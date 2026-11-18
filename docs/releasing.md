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
- [ ] For the farewell/rename pair, publish the **new package first** so the
      migration pointer is never a 404:
      1. Publish `@luminascale/shepherd@<new-version>` (`0.6.0` for the rename).
      2. Publish the final old-name release from a short-lived release branch
         or worktree that restores `"name": "@luminascale/pi-shepherd"` and
         sets `0.5.2`. Its notice is gated by a per-host marker file and is
         never emitted in a child sheep process.
      3. Deprecate the old name with a pointer:
         `npm deprecate @luminascale/pi-shepherd@0.5.2 "Moved to @luminascale/shepherd"`.
      T018 still means the old name gets its final notice-bearing release and
      is deprecated; T019 is the new package name. The user-facing ordering
      requirement is that the pointer target exists before the pointer ships.
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
