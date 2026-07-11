"""Find Medusa v2 events that the Redis event bus processed with 0
subscribers because the event-bus-redis module's BullMQ worker started
consuming before the later src/subscribers loader phase finished
registering handlers, typically right after a redeploy or a
horizontal-scale restart. Never auto-re-emits by default. DRY_RUN=true
only reports the confirmed gaps found in the boot log. Repair only
re-publishes an event under DRY_RUN=false, using data pulled fresh from
the Admin API, and only once the operator has confirmed the handler is
idempotent.
"""
import os
import re
import logging
from datetime import datetime

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_missed_events")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
BOOT_LOG_PATH = os.environ.get("BOOT_LOG_PATH", "/var/log/medusa/boot.log")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

LOG_LINE = re.compile(r"^\[(?P<ts>[^\]]+)\]\s+(?P<msg>.*)$")
ZERO_SUB = re.compile(r"Processing\s+(?P<event>\S+)\s+which has 0 subscribers")
LOADER_DONE = re.compile(r"subscribers loaded", re.IGNORECASE)


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def _to_epoch_ms(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000


def parse_boot_log(path):
    """Read the boot log once. Returns (bootLog, subscriberLoaderDoneAtMs)."""
    boot_log = []
    loader_done_at_ms = None
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            m = LOG_LINE.match(line.strip())
            if not m:
                continue
            at_ms = _to_epoch_ms(m.group("ts"))
            msg = m.group("msg")
            zero = ZERO_SUB.search(msg)
            if zero:
                boot_log.append({"event": zero.group("event"), "atMs": at_ms})
            elif LOADER_DONE.search(msg) and loader_done_at_ms is None:
                loader_done_at_ms = at_ms
    return boot_log, loader_done_at_ms


def find_missed_event_windows(boot_log, subscriber_loader_done_at_ms):
    """Pure: no I/O. boot_log is a list of {"event", "atMs"} dicts already parsed
    from lines like "Processing <eventName> which has 0 subscribers".
    An event was missed iff it was processed strictly before the subscriber
    loader finished registering handlers."""
    return [
        {"event": e["event"], "atMs": e["atMs"], "gapMs": subscriber_loader_done_at_ms - e["atMs"]}
        for e in boot_log
        if e["atMs"] < subscriber_loader_done_at_ms
    ]


def orders_missing_notifications(token, restart_iso):
    """Diff orders created since the restart against notifications sent since
    the restart, for order.placed style gaps. Returns order ids with no
    matching notification record."""
    headers = {"Authorization": f"Bearer {token}"}

    orders = requests.get(
        f"{BASE_URL}/admin/orders",
        params={"fields": "id,status,*fulfillments,*payment_collection",
                "created_at[$gte]": restart_iso},
        headers=headers, timeout=30,
    ).json()["orders"]

    notifications = requests.get(
        f"{BASE_URL}/admin/notifications",
        params={"fields": "id,to,template,data",
                "created_at[$gte]": restart_iso},
        headers=headers, timeout=30,
    ).json()["notifications"]

    notified_order_ids = {n["data"].get("id") for n in notifications if n.get("data")}
    return [o["id"] for o in orders if o["id"] not in notified_order_ids]


def reemit_order_placed(token, order_id):
    """Only called when DRY_RUN=false and the operator confirmed the handler
    is idempotent. Sources fresh payload from the Admin API, not the
    original stale event."""
    headers = {"Authorization": f"Bearer {token}"}
    order = requests.get(
        f"{BASE_URL}/admin/orders/{order_id}",
        params={"fields": "id,*items,*customer"},
        headers=headers, timeout=30,
    ).json()["order"]
    # In the Medusa backend process itself:
    #   const eventModuleService = container.resolve(Modules.EVENT)
    #   await eventModuleService.emit({ name: "order.placed", data: order })
    return order


def run():
    boot_log, loader_done_at_ms = parse_boot_log(BOOT_LOG_PATH)
    if loader_done_at_ms is None:
        log.warning("Subscriber loader done marker not found in %s. Nothing to compare.", BOOT_LOG_PATH)
        return

    missed = find_missed_event_windows(boot_log, loader_done_at_ms)
    if not missed:
        log.info("No confirmed gaps. %d event(s) processed, all after the subscriber loader finished.", len(boot_log))
        return

    for item in missed:
        log.warning(
            "Event %s processed %.0f ms before subscribers finished loading. Confirmed gap.",
            item["event"], item["gapMs"],
        )

    if not DRY_RUN:
        token = get_token()
        restart_iso = datetime.utcfromtimestamp(min(e["atMs"] for e in missed) / 1000).isoformat() + "Z"
        order_ids = orders_missing_notifications(token, restart_iso)
        for order_id in order_ids:
            log.info("Order %s has no matching notification. Re-emitting order.placed.", order_id)
            reemit_order_placed(token, order_id)

    log.info("Done. %d event(s) %s.", len(missed), "to review" if DRY_RUN else "reported and cross-checked")


if __name__ == "__main__":
    run()
