# PDF → Markdown (OCR via OpenRouter)

Drop a batch of PDFs (lecture slides, exams, scripts, handwritten notes) into a local web page and get one markdown file per PDF, ready to import into a database or hand to AI agents.

## Run

```bash
echo 'OPENROUTER_API_KEY=sk-or-...' > .env && chmod 600 .env   # once
./run.sh                                                       # then open http://localhost:8000
```

From WSL, the Windows browser reaches `http://localhost:8000` directly. Results land in `out/<job>/` and can also be downloaded as a zip.

## How each page is handled

Every page is classified locally (free) before anything is sent:

| Page | Mistral OCR (`pdf_engine`) | Vision model (`vision_model`) |
|---|---|---|
| Printed text only | text, tables, LaTeX | – |
| Printed + figures / graphs / pictures / digital ink | printed text | figures as Mermaid or descriptions, handwritten notes transcribed |
| Scanned or handwritten (no embedded text) | skipped | transcribes the whole page |

Logos and icons (images under 3% of the page) do not count as figures. OCR runs one page per request, so page boundaries are exact.

## Output

```
out/<job>/<pdf-name>/
  <pdf-name>.md      YAML front matter, then <!-- page N --> markers per page
  images/pNNN.png    page renders, linked above each figure section
  manifest.json      page kinds, failed pages, API calls, cost
```

## Cost and re-runs

The page shows an estimate before converting (measured: ~$0.0021 per OCR page, ~$0.003 per vision page). Every API result is cached in `.cache/`, so re-running the same PDF is free. A page that fails (rate limit, provider error, out of credits) is marked in the markdown and in `manifest.failed_pages`; it is not cached, so re-running the PDF retries only the failed pages.

## Configure

`config.toml`: models, PDF engine (`mistral-ocr`, or the free `cloudflare-ai` for plain text), reasoning effort for the vision model, parallel workers, render DPI, and prices for the estimate. After changing a vision prompt in `app/pipeline.py`, bump `PROMPT_VERSION` so cached results are not reused.

## Tests

```bash
.venv/bin/python -m pytest -q
```
