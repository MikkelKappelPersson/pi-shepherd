# Intent — Sheep on another machine (remote Herdr)

## Why this exists

Herdr stopped being a single-machine tool before pi-shepherd noticed. The
CLI now exposes saved SSH profiles (`herdr machine add|list|status`) and a
machine-scoped command form (`herdr --machine <label-or-id> <command>`), so
a pane, a tab, a workspace, and an agent can all live on a machine other
than the one the Shepherd runs on. This box already has two profiles
configured.

pi-shepherd is now the only part of the stack that assumes one computer:
`pane split --cwd "$PWD"`, a local broker directory, local absolute launch
files, a local pane registry. Everything a user actually wants from two
machines — "put the heavy build on the desktop", "run the overnight suite
where the repo is", "keep my laptop cool while the GPU box works" — is
already possible by hand, and is abandoned the moment you want a shepherd
watching.

This spec exists to make machine placement an attribute of a sheep instead
of a fork in the mental model.

## What already holds — do not rebuild it

- **Herdr owns the wire.** Machine profiles, SSH credentials, session
  names, and reconnect behavior are Herdr's job. We address a machine by
  its Herdr profile label or id, never by a raw `ssh` target of our own.
- **The runtime contract is already backend-neutral.** `src/runtimes/runtime.ts`
  exists precisely so a second substrate can sit under the same opaque,
  session-scoped ids (`specs/006-dual-runtime-herdr-durable`).
- **Four operations are cross-machine for free** once the `--machine` prefix
  exists: spawn placement, `status`, `read`, and `close`. So is the status
  widget's notion of agent state (`herdr --machine m agent list`).
- **The envelope layer is transport-shaped, not filesystem-shaped.**
  `src/runtimes/herdr/messaging.ts` keeps envelopes self-describing
  (schema version, session, broker, message, sender, target), authenticates
  children with a token, publishes atomically, records acknowledgements,
  dead-letters malformed mail, and requires idempotent handlers. At-least-once
  delivery over an unreliable link is therefore an existing property, not a
  new problem.

## The one thing that is not free

The broker is a **local filesystem** with a 250 ms child-side inbox poll,
and the launch path writes **local absolute paths** into the child (task
file, system prompt file, session file, and the `-e` path of the
`shepherd-done` sidecar). A remote pane can read none of them.

That single fact decides the whole shape of this work: pane control goes
over Herdr's existing SSH channel, but **coordination needs its own
transport**, and the transport is the only genuinely new subsystem here.

## Direction we intend (not a design lock)

An **SSH relay in the direction we already have** — parent → remote —
layered beneath the existing envelope code. The contract, and every check
that proves it, is in [prerequisites.md](prerequisites.md).

- Each side keeps a normal, local broker. Envelopes are the wire format;
  the relay only moves them, so envelope semantics are implemented once.
- The parent drives the loop per machine: push unsent mail into the remote
  inbox, pull new mail from the remote outbox, acknowledge what was
  delivered. The child's existing 250 ms inbox poll stays local and never
  touches the network.
- **The sheep machine never needs SSH to the shepherd.** No reverse
  credential, no listener on the parent, no tunnel to supervise. A
  parent-opened `ssh -N -R` tunnel or a `restrict`ed key is an opt-in
  latency optimisation, not a prerequisite.
- **Launch assets travel as content**, written to a remote path the parent
  chooses. Choosing that path is what makes the remote mailbox addressable
  at all.
- **Install method is not part of the identity.** The remote instance
  self-reports through a manifest (package version, protocol version,
  capabilities, sidecar path, agent dir), so npm, git, a dev clone, `-e`,
  and Nix-store paths all resolve the same way.
- **Prerequisite, not optional:** the remote machine has `pi` plus the
  `shepherd-done` sidecar. "A tracked task settles only through an explicit
  child `shepherd_done`" is load-bearing; without the sidecar a remote
  sheep's task can only ever time out.
- **Herdr as a nudge, never as the channel.** `herdr --machine m pane
  send-keys` can tell a remote child "mail is waiting, poll now". It types
  into a TUI, so it must never carry the message itself.

## Phasing

