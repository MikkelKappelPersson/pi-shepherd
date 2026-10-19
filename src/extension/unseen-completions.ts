/**
 * Parent-side bridge for tracked-task settlements that had no watcher
 * attached.
 *
 * Registers the `shepherd.task.unseen` renderer, subscribes to the lifecycle
 * registry's settlement observer for the duration of a parent pi session
 * (idempotent across repeated `session_start`), and delivers exactly one
 * notice per batch:
 *
 *  - while the Shepherd is idle, a debounced
 *    `pi.sendMessage(notice, { triggerTurn: true })` wake;
 *  - at the `agent_before_settle` boundary of a completed run, one
 *    `custom_message` entry plus `continue: true` for a single extra model
 *    request. We always offer the continuation and let pi's post-commit
 *    `canContinue` check decide; aborted or errored runs never continue,
 *    their entries stay pending for the idle wake.
 *
 * Wiring lives in `index.ts` (parent surface only, after the
 * `PI_SHEPHERD_SESSION` guard) so `registerShepherdTools` fake-pi suites are
 * unaffected.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  unseenCompletionLedger,
  type UnseenCompletionLedger,
  type UnseenSettlement,
} from '../core/unseen-completions.ts';
import { lifecycleRegistry } from '../runtimes/herdr/orchestration.ts';
import { renderShepherdNotification } from './shepherd.ts';

/** Debounce between a recorded settlement and the idle wake. */
export const UNSEEN_NOTICE_COALESCE_MS = 250;

/** Custom message type for the unwatched-completion notice. */
export const UNSEEN_NOTICE_CUSTOM_TYPE = 'shepherd.task.unseen';

export interface UnseenCompletionBridgeOptions {
  coalesceMs?: number;
  ledger?: UnseenCompletionLedger;
}

function settlementIdentity(settlement: UnseenSettlement): string {
  if (settlement.agent && settlement.label) return `${settlement.agent} "${settlement.label}"`;
  return settlement.agent || settlement.label || settlement.agentId;
}

/** Per-entry detail cap; the full result is always one shepherd_watch away. */
const NOTICE_DETAIL_MAX = 200;

function settlementDetail(settlement: UnseenSettlement): string {
  // `||` (not `??`): an empty summary must fall back to the error text.
  const raw = (settlement.text || settlement.error || '').replace(/\s+/g, ' ').trim();
  const detail =
    raw.length > NOTICE_DETAIL_MAX ? `${raw.slice(0, NOTICE_DETAIL_MAX - 1)}…` : raw;
  return detail ? `${settlement.status} — ${detail}` : settlement.status;
}

/**
 * Exact model-facing notice text for one batch of unseen settlements. Kept
 * separate from delivery so the golden text is testable without a pi runtime.
 */
export function formatUnseenCompletionNotice(settlements: readonly UnseenSettlement[]): string {
  const lines = [
    `Shepherd notice — ${settlements.length} task(s) settled with no watcher attached:`,
  ];
  for (const settlement of settlements) {
    lines.push(
      `- ${settlement.taskId} (${settlementIdentity(settlement)}): ${settlementDetail(settlement)}`
    );
  }
  const ids = settlements.map(settlement => `"${settlement.taskId}"`).join(', ');
  lines.push(`Full results: shepherd_watch({ id: [ ${ids} ] })`);
  return lines.join('\n');
}

function noticeDetails(settlements: readonly UnseenSettlement[]): {
  taskIds: string[];
  settlements: UnseenSettlement[];
} {
  return {
    taskIds: settlements.map(settlement => settlement.taskId),
    settlements: settlements.map(settlement => ({ ...settlement })),
  };
}

