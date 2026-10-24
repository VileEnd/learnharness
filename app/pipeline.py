import hashlib
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path

import pymupdf

from .assemble import build_markdown, clean_ocr
from .render import PDF_LOCK, page_kind, page_kinds, page_pdf, render_png

PROMPT_VERSION = "v5"
NO_FIGURES = "NO_FIGURES"
FIGURES_PROMPT = f"""You are converting one PDF page image into markdown for a study database.
The page's printed text, printed tables and printed formulas are already extracted separately. Output ONLY, in reading order:
- Figures, diagrams, block diagrams, flowcharts, state machines, network/processor topologies: a ```mermaid block when it can be expressed faithfully, otherwise a short italic description *[Diagram: ...]* that mentions every label and arrow.
- Plots and photos: a short prose description (axes, curves, labels, what it shows).
- Tables or formulas that are part of an image or drawn by hand: markdown tables / LaTeX ($...$, $$...$$).
- Handwritten notes, annotations and hand-solved calculations: transcribe them fully (math as LaTeX). Start each handwritten block once with **Handwritten:**, never per line or table cell.
- Crossed-out content: keep it, wrapped in ~~strikethrough~~, so it is clear it was struck out.
Never repeat printed text. If the page has none of these, output exactly {NO_FIGURES}."""
SCAN_PROMPT = """You are converting one scanned or handwritten PDF page image into markdown for a study database.
Transcribe EVERYTHING on the page faithfully, in reading order, in the page's own language:
- Text and lists as markdown; math as LaTeX ($...$ inline, $$...$$ display); tables as markdown tables.
- Code, assembly, register/memory contents: fenced code blocks, keeping the layout.
- Hand-drawn diagrams: a ```mermaid block if they are a clean flowchart/state machine/block diagram, otherwise a short italic description *[Diagram: ...]* that mentions every label and arrow.
- Crossed-out content: keep it, wrapped in ~~strikethrough~~, so it is clear it was struck out.
Do not invent content and do not turn plain text into diagrams. Mark unreadable parts as [unreadable]."""
PAGE_PROMPT = """You are converting one PDF page image into markdown for a study database.
Transcribe EVERYTHING on the page faithfully, in reading order, in the page's own language:
- Headings, text and lists as markdown; math as LaTeX ($...$ inline, $$...$$ display); tables as markdown tables.
- Code, assembly, register/memory contents: fenced code blocks, keeping the layout.
- Diagrams and figures: a ```mermaid block if they are a clean flowchart/state machine/block diagram, otherwise a short italic description *[Diagram: ...]* that mentions every label and arrow. Plots and photos: a short description of axes, curves, labels and what they show.
- Handwriting on a printed page: transcribe it too. Start each handwritten block once with **Handwritten:**, never per line or table cell.
- Crossed-out content: keep it, wrapped in ~~strikethrough~~, so it is clear it was struck out.
Do not invent content and do not turn plain text into diagrams. Mark unreadable parts as [unreadable]. Output only the markdown."""
PROMPTS = {"figures": FIGURES_PROMPT, "scan": SCAN_PROMPT, "page": PAGE_PROMPT}
PREVIEW_CHARS = 2000


def safe_name(name):
    return re.sub(r"[^\w.-]+", "_", Path(name).stem) or "document"


def plan(kind, strategy):
    """Steps for one page. 'vision': one full-page vision call per page. 'ocr+vision': Mistral OCR for printed
    text, plus a figures-only vision call on figure pages, or a full transcription on scanned pages."""
    if strategy == "vision":
        return [("vision", "page")]
    return ([("text", None)] if kind != "scan" else []) + ([("vision", kind)] if kind else [])


def thinking(cfg):
    r = cfg["openrouter"].get("vision_reasoning")
    return bool(r) and r.get("enabled", True) is not False


def estimate(pdf_bytes, cfg):
    kinds = page_kinds(pdf_bytes)
    p, strategy = cfg["pipeline"], cfg["pipeline"].get("strategy", "vision")
    steps = [s for k in kinds for s, _ in plan(k, strategy)]
    vision_price = p["vision_thinking_price_per_page"] if thinking(cfg) else p["vision_price_per_page"]
    return {"pages": len(kinds), "ocr_pages": steps.count("text"), "vision_pages": steps.count("vision"),
            "handwritten_pages": kinds.count("scan"), "figure_pages": kinds.count("figures"),
            "usd": round(steps.count("text") * p["ocr_price_per_page"] + steps.count("vision") * vision_price, 4)}


def _preview(res):
    text = res["text"] if "text" in res else "\n\n".join(clean_ocr(t) for t in res["texts"])
    return text[:PREVIEW_CHARS]


