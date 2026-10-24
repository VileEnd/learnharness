# PDF → Markdown OCR web app — design

## Intent
A student has 20+ PDFs (some 300+ pages): math-heavy lecture slides, past exams, book-like scripts, and handwritten solutions (math, processor architecture). They want to drop many PDFs into a local web page and get one markdown file per PDF, with formulas as LaTeX, tables as tables, and every diagram/graph kept as an image plus a searchable text form (Mermaid where it is a flowchart/state machine/topology, otherwise a description). The markdown is then imported into the user's own database and used by AI agents for summaries and task creation.

## Goals
- Batch upload, one `.md` + `images/` + `manifest.json` per PDF.
- LaTeX math (`$...$`, `$$...$$`), markdown tables.
- Every figure page gets a vision-model pass: Mermaid / table / LaTeX / prose description, with the page image linked above it.
- Handwritten pages are transcribed to LaTeX by a vision model.
- Cost estimate before running; on-disk cache so re-runs cost nothing.

## Non-goals
- Database insertion (user did not say which DB; output is files, import is theirs — my call).
- Local models, auth, multi-user, hosting.

## Anti-goals
- Silently dropping figures (OpenRouter's mistral-ocr caps extracted images at 8 per PDF, so we render pages ourselves).
- Paying twice for the same page.

## Constraints
- Provider: OpenRouter, OpenAI-compatible API. Key from `OPENROUTER_API_KEY`.
- Mistral OCR costs ~$2 / 1,000 pages; expected total for the first batch ~$12 + vision calls.
- Runs on the user's machine; Python is acceptable (user is language-agnostic).

## Decided by the user
- OpenRouter, not local models.
- Web UI is fine.
- Diagrams get a text description, as markdown (Mermaid) where possible.
- Typical input: ~20 PDFs, some 300+ pages.

## My calls (not yet confirmed by the user)
- Python 3.12, FastAPI, vanilla HTML/JS with SSE progress, httpx, PyMuPDF, pytest.
- Each page is classified locally: printed text → Mistral OCR only; printed + figures/ink → Mistral OCR + vision (figures and handwriting only); no embedded text (scan/handwriting) → vision transcribes the whole page, OCR skipped.
- OCR runs one page per request; pages rendered at 150 dpi for the vision model and linked in the markdown.
- Model names live in `config.toml`; vision model is `deepseek/deepseek-v4.1-flash-1017` (user's choice) with low reasoning effort.
- A failed page is marked in the markdown and manifest and not cached, so a re-run retries only that page.

## Risks, resolved in the spike (2026-10-25)
1. mistral-ocr annotations do not keep page boundaries inside a multi-page request → one page per request (same per-page price).
2. `deepseek/deepseek-v4.1-flash-1017` accepts images, but with unbounded reasoning it can return empty content → `reasoning.effort = low`, retry once with reasoning off.

## Left to the builder
Prompt wording for the vision pass, exact thresholds for "sparse OCR text", UI styling, cache file layout.
