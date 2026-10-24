from fastapi.testclient import TestClient

from app.main import app


def test_estimate_endpoint(pdf_bytes):
    r = TestClient(app).post("/api/estimate", files=[("files", ("a.pdf", pdf_bytes, "application/pdf"))])
    assert r.status_code == 200 and r.json()["files"][0]["pages"] == 5


def test_run_requires_key(pdf_bytes, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    r = TestClient(app).post("/api/run", files=[("files", ("a.pdf", pdf_bytes, "application/pdf"))])
    assert r.status_code == 500 and "OPENROUTER_API_KEY" in r.json()["detail"]


def test_job_files_cannot_escape_the_job_dir(tmp_path):
    from app import main
    (tmp_path / "job").mkdir()
    (tmp_path / "secret").write_text("x")
    main.jobs["j"] = {"events": [], "dir": tmp_path / "job"}
    assert TestClient(app).get("/api/jobs/j/files/../secret").status_code == 404
    assert TestClient(app).get("/api/jobs/j/files/%2e%2e/secret").status_code == 404


def test_event_stream_ends_only_on_the_done_event():
    from app import main
    main.jobs["s"] = {"events": [{"type": "file", "done": 3}, {"type": "req", "state": "ok"}, {"type": "done", "usd": 0}],
                      "dir": None}
    body = TestClient(app).get("/api/jobs/s/events").text
    assert body.count("data: ") == 3
