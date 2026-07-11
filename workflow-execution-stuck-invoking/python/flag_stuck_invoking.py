"""Flag Medusa workflow_execution rows stuck in the invoking state.

Medusa only persists a workflow_execution row when a workflow is marked store: true,
which long running workflows get automatically, and the row's state is meant to move
through invoking to done, failed, or compensating as async steps complete. An async
step (async: true, or one with a retryInterval) only advances the row when it gets its
external completion signal: a webhook calling setStepSuccess, a worker checking back in,
a subscriber firing. If that signal never arrives, the row is stuck mid invoke, and
without an explicit retentionTime there is no built in TTL sweep to expire it, so it can
sit there indefinitely (GitHub #9077, #11175).

This connects read only to Postgres, lists rows still in the invoking state, flags the
ones stuck past an expected TTL with a pure function, and reports the transaction ids
for an operator to retry with the Workflow Engine Module's retryStep. It never deletes
or updates workflow_execution directly. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/workflow-execution-stuck-invoking/
"""
import os
import logging
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_stuck_invoking")

DATABASE_URL = os.environ.get("MEDUSA_DATABASE_URL", "postgres://user:pass@localhost:5432/medusa")
DEFAULT_TTL_MINUTES = float(os.environ.get("DEFAULT_TTL_MINUTES", "20"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Per workflow_id TTL overrides, in minutes. Extend this if a workflow legitimately
# needs longer than DEFAULT_TTL_MINUTES to receive its async completion signal.
TTL_MINUTES_BY_WORKFLOW = {}

INVOKING_QUERY = """
    SELECT id, workflow_id, transaction_id, state, retention_time, created_at, updated_at
    FROM workflow_execution
    WHERE state = 'invoking'
"""


def is_stuck_invoking(row, now_ms, ttl_ms_by_workflow, default_ttl_ms):
    """Pure decision function. No I/O.

    row: {"state": str, "created_at": datetime, "updated_at": datetime | None, "workflow_id": str}
    now_ms: int (epoch milliseconds)
    ttl_ms_by_workflow: dict[str, int]
    default_ttl_ms: int

    Returns True only when row["state"] == "invoking" and the row has been
    sitting past its TTL since it was last updated (or created, if never updated).
    """
    if row.get("state") != "invoking":
        return False

    reference = row.get("updated_at") or row.get("created_at")
    if reference is None:
        return False

    ttl_ms = ttl_ms_by_workflow.get(row.get("workflow_id"), default_ttl_ms)
    elapsed_ms = now_ms - reference.timestamp() * 1000
    return elapsed_ms > ttl_ms


def detect_flapping(previous_ids, current_ids, ever_seen_ids):
    """Pure. Returns the set of transaction_ids seen before, missing last poll,
    and present again now (present -> absent -> present)."""
    reappeared = (ever_seen_ids - previous_ids) & current_ids
    return reappeared


def list_invoking_rows():
    """Network I/O lives only here and in run(). Imported lazily so importing
    this module (for the pure function or its tests) never requires psycopg2."""
    import psycopg2
    import psycopg2.extras

    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(INVOKING_QUERY)
            return [dict(row) for row in cur.fetchall()]
    finally:
        conn.close()


def run():
    now_ms = datetime.now(timezone.utc).timestamp() * 1000
    ttl_ms_by_workflow = {k: v * 60000 for k, v in TTL_MINUTES_BY_WORKFLOW.items()}
    default_ttl_ms = DEFAULT_TTL_MINUTES * 60000

    rows = list_invoking_rows()
    stuck = [row for row in rows if is_stuck_invoking(row, now_ms, ttl_ms_by_workflow, default_ttl_ms)]

    if DRY_RUN:
        log.info("Dry run. Reporting only, no state is ever changed by this script.")

    for row in stuck:
        reference = row.get("updated_at") or row.get("created_at")
        elapsed_minutes = (now_ms - reference.timestamp() * 1000) / 60000
        log.warning(
            "Stuck invoking: transaction_id=%s workflow_id=%s elapsed=%.1fmin. "
            "Operator action: retryStep, or cancel via the workflow's own compensation.",
            row["transaction_id"], row["workflow_id"], elapsed_minutes,
        )

    log.info("Done. %d workflow_execution row(s) stuck on invoking out of %d total in that state.",
              len(stuck), len(rows))


if __name__ == "__main__":
    run()
