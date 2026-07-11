"""Find Stripe PaymentIntents that captured money with no matching Medusa order,
and repair them the safe way. Never inserts a synthetic order through the Admin
API. DRY_RUN=true only logs the reconciliation records it would act on. The one
safe repair is retrying POST /store/carts/{id}/complete, the same route the
storefront already calls, since completeCartWorkflow's idempotent flag was set
to false in Medusa v2.8.0 specifically so a stalled completion can be retried.

Guide: https://www.allanninal.dev/medusa/stripe-captured-no-order-created/
"""
import os
import time
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_orphaned_captures")

STRIPE_KEY = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
STRIPE_API = "https://api.stripe.com/v1"

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
PUBLISHABLE_KEY = os.environ.get("MEDUSA_PUBLISHABLE_KEY", "pk_dummy")

GRACE_MS = float(os.environ.get("GRACE_MINUTES", "10")) * 60 * 1000
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def decide_reconciliation(
    stripe_payment_intent_id,
    stripe_status,
    captured_at_ms,
    now_ms,
    grace_ms,
    medusa_payment_data_ids,
    cart_completed_at,
    cart_has_order_id,
):
    """Pure: no I/O. Returns one of ok, too_recent,
    orphaned_capture_needs_manual_complete, already_reconciled.
    """
    matched_in_medusa = stripe_payment_intent_id in medusa_payment_data_ids

    if matched_in_medusa and (cart_completed_at is not None or cart_has_order_id):
        return "already_reconciled"

    if stripe_status != "succeeded":
        return "ok"  # nothing captured yet, not our problem

    if now_ms - captured_at_ms < grace_ms:
        return "too_recent"  # webhook may still be in flight, don't flag yet

    if not matched_in_medusa and cart_completed_at is None and not cart_has_order_id:
        return "orphaned_capture_needs_manual_complete"

    return "ok"


def recent_succeeded_payment_intents(lookback_hours=24):
    out, starting_after = [], None
    since = int(time.time()) - lookback_hours * 3600
    while True:
        params = {"limit": 100, "created[gte]": since}
        if starting_after:
            params["starting_after"] = starting_after
        r = requests.get(
            f"{STRIPE_API}/payment_intents",
            params=params,
            auth=(STRIPE_KEY, ""),
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        for pi in body["data"]:
            if pi["status"] == "succeeded":
                out.append(pi)
        if not body.get("has_more"):
            return out
        starting_after = body["data"][-1]["id"]


def get_admin_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def all_medusa_payment_data_ids(token):
    headers = {"Authorization": f"Bearer {token}"}
    ids, offset, limit = [], 0, 100
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/payments",
            params={"fields": "id,data", "limit": limit, "offset": offset},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        for payment in body["payments"]:
            pid = (payment.get("data") or {}).get("id")
            if pid:
                ids.append(pid)
        offset += limit
        if offset >= body["count"]:
            return ids


def get_cart(cart_id):
    r = requests.get(
        f"{BASE_URL}/store/carts/{cart_id}",
        headers={"x-publishable-api-key": PUBLISHABLE_KEY},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["cart"]


def complete_cart(cart_id):
    r = requests.post(
        f"{BASE_URL}/store/carts/{cart_id}/complete",
        headers={"x-publishable-api-key": PUBLISHABLE_KEY},
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    if body.get("type") == "order":
        return body["order"]
    raise RuntimeError(f"cart {cart_id} did not complete into an order: {body}")


def run():
    token = get_admin_token()
    medusa_payment_data_ids = all_medusa_payment_data_ids(token)
    payment_intents = recent_succeeded_payment_intents()
    now_ms = time.time() * 1000

    flagged = []
    for pi in payment_intents:
        cart_id = (pi.get("metadata") or {}).get("cart_id")
        if not cart_id:
            continue
        cart = get_cart(cart_id)
        outcome = decide_reconciliation(
            stripe_payment_intent_id=pi["id"],
            stripe_status=pi["status"],
            captured_at_ms=pi["created"] * 1000,
            now_ms=now_ms,
            grace_ms=GRACE_MS,
            medusa_payment_data_ids=medusa_payment_data_ids,
            cart_completed_at=cart.get("completed_at"),
            cart_has_order_id=bool(cart.get("order")),
        )
        if outcome == "orphaned_capture_needs_manual_complete":
            flagged.append((pi, cart_id))

    if not flagged:
        log.info("No orphaned captures found across %d succeeded PaymentIntent(s).", len(payment_intents))
        return

    for pi, cart_id in flagged:
        log.warning(
            "Orphaned capture: PI %s amount=%s cart=%s captured_at=%s. %s",
            pi["id"], pi["amount"], cart_id, pi["created"],
            "Would retry cart complete" if DRY_RUN else "Retrying cart complete",
        )
        if DRY_RUN:
            continue

        fresh_cart = get_cart(cart_id)
        if fresh_cart.get("completed_at") or fresh_cart.get("order"):
            log.info("Cart %s completed between detection and repair. Skipping.", cart_id)
            continue

        try:
            order = complete_cart(cart_id)
            log.info("Cart %s completed into order %s.", cart_id, order.get("id"))
        except Exception as exc:
            log.error(
                "Cart %s failed to complete for PI %s: %s. "
                "Flagging to support for manual /admin/draft-orders reconciliation.",
                cart_id, pi["id"], exc,
            )

    log.info("Done. %d orphaned capture(s) %s.", len(flagged), "to review" if DRY_RUN else "processed")


if __name__ == "__main__":
    run()
