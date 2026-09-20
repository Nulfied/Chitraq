/**
 * The proposal gateway: the single doorway between intelligence and memory.
 *
 * INVARIANT 8/10/11 in executable form. Nothing produced by a model reaches
 * `object` or `relation` by any other path. A capability produces a proposal;
 * the gateway validates it against deterministic rules; only then, and only
 * with an explicit accept, does it become state — carrying its provenance with
 * it, permanently.
 *
 *     capability -> proposal -> validation -> (accept) -> memory
 *                                  |
 *                                  +-> invalid / rejected, kept for the record
 *
 * A rejected proposal is not deleted. "The model suggested this and we said no"
 * is knowledge about the model and about the decision, and it is worth keeping.
 */

import { newProposalId, newConflictId, now, stableStringify } from '../core/ids.js';
import { tx, plain, plainAll } from '../core/db.js';
import { emit, EventType, SYSTEM_ACTOR } from '../core/events.js';
import * as objects from '../core/objects.js';
import * as relations from '../core/relations.js';
import * as sources from '../core/sources.js';
import { ValidationError } from '../core/objects.js';

/** Operations a proposal may request. Anything else is refused outright. */
export const Op = Object.freeze({
  CreateObject: 'create_object',
  UpdateObject: 'update_object',
  CreateRelation: 'create_relation',
  LinkEvidence: 'link_evidence',
  FlagConflict: 'flag_conflict',
  SetAttributes: 'set_attributes',
});

/**
 * Fields a proposal is permitted to change on an existing object.
 *
 * Note what is absent: origin, review, state, created_at, id, confidence of a
 * user assertion, and anything to do with permissions. A model may improve how
 * knowledge is *worded and classified*; it may not decide where knowledge came
 * from, whether a human approved it, or who can see it.
 */
const UPDATABLE_FIELDS = new Set(['title', 'body', 'attrs', 'kind', 'epistemic', 'occurredAt', 'validUntil']);

/**
 * Auto-accept policy.
 *
 * Default: nothing is auto-accepted except evidence links and conflict flags,
 * which are additive and non-destructive — they attach information to memory
 * without asserting anything new as true. Everything else waits for a human.
 *
 * Raising these thresholds is a deliberate choice the user makes, not a
 * default the system slips past them.
 */
export const DEFAULT_ACCEPT_POLICY = Object.freeze({
  autoAccept: {
    [Op.LinkEvidence]: 0.6,
    [Op.FlagConflict]: 0.5,
    [Op.CreateObject]: null,
    [Op.UpdateObject]: null,
    [Op.CreateRelation]: null,
    [Op.SetAttributes]: null,
  },
});

/**
 * Record a proposal. Always succeeds if the shape is storable — validation
 * failures are recorded as `invalid` rather than thrown away, so a
 * misbehaving provider is visible instead of silent.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @param {string} input.workspaceId
 * @param {string} input.op
 * @param {object} input.payload
 * @param {string} [input.runId]
 * @param {string} [input.rationale]
 * @param {number} [input.confidence]
 * @param {{autoAccept?: Record<string, number|null>}} [policy]
 * @param {import('../core/events.js').Actor} [actor]
 * @returns {{proposal: any, applied: any|null}}
 */
