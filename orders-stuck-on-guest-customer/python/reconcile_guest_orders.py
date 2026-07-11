"""Find Medusa orders still linked to an orphaned guest customer record.

Medusa v2 keys a Customer row by (email, has_account), not by email alone. A
guest checkout creates a Customer with has_account false, and the order's
customer_id points at that row. When the same person later registers with the
same email, Medusa creates a separate Customer row with has_account true. It
does not retroactively update the existing order's customer_id, so the order
stays linked to the old guest record, invisible to the new authenticated
account.

Medusa deliberately does not auto-merge these on registration, since blindly
re-linking by email would let anyone claim another person's guest orders just
by signing up with that email. Instead Medusa ships a consent-based Order
Transfer workflow: an admin-initiated request that notifies the original
guest order owner by email, and only completes once they accept it.

This script only reads by default. It pages through every customer, flags the
orphaned guest-plus-registered pattern, lists the stuck orders per pair, and
prints the planned transfer requests as order_id -> target customer_id.
Nothing is sent to Medusa unless DRY_RUN is false and a human has approved
the batch.
Run on a schedule for detection. Only run with DRY_RUN=false after review.

Guide: https://www.allanninal.dev/medusa/orders-stuck-on-guest-customer/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_guest_orders")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CUSTOMER_FIELDS = "id,email,has_account,created_at"
ORDER_FIELDS = "id,display_id,email,customer_id,created_at"


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


def find_orphaned_guest_orders(customers, orders):
    """Pure decision function. No I/O.

    customers: [{"id": str, "email": str, "has_account": bool}, ...]
    orders: [{"id": str, "customer_id": str, "email": str}, ...]

    Groups customers by lowercased email, keeps only email groups containing
    exactly one has_account False row and one has_account True row, then
    filters orders whose customer_id matches the guest row's id.

    Returns one record per such email group:
    {"guestCustomerId", "registeredCustomerId", "orderIds"}
    orderIds is an empty list when no orders reference the guest id.
    """
    groups = {}
    for customer in customers:
        email = (customer.get("email") or "").strip().lower()
        groups.setdefault(email, []).append(customer)

    results = []
    for rows in groups.values():
        guest_rows = [c for c in rows if c.get("has_account") is False]
        registered_rows = [c for c in rows if c.get("has_account") is True]
        if len(guest_rows) != 1 or len(registered_rows) != 1:
            continue
        guest_id = guest_rows[0]["id"]
        order_ids = [o["id"] for o in orders if o.get("customer_id") == guest_id]
        results.append({
            "guestCustomerId": guest_id,
            "registeredCustomerId": registered_rows[0]["id"],
            "orderIds": order_ids,
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


def orders_for_customer(token, customer_id):
    data = admin_get(token, "/admin/orders", {
        "customer_id": customer_id,
        "fields": ORDER_FIELDS,
        "limit": 100,
    })
    return data["orders"]


def request_order_transfer(token, order_id, registered_customer_id):
    r = requests.post(
        f"{BACKEND_URL}/admin/orders/{order_id}/transfer",
        json={"customer_id": registered_customer_id},
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    token = get_admin_token()
    customers = list_all_customers(token)

    all_orders = []
    for customer in customers:
        if customer.get("has_account") is False:
            all_orders.extend(orders_for_customer(token, customer["id"]))

    pairs = find_orphaned_guest_orders(customers, all_orders)

    planned = 0
    for pair in pairs:
        if not pair["orderIds"]:
            continue
        for order_id in pair["orderIds"]:
            planned += 1
            log.warning(
                "Planned transfer: order %s -> customer %s. %s",
                order_id, pair["registeredCustomerId"],
                "dry run, not sent" if DRY_RUN else "requesting transfer",
            )
            if not DRY_RUN:
                request_order_transfer(token, order_id, pair["registeredCustomerId"])

    log.info("Done. %d planned transfer(s) across %d orphaned pair(s).", planned, len(pairs))
    return pairs


if __name__ == "__main__":
    run()
