import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Create an isolated filesystem root for tests that need temporary state. */
export function createTempDirectory(prefix = 'pi-shepherd-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Run a test with an isolated temporary root and always remove it afterward. */
export async function withTempDirectory(prefix, callback) {
  const directory = createTempDirectory(prefix);
  try {
    return await callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Stable parent identity for transport and lifecycle unit tests. */
export function createFakeParentIdentity(overrides = {}) {
  return {
    sessionId: 'test-parent-session',
    ownerId: 'test-parent-owner',
    role: 'parent',
    ...overrides,
  };
}

/** Stable child identity for transport and lifecycle unit tests. */
export function createFakeChildIdentity(overrides = {}) {
  return {
    sessionId: 'test-parent-session',
    agentId: 'shepherd-agent-test-child',
    role: 'child',
    ...overrides,
  };
}

/** Resolve one turn of queued promises without relying on arbitrary sleeps. */
export async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}
