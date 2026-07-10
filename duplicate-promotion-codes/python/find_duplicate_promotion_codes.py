"""Find Medusa promotion codes that collide once normalized.

Medusa v2 only enforces code uniqueness with a single partial unique index,
IDX_unique_promotion_code on code WHERE deleted_at IS NULL. There is no
application-level uniqueness check before the insert in
createPromotionsWorkflow, so the workflow just relies on Postgres to reject a
clash. Because the index is case-sensitive and only looks at non-deleted
rows, two promotions created through different paths, the Admin UI, a seed or
import script, or a restored backup, can end up with codes that are
byte-different but functionally the same, for example SAVE10 vs save10, or
SAVE10 with a trailing space. This script never merges or deletes anything.
It reports every duplicate group so a human can decide which promotion stays
active, and only outside dry run does it deactivate the promotion an
operator names by setting status to inactive. Safe to run again and again.
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_duplicate_promotion_codes")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
# Optional: a promo_ id to deactivate once a human has picked the loser.
DEACTIVATE_PROMOTION_ID = os.environ.get("DEACTIVATE_PROMOTION_ID", "")

PROMOTION_FIELDS = (
    "id,code,status,is_automatic,campaign_id,"
    "application_method.value,application_method.type,created_at"
)
CAMPAIGN_FIELDS = "id,name,starts_at,ends_at"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def find_duplicate_promotion_codes(promotions):
    """Pure: groups promotions by a normalized code and returns only groups
    with more than one entry, i.e. two or more distinct promo_ ids that
    resolve to the same effective code once whitespace and case are ignored.
    No I/O, no mutation of the input list.
    """
    groups = {}
    for promotion in promotions:
        key = promotion["code"].strip().upper()
        groups.setdefault(key, []).append(promotion)

    return {key: entries for key, entries in groups.items() if len(entries) > 1}


def list_promotions(token):
    headers = {"Authorization": f"Bearer {token}"}
    offset = 0
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/promotions",
            params={"fields": PROMOTION_FIELDS, "limit": 200, "offset": offset},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        for promotion in body["promotions"]:
            yield promotion
        offset += 200
        if offset >= body["count"]:
            return


def get_campaign(token, campaign_id):
    if not campaign_id:
        return None
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/campaigns/{campaign_id}",
        params={"fields": CAMPAIGN_FIELDS},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["campaign"]


def deactivate_promotion(token, promotion_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/promotions/{promotion_id}",
        json={"status": "inactive"},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["promotion"]


def build_report(normalized_code, entries, campaigns_by_id):
    """Pure: shapes one duplicate group into a human-facing report row."""
    raw_codes = sorted({entry["code"] for entry in entries})
    return {
        "normalized_code": normalized_code,
        "is_case_or_whitespace_variant": len(raw_codes) > 1,
        "raw_codes": raw_codes,
        "promotions": [
            {
                "id": entry["id"],
                "code": entry["code"],
                "status": entry["status"],
                "campaign_id": entry.get("campaign_id"),
                "application_method": entry.get("application_method"),
                "campaign_name": (campaigns_by_id.get(entry.get("campaign_id")) or {}).get("name"),
            }
            for entry in entries
        ],
    }


def run():
    token = get_token()
    promotions = list(list_promotions(token))
    duplicates = find_duplicate_promotion_codes(promotions)

    campaigns_by_id = {}
    for entries in duplicates.values():
        for entry in entries:
            campaign_id = entry.get("campaign_id")
            if campaign_id and campaign_id not in campaigns_by_id:
                campaigns_by_id[campaign_id] = get_campaign(token, campaign_id)

    reports = []
    for normalized_code, entries in duplicates.items():
        report = build_report(normalized_code, entries, campaigns_by_id)
        reports.append(report)
        log.warning(
            "Duplicate code %s: %d promotion(s) %s. Raw codes seen: %s",
            report["normalized_code"],
            len(report["promotions"]),
            [p["id"] for p in report["promotions"]],
            report["raw_codes"],
        )

    if DEACTIVATE_PROMOTION_ID:
        log.info(
            "Promotion %s. %s",
            DEACTIVATE_PROMOTION_ID,
            "would deactivate" if DRY_RUN else "deactivating",
        )
        if not DRY_RUN:
            deactivate_promotion(token, DEACTIVATE_PROMOTION_ID)

    log.info("Done. %d duplicate code group(s) found.", len(reports))
    return reports


if __name__ == "__main__":
    run()
