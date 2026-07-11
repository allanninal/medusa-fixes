from find_missing_order_transactions import decide_order_transaction_repair


def order(**over):
    base = {"id": "order_1", "currency_code": "usd", "paid_total": 0}
    base.update(over)
    return base


def payment(**over):
    base = {"id": "pay_1", "amount": 100, "captured_at": "2026-07-10T00:00:00Z", "canceled_at": None}
    base.update(over)
    return base


def test_creates_transaction_when_single_captured_payment_missing_ref():
    result = decide_order_transaction_repair(order(), [payment()], set())
    assert result["action"] == "create_transaction"
    assert result["order_id"] == "order_1"
    assert result["payment_id"] == "pay_1"
    assert result["missing_amount"] == 100


def test_noop_when_no_payments_captured():
    result = decide_order_transaction_repair(order(), [payment(captured_at=None)], set())
    assert result["action"] == "noop"


def test_noop_when_captured_payment_already_has_ref():
    result = decide_order_transaction_repair(order(paid_total=100), [payment()], {"pay_1"})
    assert result["action"] == "noop"


def test_noop_when_canceled_even_if_captured_at_set():
    result = decide_order_transaction_repair(order(), [payment(canceled_at="2026-07-11T00:00:00Z")], set())
    assert result["action"] == "noop"


def test_flags_ambiguous_when_multiple_captured_payments():
    payments = [payment(id="pay_1"), payment(id="pay_2")]
    result = decide_order_transaction_repair(order(), payments, set())
    assert result["action"] == "flag_ambiguous"


def test_flags_ambiguous_when_partial_reference_coverage():
    payments = [payment(id="pay_1"), payment(id="pay_2")]
    result = decide_order_transaction_repair(order(), payments, {"pay_1"})
    assert result["action"] == "flag_ambiguous"


def test_noop_when_paid_total_already_matches_expected():
    result = decide_order_transaction_repair(order(paid_total=100), [payment()], set())
    # paid_total already covers the captured amount even though the ref set is empty
    assert result["action"] == "noop"


def test_missing_amount_accounts_for_partial_existing_paid_total():
    result = decide_order_transaction_repair(order(paid_total=40), [payment(amount=100)], set())
    assert result["action"] == "create_transaction"
    assert result["missing_amount"] == 60
