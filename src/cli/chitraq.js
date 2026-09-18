#!/usr/bin/env node
/**
 * Chitraq on the command line.
 *
 * The CLI talks to the engine directly rather than to the HTTP server, so it
 * works with no server running — a memory engine you can only reach through a
 * web app is a memory engine you will lose access to.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Chitraq } from '../chitraq.js';
import { loadConfig } from '../config.js';
import { render } from '../context/builder.js';

const COMMANDS = {
  remember: { args: '<text...>', help: 'Capture a note. Use --title, --kind, --body.' },
  ingest: { args: '<file|->', help: 'Capture a document and propose what it contains.' },
  search: { args: '<query...>', help: 'Search memory. Supports kind:, after:, "phrases", -exclude.' },
  ask: { args: '<question...>', help: 'Ask a question and get an answer grounded in memory.' },
  show: { args: '<id>', help: 'Everything about one object: history, links, evidence, provenance.' },
  timeline: { args: '', help: 'What happened, most recent first.' },
  connect: { args: '<srcId> <type> <dstId>', help: 'Assert a relationship.' },
  review: { args: '', help: 'Proposals waiting for your decision.' },
  accept: { args: '<proposalId>', help: 'Accept a proposal into memory.' },
  reject: { args: '<proposalId>', help: 'Decline a proposal. It is kept, marked rejected.' },
  confirm: { args: '<id>', help: 'Mark knowledge as checked by you.' },
  correct: { args: '<id> <text...>', help: 'Correct knowledge, keeping the old version.' },
  conflicts: { args: '', help: 'Disagreements Chitraq has noticed.' },
  forget: { args: '<id>', help: 'Remove from retrieval, keeping history.' },
  erase: { args: '<id> <reason...>', help: 'Irreversibly destroy an object and its history.' },
  status: { args: '', help: 'What memory holds and which intelligence is available.' },
  reindex: { args: '', help: 'Rebuild every derived index from the objects.' },
  export: { args: '', help: 'Print the whole workspace as JSON.' },
  history: { args: '', help: 'The audit log: what changed, when, and by what.' },
};

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return usage();
  }
  if (!(command in COMMANDS)) {
    console.error(`Unknown command "${command}".\n`);
    return usage(1);
  }

  const { flags, rest } = parseArgs(argv.slice(1));
  const config = loadConfig();
  const chitraq = new Chitraq({
    path: flags.db ?? config.path,
    policy: config.policy,
    providers: config.providers,
  });

  try {
    await run(command, rest, flags, chitraq);
  } catch (err) {
    console.error(`\n  ${err?.name ?? 'Error'}: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  } finally {
    chitraq.close();
  }
}

/**
 * @param {string} command
 * @param {string[]} rest
 * @param {Record<string, any>} flags
 * @param {Chitraq} c
 */
