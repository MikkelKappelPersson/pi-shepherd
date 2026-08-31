/**
 * pi-shepherd — no-fuss pi extension: subagents + herding pi agents in Herdr.
 *
 * Entry point only. Engine lives in src/core/ (discovery, lifecycle, Herdr,
 * registries, session persistence); the pi tool/command surface lives in
 * src/extension/. Bundled agents are in .agents/agents/.
 */

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { discoverAgents } from './src/core/discovery.ts';
import { fieldnotesEnabled, initializeSessionSettings, loadSettings } from './src/extension/config.ts';
import { openSettings } from './src/extension/settings-ui.ts';
import {
  doAction,
  registerShepherdTools,
  setPromptWatcherSessionActive,
  setTaskWatcherSessionActive,
  setShepherdMessageSessionActive,
  type ShepherdArgs,
} from './src/extension/shepherd.ts';
import { parseShepherdCli, tokenizeCli } from './src/extension/cli.ts';
import { lifecycleRegistry, bindSessionOwner } from './src/core/orchestration.ts';
import { shutdownPromptWatchers, shutdownTaskWatchers } from './src/core/lifecycle.ts';
import { resolveOrCreateParentArtifactSession } from './src/core/artifact-sessions.ts';
import {
  isHerdrAvailable,
  paneOwnedByCurrentSession,
  workingSubagents,
  loadCreatedPanes,
  type HerdrAgentSummary,
} from './src/core/herdr.ts';

/**
 * Persistent "below the editor" status box listing the subagents currently
 * working (see tui.md Pattern 5 / widget-placement.ts). Polls the live herd
 * into a snapshot every ~1s, then renders a bordered box at the real
 * viewport width: one row per agent with a color-coded state icon and an
 * mm:ss elapsed timer — shaped after the pi-interactive-subagents "Subagents"
 * widget, but theme-driven rather than hard-coded ANSI hues. No-op when
 * Herdr isn't reachable or there is nothing working.
 */
interface WorkingSnapshotItem extends HerdrAgentSummary {
  /** Recorded pane creation time (registry), or undefined for untracked panes. */
  createdAt?: number;
  /** Wall-clock ms when this agent started its current walking streak. */
  walkStartMs?: number;
}

function registerSubagentStatusWidget(pi: ExtensionAPI): void {
  const POLL_MS = 1_000;

  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI) return;
    let snapshot: WorkingSnapshotItem[] = [];
    // Walk origins: wall-clock time each agent entered its current
    // "working" walk. Recorded on first observation and dropped once the
    // walk ends, so every walk starts at age zero (right edge) and restarts
    // from there if the agent goes working again later.
    const walkStarts = new Map<string, number>();

    const tick = (tui: { requestRender(): void }): void => {
      // Poll Herdr + the registry once per tick, not per render frame.
      // The created-panes registry is shared across all shepherd sessions;
      // only the panes owned by THIS session belong in this widget.
      const panes = loadCreatedPanes().filter(paneOwnedByCurrentSession);
      const createdAtById = new Map(panes.map((p) => [p.paneId, p.createdAt]));
      const agents = workingSubagents();
      const workingNow = new Set(agents.filter((s) => s.state === 'working').map((s) => s.paneId));
      const now = Date.now();
      for (const paneId of walkStarts.keys()) {
        if (!workingNow.has(paneId)) walkStarts.delete(paneId);
      }
      for (const paneId of workingNow) {
        if (!walkStarts.has(paneId)) walkStarts.set(paneId, now);
      }
      snapshot = agents.map((s) => ({
        ...s,
        createdAt: createdAtById.get(s.paneId),
        walkStartMs: walkStarts.get(s.paneId),
      }));
      tui.requestRender();
    };

    ctx.ui.setWidget(
      'pi-shepherd-working',
      (tui, theme) => {
        let sheepFrame = 0;
        tick(tui);
        const timer = setInterval(() => tick(tui), POLL_MS);
        const animationTimer = setInterval(() => {
          if (!snapshot.some((agent) => agent.state === 'working')) return;
          // Keeps the spinner and the sheep (a pure function of wall-clock
          // age) re-rendering; the counter only feeds the spinner now.
          sheepFrame += 1;
          tui.requestRender();
        }, SHEEP_FRAME_MS);
        return {
          render: (width: number) =>
            snapshot.length > 0
              ? renderWorkingAgents(snapshot, theme, width, sheepFrame, loadSettings(currentCwd()).emojiSheep)
              : [],
          invalidate: () => {
            // Theme changed: rows are re-derived from the live snapshot,
            // which the poll timer keeps fresh.
            tui.requestRender();
          },
          dispose: () => {
            clearInterval(timer);
            clearInterval(animationTimer);
          },
        };
      },
      { placement: 'belowEditor' },
    );
  });
}

