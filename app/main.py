import json
import os
import re
import subprocess
import tempfile
import threading
import time
import tomllib
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask
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
# Shared by every run on this server, so starting a second run does not double the load on the providers.
POOL = ThreadPoolExecutor(CFG["pipeline"].get("workers", 16))
OCR_GATE = threading.BoundedSemaphore(CFG["pipeline"].get("ocr_workers", 6))  # Mistral OCR rate-limits early
app = FastAPI()
# id -> {"events": [dict], "dir": Path, "uploads": [(name, bytes, folder)], "cfg", "running", "usd"};
# events are kept so a reconnecting browser can resume where it left off
jobs = {}


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


def run_summary(run_dir):
    """What a run produced, read from its manifests: one entry per converted PDF, plus totals."""
    files, usd = [], 0.0
    for path in sorted(Path(run_dir).glob("*/manifest.json")):
        m = json.loads(path.read_text())
        usd += m.get("cost_usd", 0)
        files.append({"file": m.get("markdown") or f"{path.parent.name}/{path.parent.name}.md",
                      "title": m["title"], "source": m["source"], "pages": m["pages"], "failed": len(m["failed_pages"])})
    return {"dir": str(run_dir), "windows_dir": windows_path(run_dir), "markdown": files,
            "pages": sum(f["pages"] for f in files), "failed_pages": sum(f["failed"] for f in files),
            "spent_usd": round(usd, 4), "has_images": next(Path(run_dir).glob("*/images/*.png"), None) is not None}


def get_job(job_id):
    """A job from this server's memory, or a finished run still on disk (e.g. from before a restart)."""
    if job_id in jobs:
        return jobs[job_id]
    if re.fullmatch(r"[\w-]+", job_id) and (OUT / job_id).is_dir():
        return {"dir": OUT / job_id, "running": False,
                "events": [{"type": "gone", **run_summary(OUT / job_id)}]}
    raise HTTPException(404, "unknown job")


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


def launch(job, items, client):
    """Convert items [(name, bytes, folder, markdown name to overwrite or None)] in the background."""
    def emit(event):
        job["events"].append({**event, "t": time.time()})  # list.append is atomic; no lock needed

    def one(name, data, folder, markdown_name):
        try:
            m = process_pdf(data, name, client, cache, job["dir"] / folder, job["cfg"], emit, POOL, OCR_GATE,
                            markdown_name)
        except Exception as e:  # a broken PDF must not stop the rest of the batch
            emit({"type": "log", "msg": f"{name}: FAILED: {e}", "level": "error"})
            return
        job["usd"] += m["cost_usd"]
        note = f", {len(m['failed_pages'])} pages failed" if m["failed_pages"] else ""
        emit({"type": "log", "msg": f"done {name} -> {m['markdown']}: {m['pages']} pages, ${m['cost_usd']}{note}",
              "level": "warn" if note else "ok"})

    def work():
        threads = [threading.Thread(target=one, args=item) for item in items]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        job["running"] = False
        emit({"type": "done", "usd": round(job["usd"], 4), **run_summary(job["dir"])})

    job["running"] = True
    emit({"type": "start", "files": [{"file": f, "name": n} for n, _, f, _ in items],
          "strategy": job["cfg"]["pipeline"]["strategy"]})
    threading.Thread(target=work, daemon=True).start()


@app.post("/api/run")
async def api_run(files: list[UploadFile], strategy: str = Form(None)):
    client = make_client()
    cfg = with_strategy(strategy or CFG["pipeline"].get("strategy", "ocr+vision"))
    uploads, folders = [], []
    for f in files:
        folder = safe_name(f.filename)
        while folder in folders:  # two uploads with the same file name must not overwrite each other
            folder += "_"
        folders.append(folder)
        uploads.append((f.filename, await f.read(), folder))
    job_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
    job = jobs[job_id] = {"events": [], "dir": OUT / job_id, "uploads": uploads, "cfg": cfg, "usd": 0.0}
    launch(job, [(n, d, f, None) for n, d, f in uploads], client)
    return {"job": job_id}


@app.post("/api/jobs/{job_id}/retry")
def retry(job_id: str):
    """Convert again only the PDFs of a run that have failed pages; finished pages come from the cache."""
    job = get_job(job_id)
    if "uploads" not in job:
        raise HTTPException(409, "This run started before the server restarted, so its PDFs are no longer loaded. "
                                 "Drop the same PDFs again: pages that already worked come from the cache for free.")
    if job["running"]:
        raise HTTPException(409, "This run is still going; retry when it has finished.")
    todo = []
    for name, data, folder in job["uploads"]:
        manifest = job["dir"] / folder / "manifest.json"
        m = json.loads(manifest.read_text()) if manifest.exists() else None
        if m is None or m["failed_pages"]:
            todo.append((name, data, folder, m and m["markdown"]))
    start = len(job["events"])
    if todo:
        launch(job, todo, make_client())
    return {"from": start, "files": len(todo)}


@app.get("/api/runs")
def list_runs():
    """Every run in out/, newest first. Running ones can be followed again (e.g. after reloading the page)."""
    runs = []
    for d in sorted((p for p in OUT.glob("*") if p.is_dir()), reverse=True):
        job = jobs.get(d.name)
        runs.append({"job": d.name, "running": bool(job and job.get("running")),
                     "can_retry": bool(job and "uploads" in job), **run_summary(d)})
    return runs


@app.get("/api/jobs/{job_id}/events")
def events(job_id: str, start: int = Query(0, alias="from")):
    job = get_job(job_id)

    def stream():
        sent = start
        while True:
            for e in job["events"][sent:]:
                sent += 1
                yield f"data: {json.dumps(e)}\n\n"
                if e.get("type") in ("done", "gone"):
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
    """only=markdown: just the .md files, flat (diagrams stay readable as Mermaid; image links point nowhere).
    Built in a temp file, not in memory: a run with images can be hundreds of MB."""
    job = get_job(job_id)
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    with tmp, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        if only == "markdown":  # flat, also for older runs that kept each .md inside its PDF's folder
            used = set()
            for p in sorted(job["dir"].rglob("*.md")):
                name = p.name
                while name in used:
                    name = name[:-3] + "_.md"
                used.add(name)
                z.write(p, name)
        else:
            for p in sorted(job["dir"].rglob("*")):
                if p.is_file():  # PNGs are already compressed; deflating them again only costs time
                    z.write(p, p.relative_to(job["dir"]),
                            zipfile.ZIP_STORED if p.suffix == ".png" else zipfile.ZIP_DEFLATED)
    suffix = "-markdown" if only == "markdown" else ""
    return FileResponse(tmp.name, media_type="application/zip", filename=f"pdf2md-{job_id}{suffix}.zip",
                        background=BackgroundTask(os.unlink, tmp.name))
