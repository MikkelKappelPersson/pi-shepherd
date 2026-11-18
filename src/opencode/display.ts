/**
 * Display-only delivery for human-facing `/shepherd` command output (spec 013).
 *
 * `ctx.session.prompt({ sessionID, text })` admits a normal user message,
 * which the TUI renders in full, but also wakes the model into a new turn.
 * OpenCode's session layer skips that wake when `resume: false` is passed
 * (`if (input.resume !== false) yield* execution.wake(sessionID)`), so the
 * command result is shown as a normal message without starting an assistant
 * turn. Synthetic messages are NOT suitable here: the TUI renders them as a
 * single-line, truncated notice using `description ?? text`, so a multi-line
 * agent list collapses to a bare label.
 *
 * Parent-session notices elsewhere in the adapter intentionally use
 * `session.prompt` without `resume: false` because those must wake the model.
 */

export interface PromptSessionSink {
  prompt(input: { sessionID: string; text: string; resume?: boolean }): Promise<unknown>;
}

/** True when the host exposes the session-prompt primitive. */
export function supportsDisplayOnly(ctx: any): ctx is { session: PromptSessionSink } {
  return typeof ctx?.session?.prompt === "function";
}

/**
 * Show `text` in the session as a normal message without starting a turn.
 * Throws a clear error on hosts that lack the primitive rather than silently
 * degrading to a turn-starting call.
 */
export async function displayCommandOutput(ctx: any, sessionID: string, text: string): Promise<void> {
  if (!supportsDisplayOnly(ctx)) {
    throw new Error("OpenCode session.prompt is unavailable; cannot display command output")
  }
  await ctx.session.prompt({ sessionID, text, resume: false });
}
