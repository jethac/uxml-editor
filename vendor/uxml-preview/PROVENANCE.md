# Vendored `uxml-preview`

Upstream: <https://github.com/ReuHomi/uxml-preview>, Apache-2.0.

| Field | Value |
| --- | --- |
| Version | 0.5.0 |
| Tag | `v0.5.0` |
| Commit | `8cbd5cb72d7b5fb0e9ea0e7b32dfdc9e10879e4a` |
| Imported | 2026-08-30 |
| Contents | `src/` and `tests/` verbatim, plus `LICENSE`, `THIRD-PARTY-NOTICES.md`, `CHANGELOG.md` |

## Why this is vendored

The editor needs entry points the published package does not export and features
upstream has scoped out: Unity 6.3 measurement (upstream measures against
6000.0.40f1), controls beyond the five that have dedicated renderers, and the
paint/layout hooks a transition engine has to drive per frame. Upstream is
deliberately scope-locked against those, so the engine lives here instead, behind
`src/core/adapter/UxmlPreviewAdapter.ts` — the single import boundary the editor
is allowed to reach the engine through.

`vendor/uxml-preview/tests/` is the upstream suite, kept so a change to the
engine has to keep passing the measurements it was built from. It runs as part of
`npm test`.

## Local changes

`src/` is byte-identical to the tag above. Two tests resolved fixtures from the
process working directory, which upstream can assume is its own repository root
and this repository cannot:

- `tests/render/visual.test.ts` — snapshots resolve from `import.meta.dirname`
  instead of `process.cwd()/tests/render/snapshots`. Without this the suite
  writes fresh snapshots into the editor's own `tests/` tree and measures
  nothing.
- `tests/template/golden.test.ts` — `docs/accuracy*.md` resolve from
  `import.meta.dirname` instead of `process.cwd()`.

Record further divergences here as they land, so a re-sync can replay them.

`docs/*.md` and `playground/examples.ts` are also vendored: the accuracy docs
are what the golden suite checks its published figures against, and
`playground/examples.ts` is the fixture `tests/template/playground-example.test.ts`
expands. The rest of the upstream playground, its `docs/media/` images, and its
packaging (`package.json`, build config, CI) are not vendored.

## Re-syncing with upstream

```bash
git clone https://github.com/ReuHomi/uxml-preview.git /tmp/uxml-preview
git -C /tmp/uxml-preview diff v0.5.0 <newer-tag> -- src tests > /tmp/upstream.patch
git apply --directory vendor/uxml-preview /tmp/upstream.patch   # resolve against "Local changes"
```

Then update the table above, re-run `npm test`, and note any upstream API change
the adapter has to absorb (0.5.0, for instance, grew `WarningKind` from 8 to 17).
