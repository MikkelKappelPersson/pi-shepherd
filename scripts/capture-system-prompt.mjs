/**
 * Tiny pi extension used by extract-pi-system-prompt.mjs.
 *
 * Pi exposes the fully assembled prompt at before_agent_start, immediately
 * before it would make the first provider request. Keeping this as a separate
 * extension also makes the extractor usable without changing pi-shepherd's
 * normal runtime behavior.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export default function captureSystemPrompt(pi) {
	const target = process.env.PI_SYSTEM_PROMPT_CAPTURE_FILE;
	if (!target) return;

	let captured = false;
	pi.on("before_agent_start", (event, ctx) => {
		if (captured) return;
		captured = true;

		const prompt =
			typeof event?.systemPrompt === "string"
				? event.systemPrompt
				: typeof ctx?.getSystemPrompt === "function"
					? ctx.getSystemPrompt()
					: "";

		try {
			mkdirSync(dirname(target), { recursive: true });
			const temporary = `${target}.${randomUUID()}.tmp`;
			writeFileSync(temporary, prompt, { encoding: "utf8", mode: 0o600 });
			renameSync(temporary, target);
		} catch {
			// The parent reports a useful timeout/error. Do not change the agent's
			// prompt or make prompt extraction affect the actual pi run.
		}

		// Abort before the first provider request. shutdown is a second safety
		// net for JSON-mode implementations that do not honor abort here.
		ctx?.abort?.();
		ctx?.shutdown?.();
	});
}
