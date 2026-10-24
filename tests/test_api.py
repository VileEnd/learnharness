from fastapi.testclient import TestClient

from app.main import app


def test_estimate_endpoint(pdf_bytes):
    r = TestClient(app).post("/api/estimate", files=[("files", ("a.pdf", pdf_bytes, "application/pdf"))])
    assert r.status_code == 200 and r.json()["files"][0]["pages"] == 5


def test_run_requires_key(pdf_bytes, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    r = TestClient(app).post("/api/run", files=[("files", ("a.pdf", pdf_bytes, "application/pdf"))])
    assert r.status_code == 500 and "OPENROUTER_API_KEY" in r.json()["detail"]
