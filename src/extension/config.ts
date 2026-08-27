/**
 * pi-shepherd persisted configuration — two layers:
 *
 * - User layer: `~/.pi/agent/pi-shepherd/config.json` (same dir as
 *   `created-panes.json`). Holds the base defaults plus `settingsScope`,
 *   which points out where the effective values come from.
 * - Project layer: `.shepherd/config.json`, anchored at the current working
 *   directory (the same `.shepherd` root fieldnotes use; no walk-up). It is a
 *   *delta*: only fields that differ from the user layer are written, and
 *   every field present overrides the user layer one by one. `settingsScope`
 *   is never read from (or written to) the project layer.
 *
 * These are the *defaults* used when a tool call doesn't pass an explicit
 * value. Files are read fresh (with a cheap per-file mtime cache) so edits
 * made from the `/shepherd settings` popup take effect immediately.
 * Fieldnotes are the exception: their enabled/disabled state is snapshotted
 * for each parent pi session and takes effect when the next session starts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentScope } from "../core/discovery.ts";

/** Where the settings menu reads its values from and writes its edits to. */
export type ConfigScope = "user" | "project";

/**
 * Overridable config fields — every field except `settingsScope`, which lives
 * only in the user layer (a project file cannot select its own scope).
 */
const OVERRIDABLE_FIELDS = [
	"agentScope",
	"includeBundledAgents",
	"confirmProjectAgents",
	"keepOpen",
	"stayOpen",
	"fieldnotes",
	"emojiSheep",
	"timeout",
] as const;
type OverridableField = (typeof OVERRIDABLE_FIELDS)[number];

export interface ShepherdSettings {
	/** Where the effective values come from. Lives only in the user file. */
	settingsScope: ConfigScope;
	/** Which agent directories to search. Project agents are repo-controlled. */
	agentScope: AgentScope;
	/** Include pi-shepherd's bundled agents (scout, planner, worker, reviewer) in discovery. */
	includeBundledAgents: boolean;
	/** Prompt before running project-local agents (security gate). */
	confirmProjectAgents: boolean;
	/** Keep the Herdr tab open after completion, for inspection. */
	keepOpen: boolean;
	/** Keep the agent's pi process alive after done, to keep driving it. */
	stayOpen: boolean;
	/** Create and attach durable fieldnotes to delegated prompts. */
	fieldnotes: boolean;
	/** Show the animated sheep emoji beside actively working agents. */
	emojiSheep: boolean;
	/** Default time limit (minutes) for a Herdr run before it's reported timed out. */
	timeout: number;
}

export const DEFAULT_SETTINGS: ShepherdSettings = {
	settingsScope: "user",
	agentScope: "user",
	includeBundledAgents: true,
	confirmProjectAgents: true,
	keepOpen: true,
	stayOpen: false,
	fieldnotes: true,
	emojiSheep: true,
	timeout: 20,
};

export function userConfigFile(): string {
	// getAgentDir() resolves the active agent dir (~/.pi/agent by default,
	// overridable via the PI_CODING_AGENT_DIR env var). A named per-extension
	// subdir sits next to pi's own top-level files (settings.json, sessions/).
	return path.join(getAgentDir(), "pi-shepherd", "config.json");
}

export function projectConfigFile(projectRoot: string): string {
	return path.resolve(projectRoot, ".shepherd", "config.json");
}

function validAgentScope(v: unknown): AgentScope {
	return v === "user" || v === "project" || v === "both" ? v : DEFAULT_SETTINGS.agentScope;
}

function validConfigScope(v: unknown): ConfigScope {
	return v === "user" || v === "project" ? v : DEFAULT_SETTINGS.settingsScope;
}

/**
 * Timeout is stored in minutes. Migration: old settings stored ms (e.g.
 * 600000, 1200000); a value >= 1000 is assumed to be ms and converted.
 */
function validTimeout(v: unknown): number {
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return DEFAULT_SETTINGS.timeout;
	return v >= 1000 ? Math.round(v / 60_000) : v;
}

interface LayerCacheEntry {
	mtimeMs: number;
	/** Validated known fields actually present in the file (no defaults). */
	partial: Partial<ShepherdSettings>;
}

/** Per-file mtime cache: a read is skipped only when the file is unchanged. */
const layerCache = new Map<string, LayerCacheEntry>();

/**
 * Validate the on-disk value of one known field, or return undefined when the
 * field is absent or invalid (invalid falls through to the layer below).
 */
function validField(field: OverridableField, raw: Record<string, unknown>): unknown {
	switch (field) {
		case "agentScope":
			return typeof raw[field] === "string" ? validAgentScope(raw[field]) : undefined;
		case "includeBundledAgents":
		case "confirmProjectAgents":
		case "keepOpen":
		case "stayOpen":
		case "fieldnotes":
		case "emojiSheep":
			return typeof raw[field] === "boolean" ? raw[field] : undefined;
		case "timeout":
			return raw[field] !== undefined ? validTimeout(raw[field]) : undefined;
	}
}

function validateLayer(raw: unknown): Partial<ShepherdSettings> | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	const partial: Partial<ShepherdSettings> = {};
	partial.settingsScope = validConfigScope(record.settingsScope);
	for (const field of OVERRIDABLE_FIELDS) {
		const value = validField(field, record);
		if (value !== undefined) (partial as Record<string, unknown>)[field] = value;
	}
	return partial;
}

