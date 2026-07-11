from datetime import datetime, timezone

from flag_stuck_import import classify_import_job

NOW = datetime(2026, 7, 10, 0, 20, 0, tzinfo=timezone.utc)


def job(**over):
    base = {
        "transactionId": "tx_01",
        "createdAt": datetime(2026, 7, 10, 0, 0, 0, tzinfo=timezone.utc),
        "workflowState": "waiting",
        "lastEventAt": None,
    }
    base.update(over)
    return base


def test_stuck_when_waiting_past_timeout_with_no_event():
    result = classify_import_job(job(), NOW, 10 * 60000)
    assert result["status"] == "stuck"
    assert result["minutesStuck"] == 20.0


def test_ok_when_within_timeout():
    result = classify_import_job(job(), NOW, 30 * 60000)
    assert result["status"] == "ok"


def test_completed_when_state_is_done():
    result = classify_import_job(job(workflowState="done"), NOW, 1)
    assert result["status"] == "completed"


def test_failed_when_state_is_failed():
    result = classify_import_job(job(workflowState="failed"), NOW, 1)
    assert result["status"] == "failed"


def test_failed_when_state_is_reverted():
    result = classify_import_job(job(workflowState="reverted"), NOW, 1)
    assert result["status"] == "failed"


def test_ok_when_past_timeout_but_event_seen():
    seen = datetime(2026, 7, 10, 0, 5, 0, tzinfo=timezone.utc)
    result = classify_import_job(job(lastEventAt=seen), NOW, 10 * 60000)
    assert result["status"] == "ok"


def test_invoking_state_also_evaluated_for_stuck():
    result = classify_import_job(job(workflowState="invoking"), NOW, 10 * 60000)
    assert result["status"] == "stuck"
