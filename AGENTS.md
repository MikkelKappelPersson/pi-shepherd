# pi-shepherd — maintenance instructions

A no-fuss pi extension for explicit agent lifecycle orchestration and herding
pi agents inside Herdr. See `README.md` for usage and security details.

## Lifecycle workflow

Use the explicit API when agent assistance is useful: `start` an idle agent,
`prompt` it, `wait` for the result, and `close` it when finished. Parallel work
and chains are caller composition, not special shepherd modes. Bundled agents
are `scout`, `planner`, `worker`, and `reviewer`; run only agents you trust.

## Runtime and architecture

- TypeScript runs directly by pi. There is no build step or bundler.
- Herdr integration shells out to the `herdr` CLI.
- `discovery.ts` is pure and reads agent files fresh on each invocation.
- `orchestration.ts` contains opaque serializable handles and session-scoped
  registries.
- `lifecycle.ts` implements `start`, `prompt`, `wait`, `status`, and `close`.
- `shepherd.ts` exposes the action-discriminated model-facing tool.
- `herdr.ts` owns Herdr launch, pane, and created-pane registry operations.
- `shepherd-done.ts` is the in-tab completion extension.

## Invariants

- Discovery precedence remains user, shared-user, project, shared-project,
  bundled pi agents, bundled shared agents.
- User agent discovery is the default. Project agent definitions are
  repo-controlled and require explicit scope and interactive confirmation.
- `start` never submits a task and leaves the agent alive until `close`.
- Only panes recorded in `~/.pi/agent/pi-shepherd/created-panes.json` may be
  closed by pi-shepherd. Raw pane IDs must not bypass ownership checks.
- Background Herdr placement uses `--no-focus`.
- Temporary launch/session resources are removed only after the child pane is
  confirmed gone.
- Prompt handles allow one unresolved prompt per agent. Close cancels that
  prompt so `wait` never hangs.
- Do not register tools named `subagent`, `subagent_interrupt`,
  `subagents_list`, `subagent_resume`, or `herdr_workflow`; those belong to
  `pi-herdr-agents`.

## Verification

Run `npm test`. Live Herdr verification should cover idle start, non-blocking
prompt, single wait/result recovery, concurrent multi-wait, iterative prompting,
status, close cancellation, focus preservation, and ownership protection.
