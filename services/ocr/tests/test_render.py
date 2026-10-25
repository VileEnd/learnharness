import pymupdf

from app.render import page_kinds, page_pdf, render_png


def test_page_kinds_ignores_logos(pdf_bytes):
    assert page_kinds(pdf_bytes) == [None, "figures", "scan", None, None]


def test_page_pdf_and_png(pdf_bytes):
    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
        assert len(pymupdf.open(stream=page_pdf(doc, 3), filetype="pdf")) == 1
        assert render_png(doc, 0, 50)[:4] == b"\x89PNG"
