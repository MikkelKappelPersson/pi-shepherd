# Low-Level Agent Orchestration Primitives

## Status

Proposed specification.

## Summary

Replace workflow-oriented delegation as the primary orchestration model with a
small set of low-level agent lifecycle primitives:

```text
start(agent, options) -> AgentHandle
prompt(handle, message, options) -> PromptHandle
wait(promptHandle | PromptHandle[]) -> Result | Result[]
status(handle) -> Status
close(handle) -> void
```

Starting an agent must not submit work. Work is submitted explicitly with
`prompt`, and synchronization is explicit with `wait`. Parallel, sequential,
chain, fan-out/fan-in, retry, and review-loop workflows are composed by the
caller rather than being special delegation modes in pi-shepherd.

## Goals

- Make agent orchestration small, explicit, and composable.
- Separate agent lifecycle from work submission and result synchronization.
- Allow an agent to be started without an initial task.
- Support parallel work by waiting on multiple prompt handles.
- Preserve Herdr-native execution and visibility.
- Keep agent placement and launch configuration in `start` options.
- Return stable, serializable handles suitable for later tool calls.
- Preserve pi-shepherd's safety invariant: only panes created by pi-shepherd
  may be closed through pi-shepherd.
- Make failures and partial results observable rather than hiding them inside
  workflow-specific orchestration.
- Retain diagnostic operations such as listing agents and reading pane output.

## Non-goals

- No first-class `single`, `parallel`, or `chain` workflow modes in the core
  orchestration API.
- No task, message, or initial prompt argument to `start`.
- No implicit `{previous}` substitution or chain-specific result plumbing.
- No requirement that pi-shepherd implement arbitrary workflow composition.
- No simultaneous unresolved prompts for one agent in the initial version.
- No requirement to expose Herdr pane IDs as the public handle format.
- No automatic closing of agents after a prompt completes.
- No `stayOpen` option on `start`; started agents remain alive until `close`.

## Core API

### `start(agent, options) -> AgentHandle`

`start` resolves the requested discovered agent definition, creates and places
its Herdr pane/tab, launches pi, and waits until Herdr detects the agent as
ready. It returns only after the agent is addressable.

`start` does **not** send a task or user message.

The selected agent definition supplies its system prompt and default agent
configuration. Start options may override supported launch settings, including
model, working directory, tools, and system-prompt behavior. Placement options
control the Herdr topology and must follow Herdr's layout rules.

Illustrative options:

```ts
start("reviewer", {
  cwd: "/project",
  placement: {
    kind: "tab",          // or an explicitly requested sibling pane layout
    direction: "right",
    noFocus: true,
  },
  model: "provider/model",
})
```

A started agent is persistent until explicitly closed. `start` must not expose a
`stayOpen` option: because it accepts no task, `stayOpen: false` would create an
agent only to immediately terminate it, which is not meaningful for this API.
One-shot behavior belongs in a compatibility/convenience wrapper that performs
`start + prompt + wait + close`.

The exact placement schema is implementation-defined, but it must support the
Herdr primitives appropriate to the requested topology. By default, background
agents should not steal focus, and the caller's working directory should be
preserved unless explicitly overridden.

#### Start errors

`start` fails if the agent definition cannot be resolved, project-agent trust
requirements are not satisfied, Herdr cannot be reached or started, the pane
cannot be created, or pi cannot become ready. A failed start must not return a
usable handle.

### `prompt(handle, message, options) -> PromptHandle`

`prompt` sends exactly one user message to an already-started agent and returns
immediately after the message has been accepted for processing. It does not
wait for the agent's turn to settle.

```ts
const operation = prompt(agent, "Review the current diff", {
  timeout: 120_000,
})
```

The returned `PromptHandle` identifies this particular submitted operation and
can be passed to `wait`.

The initial implementation must reject a prompt when the agent already has an
unresolved prompt. This prevents ambiguous result association. Parallel work
is achieved by prompting multiple agents, not by concurrently prompting one
agent.

`prompt` must not silently discard messages. If Herdr does not detect the
agent, the agent is unavailable, or submission stalls, it returns an error and
no usable `PromptHandle` is produced.

### `wait(promptHandle | promptHandles, options) -> Result | Result[]`

`wait` waits for one or more submitted prompts to settle and returns their
results. Waiting is a synchronization operation, not an agent-lifecycle
operation: it must not close or terminate the agent. The caller uses `close`
when the agent is no longer needed.

```ts
const result = await wait(operation)
const results = await wait([researchA, researchB])
```

For an array, the default behavior is **wait for all**. Results preserve the
same order as the input handles, regardless of completion order. Waiting for
multiple prompts must wait concurrently, not sequentially.

Multi-wait should return a result for every input, including failures, so one
failed or timed-out agent does not hide successful results from other agents.
It therefore has `Promise.allSettled`-like failure behavior at the result level.

A future version may support options such as `until: "any"`, but first version
behavior is only wait-for-all.

### `status(handle) -> Status`

`status` performs a non-blocking inspection of the agent's current state.
Possible lifecycle states should reflect Herdr's recognized states:

```text
idle | working | blocked | done | unknown | failed | closed
```

