from find_broken_images import classify_image_health

HOSTS = ["cdn.example.com", "my-bucket.s3.amazonaws.com"]


def test_ok_when_status_200_on_configured_host():
    check = {"url": "https://cdn.example.com/shirt.jpg", "status": 200, "error": None, "configured_hosts": HOSTS}
    assert classify_image_health(check)["state"] == "ok"


def test_unreachable_on_404_same_host():
    check = {"url": "https://cdn.example.com/gone.jpg", "status": 404, "error": None, "configured_hosts": HOSTS}
    assert classify_image_health(check)["state"] == "unreachable"


def test_unreachable_on_network_error():
    check = {"url": "https://cdn.example.com/timeout.jpg", "status": None, "error": "timed out", "configured_hosts": HOSTS}
    assert classify_image_health(check)["state"] == "unreachable"


def test_unreachable_on_5xx():
    check = {"url": "https://cdn.example.com/oops.jpg", "status": 503, "error": None, "configured_hosts": HOSTS}
    assert classify_image_health(check)["state"] == "unreachable"


def test_foreign_host_even_when_200():
    check = {"url": "http://localhost:9000/uploads/old.jpg", "status": 200, "error": None, "configured_hosts": HOSTS}
    assert classify_image_health(check)["state"] == "foreign_host"


def test_malformed_url_string():
    check = {"url": "not-a-url", "status": None, "error": None, "configured_hosts": HOSTS}
    assert classify_image_health(check)["state"] == "malformed"


def test_malformed_wins_over_status():
    check = {"url": "", "status": 200, "error": None, "configured_hosts": HOSTS}
    assert classify_image_health(check)["state"] == "malformed"


def test_foreign_host_case_insensitive_match():
    check = {"url": "https://CDN.example.com/shirt.jpg", "status": 200, "error": None, "configured_hosts": HOSTS}
    assert classify_image_health(check)["state"] == "ok"
