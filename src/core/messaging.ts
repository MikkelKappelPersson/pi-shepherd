/**
 * Parent-owned filesystem mailbox for asynchronous Shepherd messages.
 *
 * This module is deliberately independent of Pi and Herdr. The parent creates
 * a session broker, registers child identities, and passes each child a
 * capability for its own inbox. Envelopes are published with an atomic
 * temporary-file-plus-rename operation and consumed exactly once per broker
 * session through acknowledgement markers.
 */
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type ShepherdEnvelopeKind = 'message' | 'task' | 'reply' | 'task_done' | 'runtime';
export type ShepherdDelivery = 'followUp' | 'steer';
export type ShepherdMessageStatus = 'completed' | 'blocked' | 'failed';

export interface ShepherdMessageEnvelope {
  schemaVersion: 1;
  sessionId: string;
  brokerId: string;
  kind: ShepherdEnvelopeKind;
  messageId: string;
  senderId: string;
  targetId: string;
  taskId?: string;
  threadId?: string;
  replyTo?: string;
  expectsReply?: boolean;
  deadlineAt?: number;
  delivery: ShepherdDelivery;
  content?: string;
  status?: ShepherdMessageStatus;
  summary?: string;
  error?: string;
  createdAt: number;
}

export type ShepherdEnvelopeInput = Omit<
  ShepherdMessageEnvelope,
  'schemaVersion' | 'sessionId' | 'brokerId' | 'messageId' | 'senderId' | 'createdAt'
> & {
  messageId?: string;
  createdAt?: number;
};

export interface BrokerOptions {
  /** Use a deterministic test/runtime path instead of a generated temp path. */
  rootDir?: string;
  maxMessageBytes?: number;
  maxContentLength?: number;
  maxQueueDepth?: number;
  parentId?: string;
};

export interface ChildCapability {
  sessionId: string;
  brokerId: string;
  agentId: string;
  token: string;
  inboxPath: string;
}

export interface PublishResult {
  accepted: true;
  messageId: string;
  delivery: 'queued' | 'duplicate';
}

export interface ParentBroker {
  readonly rootDir: string;
  readonly sessionId: string;
  readonly brokerId: string;
  readonly parentId: string;
  readonly parentInboxPath: string;
  readonly maxMessageBytes: number;
  readonly maxContentLength: number;
  readonly maxQueueDepth: number;
  readonly children: Map<string, ChildCapability>;
  closed: boolean;
}

export interface ChildBroker {
  readonly rootDir: string;
  readonly sessionId: string;
  readonly brokerId: string;
  readonly parentId: string;
  readonly agentId: string;
  readonly capability: ChildCapability;
  readonly maxMessageBytes: number;
  readonly maxContentLength: number;
  readonly maxQueueDepth: number;
  closed: boolean;
}

export type MessagingErrorCode =
  | 'broker_closed'
  | 'invalid_envelope'
  | 'foreign_session'
  | 'invalid_sender'
  | 'invalid_target'
  | 'invalid_capability'
  | 'queue_full'
  | 'message_too_large'
  | 'duplicate_conflict'
  | 'children_alive';

export class MessagingError extends Error {
  readonly code: MessagingErrorCode;

  constructor(code: MessagingErrorCode, message: string) {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
  }
}

const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_MAX_CONTENT_LENGTH = 50_000;
const DEFAULT_MAX_QUEUE_DEPTH = 1_000;
const ENVELOPE_KINDS = new Set<ShepherdEnvelopeKind>([
  'message',
  'task',
  'reply',
  'task_done',
  'runtime',
]);
const DELIVERIES = new Set<ShepherdDelivery>(['followUp', 'steer']);
const STATUSES = new Set<ShepherdMessageStatus>(['completed', 'blocked', 'failed']);

function ensureDirectory(directory: string, mode = 0o700): void {
  fs.mkdirSync(directory, { recursive: true, mode });
  try {
    fs.chmodSync(directory, mode);
  } catch {
    // Windows and some mounted filesystems do not support chmod reliably.
  }
}

function childDirectoryName(agentId: string): string {
  return createHash('sha256').update(agentId).digest('hex').slice(0, 32);
}

function messageFileName(envelope: ShepherdMessageEnvelope): string {
  const stamp = String(Math.max(0, Math.floor(envelope.createdAt))).padStart(16, '0');
  return `${stamp}-${childDirectoryName(envelope.messageId)}.json`;
}

