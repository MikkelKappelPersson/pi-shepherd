/**
 * hc runtime — herdr-core terminal integration for pi-shepherd.
 *
 * Shells out to the `hc` CLI (no JS library) and provides the building blocks
 * the hc backend depends on: the availability guard (`isHcAvailable`), the
 * JSON exec bridges (`hcExec` / `hcExecSync`), the created-terminals registry
 * (`recordCreatedTerminal` / `pruneStaleCreatedTerminals`), the launch-script
 * runner (`launchPiInHcTerminal`), and the terminal tail reader
 * (`readHcTerminalTail`).
 *
 * This module mirrors `src/runtimes/herdr/herdr.ts` ownership/launch/read
 * patterns: background terminals, cwd preservation, only-close-what-we-created
 * (registry file beside `created-panes.json`), temp launch-dir lifetime tied
 * to the owned terminal, and never `hc server stop` from a live session.
 *
 * Transport-independent helpers owned by the pane-based backend are reused
 * here (launch-file writer, completion-signal readers, filesystem mailbox)
 * so the two runtimes stay boring and identical where the substrate does not
 * matter. `runtime.ts` imports them through this module and never touches the
 * pane-based backend directly.
 */

import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { hostCapabilities } from '../../core/host.ts';
import { sessionOwner } from '../herdr/orchestration.ts';
import {
  readCompletionSignal,
  readLastAssistantText,
  writePiLaunchFiles,
} from '../herdr/herdr.ts';

// ── Reused transport-independent helpers ───────────────────────────────
// The launch-file writer, the completion-signal readers, and the parent-owned
// filesystem mailbox do not depend on panes or terminals; both backends share
// them so agent launch, completion detection, and `shepherd_done` behave the
// same everywhere. Re-exported here so `runtime.ts` stays free of any
// pane-backend import.
export { readCompletionSignal, readLastAssistantText, writePiLaunchFiles };
export {
  createChildBroker,
  createEnvelope,
  createParentBroker,
  pollParentInbox,
  publishFromParent,
  registerChild,
  unregisterChild,
  type ChildCapability,
  type ParentBroker,
  type ShepherdMessageEnvelope,
} from '../herdr/messaging.ts';

const execFileAsync = promisify(execFile);

export const HC_SETUP_HINT =
  'Run from an `hc` terminal (HC_TERMINAL_ID and HC_TERMINAL_SOCKET set) with `hc` on PATH, or ensure the herdr-core server is reachable.';

/** Structured `hc` failure: the CLI exits 0 with `{ error: { kind, message } }`. */
export class HcError extends Error {
  readonly kind: string;
  readonly hint?: string;
  constructor(kind: string, message: string, hint?: string) {
    super(message);
    this.name = 'HcError';
    this.kind = kind;
    if (hint !== undefined) this.hint = hint;
  }
}

