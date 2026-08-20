/**
 * Filesystem persistence for Shepherd fieldnotes sessions.
 *
 * This module deliberately has no pi/Herdr dependencies.  All mutations use
 * small exclusive lock files and same-directory rename operations so it is
 * safe for separate Shepherd processes to update one session.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export type SessionMode = "single" | "parallel" | "chain";
export type ArtifactStatus = "pending" | "running" | "completed" | "failed" | "timed-out" | "cancelled";

export interface ParentPiSessionBinding {
	/** Opaque identity supplied by the parent pi runtime. */
	identity: string;
	/** Canonical project root to which this parent is bound. */
	projectRoot: string;
	boundAt: string;
	/** Optional diagnostic only; never used as the binding key. */
	sessionFile?: string;
}

export interface ShepherdSession {
	/** Versioned durable binding format. Legacy sessions omit this field. */
	artifactSessionVersion?: 2;
	/** Canonical parent binding. Legacy sessions omit this field. */
	parentPiSession?: ParentPiSessionBinding;
	/** Compatibility aliases retained for callers of the initial draft. */
	parentPiSessionId?: string;
	parentSessionFile?: string;
	sessionName: string;
	slug: string;
	ordinal: number;
	directoryName: string;
	projectRoot: string;
	sessionPath: string;
	sessionRelativePath: string;
	mocPath: string;
	sessionMetadataPath: string;
	resumed: boolean;
	startedAt: string;
	updatedAt: string;
	status: string;
	modes: SessionMode[];
}

export interface ArtifactReservation {
	id: string;
	agent: string;
	agentSlug: string;
	ordinal: number;
	fileName: string;
	filePath: string;
	relativePath: string;
	mode: SessionMode;
	task?: string;
	status: ArtifactStatus;
	reservedAt: string;
	startedAt?: string;
	completedAt?: string;
}

export interface PlannedArtifact {
	agent: string;
	mode: SessionMode;
	task?: string;
}

interface SessionRecord extends ShepherdSession {
	artifacts: ArtifactReservation[];
}

/** A validated, parent-bound persistent fieldnotes session. */
export type ArtifactSession = ShepherdSession & {
	artifactSessionVersion: 2;
	parentPiSession: ParentPiSessionBinding;
};

const MAX_SLUG_LENGTH = 64;
const MAX_AGENT_SLUG_LENGTH = 48;
const ROOT_DIR = ".shepherd";
const SESSIONS_DIR = "sessions";
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 30_000;

