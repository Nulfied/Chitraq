/**
 * Sources and Evidence.
 *
 * A Source is captured material held verbatim: the note you pasted, the page
 * you saved, the file you dropped in. Chitraq never edits a source to match a
 * later interpretation — INVARIANT 19, generated interpretation must not
 * quietly become source truth.
 *
 * Evidence is the link from a claim back to the material supporting (or
 * contradicting) it, with the exact excerpt and offset preserved so a
 * conclusion can always be traced to the words it rests on.
 */

import { newSourceId, newEvidenceId, now, hash, stableStringify } from './ids.js';
import { tx, plain, plainAll } from './db.js';
import { emit, EventType, SYSTEM_ACTOR } from './events.js';
import { Origin, ValidationError } from './objects.js';

/**
 * Store captured material. Identical content captured twice returns the
 * existing source rather than duplicating bytes.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @param {string} input.workspaceId
 * @param {string} [input.uri]
 * @param {string} [input.mediaType]
 * @param {string} [input.title]
 * @param {string} [input.text]
 * @param {Uint8Array} [input.blob]
 * @param {object} [input.meta]
 * @param {string} [input.origin]
 * @param {string} [input.capturedAt]
 * @param {import('./events.js').Actor} [actor]
 * @returns {{source: any, deduplicated: boolean}}
 */
export function capture(db, input, actor = SYSTEM_ACTOR) {
  const text = input.text ?? null;
  const mediaType = input.mediaType ?? 'text/plain';
  const contentHash = hash(mediaType, input.uri ?? '', text ?? '', input.blob ? bytesTag(input.blob) : '');

  return tx(db, () => {
    const existing = plain(
      db
        .prepare('SELECT * FROM source WHERE workspace_id = ? AND content_hash = ?')
        .get(input.workspaceId, contentHash)
    );
    if (existing) return { source: existing, deduplicated: true };

    const row = {
      id: newSourceId(),
      workspace_id: input.workspaceId,
      uri: input.uri ?? null,
      media_type: mediaType,
      title: input.title ?? null,
      byte_size: input.blob ? input.blob.byteLength : Buffer.byteLength(text ?? '', 'utf8'),
      content_hash: contentHash,
      text,
      blob: input.blob ?? null,
      meta: stableStringify(input.meta ?? {}),
      captured_at: input.capturedAt ?? now(),
      origin: input.origin ?? Origin.User,
    };

    db.prepare(
      `INSERT INTO source (id, workspace_id, uri, media_type, title, byte_size, content_hash,
                           text, blob, meta, captured_at, origin)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.id, row.workspace_id, row.uri, row.media_type, row.title, row.byte_size,
      row.content_hash, row.text, row.blob, row.meta, row.captured_at, row.origin
    );

    emit(db, {
      workspaceId: row.workspace_id,
      type: EventType.SourceCaptured,
      subjectKind: 'source',
      subjectId: row.id,
      actor,
      payload: { uri: row.uri, mediaType: row.media_type, bytes: row.byte_size },
    });

    return { source: row, deduplicated: false };
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sourceId
 * @param {{withBlob?: boolean}} [opts]
 */
export function get(db, sourceId, opts = {}) {
  const cols = opts.withBlob ? '*' : 'id, workspace_id, uri, media_type, title, byte_size, content_hash, text, meta, captured_at, origin';
  const row = plain(db.prepare(`SELECT ${cols} FROM source WHERE id = ?`).get(sourceId));
  return row ? { ...row, meta: JSON.parse(row.meta) } : null;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 * @param {number} [limit]
 */
export function list(db, workspaceId, limit = 100) {
  return plainAll(
    db
      .prepare(
        `SELECT id, uri, media_type, title, byte_size, captured_at, origin
         FROM source WHERE workspace_id = ? ORDER BY captured_at DESC LIMIT ?`
      )
      .all(workspaceId, limit)
  );
}

/**
 * Link evidence to a claim.
 *
 * `stance` matters as much as the link itself: contradicting evidence is
 * recorded alongside supporting evidence rather than discarded, because
 * INVARIANT 53 forbids silently erasing conflicting evidence.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @param {string} input.workspaceId
 * @param {'object'|'relation'} [input.targetKind]
 * @param {string} input.targetId
 * @param {string} [input.sourceId]
 * @param {string} [input.objectId]  another knowledge object used as evidence
 * @param {'supports'|'contradicts'|'qualifies'|'mentions'} [input.stance]
 * @param {string} [input.excerpt]
 * @param {object} [input.locator]
 * @param {number} [input.weight]
 * @param {import('./events.js').Actor} [actor]
 */
export function link(db, input, actor = SYSTEM_ACTOR) {
  if (!input.sourceId && !input.objectId) {
    throw new ValidationError('Evidence needs either a sourceId or an objectId.');
  }

  const row = {
    id: newEvidenceId(),
    workspace_id: input.workspaceId,
    target_kind: input.targetKind ?? 'object',
    target_id: input.targetId,
    source_id: input.sourceId ?? null,
    object_id: input.objectId ?? null,
    stance: input.stance ?? 'supports',
    excerpt: input.excerpt ?? null,
    locator: stableStringify(input.locator ?? {}),
    weight: input.weight ?? 1.0,
    created_at: now(),
  };

  return tx(db, () => {
    db.prepare(
      `INSERT INTO evidence (id, workspace_id, target_kind, target_id, source_id, object_id,
                             stance, excerpt, locator, weight, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.id, row.workspace_id, row.target_kind, row.target_id, row.source_id, row.object_id,
      row.stance, row.excerpt, row.locator, row.weight, row.created_at
    );

    emit(db, {
      workspaceId: row.workspace_id,
      type: EventType.EvidenceLinked,
      subjectKind: row.target_kind,
      subjectId: row.target_id,
      actor,
      payload: { stance: row.stance, sourceId: row.source_id, objectId: row.object_id },
    });

    return row;
  });
}

/**
 * All evidence bearing on a claim, with the source title resolved.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} targetId
 * @param {'object'|'relation'} [targetKind]
 */
export function forTarget(db, targetId, targetKind = 'object') {
  const rows = plainAll(
    db
      .prepare(
        `SELECT e.*, s.title AS source_title, s.uri AS source_uri, s.media_type AS source_media_type,
                o.title AS object_title
         FROM evidence e
         LEFT JOIN source s ON s.id = e.source_id
         LEFT JOIN object o ON o.id = e.object_id
         WHERE e.target_kind = ? AND e.target_id = ?
         ORDER BY e.stance = 'contradicts' DESC, e.weight DESC, e.created_at ASC`
      )
      .all(targetKind, targetId)
  );
  return rows.map((r) => ({ ...r, locator: JSON.parse(r.locator) }));
}

/**
 * Everything that was derived from a given source.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sourceId
 */
export function derivedFromSource(db, sourceId) {
  return plainAll(
    db
      .prepare(
        `SELECT DISTINCT o.id, o.title, o.kind, o.epistemic, o.origin, o.state, o.created_at
         FROM evidence e JOIN object o ON o.id = e.target_id
         WHERE e.source_id = ? AND e.target_kind = 'object'
         ORDER BY o.created_at ASC`
      )
      .all(sourceId)
  );
}

/** @param {Uint8Array} bytes */
function bytesTag(bytes) {
  return `${bytes.byteLength}:${hash(Buffer.from(bytes).toString('base64'))}`;
}
