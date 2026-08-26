/**
 * Shared CLI grammar for pi-shepherd.
 *
 * One options table defines how a shepherd command is spelled as a line of
 * flags and positionals:
 *   - `parseShepherdCli` turns `/shepherd …` tokens into doAction args
 *     (the human command surface),
 *   - `formatShepherdCommand` renders doAction args back into the compact
 *     CLI-style text used by tool-call previews (the model surface).
 *
 * The two are the inverse of each other: they read and write the same
 * `OPTION_SPECS` table, so a rendered line always parses back to the same
 * args.
 */

import { lifecycleRegistry } from '../core/orchestration.ts';

export const SCOPE_VALUES = ['user', 'project', 'both'] as const;
export const PLACEMENT_VALUES = ['pane', 'tab', 'workspace'] as const;
export const DIRECTION_VALUES = ['right', 'down'] as const;
export const SOURCE_VALUES = ['visible', 'recent', 'recent-unwrapped', 'detection'] as const;

interface OptionSpec {
  /** Canonical CLI flag name (without `--`). */
  flag: string;
  /** Extra accepted spellings (e.g. `agentScope` is also `--agent-scope`). */
  aliases?: string[];
  /** doAction args key. */
  key: string;
  /** Restricted value set (validated, and used in error hints). */
  values?: readonly string[];
  /** Value must be an integer (coerced from string). */
  integer?: boolean;
  /** Value must be `true`/`false` (coerced to boolean). */
  boolean?: boolean;
  /** Bare flag: no value, always sets true. */
  bare?: boolean;
}

const OPTION_SPECS: Record<string, OptionSpec> = {
  agentScope: { flag: 'scope', aliases: ['agent-scope'], key: 'agentScope', values: SCOPE_VALUES },
  placement: { flag: 'placement', key: 'placement', values: PLACEMENT_VALUES },
  direction: { flag: 'direction', key: 'direction', values: DIRECTION_VALUES },
  confirmProjectAgents: { flag: 'confirm-project-agents', key: 'confirmProjectAgents', boolean: true },
  cwd: { flag: 'cwd', key: 'cwd' },
  model: { flag: 'model', key: 'model' },
  omitSystemPrompt: { flag: 'omit-system-prompt', key: 'omitSystemPrompt', bare: true },
  lines: { flag: 'lines', key: 'lines', integer: true },
  source: { flag: 'source', key: 'source', values: SOURCE_VALUES },
  timeout: { flag: 'timeout', key: 'timeout', integer: true },
};

const FLAG_LOOKUP = new Map<string, OptionSpec>();
for (const spec of Object.values(OPTION_SPECS)) {
  FLAG_LOOKUP.set(spec.flag, spec);
  for (const alias of spec.aliases ?? []) FLAG_LOOKUP.set(alias, spec);
}

// Which option keys each command verb accepts (renderer and parser agree).
const SPAWN_OPTION_KEYS = ['agentScope', 'placement', 'direction', 'confirmProjectAgents', 'cwd', 'model', 'omitSystemPrompt'];
const READ_OPTION_KEYS = ['lines', 'source'];

const USAGE =
  'Usage: /shepherd <agents [user|project|both] | herd | spawn <agent> [options] | status <agent|id> | read <target> [options] | settings>\n' +
  '  spawn options: --scope user|project|both, --placement pane|tab|workspace, --direction right|down, --cwd <path>, --model <provider/model>, --omit-system-prompt, --confirm-project-agents true|false\n' +
  '  read options: --lines <n>, --source ' + SOURCE_VALUES.join('|');

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Split a command line into tokens. The inverse of `formatShepherdCommand`'s
 * CLI quoting: whitespace separates tokens, and a `"` starts a quoted run that
 * is decoded as a JSON string (so `--cwd="/a b"` re-parses to the value `/a b`).
 * A quoted run may appear mid-token (e.g. immediately after `--cwd=`), so its
 * decoded value is appended to the surrounding token. Because `cliValue` wraps
 * values via `JSON.stringify`, every quoted run is a valid JSON string literal.
 */
export function tokenizeCli(input: string): string[] {
	const tokens: string[] = [];
	let cur = '';
	let i = 0;
	const push = () => {
		if (cur !== '') tokens.push(cur);
		cur = '';
	};
	while (i < input.length) {
		const c = input[i];
		if (c === '"') {
			// Capture one JSON string literal and decode it, appending to `cur`
			// so `--cwd=<quoted>` keeps the flag prefix attached.
			let j = i + 1;
			let body = '';
			while (j < input.length) {
				if (input[j] === '\\') {
					body += input[j] + (input[j + 1] ?? '');
					j += 2;
					continue;
				}
				if (input[j] === '"') break;
				body += input[j];
				j++;
			}
			try {
				cur += JSON.parse('"' + body + '"');
			} catch {
				cur += body; // malformed quote — keep the raw run rather than crashing
			}
			i = j + 1;
			continue;
		}
		if (c === ' ' || c === '\t') {
			push();
			i++;
			continue;
		}
		cur += c;
		i++;
	}
	push();
	return tokens;
}