function markerName(messageId: string): string {
  return `${childDirectoryName(messageId)}.ack`;
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MessagingError('invalid_envelope', `${field} must be a non-empty string.`);
  }
}

function assertSafeLimit(value: number | undefined, fallback: number, field: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) {
    throw new MessagingError('invalid_envelope', `${field} must be a positive integer.`);
  }
  return result;
}

/** Validate a decoded envelope before it reaches a routing handler. */
export function validateEnvelope(value: unknown): ShepherdMessageEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MessagingError('invalid_envelope', 'Message envelope must be a JSON object.');
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.schemaVersion !== 1) {
    throw new MessagingError('invalid_envelope', 'Unsupported message envelope schema version.');
  }
  assertNonEmptyString(envelope.sessionId, 'sessionId');
  assertNonEmptyString(envelope.brokerId, 'brokerId');
  assertNonEmptyString(envelope.kind, 'kind');
  if (!ENVELOPE_KINDS.has(envelope.kind as ShepherdEnvelopeKind)) {
    throw new MessagingError('invalid_envelope', `Unsupported message kind "${envelope.kind}".`);
  }
  assertNonEmptyString(envelope.messageId, 'messageId');
  assertNonEmptyString(envelope.senderId, 'senderId');
  assertNonEmptyString(envelope.targetId, 'targetId');
  if (!DELIVERIES.has(envelope.delivery as ShepherdDelivery)) {
    throw new MessagingError('invalid_envelope', 'delivery must be followUp or steer.');
  }
  if (typeof envelope.createdAt !== 'number' || !Number.isFinite(envelope.createdAt)) {
    throw new MessagingError('invalid_envelope', 'createdAt must be a finite number.');
  }
  if (envelope.deadlineAt !== undefined &&
    (typeof envelope.deadlineAt !== 'number' || !Number.isFinite(envelope.deadlineAt))) {
    throw new MessagingError('invalid_envelope', 'deadlineAt must be a finite number when present.');
  }
  for (const field of ['taskId', 'threadId', 'replyTo', 'content', 'summary', 'error']) {
    if (envelope[field] !== undefined && typeof envelope[field] !== 'string') {
      throw new MessagingError('invalid_envelope', `${field} must be a string when present.`);
    }
  }
  if (envelope.expectsReply !== undefined && typeof envelope.expectsReply !== 'boolean') {
    throw new MessagingError('invalid_envelope', 'expectsReply must be a boolean when present.');
  }
  if (envelope.status !== undefined && !STATUSES.has(envelope.status as ShepherdMessageStatus)) {
    throw new MessagingError('invalid_envelope', `Unsupported message status "${envelope.status}".`);
  }
  return { ...(value as ShepherdMessageEnvelope) };
}

/** Build a complete envelope for one broker participant. */
export function createEnvelope(
  context: { sessionId: string; brokerId: string; senderId: string },
  input: ShepherdEnvelopeInput
): ShepherdMessageEnvelope {
  assertNonEmptyString(context.sessionId, 'sessionId');
  assertNonEmptyString(context.brokerId, 'brokerId');
  assertNonEmptyString(context.senderId, 'senderId');
  const envelope = {
    ...input,
    schemaVersion: 1 as const,
    sessionId: context.sessionId,
    brokerId: context.brokerId,
    senderId: context.senderId,
    messageId: input.messageId ?? `shepherd-message-${randomUUID()}`,
    createdAt: input.createdAt ?? Date.now(),
  };
  return validateEnvelope(envelope);
}

function brokerManifest(broker: ParentBroker): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sessionId: broker.sessionId,
    brokerId: broker.brokerId,
    parentId: broker.parentId,
    maxMessageBytes: broker.maxMessageBytes,
    maxContentLength: broker.maxContentLength,
    maxQueueDepth: broker.maxQueueDepth,
    createdAt: Date.now(),
  };
}

function writeJsonAtomic(target: string, value: unknown): void {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    throw error;
  }
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function inboxFiles(inboxPath: string): string[] {
  try {
    return fs.readdirSync(inboxPath)
      .filter(name => name.endsWith('.json'))
      .sort()
      .map(name => path.join(inboxPath, name));
  } catch {
    return [];
  }
}

function ackPath(broker: ParentBroker | ChildBroker, messageId: string): string {
  return path.join(broker.rootDir, 'acks', markerName(messageId));
}

