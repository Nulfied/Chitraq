import test from 'node:test';
import assert from 'node:assert/strict';

import { open, migrate } from '../src/core/db.js';
import * as objects from '../src/core/objects.js';
import * as relations from '../src/core/relations.js';
import * as sources from '../src/core/sources.js';
import * as workspace from '../src/core/workspace.js';
import * as events from '../src/core/events.js';

/** @returns {{db: any, ws: string, user: any, actor: any}} */
function fresh() {
  const db = open(':memory:');
  const { workspace: ws, principal } = workspace.bootstrap(db);
  return {
    db,
    ws: ws.id,
    user: principal,
    actor: { id: principal.id, kind: 'user' },
  };
}

test('bootstrap creates exactly one workspace and is idempotent', () => {
  const db = open(':memory:');
  const first = workspace.bootstrap(db);
  const second = workspace.bootstrap(db);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.workspace.id, first.workspace.id);
  assert.equal(workspace.list(db).length, 1);
});

test('creating an object writes version 1 and an event', () => {
  const { db, ws, actor } = fresh();
  const o = objects.create(
    db,
    { workspaceId: ws, kind: 'decision', title: 'Use SQLite', body: 'Zero deps.' },
    actor
  );

  assert.equal(o.head_version, 1);
  assert.equal(o.origin, 'user');
  assert.equal(o.state, 'active');
  assert.equal(o.confidence, null, 'a user assertion carries no confidence score');

  const hist = objects.history(db, o.id);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].change_kind, 'create');
  assert.equal(hist[0].actor, actor.id);

  const log = events.list(db, { workspaceId: ws, subjectId: o.id });
  assert.equal(log[0].type, 'KnowledgeCaptured');
});

test('editing appends a version and never rewrites the old one', () => {
  const { db, ws, actor } = fresh();
  const o = objects.create(db, { workspaceId: ws, title: 'Original', body: 'v1 body' }, actor);
  objects.update(db, o.id, { body: 'v2 body' }, actor, { reason: 'corrected' });
  const updated = objects.update(db, o.id, { title: 'Renamed' }, actor);

  assert.equal(updated.head_version, 3);
  const hist = objects.history(db, o.id);
  assert.equal(hist.length, 3);
  assert.equal(hist[0].body, 'v1 body', 'version 1 still holds the original text');
  assert.equal(hist[1].body, 'v2 body');
  assert.equal(hist[1].change_reason, 'corrected');
  assert.equal(hist[2].title, 'Renamed');
});

test('a no-op edit does not create an empty version', () => {
  const { db, ws, actor } = fresh();
  const o = objects.create(db, { workspaceId: ws, title: 'Stable' }, actor);
  objects.update(db, o.id, { title: 'Stable' }, actor);
  assert.equal(objects.history(db, o.id).length, 1);
});

test('asOf reconstructs what was believed at a past instant', async () => {
  const { db, ws, actor } = fresh();
  const o = objects.create(db, { workspaceId: ws, title: 'Launch date', body: 'March' }, actor);
  await new Promise((r) => setTimeout(r, 10));
  const between = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 10));
  objects.update(db, o.id, { body: 'April' }, actor);

  assert.equal(objects.asOf(db, o.id, between).body, 'March');
  assert.equal(objects.get(db, o.id).body, 'April');
});

test('supersede preserves the old object instead of deleting it', () => {
  const { db, ws, actor } = fresh();
  const oldO = objects.create(db, { workspaceId: ws, title: 'Ship in Q1' }, actor);
  const newO = objects.create(db, { workspaceId: ws, title: 'Ship in Q2' }, actor);
  objects.supersede(db, oldO.id, newO.id, actor, 'schedule slipped');

  const stored = objects.get(db, oldO.id);
  assert.equal(stored.state, 'superseded');
  assert.equal(stored.superseded_by, newO.id);
  assert.equal(stored.title, 'Ship in Q1', 'superseded knowledge is still readable');
  assert.ok(stored.valid_until, 'supersession closes the validity window');
});

test('confirming AI-derived knowledge does not relabel its origin', () => {
  const { db, ws, actor } = fresh();
  const o = objects.create(
    db,
    { workspaceId: ws, title: 'Model guess', origin: 'ai', epistemic: 'inference', confidence: 0.6 },
    { id: 'run_x', kind: 'capability' }
  );
  const confirmed = objects.confirm(db, o.id, actor, 'checked against the invoice');

  assert.equal(confirmed.review, 'confirmed');
  assert.equal(confirmed.origin, 'ai', 'origin is history and does not change on confirmation');
  assert.equal(confirmed.epistemic, 'inference');
});

