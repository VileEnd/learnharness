import hashlib
import hmac
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

import pymupdf
from fastapi import FastAPI, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from .cache import Cache
from .openrouter import OpenRouter
from .pipeline import estimate, process_pdf, safe_name
from .render import PDF_LOCK

ROOT = Path(__file__).resolve().parent.parent
try:  # optional: a local .env with OPENROUTER_API_KEY; in a container the environment is used instead
    for line in (ROOT / ".env").read_text().splitlines():
        k, _, v = line.partition("=")
        if k.strip() and not line.lstrip().startswith("#"):
            os.environ.setdefault(k.strip(), v.strip())
except OSError:
    pass
CFG = tomllib.loads(Path(os.environ.get("CONFIG_PATH") or ROOT / "config.toml").read_text())
OUT = Path(os.environ.get("OUT_DIR") or ROOT / "out")
cache = Cache(os.environ.get("CACHE_DIR") or ROOT / ".cache")
MAX_BYTES = 50 * 1024 * 1024  # per PDF
MAX_PAGES = 300               # per PDF
JOB_TTL = 3600                # seconds a finished job stays in memory; the disk stays the source of truth
# Shared by every run on this server, so starting a second run does not double the load on the providers.
POOL = ThreadPoolExecutor(CFG["pipeline"].get("workers", 16))
OCR_GATE = threading.BoundedSemaphore(CFG["pipeline"].get("ocr_workers", 6))  # Mistral OCR rate-limits early
app = FastAPI()
# id -> {"events": [dict], "dir": Path, "uploads": [(name, bytes, folder)], "cfg", "running", "usd",
#        "files": {folder: state}, "finished": epoch or None};
# events are kept so a reconnecting browser can resume where it left off
jobs = {}
_index = {"root": None, "by_sha": {}}  # sha256 of a PDF -> newest finished conversion (see by_sha_index)


@app.middleware("http")
async def require_token(request: Request, call_next):
    """With OCR_TOKEN set, every /api/* request must carry it in X-OCR-Token. /healthz and the page stay open."""
    token = os.environ.get("OCR_TOKEN")
    if token and request.url.path.startswith("/api/"):
        given = request.headers.get("x-ocr-token", "")
        if not hmac.compare_digest(given.encode(), token.encode()):
            return JSONResponse({"detail": "missing or wrong X-OCR-Token"}, status_code=401)
    return await call_next(request)


@app.get("/healthz")
def healthz():
    return {"ok": True}


def make_client(key=None):
    key = key or os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise HTTPException(400, "No OpenRouter key: send X-OpenRouter-Key, or set OPENROUTER_API_KEY (e.g. in .env)")
    o = CFG["openrouter"]
    return OpenRouter(key, o["base_url"], o["ocr_model"])


def check_pdf(name, data):
    """Reject files over the size or page limit (413 / 422) before any money is spent."""
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"{name}: larger than {MAX_BYTES // 2**20} MB")
    try:
        with PDF_LOCK, pymupdf.open(stream=data, filetype="pdf") as doc:
            pages = len(doc)
    except Exception:
        raise HTTPException(422, f"{name}: not a readable PDF") from None
    if pages > MAX_PAGES:
        raise HTTPException(422, f"{name}: {pages} pages, more than the limit of {MAX_PAGES}")


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


def file_view(name, sha, manifest=None, **state):
    """One entry of the GET /api/jobs/{id} contract."""
    m = manifest or {}
    view = {"name": name, "sha256": sha, "status": "queued", "pages": m.get("pages"), "done_pages": 0,
            "failed_pages": m.get("failed_pages", []), "markdown": m.get("markdown"), "title": m.get("title"),
            "summary": m.get("summary"), "topics": m.get("topics", []), "cost_usd": m.get("cost_usd", 0.0),
            "error": None}
    return {**view, **state}


def job_view(job_id, strategy, usd, files, running):
    states = {f["status"] for f in files}
    status = "running" if running else ("failed" if states == {"failed"} else "done")
    return {"id": job_id, "status": status, "strategy": strategy, "usd": round(usd, 4), "files": files}


def live_view(job_id, job):
    return job_view(job_id, job["cfg"]["pipeline"]["strategy"], job["usd"],
                    [dict(f) for f in job["files"].values()], job["running"])


def write_marker(job_id, job):
    """out/<job>/job.json: the final status, so the job can be answered after a restart."""
    job["dir"].mkdir(parents=True, exist_ok=True)
    tmp = job["dir"] / "job.json.tmp"
    tmp.write_text(json.dumps(live_view(job_id, job)), encoding="utf-8")
    tmp.replace(job["dir"] / "job.json")


def disk_view(job_id, run_dir):
    """A job found only on disk: its done marker, else (interrupted run) rebuilt from the manifests as failed."""
    marker = run_dir / "job.json"
    if marker.exists():
        return {**json.loads(marker.read_text()), "id": job_id}
    files, usd = [], 0.0
    for path in sorted(run_dir.glob("*/manifest.json")):
        m = json.loads(path.read_text())
        usd += m.get("cost_usd", 0)
        files.append(file_view(m["source"], m.get("sha256", ""), m, status="done", done_pages=m["pages"] - len(m["failed_pages"])))
    return {**job_view(job_id, "", usd, files, False), "status": "failed"}


def by_sha_entry(job_id, m):
    return {"job": job_id, "markdown": m["markdown"], "title": m.get("title"), "summary": m.get("summary"),
            "topics": m.get("topics", []), "pages": m["pages"], "cost_usd": m.get("cost_usd", 0.0)}


