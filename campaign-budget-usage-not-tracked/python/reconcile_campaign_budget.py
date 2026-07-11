"""Reconcile a Medusa campaign's budget.used against real order redemptions.

Buy X Get Y (buyget) promotions do not reliably emit or persist the usage-update
action that keeps a campaign's budget.used current, so a campaign tied only to a
buyget promotion can be redeemed past its limit while its dashboard still shows an
untouched budget. This recomputes real usage from orders and reports every campaign
where the recomputed number disagrees with what is stored, or has crossed the limit.
By default it only reports. It syncs budget.used only when DRY_RUN=false, and it
never deactivates a promotion on its own even then. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/campaign-budget-usage-not-tracked/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_campaign_budget")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CAMPAIGN_FIELDS = "id,name,campaign_identifier,starts_at,ends_at,*budget,*promotions"
ORDER_FIELDS = "id,display_id,total,created_at,*promotions,*items,*items.adjustments"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_campaigns(token):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/campaigns",
        params={"fields": CAMPAIGN_FIELDS, "limit": 200},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["campaigns"]


def is_buyget_budget_campaign(campaign):
    budget = campaign.get("budget") or {}
    if not budget.get("limit"):
        return False
    promotions = campaign.get("promotions") or []
    return any(p.get("type") == "buyget" for p in promotions)


def orders_redeeming(token, promotion_ids):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/orders",
        params={"fields": ORDER_FIELDS, "promotion_id[]": promotion_ids, "limit": 200},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["orders"]


def redemptions_for_campaign(orders, promotion_ids):
    """Turn raw orders into flat redemption rows the pure reconciler can use."""
    ids = set(promotion_ids)
    rows = []
    for order in orders:
        matched = [p["id"] for p in (order.get("promotions") or []) if p.get("id") in ids]
        if not matched:
            continue
        discount_total = 0.0
        for item in order.get("items") or []:
            for adj in item.get("adjustments") or []:
                if adj.get("promotion_id") in ids:
                    discount_total += float(adj.get("amount") or 0)
        rows.append({"orderId": order["id"], "promotionId": matched[0], "discountTotal": discount_total})
    return rows


def reconcile_campaign_budget_usage(campaign, redemptions):
    """Pure: recomputes usage from redemptions and compares it to the stored budget.
    campaign = {"id": str, "budget": {"type": "spend" | "usage", "limit": float, "used": float}}
    redemptions = [{"orderId": str, "promotionId": str, "discountTotal": float}, ...]
    No I/O. Only arithmetic and comparison, so it can be unit tested against
    fabricated redemption arrays and budget states.
    """
    budget = campaign["budget"]
    if budget["type"] == "usage":
        recomputed_used = len(redemptions)
    else:
        recomputed_used = sum(r["discountTotal"] for r in redemptions)

    limit = budget["limit"]
    stored_used = budget["used"]
    needs_sync = recomputed_used != stored_used
    over_budget = limit > 0 and recomputed_used > limit

    return {
        "campaignId": campaign["id"],
        "storedUsed": stored_used,
        "recomputedUsed": recomputed_used,
        "limit": limit,
        "needsSync": needs_sync,
        "overBudget": over_budget,
    }


def sync_budget_used(token, campaign_id, recomputed_used):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/campaigns/{campaign_id}",
        json={"budget": {"used": recomputed_used}},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["campaign"]


def run():
    token = get_token()
    campaigns = [c for c in list_campaigns(token) if is_buyget_budget_campaign(c)]
    if not campaigns:
        log.info("No campaigns found with a budget tied to a buyget promotion.")
        return

    for campaign in campaigns:
        promotion_ids = [p["id"] for p in campaign["promotions"] if p.get("type") == "buyget"]
        orders = orders_redeeming(token, promotion_ids)
        redemptions = redemptions_for_campaign(orders, promotion_ids)
        result = reconcile_campaign_budget_usage(campaign, redemptions)

        log.info(
            "campaign_id=%s identifier=%s budget_type=%s stored_used=%s recomputed_used=%s limit=%s over_budget=%s",
            result["campaignId"], campaign.get("campaign_identifier"), campaign["budget"]["type"],
            result["storedUsed"], result["recomputedUsed"], result["limit"], result["overBudget"],
        )

        if result["needsSync"]:
            if DRY_RUN:
                log.info("Would sync budget.used to %s for campaign %s.", result["recomputedUsed"], result["campaignId"])
            else:
                sync_budget_used(token, result["campaignId"], result["recomputedUsed"])
                log.info("Synced budget.used to %s for campaign %s.", result["recomputedUsed"], result["campaignId"])

        if result["overBudget"]:
            log.warning(
                "Campaign %s is over budget. Suggested review action (not automatic): "
                "PATCH /admin/promotions/%s {\"status\": \"inactive\"}",
                result["campaignId"], promotion_ids[0],
            )

    log.info("Done. %d buyget-budget campaign(s) checked.", len(campaigns))


if __name__ == "__main__":
    run()
