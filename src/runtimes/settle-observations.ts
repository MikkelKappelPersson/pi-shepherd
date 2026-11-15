/**
 * Settlement observation seam (010 Phase 1) — the bridge subscribes through
 * the active runtime's registry instead of importing the Herdr module
 * directly.
 *
 * Both runtimes expose `onTaskSettled` with identical semantics (007 §1):
 * fires once per actual transition into a terminal task state, after the
 * watcher fan-out, with a shallow result copy and a fresh `{ hadWatchers,
 * agent?, label?, source? }` context. This module is the single place that
 * knows both registries; the unseen bridge (`src/extension/
 * unseen-completions.ts`) subscribes here, resolved per command through the
 * same `resolveBackend` + `detectCaller` seam as `doAction`.
 *
 * A parent session may settle tasks on either backend across commands (the
 * backend pin can change mid-session), so the bridge subscribes to both
 * registries unconditionally. The resolved backend is exposed for diagnostics
 * and future narrowing but never narrows the subscription — that is what
 * keeps no-watch done → settle-or-idle-wake working on both backends.
 */

import { resolveBackend, type ResolvedBackend } from './backend.ts';
import { detectCaller } from './detect.ts';
import { loadSettings } from '../core/config.ts';
import {
  lifecycleRegistry,
  type TaskSettledListener,
} from './herdr/orchestration.ts';
import {
  onTaskSettled as onHcTaskSettled,
  type HcTaskSettledListener,
} from './hc/runtime.ts';

/** Backend-neutral settlement observation context (both runtimes agree). */
export interface UnifiedSettlementContext {
  hadWatchers: boolean;
  agent?: string;
  label?: string;
  source?: 'delegate-submission-failure';
}

/** Structural settlement result; both runtimes satisfy this shape. */
export interface UnifiedSettlementResult {
  taskId: string;
  agentId: string;
  status: 'completed' | 'blocked' | 'failed' | 'cancelled' | 'timed_out';
  ok: boolean;
  returnCode: number;
  text?: string;
  error?: string;
}

export type UnifiedSettledListener = (
  result: UnifiedSettlementResult,
  context: UnifiedSettlementContext
) => void;

function asUnified(listener: UnifiedSettledListener): {
  herdr: TaskSettledListener;
  hc: HcTaskSettledListener;
} {
  const herdr: TaskSettledListener = (result, context) =>
    listener(
      result as unknown as UnifiedSettlementResult,
      context as unknown as UnifiedSettlementContext
    );
  const hc: HcTaskSettledListener = (result, context) =>
    listener(
      result as unknown as UnifiedSettlementResult,
      context as unknown as UnifiedSettlementContext
    );
  return { herdr, hc };
}

/**
 * Resolve the active backend for one command (same resolver as `doAction`:
 * explicit pin wins, else run where called from). May throw when no backend
 * is reachable — callers fall back to subscribing broadly.
 */
export function resolveActiveSettlementBackend(cwd?: string): ResolvedBackend {
  return resolveBackend(loadSettings(cwd).backend, detectCaller());
}

/** Registry handle for one backend (open question 1: beside resolveBackend). */
export function settlementRegistryFor(backend: ResolvedBackend): {
  onTaskSettled: (listener: UnifiedSettledListener) => () => void;
} {
  if (backend === 'hc') {
    return {
      onTaskSettled: listener => onHcTaskSettled(asUnified(listener).hc),
    };
  }
  return {
    onTaskSettled: listener => lifecycleRegistry.onTaskSettled(asUnified(listener).herdr),
  };
}

/**
 * Subscribe to task settlements on BOTH backends with one handler. Returns a
 * single unsubscribe releasing both registrations. This is the only
 * subscription the unseen bridge uses: whichever runtime settles a task,
 * the bridge records it and schedules the idle wake.
 */
export function subscribeToTaskSettlements(listener: UnifiedSettledListener): () => void {
  const { herdr, hc } = asUnified(listener);
  const offHerdr = lifecycleRegistry.onTaskSettled(herdr);
  const offHc = onHcTaskSettled(hc);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    offHerdr();
    offHc();
  };
}
