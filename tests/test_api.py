from fastapi.testclient import TestClient

from app.main import app


def test_estimate_endpoint(pdf_bytes):
    r = TestClient(app).post("/api/estimate", files=[("files", ("a.pdf", pdf_bytes, "application/pdf"))])
    body = r.json()
    assert r.status_code == 200 and body["files"][0]["pages"] == 5
    assert body["usd"]["vision"] < body["usd"]["ocr+vision"]


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


def test_zip_of_a_run_on_disk_after_restart(tmp_path, monkeypatch):
    import io
    import zipfile
    from app import main
    run = tmp_path / "20260101-000000-abcd"
    (run / "lecture/images").mkdir(parents=True)
    (run / "Course_Slides-01.md").write_text("# x")
    (run / "lecture/images/p001.png").write_bytes(b"png")
    (run / "old-layout").mkdir()
    (run / "old-layout/old-layout.md").write_text("# y")
    monkeypatch.setattr(main, "OUT", tmp_path)
    client = TestClient(app)
    names = lambda r: sorted(zipfile.ZipFile(io.BytesIO(r.content)).namelist())  # noqa: E731
    assert names(client.get(f"/api/jobs/{run.name}/zip?only=markdown")) == ["Course_Slides-01.md", "old-layout.md"]
    assert names(client.get(f"/api/jobs/{run.name}/zip")) == ["Course_Slides-01.md", "lecture/images/p001.png",
                                                              "old-layout/old-layout.md"]
    assert client.get("/api/jobs/..%2F..%2Fetc/zip").status_code == 404
