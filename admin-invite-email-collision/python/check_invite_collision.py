"""Flag a Medusa v2 admin invite that will fail at accept time because the
target email already has a customer AuthIdentity. Both customer registration
and invite acceptance call the same auth provider register method, which is
keyed only on email with no actor_type awareness, so a customer identity on
that email guarantees a 401 Identity with email already exists when the
invite is accepted. This never mutates an existing identity. DRY_RUN=true
only reports the collision check. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/admin-invite-email-collision/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_invite_collision")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
TARGET_EMAIL = os.environ.get("TARGET_EMAIL", "jane@example.com")
INVITE_ROLE = os.environ.get("INVITE_ROLE", "admin")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def find_customers(token, email):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/customers",
        params={"email": email, "fields": "id,email,has_account"},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["customers"]


def find_admin_users(token, email):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/users",
        params={"email": email, "fields": "id,email"},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["users"]


def list_pending_invites(token):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/invites",
        params={"fields": "id,email,accepted,expires_at"},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["invites"]


def will_invite_collide(target_email, customers, admin_users, pending_invites):
    """Pure: no I/O. Returns {"safe": bool, "reason": str}.

    reason is one of "customer_account_exists", "admin_user_exists",
    "invite_pending", or "ok".
    """
    email = target_email.strip().lower()

    for customer in customers:
        if customer.get("email", "").strip().lower() == email and customer.get("has_account") is True:
            return {"safe": False, "reason": "customer_account_exists"}

    for admin_user in admin_users:
        if admin_user.get("email", "").strip().lower() == email:
            return {"safe": False, "reason": "admin_user_exists"}

    for invite in pending_invites:
        if invite.get("email", "").strip().lower() == email and invite.get("accepted") is not True:
            return {"safe": False, "reason": "invite_pending"}

    return {"safe": True, "reason": "ok"}


def create_invite(token, email, role):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/invites",
        json={"email": email, "role": role},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["invite"]


def run():
    token = get_token()
    customers = find_customers(token, TARGET_EMAIL)
    admin_users = find_admin_users(token, TARGET_EMAIL)
    pending_invites = list_pending_invites(token)

    decision = will_invite_collide(TARGET_EMAIL, customers, admin_users, pending_invites)

    if not decision["safe"]:
        log.warning(
            "Blocked: invite to %s would collide (%s). Invite a different email instead.",
            TARGET_EMAIL, decision["reason"],
        )
        return

    log.info("Email %s is clear. %s", TARGET_EMAIL, "would create invite" if DRY_RUN else "creating invite")
    if not DRY_RUN:
        invite = create_invite(token, TARGET_EMAIL, INVITE_ROLE)
        log.info("Invite created: %s", invite["id"])


if __name__ == "__main__":
    run()