def by_sha_index():
    """sha256 -> {job, markdown, ...} of the newest finished, complete conversion, from the manifests on disk."""
    if _index["root"] != OUT:
        found = {}
        for path in sorted(OUT.glob("*/*/manifest.json")):  # job names sort by time: later overwrites earlier
            try:
                m = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            job_dir = path.parent.parent
            if m.get("sha256") and m.get("markdown") and not m.get("failed_pages") and (job_dir / m["markdown"]).is_file():
                found[m["sha256"]] = by_sha_entry(job_dir.name, m)
        _index.update(root=OUT, by_sha=found)
    return _index["by_sha"]


def prune_jobs():
    """Forget finished jobs after JOB_TTL; /api/jobs/{id} then answers from disk."""
    for job_id, job in list(jobs.items()):
        if job.get("finished") and time.time() - job["finished"] > JOB_TTL:
            jobs.pop(job_id, None)


def get_job(job_id):
    """A job from this server's memory, or a finished run still on disk (e.g. from before a restart)."""
    prune_jobs()
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
        await run_in_threadpool(check_pdf, f.filename, data)
        per = {st: await run_in_threadpool(estimate, data, with_strategy(st)) for st in STRATEGIES}
        items.append({"name": f.filename, **per["vision"], "usd": {st: e["usd"] for st, e in per.items()}})
    return {"files": items, "usd": {st: round(sum(i["usd"][st] for i in items), 4) for st in STRATEGIES},
            "default_strategy": CFG["pipeline"].get("strategy", "ocr+vision"),
            "ocr_engine": CFG["openrouter"]["pdf_engine"], "vision_model": CFG["openrouter"]["vision_model"]}


def launch(job, items, client):
    """Convert items [(name, bytes, folder, markdown name to overwrite or None)] in the background."""
    job_id = job["dir"].name
    for name, data, folder, _ in items:
        job["files"][folder] = file_view(name, hashlib.sha256(data).hexdigest(), status="queued")

    def emit(event):
        job["events"].append({**event, "t": time.time()})  # list.append is atomic; no lock needed
        f = job["files"].get(event.get("file"))
        if event.get("type") == "file" and f is not None and not event.get("finished"):
            f["status"] = "running"
            if "kinds" in event:
                f["pages"] = len(event["kinds"])
            if f["pages"] and event.get("total"):
                f["done_pages"] = min(f["pages"], round(event["done"] / event["total"] * f["pages"]))

    def one(name, data, folder, markdown_name):
        f = job["files"][folder]
        try:
            m = process_pdf(data, name, client, cache, job["dir"] / folder, job["cfg"], emit, POOL, OCR_GATE,
                            markdown_name)
        except Exception as e:  # a broken PDF must not stop the rest of the batch
            emit({"type": "log", "msg": f"{name}: FAILED: {e}", "level": "error"})
            f.update(status="failed", error=str(e))
            return
        job["usd"] += m["cost_usd"]
        f.update(file_view(name, m["sha256"], m, status="done", done_pages=m["pages"] - len(m["failed_pages"])))
        if not m["failed_pages"]:
            by_sha_index()[m["sha256"]] = by_sha_entry(job_id, m)
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
        job["finished"] = time.time()
        # keep the PDFs only where a retry could use them; the rest of the memory goes back
        keep = {folder for folder, f in job["files"].items() if f["status"] == "failed" or f["failed_pages"]}
        job["uploads"] = [u for u in job["uploads"] if u[2] in keep]
        try:
            write_marker(job_id, job)
        except OSError:
            pass
        emit({"type": "done", "usd": round(job["usd"], 4), **run_summary(job["dir"])})

    (job["dir"] / "job.json").unlink(missing_ok=True)  # a run in progress is not "done" (a retry reopens a job)
    job["running"] = True
    job["finished"] = None
    emit({"type": "start", "files": [{"file": f, "name": n} for n, _, f, _ in items],
          "strategy": job["cfg"]["pipeline"]["strategy"]})
    threading.Thread(target=work, daemon=True).start()


@app.post("/api/run")
async def api_run(files: list[UploadFile], strategy: str = Form(None),
                  x_openrouter_key: str | None = Header(None)):
    prune_jobs()
    client = make_client(x_openrouter_key)
    cfg = with_strategy(strategy or CFG["pipeline"].get("strategy", "ocr+vision"))
    uploads, folders = [], []
    for f in files:
        folder = safe_name(f.filename)
        while folder in folders:  # two uploads with the same file name must not overwrite each other
            folder += "_"
        folders.append(folder)
        data = await f.read()
        await run_in_threadpool(check_pdf, f.filename, data)
        uploads.append((f.filename, data, folder))
    job_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
    job = jobs[job_id] = {"events": [], "dir": OUT / job_id, "uploads": uploads, "cfg": cfg, "usd": 0.0,
                                "files": {}}
    launch(job, [(n, d, f, None) for n, d, f in uploads], client)
    return {"job": job_id}


@app.post("/api/jobs/{job_id}/retry")
def retry(job_id: str, x_openrouter_key: str | None = Header(None)):
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
        launch(job, todo, make_client(x_openrouter_key))
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


@app.get("/api/by-sha/{sha256}")
def by_sha(sha256: str):
    """The newest complete conversion of exactly this PDF, so a client can skip uploading it again."""
    hit = by_sha_index().get(sha256.lower())
    if not hit:
        raise HTTPException(404, "no finished conversion of this PDF")
    return hit


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = get_job(job_id)
    return live_view(job_id, job) if "files" in job else disk_view(job_id, job["dir"])


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
