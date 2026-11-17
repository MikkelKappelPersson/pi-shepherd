/**
 * Host capability seam (spec 013, Phase 1).
 *
 * The shared engine must not statically import any host SDK: a static
 * `@earendil-works/pi-*` import in the engine module graph would fail to
 * load on the OpenCode path, where those packages are not installed.
 * Host-specific values (agent directory, project config dir name, registry
 * subdir, frontmatter parser) therefore arrive through this module.
 *
 * Resolution order: an explicitly installed capability wins (each adapter
 * installs its own at load); otherwise Pi's implementations are resolved
 * once via dynamic import. A missing Pi package (the OpenCode path) is
 * detected precisely by `ERR_MODULE_NOT_FOUND` and means the host must
 * install its own capabilities; any other import failure is rethrown so a
 * broken Pi install is never masked. Existing tests keep passing untouched
 * because the Pi defaults honor the same `HOME` / `PI_CODING_AGENT_DIR`
 * env vars.
 */

// The Pi SDK is ESM-only (no `require` condition), so the fallback must be
// a dynamic import. Top-level await keeps every call site synchronous.

export interface FrontmatterResult<T> {
  frontmatter: T;
  body: string;
}

export interface HostCapabilities {
  /** Active agent dir (Pi: `getAgentDir()`; honors `PI_CODING_AGENT_DIR`). */
  getAgentDir(): string;
  /** Project config dir name (Pi: `CONFIG_DIR_NAME`, i.e. `.pi`). */
  projectConfigDirName: string;
  /** Data subdir under the agent dir (frozen: `pi-shepherd`, see FR-013). */
  dataDirName: string;
  /** YAML-frontmatter parser for agent definition files. */
  parseFrontmatter<T>(content: string): FrontmatterResult<T>;
}

let explicit: HostCapabilities | undefined;
let piFallback: HostCapabilities | undefined;
let piUnavailable = false;

/** Install the calling host's capabilities. Each adapter calls this at load. */
export function setHostCapabilities(caps: HostCapabilities): void {
  explicit = caps;
}

try {
  const pi = (await import('@earendil-works/pi-coding-agent')) as {
    getAgentDir(): string;
    CONFIG_DIR_NAME: string;
    parseFrontmatter<T>(content: string): FrontmatterResult<T>;
  };
  piFallback = {
    getAgentDir: pi.getAgentDir,
    projectConfigDirName: pi.CONFIG_DIR_NAME,
    dataDirName: 'pi-shepherd',
    parseFrontmatter: pi.parseFrontmatter,
  };
} catch (error) {
  // Only a missing package means "different host"; anything else (a
  // broken Pi install) must surface, not silently degrade.
  if ((error as { code?: string })?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  piUnavailable = true;
}

/** Active capabilities: explicit install wins, Pi fallback otherwise. */
export function hostCapabilities(): HostCapabilities {
  if (explicit) return explicit;
  if (piFallback) return piFallback;
  throw new Error(
    'No Shepherd host capabilities installed. ' +
      (piUnavailable
        ? 'The Pi SDK is not installed; the host adapter must call setHostCapabilities() at load.'
        : 'The Pi SDK failed to load and no host capabilities were installed.')
  );
}
