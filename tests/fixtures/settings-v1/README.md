# A v1 settings record (themes migration fixture)

`settings.json` is a version-1 user settings record as the app wrote it before
themes (settings schema v2, 2026-11-12): written by `writeSettings` of the
v1 store (`src/store/settings.ts` at main 3d8d4afa, 0.80.0) on a scratch data
dir, with the appearance section v1's `PUT /api/settings/appearance` accepted:
a custom `background` and the `boldColor` / `italicColor` emphasis inks, next
to the golden record's agent and compaction sections.

`tests/settings-store.test.ts` reads it through the current store, which
migrates it to v2 (the colours move into Default's own overrides only). Keep it
verbatim; it is outside `tests/fixtures/golden-data` because that set now holds
the current (v2) shape.
