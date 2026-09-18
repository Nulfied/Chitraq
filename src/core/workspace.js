/**
 * Workspaces, principals and permissions.
 *
 * INVARIANT 17: permissions are deterministic. Access is decided by explicit
 * grants, never by similarity, inference or a model's judgement about whether
 * something "looks shareable".
 */

import { newWorkspaceId, newPrincipalId, newGrantId, now } from './ids.js';
import { tx, plain, plainAll } from './db.js';
import { ValidationError, NotFoundError } from './objects.js';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{name: string, kind?: 'user'|'team'|'org'|'service', id?: string}} input
 */
export function createPrincipal(db, input) {
  const row = {
    id: input.id ?? newPrincipalId(),
    kind: input.kind ?? 'user',
    name: input.name,
    created_at: now(),
  };
  db.prepare('INSERT INTO principal (id, kind, name, created_at) VALUES (?,?,?,?)').run(
    row.id, row.kind, row.name, row.created_at
  );
  return row;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{name: string, ownerId: string}} input
 */
export function create(db, input) {
  return tx(db, () => {
    const owner = plain(db.prepare('SELECT * FROM principal WHERE id = ?').get(input.ownerId));
    if (!owner) throw new NotFoundError(`No principal ${input.ownerId}`);

    const row = { id: newWorkspaceId(), name: input.name, owner_id: input.ownerId, created_at: now() };
    db.prepare('INSERT INTO workspace (id, name, owner_id, created_at) VALUES (?,?,?,?)').run(
      row.id, row.name, row.owner_id, row.created_at
    );
    grant(db, { principalId: input.ownerId, scopeKind: 'workspace', scopeId: row.id, level: 'admin' });
    return row;
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 */
export function get(db, workspaceId) {
  return plain(db.prepare('SELECT * FROM workspace WHERE id = ?').get(workspaceId));
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function list(db) {
  return plainAll(
    db
      .prepare(
        `SELECT w.*, p.name AS owner_name,
                (SELECT COUNT(*) FROM object o WHERE o.workspace_id = w.id AND o.state = 'active') AS object_count
         FROM workspace w JOIN principal p ON p.id = w.owner_id
         ORDER BY w.created_at ASC`
      )
      .all()
  );
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{principalId: string, scopeKind: 'workspace'|'object', scopeId: string, level: 'read'|'write'|'admin'}} input
 */
export function grant(db, input) {
  const row = {
    id: newGrantId(),
    principal_id: input.principalId,
    scope_kind: input.scopeKind,
    scope_id: input.scopeId,
    level: input.level,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO grant_entry (id, principal_id, scope_kind, scope_id, level, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(principal_id, scope_kind, scope_id) DO UPDATE SET level = excluded.level`
  ).run(row.id, row.principal_id, row.scope_kind, row.scope_id, row.level, row.created_at);
  return row;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} principalId
 * @param {string} scopeId
 */
export function revoke(db, principalId, scopeId) {
  db.prepare('DELETE FROM grant_entry WHERE principal_id = ? AND scope_id = ?').run(principalId, scopeId);
}

const RANK = { read: 1, write: 2, admin: 3 };

/**
 * Does `principalId` hold at least `level` on this workspace (or object)?
 *
 * An object-scoped grant can widen access to a single object but never
 * narrows a workspace grant: the effective level is the maximum of the two.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} q
 * @param {string} q.principalId
 * @param {string} q.workspaceId
 * @param {string} [q.objectId]
 * @param {'read'|'write'|'admin'} q.level
 * @returns {boolean}
 */
export function can(db, q) {
  const need = RANK[q.level];
  const scopes = [q.workspaceId];
  if (q.objectId) scopes.push(q.objectId);

  const rows = plainAll(
    db
      .prepare(
        `SELECT level FROM grant_entry
         WHERE principal_id = ? AND scope_id IN (${scopes.map(() => '?').join(',')})`
      )
      .all(q.principalId, ...scopes)
  );

  return rows.some((r) => RANK[r.level] >= need);
}

/**
 * Throw unless the principal is allowed. Used at the API boundary so a missing
 * permission fails loudly rather than returning quietly empty results.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Parameters<typeof can>[1]} q
 */
export function require_(db, q) {
  if (!can(db, q)) {
    const err = new ValidationError(
      `Principal ${q.principalId} lacks ${q.level} on ${q.objectId ?? q.workspaceId}`
    );
    err.status = 403;
    throw err;
  }
}

/**
 * Create the default local single-user setup: one principal, one workspace.
 * Local-first Chitraq should be usable immediately, without an account step.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{userName?: string, workspaceName?: string}} [opts]
 */
export function bootstrap(db, opts = {}) {
  return tx(db, () => {
    const existing = plain(db.prepare('SELECT * FROM workspace ORDER BY created_at ASC LIMIT 1').get());
    if (existing) {
      const owner = plain(db.prepare('SELECT * FROM principal WHERE id = ?').get(existing.owner_id));
      return { workspace: existing, principal: owner, created: false };
    }
    const principal = createPrincipal(db, { name: opts.userName ?? 'me', kind: 'user' });
    const workspace = create(db, {
      name: opts.workspaceName ?? 'My memory',
      ownerId: principal.id,
    });
    return { workspace, principal, created: true };
  });
}
