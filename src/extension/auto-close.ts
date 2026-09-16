import type { AgentHandleInput } from '../core/orchestration.ts';
import { lifecycleRegistry } from '../core/orchestration.ts';
import { closeAgent } from '../core/lifecycle.ts';
import { loadSettings, type ShepherdSettings } from './config.ts';

export const AUTO_CLOSE_GRACE_MS = 10_000;

type AutoCloseSettings = Pick<ShepherdSettings, 'keepOpen' | 'stayOpen'>;
type Registry = Pick<typeof lifecycleRegistry, 'getAgent' | 'activeTaskForAgent'>;
type CloseAgent = typeof closeAgent;

interface AutoCloseOptions {
  delayMs?: number;
  registry?: Registry;
  close?: CloseAgent;
  settingsFor?: (cwd: string) => AutoCloseSettings;
  schedule?: (callback: () => void, delayMs: number) => void;
  onFailure?: (error: unknown) => void;
}

function defaultSchedule(callback: () => void, delayMs: number): void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
}

/**
 * Close a terminal agent after a short grace period when the configured
 * retention policy does not keep its process or tab. A newly delegated task
 * wins the race and keeps the reusable agent alive.
 */
export function scheduleAgentAutoClose(
  agent: AgentHandleInput,
  cwd: string,
  options: AutoCloseOptions = {}
): boolean {
  const settingsFor = options.settingsFor ?? loadSettings;
  const shouldClose = (settings: AutoCloseSettings) => !settings.keepOpen && !settings.stayOpen;
  if (!shouldClose(settingsFor(cwd))) return false;

  const registry = options.registry ?? lifecycleRegistry;
  const close = options.close ?? closeAgent;
  const schedule = options.schedule ?? defaultSchedule;
  schedule(() => {
    void (async () => {
      let record: ReturnType<Registry['getAgent']>;
      try {
        if (!shouldClose(settingsFor(cwd))) return;
        record = registry.getAgent(agent);
        if (
          record.state === 'closed' ||
          record.activePromptId ||
          registry.activeTaskForAgent(record.handle) ||
          !['done', 'blocked', 'failed'].includes(record.state)
        ) {
          return;
        }
      } catch {
        // The agent was already closed or belongs to a parent session that ended.
        return;
      }

      try {
        const result = await close(record.handle);
        if (!result.confirmedGone) {
          throw new Error(`Pane termination could not be confirmed for ${record.handle.id}.`);
        }
      } catch (error) {
        options.onFailure?.(error);
      }
    })();
  }, options.delayMs ?? AUTO_CLOSE_GRACE_MS);
  return true;
}
