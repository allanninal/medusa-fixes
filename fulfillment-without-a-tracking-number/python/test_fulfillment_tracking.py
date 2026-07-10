from flag_untracked_shipments import find_untracked_shipments


def fulfillment(**over):
    base = {
        "id": "ful_1",
        "shipped_at": "2026-07-08T00:00:00Z",
        "canceled_at": None,
        "labels": [],
    }
    base.update(over)
    return base


def test_flagged_when_shipped_and_no_labels():
    result = find_untracked_shipments([fulfillment()])
    assert len(result) == 1
    assert result[0]["id"] == "ful_1"
    assert result[0]["reason"] == "shipped_at set but no non-empty tracking_number on any label"


def test_flagged_when_labels_have_blank_tracking_number():
    f = fulfillment(labels=[{"tracking_number": ""}, {"tracking_number": None}])
    assert len(find_untracked_shipments([f])) == 1


def test_not_flagged_when_a_label_has_a_tracking_number():
    f = fulfillment(labels=[{"tracking_number": "1Z999AA10123456784"}])
    assert find_untracked_shipments([f]) == []


def test_not_flagged_when_not_shipped():
    f = fulfillment(shipped_at=None)
    assert find_untracked_shipments([f]) == []


def test_not_flagged_when_canceled():
    f = fulfillment(canceled_at="2026-07-09T00:00:00Z")
    assert find_untracked_shipments([f]) == []


def test_not_flagged_when_tracking_number_is_whitespace_only():
    f = fulfillment(labels=[{"tracking_number": "   "}])
    assert len(find_untracked_shipments([f])) == 1


def test_not_flagged_when_missing_labels_key_entirely():
    f = fulfillment()
    del f["labels"]
    assert len(find_untracked_shipments([f])) == 1


def test_multiple_fulfillments_only_flags_the_untracked_one():
    tracked = fulfillment(id="ful_2", labels=[{"tracking_number": "TRACK123"}])
    untracked = fulfillment(id="ful_3")
    result = find_untracked_shipments([tracked, untracked])
    assert [r["id"] for r in result] == ["ful_3"]


def test_empty_input_returns_empty_list():
    assert find_untracked_shipments([]) == []
