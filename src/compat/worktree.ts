import { execFileSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import type { CompatibilityTask } from './contracts.ts';

export interface WorktreeLease {
  index: number;
  agent: string;
  clone: string;
  baseRev: string;
  path: string;
  cwd: string;
  branch: string;
  /** Set when child termination could not be confirmed; such a worktree is never removed. */
  retain?: boolean;
}

export interface WorktreeOutcome {
  lease: WorktreeLease;
  dirtyFiles: number;
  commits: number;
  removed: boolean;
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 20_000 }).trim();
}

export function checkoutOf(cwd: string): { checkout: string; common: string } | null {
  try {
    const checkout = git(['-C', cwd, 'rev-parse', '--show-toplevel']);
    const commonRaw = git(['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    return { checkout, common: resolve(commonRaw, '..') };
  } catch {
    return null;
  }
}

function slug(text: string, maximum = 24): string {
  const value = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return value.slice(0, maximum).replace(/-+$/, '') || 'task';
}

export function createWorktreeLeases(
  tasks: readonly CompatibilityTask[],
  defaultCwd: string,
  tag: string
): WorktreeLease[] {
  const leases: WorktreeLease[] = [];
  try {
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      if (!task.isolate) continue;
      const requestedCwd = realpathSync(resolve(task.cwd ?? defaultCwd));
      const checkout = checkoutOf(requestedCwd);
      if (!checkout) {
        throw new Error(
          `task ${index + 1} (${task.agent}) requested isolation, but ${requestedCwd} is not in a git checkout`
        );
      }
      const relativeCwd = relative(checkout.checkout, requestedCwd);
      if (relativeCwd.startsWith('..')) throw new Error(`cwd escaped checkout: ${requestedCwd}`);
      const baseRev = git(['-C', checkout.checkout, 'rev-parse', 'HEAD']);
      const container = join(dirname(checkout.common), `${basename(checkout.common)}-wt`);
      const name = `${tag}-t${index + 1}-${slug(task.task)}`;
      const worktreePath = join(container, name);
      const branch = `shepherd/${name}`;
      git(['-C', checkout.checkout, 'worktree', 'add', '-b', branch, worktreePath, baseRev]);
      leases.push({
        index,
        agent: task.agent,
        clone: checkout.checkout,
        baseRev,
        path: worktreePath,
        cwd: relativeCwd ? join(worktreePath, relativeCwd) : worktreePath,
        branch,
      });
    }
    return leases;
  } catch (error) {
    releaseWorktreeLeases(leases);
    throw error;
  }
}

function countLines(text: string): number {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean).length;
}

export function releaseWorktreeLeases(leases: readonly WorktreeLease[]): WorktreeOutcome[] {
  return leases.map(lease => {
    let dirtyFiles = 1;
    let commits = 1;
    try {
      dirtyFiles = countLines(git(['-C', lease.path, 'status', '--porcelain']));
    } catch {
      // Unknown state deliberately preserves the worktree.
    }
    try {
      const parsed = Number.parseInt(
        git(['-C', lease.path, 'rev-list', '--count', `${lease.baseRev}..HEAD`]),
        10
      );
      commits = Number.isFinite(parsed) ? parsed : 1;
    } catch {
      // Unknown state deliberately preserves the worktree.
    }
    let removed = false;
    let branchCommits = 1;
    let branchPointsAtHead = false;
    try {
      const branchHead = git(['-C', lease.clone, 'rev-parse', lease.branch]);
      const worktreeHead = git(['-C', lease.path, 'rev-parse', 'HEAD']);
      branchPointsAtHead = branchHead === worktreeHead;
      const parsed = Number.parseInt(
        git(['-C', lease.clone, 'rev-list', '--count', `${lease.baseRev}..${lease.branch}`]),
        10
      );
      branchCommits = Number.isFinite(parsed) ? parsed : 1;
    } catch {
      // Unknown branch state deliberately preserves the worktree and branch.
    }
    commits = Math.max(commits, branchCommits);
    if (!lease.retain && branchPointsAtHead && dirtyFiles === 0 && commits === 0) {
      try {
        git(['-C', lease.clone, 'worktree', 'remove', lease.path]);
        git(['-C', lease.clone, 'branch', '-D', lease.branch]);
        removed = true;
      } catch {
        removed = false;
      }
    }
    return { lease, dirtyFiles, commits, removed };
  });
}

export function worktreeSummary(outcomes: readonly WorktreeOutcome[]): string | undefined {
  const kept = outcomes.filter(outcome => !outcome.removed);
  if (kept.length === 0) return undefined;
  return [
    'Worktrees kept (integrate or discard these yourself):',
    ...kept.map(
      outcome =>
        `  task ${outcome.lease.index + 1} (${outcome.lease.agent}): ${outcome.lease.branch} @ ${outcome.lease.path} — ${outcome.commits} commit(s), ${outcome.dirtyFiles} uncommitted file(s)`
    ),
  ].join('\n');
}
