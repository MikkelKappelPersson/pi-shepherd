#!/usr/bin/env node
// Unit test for the Phase 0.1 caller detector (src/runtimes/detect.ts).
// Matrix: TUI / app / plain / nested (innermost wins) / missing-binary.
// detectCaller() takes injected { env, execOk, fileExists } so no subprocess
// or filesystem is touched; fakes record calls to prove env-first order.
const { detectCaller } = await import('../src/runtimes/detect.ts');

let failures = 0;
function assert(ok, label) {
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}`);
  }
}

// ── fakes ────────────────────────────────────────────────────────────────
function makeExec(okFor = {}) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    return !!okFor[cmd];
  };
  fn.calls = calls;
  return fn;
}

function makeExists(existing = []) {
  const calls = [];
  const fn = p => {
    calls.push(p);
    return existing.includes(p);
  };
  fn.calls = calls;
  return fn;
}

const TUI_ENV = { HERDR_ENV: '1', HERDR_PANE_ID: 'pane-1' };
const APP_ENV = { HC_TERMINAL_ID: 't4', HC_TERMINAL_SOCKET: '/run/hc.sock' };

// ── TUI ──────────────────────────────────────────────────────────────────
{
  const exec = makeExec({ herdr: true });
  const exists = makeExists();
  assert(
    detectCaller({ env: { ...TUI_ENV }, execOk: exec, fileExists: exists }) === 'herdr-tui',
    'TUI env + herdr binary -> herdr-tui'
  );
  assert(exec.calls.join(',') === 'herdr --version', 'TUI probes herdr --version');
  assert(exists.calls.length === 0, 'TUI path never probes the hc socket');
}

// ── app ──────────────────────────────────────────────────────────────────
{
  const exec = makeExec({ hc: true });
  const exists = makeExists(['/run/hc.sock']);
  assert(
    detectCaller({ env: { ...APP_ENV }, execOk: exec, fileExists: exists }) === 'hc-app',
    'HC env + socket + hc binary -> hc-app'
  );
  assert(exec.calls.join(',') === 'hc ls', 'app probes hc ls');
  assert(!exec.calls.some(c => c.startsWith('herdr')), 'app path never probes herdr');
}

// ── plain ────────────────────────────────────────────────────────────────
{
  const exec = makeExec({ herdr: true, hc: true });
  const exists = makeExists(['/run/hc.sock']);
  assert(
    detectCaller({ env: {}, execOk: exec, fileExists: exists }) === 'plain',
    'empty env -> plain'
  );
  assert(exec.calls.length === 0 && exists.calls.length === 0, 'plain probes nothing (env first)');
}

// ── nested: both valid, innermost (hc) wins ───────────────────────────────
{
  const exec = makeExec({ herdr: true, hc: true });
  const exists = makeExists(['/run/hc.sock']);
  assert(
    detectCaller({ env: { ...TUI_ENV, ...APP_ENV }, execOk: exec, fileExists: exists }) ===
      'hc-app',
    'nested TUI+hc both valid -> hc-app (innermost wins)'
  );
}

// ── nested: hc half-signal falls through to herdr ────────────────────────
{
  const exec = makeExec({ herdr: true, hc: true });
  const exists = makeExists([]); // socket missing
  assert(
    detectCaller({ env: { ...TUI_ENV, ...APP_ENV }, execOk: exec, fileExists: exists }) ===
      'herdr-tui',
    'nested hc socket missing -> herdr-tui (no masking)'
  );
}

// ── missing binary ───────────────────────────────────────────────────────
{
  const exec = makeExec({});
  const exists = makeExists(['/run/hc.sock']);
  assert(
    detectCaller({ env: { ...TUI_ENV }, execOk: exec, fileExists: exists }) === 'plain',
    'TUI env + missing herdr binary -> plain'
  );
  assert(
    detectCaller({ env: { ...APP_ENV }, execOk: exec, fileExists: exists }) === 'plain',
    'HC env + missing hc binary -> plain'
  );
  const execNoHc = makeExec({ herdr: true });
  assert(
    detectCaller({ env: { ...APP_ENV }, execOk: execNoHc, fileExists: exists }) === 'plain',
    'HC env + failing hc ls -> plain (no cross-claim by herdr without its env)'
  );
}

// ── strict env gates ─────────────────────────────────────────────────────
{
  const exec = makeExec({ herdr: true, hc: true });
  const exists = makeExists(['/run/hc.sock']);
  assert(
    detectCaller({
      env: { HERDR_ENV: 'true', HERDR_PANE_ID: 'pane-1' },
      execOk: exec,
      fileExists: exists,
    }) === 'plain',
    'HERDR_ENV=true (not "1") -> plain'
  );
  assert(
    detectCaller({ env: { HERDR_ENV: '1' }, execOk: exec, fileExists: exists }) === 'plain',
    'HERDR_ENV without HERDR_PANE_ID -> plain'
  );
  assert(
    detectCaller({
      env: { HC_TERMINAL_ID: 't4' },
      execOk: exec,
      fileExists: exists,
    }) === 'plain',
    'HC_TERMINAL_ID without HC_TERMINAL_SOCKET -> plain'
  );
  assert(
    detectCaller({ env: { ...APP_ENV }, execOk: exec, fileExists: makeExists([]) }) === 'plain',
    'HC env + missing socket file -> plain'
  );
}

// ── live session info (non-asserting; varies by caller) ───────────────────
console.log(`INFO  live detectCaller() in this session -> ${detectCaller()}`);

if (failures) process.exit(1);
console.log('All detect assertions passed.');
