# Journal — 008 sheep on another machine (remote Herdr)

## Status — 2026-10-22

- **Scope: specification only.** No code, no settings, no tool-surface
  change. `specs/008-remote-machine-sheep/` holds `intent.md` and
  `prerequisites.md`; there is no `spec.md`, `plan.md`, or `tasks.md` yet.
- Nothing is implemented: no `machine` spawn attribute, no relay, no
  preflight, no instance manifest, no registry key change.
- Landed on `main` as documentation, not on a feature branch.
- **Exit condition for this stage:** intent (why, who, success, values,
  temptations) and the remote contract (transport direction, version skew,
  install resolution, preflight, rejected alternatives) are written down and
  mutually consistent.

## Decisions

- Transport is **parent → remote push/pull**, not child → parent. Herdr's
  `machine add` already establishes that direction, so the sheep machine
  never needs SSH to the shepherd: no reverse credential, no listener on the
  orchestrator, no tunnel to supervise. A parent-opened `ssh -N -R` tunnel or
  a `restrict`ed key is an opt-in latency optimisation, never a prerequisite.
- Launch assets (script, task, system prompt, session) travel as **content**
  to a **parent-chosen** remote path. Choosing that path is what makes the
  remote mailbox addressable at all.
- The child is launched with the **remote's own** sidecar path
  (`-e <remoteSidecarPath>`) — not the parent's absolute path, and not the
  remote's auto-loaded package. This keeps the child surface identical to
  local: sidecar only, so `shepherd_message` + `shepherd_done`, rather than
  silently granting remote sheep the full `spawn`/`delegate`/`close` surface.
- **Package version is informational; the wire protocol gates.** Envelopes
  already carry `schemaVersion: 1` and reject anything else, and today a
  mismatch dead-letters the envelope so the task hangs to its timeout.
  Mismatch must be refused at `delegate`, with a capability list alongside the
  protocol version.
- **Install method is not part of the identity.** The extension self-reports
  through `$PI_CODING_AGENT_DIR/pi-shepherd/instance.json`, so npm, git, a dev
  clone, `-e`, and Nix-store paths resolve the same way. Addressing becomes
  `(machine, agentDir)`; the ownership key becomes
  `(machine, agentDir, paneId)`.
- Provisioning mirrors `herdr machine add`: probe, print the exact install
  line, require interactive approval, round-trip the mailbox, record
  `verifiedAt`. No silent remote install, no silent agent or fieldnotes sync.

## Deliberately not decided

Per-machine default cwd policy, remote model inheritance when the machine
lacks the parent's provider, clock skew against envelope `deadlineAt` /
`completedAt`, fieldnotes for remote sheep, what a repo-controlled remote
`.shepherd/config.json` may influence, and pruning while a machine is powered
off. These stay in `intent.md` until there is code to argue with.

## Next

`spec.md` for the public surface (`machine` spawn attribute, `herd` and
`machine status` output, refusal errors), then `plan.md`/`tasks.md` for phase 1
— inventory, preflight, and the registry key — before any relay work starts.
