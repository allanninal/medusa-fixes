# Admin invite fails when the email already belongs to a customer

Both customer registration and admin invite acceptance in Medusa v2
ultimately call the same auth provider register method (for example
`POST /auth/user/emailpass/register`), which looks up a single
`AuthIdentity` row by email. When a customer already registered with
that email, the identity already exists with `app_metadata` linking
it to a customer actor, and the register flow has no `actor_type`
awareness, so it cannot tell an admin identity apart from the
existing customer one. It returns a 401 `Identity with email already
exists` instead of creating a separate admin identity. `POST
/admin/invites` succeeds and the email sends, but the invitee's
`POST /admin/invites/accept` fails at that same register step,
permanently, for that email.

There is no safe API-level fix. Medusa does not support one email
owning both a customer and an admin `AuthIdentity` in the affected
versions, and force-deleting or editing the customer's auth identity
risks locking out a real storefront customer. This is flag-and-block,
not auto-repair: it checks the target email against `has_account` on
`/admin/customers` (the reliable proxy signal, since there is no
direct auth-identity or actor_type listing route), against
`/admin/users` for an existing admin, and against `/admin/invites`
for a pending unaccepted invite, before the invite is ever created.
On any collision it blocks invite creation and reports the reason.
The only supported repair is inviting a different email address.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/admin-invite-email-collision/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export TARGET_EMAIL="jane@example.com"
export INVITE_ROLE="admin"
export DRY_RUN="true"

python admin-invite-email-collision/python/check_invite_collision.py
node   admin-invite-email-collision/node/check-invite-collision.js
```

`will_invite_collide` (Python) / `willInviteCollide` (Node) is a pure
decision function: given the normalized target email plus plain
arrays of fetched customers, admin users, and pending invites, it
returns `{ safe, reason }`. It checks, in order, whether a matching
customer has `has_account: true` (`customer_account_exists`), whether
a matching admin user already exists (`admin_user_exists`), whether a
matching non-accepted invite is already pending (`invite_pending`),
and otherwise returns `{ safe: true, reason: "ok" }`. It takes no
I/O, so it is fully unit-testable with fixture arrays and no running
Medusa instance or network call. `POST /admin/invites` is only ever
called when the check is safe; nothing about an existing identity is
ever mutated.

## Test

```bash
pytest admin-invite-email-collision/python
node --test admin-invite-email-collision/node
```
