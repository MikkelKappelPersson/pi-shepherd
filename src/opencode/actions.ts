/**
 * OpenCode action dispatcher (spec 013, Phase 2).
 *
 * Pi-owned surface for OpenCode: mirrors the `spawn` / `status` / `read` /
 * `close` / `herd` / `agents` / `prune` branches of the Pi `doAction()`
 * against the same shared engine (discovery, runtimes, broker, registries).
 * The Pi dispatcher is not reused because it is entangled with Pi UI types;
 * the lifecycle semantics are identical.
 *
 * Every function takes an explicit { cwd, sessionId } context (resolved
 * from the OpenCode session by server.ts) and returns plain text for the
 * tool result. Thrown errors carry the user-facing message.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadSettings } from '../core/config.ts';
import { discoverAgents } from '../core/discovery.ts';
import { unseenCompletionLedger } from '../core/unseen-completions.ts';
import { resolveBackend, HC_SETUP_HINT, type ResolvedBackend } from '../runtimes/backend.ts';
import { detectCaller } from '../runtimes/detect.ts';
import { createHerdrRuntime } from '../runtimes/herdr/runtime.ts';
import {
  createHcRuntime,
  describeHcAgent,
  describeHcStatusView,
  drainHcInboxForSession,
  resolveHcAgentId,
} from '../runtimes/hc/runtime.ts';
import { isHcAvailable } from '../runtimes/hc/hc.ts';
import { bindSessionOwner, lifecycleRegistry } from '../runtimes/herdr/orchestration.ts';
import { statusAgent } from '../runtimes/herdr/lifecycle.ts';
import {
  HERDR_SETUP_HINT,
  agentSummaries,
  formatSummary,
  herdrExecSync,
  isHerdrAvailable,
  loadCreatedPanes,
  pruneStaleCreatedPanes,
} from '../runtimes/herdr/herdr.ts';
import { OPENCODE_LAUNCH_OVERRIDES } from './host.ts';

const execFileAsync = promisify(execFile);

export interface OpencodeActionContext {
  cwd: string;
  sessionId?: string;
}

const PLACEMENTS = ['pane_right', 'pane_down', 'tab', 'workspace'] as const;
type Placement = (typeof PLACEMENTS)[number];

/** Resolve the backend for one call; throws the setup hint when unreachable. */
function backendFor(ctx: OpencodeActionContext): ResolvedBackend {
  let backend: ResolvedBackend;
  try {
    backend = resolveBackend(loadSettings(ctx.cwd).backend, detectCaller());
  } catch (error: any) {
    throw new Error(`Herd unavailable: ${error?.message ?? error}`);
  }
  if (backend === 'hc') {
    if (!isHcAvailable()) throw new Error(`Herd unavailable: backend "hc" is unreachable. ${HC_SETUP_HINT}`);
  } else if (!isHerdrAvailable()) {
    throw new Error(`Herd requires a running Herdr session.\n${HERDR_SETUP_HINT}`);
  }
  return backend;
}

/**
 * Scope registries to this OpenCode session. Same-session calls are a
 * no-op; a different session rotates the namespace exactly like Pi's
 * session switch.
 */
function bindSession(ctx: OpencodeActionContext): void {
  lifecycleRegistry.beginSession(ctx.sessionId);
  bindSessionOwner(ctx.sessionId);
}

function displayName(agent: string, label: string): string {
  return label ? `${agent}: ${label}` : agent;
}

export async function spawnSheep(
  ctx: OpencodeActionContext,
  opts: { agent: string; label: string; placement?: string; cwd?: string }
): Promise<string> {
  if (opts.placement !== undefined && !(PLACEMENTS as readonly string[]).includes(opts.placement)) {
    throw new Error(
      `Unknown placement "${opts.placement}". Use one of: ${PLACEMENTS.join(', ')}.`
    );
  }
  const backend = backendFor(ctx);
  bindSession(ctx);
  const spawnCwd = opts.cwd ?? ctx.cwd;
  const placement = (opts.placement ?? undefined) as Placement | undefined;
  if (backend === 'hc') {
    const runtime = createHcRuntime({
      cwd: spawnCwd,
      sessionId: ctx.sessionId,
      launch: { ...OPENCODE_LAUNCH_OVERRIDES },
    });
    const id = await runtime.spawn({ name: opts.agent } as any, {
      cwd: spawnCwd,
      label: opts.label,
      placement,
    });
    const handle = describeHcAgent(id);
    return `shepherd_spawn spawned ${displayName(handle.agent, handle.label)}\nagent id: ${handle.id}`;
  }
  const runtime = createHerdrRuntime({
    cwd: spawnCwd,
    sessionId: ctx.sessionId,
    launch: { ...OPENCODE_LAUNCH_OVERRIDES },
  });
  const id = await runtime.spawn({ name: opts.agent } as any, {
    cwd: spawnCwd,
    label: opts.label,
    placement,
  });
  const handle = lifecycleRegistry.getAgent(id).handle;
  return `shepherd_spawn spawned ${displayName(handle.agent, handle.label)}\nagent id: ${handle.id}`;
}