test('confidence outside 0..1 is rejected', () => {
  const { db, ws, actor } = fresh();
  assert.throws(
    () => objects.create(db, { workspaceId: ws, title: 'x', origin: 'ai', confidence: 1.4 }, actor),
    /confidence must be between 0 and 1/
  );
});

test('AI cannot overwrite a user-asserted relationship', () => {
  const { db, ws, actor } = fresh();
  const a = objects.create(db, { workspaceId: ws, title: 'A' }, actor);
  const b = objects.create(db, { workspaceId: ws, title: 'B' }, actor);

  const byUser = relations.create(
    db,
    { workspaceId: ws, srcId: a.id, type: 'contradicts', dstId: b.id, origin: 'user' },
    actor
  );
  assert.equal(byUser.created, true);

  const byAI = relations.create(
    db,
    { workspaceId: ws, srcId: a.id, type: 'contradicts', dstId: b.id, origin: 'ai', confidence: 0.9 },
    { id: 'run_y', kind: 'capability' }
  );

  assert.equal(byAI.blocked, true);
  assert.match(byAI.reason, /cannot overwrite/);
  assert.equal(relations.get(db, byUser.relation.id).origin, 'user');
  assert.equal(relations.get(db, byUser.relation.id).confidence, null);
});

test('a user may strengthen an AI-proposed relationship', () => {
  const { db, ws, actor } = fresh();
  const a = objects.create(db, { workspaceId: ws, title: 'A' }, actor);
  const b = objects.create(db, { workspaceId: ws, title: 'B' }, actor);

  relations.create(
    db,
    { workspaceId: ws, srcId: a.id, type: 'related_to', dstId: b.id, origin: 'ai', confidence: 0.5 },
    { id: 'run_z', kind: 'capability' }
  );
  const res = relations.create(
    db,
    { workspaceId: ws, srcId: a.id, type: 'related_to', dstId: b.id, origin: 'user' },
    actor
  );

  assert.equal(res.blocked, false);
  assert.equal(res.relation.origin, 'user');
});

test('retracted relationships stay readable as history', () => {
  const { db, ws, actor } = fresh();
  const a = objects.create(db, { workspaceId: ws, title: 'A' }, actor);
  const b = objects.create(db, { workspaceId: ws, title: 'B' }, actor);
  const { relation } = relations.create(
    db, { workspaceId: ws, srcId: a.id, type: 'causes', dstId: b.id }, actor
  );

  relations.retract(db, relation.id, actor, 'turned out to be coincidence');

  assert.equal(relations.get(db, relation.id).state, 'retracted');
  assert.equal(relations.neighbours(db, a.id).outgoing.length, 0);
  assert.equal(relations.neighbours(db, a.id, { includeRetracted: true }).outgoing.length, 1);
  assert.equal(relations.history(db, relation.id).length, 2);
});

test('self-relations are refused', () => {
  const { db, ws, actor } = fresh();
  const a = objects.create(db, { workspaceId: ws, title: 'A' }, actor);
  assert.throws(
    () => relations.create(db, { workspaceId: ws, srcId: a.id, type: 'causes', dstId: a.id }, actor),
    /cannot be related to itself/
  );
});

test('incoming edges are shown with their inverse label', () => {
  const { db, ws, actor } = fresh();
  const whole = objects.create(db, { workspaceId: ws, title: 'Engine' }, actor);
  const part = objects.create(db, { workspaceId: ws, title: 'Piston' }, actor);
  relations.create(db, { workspaceId: ws, srcId: part.id, type: 'part_of', dstId: whole.id }, actor);

  const view = relations.neighbours(db, whole.id);
  assert.equal(view.incoming[0].display_type, 'contains');
});

test('traverse reports depth and the path taken', () => {
  const { db, ws, actor } = fresh();
  const mk = (t) => objects.create(db, { workspaceId: ws, title: t }, actor);
  const [a, b, c, d] = [mk('A'), mk('B'), mk('C'), mk('D')];
  relations.create(db, { workspaceId: ws, srcId: a.id, type: 'causes', dstId: b.id }, actor);
  relations.create(db, { workspaceId: ws, srcId: b.id, type: 'causes', dstId: c.id }, actor);
  relations.create(db, { workspaceId: ws, srcId: c.id, type: 'causes', dstId: d.id }, actor);

  const reached = relations.traverse(db, a.id, { depth: 2 });
  const ids = reached.map((r) => r.id);
  assert.ok(ids.includes(b.id) && ids.includes(c.id));
  assert.ok(!ids.includes(d.id), 'depth 2 must not reach the fourth node');
  assert.equal(reached.find((r) => r.id === c.id).depth, 2);
  assert.deepEqual(reached.find((r) => r.id === c.id).via, ['causes', 'causes']);
});