function isAcknowledged(broker: ParentBroker | ChildBroker, messageId: string): boolean {
  return fs.existsSync(ackPath(broker, messageId));
}

function acknowledgeEnvelope(broker: ParentBroker | ChildBroker, envelope: ShepherdMessageEnvelope): void {
  const target = ackPath(broker, envelope.messageId);
  if (!fs.existsSync(target)) {
    writeJsonAtomic(target, {
      messageId: envelope.messageId,
      targetId: envelope.targetId,
      acknowledgedAt: Date.now(),
    });
  }
}

function assertBrokerOpen(broker: ParentBroker | ChildBroker): void {
  if (broker.closed) throw new MessagingError('broker_closed', 'Messaging broker is closed.');
}

function assertBrokerIdentity(
  broker: ParentBroker | ChildBroker,
  envelope: ShepherdMessageEnvelope
): void {
  if (envelope.sessionId !== broker.sessionId || envelope.brokerId !== broker.brokerId) {
    throw new MessagingError(
      'foreign_session',
      `Envelope "${envelope.messageId}" belongs to another Shepherd broker session.`
    );
  }
}

function queuePathForChild(broker: ParentBroker, targetId: string): string {
  const child = broker.children.get(targetId);
  if (!child) throw new MessagingError('invalid_target', `Unknown child target "${targetId}".`);
  return child.inboxPath;
}

function queuePathForChildConnection(child: ChildBroker, targetId: string): string {
  if (targetId === child.parentId || targetId === 'shepherd' || targetId === 'parent') {
    return path.join(child.rootDir, 'parent', 'inbox');
  }
  const manifestPath = path.join(child.rootDir, 'agents', childDirectoryName(targetId), 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new MessagingError('invalid_target', `Unknown child target "${targetId}".`);
  }
  return path.join(child.rootDir, 'agents', childDirectoryName(targetId), 'inbox');
}