/** Elapsed since pane creation, mm:ss (the created-panes registry is the time source). */
function formatElapsedMMSS(createdAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Nature-inspired semantic color for a Herdr state. */
function stateColor(state: string): string {
  switch (state) {
    case 'working':
    case 'done':
    case 'completed':
      return 'success';
    case 'waiting':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return 'dim';
  }
}

// Teal accent (#2aa198) for the box border and working spinner. The pi theme
// has no teal semantic color, so this is a fixed truecolor ANSI hue.
const TEAL_ANSI = '\u001b[38;2;42;161;152m';
const RESET_ANSI = '\u001b[0m';

function teal(text: string): string {
  return `${TEAL_ANSI}${text}${RESET_ANSI}`;
}

/** Colored status icon per Herdr agent state (green Braille spinner, … waiting, ✗ error). */
function stateIcon(
  state: string,
  theme: { fg(color: string, text: string): string },
  frame = 0
): string {
  const color = stateColor(state);
  switch (state) {
    case 'working':
      // Teal spinner; the rest of the row stays neutral.
      return teal(WORKING_SPINNER_FRAMES[frame % WORKING_SPINNER_FRAMES.length] ?? '⠋');
    case 'waiting':
      return theme.fg(color, '…');
    case 'error':
      return theme.fg(color, '✗');
    case 'done':
    case 'completed':
      return theme.fg(color, '✓');
    default:
      return theme.fg(color, '○');
  }
}

// The sheep walks right-to-left through the available gap after the active
// agent name. It jumps back to the right edge after reaching the left edge; it
// never walks back to the right. The glyph itself is not mirrored because
// Unicode/terminals do not provide a portable way to transform an emoji.
const SHEEP_SPEED = 1;
const SHEEP_FRAME_MS = 500;
const WORKING_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Sheep position for an agent's walk age. The position is a pure function of
 * the milliseconds since the walk started (no shared frame counter), so the
 * walk runs exactly one frame per SHEEP_FRAME_MS at any setting. Position
 * wraps against this agent's track width, so different track widths never
 * desync each other's rhythm. Age 0 starts at the right edge.
 */
function animatedSheep(
  ageMs: number,
  useEmoji: boolean,
  theme: { fg(color: string, text: string): string },
  trackSpan: number
): string {
  const glyph = useEmoji ? '🐑' : 'o';
  const cycleWidth = trackSpan + 1;
  const position = trackSpan - (((Math.floor(ageMs / SHEEP_FRAME_MS) * SHEEP_SPEED) % cycleWidth + cycleWidth) % cycleWidth);
  return `${' '.repeat(position + 1)}${theme.fg('text', glyph)}`;
}

/**
 * Bordered "working" box, one line per agent, shaped after the pi-interactive-
 * subagents widget:
 *
 *   ╭─ shepherd ────────── 2 working ─╮
 *   │ ⠋ 01:23  planner  🐑      working │
 *   │ … 00:47  worker            waiting │
 *   ╰───────────────────────────────────╯
 *
 * Left text (icon + elapsed + name) truncates; the right status label is
 * preserved and right-aligned, padding the row to full terminal width.
 */
function renderWorkingAgents(
  agents: WorkingSnapshotItem[],
  theme: {
    fg(color: string, text: string): string;
  },
  width: number,
  sheepFrame = 0,
  useEmoji = true
): string[] {
  const title = 'shepherd';
  const info = `${agents.length} working`;

  const lines: string[] = [borderTop(title, info, width, theme)];

  for (const agent of agents) {
    const elapsed = agent.createdAt != null ? ` ${formatElapsedMMSS(agent.createdAt)}` : '';
    const icon = stateIcon(agent.state, theme, sheepFrame);
    const right = ` ${theme.fg('text', agent.state)} `;
    const name = theme.fg('text', agent.name);
    const prefix = ` ${icon}${elapsed}  ${name}`;
    const sheepGlyph = useEmoji ? '🐑' : 'o';
    const sheepWidth = visibleWidth(theme.fg('text', sheepGlyph));
    const leftWidth = Math.max(0, width - 2 - visibleWidth(right));
    const trackSpan = leftWidth - visibleWidth(prefix) - sheepWidth - 1;
    const sheep =
      agent.state === 'working' && trackSpan >= 0 && agent.walkStartMs != null
        ? animatedSheep(Date.now() - agent.walkStartMs, useEmoji, theme, trackSpan)
        : '';
    const left = `${prefix}${sheep}`;
    lines.push(borderLine(left, right, width, theme));
  }

  lines.push(borderBottom(width, theme));
  return lines;
}

/** Bordered top line: ╭─ title ──── info ─╮ (all chars within `width`). */
function borderTop(
  title: string,
  info: string,
  width: number,
  theme: { fg(color: string, text: string): string }
): string {
  if (width <= 0) return '';
  if (width === 1) return teal('╭');
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = '─'.repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, '─');
  return `${teal('╭')}${teal(content)}${teal('╮')}`;
}

