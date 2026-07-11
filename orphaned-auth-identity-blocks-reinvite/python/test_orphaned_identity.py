from datetime import datetime, timezone

from repair_orphaned_identity import find_orphaned_auth_identities

NOW = datetime(2026, 7, 10, tzinfo=timezone.utc)


def invite(**over):
    base = {
        "id": "invite_01",
        "email": "jane@example.com",
        "accepted": False,
        "expires_at": datetime(2026, 7, 20, tzinfo=timezone.utc),
    }
    base.update(over)
    return base


def identity(**over):
    base = {"id": "au_01", "entityId": "jane@example.com", "providerId": "emailpass"}
    base.update(over)
    return base


def test_no_decision_when_no_matching_identity():
    result = find_orphaned_auth_identities([invite()], [], [], NOW)
    assert result == []


def test_delete_when_pending_orphaned_and_not_expired():
    result = find_orphaned_auth_identities([invite()], [identity()], [], NOW)
    assert result == [{
        "inviteId": "invite_01", "email": "jane@example.com",
        "authIdentityId": "au_01", "action": "delete_auth_identity",
    }]


def test_flag_ambiguous_when_user_already_exists():
    users = [{"id": "user_01", "email": "jane@example.com"}]
    result = find_orphaned_auth_identities([invite()], [identity()], users, NOW)
    assert result == [{
        "inviteId": "invite_01", "email": "jane@example.com",
        "authIdentityId": "au_01", "action": "flag_ambiguous",
    }]


def test_resend_invite_when_expired():
    expired = invite(expires_at=datetime(2026, 7, 1, tzinfo=timezone.utc))
    result = find_orphaned_auth_identities([expired], [identity()], [], NOW)
    assert result == [{
        "inviteId": "invite_01", "email": "jane@example.com",
        "authIdentityId": "au_01", "action": "resend_invite",
    }]


def test_skip_when_invite_already_accepted():
    accepted = invite(accepted=True)
    result = find_orphaned_auth_identities([accepted], [identity()], [], NOW)
    assert result == []


def test_skip_when_invite_missing_from_auth_identities():
    result = find_orphaned_auth_identities([invite(email="nobody@example.com")], [identity()], [], NOW)
    assert result == []


def test_user_check_wins_over_expired_invite():
    expired = invite(expires_at=datetime(2026, 7, 1, tzinfo=timezone.utc))
    users = [{"id": "user_01", "email": "jane@example.com"}]
    result = find_orphaned_auth_identities([expired], [identity()], users, NOW)
    assert result[0]["action"] == "flag_ambiguous"


def test_case_and_whitespace_are_normalized():
    messy_invite = invite(email="  Jane@Example.com  ")
    result = find_orphaned_auth_identities([messy_invite], [identity()], [], NOW)
    assert result[0]["action"] == "delete_auth_identity"


def test_multiple_invites_get_independent_decisions():
    invites = [
        invite(id="invite_01", email="jane@example.com"),
        invite(id="invite_02", email="john@example.com", expires_at=datetime(2026, 7, 1, tzinfo=timezone.utc)),
    ]
    identities = [
        identity(id="au_01", entityId="jane@example.com"),
        identity(id="au_02", entityId="john@example.com"),
    ]
    result = find_orphaned_auth_identities(invites, identities, [], NOW)
    actions = {d["inviteId"]: d["action"] for d in result}
    assert actions == {"invite_01": "delete_auth_identity", "invite_02": "resend_invite"}
