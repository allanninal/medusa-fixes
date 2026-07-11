from find_duplicate_ticks import find_duplicate_ticks

HOURLY = "0 * * * *"


def execution(**over):
    base = {"workflow_id": "job-name", "transaction_id": "tx_1", "created_at": "2026-07-10T00:00:00Z"}
    base.update(over)
    return base


def test_no_duplicate_for_a_single_execution():
    result = find_duplicate_ticks([execution()], HOURLY)
    assert result == []


def test_duplicate_when_two_transactions_share_a_tick():
    rows = [
        execution(transaction_id="tx_1", created_at="2026-07-10T00:00:00Z"),
        execution(transaction_id="tx_2", created_at="2026-07-10T00:00:02Z"),
    ]
    result = find_duplicate_ticks(rows, HOURLY)
    assert len(result) == 1
    assert sorted(result[0]["transactionIds"]) == ["tx_1", "tx_2"]


def test_not_duplicate_when_on_different_ticks():
    rows = [
        execution(transaction_id="tx_1", created_at="2026-07-10T00:00:00Z"),
        execution(transaction_id="tx_2", created_at="2026-07-10T01:00:00Z"),
    ]
    result = find_duplicate_ticks(rows, HOURLY)
    assert result == []


def test_same_transaction_twice_is_not_a_duplicate_tick():
    rows = [
        execution(transaction_id="tx_1", created_at="2026-07-10T00:00:00Z"),
        execution(transaction_id="tx_1", created_at="2026-07-10T00:00:01Z"),
    ]
    result = find_duplicate_ticks(rows, HOURLY)
    assert result == []


def test_tolerance_window_still_groups_slightly_offset_fires():
    rows = [
        execution(transaction_id="tx_1", created_at="2026-07-10T00:00:00Z"),
        execution(transaction_id="tx_2", created_at="2026-07-10T00:00:04Z"),
    ]
    result = find_duplicate_ticks(rows, HOURLY, bucket_tolerance_ms=5000)
    assert len(result) == 1


def test_three_processes_produce_three_transaction_ids():
    rows = [
        execution(transaction_id="tx_1", created_at="2026-07-10T00:00:00Z"),
        execution(transaction_id="tx_2", created_at="2026-07-10T00:00:01Z"),
        execution(transaction_id="tx_3", created_at="2026-07-10T00:00:02Z"),
    ]
    result = find_duplicate_ticks(rows, HOURLY)
    assert len(result) == 1
    assert len(result[0]["transactionIds"]) == 3


def test_different_workflow_ids_are_kept_independent():
    rows = [
        execution(workflow_id="job-a", transaction_id="tx_1", created_at="2026-07-10T00:00:00Z"),
        execution(workflow_id="job-a", transaction_id="tx_2", created_at="2026-07-10T00:00:01Z"),
        execution(workflow_id="job-b", transaction_id="tx_3", created_at="2026-07-10T00:00:00Z"),
    ]
    result = find_duplicate_ticks(rows, HOURLY)
    assert len(result) == 1
