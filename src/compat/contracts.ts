import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename as pathBasename, isAbsolute, resolve } from 'node:path';

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const DEFAULT_MAX_DEPTH = 2;
export const MAX_RESULT_CHARS = 50 * 1024;

export interface CompatibilityTask {
  agent: string;
  task: string;
  cwd?: string;
  isolate?: boolean;
  writes?: boolean;
}

export interface OwnershipConflict {
  path: string;
  tasks: number[];
  agents: string[];
}

const EXTENSIONS =
  'ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|lua|luau|sh|bash|zsh|json|jsonc|yaml|yml|toml|ini|cfg|conf|sql|md|mdx|rst|txt|csv|xml|html|css|scss|proto|tf|tfvars|mod|sum';
const BARE_NAMES = 'Makefile|Dockerfile|Justfile|Rakefile|LICENSE|CHANGELOG|Procfile|Gemfile';
const FILE_LIKE = new RegExp(
  `(?:^|[\\s"'\`(\\[*])((?:(?:~/|(?:\\.\\./)+|\\./)?[\\w/-]+(?:[./][\\w-]+)*\\.(?:${EXTENSIONS}))|(?:(?:~/|(?:\\.\\./)+|\\./)?(?:[\\w./-]*/)?(?:${BARE_NAMES})))(?=$|[\\s"'\`),\\].:;!?*])`,
  'g'
);
const WRITE_VERB =
  /\b(?:edit|edits|editing|write|writes|writing|create|creates|creating|update|updates|updating|modify|modifies|modifying|change|changes|changing|rename|renames|renaming|patch|patches|patching|refactor|refactors|refactoring|implement|implements|implementing|add|adds|adding|append|appends|appending|delete|deletes|deleting|remove|removes|removing|fix|fixes|fixing|rewrite|rewrites|rewriting|port|ports|porting|move|moves|moving|touch|wire|wires|wiring)\b/gi;
const NEGATED_VERB =
  /\b(?:do\s+not|don'?t|never|avoid|without|no\s+need\s+to|must\s+not|cannot|can'?t|should\s+not|shouldn'?t|refrain\s+from|leave|skip)\b[\s,:-]*(?:\w+[\s,:-]+){0,4}$/i;
const VERB_WINDOW = 120;

function negatedAt(text: string, index: number): boolean {
  return NEGATED_VERB.test(text.slice(Math.max(0, index - 40), index));
}

export function normalizePath(raw: string): string {
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return resolve(homedir(), raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : raw;
}

export function ownedPaths(text: string): string[] {
  const verbs = [...text.matchAll(WRITE_VERB)].map(match => {
    const index = match.index ?? 0;
    return { end: index + match[0].length, negated: negatedAt(text, index) };
  });
  if (verbs.length === 0) return [];
  const paths = new Set<string>();
  for (const match of text.matchAll(FILE_LIKE)) {
    const index = match.index ?? 0;
    let nearest: { end: number; negated: boolean } | undefined;
    for (const verb of verbs) {
      if (verb.end > index || index - verb.end > VERB_WINDOW) continue;
      if (!nearest || verb.end > nearest.end) nearest = verb;
    }
    if (!nearest || nearest.negated) continue;
    const normalized = normalizePath(match[1]);
    if (normalized) paths.add(normalized);
  }
  return [...paths];
}

function canonicalPath(file: string, cwd: string): string {
  let absolute: string;
  if (file === '~') {
    absolute = homedir();
  } else if (file.startsWith('~/')) {
    absolute = resolve(homedir(), file.slice(2));
  } else if (isAbsolute(file)) {
    absolute = resolve(file);
  } else {
    absolute = resolve(cwd, file);
  }
  let existing = absolute;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = resolve(existing, '..');
    if (parent === existing) break;
    suffix.unshift(pathBasename(existing));
    existing = parent;
  }
  try {
    const base = realpathSync(existing);
    return suffix.length > 0 ? resolve(base, ...suffix) : base;
  } catch {
    return absolute;
  }
}

export function findOwnershipConflicts(
  tasks: readonly CompatibilityTask[],
  defaultCwd: string
): OwnershipConflict[] {
  const owners = tasks.map((task, index) => {
    const cwd = resolve(task.cwd ?? defaultCwd);
    const paths = task.writes === false
      ? []
      : ownedPaths(task.task).filter(file => {
          if (!task.isolate) return true;
          if (isAbsolute(file) || file === '~' || file.startsWith('~/')) return true;
          const absolute = canonicalPath(file, cwd);
          return absolute !== cwd && !absolute.startsWith(`${cwd}/`);
        });
    return { index, agent: task.agent, cwd, paths };
  });
  const conflicts: OwnershipConflict[] = [];
  for (let left = 0; left < owners.length; left++) {
    for (let right = left + 1; right < owners.length; right++) {
      const leftOwner = owners[left];
      const rightOwner = owners[right];
      const overlap = leftOwner.paths.find(leftPath =>
        rightOwner.paths.some(
          rightPath =>
            canonicalPath(leftPath, leftOwner.cwd) === canonicalPath(rightPath, rightOwner.cwd)
        )
      );
      if (!overlap) continue;
      conflicts.push({
        path: overlap,
        tasks: [leftOwner.index, rightOwner.index],
        agents: [leftOwner.agent, rightOwner.agent],
      });
    }
  }
  return conflicts;
}

export function ownershipRefusal(conflicts: readonly OwnershipConflict[]): string {
  return [
    'Delegation refused: parallel implementers would edit the same file.',
    ...conflicts.map(
      conflict =>
        `  ${conflict.path} — tasks ${conflict.tasks.map(index => index + 1).join(' and ')} (${conflict.agents.join(', ')})`
    ),
    'Give each task disjoint files, use chain mode, or isolate the conflicting tasks.',
  ].join('\n');
}

export function configuredDepth(env: NodeJS.ProcessEnv = process.env): {
  depth: number;
  maxDepth: number;
} {
  const parsedDepth = Number.parseInt(env.PI_SUBAGENT_DEPTH ?? '0', 10);
  const parsedMaximum = Number.parseInt(env.PI_SUBAGENT_MAX_DEPTH ?? '', 10);
  return {
    depth: Number.isFinite(parsedDepth) && parsedDepth >= 0 ? parsedDepth : 0,
    maxDepth:
      Number.isFinite(parsedMaximum) && parsedMaximum >= 1 ? parsedMaximum : DEFAULT_MAX_DEPTH,
  };
}

export function assertDepthAvailable(env: NodeJS.ProcessEnv = process.env): number {
  const { depth, maxDepth } = configuredDepth(env);
  if (depth >= maxDepth) {
    throw new Error(`Delegation refused: already at subagent depth ${depth} of ${maxDepth}.`);
  }
  return depth + 1;
}

export async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      if (signal?.aborted) throw new Error('Subagent was aborted.');
      const index = next++;
      if (index >= items.length) return;
      output[index] = await run(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker())
  );
  return output;
}

export function interpolatePrevious(task: string, previous: string): string {
  return task.replace(/\{previous\}/g, () => previous);
}

export function truncateResult(text: string, maximum = MAX_RESULT_CHARS): string {
  if (text.length <= maximum) return text;
  const omitted = text.length - maximum;
  return `${text.slice(0, maximum)}\n\n[Output truncated: ${omitted} characters omitted; full output remains in the Shepherd session artifact.]`;
}
