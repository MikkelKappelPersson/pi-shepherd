/**
 * Persistent pi-shepherd settings.
 *
 * The user file stores personal values. The project file is anchored at the
 * current cwd and, when it carries `projectScope: true`, is a self-contained
 * source for project-overridable values. `confirmProjectAgents` is deliberately
 * user-owned because a repository must not be able to disable its trust gate.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentScope } from "../core/discovery.ts";

/** Fields that a project config may own. */
const PROJECT_FIELDS = [
	"agentScope",
	"includeBundledAgents",
	"keepOpen",
	"stayOpen",
	"fieldnotes",
	"emojiSheep",
	"timeout",
	"staleWaitThreshold",
] as const;
type ProjectField = (typeof PROJECT_FIELDS)[number];

/** Fields stored in the trusted user config. */
const USER_FIELDS = [...PROJECT_FIELDS, "confirmProjectAgents"] as const;
type UserField = (typeof USER_FIELDS)[number];

export interface ShepherdSettings {
	/** True when the current cwd's project file is the active source. */
	projectScope: boolean;
	/** Which agent definition directories to search. */
	agentScope: AgentScope;
	/** Include pi-shepherd's bundled agent definitions. */
	includeBundledAgents: boolean;
	/** User-owned security gate for project-local agent definitions. */
	confirmProjectAgents: boolean;
	/** Keep the Herdr tab open after completion. */
	keepOpen: boolean;
	/** Keep the child pi process alive after completion. */
	stayOpen: boolean;
	/** Create durable fieldnotes for delegated prompts. */
	fieldnotes: boolean;
	/** Show the animated sheep marker beside active agents. */
	emojiSheep: boolean;
	/** Default delegated-run timeout in minutes. */
	timeout: number;
	/** Minutes before one stale-wait reminder; values below one disable it. */
	staleWaitThreshold: number;
}

export const DEFAULT_SETTINGS: ShepherdSettings = {
	projectScope: false,
	agentScope: "user",
	includeBundledAgents: true,
	confirmProjectAgents: true,
	keepOpen: true,
	stayOpen: false,
	fieldnotes: true,
	emojiSheep: true,
	timeout: 20,
	staleWaitThreshold: 5,
};

export function userConfigFile(): string {
	return path.join(getAgentDir(), "pi-shepherd", "config.json");
}

export function projectConfigFile(projectRoot: string): string {
	return path.resolve(projectRoot, ".shepherd", "config.json");
}

function validAgentScope(value: unknown): AgentScope {
	return value === "user" || value === "project" || value === "both" ? value : DEFAULT_SETTINGS.agentScope;
}

/** Timeout is persisted in minutes; old millisecond values are migrated. */
function validTimeout(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_SETTINGS.timeout;
	return value >= 1000 ? Math.max(1, Math.round(value / 60_000)) : value;
}

/** Zero and negative stale thresholds intentionally disable reminders. */
function validStaleWaitThreshold(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_SETTINGS.staleWaitThreshold;
}

function validField(field: UserField, raw: Record<string, unknown>): unknown {
	const value = raw[field];
	if (value === undefined) return undefined;
	switch (field) {
		case "agentScope":
			return validAgentScope(value);
		case "timeout":
			return validTimeout(value);
		case "staleWaitThreshold":
			return validStaleWaitThreshold(value);
		case "includeBundledAgents":
		case "confirmProjectAgents":
		case "keepOpen":
		case "stayOpen":
		case "fieldnotes":
		case "emojiSheep":
			return typeof value === "boolean" ? value : undefined;
	}
}

/**
 * Parse one config layer, retaining only validated fields that were present.
 * `confirmProjectAgents` and all scope keys in a project file are intentionally
 * excluded from project-owned values.
 */
function validateLayer(raw: unknown, projectLayer: boolean): Partial<ShepherdSettings> | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	const partial: Partial<ShepherdSettings> = {};
	for (const field of USER_FIELDS) {
		if (projectLayer && field === "confirmProjectAgents") continue;
		const value = validField(field, record);
		if (value !== undefined) (partial as Record<string, unknown>)[field] = value;
	}
	if (projectLayer) {
		if (typeof record.projectScope === "boolean") {
			partial.projectScope = record.projectScope;
		} else if (record.settingsScope === "project") {
			// Read-only compatibility with the intermediate project-file format.
			partial.projectScope = true;
		}
	}
	return partial;
}

interface LayerCacheEntry {
	mtimeMs: number;
	partial: Partial<ShepherdSettings>;
}

const layerCache = new Map<string, LayerCacheEntry>();

