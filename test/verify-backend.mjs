#!/usr/bin/env node
// Unit test for the Phase 0.2 backend resolver (src/runtimes/backend.ts).
// Covers: pin wins over caller, caller mapping (herdr-tui->herdr,
// hc-app->hc, plain->reachable-or-error), pinned-but-unreachable throws
// with setup hint and no fallback, plain-unreachable throws with both hints,
// throwing probes are safe, errors never leak pane/terminal ids or sockets.
import { DEFAULT_SETTINGS } from '../src/core/config.ts';
import {
  HC_SETUP_HINT,
  HERDR_SETUP_HINT_FALLBACK,
  resolveBackend,
} from '../src/runtimes/backend.ts';
import { detectCaller } from '../src/runtimes/detect.ts';

let failures = 0;
function assert(ok, label) {
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}`);
  }
}

function throws(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

const alwaysTrue = () => true;
const alwaysFalse = () => false;
const throwing = () => {
  throw new Error('probe boom');
};

function callsProbe(ret) {
  const wrapped = () => {
    wrapped.calls++;
    return ret;
  };
  wrapped.calls = 0;
  return wrapped;
}

// ── default ──────────────────────────────────────────────────────────────
assert(DEFAULT_SETTINGS.backend === 'auto', 'DEFAULT_SETTINGS.backend is auto');

// ── pin wins over caller ─────────────────────────────────────────────────
{
  const hcProbe = callsProbe(true);
  const out = resolveBackend('herdr', 'hc-app', {
    isHerdrReachable: alwaysTrue,
    isHcReachable: hcProbe,
  });
  assert(out === 'herdr', 'pin herdr wins over hc-app caller -> herdr');
  assert(hcProbe.calls === 0, 'pin herdr never probes hc (no fallback check)');
}
{
  const herdrProbe = callsProbe(true);
  const out = resolveBackend('hc', 'herdr-tui', {
    isHerdrReachable: herdrProbe,
    isHcReachable: alwaysTrue,
  });
  assert(out === 'hc', 'pin hc wins over herdr-tui caller -> hc');
  assert(herdrProbe.calls === 0, 'pin hc never probes herdr (no fallback check)');
}

// ── pinned-but-unreachable: clean refusal, no fallback ───────────────────
{
  const err = throws(() =>
    resolveBackend('herdr', 'herdr-tui', {
      isHerdrReachable: alwaysFalse,
      isHcReachable: alwaysTrue, // reachable other backend must NOT be used
    })
  );
  assert(err !== null, 'pin herdr unreachable throws (even when hc reachable)');
  assert(
    err && err.message.includes(HERDR_SETUP_HINT_FALLBACK),
    'pin herdr error names herdr setup hint'
  );
  assert(err && /no fallback/i.test(err.message), 'pin herdr error states no fallback');
  assert(err && err.message.includes('"auto"'), 'pin herdr error points back to auto');
}
{
  const err = throws(() =>
    resolveBackend('hc', 'hc-app', {
      isHerdrReachable: alwaysTrue, // reachable other backend must NOT be used
      isHcReachable: alwaysFalse,
    })
  );
  assert(err !== null, 'pin hc unreachable throws (even when herdr reachable)');
  assert(err && err.message.includes(HC_SETUP_HINT), 'pin hc error names hc setup hint');
  assert(err && /no fallback/i.test(err.message), 'pin hc error states no fallback');
  assert(err && err.message.includes('"auto"'), 'pin hc error points back to auto');
}
{
  // Throwing probes are treated as unreachable, not a crash.
  const errHerdr = throws(() =>
    resolveBackend('herdr', 'plain', {
      isHerdrReachable: throwing,
      isHcReachable: alwaysTrue,
    })
  );
  assert(errHerdr !== null, 'pin herdr with throwing probe still throws cleanly');
  const errHc = throws(() =>
    resolveBackend('hc', 'plain', {
      isHerdrReachable: alwaysTrue,
      isHcReachable: throwing,
    })
  );
  assert(errHc !== null, 'pin hc with throwing probe still throws cleanly');
}

// ── auto: run where called from (no reachability gate) ───────────────────
{
  const out = resolveBackend('auto', 'herdr-tui', {
    isHerdrReachable: alwaysFalse,
    isHcReachable: alwaysFalse,
  });
  assert(out === 'herdr', 'auto + herdr-tui -> herdr (no reachability gate)');
}
{
  const out = resolveBackend('auto', 'hc-app', {
    isHerdrReachable: alwaysFalse,
    isHcReachable: alwaysFalse,
  });
  assert(out === 'hc', 'auto + hc-app -> hc (no reachability gate)');
}
{
  // Caller-mapped auto must not probe at all.
  let probed = false;
  const mark = () => {
    probed = true;
    return true;
  };
  const out = resolveBackend('auto', 'herdr-tui', {
    isHerdrReachable: mark,
    isHcReachable: mark,
  });
  assert(out === 'herdr' && probed === false, 'auto + caller mapping probes nothing');
}

// ── auto + plain: prefer herdr, else hc, else both hints ──────────────────
{
  const out = resolveBackend('auto', 'plain', {
    isHerdrReachable: alwaysTrue,
    isHcReachable: alwaysTrue,
  });
  assert(out === 'herdr', 'auto + plain + both reachable -> herdr first');
}
{
  const order = [];
  const out = resolveBackend('auto', 'plain', {
    isHerdrReachable: () => {
      order.push('herdr');
      return false;
    },
    isHcReachable: () => {
      order.push('hc');
      return true;
    },
  });
  assert(out === 'hc', 'auto + plain + only hc reachable -> hc');
  assert(order.join(',') === 'herdr,hc', 'plain probes herdr before hc');
}
{
  const err = throws(() =>
    resolveBackend('auto', 'plain', {
      isHerdrReachable: alwaysFalse,
      isHcReachable: alwaysFalse,
    })
  );
  assert(err !== null, 'auto + plain + none reachable throws');
  assert(
    err && err.message.includes(HERDR_SETUP_HINT_FALLBACK),
    'plain error names herdr hint'
  );
  assert(err && err.message.includes(HC_SETUP_HINT), 'plain error names hc hint');
}
{
  const err = throws(() =>
    resolveBackend('auto', 'plain', {
      isHerdrReachable: throwing,
      isHcReachable: throwing,
    })
  );
  assert(err !== null, 'plain with throwing probes throws cleanly (no crash)');
}

// ── never returns auto, never leaks ids/sockets ──────────────────────────
{
  const results = [
    resolveBackend('herdr', 'plain', {
      isHerdrReachable: alwaysTrue,
      isHcReachable: alwaysFalse,
    }),
    resolveBackend('hc', 'plain', {
      isHerdrReachable: alwaysFalse,
      isHcReachable: alwaysTrue,
    }),
    resolveBackend('auto', 'herdr-tui', {
      isHerdrReachable: alwaysFalse,
      isHcReachable: alwaysFalse,
    }),
    resolveBackend('auto', 'hc-app', {
      isHerdrReachable: alwaysFalse,
      isHcReachable: alwaysFalse,
    }),
    resolveBackend('auto', 'plain', {
      isHerdrReachable: alwaysTrue,
      isHcReachable: alwaysFalse,
    }),
  ];
  assert(
    results.every(r => r === 'herdr' || r === 'hc'),
    'resolveBackend never returns auto'
  );
}
{
  const errs = [
    throws(() =>
      resolveBackend('herdr', 'plain', {
        isHerdrReachable: alwaysFalse,
        isHcReachable: alwaysTrue,
      })
    ),
    throws(() =>
      resolveBackend('hc', 'plain', {
        isHerdrReachable: alwaysTrue,
        isHcReachable: alwaysFalse,
      })
    ),
    throws(() =>
      resolveBackend('auto', 'plain', {
        isHerdrReachable: alwaysFalse,
        isHcReachable: alwaysFalse,
      })
    ),
  ].filter(Boolean);
  // Setup hints may name env vars (HC_TERMINAL_ID, HERDR_ENV) as guidance;
  // leaks are concrete values: pane/terminal ids and socket paths.
  const banned = ['pane-1', 'pane-42', '/run/hc.sock', '/run/user/1000/herdr', 't11'];
  for (const e of errs) {
    const msg = String(e && e.message);
    assert(
      !banned.some(s => msg.includes(s)),
      `error leaks no ids/sockets: ${msg.slice(0, 60)}...`
    );
  }
}

// ── live session info (non-asserting; varies by caller) ───────────────────
{
  const caller = detectCaller();
  let live;
  try {
    live = resolveBackend('auto', caller);
  } catch (e) {
    live = `throw: ${String(e && e.message).slice(0, 80)}...`;
  }
  console.log(`INFO  live detectCaller()=${caller} resolveBackend(auto)=${live}`);
  // Phase 1.1 scaffold: src/runtimes/hc/ exists with the spawn/read surface
  // but stays unwired from the resolver (wiring is 1.2), so app resolution
  // is still a clean refusal downstream, never a cross-spawn. This file
  // still only proves the resolver mapping; live spawn proof goes through
  // shepherd_* + hc.
  const fs = await import('node:fs');
  assert(fs.existsSync('src/runtimes/hc/hc.ts'), 'Phase 1.1 hc.ts scaffold exists');
  assert(fs.existsSync('src/runtimes/hc/runtime.ts'), 'Phase 1.1 runtime.ts scaffold exists');
  const hcRuntimeSource = fs.readFileSync('src/runtimes/hc/runtime.ts', 'utf8');
  assert(
    !hcRuntimeSource.includes('herdr'),
    'hc runtime drives hc terminals only (no pane-backend import)'
  );
  const hc = await import('../src/runtimes/hc/hc.ts');
  for (const fn of [
    'isHcAvailable',
    'hcExec',
    'recordCreatedTerminal',
    'pruneStaleCreatedTerminals',
    'writePiLaunchFiles',
    'launchPiInHcTerminal',
  ]) {
    assert(typeof hc[fn] === 'function', `hc.ts exports ${fn}`);
  }
  const { createHcRuntime } = await import('../src/runtimes/hc/runtime.ts');
  const hcRuntime = createHcRuntime({ cwd: process.cwd() });
  for (const method of ['spawn', 'delegate', 'message', 'watch', 'status', 'close', 'read']) {
    assert(typeof hcRuntime[method] === 'function', `hc runtime implements ${method}`);
  }
}

if (failures) process.exit(1);
console.log('All backend assertions passed.');
