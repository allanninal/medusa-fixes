"""Detect Medusa customers duplicated by a guest checkout followed by registration.

Medusa v2 stores guest and registered customers as separate Customer rows keyed
by email, without deduplicating across account states. A guest checkout creates
a row with has_account false. When that email later registers,
createCustomerAccountWorkflow's validateCustomerAccountCreation step only
rejects the registration if a row already has has_account true, so it does not
look up and reuse the guest row. It creates a brand new Customer row instead,
leaving the guest's prior orders foreign-keyed to the now-orphaned guest cus_
id, invisible to the newly registered account.

This is read-only. It pages through every customer, groups them by normalized
email, flags the exact guest-plus-registered pattern, and for each flagged pair
counts the orders still stuck on the orphaned guest id. Nothing is merged or
written. DRY_RUN stays on by default; a confirmed merge is a separate, manual
step, since Medusa v2 has no documented admin route for reassigning an order's
customer.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/guest-registration-duplicate-customer/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_duplicate_customers")

BACKEND_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
ADMIN_EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
ADMIN_PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CUSTOMER_FIELDS = "id,email,has_account,created_at"


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


def find_duplicate_customer_groups(customers):
    """Pure decision function. No I/O.

    customers: [{"id": str, "email": str, "has_account": bool}, ...]

    Groups customer rows by normalized email, then decides per-group whether
    this is the "guest row never merged into registered row" duplicate pattern:
    exactly one has_account=False row AND at least one has_account=True row
    sharing the same normalized email. Pure: no I/O, no Date.now(), fully
    deterministic given the input array, testable with plain fixtures (single
    guest only -> not duplicate; guest+registered -> duplicate; two registered
    rows somehow sharing email -> flagged differently/not this pattern).

    Returns [{"email", "guestId", "registeredId", "isDuplicate"}, ...] with one
    entry per distinct normalized email.
    """
    groups = {}
    for customer in customers:
        email = (customer.get("email") or "").strip().lower()
        groups.setdefault(email, []).append(customer)

    results = []
    for email, rows in groups.items():
        guest_rows = [c for c in rows if c.get("has_account") is False]
        registered_rows = [c for c in rows if c.get("has_account") is True]
        is_duplicate = len(guest_rows) == 1 and len(registered_rows) >= 1
        results.append({
            "email": email,
            "guestId": guest_rows[0]["id"] if guest_rows else None,
            "registeredId": registered_rows[0]["id"] if registered_rows else None,
            "isDuplicate": is_duplicate,
        })
    return results


def list_all_customers(token):
    customers = []
    offset = 0
    limit = 200
    while True:
        data = admin_get(token, "/admin/customers", {
            "fields": CUSTOMER_FIELDS,
            "limit": limit,
            "offset": offset,
        })
        customers.extend(data["customers"])
        offset += limit
        if offset >= data["count"]:
            return customers


def orphaned_order_count(token, guest_customer_id):
    data = admin_get(token, "/admin/orders", {
        "customer_id": guest_customer_id,
        "fields": "id,customer_id,email,display_id",
        "limit": 1,
    })
    return data["count"]


def run():
    token = get_admin_token()
    customers = list_all_customers(token)
    groups = find_duplicate_customer_groups(customers)
    duplicates = [g for g in groups if g["isDuplicate"]]

    report = []
    for group in duplicates:
        count = orphaned_order_count(token, group["guestId"])
        row = {
            "email": group["email"],
            "guest_customer_id": group["guestId"],
            "registered_customer_id": group["registeredId"],
            "orphaned_order_count": count,
        }
        report.append(row)
        log.warning(
            "Duplicate pair: %s guest=%s registered=%s orphaned_orders=%d. %s",
            row["email"], row["guest_customer_id"], row["registered_customer_id"],
            row["orphaned_order_count"],
            "reported only, DRY_RUN on" if DRY_RUN else "reported, no write performed",
        )

    log.info("Done. %d duplicate pair(s) found across %d customer row(s).", len(report), len(customers))
    return report


if __name__ == "__main__":
    run()
