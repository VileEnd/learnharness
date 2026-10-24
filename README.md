# PDF → Markdown (OCR via OpenRouter)

Drop a batch of PDFs (lecture slides, exams, scripts, handwritten notes) into a local web page and get one markdown file per PDF, ready to import into a database or hand to AI agents.

## Run

```bash
echo 'OPENROUTER_API_KEY=sk-or-...' > .env && chmod 600 .env   # once
./run.sh                                                       # then open http://localhost:8000
```

From WSL, the Windows browser reaches `http://localhost:8000` directly. Results land in `out/<job>/` and can also be downloaded as a zip.

The right side of the page shows every API request live: page, step (OCR or vision), model, state, duration, tokens and cost. Click a row (or a page cell on the left) to see the page image that was sent and the model's answer. All PDFs in a run share one pool of `workers` parallel requests.

The Batch API is deliberately not used: it does not accept base64 images (the pages would have to be uploaded to a public URL), its discount does not apply to the per-page OCR fee, the `-1017` DeepSeek snapshot has no batch variant, and results can take up to 24 hours.

## How each page is handled

Every page is classified locally (free): plain text, text with figures, or handwritten/scanned. What happens next depends on `strategy` in `config.toml`:

The page lets you pick per run; `strategy` in `config.toml` sets the default.

| `strategy` | What is sent | Measured cost |
|---|---|---|
| `"vision"` (Cheapest) | every page as an image to the vision model, which transcribes text, LaTeX, tables, diagrams (Mermaid) and handwriting in one call | ~$0.0006 / page |
| `"ocr+vision"` (Best quality, default) | printed text to Mistral OCR; figure pages also to the vision model for figures and handwriting; handwritten pages only to the vision model | ~$0.003 / page |

On the test PDFs both strategies produced equally complete text, with LaTeX intact; `"vision"` was 6x cheaper and 4x faster. Switch to `"ocr+vision"` if printed math ever comes out wrong. Thinking is off by default (`vision_reasoning`); `{ effort = "low" }` costs about 4x more and did not read handwriting better in tests.

Crossed-out content is kept as ~~strikethrough~~; on messy corrections treat that as a hint. Logos and icons (images under 3% of the page) do not count as figures.

## Output

```
out/<job>/
  <Course_Type-NN_Topic>.md   one per PDF, named after its content; YAML front matter (title, summary,
                              topics, source, ...), then <!-- page N --> markers per page
  <pdf-name>/images/pNNN.png  renders of pages with figures or handwriting, linked from the markdown
  <pdf-name>/manifest.json    page kinds, failed pages, API calls, cost
```

All markdown files of a run sit side by side in the job folder, so they can be copied in one go. The page shows that folder's Windows path, a Copy button per file, and zips with or without images.

Diagrams are drawn as Mermaid with quoted labels plus a one- or two-sentence explanation in the document's language. Common Mermaid syntax slips (empty or unquoted edge labels) are repaired automatically; on the test material 111 of 112 diagrams parse.

## Cost and re-runs

The page shows an estimate before converting. Every API result is cached in `.cache/`, so re-running the same PDF is free. A page that fails (rate limit, provider error, out of credits) is marked in the markdown and in `manifest.failed_pages`; it is not cached, so re-running the PDF retries only the failed pages.

## Configure

`config.toml`: models, PDF engine (`mistral-ocr`, or the free `cloudflare-ai` for plain text), reasoning effort for the vision model, parallel workers, render DPI, and prices for the estimate. After changing a vision prompt in `app/pipeline.py`, bump `PROMPT_VERSION` so cached results are not reused.

## Tests

```bash
.venv/bin/python -m pytest -q
```
