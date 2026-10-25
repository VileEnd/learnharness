import json
import re


def clean_ocr(text):
    """Drop the <file ...> wrapper OpenRouter puts around parsed PDF text."""
    text = re.sub(r"^</?file[^>]*>\s*$", "", text, flags=re.M)
    text = re.sub(r"!\[[^\]]*\]\(img-\d+\.\w+\)\n?", "", text)  # extracted-image links that we do not ship
    return text.strip()


def _repair_mermaid_block(block):
    block = re.sub(r'\s--\s*""\s*-->', " -->", block)                  # empty edge label: A -- "" --> B
    block = re.sub(r'(-->|-\.->|==>)\|\s*""\s*\|', r"\1", block)        # empty pipe label: A -->|""| B
    # unquoted pipe labels break on (), {}, [] etc.: A -->|f(x)| B  ->  A -->|"f(x)"| B
    return re.sub(r'(-->|-\.->|==>)\|(?!")([^|\n]+)\|',
                  lambda m: f'{m[1]}|"{m[2].strip().replace(chr(34), "#quot;")}"|', block)


def repair_mermaid(markdown):
    """Fix the syntax slips models make most often inside ```mermaid blocks; text outside is untouched."""
    return re.sub(r"(```mermaid\n)(.*?)(```)", lambda m: m[1] + _repair_mermaid_block(m[2]) + m[3], markdown, flags=re.S)


def build_markdown(meta, pages):
    """meta: front matter fields; pages: [{text, image, vision, error}]"""
    out = ["---"] + [f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in meta.items()] + ["---", ""]
    out.append(f"# {meta['title']}\n")
    for i, p in enumerate(pages, 1):
        out.append(f"<!-- page {i} -->\n")
        if p.get("text"):
            out.append(repair_mermaid(p["text"]) + "\n")
        if p.get("vision"):
            if p.get("image"):
                out.append(f"![page {i}]({p['image']})\n")
            out.append(repair_mermaid(p["vision"].strip()) + "\n")
        for err in p.get("errors", []):
            out.append(f"> **Conversion failed on page {i}:** {err} (re-run to retry)\n")
    return "\n".join(out)
