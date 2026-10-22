# Prerequisites — what a sheep machine must provide

Companion to [intent.md](intent.md). The intent says a sheep may live on
another machine; this file fixes the **contract** that makes that safe: what
the remote side must offer, what pi-shepherd refuses to require, and how each
claim is *verified* rather than assumed.

Four questions drove this file, and each has a settled answer:

1. What if the sheep machine cannot reach the shepherd over SSH?
2. What if the pi-shepherd versions differ?
3. What if it is installed differently (npm, git, clone, `-e`, Nix)?
4. How do we prove any of the above before a task is delegated?

The governing rule: **a claim that cannot be round-tripped is not a
precondition, it is a hope.** Every item below ends in an observable check
with a specific failure message.

---

## 1. Transport direction — the sheep never needs SSH to the shepherd

Herdr's `machine add` already establishes exactly one direction: **parent →
remote** (that is how pane, agent, and workspace commands reach the remote
server). So do not add the opposite direction. Invert the relay.

- Both brokers stay local to their own machine. Nothing is shared, nothing is
  mounted.
- The parent drives one loop per machine that owns live sheep:
  - **push** unsent envelopes into the remote inbox,
  - **pull** new envelopes from the remote outbox,
  - **ack** by moving/removing the delivered file.
- The child's 250 ms inbox poll (`src/extension/shepherd-done.ts`) stays local
  and unchanged. The child never touches the network. This is the property
  that makes the design cheap: one implementation of envelope semantics, two
  transports.
- **No reverse credential**, no listener on the parent, no
  `authorized_keys` edit on the parent, no tunnel lifecycle to supervise.

Latency budget: a child's question reaches the shepherd within one parent
poll interval (~1 s per machine); the child receives mail within ~250 ms of a
push. That is adequate for ask-and-wait work and unacceptable for
real-time steering, which is why the reverse direction is a **latency
optimisation, not a requirement**: a parent-opened `ssh -N -R` tunnel, or an
opt-in `restrict`ed key with a forced command pinned to one agent id. Both
stay off by default and are visible in `machine status` when enabled.

Scaling note: N machines × 1 poll each needs `ControlMaster`/`ControlPersist`
and a poll that only runs for machines with live sheep. Unreachable machines
must **stop** being polled (and surface as unreachable), never retry silently
forever.

## 2. Launch assets travel as content, not as paths

Today `writePiLaunchFiles` writes `launch-*.sh`, `task-*.md`, `sysprompt-*.md`
and a session file into a local `mkdtemp`, then passes absolute local paths,
including `-e <parent>/src/extension/shepherd-done.ts`. A remote pane can read
none of that. Two consequences:

- Script, task, and system prompt must be **uploaded as bytes** over the same
  ssh channel and written to a remote path the **parent chooses**. Choosing
  the path is what makes the mailbox addressable at all: the parent knows the
  remote `PI_SHEPHERD_BROKER_DIR` because it invented it.
- The `-e` argument must be the **remote's own** sidecar path, never the
  parent's (see §4). This is the single change that keeps a remote child's
  capability surface identical to a local child's: sidecar only, so
  `shepherd_message` + `shepherd_done` and nothing else. Relying instead on
  the remote's auto-loaded package would silently give every remote sheep the
  full shepherd surface (`spawn`/`delegate`/`close`) — a capability
  asymmetry nobody asked for.

Transport mechanics wanted: pure POSIX shell over `ssh` to the profile's
`target`, no remote helper binary and no build step —
`cat > …/.tmp.$$ && mv` for atomic publish, length-prefixed or NUL-framed
batches for pull. Envelope sizes already bounded by `maxMessageBytes`, and
handlers are already idempotent, so a duplicated batch is safe.

## 3. Version skew — protocol gates, package version does not

Two versions exist and only one may gate:

- **Package version** (`@luminascale/pi-shepherd` 0.5.0) — informational.
- **Wire protocol** — already implicit: envelopes carry `schemaVersion: 1`,
  and `src/runtimes/herdr/messaging.ts` rejects anything else.

Today's mismatch failure mode is the worst one available: an invalid envelope
is moved to `rejected/`, the child never learns, and the task hangs until
timeout. Therefore:

- Handshake before work: `protocolVersion` plus a **capability list**
  (`mailPull`, `ackByMarker`, `steer`, …). A scalar breaks on the first
  optional feature; a list does not.
- Accept N/N-1 and refuse the rest, at `delegate` time, with an actionable
  remedy — never at completion.
- **Treat the child as the weak side.** An ancient remote sidecar must be able
  to answer "I am protocol 0"; silence is a failed preflight, not a pending
  task.
- What actually has to move together, and therefore belongs under the protocol
  number: envelope shape, ack semantics, the child tool names
  (`shepherd_message`, `shepherd_done`), the `PI_SHEPHERD_*` environment
  contract, and the sidecar load path. Cosmetic releases must not bump it.
- Locally, version lockstep is free (`-e <parent's own path>`). Cross-machine
  drift is a **new class of bug**, so `verify-compat.mjs` (which checks the
  *surface*) needs a sibling that checks the *wire*: parent-v1 ↔ child-v2
  fixtures, both directions.

## 4. Install resolution — ask the machine, never compute a path

No path guessable from the parent works: npm lands "under the Pi npm
directory", git clones reconcile to a ref, a dev clone lives in
`~/.pi/agent/extensions/pi-shepherd`, `-e` is a one-off, and `PI_PACKAGE_DIR`
exists precisely because Nix/Guix store paths are arbitrary. The package has
no `bin`, so `which pi-shepherd` is not an option either.

