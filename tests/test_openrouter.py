import json

import httpx

from app.openrouter import OpenRouter, extract_file_annotations


def ann(h, text="t"):
    return {"type": "file", "file": {"hash": h, "name": "d.pdf", "content": [{"type": "text", "text": text}]}}


def test_extract_dedupes_across_success_and_error():
    resp = {"choices": [{"message": {"annotations": [ann("a"), ann("b")]}}],
            "error": {"metadata": {"file_annotations": [ann("b"), ann("c")]}}}
    assert [a["file"]["hash"] for a in extract_file_annotations(resp)] == ["a", "b", "c"]


def test_extract_handles_garbage():
    assert extract_file_annotations("x") == []
    assert extract_file_annotations({"choices": [{"message": {"annotations": [{"type": "x"}]}}]}) == []


def test_ocr_pdf_request_and_parse():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        seen["auth"] = request.headers["authorization"]
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok", "annotations": [ann("h", "# Hi $x^2$")]}}],
                                         "usage": {"cost": 0.04}})

    c = OpenRouter("k", "https://x/api/v1", ocr_model="m", transport=httpx.MockTransport(handler))
    out = c.ocr_pdf(b"%PDF", "d.pdf", engine="mistral-ocr")
    assert seen["auth"] == "Bearer k"
    assert seen["body"]["plugins"] == [{"id": "file-parser", "pdf": {"engine": "mistral-ocr"}}]
    part = seen["body"]["messages"][0]["content"][1]
    assert part["type"] == "file" and part["file"]["file_data"].startswith("data:application/pdf;base64,")
    assert out["texts"] == ["# Hi $x^2$"] and out["cost"] == 0.04


def test_retries_on_429_then_succeeds():
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(429, json={})
        return httpx.Response(200, json={"choices": [{"message": {"content": "desc"}}], "usage": {}})

    c = OpenRouter("k", "https://x/api/v1", sleep=lambda s: None, transport=httpx.MockTransport(handler))
    assert c.vision(b"png", "p", "vm")["text"] == "desc"
    assert len(calls) == 3


def test_vision_retries_with_reasoning_off_when_content_empty():
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        content = None if len(bodies) == 1 else "figure"
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}], "usage": {"cost": 0.001}})

    c = OpenRouter("k", "https://x/api/v1", transport=httpx.MockTransport(handler))
    out = c.vision(b"png", "p", "vm", reasoning={"effort": "low"})
    assert out["text"] == "figure" and out["cost"] == 0.002
    assert bodies[0]["reasoning"] == {"effort": "low"} and bodies[1]["reasoning"] == {"enabled": False}


def test_vision_raises_when_always_empty():
    import pytest

    def handler(request):
        return httpx.Response(200, json={"choices": [{"message": {"content": None}}], "usage": {}})

    c = OpenRouter("k", "https://x/api/v1", transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError):
        c.vision(b"png", "p", "vm")


def test_transport_error_is_retried():
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectError("down")
        return httpx.Response(200, json={"choices": [{"message": {"content": "x"}}]})

    c = OpenRouter("k", "https://x/api/v1", sleep=lambda s: None, transport=httpx.MockTransport(handler))
    assert c.vision(b"png", "p", "vm")["text"] == "x"


def test_error_message_surfaces_and_is_not_retried():
    import pytest
    from app.openrouter import OpenRouterError

    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(402, json={"error": {"code": 402, "message": "Insufficient credits"}})

    c = OpenRouter("k", "https://x/api/v1", sleep=lambda s: None, transport=httpx.MockTransport(handler))
    with pytest.raises(OpenRouterError, match="Insufficient credits"):
        c.vision(b"png", "p", "vm")
    assert len(calls) == 1


def test_ocr_keeps_annotations_from_error_response():
    def handler(request):
        return httpx.Response(502, json={"error": {"code": 502, "message": "Provider returned an error",
                                                   "metadata": {"file_annotations": [ann("h", "parsed")]}}})

    c = OpenRouter("k", "https://x/api/v1", sleep=lambda s: None, transport=httpx.MockTransport(handler))
    assert c.ocr_pdf(b"%PDF", "d.pdf")["texts"] == ["parsed"]