export function propose(db, input, policy = DEFAULT_ACCEPT_POLICY, actor = SYSTEM_ACTOR) {
  return tx(db, () => {
    const verdict = validate(db, input);

    const row = {
      id: newProposalId(),
      workspace_id: input.workspaceId,
      run_id: input.runId ?? null,
      op: input.op,
      payload: stableStringify(input.payload ?? {}),
      rationale: input.rationale ?? null,
      confidence: input.confidence ?? null,
      status: verdict.valid ? 'pending' : 'invalid',
      invalid_why: verdict.valid ? null : verdict.errors.join('; '),
      applied_kind: null,
      applied_id: null,
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
      created_at: now(),
    };

    db.prepare(
      `INSERT INTO proposal (id, workspace_id, run_id, op, payload, rationale, confidence, status,
                             invalid_why, applied_kind, applied_id, reviewed_by, reviewed_at,
                             review_note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.id, row.workspace_id, row.run_id, row.op, row.payload, row.rationale, row.confidence,
      row.status, row.invalid_why, null, null, null, null, null, row.created_at
    );

    emit(db, {
      workspaceId: row.workspace_id,
      type: verdict.valid ? EventType.ProposalCreated : EventType.ProposalInvalidated,
      subjectKind: 'proposal',
      subjectId: row.id,
      actor,
      payload: { op: row.op, confidence: row.confidence, invalidWhy: row.invalid_why },
    });

    if (!verdict.valid) return { proposal: row, applied: null };

    const threshold = policy?.autoAccept?.[input.op] ?? null;
    const eligible =
      threshold !== null && typeof input.confidence === 'number' && input.confidence >= threshold;

    if (eligible) {
      const applied = accept(db, row.id, { id: 'policy', kind: 'system' }, 'auto-accepted by policy');
      return { proposal: applied.proposal, applied: applied.applied };
    }

    return { proposal: row, applied: null };
  });
}

/**
 * Deterministic validation. This is the gate.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, op: string, payload: any, confidence?: number}} input
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validate(db, input) {
  /** @type {string[]} */
  const errors = [];
  const p = input.payload ?? {};

  if (!Object.values(Op).includes(input.op)) {
    return { valid: false, errors: [`Unknown operation "${input.op}"`] };
  }
  if (!input.workspaceId) errors.push('workspaceId is required');
  if (input.confidence !== undefined && input.confidence !== null) {
    const c = Number(input.confidence);
    if (Number.isNaN(c) || c < 0 || c > 1) errors.push('confidence must be between 0 and 1');
  }

  /** @param {string} id @param {string} label */
  const objectMustExist = (id, label) => {
    if (!id) {
      errors.push(`${label} is required`);
      return null;
    }
    const row = objects.getRaw(db, id);
    if (!row) {
      errors.push(`${label} ${id} does not exist`);
      return null;
    }
    if (row.workspace_id !== input.workspaceId) {
      errors.push(`${label} ${id} belongs to another workspace`);
      return null;
    }
    return row;
  };

  switch (input.op) {
    case Op.CreateObject: {
      if (!p.title || !String(p.title).trim()) errors.push('title is required');
      if (p.title && String(p.title).length > 500) errors.push('title is unreasonably long');
      if (p.epistemic && !Object.values(objects.Epistemic).includes(p.epistemic)) {
        errors.push(`unknown epistemic status "${p.epistemic}"`);
      }
      // A proposal cannot assert its own provenance as human.
      if (p.origin && p.origin === 'user') {
        errors.push('a proposal may not claim user origin');
      }
      if (p.evidence?.sourceId && !sources.get(db, p.evidence.sourceId)) {
        errors.push(`evidence source ${p.evidence.sourceId} does not exist`);
      }
      break;
    }

    case Op.UpdateObject: {
      const target = objectMustExist(p.objectId, 'objectId');
      const fields = Object.keys(p.patch ?? {});
      if (!fields.length) errors.push('patch is empty');
      for (const f of fields) {
        if (!UPDATABLE_FIELDS.has(f)) {
          errors.push(`field "${f}" cannot be changed by a proposal`);
        }
      }
      if (target && target.origin === 'user' && target.review === 'confirmed') {
        errors.push('this object was written and confirmed by a human; it cannot be rewritten by a proposal');
      }
      if (target && target.state === 'deleted') errors.push('the object is deleted');
      break;
    }

    case Op.CreateRelation: {
      const src = objectMustExist(p.srcId, 'srcId');
      const dst = objectMustExist(p.dstId, 'dstId');
      if (!p.type) errors.push('type is required');
      if (p.srcId && p.srcId === p.dstId) errors.push('an object cannot be related to itself');

      if (src && dst && p.type) {
        const existing = plain(
          db
            .prepare(
              `SELECT origin FROM relation WHERE src_id = ? AND type = ? AND dst_id = ? AND state = 'active'`
            )
            .get(p.srcId, p.type, p.dstId)
        );
        if (existing && existing.origin === 'user') {
          errors.push('a human already asserted this relationship; a proposal cannot change it');
        }
      }
      break;
    }

    case Op.LinkEvidence: {
      objectMustExist(p.targetId, 'targetId');
      if (!p.sourceId && !p.objectId) errors.push('evidence needs a sourceId or an objectId');
      if (p.sourceId && !sources.get(db, p.sourceId)) errors.push(`source ${p.sourceId} does not exist`);
      if (p.objectId) objectMustExist(p.objectId, 'objectId');
      if (p.stance && !['supports', 'contradicts', 'qualifies', 'mentions'].includes(p.stance)) {
        errors.push(`unknown stance "${p.stance}"`);
      }
      break;
    }

    case Op.FlagConflict: {
      objectMustExist(p.aId, 'aId');
      if (p.bId) objectMustExist(p.bId, 'bId');
      if (!p.kind) errors.push('conflict kind is required');
      break;
    }

    case Op.SetAttributes: {
      const target = objectMustExist(p.objectId, 'objectId');
      if (!p.attrs || typeof p.attrs !== 'object') errors.push('attrs must be an object');
      if (target && target.origin === 'user' && target.review === 'confirmed') {
        errors.push('this object was confirmed by a human; a proposal cannot change its attributes');
      }
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Accept a proposal and apply it.
 *
 * The write that results carries a derivation row naming the capability, the
 * provider, the model and the run that produced it. Six months later, "why
 * does memory contain this?" has a precise answer.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} proposalId
 * @param {import('../core/events.js').Actor} actor
 * @param {string} [note]
 * @returns {{proposal: any, applied: any}}
 */
export function accept(db, proposalId, actor, note) {
  const row = plain(db.prepare('SELECT * FROM proposal WHERE id = ?').get(proposalId));
  if (!row) throw new ValidationError(`No proposal ${proposalId}`);
  if (row.status !== 'pending') {
    throw new ValidationError(`Proposal ${proposalId} is ${row.status}, not pending.`);
  }

  const payload = JSON.parse(row.payload);

  // Re-validate before opening the write transaction: memory may have changed
  // since the proposal was made, and a proposal that was valid an hour ago may
  // not be now. This runs outside the transaction on purpose — marking the
  // proposal invalid is a fact we must keep, and a write made inside a
  // transaction we are about to abort would be rolled away with it.
  const recheck = validate(db, {
    workspaceId: row.workspace_id,
    op: row.op,
    payload,
    confidence: row.confidence,
  });

  if (!recheck.valid) {
    const why = recheck.errors.join('; ');
    db.prepare(
      `UPDATE proposal SET status = 'invalid', invalid_why = ?, reviewed_at = ? WHERE id = ?`
    ).run(why, now(), proposalId);
    emit(db, {
      workspaceId: row.workspace_id,
      type: EventType.ProposalInvalidated,
      subjectKind: 'proposal',
      subjectId: proposalId,
      actor,
      payload: { op: row.op, invalidWhy: why, at: 'accept' },
    });
    throw new ValidationError(`Proposal ${proposalId} is no longer valid: ${why}`);
  }

  return tx(db, () => {
    const run = row.run_id
      ? plain(db.prepare('SELECT * FROM capability_run WHERE id = ?').get(row.run_id))
      : null;

    const derivation = {
      method: run ? `capability:${run.capability}` : 'capability:unknown',
      capability: run?.capability ?? null,
      provider: run?.provider ?? null,
      model: run?.model ?? null,
      modelVersion: run?.model_version ?? null,
      runId: row.run_id,
      inputs: payload.inputs ?? [],
    };

    const capabilityActor = { id: row.run_id ?? 'proposal', kind: /** @type {const} */ ('capability') };
    const applied = applyOp(db, row, payload, derivation, capabilityActor);

    db.prepare(
      `UPDATE proposal SET status = 'accepted', applied_kind = ?, applied_id = ?,
                           reviewed_by = ?, reviewed_at = ?, review_note = ?
       WHERE id = ?`
    ).run(applied.kind, applied.id, actor.id, now(), note ?? null, proposalId);

    emit(db, {
      workspaceId: row.workspace_id,
      type: EventType.ProposalAccepted,
      subjectKind: 'proposal',
      subjectId: proposalId,
      actor,
      payload: { op: row.op, appliedKind: applied.kind, appliedId: applied.id },
    });

    return {
      proposal: { ...row, status: 'accepted', applied_kind: applied.kind, applied_id: applied.id },
      applied,
    };
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} row
 * @param {any} p
 * @param {any} derivation
 * @param {import('../core/events.js').Actor} actor
 * @returns {{kind: string, id: string, entity: any}}
 */
function applyOp(db, row, p, derivation, actor) {
  switch (row.op) {
    case Op.CreateObject: {
      const created = objects.create(
        db,
        {
          workspaceId: row.workspace_id,
          kind: p.kind ?? 'note',
          title: p.title,
          body: p.body ?? '',
          attrs: p.attrs ?? {},
          epistemic: p.epistemic ?? 'inference',
          origin: p.origin ?? 'ai',
          confidence: row.confidence,
          occurredAt: p.occurredAt,
          reason: row.rationale,
          derivation,
        },
        actor
      );

      // Carry the supporting excerpt across, so the new object arrives with
      // its evidence rather than as an unattributed assertion.
      if (p.evidence?.sourceId) {
        sources.link(
          db,
          {
            workspaceId: row.workspace_id,
            targetId: created.id,
            sourceId: p.evidence.sourceId,
            excerpt: p.evidence.excerpt,
            locator: p.evidence.locator ?? {},
            stance: 'supports',
          },
          actor
        );
      }
      return { kind: 'object', id: created.id, entity: created };
    }

    case Op.UpdateObject: {
      const updated = objects.update(db, p.objectId, p.patch, actor, {
        reason: row.rationale ?? 'accepted proposal',
        derivation,
      });
      return { kind: 'object', id: updated.id, entity: updated };
    }

    case Op.CreateRelation: {
      const res = relations.create(
        db,
        {
          workspaceId: row.workspace_id,
          srcId: p.srcId,
          type: p.type,
          dstId: p.dstId,
          origin: p.origin ?? 'ai',
          confidence: row.confidence,
          note: row.rationale,
          derivation,
        },
        actor
      );
      if (res.blocked) throw new ValidationError(res.reason ?? 'relationship refused');
      return { kind: 'relation', id: res.relation.id, entity: res.relation };
    }

    case Op.LinkEvidence: {
      const ev = sources.link(
        db,
        {
          workspaceId: row.workspace_id,
          targetKind: p.targetKind ?? 'object',
          targetId: p.targetId,
          sourceId: p.sourceId,
          objectId: p.objectId,
          stance: p.stance ?? 'supports',
          excerpt: p.excerpt,
          locator: p.locator ?? {},
        },
        actor
      );
      return { kind: 'evidence', id: ev.id, entity: ev };
    }

    case Op.FlagConflict: {
      const c = recordConflict(db, {
        workspaceId: row.workspace_id,
        kind: p.kind,
        aId: p.aId,
        bId: p.bId,
        detail: p.detail ?? {},
        detectedBy: derivation.provider ?? 'proposal',
        confidence: row.confidence,
      });
      return { kind: 'conflict', id: c.id, entity: c };
    }

    case Op.SetAttributes: {
      const current = objects.get(db, p.objectId);
      const merged = { ...(current?.attrs ?? {}), ...p.attrs };
      const updated = objects.update(db, p.objectId, { attrs: merged }, actor, {
        reason: row.rationale ?? 'accepted proposal',
        derivation,
      });
      return { kind: 'object', id: updated.id, entity: updated };
    }

    default:
      throw new ValidationError(`Cannot apply operation "${row.op}"`);
  }
}

/**
 * Reject a proposal. It stays in the table, visible, with the reason.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} proposalId
 * @param {import('../core/events.js').Actor} actor
 * @param {string} [note]
 */
export function reject(db, proposalId, actor, note) {
  return tx(db, () => {
    const row = plain(db.prepare('SELECT * FROM proposal WHERE id = ?').get(proposalId));
    if (!row) throw new ValidationError(`No proposal ${proposalId}`);
    if (row.status !== 'pending') {
      throw new ValidationError(`Proposal ${proposalId} is ${row.status}, not pending.`);
    }

    db.prepare(
      `UPDATE proposal SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?
       WHERE id = ?`
    ).run(actor.id, now(), note ?? null, proposalId);

    emit(db, {
      workspaceId: row.workspace_id,
      type: EventType.ProposalRejected,
      subjectKind: 'proposal',
      subjectId: proposalId,
      actor,
      payload: { op: row.op, note: note ?? null },
    });

    // A human correcting the system is a signal worth keeping separately from
    // the rejection itself: it is what "learning from corrections" reads from.
    emit(db, {
      workspaceId: row.workspace_id,
      type: EventType.UserCorrectionRecorded,
      subjectKind: 'proposal',
      subjectId: proposalId,
      actor,
      payload: { correction: 'rejected_proposal', op: row.op, note: note ?? null },
    });

    return { ...row, status: 'rejected' };
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, status?: string, limit?: number, op?: string}} opts
 */
export function list(db, opts) {
  const where = ['p.workspace_id = ?'];
  const args = [opts.workspaceId];
  if (opts.status) { where.push('p.status = ?'); args.push(opts.status); }
  if (opts.op) { where.push('p.op = ?'); args.push(opts.op); }

  return plainAll(
    db
      .prepare(
        `SELECT p.*, r.capability, r.provider, r.model
         FROM proposal p LEFT JOIN capability_run r ON r.id = p.run_id
         WHERE ${where.join(' AND ')}
         ORDER BY p.created_at DESC LIMIT ?`
      )
      .all(...args, Math.min(opts.limit ?? 50, 500))
  ).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} proposalId
 */
export function get(db, proposalId) {
  const row = plain(db.prepare('SELECT * FROM proposal WHERE id = ?').get(proposalId));
  return row ? { ...row, payload: JSON.parse(row.payload) } : null;
}

/**
 * Record a conflict directly (used by deterministic detection, which needs no
 * proposal because it asserts nothing — it only marks a disagreement to look at).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} c
 * @param {string} c.workspaceId
 * @param {string} c.kind
 * @param {string} c.aId
 * @param {string} [c.bId]
 * @param {object} [c.detail]
 * @param {string} c.detectedBy
 * @param {number} [c.confidence]
 */
export function recordConflict(db, c) {
  const existing = plain(
    db
      .prepare(
        `SELECT * FROM conflict
         WHERE workspace_id = ? AND kind = ? AND a_id = ? AND COALESCE(b_id,'') = COALESCE(?,'')
           AND status = 'open'`
      )
      .get(c.workspaceId, c.kind, c.aId, c.bId ?? null)
  );
  if (existing) return existing;

  const row = {
    id: newConflictId(),
    workspace_id: c.workspaceId,
    kind: c.kind,
    a_kind: 'object',
    a_id: c.aId,
    b_kind: c.bId ? 'object' : null,
    b_id: c.bId ?? null,
    detail: stableStringify(c.detail ?? {}),
    detected_by: c.detectedBy,
    confidence: c.confidence ?? null,
    status: 'open',
    resolution: null,
    created_at: now(),
    resolved_at: null,
  };

  db.prepare(
    `INSERT INTO conflict (id, workspace_id, kind, a_kind, a_id, b_kind, b_id, detail,
                           detected_by, confidence, status, resolution, created_at, resolved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.workspace_id, row.kind, row.a_kind, row.a_id, row.b_kind, row.b_id, row.detail,
    row.detected_by, row.confidence, row.status, null, row.created_at, null
  );

  emit(db, {
    workspaceId: c.workspaceId,
    type: EventType.ConflictDetected,
    subjectKind: 'conflict',
    subjectId: row.id,
    actor: { id: c.detectedBy, kind: 'capability' },
    payload: { kind: c.kind, aId: c.aId, bId: c.bId ?? null, confidence: c.confidence ?? null },
  });

  return row;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} conflictId
 * @param {import('../core/events.js').Actor} actor
 * @param {'resolved'|'dismissed'|'acknowledged'} status
 * @param {string} [resolution]
 */
export function resolveConflict(db, conflictId, actor, status, resolution) {
  return tx(db, () => {
    const row = plain(db.prepare('SELECT * FROM conflict WHERE id = ?').get(conflictId));
    if (!row) throw new ValidationError(`No conflict ${conflictId}`);

    db.prepare('UPDATE conflict SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?').run(
      status, resolution ?? null, now(), conflictId
    );

    emit(db, {
      workspaceId: row.workspace_id,
      type: EventType.ConflictResolved,
      subjectKind: 'conflict',
      subjectId: conflictId,
      actor,
      payload: { status, resolution: resolution ?? null },
    });

    return { ...row, status, resolution: resolution ?? null };
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, status?: string, limit?: number}} opts
 */
export function conflicts(db, opts) {
  const where = ['c.workspace_id = ?'];
  const args = [opts.workspaceId];
  if (opts.status) { where.push('c.status = ?'); args.push(opts.status); }

  return plainAll(
    db
      .prepare(
        `SELECT c.*, a.title AS a_title, b.title AS b_title
         FROM conflict c
         LEFT JOIN object a ON a.id = c.a_id
         LEFT JOIN object b ON b.id = c.b_id
         WHERE ${where.join(' AND ')}
         ORDER BY c.created_at DESC LIMIT ?`
      )
      .all(...args, Math.min(opts.limit ?? 50, 500))
  ).map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
}

/**
 * Accept or reject many proposals at once.
 *
 * Ingesting a long document can produce dozens of proposals, and reviewing
 * them one at a time is how a review queue becomes a graveyard. Bulk actions
 * make the queue tractable — but they are still explicit decisions, made by a
 * human, over a filtered set they chose.
 *
 * Failures do not stop the run: one stale proposal in a batch of forty should
 * not block the other thirty-nine. Each outcome is reported individually.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @param {string} input.workspaceId
 * @param {'accept'|'reject'} input.action
 * @param {string[]} [input.ids]           explicit ids, or use the filters below
 * @param {number} [input.minConfidence]
 * @param {string} [input.op]
 * @param {string} [input.runId]           everything proposed by one capability run
 * @param {number} [input.limit]
 * @param {string} [input.note]
 * @param {import('../core/events.js').Actor} actor
 * @returns {{action: string, succeeded: any[], failed: Array<{id: string, error: string}>}}
 */
export function bulk(db, input, actor) {
  let candidates;

  if (input.ids?.length) {
    candidates = plainAll(
      db
        .prepare(
          `SELECT * FROM proposal WHERE workspace_id = ? AND status = 'pending'
             AND id IN (${input.ids.map(() => '?').join(',')})`
        )
        .all(input.workspaceId, ...input.ids)
    );
  } else {
    const where = ["workspace_id = ?", "status = 'pending'"];
    const args = [input.workspaceId];
    if (typeof input.minConfidence === 'number') {
      where.push('confidence >= ?');
      args.push(input.minConfidence);
    }
    if (input.op) {
      where.push('op = ?');
      args.push(input.op);
    }
    if (input.runId) {
      where.push('run_id = ?');
      args.push(input.runId);
    }
    candidates = plainAll(
      db
        .prepare(`SELECT * FROM proposal WHERE ${where.join(' AND ')} ORDER BY confidence DESC, created_at ASC LIMIT ?`)
        .all(...args, Math.min(input.limit ?? 100, 1000))
    );
  }

  const succeeded = [];
  const failed = [];

  for (const row of candidates) {
    try {
      const result =
        input.action === 'accept'
          ? accept(db, row.id, actor, input.note)
          : reject(db, row.id, actor, input.note);
      // The op travels with the result: a caller deciding what to do next —
      // enrich a new object, say — cannot tell a creation from an update
      // without it.
      succeeded.push(
        input.action === 'accept' ? { ...result.applied, op: row.op } : { id: row.id, op: row.op }
      );
    } catch (err) {
      // A proposal that went stale between listing and applying is expected,
      // not exceptional. Record it and carry on.
      failed.push({ id: row.id, error: String(err?.message ?? err) });
    }
  }

  return { action: input.action, succeeded, failed };
}

/**
 * Mark old pending proposals as expired.
 *
 * A proposal nobody has looked at in months is not a decision waiting to be
 * made, it is clutter hiding the ones that matter. Expiring is not rejecting:
 * the proposal is kept, and the distinction between "I said no" and "I never
 * looked" is preserved, because only the first is a correction signal.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, olderThanDays?: number}} opts
 * @param {import('../core/events.js').Actor} [actor]
 */
export function expireStale(db, opts, actor = SYSTEM_ACTOR) {
  const cutoff = new Date(Date.now() - (opts.olderThanDays ?? 90) * 86400000).toISOString();

  return tx(db, () => {
    const stale = plainAll(
      db
        .prepare(`SELECT id FROM proposal WHERE workspace_id = ? AND status = 'pending' AND created_at < ?`)
        .all(opts.workspaceId, cutoff)
    );

    for (const row of stale) {
      db.prepare(`UPDATE proposal SET status = 'expired', reviewed_at = ? WHERE id = ?`).run(now(), row.id);
    }
    return { expired: stale.length, cutoff };
  });
}