/**
 * Read one config file (user or project layer) and return the validated
 * fields that are actually present. Missing, unreadable, or invalid files
 * yield a pure default layer (undefined).
 */
function readPartialLayer(file: string): Partial<ShepherdSettings> | undefined {
	let mtimeMs: number;
	let text: string;
	try {
		mtimeMs = fs.statSync(file).mtimeMs;
		text = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const cached = layerCache.get(file);
	if (cached && cached.mtimeMs === mtimeMs) return cached.partial;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	const partial = validateLayer(raw);
	if (partial) layerCache.set(file, { mtimeMs, partial });
	return partial;
}

/**
 * One-shot migration: a legacy `~/.pi/agent/pi-shepherd/settings.json` is
 * moved to `config.json` the first time the new name is requested. When both
 * files exist, `config.json` wins and the legacy file is left in place (no
 * deletion). Best-effort: a failed rename just falls through to defaults.
 */
function migrateLegacySettingsFile(newFile: string): void {
	const legacy = path.join(path.dirname(newFile), "settings.json");
	let legacyReal: string;
	try {
		legacyReal = fs.realpathSync(legacy);
	} catch {
		return; // no legacy file — nothing to migrate
	}
	let existingReal: string | undefined;
	try {
		existingReal = fs.realpathSync(newFile);
	} catch {
		// config.json missing: move the legacy file in place of it.
	}
	if (existingReal) {
		if (existingReal !== legacyReal) {
			layerCache.delete(newFile); // a different file now occupies this path
		}
		return; // config.json wins; legacy file is untouched
	}
	try {
		fs.renameSync(legacy, newFile);
		layerCache.delete(newFile); // the file content changed out from under the cache
	} catch {
		// Best effort — defaults (or the untouched legacy file) apply.
	}
}

/** Overlay a project delta on top of the user layer, one field at a time. */
function overlayProject(user: ShepherdSettings, project: Partial<ShepherdSettings> | undefined): ShepherdSettings {
	if (!project) return user;
	const merged = { ...user };
	for (const field of OVERRIDABLE_FIELDS) {
		const value = project[field];
		if (value !== undefined) (merged as Record<string, unknown>)[field] = value;
	}
	// `settingsScope` is deliberately never overridden by the project layer.
	return merged;
}

/**
 * Resolve the effective settings: the user layer (file or defaults) with the
 * project delta on top when the user layer's `settingsScope` is "project" and
 * a cwd is given.
 */
export function loadSettings(cwd?: string): ShepherdSettings {
	const userFile = userConfigFile();
	migrateLegacySettingsFile(userFile);
	const user = { ...DEFAULT_SETTINGS, ...readPartialLayer(userFile) };
	if (user.settingsScope !== "project" || typeof cwd !== "string" || cwd.length === 0) return user;
	return overlayProject(user, readPartialLayer(projectConfigFile(cwd)));
}

/**
 * Persist a full settings object.
 *
 * - `user`: writes the whole object (including `settingsScope`).
 * - `project`: diffs `next` against the current user layer and writes only
 *   the fields that differ (`{}` when nothing differs); creates the file
 *   and `.shepherd/` dir when missing; never writes `settingsScope`.
 *
 * `created` is true when a new file was born on disk.
 */
export function saveSettings(
	next: ShepherdSettings,
	scope: ConfigScope = "user",
	projectRoot?: string
): { file: string; created: boolean } {
	if (scope === "project") {
		if (!projectRoot) throw new Error("projectRoot is required to save the project config layer");
		const file = projectConfigFile(projectRoot);
		const existed = fs.existsSync(file);
		const user = { ...DEFAULT_SETTINGS, ...readPartialLayer(userConfigFile()) };
		const delta: Record<string, unknown> = {};
		for (const field of OVERRIDABLE_FIELDS) {
			if ((next as Record<string, unknown>)[field] !== (user as Record<string, unknown>)[field]) {
				delta[field] = (next as Record<string, unknown>)[field];
			}
		}
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify(delta, null, 2));
			const partial: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(delta)) partial[key] = value;
			layerCache.set(file, { mtimeMs: fs.statSync(file).mtimeMs, partial });
		} catch (err) {
			throw err;
		}
		return { file, created: !existed };
	}
	const file = userConfigFile();
	const existed = fs.existsSync(file);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(next, null, 2));
		layerCache.set(file, { mtimeMs: fs.statSync(file).mtimeMs, partial: { ...next } });
	} catch (err) {
		throw err;
	}
	return { file, created: !existed };
}

/**
 * The currently effective project layer (user layer with `.shepherd/
 * config.json` on top), for the settings menu to diff against the user layer.
 */
export function loadProjectDelta(projectRoot: string): ShepherdSettings {
	const user = { ...DEFAULT_SETTINGS, ...readPartialLayer(userConfigFile()) };
	return overlayProject(user, readPartialLayer(projectConfigFile(projectRoot)));
}

// Fieldnotes are session-scoped: changing the setting while a parent pi
// session is running must not leave some agents with notes and others without
// them. A new pi session snapshots the persisted value.
let sessionFieldnotesEnabled: boolean | undefined;

export function initializeSessionSettings(cwd?: string): void {
	sessionFieldnotesEnabled = loadSettings(cwd).fieldnotes;
}

export function fieldnotesEnabled(): boolean {
	return sessionFieldnotesEnabled ?? loadSettings().fieldnotes;
}
