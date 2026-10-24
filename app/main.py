import io
import json
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
import tomllib
import uuid
import zipfile
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from .cache import Cache
from .openrouter import OpenRouter
from .pipeline import estimate, process_pdf, safe_name

ROOT = Path(__file__).resolve().parent.parent
if (ROOT / ".env").exists():
    for line in (ROOT / ".env").read_text().splitlines():
        k, _, v = line.partition("=")
        if k.strip() and not line.lstrip().startswith("#"):
            os.environ.setdefault(k.strip(), v.strip())
CFG = tomllib.loads((ROOT / "config.toml").read_text())
OUT = ROOT / "out"
cache = Cache(ROOT / ".cache")
app = FastAPI()
jobs = {}  # id -> {"events": [dict], "dir": Path}; events are kept so a reconnecting browser replays them


def make_client():
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise HTTPException(500, "OPENROUTER_API_KEY is not set (put it in .env)")
    o = CFG["openrouter"]
    return OpenRouter(key, o["base_url"], o["ocr_model"])


STRATEGIES = ("ocr+vision", "vision")


def with_strategy(strategy):
    if strategy not in STRATEGIES:
        raise HTTPException(400, f"strategy must be one of {STRATEGIES}")
    return {**CFG, "pipeline": {**CFG["pipeline"], "strategy": strategy}}


def windows_path(path):
    """Path for Windows Explorer (\\\\wsl.localhost\\...) when running in WSL; the plain path elsewhere."""
    try:
        return subprocess.run(["wslpath", "-w", str(path)], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return str(path)


def get_job(job_id):
    if job_id not in jobs:
        raise HTTPException(404, "unknown job")
    return jobs[job_id]


@app.get("/")
def index():
    return FileResponse(ROOT / "app/static/index.html")


@app.post("/api/estimate")
async def api_estimate(files: list[UploadFile]):
    # estimate takes the PDF lock, which a running job may hold; keep it off the event loop
    items = []
    for f in files:
        data = await f.read()
        per = {st: await run_in_threadpool(estimate, data, with_strategy(st)) for st in STRATEGIES}
        items.append({"name": f.filename, **per["vision"], "usd": {st: e["usd"] for st, e in per.items()}})
    return {"files": items, "usd": {st: round(sum(i["usd"][st] for i in items), 4) for st in STRATEGIES},
            "default_strategy": CFG["pipeline"].get("strategy", "ocr+vision"),
            "ocr_engine": CFG["openrouter"]["pdf_engine"], "vision_model": CFG["openrouter"]["vision_model"]}


@app.post("/api/run")
async def api_run(files: list[UploadFile], strategy: str = Form(None)):
    client = make_client()
    cfg = with_strategy(strategy or CFG["pipeline"].get("strategy", "ocr+vision"))
    uploads = [(f.filename, await f.read()) for f in files]
    job_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
    job = jobs[job_id] = {"events": [], "dir": OUT / job_id}

    def emit(event):
        job["events"].append({**event, "t": time.time()})  # list.append is atomic; no lock needed

    folders = []
    for name, _ in uploads:
        folder = safe_name(name)
        while folder in folders:  # two uploads with the same file name must not overwrite each other
            folder += "_"
        folders.append(folder)

    def work():
        pool = ThreadPoolExecutor(CFG["pipeline"].get("workers", 16))
        results = {}

        def one(name, data, folder):
            try:
                results[name] = process_pdf(data, name, client, cache, job["dir"] / folder, cfg, emit, pool)
            except Exception as e:  # a broken PDF must not stop the rest of the batch
                results[name] = None
                emit({"type": "log", "msg": f"{name}: FAILED: {e}", "level": "error"})
                return
            m = results[name]
            note = f", failed pages {m['failed_pages']}" if m["failed_pages"] else ""
            emit({"type": "log", "msg": f"done {name} -> {m['markdown']}: {m['pages']} pages, ${m['cost_usd']}{note}",
                  "level": "warn" if note else "ok"})

        # every PDF feeds the same pool, so a run is as parallel as `workers` allows, not one PDF at a time
        threads = [threading.Thread(target=one, args=(n, d, f)) for (n, d), f in zip(uploads, folders)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        pool.shutdown()
        emit({"type": "done", "usd": round(sum(m["cost_usd"] for m in results.values() if m), 4),
              "failed_files": [n for n, m in results.items() if m is None], "dir": str(job["dir"]),
              "windows_dir": windows_path(job["dir"]),
              "markdown": [{"file": m["markdown"], "title": m["title"], "source": n, "pages": m["pages"]}
                           for n, m in results.items() if m]})

    emit({"type": "start", "files": [{"file": f, "name": n} for (n, _), f in zip(uploads, folders)],
          "workers": CFG["pipeline"].get("workers", 16), "strategy": cfg["pipeline"]["strategy"]})
    threading.Thread(target=work, daemon=True).start()
    return {"job": job_id}


@app.get("/api/jobs/{job_id}/events")
def events(job_id: str):
    job = get_job(job_id)

    def stream():
        sent = 0
        while True:
            for e in job["events"][sent:]:
                sent += 1
                yield f"data: {json.dumps(e)}\n\n"
                if e.get("type") == "done":
                    return
            time.sleep(0.3)

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.get("/api/jobs/{job_id}/files/{path:path}")
def job_file(job_id: str, path: str):
    root = get_job(job_id)["dir"].resolve()
    target = (root / path).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(target)


@app.get("/api/jobs/{job_id}/zip")
def zip_job(job_id: str, only: str = "all"):
    """only=markdown: just the .md files (diagrams stay readable as Mermaid; image links point nowhere)."""
    job = get_job(job_id)
    files = sorted(job["dir"].glob("*.md")) if only == "markdown" else sorted(job["dir"].rglob("*"))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            if p.is_file():
                z.write(p, p.relative_to(job["dir"]))
    buf.seek(0)
    suffix = "-markdown" if only == "markdown" else ""
    return StreamingResponse(buf, media_type="application/zip",
                             headers={"Content-Disposition": f"attachment; filename=pdf2md-{job_id}{suffix}.zip"})
