// verify-cli.mjs
//
// The CLI grammar in cli.ts is the shared contract between the human
// `/shepherd` command (parse) and the tool-call previews (format). It must:
//   - parse every command action into doAction args,
//   - reject bad input with a usage hint,
//   - round-trip: render(parse(x)) parses back to the same args
//     (the renderer and parser share one OPTION_SPECS table).
// (see docs/plan-tool-surface-split.md §4).
import { parseShepherdCli, formatShepherdCommand, statusHandleTarget, tokenizeCli } from '../src/extension/cli.ts';
import { lifecycleRegistry } from '../src/core/orchestration.ts';

let failures = 0;
function check(ok, label) {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
	if (!ok) failures++;
}
function isError(result) {
	return typeof result === 'object' && result !== null && 'error' in result;
}

// Parse -> doAction args (action + the parsed payload).
function parsed(toks) {
	const p = parseShepherdCli(toks);
	if (isError(p)) return { error: p.error };
	return { args: p.args, action: p.action };
}

// ── Positive parses ─────────────────────────────────────────────────────────

const a = parsed(['agents']);
check(!isError(a) && a.args.agentScope === undefined, "agents: no scope");
check(parsed(['agents', 'both']).args.agentScope === 'both', "agents both: positional scope");
check(parsed(['agents', '--scope', 'project']).args.agentScope === 'project', "agents --scope: flag scope");

const okHerd = parsed(['herd']);
check(!isError(okHerd) && JSON.stringify(okHerd.args) === JSON.stringify({ action: 'herd' }), 'herd: bare');

const okSpawn = parsed(['spawn', 'worker']);
check(!isError(okSpawn) && okSpawn.args.agent === 'worker' && okSpawn.action === 'spawn', 'spawn worker: agent name');

const okSpawnFlags = parsed(['spawn', 'worker', '--placement=pane_down', '--label=down-split']);
check(
	okSpawnFlags.args.placement === 'pane_down' && okSpawnFlags.args.label === 'down-split' &&
		!('direction' in okSpawnFlags.args),
	'spawn: placement encodes pane direction',
);

const okSpawnSpace = parsed(['spawn', 'scout', '--cwd', '/tmp/x', '--model', 'openai/gpt-x']);
check(
	okSpawnSpace.args.cwd === '/tmp/x' && okSpawnSpace.args.model === 'openai/gpt-x' &&
		!('agentScope' in okSpawnSpace.args),
	'spawn: optional cwd and model values',
);

okReadChecks();
function okReadChecks() {
	const okRead = parsed(['read', 'pane123', '--lines=10', '--source=recent']);
	check(okRead.args.name === 'pane123' && okRead.args.lines === 10 && okRead.args.source === 'recent',
		'read: name + integer lines + source enum');
	const okReadSpace = parsed(['read', 'p5', '--lines', '7', '--source', 'visible']);
	check(okReadSpace.args.lines === 7 && okReadSpace.args.source === 'visible', 'read: space-separated options');
}

const okStatus = parsed(['status', 'worker']);
check(!isError(okStatus) && okStatus.args.id === 'worker',
	'status: unknown target degrades to opaque id');

// statusHandleTarget resolves a live agent by name or pane id.
const liveAgent = lifecycleRegistry.registerAgent({ agent: 'live-scout', paneId: 'wT:p1' });
check(
	statusHandleTarget('live-scout') === liveAgent.id,
	'status target resolves live agent by name',
);
check(statusHandleTarget('wT:p1') === liveAgent.id, 'status target resolves live agent by pane id');

// ── Negative parses ─────────────────────────────────────────────────────────

