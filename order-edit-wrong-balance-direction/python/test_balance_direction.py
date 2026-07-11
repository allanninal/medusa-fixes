from flag_wrong_balance_direction import decide_balance_action, reported_direction


def test_cheaper_swap_expects_refund():
    result = decide_balance_action(current_order_total=4000, paid_total=6000)
    assert result["direction"] == "refund"
    assert result["pendingDifference"] == -2000


def test_pricier_swap_expects_collect():
    result = decide_balance_action(current_order_total=8000, paid_total=6000)
    assert result["direction"] == "collect"
    assert result["pendingDifference"] == 2000


def test_no_op_edit_expects_none():
    result = decide_balance_action(current_order_total=6000, paid_total=6000)
    assert result["direction"] == "none"
    assert result["pendingDifference"] == 0


def test_operands_are_never_fed_swapped():
    # The exact regression in #13068 is feeding (paid_total, current_order_total)
    # instead of (current_order_total, paid_total). Swapping the arguments here
    # must flip the sign, proving the function is order-sensitive as intended.
    forward = decide_balance_action(current_order_total=4000, paid_total=6000)
    swapped = decide_balance_action(current_order_total=6000, paid_total=4000)
    assert forward["direction"] != swapped["direction"]
    assert forward["pendingDifference"] == -swapped["pendingDifference"]


def test_reported_direction_reads_negative_as_refund():
    order = {"summary": {"pending_difference": -1500}}
    assert reported_direction(order) == "refund"


def test_reported_direction_reads_positive_as_collect():
    order = {"summary": {"pending_difference": 1500}}
    assert reported_direction(order) == "collect"


def test_reported_direction_missing_summary_is_none():
    assert reported_direction({"summary": {}}) is None