/** Bordered bottom line: ╰──────────────────╯ */
function borderBottom(width: number, theme: { fg(color: string, text: string): string }): string {
  if (width <= 0) return '';
  if (width === 1) return teal('╰');
  const inner = Math.max(0, width - 2);
  return `${teal('╰')}${teal('─'.repeat(inner))}${teal('╯')}`;
}

/**
 * Bordered content line: │left          right│ — left truncates, right is
 * preserved and right-aligned, padded to fill `width` (both │ chars included).
 */
function borderLine(
  left: string,
  right: string,
  width: number,
  theme: { fg(color: string, text: string): string }
): string {
  if (width <= 0) return '';
  if (width === 1) return teal('│');
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status label alone is too wide, keep it compact rather than
  // overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${teal('│')}${theme.fg('muted', truncRight)}${' '.repeat(rightPad)}${teal('│')}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${teal('│')}${theme.fg('muted', truncLeft)}${' '.repeat(pad)}${theme.fg('muted', right)}${teal('│')}`;
}

function parentArtifactSessionForCommand(ctx: ExtensionCommandContext) {
  if (!fieldnotesEnabled()) return undefined;
  const parentPiSessionId = ctx.sessionManager?.getSessionId?.();
  if (!parentPiSessionId) return undefined;
  return resolveOrCreateParentArtifactSession({
    parentPiSessionId,
    parentSessionFile: ctx.sessionManager?.getSessionFile?.(),
    projectRoot: ctx.cwd,
  });
}

/**
 * Delegate a command invocation to doAction() — the shared core that also backs
 * the model-facing tools — and surface the result through notifications.
 * Error results map to error-level notifications; thrown errors are caught so
 * a failing action never escapes into an unhandled rejection.
 */
async function runCommandAction(args: ShepherdArgs, ctx: ExtensionCommandContext): Promise<void> {
  try {
    const result = await doAction(args, {
      cwd: ctx.cwd,
      sessionManager: ctx.sessionManager as any,
      ui: ctx.ui,
      hasUI: true,
    });
    const text = result.content.find(c => c.type === 'text')?.text ?? '(no output)';
    const hasError =
      typeof result.details === 'object' && result.details !== null && 'error' in result.details;
    ctx.ui?.notify(text, hasError ? 'error' : 'info');
  } catch (error: any) {
    ctx.ui?.notify(`pi-shepherd: ${error?.message ?? error}`, 'error');
  }
}