const shouldFail = [
	[['spawn'], 'spawn requires an agent name'],
	[['spawn', 'a', 'b'], 'Unexpected argument "b"'],
	[['herd', 'x'], 'herd takes no arguments'],
	[['agents', 'both', 'user'], 'agents takes at most one'],
	[['agents', 'both', '--scope=user'], 'agents takes at most one'],
	[['spawn', 'w', '--placement=up'], 'Invalid value "up" for --placement'],
	[['spawn', 'w', '--direction=down'], 'Unknown option "--direction"'],
	[['spawn', 'w', '--scope=project'], 'Unknown option "--scope"'],
	[['spawn', 'w', '--confirm-project-agents=false'], 'Unknown option "--confirm-project-agents"'],
	[['spawn', 'w', '--omit-system-prompt'], 'Unknown option "--omit-system-prompt"'],
	[['spawn', 'w', '--bogus=1'], 'Unknown option "--bogus"'],
	[['read', 'p', '--scope=user'], 'Unknown option "--scope"'], // spawn flag not allowed for read
	[['read', 'p', '--lines=abc'], 'must be an integer'],
	[['read', 'p', '--source=bogus'], 'Invalid value "bogus" for --source'],
	[['wat'], 'Unknown action'],
	[[], 'Provide an action'],
	[['status'], 'status requires'],
	[['status', 'a', 'b'], 'takes exactly one'],
	[['spawn', 'w', '--cwd'], 'Missing value for --cwd'],
];
for (const [toks, hint] of shouldFail) {
	const p = parsed(toks);
	const pass = isError(p) && p.error.includes(hint) && p.error.includes('Usage');
	check(pass, `rejects ${JSON.stringify(toks)}${p.error ? '' : '  (parsed: ' + JSON.stringify(p.args) + ')'}`);
}

// ── Round-trip: parse(x) → render → tokenize → reparse → same args ─────────

// tokenizeCli is the exact inverse of formatShepherdCommand's quoting: quoted
// values are decoded and rejoined onto their `--flag=` prefix, so a rendered
// line reparses to the same args.
function tokenizePreview(rest) {
	return tokenizeCli(rest);
}

function roundTrip(toks) {
	const p = parsed(toks);
	if (isError(p)) return `parse error unexpectedly: ${p.error}`;
	const fmt = formatShepherdCommand(p.action, p.args);
	const reparsed = parseShepherdCli([p.action, ...tokenizePreview(fmt.rest)]);
	if (isError(reparsed)) return `reparse error: ${reparsed.error}`;
	const drop = (o) => {
		const copy = { ...o };
		// Key insertion order can differ between the parsed line and the
		// rendered one (positional vs. --scope spellings); compare canonically.
		return Object.fromEntries(Object.entries(copy).sort(([a], [b]) => a.localeCompare(b)));
	};
	return p.action === reparsed.action && JSON.stringify(drop(p.args)) === JSON.stringify(drop(reparsed.args))
		? null
		: `mismatch: ${JSON.stringify(p.args)} vs ${JSON.stringify(reparsed.args)}`;
}
for (const toks of [
	['agents'],
	['agents', 'project'],
	['herd'],
	['spawn', 'worker'],
	['spawn', 'worker', '--placement=pane_down'],
	['spawn', 'scout', '--cwd=/a b', '--model=openai/gpt-x'],
	['read', 'p5', '--lines=7', '--source=visible'],
]) {
	const err = roundTrip(toks);
	check(err === null, `round-trip ${toks.join(' ')}${err ? ` — ${err}` : ''}`);
}

// The spawn preview is CLI-style: `spawn scout --cwd=/a b` (quoted if needed).
const preview = formatShepherdCommand('spawn', { agent: 'scout', cwd: '/a b' });
check(
	preview.verb === 'spawn' && preview.rest.includes('scout') && preview.rest.includes('--cwd="') &&
		!preview.rest.includes('--scope') && !preview.rest.includes('--direction'),
	'preview: spawn renders verb + positional + quoted --cwd',
);

const defaultsPreview = formatShepherdCommand('spawn', {
	agent: 'scout',
	label: '10-second required-args smoke test',
	placement: 'tab',
	cwd: process.cwd(),
	model: 'default',
});
check(
	defaultsPreview.rest === 'scout --label="10-second required-args smoke test"',
	'preview: spawn omits materialized default placement, cwd, and model',
);

if (failures > 0) {
	console.log(`\n${failures} CLI assertion(s) failed.`);
	process.exit(1);
}
console.log('\nAll CLI grammar assertions passed.');