test('identical source content is captured once', () => {
  const { db, ws } = fresh();
  const first = sources.capture(db, { workspaceId: ws, text: 'same bytes', uri: 'file://a' });
  const again = sources.capture(db, { workspaceId: ws, text: 'same bytes', uri: 'file://a' });
  assert.equal(again.deduplicated, true);
  assert.equal(again.source.id, first.source.id);
});

test('contradicting evidence is kept and surfaced first', () => {
  const { db, ws, actor } = fresh();
  const claim = objects.create(db, { workspaceId: ws, title: 'Revenue grew 20%' }, actor);
  const { source: s1 } = sources.capture(db, { workspaceId: ws, text: 'Q3 deck says 20%' });
  const { source: s2 } = sources.capture(db, { workspaceId: ws, text: 'Audit says 11%' });

  sources.link(db, { workspaceId: ws, targetId: claim.id, sourceId: s1.id, stance: 'supports' }, actor);
  sources.link(db, { workspaceId: ws, targetId: claim.id, sourceId: s2.id, stance: 'contradicts' }, actor);

  const ev = sources.forTarget(db, claim.id);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].stance, 'contradicts', 'disagreement is not buried below agreement');
});

test('permissions are explicit, and object grants widen rather than narrow', () => {
  const { db, ws, user } = fresh();
  const stranger = workspace.createPrincipal(db, { name: 'stranger' });

  assert.equal(workspace.can(db, { principalId: user.id, workspaceId: ws, level: 'admin' }), true);
  assert.equal(workspace.can(db, { principalId: stranger.id, workspaceId: ws, level: 'read' }), false);

  const o = objects.create(db, { workspaceId: ws, title: 'Shared note' }, { id: user.id, kind: 'user' });
  workspace.grant(db, { principalId: stranger.id, scopeKind: 'object', scopeId: o.id, level: 'read' });

  assert.equal(
    workspace.can(db, { principalId: stranger.id, workspaceId: ws, objectId: o.id, level: 'read' }),
    true
  );
  assert.equal(workspace.can(db, { principalId: stranger.id, workspaceId: ws, level: 'read' }), false);
});

test('soft delete keeps history; purge is the only thing that erases it', () => {
  const { db, ws, actor } = fresh();
  const o = objects.create(db, { workspaceId: ws, title: 'Sensitive' }, actor);
  objects.remove(db, o.id, actor, 'user asked');

  assert.equal(objects.get(db, o.id).state, 'deleted');
  assert.equal(objects.history(db, o.id).length, 2);
  assert.equal(objects.list(db, { workspaceId: ws }).length, 0, 'deleted objects leave retrieval');

  objects.purge(db, o.id, actor, 'right to erasure');
  assert.equal(objects.get(db, o.id), null);
  assert.equal(objects.history(db, o.id).length, 0);

  const log = events.list(db, { workspaceId: ws, types: ['KnowledgeDeleted'] });
  assert.equal(log[0].payload.purged, true, 'the fact of erasure stays auditable');
});

test('list filters are deterministic and exclude deleted by default', () => {
  const { db, ws, actor } = fresh();
  objects.create(db, { workspaceId: ws, kind: 'decision', title: 'D1' }, actor);
  objects.create(db, { workspaceId: ws, kind: 'note', title: 'N1' }, actor);
  const gone = objects.create(db, { workspaceId: ws, kind: 'note', title: 'N2' }, actor);
  objects.remove(db, gone.id, actor);

  assert.equal(objects.list(db, { workspaceId: ws }).length, 2);
  assert.equal(objects.list(db, { workspaceId: ws, kinds: ['decision'] }).length, 1);
  assert.equal(objects.count(db, { workspaceId: ws, kinds: ['note'] }), 1);
});

test('a store written by a newer schema is refused rather than opened blindly', () => {
  const db = open(':memory:');
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('999', 'schema_version');
  assert.throws(() => migrate(db), /newer Chitraq/);
});
