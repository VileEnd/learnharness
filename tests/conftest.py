import pymupdf
import pytest


def make_pdf(pages):
    """pages: list of dicts {text: str, figure: bool, logo: bool}"""
    doc = pymupdf.open()
    for p in pages:
        page = doc.new_page()
        if p.get("text"):
            page.insert_text((72, 72), p["text"])
        if p.get("figure"):
            for i in range(30):
                page.draw_line((100, 200 + i * 5), (400, 200 + i * 5))
        if p.get("logo"):
            logo = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 8, 8), False)
            page.insert_image(pymupdf.Rect(540, 20, 570, 50), pixmap=logo)
    data = doc.tobytes()
    doc.close()
    return data


TEXT = "Some printed lecture text. " * 5


@pytest.fixture
def pdf_bytes():
    # kinds: None, figures, scan, None (logo only), None
    return make_pdf([{"text": TEXT}, {"text": TEXT, "figure": True}, {}, {"text": TEXT, "logo": True}, {"text": TEXT}])