function readPartialLayer(file: string, projectLayer: boolean): Partial<ShepherdSettings> | undefined {
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
	const partial = validateLayer(raw, projectLayer);
	if (partial) layerCache.set(file, { mtimeMs, partial });
	return partial;
}

/**
 * Migrate the old user-level settings filename once. The new config wins when
 * both files exist, and the legacy file is intentionally left untouched then.
 */
function migrateLegacySettingsFile(newFile: string): void {
	const legacyFile = path.join(path.dirname(newFile), "settings.json");
	let legacyReal: string;
	try {
		legacyReal = fs.realpathSync(legacyFile);
	} catch {
		return;
	}
	let existingReal: string | undefined;
	try {
		existingReal = fs.realpathSync(newFile);
	} catch {
		// The new file does not exist and may be replaced by the legacy file.
	}
	if (existingReal) {
		if (existingReal !== legacyReal) layerCache.delete(newFile);
		return;
	}
	try {
		fs.renameSync(legacyFile, newFile);
		layerCache.delete(newFile);
	} catch {
		// Best effort: the legacy file remains available for the next attempt.
	}
}

/**
 * Resolve settings for one workspace. An active project file starts from built-in
 * defaults; only the user-owned confirmation gate comes from the user layer.
 */
export function loadSettings(cwd?: string): ShepherdSettings {
	const userFile = userConfigFile();
	migrateLegacySettingsFile(userFile);
	const user = {
		...DEFAULT_SETTINGS,
		...readPartialLayer(userFile, false),
		projectScope: false,
	} as ShepherdSettings;
	if (typeof cwd !== "string" || cwd.length === 0) return user;

	const project = readPartialLayer(projectConfigFile(cwd), true);
	if (!project?.projectScope) return user;
	return {
		...DEFAULT_SETTINGS,
		...project,
		projectScope: true,
		confirmProjectAgents: user.confirmProjectAgents,
	};
}

/**
 * Return parked project values for menu activation. Missing fields use built-in
 * defaults, never the current user's private values.
 */
export function loadProjectFileValues(projectRoot: string): Pick<ShepherdSettings, ProjectField> {
	const project = readPartialLayer(projectConfigFile(projectRoot), true);
	const values = {} as Record<ProjectField, unknown>;
	for (const field of PROJECT_FIELDS) {
		const value = project?.[field];
		values[field] = value !== undefined ? value : DEFAULT_SETTINGS[field];
	}
	return values as Pick<ShepherdSettings, ProjectField>;
}

/**
 * Persist one layer. User files contain every user field; project files contain
 * every project-owned field and the boolean activation flag.
 */
export function saveSettings(
	next: ShepherdSettings,
	scope: "user" | "project" = "user",
	projectRoot?: string,
): { file: string; created: boolean } {
	let file: string;
	if (scope === "project") {
		if (!projectRoot) throw new Error("projectRoot is required to save the project config layer");
		file = projectConfigFile(projectRoot);
	} else {
		file = userConfigFile();
	}
	const existed = fs.existsSync(file);
	const output: Record<string, unknown> = {};
	if (scope === "project") {
		for (const field of PROJECT_FIELDS) output[field] = next[field];
		output.projectScope = next.projectScope;
	} else {
		for (const field of USER_FIELDS) output[field] = next[field];
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(output, null, 2));
	const partial = validateLayer(output, scope === "project") ?? {};
	layerCache.set(file, { mtimeMs: fs.statSync(file).mtimeMs, partial });
	return { file, created: !existed };
}

/**
 * Deactivate one workspace without deleting its parked settings. Any valid
 * object other than an already-false flag is normalized to the boolean form;
 * this includes keyless and legacy-string project files.
 */
export function deactivateProjectScope(projectRoot: string): { file: string; changed: boolean } {
	const file = projectConfigFile(projectRoot);
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return { file, changed: false };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { file, changed: false };
	const record = { ...(raw as Record<string, unknown>) };
	if (record.projectScope === false) return { file, changed: false };
	record.projectScope = false;
	delete record.settingsScope;
	fs.writeFileSync(file, JSON.stringify(record, null, 2));
	const partial = validateLayer(record, true) ?? {};
	layerCache.set(file, { mtimeMs: fs.statSync(file).mtimeMs, partial });
	return { file, changed: true };
}

// Fieldnotes are session-scoped so a running parent session has one stable mode.
let sessionFieldnotesEnabled: boolean | undefined;

export function initializeSessionSettings(cwd?: string): void {
	sessionFieldnotesEnabled = loadSettings(cwd).fieldnotes;
}

export function fieldnotesEnabled(): boolean {
	return sessionFieldnotesEnabled ?? loadSettings().fieldnotes;
}
