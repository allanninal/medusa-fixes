# Orphaned auth identity blocks re-invite

Accepting a Medusa v2 invite is two calls: `POST /auth/user/{provider}/register` creates an `AuthIdentity` row first, then `POST /admin/invites/accept` runs `acceptInviteWorkflow`, which creates the user and only afterward links the identity to it. If that second call fails (a duplicate email, a role conflict, a database error), Medusa compensates the invite back to pending, but the `AuthIdentity` created in the earlier, separate register call has no compensation step and is left behind. The invitee's retry then fails with `Identity with email already exists`, forever, for that email.

This script lists pending invites over the Admin API, cross-checks them against auth identities and users (read server-side with `container.resolve(Modules.AUTH)` and `Modules.USER)`), and repairs the confirmed orphan: `deleteAuthIdentities` when no user is linked, `resend` when the invite itself has also expired, or a flag when a real user already exists for that email so nothing gets touched.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/orphaned-auth-identity-blocks-reinvite/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python orphaned-auth-identity-blocks-reinvite/python/repair_orphaned_identity.py
node   orphaned-auth-identity-blocks-reinvite/node/repair-orphaned-identity.js
```

The Admin API has no route that lists `AuthIdentity` rows, so the identity and user lookups in `run()` are left as an injection point for a Medusa server script or subscriber using `container.resolve(Modules.AUTH)` and `container.resolve(Modules.USER)`. `find_orphaned_auth_identities` / `findOrphanedAuthIdentities` is a pure function (the current time is passed in): a pending invite with a matching, userless `AuthIdentity` is deleted; the same case with an already-expired invite also gets a resend; and a matching identity next to an existing user is only flagged, never touched. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest orphaned-auth-identity-blocks-reinvite/python
node --test orphaned-auth-identity-blocks-reinvite/node
```
