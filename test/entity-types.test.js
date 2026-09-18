/**
 * Entity kinds beyond people and organisations.
 *
 * STATUS.md listed this as a weakness: places, products and projects were
 * extracted as attributes and never resolved into entities you could browse or
 * merge. They are now — by shape and by a deliberately short list, never by
 * guessing.
 *
 * Most of what follows tests restraint. Precision matters more than coverage
 * here, because a wrong entity is not a missing entity: it is a node in the
 * graph, in the sidebar, and in every context an answer is built from, and it
 * has to be found and merged away by hand.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entities } from '../src/intelligence/providers/deterministic.js';
import { isKnownPlace, COUNTRIES, CITIES } from '../src/core/gazetteer.js';
import { entityTypeFor, EntityType } from '../src/core/entities.js';
import { Chitraq } from '../src/chitraq.js';

/** @param {string} text */
function byType(text) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const e of entities(text)) (out[e.type] ??= []).push(e.text);
  return out;
}

test('places come from cue phrases and from a short list', () => {
  const found = byType(
    'We are based in Pune. The team flew to Singapore last week, and the ' +
      'office in Bengaluru opened in March.'
  );
  assert.deepEqual(found.place?.sort(), ['Bengaluru', 'Pune', 'Singapore']);
});

test('a place-shaped name needs no list at all', () => {
  const found = byType('Meet me on Oxford Street, then Heathrow Airport.');
  assert.ok(found.place.includes('Oxford Street'));
  assert.ok(found.place.includes('Heathrow Airport'));
});

test('"in" alone is not a location cue', () => {
  // The loose reading of "in X" turns every abstraction into a place. Only
  // phrasings that are almost always geographic are treated as cues.
  const found = byType('We wrote it in Rust. It failed in Production. Believe in Yourself.');
  assert.equal(found.place, undefined, 'none of these are places');
});

test('products are recognised by what follows them, not by a catalogue', () => {
  const found = byType('We upgraded to Postgres 16 and wrote the Billing API against Node 24.');
  assert.ok(found.product.includes('Postgres'));
  assert.ok(found.product.includes('Billing'), 'the API suffix is the signal');
  assert.ok(found.product.includes('Node'));
});

test('projects are recognised from how people actually write about them', () => {
  const found = byType('Project Nimbus starts soon. The Atlas migration finishes in March.');
  assert.deepEqual(found.project?.sort(), ['Atlas', 'Nimbus']);

  // And not as a person called "Project Nimbus" alongside. A cue word that
  // introduces a name is grammar, not part of it.
  assert.ok(!(found.name ?? []).some((n) => n.includes('Project')));
  assert.ok(!(found.name ?? []).some((n) => n.startsWith('The ')));
});

test('one name yields one entity, at its strongest reading', () => {
  // "based in Pune" says place with confidence; the capitalised-word sweep says
  // it again with a shrug. Two rows here means two Punes in the graph.
  const all = entities('We are based in Pune. Pune is growing.');
  const punes = all.filter((e) => e.text === 'Pune');
  assert.equal(punes.length, 1);
  assert.equal(punes[0].type, 'place');
  assert.equal(punes[0].confidence, 0.75, 'the confident reading won');
});

test('a name that starts a sentence is no longer clipped', () => {
  // It used to come back as "Sharma": the first word of a sentence was skipped
  // because its capital is grammar. A run of capitals still means something.
  const found = byType('The build passed. Priya Sharma approved the change.');
  assert.ok(found.name.includes('Priya Sharma'));
});

test('but a single capital at a sentence start still proves nothing', () => {
  const found = byType('It shipped. However the plan changed. Meanwhile we waited.');
  assert.equal(found.name, undefined);
});

test('legal suffixes still win over everything else', () => {
  const found = byType('Dr Rao joined from Infosys Limited, then Acme Labs.');
  assert.ok(found.organisation.includes('Infosys Limited'));
  assert.ok(found.organisation.includes('Acme Labs'));
  assert.ok(!(found.name ?? []).some((n) => n.startsWith('Dr ')), 'a title is not part of a name');
});

test('values stay values: a date is not an entity', () => {
  assert.equal(entityTypeFor('date'), null);
  assert.equal(entityTypeFor('money'), null);
  assert.equal(entityTypeFor('percent'), null);
  assert.equal(entityTypeFor('version'), null);

  // The new kinds do resolve, which is the whole point of the change.
  assert.equal(entityTypeFor('place'), EntityType.Place);
  assert.equal(entityTypeFor('product'), EntityType.Product);
  assert.equal(entityTypeFor('project'), EntityType.Project);
});

test('the gazetteer stays small and says what it holds', () => {
  assert.equal(isKnownPlace('India'), true);
  assert.equal(isKnownPlace('the United States'), true);
  assert.equal(isKnownPlace('Bengaluru'), true);
  assert.equal(isKnownPlace('Riverside Road'), true);

  // Not a geography database. A place it cannot know is honestly not known,
  // and gets found by sentence cue instead.
  assert.equal(isKnownPlace('Thiruvananthapuram'), false);
  assert.ok(COUNTRIES.size < 200, 'countries only');
  assert.ok(CITIES.size < 200, 'and the large cities');
});

test('places and products become linked entities, end to end', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  await c.remember({
    title: 'Infrastructure move',
    body:
      'We are based in Pune and opened an office in Singapore. ' +
      'We upgraded to Postgres 16. The Atlas migration finishes in March.',
  });

  const found = c.entities();
  const types = Object.fromEntries(found.map((e) => [e.title, e.attrs?.entityType]));

  assert.equal(types.Pune, 'place');
  assert.equal(types.Singapore, 'place');
  assert.equal(types.Postgres, 'product');
  assert.equal(types.Atlas, 'project');
});
