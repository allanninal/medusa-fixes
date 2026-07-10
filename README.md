# medusa-fixes

Small, focused scripts that detect and repair the everyday problems that hit real
[Medusa.js](https://medusajs.com) (v2) stores: hidden products, missing region
prices, stuck inventory reservations, carts that will not complete, orders that
never fulfill, promotions that will not apply, broken module links, and missed
background jobs.

Every fix ships in **both Python and Node.js**, is **safe by default** (a
`DRY_RUN` flag that defaults to `true`, so it reports before it writes), and has
a **pure decision function** with unit tests, so you can trust the logic before
you point it at a live store.

Each fix has a full write-up with diagrams on
**[allanninal.dev/medusa](https://www.allanninal.dev/medusa/)**.

## How the scripts authenticate

The scripts talk to the Medusa **Admin API**. They read configuration from the
environment:

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"   # set to "false" to actually write
```

They exchange the email and password for a JWT at
`POST /auth/user/emailpass`, then call `/admin/*` routes with an
`Authorization: Bearer <token>` header. The Node scripts use
[`@medusajs/js-sdk`](https://docs.medusajs.com/resources/js-sdk); the Python
scripts use `requests`.

## The fixes

| Fix | What it does | Type | Guide |
| --- | --- | --- | --- |