async function run(command, rest, flags, c) {
  const joined = rest.join(' ');

  switch (command) {
    case 'remember': {
      const title = flags.title ?? firstLine(joined);
      const body = flags.body ?? (flags.title ? joined : restOfText(joined));
      if (!title) throw new Error('Nothing to remember. Give some text, or use --title.');

      const { object, enrichment } = await c.remember({
        title,
        body,
        kind: flags.kind,
        epistemic: flags.epistemic,
        occurredAt: flags.when,
      });

      console.log(`\n  remembered  ${object.id}`);
      console.log(`  ${object.title}`);
      if (enrichment?.keywords?.length) console.log(`  keywords    ${enrichment.keywords.join(', ')}`);
      if (enrichment?.conflicts?.length) {
        console.log(`  ⚠ this disagrees with ${enrichment.conflicts.length} thing(s) already in memory`);
      }
      if (enrichment?.proposals?.length) {
        console.log(`  ${enrichment.proposals.filter((p) => p.status === 'pending').length} suggestion(s) waiting — run: chitraq review`);
      }
      console.log('');
      break;
    }

    case 'ingest': {
      const target = rest[0];
      if (!target) throw new Error('Give a file path, or - to read standard input.');

      const text = target === '-' ? await readStdin() : await readFile(target, 'utf8');
      const result = await c.ingest({
        text,
        filename: target === '-' ? 'stdin.txt' : basename(target),
        uri: target === '-' ? undefined : `file://${target}`,
        title: flags.title,
      });

      if (result.deduplicated) {
        console.log(`\n  already captured — this is identical to ${result.source.id}\n`);
        break;
      }
      console.log(`\n  captured    ${result.source.id} (${result.parsed.mediaType})`);
      console.log(`  proposed    ${result.proposals.length} pieces of knowledge`);
      if (result.accepted.length) console.log(`  accepted    ${result.accepted.length} automatically by policy`);
      console.log(`\n  Nothing was written to memory yet. Review with: chitraq review\n`);
      break;
    }

    case 'search': {
      if (!joined) throw new Error('Give something to search for.');
      const found = await c.search(joined, { limit: Number(flags.limit ?? 10), includeArchived: !!flags.all });

      if (!found.results.length) {
        console.log(`\n  Nothing in memory matches "${joined}".\n`);
        break;
      }
      console.log(`\n  ${found.total} match(es) via ${found.signals.join(' + ')} in ${found.latencyMs}ms\n`);
      for (const r of found.results) {
        console.log(`  ${r.id}`);
        console.log(`  ${r.title}  ${dim(`[${r.kind} · ${r.epistemic} · ${r.origin}${r.review === 'confirmed' ? ' · confirmed' : ''}]`)}`);
        if (r.excerpt) console.log(`    ${wrap(r.excerpt, 4)}`);
        if (flags.why) console.log(`    ${dim(`why: ${Object.keys(r.why).join(', ')} · score ${r.score}`)}`);
        console.log('');
      }
      break;
    }

    case 'ask': {
      if (!joined) throw new Error('Give a question.');
      const answered = await c.ask(joined);

      console.log('');
      if (answered.grounded) {
        console.log(`  ${wrap(answered.answer, 2)}`);
        console.log('');
        console.log(`  ${dim(`from ${answered.citations.length} item(s) in memory · ${answered.provider}`)}`);
        for (const id of answered.citations) {
          const obj = c.recall(id)?.object;
          if (obj) console.log(`    ${dim(id)}  ${obj.title}`);
        }
      } else {
        console.log(`  ${wrap(answered.uncertainty, 2)}`);
        if (answered.context.items.length) {
          console.log(`\n  Related material that did not answer it:`);
          for (const i of answered.context.items.slice(0, 5)) {
            console.log(`    ${dim(i.id)}  ${i.title}  ${dim(`(${i.reason})`)}`);
          }
        }
      }

      if (answered.conflicts?.length) {
        console.log(`\n  ⚠ ${answered.conflicts.length} disagreement(s) in this material:`);
        for (const conflict of answered.conflicts) {
          console.log(`    ${conflict.detail?.reason ?? conflict.kind}`);
        }
      }
      if (flags.context) {
        console.log(`\n${dim('--- context used ---')}\n${render(answered.context)}`);
      }
      console.log('');
      break;
    }

    case 'show': {
      const found = c.recall(rest[0]);
      if (!found) throw new Error(`No object ${rest[0]}`);
      const o = found.object;

      console.log(`\n  ${o.title}`);
      console.log(`  ${dim(`${o.id} · ${o.kind} · ${o.epistemic} · from ${o.origin} · ${o.review} · v${o.head_version}`)}`);
      if (o.confidence !== null) console.log(`  ${dim(`confidence ${o.confidence}`)}`);
      if (o.state !== 'active') console.log(`  ${dim(`state: ${o.state}${o.superseded_by ? ` → ${o.superseded_by}` : ''}`)}`);
      if (o.body) console.log(`\n  ${wrap(o.body, 2)}`);

      section('relationships', [
        ...found.relations.outgoing.map((r) => `${r.type.replace(/_/g, ' ')} → ${r.other_title}  ${dim(r.other_id)}`),
        ...found.relations.incoming.map((r) => `${r.display_type.replace(/_/g, ' ')} → ${r.other_title}  ${dim(r.other_id)}`),
      ]);

      section('evidence', found.evidence.map((e) =>
        `${e.stance}: ${e.source_title ?? e.object_title ?? e.source_id}${e.excerpt ? ` — "${truncate(e.excerpt, 70)}"` : ''}`
      ));

      section('history', found.history.map((h) =>
        `v${h.version} ${h.change_kind}${h.change_reason ? ` (${h.change_reason})` : ''} ${dim(h.recorded_at)}`
      ));

      section('provenance', found.provenance.map((p) =>
        `v${p.target_version} via ${p.method}${p.model ? ` [${p.model}]` : ''}`
      ));

      if (found.conflicts.length) {
        section('⚠ conflicts', found.conflicts.map((cf) => cf.detail?.reason ?? cf.kind));
      }
      console.log('');
      break;
    }

    case 'timeline': {
      const items = c.timeline({ limit: Number(flags.limit ?? 25) });
      console.log('');
      for (const o of items) {
        const when = (o.occurred_at ?? o.created_at).slice(0, 10);
        console.log(`  ${dim(when)}  ${o.title}  ${dim(`[${o.kind}] ${o.id}`)}`);
      }
      if (!items.length) console.log('  Memory is empty.');
      console.log('');
      break;
    }

    case 'connect': {
      const [srcId, type, dstId] = rest;
      if (!srcId || !type || !dstId) throw new Error('Usage: chitraq connect <srcId> <type> <dstId>');
      const result = c.connect(srcId, type, dstId, { note: flags.note });
      console.log(
        result.blocked
          ? `\n  refused: ${result.reason}\n`
          : `\n  ${result.created ? 'connected' : 'updated'}  ${srcId} ${type} ${dstId}\n`
      );
      break;
    }

    case 'review': {
      const pending = c.pending({ limit: Number(flags.limit ?? 20) });
      if (!pending.length) {
        console.log('\n  Nothing waiting for review.\n');
        break;
      }
      console.log(`\n  ${pending.length} proposal(s) waiting:\n`);
      for (const p of pending) {
        console.log(`  ${p.id}  ${dim(`${p.op} · ${p.provider ?? 'unknown'} · confidence ${p.confidence ?? '—'}`)}`);
        console.log(`    ${describeProposal(p)}`);
        if (p.rationale) console.log(`    ${dim(p.rationale)}`);
        console.log('');
      }
      console.log(`  Accept with: chitraq accept <id>   ·   Decline with: chitraq reject <id>\n`);
      break;
    }

    case 'accept': {
      const result = await c.accept(rest[0], flags.note);
      console.log(`\n  accepted — created ${result.applied.kind} ${result.applied.id}\n`);
      break;
    }

    case 'reject': {
      c.decline(rest[0], rest.slice(1).join(' ') || flags.note);
      console.log(`\n  declined. It stays in memory marked rejected, with your reason.\n`);
      break;
    }

    case 'confirm': {
      const o = c.confirm(rest[0], flags.note);
      console.log(`\n  confirmed  ${o.title}\n`);
      break;
    }

    case 'correct': {
      const [id, ...text] = rest;
      const updated = await c.correct(id, { body: text.join(' ') }, flags.reason ?? 'corrected');
      console.log(`\n  corrected  now at v${updated.head_version}; v${updated.head_version - 1} is still readable\n`);
      break;
    }

    case 'conflicts': {
      const open = c.conflicts({ status: flags.status ?? 'open' });
      if (!open.length) {
        console.log('\n  No open conflicts.\n');
        break;
      }
      console.log('');
      for (const cf of open) {
        console.log(`  ${cf.id}  ${dim(`${cf.kind} · confidence ${cf.confidence ?? '—'} · found by ${cf.detected_by}`)}`);
        console.log(`    ${cf.a_title}  ${dim(cf.a_id)}`);
        if (cf.b_id) console.log(`    ${cf.b_title}  ${dim(cf.b_id)}`);
        if (cf.detail?.reason) console.log(`    ${dim(cf.detail.reason)}`);
        console.log('');
      }
      break;
    }

    case 'forget': {
      c.forget(rest[0], flags.reason);
      console.log(`\n  removed from retrieval. History is intact; erase permanently with: chitraq erase ${rest[0]} <reason>\n`);
      break;
    }

    case 'erase': {
      const [id, ...reason] = rest;
      if (!reason.length) throw new Error('Erasing destroys history. State a reason.');
      c.erase(id, reason.join(' '));
      console.log(`\n  erased ${id} permanently. Only the fact of erasure remains in the log.\n`);
      break;
    }

    case 'status': {
      const stats = c.stats();
      const { providers, coverage, policy } = await c.capabilities();

      console.log(`\n  memory`);
      console.log(`    ${stats.objects} objects · ${stats.versions} versions · ${stats.relations} relations`);
      console.log(`    ${stats.sources} sources · ${stats.chunks} chunks · ${stats.embeddings} embeddings`);
      console.log(`    ${stats.events} events · ${stats.pendingProposals} pending · ${stats.openConflicts} conflicts`);

      if (stats.byKind.length) {
        console.log(`\n  by kind`);
        for (const k of stats.byKind) console.log(`    ${String(k.n).padStart(5)}  ${k.kind}`);
      }
      if (stats.byOrigin.length) {
        console.log(`\n  by origin`);
        for (const o of stats.byOrigin) console.log(`    ${String(o.n).padStart(5)}  ${o.origin}`);
      }

      console.log(`\n  intelligence  ${dim(`prefer ${policy.prefer} · remote ${policy.allowRemote ? 'on' : 'off'} · paid ${policy.allowPaid ? 'on' : 'off'}`)}`);
      for (const p of providers) {
        console.log(`    ${p.available ? '●' : '○'} ${p.label}  ${dim(`${p.locality} · ${p.cost}${p.deterministic ? ' · deterministic' : ''}`)}`);
      }

      console.log(`\n  capabilities`);
      for (const [name, cov] of Object.entries(coverage)) {
        const mark = !cov.best ? '✗' : cov.degraded ? '·' : '●';
        console.log(`    ${mark} ${name.padEnd(18)} ${cov.best ?? dim('no provider')}${cov.degraded ? dim(' (deterministic floor)') : ''}`);
      }
      console.log('');
      break;
    }

    case 'reindex': {
      process.stdout.write('  reindexing');
      const result = await c.reindex((n, total) => {
        if (n % 10 === 0 || n === total) process.stdout.write('.');
      });
      console.log(`\n  rebuilt ${result.chunks} chunks from ${result.objects} objects\n`);
      break;
    }

    case 'export':
      console.log(JSON.stringify(c.export(), null, 2));
      break;

    case 'history': {
      for (const e of c.history({ limit: Number(flags.limit ?? 40) })) {
        console.log(`  ${dim(e.at.slice(0, 19).replace('T', ' '))}  ${e.type.padEnd(22)} ${dim(e.subject_id ?? '')}`);
      }
      break;
    }
  }
}