export type ParsedShepherdCommand =
  | { action: 'agents'; args: Record<string, unknown> }
  | { action: 'herd'; args: Record<string, unknown> }
  | { action: 'spawn'; args: Record<string, unknown> }
  | { action: 'status'; args: Record<string, unknown> }
  | { action: 'read'; args: Record<string, unknown> };

export type ParseShepherdCliResult = ParsedShepherdCommand | { error: string };

/**
 * Parse `--flag value` / `--flag=value` / bare flags tokens into an options
 * object using the shared table. Non-`--` tokens are collected into
 * `positional` (the caller decides how many are allowed).
 */
function parseFlags(
  tokens: string[],
  from: number,
  allowed: readonly string[],
  positional: string[]
): { options: Record<string, unknown>; error?: string } {
  const allowedSet = new Set(allowed);
  const options: Record<string, unknown> = {};
  for (let i = from; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const flag = (eq >= 0 ? token.slice(0, eq) : token).replace(/^--/, '');
    const spec = FLAG_LOOKUP.get(flag);
    if (!spec || !allowedSet.has(spec.key)) return { options, error: `Unknown option "--${flag}".` };
    if (spec.bare) {
      if (eq >= 0) return { options, error: `Option --${spec.flag} takes no value.` };
      options[spec.key] = true;
      continue;
    }
    const raw = eq >= 0 ? token.slice(eq + 1) : tokens[++i];
    if (raw === undefined || raw === '' || raw.startsWith('--'))
      return { options, error: `Missing value for --${spec.flag}.` };
    if (spec.values && !spec.values.includes(raw))
      return { options, error: `Invalid value "${raw}" for --${spec.flag}; use ${spec.values.join(', ')}.` };
    if (spec.integer) {
      if (!/^-?\d+$/.test(raw)) return { options, error: `Value "${raw}" for --${spec.flag} must be an integer.` };
      options[spec.key] = Number(raw);
    } else if (spec.boolean) {
      if (raw !== 'true' && raw !== 'false')
        return { options, error: `Value "${raw}" for --${spec.flag} must be true or false.` };
      options[spec.key] = raw === 'true';
    } else {
      options[spec.key] = raw;
    }
  }
  return { options };
}

/**
 * Resolve a human status target (agent name, lifecycle id, or pane id) to the
 * opaque lifecycle id the status action uses. Falls back to the supplied value
 * so the registry can return its useful unknown-id error.
 */
export function statusHandleTarget(target: string): string {
  for (const handle of lifecycleRegistry.allAgents()) {
    if (handle.id === target || handle.agent === target || handle.paneId === target) {
      return handle.id;
    }
  }
  return target;
}

/**
 * Parse the tokens of a `/shepherd` invocation into doAction args.
 * `settings` is command-only and handled by the caller before parsing.
 */
export function parseShepherdCli(tokens: string[]): ParseShepherdCliResult {
  const action = tokens[0] ?? '';

  if (action === 'herd') {
    if (tokens.length > 1) return { error: `/shepherd herd takes no arguments.\n${USAGE}` };
    return { action: 'herd', args: { action: 'herd' } };
  }

  if (action === 'agents') {
    // Scope may be a positional (`agents both`) or a flag (`agents --scope both`).
    const positional: string[] = [];
    const { options, error } = parseFlags(tokens, 1, ['agentScope'], positional);
    if (error) return { error: `${error}\n${USAGE}` };
    const positionalScope = positional[0];
    if (positional.length > 1 || (positionalScope && 'agentScope' in options))
      return { error: `/shepherd agents takes at most one scope argument (positional or --scope).\n${USAGE}` };
    const scope = positionalScope ?? (options.agentScope as string | undefined);
    if (scope && !SCOPE_VALUES.includes(scope as 'user'))
      return { error: `Invalid scope "${scope}"; use ${SCOPE_VALUES.join(', ')}.` };
    return {
      action: 'agents',
      args: { action: 'agents', ...(scope ? { agentScope: scope } : {}) },
    };
  }

  if (action === 'spawn') {
    const positional: string[] = [];
    const { options, error } = parseFlags(tokens, 1, SPAWN_OPTION_KEYS, positional);
    if (error) return { error: `${error}\n${USAGE}` };
    const [agent, ...extra] = positional;
    if (!agent) return { error: `spawn requires an agent name.\n${USAGE}` };
    if (extra.length > 0) return { error: `Unexpected argument "${extra[0]}".\n${USAGE}` };
    return { action: 'spawn', args: { action: 'spawn', agent, ...options } };
  }

  if (action === 'status') {
    if (tokens.length > 2) return { error: `/shepherd status takes exactly one target.\n${USAGE}` };
    const target = tokens[1];
    if (!target) return { error: `status requires an agent name or lifecycle id.\n${USAGE}` };
    return { action: 'status', args: { action: 'status', id: statusHandleTarget(target) } };
  }

  if (action === 'read') {
    const positional: string[] = [];
    const { options, error } = parseFlags(tokens, 1, READ_OPTION_KEYS, positional);
    if (error) return { error: `${error}\n${USAGE}` };
    const [name, ...extra] = positional;
    if (!name) return { error: `read requires a target (agent name, pane id, or lifecycle id).\n${USAGE}` };
    if (extra.length > 0) return { error: `Unexpected argument "${extra[0]}".\n${USAGE}` };
    return { action: 'read', args: { action: 'read', name, ...options } };
  }

  if (tokens.length === 0)
    return { error: `Provide an action. Try: agents, herd, spawn <agent>, status <target>, read <target>, or settings.\n${USAGE}` };
  return {
    error: `Unknown action "${action}". Try: agents, herd, spawn <agent>, status <target>, read <target>, or settings.\n${USAGE}`,
  };
}

