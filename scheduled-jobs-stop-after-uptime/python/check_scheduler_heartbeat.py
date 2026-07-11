"""Detect a stalled Medusa v2 scheduler caused by a hung workflow step
occupying the only BullMQ worker slot (jobWorkerOptions.concurrency=1
by default on @medusajs/medusa/workflow-engine-redis). There is no
Admin API route that can kill a stuck job or restart the scheduler,
so this only flags the stall and alerts an operator to restart the
worker process. DRY_RUN=true only logs locally; DRY_RUN=false also
calls the alert webhook. Never writes anything to Medusa itself.
"""
import os
import logging
from datetime import datetime, timedelta, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_scheduler_heartbeat")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
STOCK_LOCATION_ID = os.environ.get("HEARTBEAT_STOCK_LOCATION_ID", "sloc_heartbeat")
HEARTBEAT_CRON = os.environ.get("HEARTBEAT_CRON", "*/5 * * * *")
TOLERANCE_MULTIPLIER = float(os.environ.get("TOLERANCE_MULTIPLIER", "3"))
ALERT_WEBHOOK_URL = os.environ.get("ALERT_WEBHOOK_URL")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def get_heartbeat_last_run_at(token, stock_location_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/stock-locations",
        params={"fields": "id,metadata", "limit": 100},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    locations = r.json()["stock_locations"]
    for loc in locations:
        if loc["id"] == stock_location_id:
            return (loc.get("metadata") or {}).get("heartbeat_last_run_at")
    return None


def _parse_field(field, lo, hi):
    """Parse one cron field (*, N, N-M, N,M, */S) into a set of allowed ints."""
    if field == "*":
        return set(range(lo, hi + 1))
    values = set()
    for part in field.split(","):
        if part.startswith("*/"):
            values.update(range(lo, hi + 1, int(part[2:])))
        elif "-" in part:
            a, b = part.split("-")
            values.update(range(int(a), int(b) + 1))
        else:
            values.add(int(part))
    return values


def _parse_cron(cron_expression):
    minute, hour, dom, month, dow = cron_expression.strip().split()
    return {
        "minute": _parse_field(minute, 0, 59),
        "hour": _parse_field(hour, 0, 23),
        "dom": _parse_field(dom, 1, 31),
        "month": _parse_field(month, 1, 12),
        "dow": _parse_field(dow, 0, 6),
    }


def _matches(dt, spec):
    if dt.minute not in spec["minute"] or dt.hour not in spec["hour"] or dt.month not in spec["month"]:
        return False
    dom_ok = dt.day in spec["dom"]
    dow_ok = (dt.weekday() + 1) % 7 in spec["dow"]
    if spec["dom"] != set(range(1, 32)) and spec["dow"] != set(range(0, 7)):
        return dom_ok or dow_ok
    return dom_ok and dow_ok


def _next_run_after(cron_expression, after, limit_minutes=527040):
    """Smallest minute-aligned datetime strictly after `after` matching the cron spec."""
    spec = _parse_cron(cron_expression)
    cursor = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(limit_minutes):
        if _matches(cursor, spec):
            return cursor
        cursor += timedelta(minutes=1)
    raise RuntimeError("No matching run found within search window")


def expected_interval_ms(cron_expression, anchor):
    """The gap, in ms, between two consecutive matches of cron_expression near anchor."""
    first_run = _next_run_after(cron_expression, anchor)
    second_run = _next_run_after(cron_expression, first_run)
    return (second_run - first_run).total_seconds() * 1000


def is_scheduler_stalled(last_run_at, now, cron_schedule, tolerance_multiplier=3):
    """Pure: no I/O. Returns True iff the gap since last_run_at exceeds the
    schedule's expected interval times tolerance_multiplier."""
    interval_ms = expected_interval_ms(cron_schedule, last_run_at)
    gap_ms = (now - last_run_at).total_seconds() * 1000
    return gap_ms > interval_ms * tolerance_multiplier


def alert_stalled_scheduler(gap_minutes, webhook_url=None):
    message = (
        f"Medusa scheduler looks stalled. No heartbeat for {gap_minutes:.1f} minutes. "
        "A workflow step is likely stuck occupying the only BullMQ worker slot "
        "(jobWorkerOptions.concurrency=1). Restart the worker process "
        "(MEDUSA_WORKER_MODE=worker) to recover. Consider raising concurrency and "
        "adding step-level timeouts to prevent this recurring."
    )
    if webhook_url:
        requests.post(webhook_url, json={"text": message}, timeout=15)
    return message


def run():
    token = get_token()
    last_run_iso = get_heartbeat_last_run_at(token, STOCK_LOCATION_ID)
    now = datetime.now(timezone.utc)

    if last_run_iso is None:
        log.warning("No heartbeat recorded yet at all. Treating as stalled.")
        message = alert_stalled_scheduler(float("inf"), ALERT_WEBHOOK_URL if not DRY_RUN else None)
        log.warning(message)
        return

    last_run_at = datetime.fromisoformat(last_run_iso.replace("Z", "+00:00"))
    stalled = is_scheduler_stalled(last_run_at, now, HEARTBEAT_CRON, TOLERANCE_MULTIPLIER)

    gap_minutes = (now - last_run_at).total_seconds() / 60
    if not stalled:
        log.info("Scheduler healthy. Last heartbeat %.1f minute(s) ago.", gap_minutes)
        return

    log.warning("Scheduler stalled. Last heartbeat %.1f minute(s) ago.", gap_minutes)
    message = alert_stalled_scheduler(gap_minutes, ALERT_WEBHOOK_URL if not DRY_RUN else None)
    log.warning(message)


if __name__ == "__main__":
    run()
