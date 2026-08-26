/**
 * System-prompt adjustment used by pi-shepherd-launched agents.
 *
 * Pi's default identity paragraph is useful for the main session, but it is
 * misleading when an agent has a more specific system-prompt body. Keep the
 * match exact so custom prompts and future Pi prompt changes are left alone.
 */

export const PI_DEFAULT_IDENTITY =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

export function replacePiIdentity(systemPrompt: string, replacement: unknown): string {
	if (typeof replacement !== "string") return systemPrompt;
	const value = replacement.trim();
	if (!value || !systemPrompt.startsWith(PI_DEFAULT_IDENTITY)) return systemPrompt;
	return value + systemPrompt.slice(PI_DEFAULT_IDENTITY.length);
}

/** Remove only Pi's built-in documentation guidance, not project context. */
export function omitPiDocumentation(systemPrompt: string): string {
	const marker = "\n\nPi documentation (read only when the user asks about pi itself";
	const start = systemPrompt.indexOf(marker);
	if (start < 0) return systemPrompt;
	const finalBullet = systemPrompt.indexOf(
		"\n- Always read pi .md files completely and follow links to related docs",
		start + marker.length,
	);
	if (finalBullet >= 0) {
		const end = systemPrompt.indexOf("\n", finalBullet + 1);
		const suffix = systemPrompt.slice(end < 0 ? systemPrompt.length : end);
		return systemPrompt.slice(0, start) + (suffix.startsWith("\n\n") ? "" : "\n") + suffix;
	}
	// Keep a conservative fallback for a future Pi wording change where the
	// section is still separated from the next prompt section by a blank line.
	const end = systemPrompt.indexOf("\n\n", start + marker.length);
	if (end < 0) return systemPrompt.slice(0, start);
	return systemPrompt.slice(0, start) + systemPrompt.slice(end);
}