function now(): string { return new Date().toISOString(); }
function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function lock(lockPath: string): () => void {
	const started = Date.now();
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	while (true) {
		try {
			const fd = fs.openSync(lockPath, "wx");
			fs.writeSync(fd, `${process.pid}\n`);
			fs.closeSync(fd);
			return () => { try { fs.unlinkSync(lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`Timed out acquiring filesystem lock: ${lockPath}`);
			sleep(LOCK_RETRY_MS);
		}
	}
}

function atomicWrite(filePath: string, content: string): void {
	const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
	const fd = fs.openSync(temporary, "wx", 0o644);
	try {
		fs.writeFileSync(fd, content, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fs.renameSync(temporary, filePath);
	} catch (error) {
		try { fs.closeSync(fd); } catch { /* already closed */ }
		try { fs.unlinkSync(temporary); } catch { /* best effort */ }
		throw error;
	}
}

function ensureDescendant(root: string, candidate: string): void {
	const relative = path.relative(root, candidate);
	if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Path escapes session root: ${candidate}`);
	}
}


function validateParentIdentity(identity: unknown): string {
	if (typeof identity !== "string" || !identity) throw new TypeError("A stable parent pi session identity is required");
	if (/[\u0000-\u001f\u007f]/.test(identity)) throw new Error("Parent pi session identity contains control characters");
	return identity;
}

/** Validate and normalize a human-facing session name into a safe slug. */
export function slugifySessionName(name: string): string {
	if (typeof name !== "string") throw new TypeError("Session name must be a string");
	if (name.includes("\0") || /[\u0001-\u001f\u007f]/.test(name) || name.includes("/") || name.includes("\\") || path.isAbsolute(name)) {
		throw new Error("Session name must not contain control characters, path separators, or be an absolute path");
	}
	const trimmed = name.trim();
	if (trimmed === "." || trimmed === ".." || trimmed.split(/[\\/]/).some((part) => part === "..")) {
		throw new Error("Session name must not contain traversal components");
	}
	const slug = trimmed.toLocaleLowerCase().normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
	if (!slug) throw new Error("Session name must contain at least one usable character");
	return slug;
}

/** Convert an agent label to a filename component (agent labels are sanitized, not rejected). */
export function slugifyAgentName(agent: string): string {
	const value = String(agent).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
		.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
		.slice(0, MAX_AGENT_SLUG_LENGTH).replace(/-+$/g, "");
	return value || "agent";
}

export function deriveSessionName(task?: string): string {
	if (!task || !task.trim()) return "delegation";
	const words = task.trim().split(/\s+/).slice(0, 8).join("-");
	try { return slugifySessionName(words); } catch { return "delegation"; }
}

function sessionRoot(projectRoot: string): string {
	return path.resolve(projectRoot, ROOT_DIR, SESSIONS_DIR);
}
function isSessionDirectory(name: string): boolean { return /^\d{4,}-.+/.test(name); }
function readRecord(dir: string): SessionRecord | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8")) as SessionRecord;
		if (!value || typeof value.sessionName !== "string" || typeof value.projectRoot !== "string" || !Number.isInteger(value.ordinal) || !Array.isArray(value.artifacts)) return undefined;
		if (value.directoryName !== path.basename(dir)) return undefined;
		const sessionPath = path.resolve(dir);
		const projectRoot = path.resolve(value.projectRoot);
		// The metadata may contain paths from another machine or an attacker. The
		// directory being read must be the canonical sessions child of its recorded
		// project; all other paths are derived below rather than trusted.
		if (path.dirname(sessionPath) !== sessionRoot(projectRoot)) return undefined;
		if (value.artifactSessionVersion === 2) {
			const identity = value.parentPiSession?.identity ?? value.parentPiSessionId;
			if (typeof identity !== "string" || !identity || /[\u0000-\u001f\u007f]/.test(identity)) return undefined;
			if (value.parentPiSession && path.resolve(value.parentPiSession.projectRoot) !== projectRoot) return undefined;
		}
		const artifacts = value.artifacts.map((artifact) => {
			if (!artifact || typeof artifact.agent !== "string" || typeof artifact.fileName !== "string" || !Number.isInteger(artifact.ordinal)) throw new Error("Invalid artifact metadata");
			// Never trust paths read from session.json.  They are derived from the
			// session directory and the filename, then checked lexically below.
			if (artifact.fileName === "shepherd.md" || path.basename(artifact.fileName) !== artifact.fileName || artifact.fileName.includes("\0")) throw new Error("Invalid artifact filename");
			const filePath = path.join(sessionPath, artifact.fileName);
			ensureDescendant(sessionPath, filePath);
			return {
				...artifact,
				filePath,
				relativePath: path.relative(projectRoot, filePath),
			};
		});
		return {
			...value,
			projectRoot,
			sessionPath,
			sessionRelativePath: path.relative(projectRoot, sessionPath),
			mocPath: path.join(sessionPath, "shepherd.md"),
			sessionMetadataPath: path.join(sessionPath, "session.json"),
			artifacts,
		};
	} catch { return undefined; }
}
function toSession(record: SessionRecord, resumed: boolean): ShepherdSession {
	return { ...record, resumed };
}
function writeRecord(sessionPath: string, record: SessionRecord): void {
	atomicWrite(path.join(sessionPath, "session.json"), `${JSON.stringify(record, null, 2)}\n`);
}

function directorySlug(name: string): string | undefined {
	const match = /^\d{4,}-(.+)$/.exec(name);
	return match?.[1];
}
function collisionSlug(root: string, slug: string, sessionName: string): string {
	const existingSlugs = new Set<string>();
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !isSessionDirectory(entry.name)) continue;
		const existingSlug = directorySlug(entry.name);
		if (existingSlug) existingSlugs.add(existingSlug);
		const record = readRecord(path.join(root, entry.name));
		if (record?.sessionName === sessionName) continue;
		if (record && (() => { try { return slugifySessionName(record.sessionName) === slug; } catch { return false; } })()) existingSlugs.add(slug);
	}
	if (!existingSlugs.has(slug)) return slug;
	const suffix = hash(sessionName);
	const baseLength = Math.max(1, MAX_SLUG_LENGTH - suffix.length - 1);
	const base = slug.slice(0, baseLength).replace(/-+$/g, "") || "session";
	let candidate = `${base}-${suffix}`;
	let serial = 2;
	while (existingSlugs.has(candidate)) {
		const serialSuffix = `-${serial++}`;
		const length = Math.max(1, MAX_SLUG_LENGTH - serialSuffix.length);
		candidate = `${candidate.slice(0, length).replace(/-+$/g, "")}${serialSuffix}`;
	}
	return candidate;
}
function displayName(name: string): string {
	return name.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function renderMoc(record: SessionRecord): string {
	const modes = record.modes.length ? record.modes.join(", ") : record.artifacts.map((a) => a.mode).filter((m, i, all) => all.indexOf(m) === i).join(", ");
	const binding = record.artifactSessionVersion === 2 && (record.parentPiSession?.identity ?? record.parentPiSessionId)
		? `parent-bound (identity ${hash(record.parentPiSession?.identity ?? record.parentPiSessionId!)})`
		: "legacy/unbound";
	const artifacts = record.artifacts.length
		? record.artifacts.map((a, i) => `${i + 1}. [${displayName(a.agent)} ${String(a.ordinal).padStart(2, "0")}](./${a.fileName}) — ${a.status}`).join("\n")
		: "_No notes reserved yet._";
	const flow = record.artifacts.length ? record.artifacts.map((a) => `[${a.fileName.replace(/\.md$/, "")}](./${a.fileName})`).join(" → ") : "_No flow yet._";
	return `# Session ${String(record.ordinal).padStart(4, "0")} — ${displayName(record.sessionName)}\n\n- **Status:** ${record.status}\n- **Session name:** \`${record.sessionName}\`\n- **Fieldnotes session version:** ${record.artifactSessionVersion ?? "legacy"}\n- **Parent binding:** ${binding}\n- **Started:** ${record.startedAt}\n- **Updated:** ${record.updatedAt}\n- **Project:** .\n- **Mode(s):** ${modes || "pending"}\n\n## Notes\n\n${artifacts}\n\n## Flow\n\n${flow}\n`;
}
function writeMoc(record: SessionRecord): void { atomicWrite(path.join(record.sessionPath, "shepherd.md"), renderMoc(record)); }
function updateRecordAndMoc(record: SessionRecord): void { record.updatedAt = now(); writeRecord(record.sessionPath, record); writeMoc(record); }

function allocationOrdinal(root: string): number {
	const alloc = path.join(root, ".alloc");
	fs.mkdirSync(alloc, { recursive: true });
	let candidate = 1;
	try {
		for (const name of fs.readdirSync(root)) {
			const match = /^(\d{4,})-/.exec(name);
			if (match) candidate = Math.max(candidate, Number(match[1]) + 1);
		}
	} catch { /* root was created above */ }
	while (true) {
		const token = path.join(alloc, String(candidate).padStart(4, "0"));
		try { fs.mkdirSync(token); return candidate; } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			candidate++;
		}
	}
}

export interface CreateSessionOptions {
	projectRoot: string;
	sessionName?: string;
	fallbackTask?: string;
	mode?: SessionMode;
	/** Explicit names resume; generated fallback names create a fresh session by default. */
	resumeExisting?: boolean;
}

/** Create a numbered session or resume one matched by exact session.json name. */
export function createOrResumeSession(options: CreateSessionOptions): ShepherdSession {
	const projectRoot = path.resolve(options.projectRoot);
	const root = sessionRoot(projectRoot);
	fs.mkdirSync(root, { recursive: true });
	const explicitName = Boolean(options.sessionName?.trim());
	const requested = options.sessionName?.trim() || deriveSessionName(options.fallbackTask);
	const resumeExisting = options.resumeExisting ?? explicitName;
	// Explicit names are validated even if a malformed name could be normalized safely.
	const slug = slugifySessionName(requested);
	const release = lock(path.join(root, ".sessions.lock"));
	try {
		if (resumeExisting) {
			for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory() || !isSessionDirectory(entry.name)) continue;
				const record = readRecord(path.join(root, entry.name));
				if (!record || record.projectRoot !== projectRoot || record.sessionName !== requested) continue;
				const sessionRelease = lock(path.join(path.join(root, entry.name), ".session.lock"));
				try {
					record.resumed = true;
					if (options.mode && !record.modes.includes(options.mode)) record.modes.push(options.mode);
					record.status = ["completed", "failed", "timed-out", "cancelled"].includes(record.status) ? "running" : record.status;
					updateRecordAndMoc(record);
					return toSession(record, true);
				} finally { sessionRelease(); }
			}
		}
		const ordinal = allocationOrdinal(root);
		const actualSlug = collisionSlug(root, slug, requested);
		const directoryName = `${String(ordinal).padStart(4, "0")}-${actualSlug}`;
		const sessionPath = path.join(root, directoryName);
		ensureDescendant(root, sessionPath);
		fs.mkdirSync(sessionPath); // ordinal reservation means this should be unique
		const startedAt = now();
		const record: SessionRecord = {
			sessionName: requested, slug: actualSlug, ordinal, directoryName, projectRoot,
			sessionPath, sessionRelativePath: path.relative(projectRoot, sessionPath),
			mocPath: path.join(sessionPath, "shepherd.md"), sessionMetadataPath: path.join(sessionPath, "session.json"),
			resumed: false, startedAt, updatedAt: startedAt, status: "running", modes: options.mode ? [options.mode] : [], artifacts: [],
		};
		writeRecord(sessionPath, record);
		writeMoc(record);
		return toSession(record, false);
	} finally { release(); }
}

