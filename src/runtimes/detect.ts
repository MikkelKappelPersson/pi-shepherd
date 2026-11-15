/**
 * Caller detection (009 Phase 0.1) — where is this Shepherd command running?
 *
 * Pure `detectCaller()`: `herdr-tui | hc-app | plain` from env + binary +
 * socket only. No tool/result/README surface, no behavior change; the Phase
 * 0.2 resolver will consume this per command.
 *
 * Authoritative signals only (never labels/titles):
 * - `herdr-tui` iff `HERDR_ENV == "1"` AND `HERDR_PANE_ID` set AND
 *   `herdr --version` exits 0.
 * - `hc-app` iff `HC_TERMINAL_ID` set AND `HC_TERMINAL_SOCKET` exists AND
 *   `hc ls` exits 0.
 * - `plain` otherwise.
 *
 * Nested tiebreak (innermost wins): when both env groups are present — e.g.
 * a TUI pane that ran `hc run`, whose child inherits `HERDR_*` and gains
 * fresh `HC_*` — the `hc-app` check runs first. Rationale: `HC_TERMINAL_ID`
 * is minted per `hc` invocation (the direct caller), while `HERDR_ENV=1` is
 * broadly inherited down the process tree, so `HC_*` presence is the
 * stronger direct-caller signal. A half-signal (env present but binary or
 * socket missing) never masks a fully-validated other runtime; it falls
 * through to `plain`.
 *
 * Unit-testable: pass `{ env, execOk, fileExists }` to inject fakes.
 * Defaults read `process.env`, probe synchronously with a short timeout,
 * and check the socket with `fs.existsSync`. Env is checked first, so a
 * `plain` process never spawns a subprocess.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Where the current Shepherd command was invoked from. Internal only. */
export type CallerKind = 'herdr-tui' | 'hc-app' | 'plain';

/** String-valued environment mapping (`process.env` shape). */
export type EnvLike = { [key: string]: string | undefined };

/**
 * Synchronous binary probe: true iff `cmd args...` exits 0.
 * Injected fakes may record calls to assert the env-first short-circuit.
 */
export type ExecProbe = (cmd: string, args: string[]) => boolean;

/** Synchronous path-existence check (socket probe). Defaults to `existsSync`. */
export type ExistsProbe = (path: string) => boolean;

export interface DetectDeps {
  env?: EnvLike;
  execOk?: ExecProbe;
  fileExists?: ExistsProbe;
}

/** Short subprocess cap so per-command detection stays cheap. */
const PROBE_TIMEOUT_MS = 3_000;

function defaultExecOk(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function hasText(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Classify the current caller. Pure given `deps`; reads `process.env` and
 * probes the local machine by default. Never throws — probe failures fall
 * through to the next candidate, then `plain`.
 */
export function detectCaller(deps: DetectDeps = {}): CallerKind {
  const env = deps.env ?? (process.env as EnvLike);
  const execOk = deps.execOk ?? defaultExecOk;
  const fileExists = deps.fileExists ?? existsSync;

  // hc-app first: innermost wins when both env groups are present.
  if (hasText(env.HC_TERMINAL_ID) && hasText(env.HC_TERMINAL_SOCKET)) {
    try {
      if (fileExists(env.HC_TERMINAL_SOCKET) && execOk('hc', ['ls'])) {
        return 'hc-app';
      }
    } catch {
      // Probe threw synchronously (fake or fs error) — try herdr, then plain.
    }
  }

  if (env.HERDR_ENV === '1' && hasText(env.HERDR_PANE_ID)) {
    try {
      if (execOk('herdr', ['--version'])) {
        return 'herdr-tui';
      }
    } catch {
      // Probe threw synchronously — fall through to plain.
    }
  }

  return 'plain';
}
