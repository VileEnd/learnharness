import json
import re
import unicodedata

NAME_PROMPT_VERSION = "n1"
EXCERPT_CHARS = 6000
HEADING_CHARS = 2000
NAME_PROMPT = """You name study documents for a personal knowledge base. Below is an excerpt of a document converted from the PDF file "{source}": its beginning, then the headings found further in.
Reply with JSON only, no code fence:
{{"title": "...", "filename": "...", "summary": "...", "topics": ["..."]}}
- title: readable title in the document's language, with course, document type (slides, exercise sheet, exam, script, notes, book) and number if present, e.g. "Systemsicherheit 1, Aufgabenblatt 3: Crashkurs Assembler".
- filename: the same information in at most 80 characters, words joined with hyphens and parts separated by underscores, e.g. "Systemsicherheit-1_Aufgabenblatt-03_Crashkurs-Assembler". No file extension.
- summary: one or two sentences on what the document covers.
- topics: 3 to 8 short keywords.

Excerpt:
{excerpt}"""

_UMLAUTS = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue", "ß": "ss"})


def slugify(name, limit=80):
    """File-system-safe ASCII name: umlauts transliterated, other accents dropped, only [A-Za-z0-9._-]."""
    name = unicodedata.normalize("NFKD", name.translate(_UMLAUTS)).encode("ascii", "ignore").decode()
    name = re.sub(r"\s+", "-", name.strip())
    name = re.sub(r"[^A-Za-z0-9._-]+", "", name)
    name = re.sub(r"([-_.])[-_.]+", r"\1", name).strip("-_.")
    if len(name) > limit:  # cut at a part boundary (_), else a word boundary (-), never mid-word
        cut = name[:limit + 1]
        part, word = cut.rfind("_"), cut.rfind("-")
        pos = part if part >= limit * 0.6 else word
        name = cut[:pos] if pos > 0 else name[:limit]
    return name.rstrip("-_.")


def excerpt(markdown):
    head = markdown[:EXCERPT_CHARS]
    headings = "\n".join(line for line in markdown[EXCERPT_CHARS:].splitlines() if line.startswith("#"))
    return head + ("\n\n[...]\n\n" + headings[:HEADING_CHARS] if headings else "")


def parse_name(text):
    """The model's JSON reply -> {title, filename, summary, topics}, or None if it is unusable."""
    match = re.search(r"\{.*\}", text, re.S)
    try:
        data = json.loads(match.group(0)) if match else None
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("title"), str) or not data["title"].strip():
        return None
    filename = slugify(str(data.get("filename") or "")) or slugify(data["title"])  # models sometimes skip it
    if not filename:
        return None
    topics = data.get("topics")
    return {"title": data["title"].strip(), "filename": filename,
            "summary": str(data.get("summary", "")).strip(),
            "topics": [str(t) for t in topics] if isinstance(topics, list) else []}
