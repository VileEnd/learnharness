import tomllib
from pathlib import Path

import pytest

from app.cache import Cache
from app.pipeline import NO_FIGURES, PAGE_PROMPT, SCAN_PROMPT, estimate, process_pdf

CFG = tomllib.loads(Path(__file__).parent.parent.joinpath("config.toml").read_text())
CFG["pipeline"]["strategy"] = "ocr+vision"
VISION_CFG = {**CFG, "pipeline": {**CFG["pipeline"], "strategy": "vision", "keep_page_images": True}}


class FakeClient:
    def __init__(self, fail_vision=False):
        self.ocr_pages, self.prompts, self.fail_vision = [], [], fail_vision

    def ocr_pdf(self, pdf_bytes, name, engine, on_retry=None):
        self.ocr_pages.append(name)
        return {"texts": [f'<file name="{name}">\n\nocr {name}\n\n</file>'], "cost": 0.002}

    def text(self, prompt, model, on_retry=None):
        return {"text": '{"title": "Rechnerarchitektur, Folien 2", "filename": "Rechnerarchitektur_Folien-02", '
                        '"summary": "s", "topics": ["CPU"]}', "cost": 0.0005}

    def vision(self, png, prompt, model, reasoning=None, on_retry=None):
        self.prompts.append(prompt)
        if self.fail_vision:
            raise RuntimeError("HTTP 402: out of credits")
        return {"text": "*[Diagram: transcribed]*" if prompt == SCAN_PROMPT else "```mermaid\ngraph TD\n```", "cost": 0.003}


@pytest.fixture
def run(tmp_path, pdf_bytes):
    return lambda client: process_pdf(pdf_bytes, "My Lecture.pdf", client, Cache(tmp_path / "cache"), tmp_path / "job/My_Lecture", CFG)


def test_converts_and_rerun_is_free(tmp_path, run):
    client = FakeClient()
    m = run(client)
    md = (tmp_path / "job/Rechnerarchitektur_Folien-02.md").read_text()
    assert m["markdown"] == "Rechnerarchitektur_Folien-02.md" and 'title: "Rechnerarchitektur, Folien 2"' in md
    assert "![page" not in md and not (tmp_path / "job/My_Lecture/images").exists()  # markdown only by default
    assert len(client.ocr_pages) == 4                       # scanned page 3 skips the paid OCR
    assert len(client.prompts) == 2 and SCAN_PROMPT in client.prompts
    assert "ocr My_Lecture-p1.pdf" in md and "<file" not in md and "```mermaid" in md and "*[Diagram" in md
    assert m["scan_pages"] == [3] and m["figure_pages"] == [2] and m["failed_pages"] == [] and m["cost_usd"] == 0.0145
    again = run(client)
    assert again["cost_usd"] == 0 and len(client.ocr_pages) == 4 and again["markdown"] == "Rechnerarchitektur_Folien-02-2.md"


def test_failed_page_is_marked_and_retried_on_rerun(tmp_path, run):
    m = run(FakeClient(fail_vision=True))
    assert m["failed_pages"] == [2, 3] and "out of credits" in (tmp_path / "job" / m["markdown"]).read_text()
    client = FakeClient()
    assert run(client)["failed_pages"] == [] and len(client.prompts) == 2 and client.ocr_pages == []


def test_no_figures_answer_drops_the_section(tmp_path, run):
    client = FakeClient()
    client.vision = lambda *a, **k: {"text": NO_FIGURES, "cost": 0.003}
    m = run(client)
    assert NO_FIGURES not in (tmp_path / "job" / m["markdown"]).read_text()


def test_estimate(pdf_bytes):
    assert estimate(pdf_bytes, CFG)["usd"] == round(4 * 0.0021 + 2 * 0.0006, 4)
    assert estimate(pdf_bytes, VISION_CFG) == {"pages": 5, "ocr_pages": 0, "vision_pages": 5, "handwritten_pages": 1,
                                               "figure_pages": 1, "usd": 0.003}


def test_vision_strategy_reads_every_page_once_and_can_keep_images(tmp_path, pdf_bytes):
    client = FakeClient()
    m = process_pdf(pdf_bytes, "My Lecture.pdf", client, Cache(tmp_path / "cache"), tmp_path / "job/My_Lecture", VISION_CFG)
    md = (tmp_path / "job" / m["markdown"]).read_text()
    assert client.ocr_pages == [] and client.prompts == [PAGE_PROMPT] * 5 and m["failed_pages"] == []
    assert sorted(p.name for p in (tmp_path / "job/My_Lecture/images").iterdir()) == ["p002.png", "p003.png"]
    assert "![page 1]" not in md and "![page 2](My_Lecture/images/p002.png)" in md


def test_naming_failure_falls_back_to_the_text_not_the_file_name(tmp_path, pdf_bytes):
    client = FakeClient()
    client.text = lambda *a, **k: {"text": "sorry, no JSON", "cost": 0.0005}
    m = process_pdf(pdf_bytes, "My Lecture.pdf", client, Cache(tmp_path / "cache"), tmp_path / "job/My_Lecture", CFG)
    assert m["title"] == "ocr My_Lecture-p1.pdf" and m["markdown"] == "ocr-My_Lecture-p1.pdf.md"


def test_emits_live_request_events(tmp_path, pdf_bytes):
    events = []
    cache = Cache(tmp_path / "cache")
    process_pdf(pdf_bytes, "a.pdf", FakeClient(), cache, tmp_path / "job/a", CFG, events.append)
    reqs = [e for e in events if e["type"] == "req"]
    assert [e["state"] for e in reqs].count("running") == 7 and [e["state"] for e in reqs].count("ok") == 7  # 6 pages + name
    assert events[0]["kinds"] == [None, "figures", "scan", None, None] and events[-1]["finished"]
    events.clear()
    process_pdf(pdf_bytes, "a.pdf", FakeClient(), cache, tmp_path / "job/a", CFG, events.append)
    assert {e["state"] for e in events if e["type"] == "req"} == {"cached"}


def test_markdown_name_overwrites_the_same_file(tmp_path, pdf_bytes):
    cache, out = Cache(tmp_path / "cache"), tmp_path / "job/My_Lecture"
    first = process_pdf(pdf_bytes, "My Lecture.pdf", FakeClient(fail_vision=True), cache, out, CFG)
    again = process_pdf(pdf_bytes, "My Lecture.pdf", FakeClient(), cache, out, CFG, markdown_name=first["markdown"])
    assert again["markdown"] == first["markdown"] and again["failed_pages"] == []
    assert len(list((tmp_path / "job").glob("*.md"))) == 1