The returned status should include stable identity and placement metadata where
available, such as agent name, handle ID, pane ID, tab ID, and workspace ID.
`status` must not focus the agent or otherwise alter user-visible Herdr state.

### `close(handle) -> void`

`close` closes the Herdr pane/tab represented by the handle and releases its
pi-shepherd resources. It must refuse to close a pane that pi-shepherd did not
create, even if a caller supplies a matching raw pane ID.

Closing an agent with unresolved prompts should be explicit and deterministic.
The initial implementation should mark those prompts as failed/cancelled and
ensure subsequent `wait` calls return those results rather than hanging.

Close should be idempotent for a handle that has already been closed, while a
handle from another session or an unknown handle should produce a clear error.

## Data model

Handles are opaque to callers but serializable across model/tool calls.
Internal representations may contain Herdr identifiers, but callers should use
the generated handle ID rather than depending on pane IDs.

Illustrative shapes:

```ts
type AgentHandle = {
  id: string
  agent: string
  paneId?: string
  tabId?: string
  workspaceId?: string
}

type PromptHandle = {
  id: string
  agentId: string
  createdAt: number
}

type Result = {
  promptId: string
  agentId: string
  status: "idle" | "done" | "blocked" | "failed" | "timeout" | "cancelled"
  ok: boolean
  text?: string
  error?: string
}
```

The exact TypeScript representation may differ. The public contract must retain
stable IDs, prompt-to-agent association, terminal status, and either returned
text or an actionable error.

## Composition examples

### Parallel work

```ts
const researcherA = await start("scout", { cwd: project })
const researcherB = await start("scout", { cwd: project })

const promptA = await prompt(researcherA, "Research authentication")
const promptB = await prompt(researcherB, "Research authorization")

const [resultA, resultB] = await wait([promptA, promptB])
```

### Sequential chain

```ts
const scout = await start("scout", options)
const scoutPrompt = await prompt(scout, "Inspect the repository")
const scoutResult = await wait(scoutPrompt)

const planner = await start("planner", options)
const plannerPrompt = await prompt(
  planner,
  `Create a plan from this report:\n\n${scoutResult.text}`,
)
const plannerResult = await wait(plannerPrompt)
```

### Iterative work on one agent

```ts
const worker = await start("worker", options)
const first = await wait(await prompt(worker, "Implement the feature"))
const second = await wait(await prompt(worker, "Run tests and fix failures"))
```

## Existing functionality and migration

The existing Herdr management actions for `agents`, `list`, `read`, and `gc`
remain useful and may remain separate operational actions. `status` and
`close` should be updated to accept `AgentHandle`s while retaining safe
resolution of existing created-pane records during migration.

The current `delegate` modes (`single`, `parallel`, `chain`, and `bare`) should
not remain the fundamental implementation. The implementation should first
extract reusable start/prompt/wait lifecycle operations from the existing Herdr
runner and persistent-agent path. The low-level `start` operation always
creates a persistent agent; the old `bare` mode is therefore replaced by
`start` with no initial prompt.

A temporary compatibility wrapper may implement legacy delegation as:

```text
delegate(single)   = start + prompt + wait + close (if one-shot behavior is requested)
delegate(parallel) = multiple start/prompt + wait(all) + close (if requested)
delegate(chain)    = repeated start + prompt + wait + close (if requested)
```

If retained, this wrapper must be documented as convenience syntax and must not
reintroduce workflow behavior into the low-level primitives. It may be removed
in a later breaking change.

## Lifecycle and persistence

- Agent handles must be backed by a registry while their agents are alive.
- Prompt handles must remain resolvable until they settle, fail, are cancelled,
  or are explicitly garbage-collected.
- Extension reload and parent-session boundaries must either preserve these
  registries or return clear invalid-handle errors; they must never wait
  indefinitely on lost state.
- Temporary launch/session files must not be deleted while a child pi process
  can still access them.
- Completion results should be recovered from the existing completion sidecar
  and/or child session data only after the child has reached a safe settled
  state, preserving the existing sentinel/session-file invariant.

## Security and safety

- User-level agent discovery remains the default.
- Project-controlled agent definitions remain trust-gated and require explicit
  opt-in/confirmation.
- Agents retain host-user tool permissions; this must remain documented.
- Herdr commands must use explicit pane/workspace context and preserve focus by
  default.
- `close` must never close panes pi-shepherd did not create.
- Raw caller-supplied pane IDs must not bypass ownership checks.

## Acceptance criteria

- An agent can be started with no task and becomes visible/ready in Herdr.
- `start` returns a stable handle and sends no user message.
- `prompt` returns before the agent finishes processing the message.
- `wait` returns the corresponding result for one prompt.
- `wait` on multiple prompts runs waits concurrently and returns ordered,
  per-prompt results including partial failures.
- A second unresolved prompt to the same agent is rejected.
- `status` reports lifecycle state without focusing or mutating the agent.
- `close` enforces pi-shepherd pane ownership and resolves outstanding prompts.
- Parallel and chain behavior can be implemented entirely by composing the
  primitives.
- Existing project-agent trust and temporary-file safety invariants remain
  intact.
