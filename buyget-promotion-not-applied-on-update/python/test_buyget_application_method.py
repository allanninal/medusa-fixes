from fix_buyget_application_method import (
    is_buyget_application_method_valid,
    build_corrected_application_method,
)


def valid_am(**over):
    base = {
        "id": "apmethod_1",
        "target_type": "items",
        "allocation": "across",
        "apply_to_quantity": 1,
        "max_quantity": None,
        "buy_rules": [{"attribute": "items.product_id", "operator": "in", "values": ["prod_1"]}],
        "target_rules": [{"attribute": "items.product_id", "operator": "in", "values": ["prod_2"]}],
        "buy_rules_min_quantity": 2,
    }
    base.update(over)
    return base


def test_valid_across_payload_passes():
    result = is_buyget_application_method_valid(valid_am())
    assert result == {"valid": True, "reasons": []}


def test_valid_each_payload_needs_max_quantity():
    am = valid_am(allocation="each", max_quantity=1)
    assert is_buyget_application_method_valid(am)["valid"] is True


def test_each_without_max_quantity_is_invalid():
    am = valid_am(allocation="each", max_quantity=None)
    result = is_buyget_application_method_valid(am)
    assert result["valid"] is False
    assert "max_quantity is required when allocation is each" in result["reasons"]


def test_target_type_order_is_invalid():
    result = is_buyget_application_method_valid(valid_am(target_type="order"))
    assert result["valid"] is False
    assert any("target_type" in r for r in result["reasons"])


def test_empty_target_rules_is_invalid():
    result = is_buyget_application_method_valid(valid_am(target_rules=[]))
    assert result["valid"] is False
    assert "target_rules is empty" in result["reasons"]


def test_missing_target_rules_key_is_invalid():
    am = valid_am()
    del am["target_rules"]
    result = is_buyget_application_method_valid(am)
    assert result["valid"] is False
    assert "target_rules is empty" in result["reasons"]


def test_empty_buy_rules_is_invalid():
    result = is_buyget_application_method_valid(valid_am(buy_rules=[]))
    assert result["valid"] is False
    assert "buy_rules is empty" in result["reasons"]


def test_missing_buy_rules_min_quantity_is_invalid():
    result = is_buyget_application_method_valid(valid_am(buy_rules_min_quantity=None))
    assert result["valid"] is False
    assert "buy_rules_min_quantity is missing or not positive" in result["reasons"]


def test_zero_buy_rules_min_quantity_is_invalid():
    result = is_buyget_application_method_valid(valid_am(buy_rules_min_quantity=0))
    assert result["valid"] is False


def test_negative_buy_rules_min_quantity_is_invalid():
    result = is_buyget_application_method_valid(valid_am(buy_rules_min_quantity=-1))
    assert result["valid"] is False


def test_bad_allocation_is_invalid():
    result = is_buyget_application_method_valid(valid_am(allocation="whole_order"))
    assert result["valid"] is False
    assert "allocation must be across or each" in result["reasons"]


def test_missing_apply_to_quantity_is_invalid():
    result = is_buyget_application_method_valid(valid_am(apply_to_quantity=None))
    assert result["valid"] is False
    assert "apply_to_quantity is missing" in result["reasons"]


def test_multiple_reasons_can_be_reported_together():
    result = is_buyget_application_method_valid(
        valid_am(target_type="order", target_rules=[], buy_rules=[])
    )
    assert result["valid"] is False
    assert len(result["reasons"]) == 3


def test_build_corrected_application_method_fixes_target_type():
    am = valid_am(target_type="order")
    corrected = build_corrected_application_method(am)
    assert corrected["target_type"] == "items"
    assert corrected["id"] == "apmethod_1"
    assert corrected["buy_rules"] == am["buy_rules"]
    assert corrected["target_rules"] == am["target_rules"]
    assert "max_quantity" not in corrected


def test_build_corrected_application_method_fills_max_quantity_for_each():
    am = valid_am(allocation="each", max_quantity=None, apply_to_quantity=3)
    corrected = build_corrected_application_method(am)
    assert corrected["allocation"] == "each"
    assert corrected["max_quantity"] == 3


def test_build_corrected_application_method_defaults_bad_allocation_to_across():
    am = valid_am(allocation="whole_order")
    corrected = build_corrected_application_method(am)
    assert corrected["allocation"] == "across"


def test_build_corrected_application_method_falls_back_apply_to_quantity():
    am = valid_am(apply_to_quantity=None, buy_rules_min_quantity=2)
    corrected = build_corrected_application_method(am)
    assert corrected["apply_to_quantity"] == 2
