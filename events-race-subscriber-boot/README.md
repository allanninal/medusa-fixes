# Events fire before subscribers finish loading on boot

In Medusa v2's Redis event bus, the `event-bus-redis` module and its
BullMQ worker are instantiated and start consuming queued jobs as soon
as the module loader resolves, but custom subscribers in
`src/subscribers` are registered by a separate, later loader phase. If
events were already queued in Redis before or during that window, for
example right after a redeploy or a horizontal-scale restart, the
worker dequeues them immediately, logs `Processing <event> which has 0
subscribers`, and marks the job complete, permanently losing that
delivery. There is no subscriber-aware retry for a job BullMQ
considers successfully processed. This is confirmed as a real bug in
`medusajs/medusa#10822`.

This never auto-re-emits blindly. It parses the boot log once for the
subscriber-loader-done marker and every `Processing <event> which has
0 subscribers` line, keeps only the ones timestamped strictly before
the loader finished (a confirmed gap, not a guess), and reports each
one under `DRY_RUN`. Repair only re-publishes an event under
`DRY_RUN=false`, using data pulled fresh from the current Admin API
state of the affected entity, and only once the operator has confirmed
the handler is idempotent.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/events-race-subscriber-boot/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export BOOT_LOG_PATH="/var/log/medusa/boot.log"
export DRY_RUN="true"

python events-race-subscriber-boot/python/find_missed_events.py
node   events-race-subscriber-boot/node/find-missed-events.js
```

`find_missed_event_windows` (Python) / `findMissedEventWindows` (Node)
is a pure decision function: given the boot log entries already
parsed into plain `{ event, atMs }` values and the timestamp where the
subscriber loader finished registering handlers, it returns every
event that was processed strictly before that timestamp, each with how
big the gap was in milliseconds. It takes no I/O, so it is fully
unit-testable without a running Medusa instance, a log file, or a
network call. The only writes in the guarded repair path are a single
re-emit of the specific event per confirmed gap, cross-checked first
against the Admin API (for example diffing `/admin/orders` against
`/admin/notifications`), and both are skipped entirely while
`DRY_RUN=true`.

## Test

```bash
pytest events-race-subscriber-boot/python
node --test events-race-subscriber-boot/node
```
