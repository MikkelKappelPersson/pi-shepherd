/**
 * One-time farewell notice for the `@luminascale/pi-shepherd` package name.
 *
 * Host-neutral: the marker lives in the active host's user data directory, so
 * Pi and OpenCode each show the notice once. Child sheep processes never see
 * it — they load the same package but must not receive human-facing release
 * messaging.
 */

import fs from 'node:fs';
import path from 'node:path';
import { hostCapabilities } from './host.ts';

export const NEW_PACKAGE_NAME = '@luminascale/shepherd';

export const MIGRATION_NOTICE =
  `Shepherd is moving to ${NEW_PACKAGE_NAME}. ` +
  'This is the last release under @luminascale/pi-shepherd. ' +
  'When you are ready, install @luminascale/shepherd: settings, agent definitions, ' +
  'registrations, and fieldnotes carry over automatically.';

const MARKER_FILE = 'migration-notice.json';

/** True inside a launched child (Pi or OpenCode capability prefix). */
export function isChildShepherdProcess(): boolean {
  return Boolean(process.env.PI_SHEPHERD_SESSION || process.env.SHEPHERD_TASK_ID);
}

export function migrationMarkerFile(): string {
  const host = hostCapabilities();
  return path.join(host.getAgentDir(), host.dataDirName, MARKER_FILE);
}

/**
 * Return the notice exactly once per host user, never in a child process.
 * The marker is created with an exclusive write so concurrent sessions race
 * safely: only one of them receives the text.
 */
export function migrationNoticeOnce(): string | undefined {
  if (isChildShepherdProcess()) return undefined;
  const file = migrationMarkerFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ shownAt: new Date().toISOString(), newName: NEW_PACKAGE_NAME }, null, 2),
      { flag: 'wx' }
    );
  } catch (error: any) {
    if (error?.code === 'EEXIST') return undefined;
    // A read-only or full disk must not break the host session.
    return undefined;
  }
  return MIGRATION_NOTICE;
}
