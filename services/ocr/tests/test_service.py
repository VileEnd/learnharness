import hashlib
import json
import time

import pytest
from fastapi.testclient import TestClient

from app import main
from app.cache import Cache
from app.naming import NAME_PROMPT
from conftest import make_pdf

keys = []


class StubClient:
    """Stands in for OpenRouter: records the key it was built with, answers without any network."""

    def __init__(self, key, *args, **kwargs):
        keys.append(key)

    def ocr_pdf(self, pdf_bytes, name, engine, on_retry=None):
        return {"texts": ["Hello printed text"], "cost": 0.002}

    def text(self, prompt, model, on_retry=None):
        return {"text": '{"title": "Stub Title", "filename": "Stub-Title", "summary": "s", "topics": ["a"]}',
                "cost": 0.0005}

    def vision(self, png, prompt, model, reasoning=None, on_retry=None):
        return {"text": "NO_FIGURES", "cost": 0.0}


@pytest.fixture
def client(tmp_path, monkeypatch):
    keys.clear()
    monkeypatch.setattr(main, "OUT", tmp_path / "out")
    monkeypatch.setattr(main, "cache", Cache(tmp_path / "cache"))
    monkeypatch.setattr(main, "OpenRouter", StubClient)
    monkeypatch.setattr(main, "jobs", {})
    monkeypatch.delenv("OCR_TOKEN", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "env-key")
    return TestClient(main.app)


def run_job(client, pdf, headers=None):
    r = client.post("/api/run", files=[("files", ("lecture.pdf", pdf, "application/pdf"))], headers=headers)
    assert r.status_code == 200, r.text
    job = r.json()["job"]
    for _ in range(100):
        body = client.get(f"/api/jobs/{job}", headers=headers).json()
        if body["status"] != "running":
            return job, body
        time.sleep(0.1)
    raise AssertionError("job did not finish")


def test_request_key_beats_env_key_and_env_is_the_fallback(client):
    pdf = make_pdf([{"text": "x" * 80}])
    run_job(client, pdf, {"X-OpenRouter-Key": "request-key"})
    run_job(client, pdf)
    assert keys == ["request-key", "env-key"]


def test_token_is_enforced_but_healthz_is_open(client, monkeypatch):
    monkeypatch.setenv("OCR_TOKEN", "secret")
    assert client.get("/healthz").json() == {"ok": True}
    assert client.get("/api/runs").status_code == 401
    assert client.get("/api/runs", headers={"X-OCR-Token": "wrong"}).status_code == 401
    assert client.get("/api/runs", headers={"X-OCR-Token": "secret"}).status_code == 200


def test_job_status_has_the_contract_shape_live_and_from_disk(client, monkeypatch):
    pdf = make_pdf([{"text": "x" * 80}, {"text": "y" * 80}])
    job, body = run_job(client, pdf)
    f = body["files"][0]
    assert set(body) == {"id", "status", "strategy", "usd", "files"} and body["status"] == "done"
    assert body["id"] == job and body["strategy"] == "ocr+vision"
    assert set(f) == {"name", "sha256", "status", "pages", "done_pages", "failed_pages", "markdown", "title",
                      "summary", "topics", "cost_usd", "error"}
    assert f["name"] == "lecture.pdf" and f["sha256"] == hashlib.sha256(pdf).hexdigest()
    assert (f["status"], f["pages"], f["done_pages"], f["failed_pages"], f["error"]) == ("done", 2, 2, [], None)
    assert f["title"] == "Stub Title" and f["topics"] == ["a"] and f["markdown"] == "Stub-Title.md"
    assert client.get(f"/api/jobs/{job}/files/{f['markdown']}").status_code == 200
    assert (main.OUT / job / "job.json").exists()
    main.jobs.clear()  # as after a restart
    assert client.get(f"/api/jobs/{job}").json() == body
    (main.OUT / job / "job.json").unlink()  # interrupted run: no done marker
    assert client.get(f"/api/jobs/{job}").json()["status"] == "failed"
    assert client.get("/api/jobs/nope").status_code == 404


def test_by_sha_finds_the_newest_conversion_else_404(client):
    pdf = make_pdf([{"text": "x" * 80}])
    job, body = run_job(client, pdf)
    sha = body["files"][0]["sha256"]
    hit = client.get(f"/api/by-sha/{sha}")
    assert hit.status_code == 200
    assert hit.json() == {"job": job, "markdown": "Stub-Title.md", "title": "Stub Title", "summary": "s",
                          "topics": ["a"], "pages": 1, "cost_usd": body["files"][0]["cost_usd"]}
    assert client.get("/api/by-sha/" + "0" * 64).status_code == 404


def test_too_big_or_too_long_pdfs_are_rejected(client, monkeypatch):
    post = lambda data: client.post("/api/run", files=[("files", ("a.pdf", data, "application/pdf"))])  # noqa: E731
    monkeypatch.setattr(main, "MAX_BYTES", 100)
    assert post(make_pdf([{"text": "x" * 80}])).status_code == 413
    monkeypatch.setattr(main, "MAX_BYTES", 10**8)
    monkeypatch.setattr(main, "MAX_PAGES", 2)
    r = post(make_pdf([{"text": "x"}] * 3))
    assert r.status_code == 422 and "3 pages" in r.json()["detail"]
    assert post(b"not a pdf").status_code == 422


def test_naming_prompt_does_not_contain_the_file_name():
    assert "{source}" not in NAME_PROMPT and ".pdf" not in NAME_PROMPT
