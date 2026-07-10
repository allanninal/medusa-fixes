"""Find Medusa v2 records whose scheduled job missed a run, because the
instance never registered the job in server-only WORKER_MODE, or the
default in-memory workflow engine dropped the tick across a restart.
Never replays a cron tick generically. DRY_RUN=true only reports the
flagged records. Safe to run again and again, because repair writes a
last_synced_at marker that stops the same gap from being reprocessed.
"""
import os
import logging
from datetime import datetime, timedelta, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_missed_runs")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
JOB_CRON = os.environ.get("JOB_CRON", "0 * * * *")
GRACE_MULTIPLIER = float(os.environ.get("GRACE_MULTIPLIER", "1.5"))

PRICE_LIST_FIELDS = "id,title,ends_at,updated_at"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_price_lists(token, limit=100):
    headers = {"Authorization": f"Bearer {token}"}
    out, offset = [], 0
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/price-lists",
            params={"fields": PRICE_LIST_FIELDS, "limit": limit, "offset": offset},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        out.extend(body["price_lists"])
        offset += limit
        if offset >= body["count"]:
            return out


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


def next_run_after(cron_expression, after, limit_minutes=527040):
    """Smallest minute-aligned datetime strictly after `after` matching the cron spec."""
    spec = _parse_cron(cron_expression)
    cursor = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(limit_minutes):
        if _matches(cursor, spec):
            return cursor
        cursor += timedelta(minutes=1)
    raise RuntimeError("No matching run found within search window")


def find_missed_runs(records, cron_expression, now, grace_multiplier=1.5):
    """Pure: no I/O. records is a list of {"id", "lastRunAt"} dicts already fetched."""
    anchor = next_run_after(cron_expression, now - timedelta(days=1))
    interval_ms = (next_run_after(cron_expression, anchor) - anchor).total_seconds() * 1000
    missed = []

    for record in records:
        last_run_at = record.get("lastRunAt")
        if last_run_at is None:
            missed.append({
                "id": record["id"],
                "expectedRunAt": now,
                "missedByMs": interval_ms * grace_multiplier + 1,
            })
            continue

        # The tick that should have fired right after the record's own last run.
        expected_run_at = next_run_after(cron_expression, last_run_at)
        gap_ms = (now - expected_run_at).total_seconds() * 1000

        if gap_ms > interval_ms * grace_multiplier and last_run_at < expected_run_at:
            missed.append({
                "id": record["id"],
                "expectedRunAt": expected_run_at,
                "missedByMs": gap_ms,
            })

    missed.sort(key=lambda m: m["missedByMs"], reverse=True)
    return missed


def to_record(price_list):
    """Adapt a Medusa price list into the {id, lastRunAt} shape the pure function expects."""
    last_run_iso = price_list.get("updated_at") or price_list.get("ends_at")
    last_run_at = None
    if last_run_iso:
        last_run_at = datetime.fromisoformat(last_run_iso.replace("Z", "+00:00"))
    return {"id": price_list["id"], "lastRunAt": last_run_at}


def mark_synced(token, price_list_id, synced_at_iso):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/price-lists/{price_list_id}",
        json={"metadata": {"last_synced_at": synced_at_iso}},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def rerun_expiry_sweep_for_one(price_list_id):
    """Invoke the same workflow src/jobs/expire-price-lists.ts would run,
    scoped to exactly one record so a missed tick affects nothing else."""
    import subprocess
    subprocess.run(
        ["npx", "medusa", "exec", "./src/scripts/expire-one-price-list.ts", price_list_id],
        check=True,
    )


def run():
    token = get_token()
    price_lists = list_price_lists(token)
    by_id = {p["id"]: p for p in price_lists}

    records = [to_record(p) for p in price_lists]
    now = datetime.now(timezone.utc)
    missed = find_missed_runs(records, JOB_CRON, now, GRACE_MULTIPLIER)

    if not missed:
        log.info("No missed runs across %d record(s).", len(price_lists))
        return

    for item in missed:
        title = by_id[item["id"]].get("title")
        log.warning(
            "Record %s (%s) missed run expected at %s, missed by %.0f ms.",
            item["id"], title, item["expectedRunAt"].isoformat(), item["missedByMs"],
        )

    if not DRY_RUN:
        synced_at_iso = now.isoformat()
        for item in missed:
            log.info("Record %s: re-running expiry sweep.", item["id"])
            rerun_expiry_sweep_for_one(item["id"])
            mark_synced(token, item["id"], synced_at_iso)

    log.info("Done. %d record(s) %s.", len(missed), "to review" if DRY_RUN else "repaired")


if __name__ == "__main__":
    run()
