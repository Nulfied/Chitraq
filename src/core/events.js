/**
 * The event log: an append-only record of every meaningful change to memory.
 *
 * INVARIANT 43 (observability): for any piece of memory it must be possible to
 * answer what happened, when, who or what caused it, and what changed. Events
 * are never updated or deleted — corrections are new events.
 */

import { newEventId, now } from './ids.js';
import { stableStringify } from './ids.js';

/** Canonical event types. Adding one is cheap; renaming one is a migration. */
export const EventType = Object.freeze({
  KnowledgeCaptured: 'KnowledgeCaptured',
  KnowledgeUpdated: 'KnowledgeUpdated',
  KnowledgeArchived: 'KnowledgeArchived',
  KnowledgeDeleted: 'KnowledgeDeleted',
  KnowledgeRestored: 'KnowledgeRestored',
  KnowledgeSuperseded: 'KnowledgeSuperseded',
  KnowledgeConfirmed: 'KnowledgeConfirmed',
  KnowledgeRejected: 'KnowledgeRejected',
  RelationCreated: 'RelationCreated',
  RelationUpdated: 'RelationUpdated',
  RelationRetracted: 'RelationRetracted',
  EvidenceLinked: 'EvidenceLinked',
  SourceCaptured: 'SourceCaptured',
  ProposalCreated: 'ProposalCreated',
  ProposalAccepted: 'ProposalAccepted',
  ProposalRejected: 'ProposalRejected',
  ProposalInvalidated: 'ProposalInvalidated',
  CapabilityRun: 'CapabilityRun',
  ConflictDetected: 'ConflictDetected',
  ConflictResolved: 'ConflictResolved',
  QueryAsked: 'QueryAsked',
  ContextBuilt: 'ContextBuilt',
  UserCorrectionRecorded: 'UserCorrectionRecorded',
});

/**
 * @typedef {object} Actor
 * @property {string} id       principal id, or capability run id
 * @property {'user'|'system'|'capability'} kind
 */

/** The actor used for changes Chitraq makes on its own behalf. */
export const SYSTEM_ACTOR = Object.freeze({ id: 'system', kind: /** @type {const} */ ('system') });

/**
 * Append an event. Call inside the same transaction as the change it records,
 * so an event never describes a mutation that was rolled back.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} e
 * @param {string} e.workspaceId
 * @param {string} e.type
 * @param {string} [e.subjectKind]
 * @param {string} [e.subjectId]
 * @param {Actor} [e.actor]
 * @param {object} [e.payload]
 * @returns {string} event id
 */
export function emit(db, e) {
  const actor = e.actor ?? SYSTEM_ACTOR;
  const eventId = newEventId();
  db.prepare(
    `INSERT INTO event (id, workspace_id, type, subject_kind, subject_id, actor, actor_kind, payload, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventId,
    e.workspaceId,
    e.type,
    e.subjectKind ?? null,
    e.subjectId ?? null,
    actor.id,
    actor.kind,
    stableStringify(e.payload ?? {}),
    now()
  );
  return eventId;
}

/**
 * Read the event log, newest first.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {string} [opts.subjectId]  only events about this object/relation
 * @param {string[]} [opts.types]
 * @param {string} [opts.since]      ISO instant, exclusive
 * @param {string} [opts.until]      ISO instant, exclusive
 * @param {number} [opts.limit]
 * @returns {any[]}
 */
export function list(db, opts) {
  const where = ['workspace_id = ?'];
  const args = [opts.workspaceId];

  if (opts.subjectId) {
    where.push('subject_id = ?');
    args.push(opts.subjectId);
  }
  if (opts.types?.length) {
    where.push(`type IN (${opts.types.map(() => '?').join(',')})`);
    args.push(...opts.types);
  }
  if (opts.since) {
    where.push('at > ?');
    args.push(opts.since);
  }
  if (opts.until) {
    where.push('at < ?');
    args.push(opts.until);
  }

  const limit = Math.min(opts.limit ?? 100, 1000);
  const rows = db
    .prepare(`SELECT * FROM event WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ?`)
    .all(...args, limit);

  return rows.map((r) => ({ ...r, payload: safeParse(r.payload) }));
}

/**
 * @param {unknown} s
 * @returns {object}
 */
function safeParse(s) {
  try {
    return JSON.parse(/** @type {string} */ (s));
  } catch {
    return {};
  }
}