Instead, the extension knows its own root (`import.meta.url`) and its agent
dir (`PI_CODING_AGENT_DIR`), so it writes an **instance manifest** at load:

```json
{
  "packageVersion": "0.5.0",
  "protocolVersion": 1,
  "capabilities": ["mailPull", "ackByMarker"],
  "piVersion": "1.4.0",
  "extensionRoot": "/…/pi-shepherd",
  "sidecarPath": "/…/pi-shepherd/src/extension/shepherd-done.ts",
  "agentDir": "/home/u/.pi/agent",
  "pid": 1234,
  "startedAt": 0
}
```

Stored at `$PI_CODING_AGENT_DIR/pi-shepherd/instance.json`. One read-only
`ssh target cat …` then answers *installed? which version? where?* identically
for npm, git, clone, `-e`, and Nix. **Install method stops being part of the
identity.**

Two consequences:

- **Addressing is `(machine, agentDir)`**, not `machine`. One host can carry
  two installs (npm copy plus a dev clone) or two agent dirs, and those are
  distinct shepherds. The ownership registry key must become
  `(machine, agentDir, paneId)` before any of this lands; today `CreatedPane`
  is keyed by a bare `paneId`, which collides across machines because pane ids
  (`w1:p1`) are per-session-per-machine.
- A **stale manifest** is normal (last shutdown leaves it behind), so treat it
  as a hint plus a liveness check, not as truth: `pid` + `startedAt` let the
  probe distinguish "installed, idle" from "installed, running".

## 5. Provisioning — approved once, verified every time

Mirror the model Herdr already uses for itself: `herdr machine add` prepares
the remote installation and *missing or incompatible installations require
approval in an interactive terminal.*

`shepherd machine add <herdr-profile>` should:

1. Probe (§6). Print exactly what is missing and the exact fix, e.g.
   `pi install npm:@luminascale/pi-shepherd@0.5.0`.
2. Offer to run it; never run it silently. A remote pi package is code
   execution in the user's remote shell, and remote sheep already execute
   remote repo content.
3. Round-trip the mailbox and only then record
   `{machine, agentDir, protocolVersion, sidecarPath, cwd, verifiedAt}`.
4. Re-verify on `machine status`, and re-probe at `spawn` when `verifiedAt` is
   stale.

Never auto-sync agent definitions or fieldnotes. Each is a trust decision
about which repo content may define what a sheep does.

## 6. Preflight checklist

Cheap, ordered, each step with a specific remedy. Blocking steps must block
`delegate`; advisory steps only warn.

| # | Check | How | Failure means |
|---|---|---|---|
| P1 | Machine known and enabled | `herdr machine list --json` → `enabled: true` | "run `herdr machine add <target>`" |
| P2 | SSH reachable parent → remote | one `ssh <target> true` | "machine unreachable; nothing was spawned" |
| P3 | Remote `pi` present and new enough | `pi --version` vs minimum | "remote pi too old for `-e` TypeScript sidecar" |
| P4 | pi-shepherd installed remotely | read `instance.json` | "install `@luminascale/pi-shepherd@<v>` on `<machine>`" |
| P5 | Protocol compatible | manifest `protocolVersion` ∈ window | "machine speaks protocol 2, this shepherd 1" |
| P6 | Sidecar readable | `ssh <target> test -r <sidecarPath>` | "install incomplete; reinstall the package" |
| P7 | Mailbox round trip | push envelope, pull it back, ack | "no working mail route; using tunnel or refusing `delegate`" |
| P8 | cwd exists remotely | `ssh <target> test -d <cwd>` | "per-machine cwd `<dir>` does not exist" |
| P9 | Model/provider available | advisory | warning only; herd records the substitution |

P4/P5/P6 replace what would otherwise be a **30 s `herdr agent start` detect
timeout**: without them a missing remote surface shows up as an opaque agent
start failure, which is exactly the diagnosis-free outcome this list exists to
prevent.

## 7. Rejected alternatives

- **Shared mount (sshfs/NFS) at identical paths.** Preserves the 250 ms poll
  with zero new transport code, but lets the remote host read and rewrite the
  broker directory and its tokens, and a stalled mount blocks the parent poll
  instead of failing it.
- **Reverse SSH as the default.** Requires a credential on the *orchestrator*
  that a remote compromise can use, to buy latency the pull loop already
  delivers.
- **Bundling/copying the sidecar as a standalone file.** It imports
  `../runtimes/herdr/messaging.ts` and `./system-prompt.ts`, and the repo has
  no build step (AGENTS.md). Requiring the package is cheaper than inventing a
  bundler.
- **Path discovery by guessing** (`node_modules`, `which`, `~/.pi/agent/extensions`).
  Wrong for at least two supported install methods, silently wrong when two
  installs coexist.
- **`herdr pane run` / `send-keys` as the message channel.** Types into a TUI:
  lossy, unaddressable, collides with approval prompts. Wake signal only.
- **Silent remote install or silent agent/fieldnotes sync.**

## 8. Still owned by intent.md

These are not settled here and must not be smuggled in by an implementation
detail: per-machine default cwd policy, model inheritance when the remote
lacks the parent's provider, clock skew against envelope `deadlineAt` /
`completedAt`, the fieldnotes decision for remote sheep, what a repo-controlled
remote `.shepherd/config.json` may influence, and pruning while a machine is
powered off.
