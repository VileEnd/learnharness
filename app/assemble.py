import json
import re


def clean_ocr(text):
    """Drop the <file ...> wrapper OpenRouter puts around parsed PDF text."""
    text = re.sub(r"^</?file[^>]*>\s*$", "", text, flags=re.M)
    text = re.sub(r"!\[[^\]]*\]\(img-\d+\.\w+\)\n?", "", text)  # extracted-image links that we do not ship
    return text.strip()


def build_markdown(meta, pages):
    """meta: front matter fields; pages: [{text, image, vision, error}]"""
    out = ["---"] + [f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in meta.items()] + ["---", ""]
    out.append(f"# {meta['title']}\n")
    for i, p in enumerate(pages, 1):
        out.append(f"<!-- page {i} -->\n")
        if p.get("text"):
            out.append(p["text"] + "\n")
        if p.get("vision"):
            out.append(f"![page {i}]({p['image']})\n")
            out.append(p["vision"].strip() + "\n")
        for err in p.get("errors", []):
            out.append(f"> **Conversion failed on page {i}:** {err} (re-run to retry)\n")
    return "\n".join(out)
