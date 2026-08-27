/**
 * Phase 1 — Agent discovery.
 *
 * Pure filesystem + frontmatter parsing. No LLM calls, no pi session APIs.
 *
 * Reads agent definitions from the standard VS Code custom-agent syntax
 * (YAML frontmatter + Markdown body) across user, project and bundled
 * locations, in a fixed precedence order. On a name collision the EARLIER
 * location in that order wins (first-write-with-guard).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

/** The part of pi's current model needed to inherit its provider-qualified name. */
export type DelegatorModel = { provider: string; id: string };

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Omit pi's built-in default system prompt when delegating this agent. */
	omitSystemPrompt?: boolean;
	/** Omit Pi's built-in documentation guidance from the delegated prompt. */
	omitPiDocumentation: boolean;
	/** Omit Pi's automatic AGENTS.md/CLAUDE.md context-file loading. */
	omitContextFiles: boolean;
	systemPrompt: string;
	source: "user" | "project" | "bundled";
	filePath: string;
	// Pass-through frontmatter (carried as-is when present)
	userInvocable?: unknown;
	disableModelInvocation?: unknown;
	agents?: unknown;
	handoffs?: unknown;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectDirs: string[];
}

type Source = "user" | "project" | "bundled";

/** A candidate directory plus which source bucket it belongs to. */
interface Location {
	dir: string;
	source: Source;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Walk up from `cwd` to the filesystem root, returning the nearest ancestor
 * (including cwd itself) whose `<ancestor>/<subdir>/agents` is a directory.
 */
function findNearestProjectAgentsDir(cwd: string, subdir: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, subdir, "agents");
		if (isDirectory(candidate)) return candidate;

		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/** Normalize a model frontmatter value. Missing, null, empty, and whitespace-only
 * values mean the agent inherits the delegator's model. */
export function normalizeModel(model: unknown): string | undefined {
	if (typeof model !== "string") return undefined;
	const normalized = model.trim();
	return normalized.length > 0 ? normalized : undefined;
}

/** Resolve the model passed to a child pi process. An explicit agent model
 * wins; otherwise inherit the parent's provider/id when both are available. */
export function resolveDelegatedModel(agentModel: unknown, parentModel: DelegatorModel | undefined): string | undefined {
	const explicit = normalizeModel(agentModel);
	if (explicit) return explicit;
	if (!parentModel || typeof parentModel !== "object") return undefined;
	const model = parentModel as { provider?: unknown; id?: unknown };
	const provider = normalizeModel(model.provider);
	const id = normalizeModel(model.id);
	return provider && id ? `${provider}/${id}` : undefined;
}

function normalizeTools(tools: unknown): string[] | undefined {
	if (tools === undefined || tools === null) return undefined;

	let items: unknown[];
	if (Array.isArray(tools)) {
		items = tools;
	} else if (typeof tools === "string") {
		items = tools.split(",");
	} else {
		return undefined;
	}

	const cleaned = items
		.map((t) => (typeof t === "string" ? t.trim() : String(t).trim()))
		.filter((t) => t.length > 0);

	return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Read every `.md` / `.agent.md` file in a directory, returning parsed
 * AgentConfigs. Files missing a name or description are skipped. Within a
 * directory, if two files share a name the EARLIER one read wins.
 */
function loadAgentsFromDir(dir: string, source: Source): AgentConfig[] {
	if (!isDirectory(dir)) return [];

	const agents: AgentConfig[] = [];
	const seen = new Set<string>();

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		const name = entry.name;
		if (!name.endsWith(".md") && !name.endsWith(".agent.md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

		const agentName = frontmatter.name;
		const description = frontmatter.description;
		if (typeof agentName !== "string" || agentName.length === 0) continue;
		if (typeof description !== "string" || description.length === 0) continue;
		if (seen.has(agentName)) continue; // earlier file in this dir wins
		seen.add(agentName);

		agents.push({
			name: agentName,
			description,
			tools: normalizeTools(frontmatter.tools),
			model: normalizeModel(frontmatter.model),
			systemPrompt: body,
			source,
			filePath,
			// Only the YAML boolean is accepted; malformed values are ignored.
			omitSystemPrompt:
				typeof frontmatter["omit-system-prompt"] === "boolean"
					? frontmatter["omit-system-prompt"]
					: undefined,
			// This option intentionally defaults to false when absent. Accept the
			// documented camelCase spelling and the conventional kebab-case alias.
			omitPiDocumentation:
				typeof frontmatter.omitPiDocumentation === "boolean"
					? frontmatter.omitPiDocumentation
					: typeof frontmatter["omit-pi-documentation"] === "boolean"
						? frontmatter["omit-pi-documentation"]
						: false,
			// Only a YAML boolean is accepted; quoted strings default to false.
			omitContextFiles:
				typeof frontmatter.omitContextFiles === "boolean"
					? frontmatter.omitContextFiles
					: false,
			// Pass-through fields, carried as-is when present.
			userInvocable: frontmatter["user-invocable"],
			disableModelInvocation: frontmatter["disable-model-invocation"],
			agents: frontmatter.agents,
			handoffs: frontmatter.handoffs,
		});
	}

	return agents;
}

/**
 * Build the ordered list of locations to scan for a given scope.
 * Precedence (1 highest, 6 lowest):
 *   1  user:   getAgentDir()/agents                    (~/.pi/agent/agents)
 *   2  user:   os.homedir()/.agents/agents
 *   3  project: nearest ancestor with <anc>/ .pi/agents
 *   4  project: nearest ancestor with <anc>/ .agents/agents
 *   5  bundled: <pkg>/.pi/agents
 *   6  bundled: <pkg>/.agents/agents
 */
function buildLocations(cwd: string, scope: AgentScope, projectDirs: string[], includeBundled: boolean): Location[] {
	const locations: Location[] = [];

	// Bundled base set (lowest precedence): pi-shepherd's own agent dirs.
	const pkgDir = path.dirname(url.fileURLToPath(import.meta.url));
	const bundledPi = path.join(pkgDir, ".pi", "agents");
	const bundledAgents = path.join(pkgDir, ".agents", "agents");

	if (scope === "user" || scope === "both") {
		locations.push({ dir: path.join(getAgentDir(), "agents"), source: "user" });
		locations.push({ dir: path.join(os.homedir(), ".agents", "agents"), source: "user" });
	}

	if (scope === "project" || scope === "both") {
		const piDir = findNearestProjectAgentsDir(cwd, CONFIG_DIR_NAME);
		if (piDir) {
			locations.push({ dir: piDir, source: "project" });
			projectDirs.push(piDir);
		}
		const agentsDir = findNearestProjectAgentsDir(cwd, ".agents");
		if (agentsDir) {
			locations.push({ dir: agentsDir, source: "project" });
			projectDirs.push(agentsDir);
		}
	}

	if (includeBundled) {
		locations.push({ dir: bundledPi, source: "bundled" });
		locations.push({ dir: bundledAgents, source: "bundled" });
	}

	return locations;
}

export interface DiscoveryOptions {
	/** When false, skip bundled agent locations (scout, planner, worker, reviewer). */
	includeBundled?: boolean;
}

export function discoverAgents(cwd: string, scope: AgentScope, options: DiscoveryOptions = {}): AgentDiscoveryResult {
	const projectDirs: string[] = [];
	const locations = buildLocations(cwd, scope, projectDirs, options.includeBundled !== false);

	// First-write-with-guard: the first location (highest precedence) that
	// declares a given name wins; later duplicate names are dropped.
	const agentMap = new Map<string, AgentConfig>();
	for (const loc of locations) {
		for (const agent of loadAgentsFromDir(loc.dir, loc.source)) {
			if (!agentMap.has(agent.name)) {
				agentMap.set(agent.name, agent);
			}
		}
	}

	return { agents: Array.from(agentMap.values()), projectDirs };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
