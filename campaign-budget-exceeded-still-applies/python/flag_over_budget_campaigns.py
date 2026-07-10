"""Flag Medusa campaigns whose budget.used has already crossed budget.limit.

Campaign budgets are only checked when a promotion is computed onto a cart,
and used only increments later, when an order completes. This script never
reverses a completed order. It reports every over-budget campaign, the
promotions riding on it, and the orders that slipped through, and only
outside dry run does it deactivate the promotion or close the campaign
window so no new cart can pick it up. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/campaign-budget-exceeded-still-applies/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_over_budget_campaigns")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ORDERS_SINCE = os.environ.get("ORDERS_SINCE", "1970-01-01T00:00:00Z")

CAMPAIGN_FIELDS = "id,name,campaign_identifier,starts_at,ends_at,*budget"
PROMOTION_FIELDS = "id,code,status,*application_method,*campaign,*campaign.budget"
ORDER_FIELDS = "id,display_id,created_at,*promotions,*promotions.campaign,*promotions.campaign.budget"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def is_campaign_over_budget(budget, pending_amount=None):
    """Pure: decides only from limit and used, never mutates anything.
    limit None means unlimited. overageAmount is clamped to zero or above.
    """
    limit = budget.get("limit")
    used = budget.get("used") or 0

    if limit is None:
        return {"overBudget": False, "wouldExceedIfApplied": False, "overageAmount": 0}

    over_budget = used >= limit
    would_exceed_if_applied = pending_amount is not None and (used + pending_amount) > limit
    overage_amount = max(0, used - limit)

    return {
        "overBudget": over_budget,
        "wouldExceedIfApplied": would_exceed_if_applied,
        "overageAmount": overage_amount,
    }


def list_campaigns(token):
    headers = {"Authorization": f"Bearer {token}"}
    offset = 0
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/campaigns",
            params={"fields": CAMPAIGN_FIELDS, "limit": 50, "offset": offset},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        for campaign in body["campaigns"]:
            yield campaign
        offset += 50
        if offset >= body["count"]:
            return


def promotions_for_campaign(token, campaign_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/promotions",
        params={"campaign_id": campaign_id, "fields": PROMOTION_FIELDS},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["promotions"]


def orders_since(token, campaign_id, since_iso):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/orders",
        params={
            "fields": ORDER_FIELDS,
            "promotions.campaign_id": campaign_id,
            "created_at[$gte]": since_iso,
        },
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["orders"]


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


def build_report(campaign, decision, promotions, orders):
    """Pure: shapes the finance/support-facing report for one over-budget campaign."""
    budget = campaign.get("budget") or {}
    return {
        "campaign_id": campaign["id"],
        "campaign_name": campaign.get("name"),
        "budget_type": budget.get("type"),
        "limit": budget.get("limit"),
        "used": budget.get("used"),
        "overage_amount": decision["overageAmount"],
        "promotion_ids": [p["id"] for p in promotions],
        "order_ids": [o["id"] for o in orders],
    }


def run():
    token = get_token()
    reports = []

    for campaign in list_campaigns(token):
        budget = campaign.get("budget")
        if not budget:
            continue

        decision = is_campaign_over_budget(budget)
        if not decision["overBudget"]:
            continue

        promotions = promotions_for_campaign(token, campaign["id"])
        orders = orders_since(token, campaign["id"], ORDERS_SINCE)
        report = build_report(campaign, decision, promotions, orders)
        reports.append(report)

        log.warning(
            "Campaign %s (%s) over budget: used %s / limit %s, overage %s. %d promo(s), %d order(s).",
            report["campaign_id"], report["campaign_name"],
            report["used"], report["limit"], report["overage_amount"],
            len(report["promotion_ids"]), len(report["order_ids"]),
        )

        for promotion in promotions:
            if promotion.get("status") == "inactive":
                continue
            log.info(
                "Promotion %s on campaign %s. %s",
                promotion["id"], campaign["id"],
                "would deactivate" if DRY_RUN else "deactivating",
            )
            if not DRY_RUN:
                deactivate_promotion(token, promotion["id"])

    log.info("Done. %d campaign(s) over budget.", len(reports))
    return reports


if __name__ == "__main__":
    run()
