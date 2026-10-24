import tomllib
from pathlib import Path

import pytest

from app.cache import Cache
from app.pipeline import NO_FIGURES, SCAN_PROMPT, estimate, process_pdf

CFG = tomllib.loads(Path(__file__).parent.parent.joinpath("config.toml").read_text())


class FakeClient:
    def __init__(self, fail_vision=False):
        self.ocr_pages, self.prompts, self.fail_vision = [], [], fail_vision

    def ocr_pdf(self, pdf_bytes, name, engine, on_retry=None):
        self.ocr_pages.append(name)
        return {"texts": [f'<file name="{name}">\n\nocr {name}\n\n</file>'], "cost": 0.002}

    def vision(self, png, prompt, model, reasoning=None, on_retry=None):
        self.prompts.append(prompt)
        if self.fail_vision:
            raise RuntimeError("HTTP 402: out of credits")
        return {"text": "*[Diagram: transcribed]*" if prompt == SCAN_PROMPT else "```mermaid\ngraph TD\n```", "cost": 0.003}


@pytest.fixture
def run(tmp_path, pdf_bytes):
    return lambda client: process_pdf(pdf_bytes, "My Lecture.pdf", client, Cache(tmp_path / "cache"), tmp_path / "out", CFG)


def test_converts_and_rerun_is_free(tmp_path, run):
    client = FakeClient()
    m = run(client)
    md = (tmp_path / "out/My_Lecture.md").read_text()
    assert len(client.ocr_pages) == 4                       # scanned page 3 skips the paid OCR
    assert len(client.prompts) == 2 and SCAN_PROMPT in client.prompts
    assert "ocr My_Lecture-p1.pdf" in md and "<file" not in md and "```mermaid" in md and "*[Diagram" in md
    assert m["scan_pages"] == [3] and m["figure_pages"] == [2] and m["failed_pages"] == [] and m["cost_usd"] == 0.014
    assert run(client)["cost_usd"] == 0 and len(client.ocr_pages) == 4


def test_failed_page_is_marked_and_retried_on_rerun(tmp_path, run):
    m = run(FakeClient(fail_vision=True))
    assert m["failed_pages"] == [2, 3] and "out of credits" in (tmp_path / "out/My_Lecture.md").read_text()
    client = FakeClient()
    assert run(client)["failed_pages"] == [] and len(client.prompts) == 2 and client.ocr_pages == []


def test_no_figures_answer_drops_the_section(tmp_path, run):
    client = FakeClient()
    client.vision = lambda *a, **k: {"text": NO_FIGURES, "cost": 0.003}
    run(client)
    assert NO_FIGURES not in (tmp_path / "out/My_Lecture.md").read_text()


def test_estimate(pdf_bytes):
    assert estimate(pdf_bytes, CFG) == {"pages": 5, "ocr_pages": 4, "vision_pages": 2, "usd": 0.0144}


def test_emits_live_request_events(tmp_path, pdf_bytes):
    events = []
    cache = Cache(tmp_path / "cache")
    process_pdf(pdf_bytes, "a.pdf", FakeClient(), cache, tmp_path / "out", CFG, events.append)
    reqs = [e for e in events if e["type"] == "req"]
    assert [e["state"] for e in reqs].count("running") == 6 and [e["state"] for e in reqs].count("ok") == 6
    assert events[0]["kinds"] == [None, "figures", "scan", None, None] and events[-1]["done"] == 6
    events.clear()
    process_pdf(pdf_bytes, "a.pdf", FakeClient(), cache, tmp_path / "out", CFG, events.append)
    assert {e["state"] for e in events if e["type"] == "req"} == {"cached"}
