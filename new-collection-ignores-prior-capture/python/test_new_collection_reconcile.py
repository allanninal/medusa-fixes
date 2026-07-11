from reconcile_new_collection import reconcile_outstanding_amount


def summary(**over):
    base = {"currentOrderTotal": 120.0, "paidTotal": 100.0, "refundedTotal": 0.0, "transactionTotal": 100.0}
    base.update(over)
    return base


def test_none_when_nothing_owed():
    result = reconcile_outstanding_amount(summary(currentOrderTotal=100.0), [])
    assert result["action"] == "none"


def test_none_when_open_collection_matches_pending_difference():
    # pending_difference = 120 - 100 - 0 = 20, open collection is 20: correct.
    collections = [{"id": "paycol_1", "amount": 20.0, "status": "not_paid"}]
    result = reconcile_outstanding_amount(summary(), collections)
    assert result["action"] == "none"


def test_recreate_when_single_open_collection_sized_off_full_total():
    # pending_difference = 20, but the open collection was created for the full new total 120.
    collections = [{"id": "paycol_1", "amount": 120.0, "status": "not_paid"}]
    result = reconcile_outstanding_amount(summary(), collections)
    assert result["action"] == "recreate"
    assert result["correctAmount"] == 20.0
    assert result["staleCollectionIds"] == ["paycol_1"]


def test_flag_when_multiple_open_collections_are_ambiguous():
    collections = [
        {"id": "paycol_1", "amount": 70.0, "status": "not_paid"},
        {"id": "paycol_2", "amount": 60.0, "status": "awaiting"},
    ]
    result = reconcile_outstanding_amount(summary(), collections)
    assert result["action"] == "flag"
    assert set(result["staleCollectionIds"]) == {"paycol_1", "paycol_2"}


def test_none_when_no_prior_capture_even_if_over_sized_looking():
    # A fresh order, nothing paid yet: current total and pending difference are the same,
    # so a collection at the full total is correct, not a bug.
    collections = [{"id": "paycol_1", "amount": 120.0, "status": "not_paid"}]
    result = reconcile_outstanding_amount(
        summary(currentOrderTotal=120.0, paidTotal=0.0), collections
    )
    assert result["action"] == "none"


def test_canceled_collections_are_ignored_in_the_open_total():
    collections = [
        {"id": "paycol_1", "amount": 120.0, "status": "canceled"},
        {"id": "paycol_2", "amount": 20.0, "status": "not_paid"},
    ]
    result = reconcile_outstanding_amount(summary(), collections)
    assert result["action"] == "none"


def test_rounding_epsilon_does_not_false_positive():
    collections = [{"id": "paycol_1", "amount": 20.004, "status": "not_paid"}]
    result = reconcile_outstanding_amount(summary(), collections)
    assert result["action"] == "none"


def test_refunded_total_reduces_pending_difference():
    result = reconcile_outstanding_amount(
        summary(currentOrderTotal=120.0, paidTotal=100.0, refundedTotal=20.0), []
    )
    assert result["action"] == "none"
    assert result["correctAmount"] == 0.0
