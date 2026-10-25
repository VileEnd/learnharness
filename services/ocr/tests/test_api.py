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


def test_events_resume_from_an_offset_and_old_runs_report_gone(tmp_path, monkeypatch):
    from app import main
    main.jobs["r"] = {"events": [{"type": "start"}, {"type": "log", "msg": "a"}, {"type": "done", "usd": 0}],
                      "dir": None}
    assert TestClient(app).get("/api/jobs/r/events?from=1").text.count("data: ") == 2
    (tmp_path / "20260101-000000-abcd").mkdir()
    monkeypatch.setattr(main, "OUT", tmp_path)
    body = TestClient(app).get("/api/jobs/20260101-000000-abcd/events").text
    assert '"type": "gone"' in body


def test_retry_runs_only_pdfs_with_failed_pages(tmp_path, monkeypatch):
    import json
    from app import main
    for folder, failed in (("ok", []), ("bad", [3])):
        (tmp_path / folder).mkdir()
        (tmp_path / folder / "manifest.json").write_text(json.dumps({"markdown": f"{folder}.md", "failed_pages": failed}))
    launched = []
    monkeypatch.setattr(main, "launch", lambda job, items, client: launched.extend(items))
    monkeypatch.setattr(main, "make_client", lambda: None)
    main.jobs["t"] = {"events": [], "dir": tmp_path, "running": False, "cfg": {},
                      "uploads": [("ok.pdf", b"1", "ok"), ("bad.pdf", b"2", "bad")]}
    assert TestClient(app).post("/api/jobs/t/retry").json() == {"from": 0, "files": 1}
    assert launched == [("bad.pdf", b"2", "bad", "bad.md")]


def test_retry_of_a_run_from_before_a_restart_explains_what_to_do(tmp_path, monkeypatch):
    from app import main
    (tmp_path / "20260101-000000-abcd").mkdir()
    monkeypatch.setattr(main, "OUT", tmp_path)
    r = TestClient(app).post("/api/jobs/20260101-000000-abcd/retry")
    assert r.status_code == 409 and "Drop the same PDFs again" in r.json()["detail"]


def test_runs_lists_past_runs_newest_first_with_totals(tmp_path, monkeypatch):
    import json
    from app import main
    for run, pages, failed in (("20260101-000000-aaaa", 3, []), ("20260102-000000-bbbb", 5, [2])):
        (tmp_path / run / "doc").mkdir(parents=True)
        (tmp_path / run / "doc/manifest.json").write_text(json.dumps(
            {"markdown": "Doc.md", "title": "Doc", "source": "doc.pdf", "pages": pages, "failed_pages": failed,
             "cost_usd": 0.01}))
    monkeypatch.setattr(main, "OUT", tmp_path)
    runs = TestClient(app).get("/api/runs").json()
    assert [r["job"] for r in runs] == ["20260102-000000-bbbb", "20260101-000000-aaaa"]
    assert runs[0]["pages"] == 5 and runs[0]["failed_pages"] == 1 and runs[0]["running"] is False
    assert runs[0]["markdown"][0]["file"] == "Doc.md" and runs[0]["has_images"] is False
