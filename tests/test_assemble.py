from app.assemble import build_markdown, clean_ocr


def test_clean_ocr_strips_wrapper_and_dangling_image_links():
    assert clean_ocr('<file name="a.pdf">\n\nHi $x$\n![img-0.jpeg](img-0.jpeg)\nAbb. 1\n</file>') == "Hi $x$\nAbb. 1"


def test_build_markdown():
    md = build_markdown({"title": "Doc", "source": "Doc.pdf"}, [
        {"text": "T1", "image": "images/p001.png", "vision": None, "errors": []},
        {"text": "T2", "image": "images/p002.png", "vision": "```mermaid\ngraph TD\n```", "errors": ["vision: boom"]}])
    assert md.startswith('---\ntitle: "Doc"\nsource: "Doc.pdf"\n---')
    assert "images/p001.png" not in md                       # no figure output -> no image link
    assert md.index("T2") < md.index("![page 2](images/p002.png)") < md.index("```mermaid")
    assert "Conversion failed on page 2:** vision: boom" in md
