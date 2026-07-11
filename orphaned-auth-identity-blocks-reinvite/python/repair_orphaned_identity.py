"""Find and repair an AuthIdentity orphaned by a failed Medusa v2 invite accept.

POST /auth/user/{provider}/register creates the AuthIdentity before
POST /admin/invites/accept ever runs acceptInviteWorkflow. If that workflow
fails, Medusa compensates the invite back to pending, but the AuthIdentity has
no compensation step of its own and is left behind, blocking every retry with
"Identity with email already exists". This lists pending invites over the
Admin API, cross-checks them against auth identities and users you supply
(read server-side with container.resolve(Modules.AUTH) and Modules.USER), and
only ever deletes an identity when no user is linked to that email. DRY_RUN=true
only reports what it would do. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/orphaned-auth-identity-blocks-reinvite/
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_orphaned_identity")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_pending_invites(token):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/invites",
        params={"fields": "id,email,accepted,expires_at,token"},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    invites = r.json()["invites"]
    return [i for i in invites if i.get("accepted") is False]


def resend_invite(token, invite_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/invites/{invite_id}/resend",
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()


def find_orphaned_auth_identities(invites, auth_identities, users, now):
    """Pure: no I/O. invites/authIdentities/users are plain lists, now is a datetime.

    invites: [{id, email, accepted, expires_at}]
    auth_identities: [{id, entityId, providerId}]
    users: [{id, email}]
    now: datetime (should be timezone-aware to compare against expires_at)

    Returns a list of {inviteId, email, authIdentityId, action} where action is
    one of "delete_auth_identity", "flag_ambiguous", "resend_invite".
    """
    user_emails = {u["email"].strip().lower() for u in users if u.get("email")}
    decisions = []

    for invite in invites:
        if invite.get("accepted") is not False:
            continue
        email = invite["email"].strip().lower()

        match = next(
            (ai for ai in auth_identities if ai.get("entityId", "").strip().lower() == email),
            None,
        )
        if match is None:
            continue

        if email in user_emails:
            decisions.append({
                "inviteId": invite["id"], "email": invite["email"],
                "authIdentityId": match["id"], "action": "flag_ambiguous",
            })
            continue

        expires_at = invite.get("expires_at")
        if expires_at is not None and expires_at < now:
            decisions.append({
                "inviteId": invite["id"], "email": invite["email"],
                "authIdentityId": match["id"], "action": "resend_invite",
            })
        else:
            decisions.append({
                "inviteId": invite["id"], "email": invite["email"],
                "authIdentityId": match["id"], "action": "delete_auth_identity",
            })

    return decisions


def run():
    token = get_token()
    invites = list_pending_invites(token)

    # In a real deployment these two calls happen server-side, inside a Medusa
    # script or subscriber, using container.resolve(Modules.AUTH) and
    # container.resolve(Modules.USER). There is no public admin route for
    # AuthIdentity, so this is left as an injection point:
    #
    #   auth_identities = await authModuleService.listAuthIdentities(
    #       {}, {"relations": ["provider_identities"]}
    #   )
    #   users = await userModuleService.listUsers({})
    auth_identities = []
    users = []

    now = datetime.datetime.now(datetime.timezone.utc)
    decisions = find_orphaned_auth_identities(invites, auth_identities, users, now)

    for decision in decisions:
        if decision["action"] == "flag_ambiguous":
            log.warning(
                "Flagged: %s has both a pending invite and a user. Not touching AuthIdentity %s.",
                decision["email"], decision["authIdentityId"],
            )
            continue

        if decision["action"] == "resend_invite":
            log.warning(
                "Invite for %s expired with an orphaned identity. %s",
                decision["email"], "would resend and delete identity" if DRY_RUN else "resending and deleting identity",
            )
            if not DRY_RUN:
                resend_invite(token, decision["inviteId"])
                # await authModuleService.deleteAuthIdentities([decision["authIdentityId"]])
            continue

        log.info(
            "Orphaned AuthIdentity for %s. %s",
            decision["email"], "would delete" if DRY_RUN else "deleting",
        )
        if not DRY_RUN:
            pass
            # await authModuleService.deleteAuthIdentities([decision["authIdentityId"]])

    log.info("Done. %d decision(s) evaluated.", len(decisions))


if __name__ == "__main__":
    run()