def process_pdf(pdf_bytes, name, client, cache, out_dir, cfg, emit=lambda event: None, executor=None):
    """Convert one PDF into out_dir/<title>.md + images/ + manifest.json. Failed pages are marked, not fatal.
    Pass a shared executor to run several PDFs' API calls in one pool; emit receives file and request events."""
    o, p = cfg["openrouter"], cfg["pipeline"]
    engine, vmodel, reasoning = o["pdf_engine"], o["vision_model"], o.get("vision_reasoning")
    strategy = p.get("strategy", "vision")
    title, out_dir = safe_name(name), Path(out_dir)
    (out_dir / "images").mkdir(parents=True, exist_ok=True)
    src = hashlib.sha256(pdf_bytes).hexdigest()

    # All PDF work happens under the lock; only API calls go to the thread pool.
    tasks = []  # (page, step, prompt, cache key, payload or None when cached)
    with PDF_LOCK, pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
        kinds = [page_kind(page) for page in doc]
        for i, kind in enumerate(kinds):
            for step, prompt in plan(kind, strategy):
                if step == "text":
                    key = ("ocr", engine, src, i)
                    tasks.append((i, step, None, key, None if cache.get(*key) else page_pdf(doc, i)))
                    continue
                image = out_dir / f"images/p{i + 1:03d}.png"
                if not image.exists():
                    image.write_bytes(render_png(doc, i, p["dpi"]))
                key = ("vision", vmodel, json.dumps(reasoning), PROMPT_VERSION, prompt, src, i, p["dpi"])
                tasks.append((i, step, prompt, key, None if cache.get(*key) else image))

    def run(task):
        i, step, prompt, key, payload = task
        req = {"type": "req", "id": f"{out_dir.name}:{i + 1}:{step}", "file": out_dir.name, "page": i + 1,
               "step": step, "kind": prompt or "text", "model": engine if step == "text" else vmodel,
               "image": f"{out_dir.name}/images/p{i + 1:03d}.png" if step == "vision" else None}
        if payload is None:
            res = cache.get(*key)
            emit({**req, "state": "cached", "preview": _preview(res)})
            return res, 0.0
        emit({**req, "state": "running"})
        on_retry = lambda note: emit({**req, "state": "retry", "note": note})  # noqa: E731
        started = time.monotonic()
        try:
            if step == "text":
                res = client.ocr_pdf(payload, f"{title}-p{i + 1}.pdf", engine, on_retry=on_retry)
            else:
                res = client.vision(payload.read_bytes(), PROMPTS[prompt], vmodel, reasoning, on_retry=on_retry)
        except Exception as e:
            emit({**req, "state": "error", "ms": round((time.monotonic() - started) * 1000), "error": str(e)})
            raise
        cache.put(res, *key)
        emit({**req, "state": "ok", "ms": round((time.monotonic() - started) * 1000), "cost": res["cost"],
              "usage": res.get("usage"), "preview": _preview(res)})
        return res, res["cost"]

    # page images are linked (and kept) only where there is something to look at: figures or handwriting
    pages = [{"text": "", "image": f"images/p{i + 1:03d}.png" if k else None, "vision": None, "errors": []}
             for i, k in enumerate(kinds)]
    spent, calls, done = 0.0, 0, 0
    progress = {"type": "file", "file": out_dir.name, "name": name, "total": len(tasks), "strategy": strategy}
    emit({**progress, "done": 0, "failed": 0, "kinds": kinds})
    own_pool = executor is None
    pool = executor or ThreadPoolExecutor(p.get("workers", 16))
    try:
        futures = {pool.submit(run, t): t for t in tasks}
        for fut in as_completed(futures):
            i, step, prompt, _, payload = futures[fut]
            done += 1
            try:
                res, cost = fut.result()
            except Exception as e:  # one bad page must not sink a 300-page PDF; it is not cached, so a re-run retries it
                pages[i]["errors"].append(f"{step}: {e}")
            else:
                spent += cost
                calls += payload is not None
                if step == "text":
                    pages[i]["text"] = "\n\n".join(clean_ocr(t) for t in res["texts"]).strip()
                elif prompt == "page" and not kinds[i]:
                    pages[i]["text"] = res["text"]  # plain text page: no figure section, no image link
                elif res["text"].strip() != NO_FIGURES:
                    pages[i]["vision"] = res["text"]
            emit({**progress, "done": done, "failed": sum(1 for pg in pages if pg["errors"])})
    finally:
        if own_pool:
            pool.shutdown()

    if not p.get("keep_all_page_images"):
        for i, k in enumerate(kinds):
            if not k:
                (out_dir / f"images/p{i + 1:03d}.png").unlink(missing_ok=True)

    failed = [i + 1 for i, pg in enumerate(pages) if pg["errors"]]
    meta = {"title": title, "source": name, "pages": len(pages), "sha256": src, "converted": date.today().isoformat(),
            "strategy": strategy, "ocr_engine": engine if strategy != "vision" else None, "vision_model": vmodel}
    (out_dir / f"{title}.md").write_text(build_markdown(meta, pages), encoding="utf-8")
    manifest = {**meta, "scan_pages": [i + 1 for i, k in enumerate(kinds) if k == "scan"],
                "figure_pages": [i + 1 for i, k in enumerate(kinds) if k == "figures"],
                "failed_pages": failed, "api_calls": calls, "cost_usd": round(spent, 4)}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest
