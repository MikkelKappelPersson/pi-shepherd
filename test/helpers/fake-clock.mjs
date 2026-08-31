/**
 * Small dependency-free clock for lifecycle tests. Production code should
 * accept a clock/read-now function rather than patching Date.now; this helper
 * gives those tests one consistent clock contract.
 */
export function createManualClock(start = 0) {
  if (!Number.isFinite(start)) throw new TypeError('Clock start must be finite.');
  let current = start;
  return {
    now: () => current,
    set(value) {
      if (!Number.isFinite(value)) throw new TypeError('Clock value must be finite.');
      current = value;
      return current;
    },
    advance(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new TypeError('Clock advance must be a non-negative finite number.');
      }
      current += milliseconds;
      return current;
    },
  };
}

/**
 * Run a callback with a controlled Date.now value. This is reserved for tests
 * around legacy code that cannot yet receive an injected clock directly.
 */
export async function withFakeDateNow(start, callback) {
  const clock = createManualClock(start);
  const originalNow = Date.now;
  Date.now = clock.now;
  try {
    return await callback(clock);
  } finally {
    Date.now = originalNow;
  }
}
