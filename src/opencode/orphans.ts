/**
 * Orphan detection and reap for the OpenCode adapter (spec 013 reload item).
 *
 * A plugin reload/server restart loses all module-local SheepRecords while
 * the Herdr panes/hc terminals and their on-disk ownership registries survive.
 * Rather than pretend those sheep are still manageable, surface them once and
 * offer an explicit, ownership-checked reap. Native pane/terminal ids are
 * never accepted from a tool argument; they come only from the registry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { hostCapabilities } from '../core/host.ts';
import {
  forgetOwnedPane,
  herdrExecSync,
  loadCreatedPanes,
  paneExists,
  pruneStaleCreatedPanes,
} from '../runtimes/herdr/herdr.ts';
import {
  forgetOwnedTerminal,
  killHcTerminal,
  loadCreatedTerminals,
  pruneStaleCreatedTerminals,
  terminalExists,
} from '../runtimes/hc/hc.ts';
import { isManagedTransport } from './bridge.ts';
import { displayCommandOutput } from './display.ts';

export interface Orphan {
  transportId: string;
  name: string;
  cwd: string;
  ownerSession?: string;
  backend: 'herdr' | 'hc';
}

function markerFile(): string {
  const host = hostCapabilities();
  return path.join(host.getAgentDir(), host.dataDirName, 'orphan-notices.json');
}

function readMarker(): Record<string, string[]> {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerFile(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeMarker(marker: Record<string, string[]>): void {
  try {
    const file = markerFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(marker, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* notice tracking is best effort */
  }
}

/** Live owned transports that no in-memory SheepRecord currently manages. */
export function findOrphans(sessionId?: string): Orphan[] {
  pruneStaleCreatedPanes();
  pruneStaleCreatedTerminals();
  const owned = (owner?: string): boolean =>
    !sessionId || owner === sessionId || owner === undefined;
  const orphans: Orphan[] = [];
  for (const entry of loadCreatedPanes()) {
    if (owned(entry.ownerSession) && paneExists(entry.paneId) && !isManagedTransport(entry.paneId)) {
      orphans.push({
        transportId: entry.paneId,
        name: entry.name,
        cwd: entry.cwd,
        ownerSession: entry.ownerSession,
        backend: 'herdr',
      });
    }
  }
  for (const entry of loadCreatedTerminals()) {
    if (
      owned(entry.ownerSession) &&
      terminalExists(entry.terminalId) &&
      !isManagedTransport(entry.terminalId)
    ) {
      orphans.push({
        transportId: entry.terminalId,
        name: entry.name,
        cwd: entry.cwd,
        ownerSession: entry.ownerSession,
        backend: 'hc',
      });
    }
  }
  return orphans;
}

/** One display-only notice per previously unreported orphan set. */
export async function noticeNewOrphans(ctx: any): Promise<void> {
  const orphans = findOrphans();
  if (orphans.length === 0) return;
  const marker = readMarker();
  const byOwner = new Map<string, Orphan[]>();
  for (const orphan of orphans) {
    const owner = orphan.ownerSession ?? '';
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), orphan]);
  }
  for (const [owner, entries] of byOwner) {
    if (!owner) continue;
    const seen = new Set(marker[owner] ?? []);
    const fresh = entries.filter(entry => !seen.has(entry.transportId));
    if (fresh.length === 0) continue;
    const lines = [
      'Shepherd restarted while some sheep were still running. Their opaque ids were lost, so they cannot be delegated to or closed until reaped.',
      `Orphaned sheep (${fresh.length}):`,
      ...fresh.map(entry =>
        `- ${entry.name} (${entry.backend}) cwd ${entry.cwd}`.trimEnd()
      ),
      'Use the shepherd tool with action "reap" to close them, or respawn and close the old panes manually. Fieldnotes and queued envelopes remain on disk.',
    ];
    try {
      await displayCommandOutput(ctx, owner, lines.join('\n'));
      marker[owner] = [...seen, ...fresh.map(entry => entry.transportId)];
      writeMarker(marker);
    } catch {
      /* host may not have this session any more; try again next startup */
    }
  }
}

/** Close live but unmanaged owned transports, then drop their registrations. */
export function reapOrphans(sessionId?: string): string {
  const orphans = findOrphans(sessionId);
  if (orphans.length === 0) return 'No orphaned sheep to reap.';
  const reaped: string[] = [];
  const failed: string[] = [];
  for (const orphan of orphans) {
    let closed = false;
    try {
      if (orphan.backend === 'herdr') {
        herdrExecSync(['pane', 'close', orphan.transportId]);
        closed = !paneExists(orphan.transportId);
        if (closed) forgetOwnedPane(orphan.transportId, sessionId);
      } else {
        killHcTerminal(orphan.transportId);
        closed = !terminalExists(orphan.transportId);
        if (closed) forgetOwnedTerminal(orphan.transportId, sessionId);
      }
    } catch {
      closed = false;
    }
    (closed ? reaped : failed).push(orphan.name || orphan.transportId);
  }
  const lines = [`reaped ${reaped.length} orphaned sheep.`, ...reaped.map(name => `- ${name}`)];
  if (failed.length) {
    lines.push(`could not close ${failed.length}:`, ...failed.map(name => `- ${name}`));
  }
  return lines.join('\n');
}