function loadSession(session: ShepherdSession): SessionRecord {
	const sessionPath = path.resolve(session.sessionPath);
	const record = readRecord(sessionPath);
	if (!record) throw new Error(`Invalid session metadata: ${session.sessionMetadataPath}`);
	if (record.sessionPath !== sessionPath) throw new Error("Session path does not match durable metadata");
	if (record.artifactSessionVersion === 2 && !record.parentPiSession && !record.parentPiSessionId) {
		throw new Error("Parent-bound session is missing its binding metadata");
	}
	return record;
}
function hash(value: string): string { return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8); }
function safeArtifactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
	// Lifecycle metadata is useful provenance, but never allow it to replace the
	// allocator-owned identity or filesystem fields loaded from session.json.
	const forbidden = new Set(["id", "artifactSessionVersion", "session", "sessionName", "parentPiSession", "agent", "agentSlug", "ordinal", "fileName", "filePath", "relativePath", "mode", "status", "reservedAt", "startedAt", "completedAt"]);
	return Object.fromEntries(Object.entries(metadata).filter(([key]) => !forbidden.has(key)));
}
function artifactBase(agent: string, existing: ArtifactReservation[]): string {
	// Reuse the established slug for repeated invocations of the same agent;
	// ordinals, rather than slugs, distinguish those artifacts.
	const prior = existing.find((item) => item.agent === agent);
	if (prior) return prior.agentSlug;
	const base = slugifyAgentName(agent);
	// Different labels may normalize to the same filename component.  Keep the
	// original label in the metadata, and disambiguate the filename safely.
	if (!existing.some((item) => item.agentSlug === base)) return base;
	return `${base}-${hash(agent)}`;
}
function artifactFrontmatter(a: ArtifactReservation, session: SessionRecord, extra: Record<string, unknown> = {}): string {
	const parentIdentity = session.parentPiSession?.identity ?? session.parentPiSessionId;
	const fields: Record<string, unknown> = {
		...extra,
		artifactSessionVersion: session.artifactSessionVersion ?? 1,
		session: session.directoryName,
		sessionName: session.sessionName,
		...(parentIdentity ? { parentPiSession: hash(parentIdentity) } : {}),
		agent: a.agent,
		ordinal: a.ordinal,
		mode: a.mode,
		status: a.status,
		reservedAt: a.reservedAt,
		...(a.startedAt ? { started: a.startedAt } : {}),
		...(a.completedAt ? { completed: a.completedAt } : {}),
	};
	const lines = Object.entries(fields).map(([key, value]) => {
		if (typeof value !== "string") return `${key}: ${JSON.stringify(value)}`;
		const safe = /^[A-Za-z0-9._-]+$/.test(value) ? value : JSON.stringify(value);
		return `${key}: ${safe}`;
	});
	return `---\n${lines.join("\n")}\n---\n\n# ${displayName(a.agent)} ${String(a.ordinal).padStart(2, "0")}\n\n<!-- Sheep's note or sheep-maintained report follows. -->\n`;
}
function initializeArtifact(a: ArtifactReservation, session: SessionRecord): void { atomicWrite(a.filePath, artifactFrontmatter(a, session) + "\n"); }

