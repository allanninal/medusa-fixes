# Broken product image links

Medusa v2 stores `thumbnail` and each `images[].url` as a plain opaque
string on the product record. The framework never re-validates at read time
that a stored URL still resolves, so it only stays valid as long as the file
keeps existing at that exact host and path under whichever File Module
Provider generated it. This breaks in two well documented, common scenarios:
the Local File Module Provider (dev-only, disk-backed under `/uploads`)
bakes in the host active at upload time, so a redeploy, a container restart
with ephemeral storage, or a reverse-proxy/domain change permanently 404s
every previously-uploaded image (frequently frozen as
`http://localhost:9000/...`); and when a store migrates its file provider
(local to S3/R2/MinIO, or between buckets/regions), old product rows keep
the previous provider's URL while the object itself no longer exists at that
location.

Because guessing a replacement URL risks pointing a product at the wrong
asset, this script never rewrites a URL by hand. It paginates every product
through the Admin API, checks every unique image URL with a HEAD request
(falling back to a ranged GET), classifies each one with a pure decision
function, and only ever clears a confirmed-broken field behind a `DRY_RUN`
guard. A real replacement always comes from `POST /admin/uploads`, never a
hand-built string.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/broken-product-image-links/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export CONFIGURED_IMAGE_HOSTS="localhost:9000,cdn.example.com,my-bucket.s3.amazonaws.com"
export DRY_RUN="true"   # start safe, change to false to let the repair actually write

python broken-product-image-links/python/find_broken_images.py
node   broken-product-image-links/node/find-broken-images.js
```

`classify_image_health` / `classifyImageHealth` is a pure function: given a
plain `{url, status, error, configuredHosts}` check, it returns a
deterministic `{state, reason}`. A malformed URL is reported first, then a
network error or a 4xx/5xx status is `unreachable`, then a URL whose host is
outside `configuredHosts` is `foreign_host` even if it happened to respond
(a strong signal of a stale provider URL or a pre-migration bucket), and
everything else is `ok`. The only write the script ever performs is clearing
a confirmed-broken `thumbnail` or dropping a dead entry from `images`, gated
by `DRY_RUN`.

## Test

```bash
pytest broken-product-image-links/python
node --test broken-product-image-links/node
```
