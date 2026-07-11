"""Find Medusa v2 scheduled job ticks that fired more than once, because
more than one process is running in shared or worker WORKER_MODE against
the same database, with no distributed lock coordinating them.

This is an infrastructure and config defect, not a data problem. It only
reports the duplicate ticks, it never resends a suppressed side effect
and never deletes a workflow_execution row. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/scheduled-job-runs-twice/
"""
import os
import logging
from datetime import datetime, timedelta

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_duplicate_ticks")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
JOB_WORKFLOW_ID = os.environ.get("JOB_WORKFLOW_ID", "job-name")
JOB_CRON = os.environ.get("JOB_CRON", "*/15 * * * *")
BUCKET_TOLERANCE_MS = float(os.environ.get("BUCKET_TOLERANCE_MS", "5000"))

EXECUTION_FIELDS = "id,transaction_id,workflow_id,created_at,state"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_workflow_executions(token, workflow_id, limit=200):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/workflows-executions",
        params={"workflow_id": workflow_id, "fields": EXECUTION_FIELDS, "limit": limit,
                "order": "created_at"},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["workflow_executions"]


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


def nearest_tick_boundary(cron_expression, at, search_minutes=1440):
    """Minute-aligned tick boundary matching the cron spec closest to `at`."""
    spec = _parse_cron(cron_expression)
    base = at.replace(second=0, microsecond=0)
    if _matches(base, spec):
        return base
    for offset in range(1, search_minutes + 1):
        earlier = base - timedelta(minutes=offset)
        if _matches(earlier, spec):
            return earlier
        later = base + timedelta(minutes=offset)
        if _matches(later, spec):
            return later
    raise RuntimeError("No matching tick boundary found within search window")


def find_duplicate_ticks(executions, cron_schedule, bucket_tolerance_ms=5000):
    """Pure: no I/O, no clock access. executions is a list of
    {"workflow_id", "transaction_id", "created_at"} dicts already fetched."""
    by_workflow = {}
    for execution in executions:
        by_workflow.setdefault(execution["workflow_id"], []).append(execution)

    duplicates = []
    for workflow_id, rows in by_workflow.items():
        buckets = {}
        for row in rows:
            created_at = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
            tick = nearest_tick_boundary(cron_schedule, created_at)
            delta_ms = abs((created_at - tick).total_seconds() * 1000)
            if delta_ms > bucket_tolerance_ms:
                continue
            key = tick.isoformat()
            buckets.setdefault(key, set()).add(row["transaction_id"])

        for tick_bucket, tx_ids in buckets.items():
            if len(tx_ids) > 1:
                duplicates.append({
                    "tickBucket": tick_bucket,
                    "transactionIds": sorted(tx_ids),
                })

    duplicates.sort(key=lambda d: d["tickBucket"])
    return duplicates


def write_audit_report(job_name, duplicates):
    """The only write this script does: an audit log line per duplicate tick.
    Never resends a suppressed side effect, never deletes an execution row."""
    for item in duplicates:
        log.warning(
            "DUPLICATE TICK job=%s tick=%s transaction_ids=%s inferred_replicas=%d",
            job_name, item["tickBucket"], item["transactionIds"], len(item["transactionIds"]),
        )


def run():
    token = get_token()
    executions = list_workflow_executions(token, JOB_WORKFLOW_ID)
    duplicates = find_duplicate_ticks(executions, JOB_CRON, BUCKET_TOLERANCE_MS)

    if not duplicates:
        log.info("No duplicate ticks across %d execution(s) for %s.", len(executions), JOB_WORKFLOW_ID)
        return

    for item in duplicates:
        log.warning(
            "Tick %s fired %d time(s): %s",
            item["tickBucket"], len(item["transactionIds"]), item["transactionIds"],
        )

    if not DRY_RUN:
        write_audit_report(JOB_WORKFLOW_ID, duplicates)

    log.info("Done. %d duplicate tick(s) %s.", len(duplicates), "to review" if DRY_RUN else "reported")


if __name__ == "__main__":
    run()