/** Reserve all artifacts in input order, before any corresponding child starts. */
export function reserveArtifacts(session: ShepherdSession, planned: PlannedArtifact[]): ArtifactReservation[] {
	if (!Array.isArray(planned)) throw new TypeError("planned artifacts must be an array");
	const release = lock(path.join(session.sessionPath, ".session.lock"));
	try {
		const record = loadSession(session);
		const result: ArtifactReservation[] = [];
		for (const item of planned) {
			if (!item || typeof item.agent !== "string" || !item.agent.trim()) throw new Error("Artifact agent name is required");
				const ordinal = record.artifacts.filter((a) => a.agent === item.agent).length + 1;
			let base = artifactBase(item.agent, record.artifacts);
			let fileName = `${base}-${String(ordinal).padStart(2, "0")}.md`;
			let suffix = 2;
			while (record.artifacts.some((a) => a.fileName === fileName) || fs.existsSync(path.join(record.sessionPath, fileName))) fileName = `${base}-${suffix++}-${String(ordinal).padStart(2, "0")}.md`;
			const reservedAt = now();
			const artifact: ArtifactReservation = { id: `${record.directoryName}/${fileName}`, agent: item.agent, agentSlug: base, ordinal, fileName, filePath: path.join(record.sessionPath, fileName), relativePath: path.relative(record.projectRoot, path.join(record.sessionPath, fileName)), mode: item.mode, task: item.task, status: "pending", reservedAt };
			ensureDescendant(record.sessionPath, artifact.filePath);
			initializeArtifact(artifact, record);
			record.artifacts.push(artifact);
			result.push(artifact);
		}
		if (planned.some((p) => p.mode && !record.modes.includes(p.mode))) record.modes = [...record.modes, ...planned.map((p) => p.mode).filter((m, i, all) => !record.modes.includes(m) && all.indexOf(m) === i)];
		updateRecordAndMoc(record);
		return result;
	} finally { release(); }
}

