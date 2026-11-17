/**
 * OpenCode host capabilities (spec 013, Phase 2).
 *
 * Pi-owned surface: this module is the OpenCode adapter's counterpart to the
 * Pi extension entry. It installs engine host values appropriate for
 * OpenCode: the global OpenCode dir as agent dir, `.opencode` as project
 * config dir, and a YAML-frontmatter parser identical in behavior to Pi's
 * (same `---` splitting + `yaml` parse; `yaml` is a declared dependency).
 * The data subdir stays `pi-shepherd` (frozen per FR-013).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { setHostCapabilities, type FrontmatterResult } from '../core/host.ts';

/** Env prefix for the child capability handoff on the OpenCode path. */
export const OPENCODE_ENV_PREFIX = 'SHEPHERD_';

/** Full shell command booting an interactive OpenCode child in a pane. */
export const OPENCODE_CHILD_COMMAND = 'opencode';

/** Launch overrides passed through the runtime contexts for OpenCode sheep. */
export const OPENCODE_LAUNCH_OVERRIDES = {
  command: OPENCODE_CHILD_COMMAND,
  envPrefix: OPENCODE_ENV_PREFIX,
} as const;

function extractFrontmatter(content: string): { yamlString: string | null; body: string } {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---')) return { yamlString: null, body: normalized };
  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) return { yamlString: null, body: normalized };
  return {
    yamlString: normalized.slice(4, endIndex),
    body: normalized.slice(endIndex + 4).trim(),
  };
}

/** Same observable behavior as Pi's parseFrontmatter for definition files. */
export function parseOpencodeFrontmatter<T>(content: string): FrontmatterResult<T> {
  const { yamlString, body } = extractFrontmatter(content);
  if (!yamlString) return { frontmatter: {} as T, body };
  return { frontmatter: (parseYaml(yamlString) ?? {}) as T, body };
}

/** Global OpenCode dir (overridable for tests via OPENCODE_CONFIG_DIR). */
export function opencodeAgentDir(): string {
  const override = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (override) return override;
  return path.join(os.homedir(), '.config', 'opencode');
}

/** Install the OpenCode host values into the shared engine. Idempotent. */
export function installOpencodeHost(): void {
  setHostCapabilities({
    getAgentDir: opencodeAgentDir,
    projectConfigDirName: '.opencode',
    dataDirName: 'pi-shepherd',
    parseFrontmatter: parseOpencodeFrontmatter,
  });
}
