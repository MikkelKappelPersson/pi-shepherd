/**
 * pi-shepherd persisted settings — a tiny JSON store at
 * `~/.pi/agent/pi-shepherd/settings.json` (same dir as `created-panes.json`).
 *
 * These are the *defaults* used when a tool call doesn't pass an explicit
 * value. They're read fresh from disk (with a cheap mtime cache) so edits made
 * from the `/shepherd settings` popup take effect immediately. Fieldnotes are
 * the exception: their enabled/disabled state is snapshotted for each parent
 * pi session and takes effect when the next session starts.
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
	/** Keep the sheep's pi process alive after done, to keep driving it. */
	stayOpen: boolean;
	/** Create and attach durable fieldnotes to delegated prompts. */
	fieldnotes: boolean;
	/** Default time limit (minutes) for a Herdr run before it's reported timed out. */
	timeout: number;
}

export const DEFAULT_SETTINGS: ShepherdSettings = {
	agentScope: "user",
	confirmProjectAgents: true,
	keepOpen: true,
	stayOpen: false,
	fieldnotes: true,
	timeout: 20,
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
			fieldnotes:
				typeof parsed.fieldnotes === "boolean" ? parsed.fieldnotes : DEFAULT_SETTINGS.fieldnotes,
			timeout: (() => {
				const raw = parsed.timeout;
				if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DEFAULT_SETTINGS.timeout;
				// Migration: old settings stored timeout in ms (e.g., 600000, 1200000).
				// New settings use minutes. If value >= 1000, assume it's ms and convert.
				return raw >= 1000 ? Math.round(raw / 60_000) : raw;
			})(),
		};
		cache = merged;
		cacheMtimeMs = mtime;
		// Save migrated value back to disk (e.g., old ms -> minutes)
		if (merged.timeout !== parsed.timeout) {
			saveSettings(merged);
		}
		return merged;
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

// Fieldnotes are session-scoped: changing the setting while a parent pi
// session is running must not leave some sheep with notes and others without
// them. A new pi session snapshots the persisted value.
let sessionFieldnotesEnabled: boolean | undefined;

export function initializeSessionSettings(): void {
	sessionFieldnotesEnabled = loadSettings().fieldnotes;
}

export function fieldnotesEnabled(): boolean {
	return sessionFieldnotesEnabled ?? loadSettings().fieldnotes;
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
