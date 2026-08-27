---
description: Cut the next pi-shepherd release: verify, bump the package version, commit, tag, and push
argument-hint: "[version] [bump-level: patch|minor|major]"
---
Cut the next release of this repository following the established v0.1.x pattern.

Version to bump to: ${1:-next patch} (if this is a word like "patch"/"minor"/"major", bump that digit of the current version in package.json; if it is a concrete value like "0.1.5", use it verbatim).
Note for the release summary: ${2:-(none given)}

Steps (do them in order, and stop with a clear report if any step fails):

1. Check state: run `git status --short` and `git log --oneline -5` — make sure the fix/feature work is already committed and the tree is clean. If there is uncommitted work, summarize it and ask before committing; do not silently swallow changes.
2. Verify: run `npm test` and require a clean pass. If tests fail, stop and report — do not release a failing build.
3. Determine the next version from `package.json` (the current published version field), applying the bump requested above.
4. Bump the package: run `npm version <next> --no-git-tag-version` so BOTH `package.json` and `package-lock.json` are updated consistently (the lockfile can drift; `npm version` fixes that). Show the version diff before committing.
5. Commit the bump with the repo's conventional message: `Bump version to <next>`.
6. Create the release tag on that commit, annotated, matching the v0.1.3 style: `git tag -a v<next> -m "Bump version to <next>"`.
7. Push the branch and the tag: `git push` then `git push origin v<next>`.
8. Report: show `git log --oneline` of the new tag and the range since the previous tag (e.g. `git log --oneline v<prev>..v<next>`) so the user can see exactly what the release contains.

Never force-push, never delete or move an existing tag, and never run `npm publish` unless the user explicitly asks for it.
