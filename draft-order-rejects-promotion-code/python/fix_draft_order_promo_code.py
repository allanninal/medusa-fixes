"""Classify and safely repair Medusa draft orders that reject a valid
promotion code because no order_change edit session is open yet. Never
activates a promotion whose status is not active, that is flagged for a
human. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/draft-order-rejects-promotion-code/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_draft_order_promo_code")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

DRAFT_ORDER_FIELDS = "id,status,is_draft_order,*order_change"

# Reasons that are safe to repair automatically: only a missing or inactive
# edit session. A promotion that is genuinely not active is never forced.
REPAIRABLE_REASONS = {"no_active_edit_session", "edit_session_inactive"}


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def get_draft_order(token, draft_order_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/draft-orders/{draft_order_id}",
        params={"fields": DRAFT_ORDER_FIELDS},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["draft_order"]


def find_promotions_by_codes(token, codes):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/promotions",
        params={"code[]": codes, "fields": "id,code,status,campaign_id"},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["promotions"]


def classify_promo_rejection(order, promotions, requested_codes):
    """Pure: no I/O. Mirrors throwIfNotDraftOrder, throwIfOrderChangeIsNotActive,
    throwIfCodesAreMissing, and throwIfCodesAreInactive, in that exact order.

    order: {status, is_draft_order, order_change: {status, canceled_at, confirmed_at, declined_at} | None}
    promotions: [{code, status}]
    requested_codes: [str]
    returns: [{code, reason}] where reason is one of
      not_draft_order | no_active_edit_session | edit_session_inactive |
      code_not_found | code_not_active | ok
    """
    by_code = {p["code"]: p for p in promotions}
    results = []
    for code in requested_codes:
        if order.get("status") != "draft" and not order.get("is_draft_order"):
            results.append({"code": code, "reason": "not_draft_order"})
            continue

        order_change = order.get("order_change")
        if order_change is None:
            results.append({"code": code, "reason": "no_active_edit_session"})
            continue
        if order_change.get("canceled_at") or order_change.get("confirmed_at") or order_change.get("declined_at"):
            results.append({"code": code, "reason": "edit_session_inactive"})
            continue

        promo = by_code.get(code)
        if promo is None:
            results.append({"code": code, "reason": "code_not_found"})
            continue
        if promo.get("status") != "active":
            results.append({"code": code, "reason": "code_not_active"})
            continue

        results.append({"code": code, "reason": "ok"})
    return results


def open_edit_session(token, draft_order_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/draft-orders/{draft_order_id}/edit",
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def add_promo_codes(token, draft_order_id, codes):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/draft-orders/{draft_order_id}/edit/promotions",
        json={"promo_codes": codes},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def request_edit(token, draft_order_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/draft-orders/{draft_order_id}/edit/request",
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def confirm_edit(token, draft_order_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/draft-orders/{draft_order_id}/edit/confirm",
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run(draft_order_id=None, codes=None):
    draft_order_id = draft_order_id or os.environ["DRAFT_ORDER_ID"]
    codes = codes or [c.strip() for c in os.environ.get("PROMO_CODES", "").split(",") if c.strip()]
    if not codes:
        raise ValueError("No promo codes provided. Set PROMO_CODES as a comma separated list.")

    token = get_token()
    order = get_draft_order(token, draft_order_id)
    promotions = find_promotions_by_codes(token, codes)

    classified = classify_promo_rejection(order, promotions, codes)
    repairable_codes = []
    for item in classified:
        code, reason = item["code"], item["reason"]
        if reason == "ok":
            log.info("Code %s already ok, nothing to do.", code)
        elif reason in REPAIRABLE_REASONS:
            log.warning("Code %s rejected: %s. %s", code, reason,
                        "would open edit session and add it" if DRY_RUN else "opening edit session and adding it")
            repairable_codes.append(code)
        elif reason == "code_not_active":
            log.warning("Code %s rejected: promotion is not active. Flagging for a human to activate it in Medusa Admin.", code)
        else:
            log.warning("Code %s rejected: %s. Not auto-repairable.", code, reason)

    if not repairable_codes:
        log.info("Done. Nothing to repair for draft order %s.", draft_order_id)
        return

    if DRY_RUN:
        log.info("Dry run. Would repair %d code(s) on draft order %s.", len(repairable_codes), draft_order_id)
        return

    open_edit_session(token, draft_order_id)
    add_promo_codes(token, draft_order_id, repairable_codes)
    request_edit(token, draft_order_id)
    confirm_edit(token, draft_order_id)
    log.info("Done. Repaired %d code(s) on draft order %s.", len(repairable_codes), draft_order_id)


if __name__ == "__main__":
    run()