/** @param {any} p */
function describeProposal(p) {
  switch (p.op) {
    case 'create_object':
      return `new ${p.payload.kind ?? 'note'}: "${truncate(p.payload.title, 90)}"`;
    case 'update_object':
      return `change ${Object.keys(p.payload.patch ?? {}).join(', ')} on ${p.payload.objectId}`;
    case 'create_relation':
      return `link ${p.payload.srcId} ${p.payload.type} ${p.payload.dstId}`;
    case 'set_attributes':
      return `tag ${p.payload.objectId} with ${JSON.stringify(p.payload.attrs).slice(0, 90)}`;
    case 'link_evidence':
      return `attach evidence to ${p.payload.targetId}`;
    default:
      return p.op;
  }
}

function usage(code = 0) {
  console.log(`
  Chitraq — the memory engine

    chitraq <command> [options]

`);
  for (const [name, spec] of Object.entries(COMMANDS)) {
    console.log(`    ${`${name} ${spec.args}`.padEnd(30)} ${spec.help}`);
  }
  console.log(`
  Options
    --db <path>     use a specific memory store
    --limit <n>     how many results
    --why           show why each search result ranked where it did
    --context       show the context an answer was built from

  Examples
    chitraq remember "Chose SQLite because it needs no server"
    chitraq ingest notes/architecture.md
    chitraq search "kind:decision sqlite after:2025-01"
    chitraq ask "why did we drop the redis cache"
    chitraq review
`);
  process.exitCode = code;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const flags = {};
  /** @type {string[]} */
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

function readStdin() {
  return new Promise((res, rej) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => res(data));
    process.stdin.on('error', rej);
  });
}

/** @param {string} label @param {string[]} lines */
function section(label, lines) {
  if (!lines.length) return;
  console.log(`\n  ${label}`);
  for (const l of lines) console.log(`    ${l}`);
}

/** @param {string} s */
function firstLine(s) {
  return s.split('\n')[0].trim().slice(0, 200);
}

/** @param {string} s */
function restOfText(s) {
  const nl = s.indexOf('\n');
  return nl < 0 ? '' : s.slice(nl + 1).trim();
}

/** @param {string} s @param {number} n */
function truncate(s, n) {
  return !s ? '' : s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** @param {string} text @param {number} indent */
function wrap(text, indent, width = 78) {
  if (!text) return '';
  const pad = ' '.repeat(indent);
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if ((line + word).length > width) {
        out.push(line.trimEnd());
        line = '';
      }
      line += `${word} `;
    }
    out.push(line.trimEnd());
  }
  return out.join(`\n${pad}`);
}

/** @param {string} s */
function dim(s) {
  return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}

main();