export async function statusSheep(
  ctx: OpencodeActionContext,
  opts: { id: string }
): Promise<string> {
  const backend = backendFor(ctx);
  bindSession(ctx);
  if (backend === 'hc') {
    try {
      drainHcInboxForSession(ctx.sessionId);
    } catch {
      /* reads stay best-effort */
    }
    const view = describeHcStatusView(opts.id);
    const taskNote = view.task ? `; task ${view.task.id} ${view.task.state}` : '';
    return `agent ${view.state}${taskNote}.\nagent id: ${view.handle.id}`;
  }
  const result = statusAgent(opts.id);
  const taskNote = result.task ? `; task ${result.task.id} ${result.task.state}` : '';
  return `agent ${result.state}${taskNote}.\nagent id: ${result.handle.id}`;
}

export async function readSheep(
  ctx: OpencodeActionContext,
  opts: { target: string; lines?: number; source?: string }
): Promise<string> {
  const target = opts.target?.trim();
  if (!target) throw new Error('Provide an agent id, name, or pane target to read.');
  const lines = opts.lines ?? 40;
  const source = opts.source ?? 'recent-unwrapped';
  const backend = backendFor(ctx);
  bindSession(ctx);
  if (backend === 'hc') {
    const agentId = resolveHcAgentId(target);
    if (!agentId) return `Could not read "${target}": unknown hc agent, terminal, or name.`;
    try {
      const runtime = createHcRuntime({ cwd: ctx.cwd, sessionId: ctx.sessionId });
      const tail = await runtime.read(agentId, { lines });
      return (tail as string).trim() || '(no terminal output)';
    } catch (error: any) {
      return `Could not read "${target}": ${error?.message ?? String(error)}`;
    }
  }
  const created = loadCreatedPanes();
  const match = created.find(p => p.paneId === target || p.name === target);
  let resolved = match?.paneId ?? target;
  if (!match) {
    try {
      resolved = lifecycleRegistry.getAgent({ id: target }).handle.paneId ?? target;
    } catch {
      // Keep the original target so Herdr returns the useful not-found error.
    }
  }
  try {
    const { stdout } = await execFileAsync(
      'herdr',
      [
        'agent',
        'read',
        resolved,
        '--source',
        source,
        '--lines',
        String(lines),
        '--format',
        'text',
      ],
      { encoding: 'utf8' }
    );
    return (stdout as string).trim() || '(no terminal output)';
  } catch {
    // Agent detection is dropped once the pane's child exited — fall back
    // to a plain terminal read so finished runs stay inspectable.
    try {
      const { stdout } = await execFileAsync(
        'herdr',
        ['pane', 'read', resolved, '--lines', String(lines), '--format', 'text'],
        { encoding: 'utf8' }
      );
      return (stdout as string).trim() || '(no terminal output)';
    } catch {
      return `Could not read "${target}": Herdr has no such agent or pane.`;
    }
  }
}

export async function closeSheep(
  ctx: OpencodeActionContext,
  opts: { id: string }
): Promise<string> {
  const backend = backendFor(ctx);
  bindSession(ctx);
  const runtime =
    backend === 'hc'
      ? createHcRuntime({ cwd: ctx.cwd, sessionId: ctx.sessionId })
      : createHerdrRuntime({ cwd: ctx.cwd, sessionId: ctx.sessionId });
  await runtime.close(opts.id);
  const identity =
    backend === 'hc'
      ? describeHcAgent(opts.id)
      : (() => {
          const handle = lifecycleRegistry.getAgent(opts.id).handle;
          return { id: handle.id, agent: handle.agent, label: handle.label };
        })();
  const cleared = unseenCompletionLedger.clearForAgent(identity.id);
  const clearedNote =
    cleared.length > 0
      ? `; cleared ${cleared.length} unseen completion(s): ${cleared.join(', ')}`
      : '';
  return `closed ${displayName(identity.agent, identity.label)}${clearedNote}\nagent id: ${identity.id}`;
}

export async function listAgents(
  ctx: OpencodeActionContext,
  opts: { agentScope?: string }
): Promise<string> {
  bindSession(ctx);
  const settings = loadSettings(ctx.cwd);
  const scope = (opts.agentScope ?? settings.agentScope) as 'user' | 'project' | 'both';
  if (!['user', 'project', 'both'].includes(scope)) {
    throw new Error(`Unknown agent scope "${opts.agentScope}". Use one of: user, project, both.`);
  }
  const { agents } = discoverAgents(ctx.cwd, scope, {
    includeBundled: settings.includeBundledAgents,
  });
  if (agents.length === 0) {
    return `No agent definitions found in ${scope} scope. Do not guess an agent name; add a definition or choose another scope.`;
  }
  const lines = agents.map(a => `${a.name} (${a.source}): ${a.description}`);
  return `Available agent names (copy the name exactly; names are case-sensitive):\n${lines.join('\n')}`;
}

export async function listHerd(ctx: OpencodeActionContext): Promise<string> {
  backendFor(ctx);
  bindSession(ctx);
  pruneStaleCreatedPanes();
  const out = herdrExecSync(['agent', 'list']);
  const agents = agentSummaries(out);
  if (agents.length === 0) return 'No agents detected in Herdr.';
  return agents.map(formatSummary).join('\n');
}

export async function pruneRegistrations(ctx: OpencodeActionContext): Promise<string> {
  bindSession(ctx);
  const pruned = pruneStaleCreatedPanes();
  const remaining = loadCreatedPanes().length;
  return pruned === 0
    ? `No stale pi-shepherd panes found (${remaining} registered).`
    : `Removed ${pruned} stale pane registration(s); ${remaining} remain.`;
}
