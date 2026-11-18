# Release checklist

Shepherd ships as one package with two independent host adapters. Every
release must say which host(s) it affects and must have run both verification
harnesses.

## Checklist

- [ ] Run `npm test` — this runs `pi-suite:test` **and** `opencode-suite:test`.
      A release with either suite red does not ship.
- [ ] Determine host impact for the release range:
      `npm run host-impact -- <previous-tag>..HEAD`
      (or `npm run host-impact -- --files a,b,c` for an uncommitted set).
- [ ] Write release notes with an explicit **Pi impact** and **OpenCode impact**
      line. Use `none` when a host is untouched — do not leave it implicit.
- [ ] If impact is Pi-only, verify the range has zero `src/opencode/` edits;
      if OpenCode-only, verify zero `src/extension/`, `index.ts`, or Pi entry
      edits. Shared `src/core/`, `src/runtimes/`, packaging, and docs changes
      are cross-host and must be called out for both.
- [ ] For the farewell/rename pair, follow the strict order in
      `specs/013-opencode-shepherd/tasks.md`: T018 (migration notice on the old
      name) ships **before** T019 (the `@luminascale/shepherd` rename).
      The farewell release publishes the last `@luminascale/pi-shepherd`
      version **first**, then marks it deprecated with a pointer:
      `npm deprecate @luminascale/pi-shepherd@<farewell-version> "Moved to @luminascale/shepherd"`.
      Only after that may the renamed package be published. The one-time
      notice is gated by a per-host marker file and is never emitted in a
      child sheep process.
- [ ] Publish and confirm the install path from each host's own docs:
      `pi install npm:<package>` and the OpenCode `plugins` entry.

## Host impact notes template

```markdown
## <version>

- Pi impact: <none | summary>
- OpenCode impact: <none | summary>
- Shared/engine impact: <none | summary>
- Verification: npm test (Pi + OpenCode suites) — pass
```

`npm run host-impact` classifies changed paths so the notes can be filled in
from evidence rather than memory.
