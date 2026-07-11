"""Flag Medusa product import transactions stuck at preprocessing.

importProductsWorkflow, which powers POST /admin/products/import, deliberately
pauses at waitConfirmationProductImportStep after normalizeCsvStep finishes. That
pause is the preprocessing state, and the transaction sits idle in the workflow
engine's data store until something calls
POST /admin/products/import/:transaction_id/confirm, which runs setStepSuccess on
it. If that confirm call is dropped, the operator never notices the review prompt,
or the workflow engine's event bus is misconfigured, the transaction never resumes
and no product.created or product.updated event ever fires, since v2 only emits
those after the workflow fully succeeds.

Medusa v2 has no route that lists every pending import, so this script keeps its
own tracking file of transaction_id, summary, and start time, and polls the
workflow engine's state for each tracked transaction. Anything still invoking or
waiting past IMPORT_TIMEOUT_MINUTES with no completion event observed is reported
as stuck. It never calls confirm on your behalf. Run on a schedule.
Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/csv-import-stuck-preprocessing/
"""
import os
import json
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_stuck_import")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL")
ADMIN_PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD")
IMPORT_TIMEOUT_MINUTES = float(os.environ.get("IMPORT_TIMEOUT_MINUTES", "15"))
TRACKING_FILE = os.environ.get("IMPORT_TRACKING_FILE", "import_jobs.json")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def classify_import_job(job, now, timeout_ms):
    """Pure decision function. No I/O.

    job: {"transactionId": str, "createdAt": datetime, "workflowState": str,
          "lastEventAt": datetime | None}
    now: datetime
    timeout_ms: int (milliseconds)

    Returns {"status": "ok"|"completed"|"failed"|"stuck", "minutesStuck": float}
    """
    state = job["workflowState"]
    if state == "done":
        return {"status": "completed", "minutesStuck": 0.0}
    if state in ("failed", "reverted"):
        return {"status": "failed", "minutesStuck": 0.0}

    elapsed_ms = (now - job["createdAt"]).total_seconds() * 1000
    minutes_stuck = elapsed_ms / 60000

    if elapsed_ms > timeout_ms and job.get("lastEventAt") is None:
        return {"status": "stuck", "minutesStuck": minutes_stuck}
    return {"status": "ok", "minutesStuck": minutes_stuck}


def load_tracked_jobs():
    if not os.path.exists(TRACKING_FILE):
        return {}
    with open(TRACKING_FILE) as f:
        return json.load(f)


def save_tracked_jobs(jobs):
    with open(TRACKING_FILE, "w") as f:
        json.dump(jobs, f, indent=2, default=str)


def get_token():
    r = requests.post(
        f"{BACKEND_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def fetch_workflow_state(token, transaction_id):
    """Reads the workflow_execution row for this transaction via a custom
    read only admin route that queries workflow_id = 'import-products'.
    Returns a dict like {"state": "invoking", "lastEventAt": None} or None
    if the transaction can no longer be found."""
    r = requests.get(
        f"{BACKEND_URL}/admin/workflow-executions/import-products/{transaction_id}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def run():
    jobs = load_tracked_jobs()
    if not jobs:
        log.info("No tracked import transactions found in %s.", TRACKING_FILE)
        return

    token = get_token()
    timeout_ms = IMPORT_TIMEOUT_MINUTES * 60000
    now = datetime.datetime.now(datetime.timezone.utc)
    stuck_count = 0

    for transaction_id, job in jobs.items():
        state = fetch_workflow_state(token, transaction_id)
        if state is None:
            continue

        classified_job = {
            "transactionId": transaction_id,
            "createdAt": datetime.datetime.fromisoformat(job["createdAt"]),
            "workflowState": state["state"],
            "lastEventAt": (
                datetime.datetime.fromisoformat(state["lastEventAt"])
                if state.get("lastEventAt") else None
            ),
        }
        result = classify_import_job(classified_job, now, timeout_ms)

        if result["status"] == "stuck":
            stuck_count += 1
            log.warning(
                "STUCK import: transaction_id=%s summary=%s minutes_stuck=%.1f workflow_state=%s. "
                "Operator action: inspect the summary, then either confirm to resume it or "
                "discard it and re-submit a fresh import.",
                transaction_id, job.get("summary"), result["minutesStuck"], classified_job["workflowState"],
            )
            if not DRY_RUN:
                job["flagged_stale"] = True
        elif result["status"] in ("completed", "failed"):
            jobs.pop(transaction_id, None)

    save_tracked_jobs(jobs)
    log.info("Done. %d import transaction(s) flagged stuck out of %d tracked.", stuck_count, len(jobs))


if __name__ == "__main__":
    run()