export function configureUnseenCompletionBridge(
  pi: ExtensionAPI,
  options: UnseenCompletionBridgeOptions = {}
): void {
  const ledger = options.ledger ?? unseenCompletionLedger;
  const coalesceMs = options.coalesceMs ?? UNSEEN_NOTICE_COALESCE_MS;

  let idle = true;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let capturedContext: any;

  const clearFlushTimer = (): void => {
    if (flushTimer === undefined) return;
    clearTimeout(flushTimer);
    flushTimer = undefined;
  };

  const isIdleNow = (): boolean => {
    if (capturedContext && typeof capturedContext.isIdle === 'function') {
      try {
        return capturedContext.isIdle() === true;
      } catch {
        /* fall back to the tracked flag */
      }
    }
    return idle;
  };

  const flush = (): void => {
    clearFlushTimer();
    if (typeof pi.sendMessage !== 'function') return;
    if (!isIdleNow()) return;
    const settlements = ledger.pending();
    if (settlements.length === 0) return;
    try {
      pi.sendMessage(
        {
          customType: UNSEEN_NOTICE_CUSTOM_TYPE,
          content: formatUnseenCompletionNotice(settlements),
          display: true,
          details: noticeDetails(settlements),
        },
        { triggerTurn: true }
      );
    } catch {
      // Delivery is best effort: a synchronous throw keeps entries pending so
      // a later boundary or idle wake retries them.
      return;
    }
    ledger.drain(settlements.map(settlement => settlement.taskId));
  };

  const scheduleIdleWake = (): void => {
    if (flushTimer !== undefined) return;
    if (!idle) return;
    if (ledger.pending().length === 0) return;
    flushTimer = setTimeout(flush, coalesceMs);
    (flushTimer as any).unref?.();
  };

  const subscribe = (): void => {
    if (unsubscribe) return;
    unsubscribe = lifecycleRegistry.onTaskSettled((result, context) => {
      if (ledger.record(result, context)) scheduleIdleWake();
    });
  };

  pi.on('session_start', (_event: any, ctx?: any) => {
    if (ctx !== undefined) capturedContext = ctx;
    idle = true;
    clearFlushTimer();
    ledger.clearAll();
    subscribe();
  });

  pi.on('agent_start', (_event: any, ctx?: any) => {
    if (ctx !== undefined) capturedContext = ctx;
    idle = false;
  });

  pi.on('agent_settled', (_event: any, ctx?: any) => {
    if (ctx !== undefined) capturedContext = ctx;
    idle = true;
    scheduleIdleWake();
  });

  pi.on('agent_before_settle', (event: any, ctx?: any) => {
    if (ctx !== undefined) capturedContext = ctx;
    if (event?.outcome !== 'completed') return undefined;
    // No pre-entry canContinue check: `event.context` is projected from the
    // entries that existed before this handler's draft, so it is always
    // `false` here. pi commits the drafts first and then recomputes
    // `finalContext.canContinue`, so a `custom_message` makes it continuable.
    const settlements = ledger.pending();
    if (settlements.length === 0) return undefined;
    const taskIds = settlements.map(settlement => settlement.taskId);
    const entry = {
      type: 'custom_message' as const,
      customType: UNSEEN_NOTICE_CUSTOM_TYPE,
      content: formatUnseenCompletionNotice(settlements),
      display: true,
      details: noticeDetails(settlements),
    };
    // Drained when handed to pi. pi may reject the whole boundary result if
    // any handler's entries fail projection (runner invalid-boundary path);
    // that is not retried (documented residual in spec 007).
    ledger.drain(taskIds);
    return { entries: [entry], continue: true };
  });

  pi.on('session_shutdown', () => {
    clearFlushTimer();
    ledger.clearAll();
    unsubscribe?.();
    unsubscribe = undefined;
    capturedContext = undefined;
    idle = true;
  });

  pi.registerMessageRenderer(
    UNSEEN_NOTICE_CUSTOM_TYPE,
    (message: any, renderOptions: any, theme: any) => {
      const settlements = Array.isArray(message?.details?.settlements)
        ? message.details.settlements
        : [];
      return renderShepherdNotification(
        message,
        renderOptions,
        theme,
        settlements.length > 0 ? formatUnseenCompletionNotice(settlements) : undefined
      );
    }
  );
}