export function markArtifactStarted(session: ShepherdSession, artifact: ArtifactReservation, metadata: Record<string, unknown> = {}): void {
	updateArtifact(session, artifact, "running", metadata);
}

export function markArtifactStatus(session: ShepherdSession, artifact: ArtifactReservation, status: ArtifactStatus, metadata: Record<string, unknown> = {}): void {
	updateArtifact(session, artifact, status, metadata);
}

function updateArtifact(session: ShepherdSession, artifact: ArtifactReservation, status: ArtifactStatus, metadata: Record<string, unknown>): void {
	const release = lock(path.join(session.sessionPath, ".session.lock"));
	try {
		const record = loadSession(session);
		const stored = record.artifacts.find((a) => a.id === artifact.id || a.filePath === artifact.filePath);
		if (!stored) throw new Error(`Artifact is not part of session: ${artifact.filePath}`);
		stored.status = status;
		if (status === "running" && !stored.startedAt) stored.startedAt = now();
		if (["completed", "failed", "timed-out", "cancelled"].includes(status)) stored.completedAt = now();
		Object.assign(stored, safeArtifactMetadata(metadata));
		const existing = fs.existsSync(stored.filePath) ? fs.readFileSync(stored.filePath, "utf8") : "";
		const body = existing.replace(/^---[\s\S]*?---\s*/, "").replace(/\n<!-- Shepherd orchestration -->[\s\S]*$/, "");
		atomicWrite(stored.filePath, artifactFrontmatter(stored, record, metadata) + body.trimStart() + "\n");
		updateRecordAndMoc(record);
	} finally { release(); }
}

