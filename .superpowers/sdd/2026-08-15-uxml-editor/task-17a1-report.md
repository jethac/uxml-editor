# Task 17A1 Report: Deterministic Project Corpus And Fixture Audit

Base: `04b5d57c483cacf4142bdbd6b60092a3641e791e`

Implementation commit: `9dfee1593d91d653a2673f756d46c08886a1e1dc` (`test: add deterministic project fixtures`)

Runtime: Node `v24.15.0`

## RED

Command:

```text
npm test -- tests/fixtures/fixtureAudit.test.ts
```

Output:

```text
Test Files  1 failed (1)
Tests  8 failed (8)
```

The audit failed because every Task 17A fixture path was absent; the first
failure was `menu/Assets/UI/Menu.uxml: expected false to be true`, followed by
the expected `ENOENT` reads for each fixture group and PNG.

## GREEN

Focused command:

```text
npm test -- tests/fixtures/fixtureAudit.test.ts
```

Output:

```text
Test Files  1 passed (1)
Tests  8 passed (8)
```

The audit reads filesystem bytes, validates all required paths and reference
resolution, parses package metadata, and decodes the PNG signature, chunks,
CRC, IHDR, IDAT scanlines, and nonblank pixels. `.gitattributes` forces the
two menu fixtures to check out with their required CRLF bytes.

## Final Verification

```text
npm test
Test Files  45 passed (45)
Tests  696 passed (696)

npm run build
exit 0

git diff --check
exit 0

git diff --cached --check
exit 0
```

The build emitted Vite's existing chunk-size warning and completed successfully.

## Round 1 Fixes

Fix base: `ad24d41be35d51a7c2602ba8f18c082a3091de54`

Implementation commit: `ede745a86dda59e3f0bb2ce76a7fd85694481eaf` (`fix: preserve Task 17A fixture bytes`)

Runtime: Node `v24.15.0`

### RED

```text
npm test -- tests/fixtures/fixtureAudit.test.ts
Test Files  1 failed (1)
Tests  3 failed | 5 passed (8)
```

The strengthened audit failed before fixture changes because the options icon
path was absent, the `option-control` class was absent, and the committed menu
blob ended in LF rather than CRLF.

### GREEN

```text
npm test -- tests/fixtures/fixtureAudit.test.ts
Test Files  1 passed (1)
Tests  8 passed (8)

npm test
Test Files  45 passed (45)
Tests  696 passed (696)

npm run build
exit 0

git diff --check
exit 0

git diff --check --ignore-space-at-eol HEAD~1 HEAD
exit 0
```

The audit now reads raw working-tree, `HEAD`, and index blob bytes for both
menu fixtures and requires CRLF-only line endings in every representation. It
also validates the real options asset, exact malformed preservation sentinels,
the `acme` namespace binding, and responsive control classes. The build again
emitted Vite's existing chunk-size warning and completed successfully.