/** Extract a structured `HcError` from raw CLI stdout, if it carries `{ error }`. */
function hcErrorFromStdout(stdout: unknown, context: string): HcError | undefined {
  if (typeof stdout !== 'string' || !stdout.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const err = (parsed as { error?: { kind?: unknown; message?: unknown; hint?: unknown } })?.error;
  if (!err || typeof err !== 'object') return undefined;
  const kind = typeof err.kind === 'string' ? err.kind : 'hc_error';
  const message = typeof err.message === 'string' ? err.message : `hc ${context} failed.`;
  const hint = typeof err.hint === 'string' ? err.hint : undefined;
  return new HcError(kind, `hc ${context} failed: ${message}`, hint);
}

function throwOnHcError(output: unknown, context: string): unknown {
  const err = (output as { error?: { kind?: unknown; message?: unknown; hint?: unknown } })
    ?.error;
  if (err && typeof err === 'object') {
    const kind = typeof err.kind === 'string' ? err.kind : 'hc_error';
    const message = typeof err.message === 'string' ? err.message : `hc ${context} failed.`;
    const hint = typeof err.hint === 'string' ? err.hint : undefined;
    throw new HcError(kind, `hc ${context} failed: ${message}`, hint);
  }
  return output;
}

/** True when the `hc` binary is on PATH. */
export function isHcCliPresent(): boolean {
  try {
    execFileSync('hc', ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the herdr-core server is reachable: the CLI is present and
 * `hc ls` succeeds. Like the pane-based guard, a plain terminal can drive
 * `hc` when the server is up — no HC_* env required here (detection of the
 * caller lives in `src/runtimes/detect.ts`).
 */
export function isHcAvailable(): boolean {
  if (!isHcCliPresent()) return false;
  try {
    throwOnHcError(hcExecSync(['ls', '--json']), 'ls');
    return true;
  } catch {
    return false;
  }
}

/**
 * Run an `hc` subcommand synchronously and parse its JSON output. Callers
 * pass `--json` explicitly (run/read print text even when piped). A response
 * body carrying `{ error }` throws `HcError`.
 */
export function hcExecSync(args: string[]): unknown {
  let stdout: string;
  try {
    stdout = execFileSync('hc', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    const out = typeof error?.stdout === 'string' ? error.stdout : (error?.stdout?.toString?.() ?? '');
    const errOut =
      typeof error?.stderr === 'string' ? error.stderr : (error?.stderr?.toString?.() ?? '');
    const structured =
      hcErrorFromStdout(out, args[0] ?? '') ?? hcErrorFromStdout(errOut, args[0] ?? '');
    if (structured) throw structured;
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(
      `hc ${args[0] ?? ''} failed.${stderr ? ` ${stderr}` : ''}${error?.message ? ` (${error.message})` : ''}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Unexpected non-JSON hc output: ${stdout.slice(0, 200)}`);
  }
  return throwOnHcError(parsed, args[0] ?? '');
}

/** Async `hc` bridge: same JSON contract as `hcExecSync`. */
export async function hcExec(args: string[]): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('hc', args, { encoding: 'utf8' }));
  } catch (error: any) {
    const out = typeof error?.stdout === 'string' ? error.stdout : (error?.stdout?.toString?.() ?? '');
    const errOut =
      typeof error?.stderr === 'string' ? error.stderr : (error?.stderr?.toString?.() ?? '');
    const structured =
      hcErrorFromStdout(out, args[0] ?? '') ?? hcErrorFromStdout(errOut, args[0] ?? '');
    if (structured) throw structured;
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(
      `hc ${args[0] ?? ''} failed.${stderr ? ` ${stderr}` : ''}${error?.message ? ` (${error.message})` : ''}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Unexpected non-JSON hc output: ${String(stdout).slice(0, 200)}`);
  }
  return throwOnHcError(parsed, args[0] ?? '');
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

let cachedPiBinary: string | undefined;

/**
 * Absolute path to the `pi` binary for launch scripts. `hc run` starts
 * through a non-login shell without the user's profile PATH, so the bare
 * `pi` the shared launch script uses would fail with "command not found".
 * Resolved once per process: `which pi`, then the default agent bin dir.
 */export function resolvePiBinary(): string {
  if (cachedPiBinary) return cachedPiBinary;
  try {
    const found = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim().split('\n')[0];
    if (found) {
      cachedPiBinary = found;
      return cachedPiBinary;
    }
  } catch {
    /* fall through to the well-known location */
  }
  const home = process.env.HOME || os.homedir();
  const fallback = path.join(home, '.pi', 'agent', 'bin', 'pi');
  try {
    fs.accessSync(fallback, fs.constants.X_OK);
    cachedPiBinary = fallback;
    return cachedPiBinary;
  } catch {
    /* last resort: keep the bare name and let the failure surface */
  }
  cachedPiBinary = 'pi';
  return cachedPiBinary;
}

/** Extract the terminal address (`t7`) from an `hc run`/`hc get` response. */
export function terminalAddressOf(output: unknown, context: string): string {
  const address = (output as { address?: unknown })?.address;
  if (typeof address !== 'string' || !address) {
    throw new Error(`Unexpected hc ${context} output: ${JSON.stringify(output)}`);
  }
  return address;
}

// ── Owned-terminals registry ────────────────────────────────────────────
// Mirrors the created-panes registry: tracks terminals pi-shepherd created so
// close/prune only ever touch our own terminals (safety invariant: never
// kill terminals we didn't create; never `hc server stop`).

export interface CreatedTerminal {
  terminalId: string;
  name: string;
  cwd: string;
  createdAt: number;
  /** Temp launch dir (if any) to remove when this terminal is closed. */
  dir?: string;
  /** Parent pi session that created this terminal (legacy entries omit it). */
  ownerSession?: string;
}

/** Owner session id of a terminal entry; legacy entries belong to the current session. */
function terminalOwner(entry: CreatedTerminal): string {
  return entry.ownerSession ?? sessionOwner() ?? '';
}

function registryFile(): string {
  // Beside created-panes.json in the active agent dir (~/.pi/agent by
  // default on Pi, overridable via PI_CODING_AGENT_DIR).
  const host = hostCapabilities();
  return path.join(host.getAgentDir(), host.dataDirName, 'created-terminals.json');
}

export function loadCreatedTerminals(): CreatedTerminal[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
    return Array.isArray(parsed) ? (parsed as CreatedTerminal[]) : [];
  } catch {
    return [];
  }
}

function saveCreatedTerminals(terminals: CreatedTerminal[]): void {
  const file = registryFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(terminals, null, 2));
  } catch {
    /* best effort */
  }
}