/** Finalize an artifact without discarding content an agent may have written. */
export function finalizeArtifact(session: ShepherdSession, artifact: ArtifactReservation, result: { status: ArtifactStatus; output?: string; error?: string; metadata?: Record<string, unknown> }): void {
	if (!["completed", "failed", "timed-out", "cancelled"].includes(result.status)) throw new Error("Final artifact status must be terminal");
	const release = lock(path.join(session.sessionPath, ".session.lock"));
	try {
		const record = loadSession(session);
		const stored = record.artifacts.find((a) => a.id === artifact.id || a.filePath === artifact.filePath);
		if (!stored) throw new Error(`Artifact is not part of session: ${artifact.filePath}`);
		stored.status = result.status;
		stored.completedAt = now();
		if (result.metadata) Object.assign(stored, safeArtifactMetadata(result.metadata));
		const existing = fs.existsSync(stored.filePath) ? fs.readFileSync(stored.filePath, "utf8") : artifactFrontmatter(stored, record);
		const body = existing.replace(/^---[\s\S]*?---\s*/, "").replace(/\n<!-- Shepherd orchestration -->[\s\S]*$/, "").trimEnd();
		const output = result.output ? `\n\n### Final output\n\n${result.output}` : "";
		const error = result.error ? `\n\n### Error\n\n${result.error}` : "";
		const section = `\n\n<!-- Shepherd orchestration -->\n## Shepherd orchestration\n\n- **Final status:** ${result.status}\n- **Completed:** ${stored.completedAt}\n${result.metadata && Object.keys(result.metadata).length ? `- **Metadata:** \`${JSON.stringify(result.metadata)}\`\n` : ""}${output}${error}\n`;
		atomicWrite(stored.filePath, artifactFrontmatter(stored, record, result.metadata ?? {}) + body + section);
		updateRecordAndMoc(record);
	} finally { release(); }
}

/** Update session status/modes and atomically regenerate its fieldnotes index. */
export function updateSessionMoc(session: ShepherdSession, update: { mode?: SessionMode; status?: string } = {}): ShepherdSession {
	const release = lock(path.join(session.sessionPath, ".session.lock"));
	try {
		const record = loadSession(session);
		if (update.mode && !record.modes.includes(update.mode)) record.modes.push(update.mode);
		if (update.status) record.status = update.status;
		updateRecordAndMoc(record);
		return toSession(record, true);
	} finally { release(); }
}

export interface ParentArtifactSessionOptions {
	/** Stable identity supplied by the parent pi SessionManager. */
	parentPiSessionId?: string;
	/** Preferred spelling for callers that expose the pi identity as identity. */
	parentPiSessionIdentity?: string;
	/** Optional human-readable label; it never participates in lookup. */
	sessionName?: string;
	/** Canonical project root for this parent binding. */
	projectRoot: string;
	/** Optional parent JSONL path, for provenance/debugging only. */
	parentSessionFile?: string;
}

/**
 * Resolve the one durable fieldnotes session owned by a parent pi session and
 * project root. This deliberately does not use createOrResumeSession's
 * human-facing name matching: legacy unbound sessions and sessions belonging
 * to another parent are never silently claimed.
 */
export function resolveOrCreateParentArtifactSession(options: ParentArtifactSessionOptions): ArtifactSession {
	const parentPiSessionId = validateParentIdentity(options.parentPiSessionIdentity ?? options.parentPiSessionId);
	const projectRoot = path.resolve(options.projectRoot);
	if (!projectRoot || projectRoot === path.parse(projectRoot).root) {
		// The filesystem root is technically valid, but is almost certainly an
		// accidental binding and would make project isolation hard to reason about.
		// Keep the check explicit while allowing normal temporary/project roots.
		if (!fs.existsSync(projectRoot)) throw new Error("Project root does not exist");
	}
	const root = sessionRoot(projectRoot);
	fs.mkdirSync(root, { recursive: true });
	const release = lock(path.join(root, ".sessions.lock"));
	try {
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || !isSessionDirectory(entry.name)) continue;
			const record = readRecord(path.join(root, entry.name));
			if (!record || record.artifactSessionVersion !== 2) continue;
			const storedIdentity = record.parentPiSession?.identity ?? record.parentPiSessionId;
			if (record.projectRoot !== projectRoot || storedIdentity !== parentPiSessionId) continue;
			const sessionRelease = lock(path.join(record.sessionPath, ".session.lock"));
			try {
				record.parentSessionFile = options.parentSessionFile ?? record.parentSessionFile;
				if (record.parentPiSession) record.parentPiSession.sessionFile = record.parentSessionFile;
				record.resumed = true;
				if (["completed", "failed", "timed-out", "cancelled"].includes(record.status)) record.status = "running";
				updateRecordAndMoc(record);
				return toSession(record, true) as ArtifactSession;
			} finally { sessionRelease(); }
		}

		const ordinal = allocationOrdinal(root);
		const sessionName = options.sessionName?.trim() || `orchestrator-${hash(parentPiSessionId)}`;
		const slug = collisionSlug(root, slugifySessionName(sessionName), sessionName);
		const directoryName = `${String(ordinal).padStart(4, "0")}-${slug}`;
		const sessionPath = path.join(root, directoryName);
		ensureDescendant(root, sessionPath);
		fs.mkdirSync(sessionPath);
		const startedAt = now();
		const boundAt = startedAt;
		const parentPiSession: ParentPiSessionBinding = {
			identity: parentPiSessionId,
			projectRoot,
			boundAt,
			...(options.parentSessionFile ? { sessionFile: options.parentSessionFile } : {}),
		};
		const record: SessionRecord = {
			artifactSessionVersion: 2,
			parentPiSession,
			parentPiSessionId,
			...(options.parentSessionFile ? { parentSessionFile: options.parentSessionFile } : {}),
			sessionName, slug, ordinal, directoryName, projectRoot,
			sessionPath, sessionRelativePath: path.relative(projectRoot, sessionPath),
			mocPath: path.join(sessionPath, "shepherd.md"), sessionMetadataPath: path.join(sessionPath, "session.json"),
			resumed: false, startedAt, updatedAt: startedAt, status: "running", modes: [], artifacts: [],
		};
		writeRecord(sessionPath, record);
		writeMoc(record);
		return toSession(record, false) as ArtifactSession;
	} finally { release(); }
}

export function readSessionMetadata(sessionPath: string): ShepherdSession | undefined {
	const resolved = path.resolve(sessionPath);
	const record = readRecord(resolved);
	return record ? toSession(record, true) : undefined;
}