/**
 * Cwd of the most recent pi session. Held in module scope because the
 * /shepherd command's argument-completion callback receives only the typed
 * prefix (no ExtensionCommandContext), and the status widget's render
 * closure lives inside registerSubagentStatusWidget() — outside the
 * export default body, so a local there would be unresolvable at render
 * time. Falls back to the process cwd until session_start fires.
 */
let activeSessionCwd: string | undefined;

function currentCwd(): string {
  return activeSessionCwd ?? process.cwd();
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    setPromptWatcherSessionActive(true);
    setTaskWatcherSessionActive(true);
    setShepherdMessageSessionActive(true);
    activeSessionCwd = ctx.cwd;
    // Fieldnotes are intentionally session-scoped. Persisted setting changes
    // are applied when the next parent pi session starts.
    initializeSessionSettings(ctx.cwd);
    // Bind this session's identity so the panes it creates are tagged and the
    // widget/registry views are scoped to its own sheep.
    bindSessionOwner(ctx.sessionManager?.getSessionId?.());
  });
  pi.on('session_shutdown', (_event, _ctx) => {
    // Watchers are parent-session scoped. Stop timers and discard delivery
    // registrations, but leave prompts, child panes, result files, and notes
    // untouched for normal lifecycle retention.
    setPromptWatcherSessionActive(false);
    setTaskWatcherSessionActive(false);
    setShepherdMessageSessionActive(false);
    shutdownPromptWatchers();
    shutdownTaskWatchers();
    // Drop the binding on teardown so a reload/new-session cycle without a
    // fresh identity never attributes fresh panes to a stale session.
    bindSessionOwner(undefined);
  });

  // Launched workers load the user extension set too, but their only Shepherd
  // surface is the in-tab completion extension from shepherd-done.ts. Keep the
  // parent orchestrator's tools, command, settings UI, and widget out of worker
  // sessions; PI_SHEPHERD_SESSION is set by herdr.ts only for launched agents.
  if (process.env.PI_SHEPHERD_SESSION) return;

  // Tools for natural-language use.
  registerShepherdTools(pi);
  registerSubagentStatusWidget(pi);

  pi.registerCommand('shepherd', {
    description:
      'pi-shepherd: (no args) settings menu | agents | herd | spawn | status | read | settings',
    // Keep completion aligned with the actions the command supports. Agent
    // names (and live handle ids for status) are discovered fresh so
    // user-defined agents and running agents are available here.
    getArgumentCompletions: prefix => {
      const parts = prefix.split(/\s+/);
      const action = parts[0] ?? '';
      const discoveredAgentNames = () =>
        (() => {
          const cwd = currentCwd();
          const s = loadSettings(cwd);
          return discoverAgents(cwd, s.agentScope, {
            includeBundled: s.includeBundledAgents,
          });
        })()
          .agents.filter(agent => agent.name.length > 0)
          .map(agent => ({ name: agent.name, description: agent.description }));
      const liveHandleIdPrefixes = () =>
        lifecycleRegistry
          .allAgents()
          .map(handle => handle.id)
          .filter(id => id.length > 0);
      if (parts.length <= 1 && !prefix.endsWith(' ')) {
        // Pi does not automatically invoke the completion provider again
        // after applying an argument completion. When the user types
        // `/shepherd spa`, show full `spawn <agent>` entries immediately
        // instead of requiring a second completion cycle after `spawn`.
        if (action.length >= 3 && 'spawn'.startsWith(action)) {
          const names = discoveredAgentNames();
          if (names.length > 0) {
            return names.map(agent => ({
              value: `spawn ${agent.name}`,
              label: `spawn ${agent.name}`,
              description: agent.description,
            }));
          }
        }
        if (action.length >= 3 && 'status'.startsWith(action)) {
          const targets = [...discoveredAgentNames().map(a => a.name), ...liveHandleIdPrefixes()];
          if (targets.length > 0) {
            return targets.map(target => ({
              value: `status ${target}`,
              label: `status ${target}`,
            }));
          }
        }
        if (action.length >= 3 && 'read'.startsWith(action)) {
          const targets = [...discoveredAgentNames().map(a => a.name), ...liveHandleIdPrefixes()];
          if (targets.length > 0) {
            return targets.map(target => ({ value: `read ${target}`, label: `read ${target}` }));
          }
        }
        const actions = ['agents', 'herd', 'spawn', 'status', 'read', 'settings'];
        const filtered = actions.filter(s => s.startsWith(action));
        return filtered.length > 0 ? filtered.map(value => ({ value, label: value })) : null;
      }
      if (action === 'spawn') {
        const agentPrefix = prefix.slice('spawn'.length).trim();
        const filtered = discoveredAgentNames()
          .map(agent => agent.name)
          .filter(name => name.startsWith(agentPrefix));
        // Command completion replaces the complete argument string, not just
        // the final token. Preserve the action or Enter turns `spawn scout`
        // into only `scout`.
        return filtered.length > 0
          ? filtered.map(value => ({ value: `spawn ${value}`, label: value }))
          : null;
      }
      if (action === 'status' || action === 'read') {
        const targetPrefix = prefix.slice(action.length).trim();
        const targets = [
          ...discoveredAgentNames().map(a => a.name),
          // A registered agent name is preferred over its handle id; the
          // parser resolves each to a handle through the live registry.
          ...liveHandleIdPrefixes(),
        ].filter(t => t.startsWith(targetPrefix));
        return targets.length > 0
          ? targets.map(value => ({ value: `${action} ${value}`, label: value }))
          : null;
      }
      return null;
    },
    handler: async (args, ctx: ExtensionCommandContext) => {
      const raw = (args ?? '').trim();
      // Quote-aware tokenization (shared with the CLI preview renderer) so
      // flags like --cwd="/a b" survive the split.
      let tokens = raw ? tokenizeCli(raw) : [];
      // With no arguments (or the explicit `settings` action), open the
      // settings menu — the command's default behavior.
      if (tokens.length === 0 || tokens[0] === 'settings') {
        await openSettings(ctx);
        return;
      }
      // Historical aliases remain accepted but are never offered in
      // completions; `agents` is canonical.
      if (tokens[0] === 'list' || tokens[0] === 'sheep') tokens = ['agents', ...tokens.slice(1)];
      const parsed = parseShepherdCli(tokens);
      if ('error' in parsed) {
        ctx.ui?.notify(`pi-shepherd: ${parsed.error}`, 'warning');
        return;
      }
      // Only `agents` is pure local discovery; everything else needs the
      // Herdr runtime, so warn with the setup hint instead of a raw error.
      if (parsed.action !== 'agents' && !isHerdrAvailable()) {
        ctx.ui?.notify(
          'pi-shepherd: Herdr runtime not reachable. Start Herdr with `herdr`, or run pi inside a Herdr pane.',
          'warning'
        );
        return;
      }
      if (parsed.action === 'spawn') {
        const agent = String(parsed.args.agent);
        ctx.ui?.setStatus?.('pi-shepherd', `Starting ${agent}…`);
        try {
          await runCommandAction(
            {
              ...parsed.args,
              // Pre-resolve tolerantly (undefined when fieldnotes are
              // disabled or no session identity exists); 'artifactSession'
              // in args makes doAction honor the explicit value instead of
              // requiring one.
              artifactSession: parentArtifactSessionForCommand(ctx),
            } as unknown as ShepherdArgs,
            ctx
          );
        } finally {
          ctx.ui?.setStatus?.('pi-shepherd', undefined);
        }
        return;
      }
      await runCommandAction(parsed.args as ShepherdArgs, ctx);
    },
  });
}
