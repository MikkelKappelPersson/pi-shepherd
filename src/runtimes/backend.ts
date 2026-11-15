/**
 * Backend resolver (009 Phase 0.2) — which runtime should this command use?
 *
 * App-side only. The model never decides: no `shepherd_*` tool schema,
 * prompt snippet, or result mentions `backend`. The pin lives in
 * `src/core/config.ts` (`backend: auto|herdr|hc`, default `auto`,
 * user-owned precedence — a project file can never force it) plus one row
 * in `/shepherd settings`.
 *
 * `resolveBackend(pin, caller)`:
 * - pin `herdr|hc` wins outright; when that runtime is unreachable it throws
 *   with a setup hint and no fallback (never cross-spawns).
 * - pin `auto` (default) maps the caller: `herdr-tui->herdr`,
 *   `hc-app->hc`, `plain->reachable-or-error` (prefer `herdr` server when
 *   up, else `hc`, else throw naming both hints).
 *
 * Pure given injected probes; defaults hit the local machine synchronously
 * with a short timeout. Never returns `auto`, never leaks pane/terminal ids
 * or socket paths — callers surface only the setup hint.
 */

import { execFileSync } from 'node:child_process';
import type { BackendSetting, ResolvedBackend } from '../core/config.ts';
import type { CallerKind } from './detect.ts';

export type { BackendSetting, ResolvedBackend };

export const HC_SETUP_HINT =
  'Run from an `hc` terminal (HC_TERMINAL_ID and HC_TERMINAL_SOCKET set) with `hc` on PATH.';

export const HERDR_SETUP_HINT_FALLBACK =
  'Run `herdr` to start/attach Herdr (or ensure the headless server is up), and keep `herdr` on PATH.';

const PROBE_TIMEOUT_MS = 3_000;

function defaultIsHerdrReachable(): boolean {
  try {
    execFileSync('herdr', ['--version'], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
  } catch {
    return false;
  }
  if (process.env.HERDR_ENV === '1') return true;
  try {
    const out = execFileSync('herdr', ['status', 'server'], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    });
    return /status:\s*running/i.test(String(out));
  } catch {
    return false;
  }
}

function defaultIsHcReachable(): boolean {
  try {
    execFileSync('hc', ['ls'], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

export interface ResolveBackendDeps {
  isHerdrReachable?: () => boolean;
  isHcReachable?: () => boolean;
}

function safeProbe(probe: () => boolean): boolean {
  try {
    return probe() === true;
  } catch {
    return false;
  }
}

/**
 * Pick the concrete runtime for one command. Throws with a setup hint when
 * the pinned (or plain-auto) runtime is unreachable — callers convert this
 * to the standard Shepherd error shape, never a fallback spawn.
 */
export function resolveBackend(
  pin: BackendSetting,
  caller: CallerKind,
  deps: ResolveBackendDeps = {}
): ResolvedBackend {
  const isHerdrReachable = deps.isHerdrReachable ?? defaultIsHerdrReachable;
  const isHcReachable = deps.isHcReachable ?? defaultIsHcReachable;

  if (pin === 'herdr') {
    if (!safeProbe(isHerdrReachable)) {
      throw new Error(
        `backend "herdr" is pinned but unreachable. ${HERDR_SETUP_HINT_FALLBACK} ` +
          `No fallback was attempted: set backend to "auto" to run where called from.`
      );
    }
    return 'herdr';
  }

  if (pin === 'hc') {
    if (!safeProbe(isHcReachable)) {
      throw new Error(
        `backend "hc" is pinned but unreachable. ${HC_SETUP_HINT} ` +
          `No fallback was attempted: set backend to "auto" to run where called from.`
      );
    }
    return 'hc';
  }

  // auto: run where called from.
  if (caller === 'herdr-tui') return 'herdr';
  if (caller === 'hc-app') return 'hc';

  // plain caller: prefer a reachable herdr server, else hc, else clean error.
  if (safeProbe(isHerdrReachable)) return 'herdr';
  if (safeProbe(isHcReachable)) return 'hc';
  throw new Error(
    `No reachable backend (plain caller, backend "auto"). ${HERDR_SETUP_HINT_FALLBACK} ${HC_SETUP_HINT}`
  );
}