function publishToQueue(
  broker: ParentBroker | ChildBroker,
  inboxPath: string,
  envelope: ShepherdMessageEnvelope
): PublishResult {
  assertBrokerOpen(broker);
  const encoded = Buffer.from(JSON.stringify(envelope), 'utf8');
  const maxBytes = broker.maxMessageBytes;
  const maxContentLength = broker.maxContentLength;
  const maxQueueDepth = broker.maxQueueDepth;
  if (typeof envelope.content === 'string' && envelope.content.length > maxContentLength) {
    throw new MessagingError(
      'message_too_large',
      `Message "${envelope.messageId}" content exceeds the ${maxContentLength}-character limit.`
    );
  }
  if (encoded.byteLength > maxBytes) {
    throw new MessagingError(
      'message_too_large',
      `Message "${envelope.messageId}" is ${encoded.byteLength} bytes; maximum is ${maxBytes}.`
    );
  }
  ensureDirectory(inboxPath);
  if (isAcknowledged(broker, envelope.messageId)) {
    return { accepted: true, messageId: envelope.messageId, delivery: 'duplicate' };
  }
  const files = inboxFiles(inboxPath);
  const target = path.join(inboxPath, messageFileName(envelope));
  if (files.length >= maxQueueDepth && !files.includes(target)) {
    throw new MessagingError('queue_full', `Message queue for "${envelope.targetId}" is full.`);
  }
  if (fs.existsSync(target)) {
    let existing: ShepherdMessageEnvelope | undefined;
    try {
      existing = validateEnvelope(readJson(target));
    } catch {
      throw new MessagingError('duplicate_conflict', `Message file for "${envelope.messageId}" is invalid.`);
    }
    if (JSON.stringify(existing) !== JSON.stringify(envelope)) {
      throw new MessagingError('duplicate_conflict', `Message id "${envelope.messageId}" is already in use.`);
    }
    return { accepted: true, messageId: envelope.messageId, delivery: 'duplicate' };
  }
  const temporary = path.join(inboxPath, `.${messageFileName(envelope)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, encoded, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    throw error;
  }
  return { accepted: true, messageId: envelope.messageId, delivery: 'queued' };
}

function pollQueue(
  broker: ParentBroker | ChildBroker,
  inboxPath: string,
  expectedTarget: string,
  limit = Number.MAX_SAFE_INTEGER
): ShepherdMessageEnvelope[] {
  assertBrokerOpen(broker);
  const processedPath = path.join(broker.rootDir, 'processed');
  const rejectedPath = path.join(broker.rootDir, 'rejected');
  ensureDirectory(processedPath);
  ensureDirectory(rejectedPath);
  const messages: ShepherdMessageEnvelope[] = [];
  for (const filePath of inboxFiles(inboxPath).slice(0, limit)) {
    let envelope: ShepherdMessageEnvelope;
    try {
      envelope = validateEnvelope(readJson(filePath));
      assertBrokerIdentity(broker, envelope);
      if (envelope.targetId !== expectedTarget &&
        !(expectedTarget === broker.parentId && ['shepherd', 'parent'].includes(envelope.targetId))) {
        throw new MessagingError('invalid_target', `Envelope target "${envelope.targetId}" does not match this inbox.`);
      }
    } catch {
      try {
        fs.renameSync(filePath, path.join(rejectedPath, `${path.basename(filePath)}.${randomUUID()}`));
      } catch {}
      continue;
    }
    if (isAcknowledged(broker, envelope.messageId)) {
      try { fs.rmSync(filePath, { force: true }); } catch {}
      continue;
    }
    try {
      fs.renameSync(filePath, path.join(processedPath, `${path.basename(filePath)}.${randomUUID()}`));
      acknowledgeEnvelope(broker, envelope);
      messages.push(envelope);
    } catch {
      // Leave a failed file for a later poll where possible. A duplicate
      // envelope is safe because handlers are required to be idempotent.
    }
  }
  return messages;
}

/** Create the parent broker and its protected inbox structure. */
export function createParentBroker(sessionOwner: string, options: BrokerOptions = {}): ParentBroker {
  assertNonEmptyString(sessionOwner, 'sessionOwner');
  const rootDir = options.rootDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-broker-'));
  ensureDirectory(rootDir);
  const parentInboxPath = path.join(rootDir, 'parent', 'inbox');
  ensureDirectory(parentInboxPath);
  ensureDirectory(path.join(rootDir, 'agents'));
  ensureDirectory(path.join(rootDir, 'acks'));
  ensureDirectory(path.join(rootDir, 'processed'));
  ensureDirectory(path.join(rootDir, 'rejected'));
  const broker: ParentBroker = {
    rootDir,
    sessionId: sessionOwner,
    brokerId: `shepherd-broker-${randomUUID()}`,
    parentId: options.parentId ?? 'shepherd',
    parentInboxPath,
    maxMessageBytes: assertSafeLimit(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, 'maxMessageBytes'),
    maxContentLength: assertSafeLimit(options.maxContentLength, DEFAULT_MAX_CONTENT_LENGTH, 'maxContentLength'),
    maxQueueDepth: assertSafeLimit(options.maxQueueDepth, DEFAULT_MAX_QUEUE_DEPTH, 'maxQueueDepth'),
    children: new Map(),
    closed: false,
  };
  writeJsonAtomic(path.join(rootDir, 'broker.json'), brokerManifest(broker));
  return broker;
}

/** Register one child and create its capability-protected inbox. */
export function registerChild(broker: ParentBroker, agentId: string): ChildCapability {
  assertBrokerOpen(broker);
  assertNonEmptyString(agentId, 'agentId');
  if (agentId === broker.parentId || ['parent', 'shepherd'].includes(agentId)) {
    throw new MessagingError('invalid_sender', `Child id "${agentId}" is reserved for the parent.`);
  }
  const existing = broker.children.get(agentId);
  if (existing) return { ...existing };
  const directory = path.join(broker.rootDir, 'agents', childDirectoryName(agentId));
  const inboxPath = path.join(directory, 'inbox');
  ensureDirectory(inboxPath);
  const capability: ChildCapability = {
    sessionId: broker.sessionId,
    brokerId: broker.brokerId,
    agentId,
    token: randomUUID(),
    inboxPath,
  };
  writeJsonAtomic(path.join(directory, 'manifest.json'), capability);
  broker.children.set(agentId, capability);
  return { ...capability };
}

/** Remove a child registration only after its process/pane is confirmed gone. */
export function unregisterChild(broker: ParentBroker, agentId: string): void {
  assertBrokerOpen(broker);
  const child = broker.children.get(agentId);
  if (!child) return;
  broker.children.delete(agentId);
  const directory = path.join(broker.rootDir, 'agents', childDirectoryName(agentId));
  fs.rmSync(directory, { recursive: true, force: true });
}

/** Rehydrate a child-side broker from launch-time identity and capability data. */
export function createChildBroker(input: ChildCapability & { rootDir: string }): ChildBroker {
  const brokerFile = path.join(input.rootDir, 'broker.json');
  let manifest: any;
  try {
    manifest = readJson(brokerFile);
  } catch {
    throw new MessagingError('invalid_capability', 'Parent broker manifest is unavailable.');
  }
  if (manifest.sessionId !== input.sessionId || manifest.brokerId !== input.brokerId) {
    throw new MessagingError('foreign_session', 'Child capability belongs to another broker session.');
  }
  const directory = path.join(input.rootDir, 'agents', childDirectoryName(input.agentId));
  let stored: any;
  try {
    stored = readJson(path.join(directory, 'manifest.json'));
  } catch {
    throw new MessagingError('invalid_capability', 'Child capability manifest is unavailable.');
  }
  if (stored.agentId !== input.agentId || stored.token !== input.token || stored.inboxPath !== input.inboxPath) {
    throw new MessagingError('invalid_capability', 'Child capability does not match its registered inbox.');
  }
  return {
    rootDir: input.rootDir,
    sessionId: input.sessionId,
    brokerId: input.brokerId,
    parentId: typeof manifest.parentId === 'string' ? manifest.parentId : 'shepherd',
    agentId: input.agentId,
    capability: { ...input },
    maxMessageBytes: assertSafeLimit(manifest.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, 'maxMessageBytes'),
    maxContentLength: assertSafeLimit(manifest.maxContentLength, DEFAULT_MAX_CONTENT_LENGTH, 'maxContentLength'),
    maxQueueDepth: assertSafeLimit(manifest.maxQueueDepth, DEFAULT_MAX_QUEUE_DEPTH, 'maxQueueDepth'),
    closed: false,
  };
}

export function publishFromParent(
  broker: ParentBroker,
  envelope: ShepherdMessageEnvelope
): PublishResult {
  assertBrokerOpen(broker);
  const valid = validateEnvelope(envelope);
  assertBrokerIdentity(broker, valid);
  if (valid.senderId !== broker.parentId) {
    throw new MessagingError('invalid_sender', `Parent envelopes must be sent by "${broker.parentId}".`);
  }
  if (valid.targetId === broker.parentId || ['parent', 'shepherd'].includes(valid.targetId)) {
    throw new MessagingError('invalid_target', 'Parent messages cannot target the parent inbox.');
  }
  return publishToQueue(broker, queuePathForChild(broker, valid.targetId), valid);
}

export function publishFromChild(
  child: ChildBroker,
  envelope: ShepherdMessageEnvelope
): PublishResult {
  assertBrokerOpen(child);
  const valid = validateEnvelope(envelope);
  assertBrokerIdentity(child, valid);
  if (valid.senderId !== child.agentId) {
    throw new MessagingError('invalid_sender', `Child envelopes must be sent by "${child.agentId}".`);
  }
  return publishToQueue(child, queuePathForChildConnection(child, valid.targetId), valid);
}

export function pollParentInbox(broker: ParentBroker, limit?: number): ShepherdMessageEnvelope[] {
  return pollQueue(broker, broker.parentInboxPath, broker.parentId, limit);
}

export function pollChildInbox(child: ChildBroker, limit?: number): ShepherdMessageEnvelope[] {
  return pollQueue(child, child.capability.inboxPath, child.agentId, limit);
}

/** Explicitly acknowledge an envelope; polling already performs this operation. */
export function acknowledge(
  broker: ParentBroker | ChildBroker,
  envelope: ShepherdMessageEnvelope
): void {
  assertBrokerOpen(broker);
  validateEnvelope(envelope);
  assertBrokerIdentity(broker, envelope);
  acknowledgeEnvelope(broker, envelope);
}

/**
 * Remove a session mailbox only after the caller confirms all child panes are
 * gone. The callback is intentionally supplied by the Herdr integration so
 * this transport layer never guesses whether a child process still exists.
 */
export function closeBrokerWhenChildrenGone(
  broker: ParentBroker,
  childrenGone: () => boolean = () => broker.children.size === 0
): boolean {
  if (broker.closed) return true;
  if (!childrenGone()) return false;
  broker.closed = true;
  fs.rmSync(broker.rootDir, { recursive: true, force: true });
  return true;
}
