import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path

import pymupdf

from .assemble import build_markdown, clean_ocr
from .render import page_kind, page_kinds, page_pdf, render_png

PROMPT_VERSION = "v4"
NO_FIGURES = "NO_FIGURES"
FIGURES_PROMPT = f"""You are converting one PDF page image into markdown for a study database.
The page's printed text, printed tables and printed formulas are already extracted separately. Output ONLY, in reading order:
- Figures, diagrams, block diagrams, flowcharts, state machines, network/processor topologies: a ```mermaid block when it can be expressed faithfully, otherwise a short italic description *[Diagram: ...]* that mentions every label and arrow.
- Plots and photos: a short prose description (axes, curves, labels, what it shows).
- Tables or formulas that are part of an image or drawn by hand: markdown tables / LaTeX ($...$, $$...$$).
- Handwritten notes, annotations and hand-solved calculations: transcribe them fully (math as LaTeX), prefixed with **Handwritten:**.
Never repeat printed text. If the page has none of these, output exactly {NO_FIGURES}."""
SCAN_PROMPT = """You are converting one scanned or handwritten PDF page image into markdown for a study database.
Transcribe EVERYTHING on the page faithfully, in reading order, in the page's own language:
- Text and lists as markdown; math as LaTeX ($...$ inline, $$...$$ display); tables as markdown tables.
- Code, assembly, register/memory contents: fenced code blocks, keeping the layout.
- Hand-drawn diagrams: a ```mermaid block if they are a clean flowchart/state machine/block diagram, otherwise a short italic description *[Diagram: ...]* that mentions every label and arrow.
Do not invent content and do not turn plain text into diagrams. Mark unreadable parts as [unreadable]."""
PROMPTS = {"figures": FIGURES_PROMPT, "scan": SCAN_PROMPT}


def safe_name(name):
    return re.sub(r"[^\w.-]+", "_", Path(name).stem) or "document"


def estimate(pdf_bytes, cfg):
    kinds = page_kinds(pdf_bytes)
    ocr = sum(1 for k in kinds if k != "scan")
    vision = sum(1 for k in kinds if k)
    p = cfg["pipeline"]
    return {"pages": len(kinds), "ocr_pages": ocr, "vision_pages": vision,
            "usd": round(ocr * p["ocr_price_per_page"] + vision * p["vision_price_per_page"], 4)}


def process_pdf(pdf_bytes, name, client, cache, out_dir, cfg, progress=lambda msg: None):
    """Convert one PDF into out_dir/<title>.md + images/ + manifest.json. Failed pages are marked, not fatal."""
    o, p = cfg["openrouter"], cfg["pipeline"]
    engine, vmodel, reasoning = o["pdf_engine"], o["vision_model"], o.get("vision_reasoning")
    title, out_dir = safe_name(name), Path(out_dir)
    (out_dir / "images").mkdir(parents=True, exist_ok=True)
    src = hashlib.sha256(pdf_bytes).hexdigest()

    # PyMuPDF is not thread-safe: do all PDF work here, only API calls go to the thread pool.
    tasks = []  # (page, step, cache key, payload or None when cached)
    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
        kinds = [page_kind(page) for page in doc]
        for i, kind in enumerate(kinds):
            if kind != "scan":
                key = ("ocr", engine, src, i)
                tasks.append((i, "text", key, None if cache.get(*key) else page_pdf(doc, i)))
            if kind:
                image = out_dir / f"images/p{i + 1:03d}.png"
                if not image.exists():
                    image.write_bytes(render_png(doc, i, p["dpi"]))
                key = ("vision", vmodel, json.dumps(reasoning), PROMPT_VERSION, kind, src, i, p["dpi"])
                tasks.append((i, "vision", key, None if cache.get(*key) else image))

    def run(task):
        i, step, key, payload = task
        if payload is None:
            return cache.get(*key), 0.0
        if step == "text":
            res = client.ocr_pdf(payload, f"{title}-p{i + 1}.pdf", engine)
        else:
            res = client.vision(payload.read_bytes(), PROMPTS[kinds[i]], vmodel, reasoning)
        cache.put(res, *key)
        return res, res["cost"]

    pages = [{"text": "", "image": f"images/p{i + 1:03d}.png", "vision": None, "errors": []} for i in range(len(kinds))]
    spent, calls, done = 0.0, 0, 0
    with ThreadPoolExecutor(p.get("workers", 8)) as ex:
        futures = {ex.submit(run, t): t for t in tasks}
        for fut in as_completed(futures):
            i, step, _, payload = futures[fut]
            done += 1
            try:
                res, cost = fut.result()
            except Exception as e:  # one bad page must not sink a 300-page PDF; it is not cached, so a re-run retries it
                pages[i]["errors"].append(f"{step}: {e}")
                progress(f"{title}: page {i + 1} {step} FAILED: {e}")
                continue
            spent += cost
            calls += payload is not None
            if step == "text":
                pages[i]["text"] = "\n\n".join(clean_ocr(t) for t in res["texts"]).strip()
            elif res["text"].strip() != NO_FIGURES:
                pages[i]["vision"] = res["text"]
            progress(f"{title}: {done}/{len(tasks)} steps")

    failed = [i + 1 for i, pg in enumerate(pages) if pg["errors"]]
    meta = {"title": title, "source": name, "pages": len(pages), "sha256": src, "converted": date.today().isoformat(),
            "ocr_engine": engine, "vision_model": vmodel}
    (out_dir / f"{title}.md").write_text(build_markdown(meta, pages), encoding="utf-8")
    manifest = {**meta, "scan_pages": [i + 1 for i, k in enumerate(kinds) if k == "scan"],
                "figure_pages": [i + 1 for i, k in enumerate(kinds) if k == "figures"],
                "failed_pages": failed, "api_calls": calls, "cost_usd": round(spent, 4)}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest
