import io
import json
import os
import threading
import time
import tomllib
import uuid
import zipfile
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

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


def get_job(job_id):
    if job_id not in jobs:
        raise HTTPException(404, "unknown job")
    return jobs[job_id]


@app.get("/")
def index():
    return FileResponse(ROOT / "app/static/index.html")


@app.post("/api/estimate")
async def api_estimate(files: list[UploadFile]):
    items = [{"name": f.filename, **estimate(await f.read(), CFG)} for f in files]
    return {"files": items, "usd": round(sum(i["usd"] for i in items), 4),
            "ocr_engine": CFG["openrouter"]["pdf_engine"], "vision_model": CFG["openrouter"]["vision_model"]}


@app.post("/api/run")
async def api_run(files: list[UploadFile]):
    client = make_client()
    uploads = [(f.filename, await f.read()) for f in files]
    job_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
    job = jobs[job_id] = {"events": [], "dir": OUT / job_id}

    def work():
        emit = job["events"].append
        total, failed_files = 0.0, []
        used = set()
        for name, data in uploads:
            folder = safe_name(name)
            while folder in used:  # two uploads with the same file name must not overwrite each other
                folder += "_"
            used.add(folder)
            try:
                m = process_pdf(data, name, client, cache, job["dir"] / folder, CFG, lambda msg: emit({"msg": msg}))
            except Exception as e:  # a broken PDF must not stop the rest of the batch
                failed_files.append(name)
                emit({"msg": f"{name}: FAILED: {e}", "level": "error"})
                continue
            total += m["cost_usd"]
            note = f", failed pages {m['failed_pages']}" if m["failed_pages"] else ""
            emit({"msg": f"done {name}: {m['pages']} pages, ${m['cost_usd']}{note}",
                  "level": "warn" if note else "ok"})
        emit({"done": True, "usd": round(total, 4), "failed_files": failed_files, "dir": str(job["dir"])})

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
                if e.get("done"):
                    return
            time.sleep(0.3)

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.get("/api/jobs/{job_id}/zip")
def zip_job(job_id: str):
    job = get_job(job_id)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(job["dir"].rglob("*")):
            if p.is_file():
                z.write(p, p.relative_to(job["dir"]))
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/zip",
                             headers={"Content-Disposition": f"attachment; filename=markdown-{job_id}.zip"})
