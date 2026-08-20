# Contributing to pi-shepherd

Thank you for your interest in contributing to pi-shepherd! Bug reports,
documentation improvements, tests, and code contributions are all welcome.

Please read this guide before opening an issue or pull request. Following these
steps helps keep contributions focused and easy to review.

## Before you start

- Search existing issues and pull requests before opening a new one.
- For larger changes, open an issue first to discuss the proposed approach.
- Keep pull requests focused on one change or closely related group of changes.
- Never include passwords, API keys, tokens, or other sensitive information in
  issues, commits, or pull requests.

## Development setup

pi-shepherd is a TypeScript pi extension that runs directly and does not require
a build step.

The test files import the pi runtime package `@earendil-works/pi-coding-agent`,
which is provided by the pi host rather than declared as an npm dependency of
this extension. Run the tests from an environment where that package is
available.

1. Fork the repository on GitHub.
2. Clone your fork and enter the project directory.
3. Add the original repository as the `upstream` remote if needed.
4. Install any dependencies required by your local environment.
5. Run the test suite to verify your setup:

   ```bash
   npm test
   ```

Live Herdr verification may require a running Herdr environment. See the
project documentation and existing tests for the scenarios covered by the
repository.

## Create a branch

Start new work from an up-to-date `main` branch:

```bash
git fetch upstream
git switch main
git pull --ff-only upstream main
git switch -c <type>/<short-description>
```

Use a descriptive branch name in lowercase. Common prefixes include:

- `feat/` for a new feature
- `fix/` for a bug fix
- `docs/` for documentation-only changes
- `refactor/` for code improvements that do not change behavior
- `test/` for test changes
- `chore/` for maintenance work

For example:

```text
docs/contributing-guide
fix/prompt-timeout
feat/parallel-agent-prompts
```

## Make your changes

- Follow the existing code style and conventions.
- Keep changes small and focused.
- Update documentation when behavior or public interfaces change.
- Add or update tests for behavior changes and bug fixes.
- Preserve the project's security invariants, especially agent scope, pane
  ownership, and cleanup behavior.
- Do not commit generated files, local configuration, credentials, or temporary
  runtime notes.

Before committing, run the relevant tests. For the full focused suite, run:

```bash
npm test
```

## Commit changes

Write clear commit messages in the imperative mood. Conventional Commits use
this general format:

```text
<type>[optional scope][optional !]: <short description>
```

Use one of these common types:

- `feat` — add a new feature
- `fix` — fix a bug
- `docs` — add or update documentation
- `style` — make formatting-only changes that do not affect behavior
- `refactor` — restructure code without changing behavior
- `perf` — improve performance
- `test` — add or update tests
- `build` — change build or dependency configuration
- `ci` — change continuous integration or delivery configuration
- `chore` — make other maintenance changes
- `revert` — revert a previous commit

An optional scope can identify the affected area, and `!` marks a breaking
change. For example:

```text
docs: explain agent discovery
fix: handle prompt timeout
feat: support concurrent waits
refactor(discovery): simplify agent precedence
fix!: remove the legacy delegate action
```

Keep each commit related to the change it describes. Avoid committing unrelated
formatting changes or drive-by refactors.

## Open a pull request

Push your branch to your fork:

```bash
git push -u origin <type>/<short-description>
```

Then open a pull request against the project's `main` branch.

A useful pull request description should include:

- What changed and why.
- How the change was tested.
- Any limitations, compatibility considerations, or follow-up work.
- Links to related issues or discussions.

Please keep the pull request title concise and descriptive. If the change is
not ready for review, open it as a draft pull request.

Maintainers may request changes, ask questions, or suggest a different approach.
Please respond to review feedback and keep the branch up to date while the pull
request is being reviewed.

## Reporting bugs

When reporting a bug, include:

- A clear description of the expected and actual behavior.
- Steps to reproduce the problem.
- Relevant operating system, Node.js, pi, and Herdr versions.
- Test output, logs, or screenshots when useful.
- A minimal reproduction or example, if possible.

Remove sensitive information before sharing logs or configuration.

## Suggesting features

Feature requests are welcome. Explain the problem the feature would solve,
include a proposed use case, and describe any alternatives you considered.
Smaller, well-scoped proposals are easier to evaluate and implement.

## Security issues

Please do not report security vulnerabilities in a public issue. Contact the
maintainers privately with enough detail to reproduce the problem. Do not
include credentials or other secrets in the report.

## Code of conduct

Contributors are expected to be respectful, constructive, and inclusive. Help
maintain a welcoming project by assuming good intent, discussing technical
issues professionally, and avoiding harassment or discriminatory behavior.

Thank you for helping improve pi-shepherd!