// ── Rendering (inverse of the parser) ───────────────────────────────────────

/** Keep tool-call previews compact without rendering an empty placeholder. */
function previewText(value: unknown, maxLength = 40): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** Render opaque lifecycle ids as compact CLI-like values. */
function handlePreview(value: unknown, maxLength = 40): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => handlePreview(item, maxLength)).join(', ')}]`;
  }

  if (value && typeof value === 'object' && 'id' in value) {
    return previewText((value as { id?: unknown }).id, maxLength);
  }

  // A few providers serialize nested legacy handle arguments before they reach the
  // renderer. Keep the display useful even though prepareArguments normalizes
  // them before execution.
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return handlePreview(parsed, maxLength);
    } catch {
      // It may simply be an id, so fall through.
    }
  }

  return previewText(value, maxLength);
}

/** Quote values that would otherwise be ambiguous in a command-like preview. */
function cliValue(value: unknown, maxLength = 80): string {
  const text = previewText(value, maxLength);
  return /[\s"'=]/.test(text) ? JSON.stringify(text) : text;
}

function cliOption(key: string, value: unknown, maxLength = 80): string {
  if (value === undefined || value === null) return '';
  const spec = OPTION_SPECS[key];
  // Bare flags render without a value; `false` cannot be expressed as a bare
  // flag, so it is omitted (the schema default applies).
  if (spec.bare) return value ? `--${spec.flag}` : '';
  // Booleans render as `--flag=true|false` so the parser round-trips them.
  const text = typeof value === 'boolean' ? String(value) : cliValue(value, maxLength);
  return `--${spec.flag}=${text}`;
}

export interface ShepherdCommandRender {
  verb: string;
  /** Positional args + options as `x y --flag=v …` (no leading verb/space). */
  rest: string;
}

/**
 * Render doAction args into the compact CLI-style line the tool-call preview
 * shows. Flags come from the shared OPTION_SPECS table so every rendered line
 * parses back with `parseShepherdCli`. Defaults that were not supplied are
 * intentionally omitted, which keeps options like --scope visible without
 * dumping internal implementation details (paneId, tabId, workspaceId).
 */
export function formatShepherdCommand(
  verb: string,
  options: Record<string, any>,
  expanded = false
): ShepherdCommandRender {
  const valueLimit = expanded ? Number.POSITIVE_INFINITY : 80;
  const idLimit = expanded ? Number.POSITIVE_INFINITY : 48;
  const tokens: string[] = [];
  const add = (key: string) => {
    const option = cliOption(key, options[key], valueLimit);
    if (option) tokens.push(option);
  };

  switch (verb) {
    case 'spawn':
      tokens.push(cliValue(options.agent, valueLimit));
      for (const key of SPAWN_OPTION_KEYS) add(key);
      break;
    case 'prompt':
      tokens.push(handlePreview(options.id, idLimit));
      if (options.message !== undefined) tokens.push(cliValue(options.message, valueLimit));
      add('timeout');
      break;
    case 'wait':
      tokens.push(handlePreview(options.id, idLimit));
      add('timeout');
      break;
    case 'status':
    case 'close':
      tokens.push(handlePreview(options.id, idLimit));
      break;
    case 'agents':
      add('agentScope');
      break;
    case 'read':
      tokens.push(cliValue(options.name, valueLimit));
      for (const key of READ_OPTION_KEYS) add(key);
      break;
  }

  return { verb, rest: tokens.join(' ') };
}
