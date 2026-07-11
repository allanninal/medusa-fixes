from classify_stuck_jobs import classify_job

NOW = 1_800_000_000_000
STEP_TIMEOUT_MS = 60_000


def job(**over):
    base = {
        "id": "job-transaction-sync-job",
        "timestamp": NOW - 1_000,
        "processedOn": None,
        "finishedOn": None,
        "failedReason": None,
        "attemptsMade": 0,
        "opts": {"attempts": 3},
    }
    base.update(over)
    return base


def test_healthy_when_freshly_queued():
    assert classify_job(job(), NOW, STEP_TIMEOUT_MS) == "healthy"


def test_orphaned_not_found_from_failed_reason():
    j = job(failedReason='Error: Workflow with id "job-transaction-sync-job" not found')
    assert classify_job(j, NOW, STEP_TIMEOUT_MS) == "orphaned-not-found"


def test_stuck_active_when_processed_but_not_finished_past_timeout():
    j = job(processedOn=NOW - STEP_TIMEOUT_MS - 1)
    assert classify_job(j, NOW, STEP_TIMEOUT_MS) == "stuck-active"


def test_not_stuck_active_when_within_timeout():
    j = job(processedOn=NOW - 1_000)
    assert classify_job(j, NOW, STEP_TIMEOUT_MS) == "healthy"


def test_exhausted_retries_when_attempts_used_up():
    j = job(attemptsMade=3, opts={"attempts": 3}, failedReason="boom")
    assert classify_job(j, NOW, STEP_TIMEOUT_MS) == "exhausted-retries"


def test_not_exhausted_when_finished_even_if_attempts_high():
    j = job(attemptsMade=3, opts={"attempts": 3}, failedReason="boom", finishedOn=NOW)
    assert classify_job(j, NOW, STEP_TIMEOUT_MS) == "healthy"


def test_pending_too_long_when_never_processed():
    j = job(timestamp=NOW - STEP_TIMEOUT_MS - 1)
    assert classify_job(j, NOW, STEP_TIMEOUT_MS) == "pending-too-long"


def test_not_found_takes_priority_over_other_signals():
    j = job(
        failedReason='Workflow with id "x" not found',
        processedOn=NOW - STEP_TIMEOUT_MS - 1,
        attemptsMade=3,
        opts={"attempts": 3},
    )
    assert classify_job(j, NOW, STEP_TIMEOUT_MS) == "orphaned-not-found"


def test_exactly_at_timeout_is_not_yet_stuck():
    j = job(processedOn=NOW - STEP_TIMEOUT_MS)
    assert classify_job(j, NOW, STEP_TIMEOUT_MS) == "healthy"


def test_missing_attempts_option_defaults_to_one():
    j = job(attemptsMade=1, opts={}, failedReason="boom")
    assert classify_job(j, NOW, STEP_TIMEOUT_MS) == "exhausted-retries"
