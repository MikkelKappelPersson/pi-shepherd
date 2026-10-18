/**
 * Session-scoped ledger of tracked-task settlements that have not yet been
 * noticed by the parent session.
 *
 * The registry settlement observer feeds this ledger whenever a task settles
 * without an attached watcher. The parent extension bridge
 * (`src/extension/unseen-completions.ts`) drains entries after delivering one
 * notice; explicit `shepherd_watch` retrieval and `shepherd_close` clear
 * entries directly.
 *
 * Pure by design: this module must not import `@earendil-works/*`,
 * `src/runtimes/`, or `src/extension/`, so any runtime implementation can feed
 * the same ledger (spec 007).
 */

export interface UnseenSettlement {
  taskId: string;
  agentId: string;
  agent?: string;
  label?: string;
  status: 'completed' | 'blocked' | 'failed' | 'timed_out';
  ok: boolean;
  returnCode: number;
  text?: string;
  error?: string;
}

/** Structural settlement input; independent of the runtime's `TaskResult`. */
export interface UnseenSettlementResult {
  taskId: string;
  agentId: string;
  status: UnseenSettlement['status'] | 'cancelled';
  ok: boolean;
  returnCode: number;
  text?: string;
  error?: string;
}

/** Observer context attached to one settlement. */
export interface UnseenSettlementContext {
  hadWatchers: boolean;
  agent?: string;
  label?: string;
  source?: 'delegate-submission-failure';
}

/**
 * Map keyed by task id, in insertion order. Entries exist only while
 * un-noticed; notifying (boundary or idle) drains them.
 */
export class UnseenCompletionLedger {
  private readonly settlements = new Map<string, UnseenSettlement>();

  /**
   * Add one settlement unless it had watchers, is a parent-initiated
   * cancellation, came from the delegate submission failure path, or is
   * already recorded. Returns whether a new entry was added.
   */
  record(result: UnseenSettlementResult, context: UnseenSettlementContext): boolean {
    if (context.hadWatchers) return false;
    if (context.source === 'delegate-submission-failure') return false;
    if (result.status === 'cancelled') return false;
    if (this.settlements.has(result.taskId)) return false;
    this.settlements.set(result.taskId, {
      taskId: result.taskId,
      agentId: result.agentId,
      ...(context.agent !== undefined ? { agent: context.agent } : {}),
      ...(context.label !== undefined ? { label: context.label } : {}),
      status: result.status,
      ok: result.ok,
      returnCode: result.returnCode,
      ...(result.text !== undefined ? { text: result.text } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
    return true;
  }

  /** Un-noticed entries in insertion order. */
  pending(): ReadonlyArray<UnseenSettlement> {
    return [...this.settlements.values()].map(settlement => ({ ...settlement }));
  }

  /** Drop entries after a notice was successfully handed to pi. */
  drain(taskIds: string[]): void {
    for (const taskId of taskIds) this.settlements.delete(taskId);
  }

  /** Retrieval clear (for example `shepherd_watch`); returns removed ids. */
  clear(taskIds: string[]): string[] {
    const cleared: string[] = [];
    for (const taskId of taskIds) {
      if (this.settlements.delete(taskId)) cleared.push(taskId);
    }
    return cleared;
  }

  /** Close clear (for example `shepherd_close`); returns removed ids. */
  clearForAgent(agentId: string): string[] {
    const cleared: string[] = [];
    for (const [taskId, settlement] of this.settlements) {
      if (settlement.agentId !== agentId) continue;
      this.settlements.delete(taskId);
      cleared.push(taskId);
    }
    return cleared;
  }

  /** Session lifecycle clear. */
  clearAll(): void {
    this.settlements.clear();
  }
}

export const unseenCompletionLedger = new UnseenCompletionLedger();