export function recordCreatedTerminal(entry: CreatedTerminal): void {
  const terminals = loadCreatedTerminals();
  if (!terminals.some(t => t.terminalId === entry.terminalId)) {
    terminals.push(entry);
    saveCreatedTerminals(terminals);
  }
}

export function forgetCreatedTerminal(terminalId: string): void {
  saveCreatedTerminals(loadCreatedTerminals().filter(t => t.terminalId !== terminalId));
}

/** Drop one registry entry only when its recorded owner matches (orphan reap). */
export function forgetOwnedTerminal(terminalId: string, ownerSession?: string): boolean {
  const entry = loadCreatedTerminals().find(t => t.terminalId === terminalId);
  if (!entry || (ownerSession && terminalOwner(entry) !== ownerSession)) return false;
  removeCreatedTerminalDir(terminalId);
  forgetCreatedTerminal(terminalId);
  return true;
}

/**
 * Attach (or overwrite) the temp launch dir for an existing terminal so that
 * close can clean it up. The terminal is recorded early (for orphan safety)
 * but its launch dir is only known once pi is booted, so it is set
 * afterwards.
 */
export function setCreatedTerminalDir(terminalId: string, dir: string): void {
  const terminals = loadCreatedTerminals();
  const entry = terminals.find(t => t.terminalId === terminalId);
  if (!entry) return;
  entry.dir = dir;
  saveCreatedTerminals(terminals);
}

