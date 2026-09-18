/**
 * Entity resolution.
 *
 * The tests that matter here are the ones about *not* merging. A wrong merge
 * silently fuses two histories and is tedious to unpick, so the bar for an
 * automatic merge is exact-match only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Chitraq } from '../src/chitraq.js';
import * as entities from '../src/core/entities.js';
import { canonicalise, compareNames } from '../src/core/entities.js';

test('names are normalised for matching without reordering them', () => {
  assert.equal(canonicalise('Dr. Priya Rao'), 'priya rao');
  assert.equal(canonicalise('  PRIYA   RAO  '), 'priya rao');
  assert.equal(canonicalise("O'Brien"), 'obrien');
  assert.notEqual(canonicalise('Rao Priya'), canonicalise('Priya Rao'), 'word order is not guessed at');
});

test('the same name resolves to one entity, not many', () => {
  const c = new Chitraq({ path: ':memory:' });
  const first = entities.resolve(c.db, { workspaceId: c.workspaceId, name: 'Priya Rao', entityType: 'person' });
  const again = entities.resolve(c.db, { workspaceId: c.workspaceId, name: 'priya rao', entityType: 'person' });
  const honorific = entities.resolve(c.db, { workspaceId: c.workspaceId, name: 'Dr. Priya Rao', entityType: 'person' });

  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.entity.id, first.entity.id);
  assert.equal(honorific.entity.id, first.entity.id);
  c.close();
});

test('entities of different types are kept apart', () => {
  const c = new Chitraq({ path: ':memory:' });
  const person = entities.resolve(c.db, { workspaceId: c.workspaceId, name: 'Mercury', entityType: 'person' });
  const project = entities.resolve(c.db, { workspaceId: c.workspaceId, name: 'Mercury', entityType: 'project' });

  assert.notEqual(person.entity.id, project.entity.id);
  c.close();
});

test('an entity is algorithm-origin, because nobody asserted it', () => {
  const c = new Chitraq({ path: ':memory:' });
  const { entity } = entities.resolve(c.db, { workspaceId: c.workspaceId, name: 'Acme Ltd', entityType: 'organisation' });

  assert.equal(entity.origin, 'algorithm');
  assert.equal(entity.kind, 'entity');
  c.close();
});

test('values are not turned into entities', () => {
  // Dates, money and percentages are measurements, not things to link.
  for (const t of ['date', 'money', 'percent', 'url', 'email', 'version']) {
    assert.equal(entities.entityTypeFor(t), null, `${t} must not become an entity`);
  }
  assert.equal(entities.entityTypeFor('name'), 'person');
  assert.equal(entities.entityTypeFor('identifier'), 'identifier');
});

test('mentions link notes to entities and are counted', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.remember({
    title: 'Kickoff with Priya Rao',
    body: 'Priya Rao walked through the migration plan for ticket OPS-412.',
  });
  await c.remember({
    title: 'Follow-up with Priya Rao',
    body: 'Priya Rao confirmed the rollout window.',
  });

  const all = c.entities();
  const priya = all.find((e) => e.title === 'Priya Rao');
  assert.ok(priya, 'the person was resolved out of both notes');
  assert.equal(priya.mentions, 2, 'both notes point at the same entity');

  const mentioned = c.entity(priya.id).mentionedIn;
  assert.equal(mentioned.length, 2);
  c.close();
});

test('similar names are suggested, never merged automatically', () => {
  const c = new Chitraq({ path: ':memory:' });
  entities.resolve(c.db, { workspaceId: c.workspaceId, name: 'Priya Rao', entityType: 'person' });
  entities.resolve(c.db, { workspaceId: c.workspaceId, name: 'P. Rao', entityType: 'person' });

  assert.equal(c.entities().length, 2, 'they stay separate until a human says otherwise');

  const candidates = c.duplicateEntities();
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].score >= 0.8);
  assert.match(candidates[0].because, /initial/);
  c.close();
});

test('unrelated names of the same type are not suggested', () => {
  const c = new Chitraq({ path: ':memory:' });
  entities.resolve(c.db, { workspaceId: c.workspaceId, name: 'Priya Rao', entityType: 'person' });
  entities.resolve(c.db, { workspaceId: c.workspaceId, name: 'Tomas Berg', entityType: 'person' });

  assert.equal(c.duplicateEntities().length, 0);
  c.close();
});

test('a shared surname alone is not enough to suggest a merge', () => {
  const different = compareNames('Priya Rao', 'Sanjay Rao');
  assert.equal(different.score, 0, 'two people can share a surname');
});

test('merging re-points every mention and keeps the merged entity as history', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.remember({ title: 'Note one', body: 'Priya Rao owns the migration.' });
  await c.remember({ title: 'Note two', body: 'The rollout was approved by Priya R Rao.' });

  const all = c.entities();
  const keep = all.find((e) => e.title === 'Priya Rao');
  const dupe = all.find((e) => e.title === 'Priya R Rao');
  assert.ok(keep && dupe, 'both spellings were captured separately');

  const result = c.mergeEntities(keep.id, dupe.id, 'same person');
  assert.ok(result.movedRelations >= 1, 'mentions were moved to the kept entity');
  assert.ok(result.aliases.includes('Priya R Rao'), 'the merged name becomes an alias');

  assert.equal(c.recall(dupe.id).object.state, 'superseded', 'the merged entity is kept, not deleted');
  assert.equal(c.recall(dupe.id).object.superseded_by, keep.id);
  assert.equal(c.entity(keep.id).mentionedIn.length, 2, 'both notes now point at one entity');
  c.close();
});

test('after a merge, the old spelling resolves to the kept entity', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.remember({ title: 'One', body: 'Priya Rao led it.' });
  await c.remember({ title: 'Two', body: 'Priya R Rao led it.' });

  const all = c.entities();
  const keep = all.find((e) => e.title === 'Priya Rao');
  const dupe = all.find((e) => e.title === 'Priya R Rao');
  c.mergeEntities(keep.id, dupe.id);

  const resolved = entities.resolve(c.db, {
    workspaceId: c.workspaceId,
    name: 'Priya R Rao',
    entityType: 'person',
  });
  assert.equal(resolved.created, false, 'the alias prevents the duplicate coming back');
  assert.equal(resolved.entity.id, keep.id);
  c.close();
});

test('an entity cannot be merged into itself', () => {
  const c = new Chitraq({ path: ':memory:' });
  const { entity } = entities.resolve(c.db, { workspaceId: c.workspaceId, name: 'Acme', entityType: 'organisation' });
  assert.throws(() => c.mergeEntities(entity.id, entity.id), /cannot be merged into itself/);
  c.close();
});

test('a hand-added alias resolves future mentions', () => {
  const c = new Chitraq({ path: ':memory:' });
  const { entity } = entities.resolve(c.db, {
    workspaceId: c.workspaceId,
    name: 'Acme Corporation',
    entityType: 'organisation',
  });
  c.addAlias(entity.id, 'Acme Ltd');

  const resolved = entities.resolve(c.db, {
    workspaceId: c.workspaceId,
    name: 'acme ltd',
    entityType: 'organisation',
  });
  assert.equal(resolved.entity.id, entity.id);
  c.close();
});

test('merging does not leave a self-referential edge behind', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.remember({ title: 'Shared note', body: 'Priya Rao and Priya R Rao were both listed.' });

  const all = c.entities();
  const keep = all.find((e) => e.title === 'Priya Rao');
  const dupe = all.find((e) => e.title === 'Priya R Rao');
  if (!keep || !dupe) return; // extraction did not split them; nothing to test

  c.mergeEntities(keep.id, dupe.id);
  const edges = c.recall(keep.id).relations;
  for (const e of [...edges.outgoing, ...edges.incoming]) {
    assert.notEqual(e.other_id, keep.id, 'no entity points at itself after a merge');
  }
  c.close();
});