1. **Placement without coordination.** Machine inventory surfaced next to
   `herd`; `machine add` runs the preflight and records a verified machine;
   `machine` accepted as a spawn attribute; `status`/`read`/`close` working
   cross-machine; `delegate` and `message` refused with a clear, specific
   error. The registry key becomes `(machine, agentDir, paneId)` first.
2. **Coordination.** Parent-driven SSH relay under the existing envelope
   layer, gated by the wire handshake in
   [prerequisites.md](prerequisites.md); `delegate`/`message`/`watch` reach
   parity for remote sheep.
3. **Comfort.** Optional reverse tunnel or wake nudge, multi-machine widget
   polling, and an explicit decision about fieldnotes for remote sheep.

## Who it serves

1. **Laptop orchestrator, desktop worker.** The Shepherd stays where the
   human is; the heavy sheep live where the CPU is.
2. **Long-running remote work.** The suite runs where the repo and its
   secrets already are, and the answer comes back to the same result blocks.
3. **Maintainer (us).** One tool surface. `machine` is a spawn attribute,
   not a second universe of `remote_*` tools, and machine support costs
   nothing when it is unused.

## What success looks like

- Adding a machine is one line the user already has in Herdr, then
  `/shepherd spawn worker --machine eos-ext` behaves like any other spawn:
  same opaque id, same `call:`/`return:`/`details:` result, same lifecycle.
- `shepherd herd` shows which machine each sheep is on, and `status`,
  `read`, and `close` behave identically for local and remote sheep.
- A remote sheep asks the Shepherd a question mid-task and receives a
  correlated reply; `shepherd_done` remains the only terminal outcome.
- Losing the SSH link turns into a visible terminal failure — never a
  silent hang, and never a fabricated completion.
- A local-only user notices nothing: no new dependency, no new config, no
  SSH key required to run pi-shepherd as it runs today.

## Guiding values

1. **Herdr owns machines.** Profiles, credentials, and session naming stay
   in Herdr. We consume its inventory; we do not grow a parallel SSH config.
2. **One surface, one id space.** Machine is an attribute of spawn. Opaque
   ids stay opaque. A pane id from another machine is never more valid as a
   handle than a local one.
3. **Fail loud, fail closed.** An unreachable machine is a terminal
   outcome, not a pending one.
4. **Local by default.** No behavior change, no new dependency, no new
   credential for the single-machine install.

## Deliberate temptations to resist

- **Shared mount (sshfs/NFS) as "the cheap way."** It preserves the 250 ms
  poll unchanged, and in exchange the remote host can read and rewrite the
  broker directory and its tokens, and a stalled mount blocks the parent
  poll instead of failing it.
- **The child's TUI as the message channel.** Lossy, unaddressable, no
  metadata, and it collides with approval prompts.
- **Adding the reverse SSH direction by default.** It buys latency the
  parent-driven pull loop already provides, and costs a credential on the
  orchestrating machine.
- **Guessing remote install paths**, or letting an npm-shaped layout become
  part of the identity.
- **Trusting the SSH key alone** to authorize an agent id.
- **Silently syncing agent definitions or fieldnotes** to remote machines.
  Each is a trust decision about which repo content may define what a sheep
  does, and remote repo content feeding a locally user-owned gate is a real
  regression, not a convenience.
- **250 ms polling over SSH** fanned out across every remote sheep.
- **Reading agent state as completion.** `idle`/`done` from a remote list is
  visibility, not a result.

## Open questions

Transport direction, version skew, and install resolution are specified in
[prerequisites.md](prerequisites.md). What remains genuinely open:

- Per-machine default working directory. Herdr profiles deliberately carry
  no cwd, so this must be ours, and validated on the far side (preflight
  P8).
- Model inheritance when the remote machine lacks the parent's provider.
- Clock skew against envelope `deadlineAt` and `completedAt`.
- Fieldnotes for remote sheep: shared, mirrored, or explicitly unavailable.
- What a repo-controlled remote `.shepherd/config.json` is allowed to
  influence given the project-agent gate is user-owned and local.
- Ownership and pruning when a machine is powered off at prune time.

## When we are done

We can delete this file's doubts: placement stopped being a decision about
which tool the user reaches for, and became one flag on the same sheep.
