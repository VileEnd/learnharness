from app.naming import excerpt, parse_name, slugify


def test_slugify_transliterates_and_strips():
    assert slugify("Übungsblatt 3: Größe & Maß / Interrupts") == "Uebungsblatt-3-Groesse-Mass-Interrupts"
    assert slugify("a" * 100) == "a" * 80


def test_parse_name_accepts_fenced_json_and_rejects_garbage():
    reply = '```json\n{"title": "Systemsicherheit 1, Blatt 3", "filename": "Systemsicherheit-1_Blatt-03", "summary": "x", "topics": ["a"]}\n```'
    assert parse_name(reply) == {"title": "Systemsicherheit 1, Blatt 3", "filename": "Systemsicherheit-1_Blatt-03",
                                 "summary": "x", "topics": ["a"]}
    assert parse_name("no json here") is None
    assert parse_name('{"title": "t", "filename": "///"}') is None


def test_excerpt_adds_later_headings():
    md = "x" * 7000 + "\n# Kapitel 2\ntext\n## 2.1 Details\n"
    assert excerpt(md).endswith("# Kapitel 2\n## 2.1 Details")
