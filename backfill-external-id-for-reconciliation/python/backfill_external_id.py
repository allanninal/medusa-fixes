"""Backfill metadata.external_id on Medusa orders for cross-system reconciliation.

Medusa v2's Order module has no first-class external_id column. The official
ERP integration recipe stores it under metadata.external_id, a generic JSONB
field, instead of a structured one. Orders created before an integration
existed, imported by a seed script, or created through a flow that dropped
metadata along the way, end up with metadata null or missing that key, and
there is no built-in mechanism to recover the mapping once it is lost.

This lists orders missing metadata.external_id, matches each one against a
legacy CSV export by display_id when available or by email, total, and
created_at otherwise, and only applies the id when exactly one legacy row
matches. Orders with zero or multiple matches are flagged for manual
reconciliation, never guessed. Metadata is always fully resent on update,
since Medusa v2 replaces nested metadata rather than merging it.
Run once with DRY_RUN=true for a CSV report before flipping to false.
"""
import os
import csv
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill_external_id")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
LEGACY_EXPORT_PATH = os.environ.get("LEGACY_EXPORT_PATH", "legacy_orders.csv")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

TOTAL_EPSILON = 0.01
DAY_WINDOW_SECONDS = 86400

ORDER_FIELDS = "id,display_id,created_at,email,*metadata"


def get_admin_token():
    r = requests.post(
        f"{BACKEND_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def admin_get(token, path, params=None):
    r = requests.get(
        f"{BACKEND_URL}{path}",
        headers={"Authorization": f"Bearer {token}"},
        params=params or {},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def admin_post(token, path, json_body):
    r = requests.post(
        f"{BACKEND_URL}{path}",
        headers={"Authorization": f"Bearer {token}"},
        json=json_body,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def list_orders_missing_external_id(token):
    missing = []
    offset = 0
    limit = 200
    while True:
        data = admin_get(token, "/admin/orders", {
            "fields": ORDER_FIELDS,
            "limit": limit,
            "offset": offset,
        })
        for order in data["orders"]:
            metadata = order.get("metadata") or {}
            if not metadata.get("external_id"):
                missing.append(order)
        offset += limit
        if offset >= data["count"]:
            return missing


def load_legacy_candidates(path):
    """Reads a CSV with columns: legacy_id, display_id, email, total, created_at.
    display_id, total, and created_at may be blank."""
    candidates = []
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            candidates.append({
                "legacyId": row["legacy_id"],
                "display_id": int(row["display_id"]) if row.get("display_id") else None,
                "email": row.get("email") or None,
                "total": float(row["total"]) if row.get("total") else None,
                "created_at": row.get("created_at") or None,
            })
    return candidates


def _parse_epoch(iso):
    if not iso:
        return None
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def _matches_fuzzy(order, candidate):
    if not (order.get("email") and candidate.get("email")):
        return False
    if order["email"].strip().lower() != candidate["email"].strip().lower():
        return False
    if candidate.get("total") is None or order.get("total") is None:
        return False
    if abs(candidate["total"] - order["total"]) > TOTAL_EPSILON:
        return False
    order_epoch = _parse_epoch(order.get("created_at"))
    candidate_epoch = _parse_epoch(candidate.get("created_at"))
    if order_epoch is None or candidate_epoch is None:
        return False
    return abs(order_epoch - candidate_epoch) <= DAY_WINDOW_SECONDS


def decide_external_id_backfill(order, legacy_candidates):
    """Pure decision function. No I/O.

    order: {"id": str, "display_id": int, "metadata": dict | None,
            "created_at": str, "email": str | None, "total": float | None}
    legacy_candidates: [{"legacyId": str, "display_id": int | None,
                          "email": str | None, "total": float | None,
                          "created_at": str | None}]

    Returns {"action", "external_id", "reason"} where action is one of
    "skip_has_id" | "apply" | "flag_ambiguous" | "flag_no_match".

    1. If order.metadata.external_id is already a non-empty string, skip.
    2. Filter legacy_candidates to those matching on display_id if the order
       has one, else on (email && total within epsilon && created_at within
       a day window).
    3. Exactly one candidate matches -> apply that candidate's legacyId.
    4. Zero candidates match -> flag_no_match.
    5. More than one candidate matches -> flag_ambiguous. Never guess.
    """
    existing = (order.get("metadata") or {}).get("external_id")
    if isinstance(existing, str) and existing.strip():
        return {"action": "skip_has_id", "reason": "metadata.external_id already set"}

    if order.get("display_id") is not None:
        matches = [
            c for c in legacy_candidates
            if c.get("display_id") is not None and c["display_id"] == order["display_id"]
        ]
    else:
        matches = [c for c in legacy_candidates if _matches_fuzzy(order, c)]

    if len(matches) == 1:
        return {
            "action": "apply",
            "external_id": matches[0]["legacyId"],
            "reason": "exactly one legacy candidate matched",
        }
    if len(matches) == 0:
        return {"action": "flag_no_match", "reason": "no legacy candidate matched"}
    return {
        "action": "flag_ambiguous",
        "reason": f"{len(matches)} legacy candidates matched, refusing to guess",
    }


def apply_external_id(token, order, external_id):
    existing_metadata = order.get("metadata") or {}
    return admin_post(token, f"/admin/orders/{order['id']}", {
        "metadata": {**existing_metadata, "external_id": external_id},
    })


def run():
    token = get_admin_token()
    legacy_candidates = load_legacy_candidates(LEGACY_EXPORT_PATH)
    orders = list_orders_missing_external_id(token)

    rows = [("medusa_order_id", "display_id", "external_id", "action")]
    applied = 0
    flagged = 0
    for order in orders:
        outcome = decide_external_id_backfill(order, legacy_candidates)
        action = outcome["action"]

        if action == "skip_has_id":
            continue

        if action == "apply":
            external_id = outcome["external_id"]
            log.info(
                "Order %s matched legacy id %s. %s",
                order.get("display_id") or order["id"], external_id,
                "would apply" if DRY_RUN else "applying",
            )
            if not DRY_RUN:
                apply_external_id(token, order, external_id)
            rows.append((order["id"], order.get("display_id"), external_id, "apply"))
            applied += 1
        else:
            log.warning(
                "Order %s %s: %s",
                order.get("display_id") or order["id"], action, outcome["reason"],
            )
            rows.append((order["id"], order.get("display_id"), "", action))
            flagged += 1

    for row in rows:
        print(",".join(str(v) if v is not None else "" for v in row))

    log.info(
        "Done. %d order(s) %s, %d order(s) flagged for manual reconciliation.",
        applied, "to backfill" if DRY_RUN else "backfilled", flagged,
    )


if __name__ == "__main__":
    run()
