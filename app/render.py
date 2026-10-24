import pymupdf

SPARSE_TEXT_CHARS = 40   # less embedded text than this = scanned or handwritten page
MIN_IMAGE_AREA = 0.03    # images under 3% of the page (logos, icons) are not figures
MIN_DRAWINGS = 20        # slide templates use a few vector paths; diagrams and digital ink use many


def page_kind(page):
    """'scan' (transcribe the whole page), 'figures' (text via OCR + figures via vision), or None (OCR only)."""
    if len(page.get_text().strip()) < SPARSE_TEXT_CHARS:
        return "scan"
    area = abs(page.rect)
    if any(abs(pymupdf.Rect(i["bbox"]) & page.rect) >= MIN_IMAGE_AREA * area for i in page.get_image_info()):
        return "figures"
    if len(page.get_drawings()) >= MIN_DRAWINGS:
        return "figures"
    if any(a.type[0] == pymupdf.PDF_ANNOT_INK for a in page.annots()):
        return "figures"
    return None


def page_kinds(pdf_bytes):
    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
        return [page_kind(p) for p in doc]


def page_pdf(doc, index):
    """A single page as its own PDF, so the OCR result maps to exactly one page."""
    with pymupdf.open() as part:
        part.insert_pdf(doc, from_page=index, to_page=index)
        return part.tobytes(garbage=3, deflate=True)


def render_png(doc, index, dpi):
    return doc[index].get_pixmap(dpi=dpi).tobytes("png")