/** Best-effort removal of a terminal's retained temp launch dir. */
export function removeCreatedTerminalDir(terminalId: string): void {
  const entry = loadCreatedTerminals().find(t => t.terminalId === terminalId);
  if (!entry?.dir) return;
  try {
    fs.rmSync(entry.dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * True when herdr-core still lists a terminal with this id. Returns true when
 * the check itself fails — safer to never prune a terminal we can't confirm
 * is gone.
 */
export function terminalExists(terminalId: string): boolean {
  try {
    const out = hcExecSync(['get', terminalId, '--json']) as any;
    return typeof out?.address === 'string';
  } catch (error) {
    // A removed/unknown terminal reports kind not_found; anything else (a
    // failed probe) must not prune.
    if (error instanceof HcError) return error.kind !== 'not_found';
    return true;
  }
}

/**
 * Drop created-terminal registrations whose terminal is gone (and remove
 * finished strays we own, then clean their retained temp launch dirs).
 * Returns how many stale entries were pruned.
 */
export function pruneStaleCreatedTerminals(): number {
  const terminals = loadCreatedTerminals();
  if (terminals.length === 0) return 0;
  const stale: CreatedTerminal[] = [];
  for (const entry of terminals) {
    let state: string | undefined;
    try {
      const out = hcExecSync(['get', entry.terminalId, '--json']) as any;
      state = typeof out?.state === 'string' ? out.state : undefined;
    } catch (error) {
      if (error instanceof HcError && error.kind === 'not_found') {
        stale.push(entry);
        continue;
      }
      continue; // ambiguous probe failure: keep the entry
    }
    if (state !== undefined && state !== 'live') {
      try {
        hcExecSync(['rm', entry.terminalId, '--json']);
      } catch {
        /* best effort; the registry entry is still dropped */
      }
      stale.push(entry);
    }
  }
  if (stale.length === 0) return 0;
  for (const entry of stale) removeCreatedTerminalDir(entry.terminalId);
  saveCreatedTerminals(terminals.filter(t => !stale.includes(t)));
  return stale.length;
}

/**
 * True when a created-terminal entry was spawned by THIS parent session (or is
 * a legacy entry without an owner marker, attributed to the current session).
 */
export function terminalOwnedByCurrentSession(entry: CreatedTerminal): boolean {
  return terminalOwner(entry) === sessionOwner();
}

// ── hc-backed agent terminal lifecycle ───────────────────────────────────

/**
 * Boot pi in a fresh background `hc` terminal from the shared launch files.
 * The temp dir is intentionally RETAINED while the terminal's pi is alive —
 * removing it would make the still-running pi hit ENOENT on its own session
 * file (same invariant as the pane-based backend).
 *
 * Flags: `--bg` (return at once), `--no-notify` (don't type spawn notes into
 * the parent terminal), `--outlive-parent` (sheep outlive the parent like
 * panes do). `--keep` is deliberately NOT passed: a crashed pi must surface
 * as a finished terminal (fast failure) instead of being replaced by a
 * shell that masks the exit.
 */
export function launchPiInHcTerminal(
  name: string,
  opts: Parameters<typeof writePiLaunchFiles>[0] & { cwd: string; label?: string }
): { terminalId: string; dir: string; sessionFile: string; scriptFile: string } {
  const { cwd, label: _label, ...launchOpts } = opts;
  void _label;
  const files = writePiLaunchFiles(launchOpts);
  // Point the shared launch script at the absolute pi binary (see
  // resolvePiBinary): the file itself is owned by the pane-based backend
  // and stays untouched.
  try {
    const script = fs.readFileSync(files.scriptFile, 'utf8');
    const patched = script.replace(/\npi /, `\n${shellQuote(resolvePiBinary())} `);
    if (patched !== script) fs.writeFileSync(files.scriptFile, patched);
  } catch {
    /* best effort; a bare `pi` may still resolve */
  }
  const sanitizedAgent = name.replace(/[^a-z0-9-_]/gi, '-').slice(0, 20) || 'agent';
  let terminalId: string;
  try {
    const out = hcExecSync([
      'run',
      '--bg',
      '--json',
      '--cwd',
      cwd,
      '--label',
      'shepherd.owned=true',
      '--label',
      `shepherd.agent=${sanitizedAgent}`,
      '--no-notify',
      '--outlive-parent',
      'bash',
      files.scriptFile,
    ]);
    terminalId = terminalAddressOf(out, 'run');
  } catch (error) {
    try {
      fs.rmSync(files.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    throw error;
  }
  try {
    hcExecSync(['label', terminalId, `shepherd.name=${sanitizedAgent}`, '--json']);
  } catch {
    /* cosmetic */
  }
  recordCreatedTerminal({
    terminalId,
    name,
    cwd,
    createdAt: Date.now(),
    ownerSession: sessionOwner(),
  });
  setCreatedTerminalDir(terminalId, files.dir);
  return { terminalId, ...files };
}

/**
 * Poll until herdr-core reports the terminal's agent (or timeout). Used as
 * the post-spawn readiness check: `hc get` shows `status.app === "pi"` once
 * the booted pi registers. A terminal that finishes before registering
 * resolves immediately with its exit code so the caller can surface the tail
 * instead of waiting out the full timeout.
 */
export async function waitForHcAgentDetected(
  terminalId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ detected: boolean; state?: string; exitCode?: number }> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let state: string | undefined;
  while (Date.now() <= deadline) {
    let rec: any;
    try {
      rec = await hcExec(['get', terminalId, '--json']);
    } catch (error) {
      if (error instanceof HcError && error.kind === 'not_found') {
        return { detected: false, state: 'removed' };
      }
      if (Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }
    const app = (rec as any)?.status?.app;
    state =
      typeof (rec as any)?.status?.state === 'string'
        ? (rec as any).status.state
        : typeof (rec as any)?.state === 'string'
          ? (rec as any).state
          : undefined;
    if (typeof app === 'string' && app.length > 0) return { detected: true, state };
    if ((rec as any)?.state === 'finished') {
      const exitCode =
        typeof (rec as any)?.exit_code === 'number' ? (rec as any).exit_code : undefined;
      return { detected: false, state: 'exited', ...(exitCode !== undefined ? { exitCode } : {}) };
    }
    if (Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { detected: false, state };
}

/** Tail human-readable output for an owned terminal (fixed fetch, sliced by the caller). */
export async function readHcTerminalTail(terminalId: string, lines = 120): Promise<string> {
  try {
    const out = (await hcExec(['read', terminalId, '--lines', String(lines), '--json'])) as any;
    return typeof out?.text === 'string' ? out.text : '';
  } catch {
    return '';
  }
}

/** Best-effort kill-then-remove for an owned terminal. */
export function killHcTerminal(terminalId: string): void {
  try {
    hcExecSync(['kill', terminalId, '--json']);
  } catch {
    /* already finished or kill raced; rm below still applies */
  }
  try {
    hcExecSync(['rm', terminalId, '--json']);
  } catch {
    /* best effort */
  }
}
