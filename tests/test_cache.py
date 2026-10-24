from app.cache import Cache


def test_roundtrip_and_miss(tmp_path):
    c = Cache(tmp_path)
    assert c.get("a", "b") is None
    c.put({"x": 1}, "a", "b")
    assert c.get("a", "b") == {"x": 1}
    assert c.get("a", "c") is None
