/**
 * pi-shepherd persisted settings — a tiny JSON store at
 * `~/.pi/agent/pi-shepherd/settings.json` (same dir as `created-panes.json`).
 *
 * These are the *defaults* used when a tool call doesn't pass an explicit
 * value. They're read fresh from disk (with a cheap mtime cache) so edits made
 * from the `/pi-shepherd settings` popup take effect immediately.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentScope } from "./discovery.ts";

export interface ShepherdSettings {
	/** Which agent directories to search. Project agents are repo-controlled. */
	agentScope: AgentScope;
	/** Prompt before running project-local agents (security gate). */
	confirmProjectAgents: boolean;
	/** Keep the Herdr tab open after completion, for inspection. */
	keepOpen: boolean;
	/** Keep the subagent's pi process alive after done, to keep driving it. */
	stayOpen: boolean;
	/** Default time limit (ms) for a Herdr run before it's reported timed out. */
	timeout: number;
}

export const DEFAULT_SETTINGS: ShepherdSettings = {
	agentScope: "user",
	confirmProjectAgents: true,
	keepOpen: true,
	stayOpen: false,
	timeout: 600_000,
};

export function settingsFile(): string {
	return path.join(os.homedir(), ".pi", "agent", "pi-shepherd", "settings.json");
}

let cache: ShepherdSettings | undefined;
let cacheMtimeMs = -1;

function validAgentScope(v: unknown): AgentScope {
	return v === "user" || v === "project" || v === "both" ? v : DEFAULT_SETTINGS.agentScope;
}

/** Merge on-disk values over defaults. Missing/invalid fields fall back. */
export function loadSettings(): ShepherdSettings {
	const file = settingsFile();
	try {
		const mtime = fs.statSync(file).mtimeMs;
		if (cache && cacheMtimeMs === mtime) return cache;

		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ShepherdSettings>;
		const merged: ShepherdSettings = {
			agentScope: validAgentScope(parsed.agentScope),
			confirmProjectAgents:
				typeof parsed.confirmProjectAgents === "boolean"
					? parsed.confirmProjectAgents
					: DEFAULT_SETTINGS.confirmProjectAgents,
			keepOpen:
				typeof parsed.keepOpen === "boolean" ? parsed.keepOpen : DEFAULT_SETTINGS.keepOpen,
			stayOpen:
				typeof parsed.stayOpen === "boolean" ? parsed.stayOpen : DEFAULT_SETTINGS.stayOpen,
			timeout:
				typeof parsed.timeout === "number" && Number.isFinite(parsed.timeout) && parsed.timeout > 0
					? parsed.timeout
					: DEFAULT_SETTINGS.timeout,
		};
		cache = merged;
		cacheMtimeMs = mtime;
		return merged;
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveSettings(settings: ShepherdSettings): void {
	const file = settingsFile();
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(settings, null, 2));
		cache = { ...settings };
		cacheMtimeMs = fs.statSync(file).mtimeMs;
	} catch (err) {
		throw err;
	}
}
