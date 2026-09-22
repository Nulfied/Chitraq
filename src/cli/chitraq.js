#!/usr/bin/env node
/**
 * Chitraq on the command line.
 *
 * The CLI talks to the engine directly rather than to the HTTP server, so it
 * works with no server running — a memory engine you can only reach through a
 * web app is a memory engine you will lose access to.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planFolder, skipSummary, DOCUMENT_EXTENSIONS } from '../capture/folder.js';
import { isRemoteHost } from '../core/sync-http.js';
import { Chitraq } from '../chitraq.js';
import { loadConfig } from '../config.js';
import { runSetup } from './setup.js';
import { render } from '../context/builder.js';

const COMMANDS = {
  setup: { args: '', help: 'Choose an intelligence and check it works. Run this first.' },
  remember: { args: '<text...>', help: 'Capture a note. Use --title, --kind, --body.' },
  ingest: { args: '<file|folder|->', help: 'Capture a document, or every document in a folder.' },
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
  entities: { args: '', help: 'People, places, products and projects found in your notes.' },
  merge: { args: '<keepId> <mergeId>', help: 'Merge two entities into one.' },
  concepts: { args: '', help: 'Ideas that recur across your notes. --propose to suggest them.' },
  watch: { args: '<folder>', help: 'Capture changes to a folder as they happen. Ctrl-C to stop.' },
  notices: { args: '', help: 'Things worth knowing without asking.' },
  costs: { args: '', help: 'What intelligence has cost, by provider and capability.' },
  import: { args: '<file>', help: 'Import a Chitraq export into this memory.' },
  sync: { args: '<url>', help: 'Exchange changes with another Chitraq. Use --push, --pull, --dry-run.' },
  peers: { args: '', help: 'Machines this memory has exchanged changes with.' },
  keys: { args: '', help: 'API keys you have supplied. Add with --set, remove with --remove.' },
  tokens: { args: '', help: 'Let your other programs in. --new <name>, --revoke <name>.' },
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

  // A passphrase, if one is set and supplied. Done before any command runs,
  // because every one of them that reaches a model needs the keys open.
  const lock = chitraq.keyLockState();
  if (lock.exists && process.env.CHITRAQ_PASSPHRASE) {
    try {
      chitraq.unlockKeys(process.env.CHITRAQ_PASSPHRASE);
    } catch (err) {
      console.error(`\n  ${err.message}\n`);
      chitraq.close();
      process.exitCode = 1;
      return;
    }
  }

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
    case 'setup': {
      // The path this instance actually opened, not the configured default —
      // `--db` exists precisely so they can differ, and setup telling you
      // about a memory it is not touching would be worse than saying nothing.
      await runSetup(c, { path: flags.db ?? loadConfig().path });
      break;
    }

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
      if (!target) throw new Error('Give a file path, a folder, or - to read standard input.');

      // One command for one file and for a folder of them. Which one you meant
      // is a question the filesystem can answer, so it does.
      const info = target === '-' ? null : await stat(target).catch(() => null);
      if (info?.isDirectory()) {
        await ingestFolder(target, flags, c);
        break;
      }
      if (target !== '-' && !info) throw new Error(`There is nothing at ${target}.`);

      const result = await c.ingest(
        target === '-'
          ? { text: await readStdin(), filename: 'stdin.txt', title: flags.title }
          : {
              // Bytes, not text: a PDF read as UTF-8 decodes into convincing
              // rubbish, and the parser can only tell the difference if it is
              // handed what is actually on disk.
              bytes: await readFile(target),
              filename: basename(target),
              uri: pathToFileURL(target).href,
              title: flags.title,
              // From the environment rather than a flag, for the same reason
              // API keys are: an argument lands in shell history and in the
              // process list. Only needed for the rare PDF with a real user
              // password; most encrypted ones have none.
              password: process.env.CHITRAQ_PDF_PASSWORD,
            }
      );

      if (result.deduplicated) {
        console.log(`\n  already captured — this is identical to ${result.source.id}\n`);
        break;
      }
      console.log(`\n  captured    ${result.source.id} (${result.parsed.mediaType})`);
      if (result.parsed.needsCapability) {
        const failed = result.parsed.readFailed;
        if (failed) {
          // Something is configured and it said no. Saying "needs
          // speech.transcribe" here would send somebody to install what
          // they already have.
          console.log(`  no text     ${failed.provider ?? 'the provider'} could not read this`);
          console.log(`              ${truncate(String(failed.error), 90)}`);
          if (String(result.parsed.mediaType).startsWith('video/')) {
            console.log('');
            console.log('              A video has to be demuxed and decoded before it is');
            console.log('              audio. Whisper servers that bundle ffmpeg do that');
            console.log('              for you — Speaches, faster-whisper-server, WhisperX,');
            console.log('              or whisper.cpp built with ffmpeg. Chitraq does not');
            console.log('              carry a decoder, so it needs one of those.');
          }
        } else {
          console.log(`  no text     stored as-is; reading it needs ${result.parsed.needsCapability}`);
        }
        console.log('');
        break;
      }
      console.log(`  proposed    ${result.proposals.length} pieces of knowledge`);
      // Which extractor did it, when it was not the best one available. A
      // timed-out model otherwise looks exactly like a model that ran.
      if (result.pieces > 1) console.log(`  read in     ${result.pieces} pieces`);
      if (result.skippedModel) {
        console.log(
          `  used the floor: a model would take about ` +
            `${Math.round(result.skippedModel.estimatedMs / 60000)} min for this`
        );
      }
      if (result.fellBackFrom?.length) {
        for (const f of result.fellBackFrom) {
          console.log(`  ⚠ ${f.provider} ${f.reason} after ${Math.round(f.ms / 1000)}s`);
        }
        console.log(`  read by     ${result.extractedBy} instead`);
      }
      if (result.accepted.length) console.log(`  accepted    ${result.accepted.length} automatically by policy`);
      console.log(`\n  Nothing was written to memory yet. Review with: chitraq review\n`);
      break;
    }

    case 'sync': {
      const url = rest[0];
      if (!url) throw new Error('Give the address of the other Chitraq, e.g. http://192.168.1.20:4317');

      const direction = flags.push ? 'push' : flags.pull ? 'pull' : 'both';

      // Said out loud because it is true and because nothing else in Chitraq
      // does it. Local-first is a promise, and this is the one command that
      // spends it.
      if (isRemoteHost(url) && direction !== 'pull') {
        console.log(`\n  Sending knowledge from this memory to ${url}.`);
      }

      const report = await c.syncOverHttp(url, {
        token: flags.token,
        direction,
        dryRun: !!flags['dry-run'],
        limit: flags.limit ? Number(flags.limit) : undefined,
        timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
      });

      console.log(`\n  peer        ${report.peer.id}`);
      console.log(`  at          ${report.peer.url}`);
      if (report.dryRun) console.log(`  dry run     nothing was written on either side`);

      if (report.pushed) {
        const p = report.pushed;
        console.log(`\n  sent        ${p.objects} object(s), ${p.relations} relation(s), ${p.versions} version(s)`);
        if (p.accepted) console.log(`  they kept   ${describeCounts(p.accepted)}`);
        if (p.conflicts) console.log(`  \u26a0 ${p.conflicts} disagreement(s) raised on their side`);
      }
      if (report.pulled) {
        const p = report.pulled;
        console.log(`\n  received    ${p.objects} object(s), ${p.relations} relation(s)`);
        if (p.applied) console.log(`  merged      ${describeCounts(p.applied)}`);
        if (p.skipped && Object.keys(p.skipped).length) {
          console.log(`  unchanged   ${describeCounts(p.skipped)}`);
        }
        if (p.conflicts?.length) {
          console.log(`  \u26a0 ${p.conflicts.length} object(s) were edited on both sides`);
          console.log(`    Your version was kept and theirs recorded. See: chitraq conflicts`);
        }
      }
      if (!report.pushed && !report.pulled) console.log(`\n  nothing to exchange`);
      if (report.more) {
        console.log(`\n  This moved one batch, not everything. Run the same command again.`);
      }
      console.log('');
      break;
    }

    case 'peers': {
      const list = c.peers();
      if (!list.length) {
        console.log(`\n  This memory has never synced with another machine.`);
        console.log(`  Start one with: chitraq sync http://<other-machine>:4317\n`);
        break;
      }
      console.log('');
      for (const peer of list) {
        console.log(`  ${peer.id}`);
        console.log(`    ${dim(`last contact ${peer.last_contact ?? 'never'}`)}`);
        console.log(`    ${dim(`sent up to ${peer.last_pushed ?? '\u2014'} \u00b7 received up to ${peer.last_pulled ?? '\u2014'}`)}`);
      }
      console.log('');
      break;
    }

    case 'keys': {
      if (flags.lock) {
        const passphrase = process.env.CHITRAQ_PASSPHRASE;
        if (!passphrase) {
          console.log(`\n  Put the passphrase in CHITRAQ_PASSPHRASE, not on the command line:`);
          console.log(`\n    CHITRAQ_PASSPHRASE='...' chitraq keys --lock`);
          console.log(`\n  Nobody can recover it for you. If you lose it, the stored keys are`);
          console.log(`  gone and you set them again \u2014 your memory itself is untouched.\n`);
          process.exitCode = 1;
          break;
        }
        const result = c.lockKeys({ passphrase, hint: flags.hint });
        console.log(`\n  locked      ${result.resealed} key(s) re-sealed under your passphrase`);
        console.log(`  Chitraq now needs CHITRAQ_PASSPHRASE to use them.\n`);
        break;
      }

      if (flags.unlock) {
        const passphrase = process.env.CHITRAQ_PASSPHRASE;
        if (!passphrase) throw new Error('Set CHITRAQ_PASSPHRASE to remove the passphrase.');
        const result = c.unlockKeysPermanently(passphrase);
        console.log(`\n  unlocked    ${result.resealed} key(s) back to file-secret sealing`);
        console.log(`  ${dim('This protects a leaked database, not a machine somebody else can read.')}\n`);
        break;
      }

      if (flags['change-passphrase']) {
        const current = process.env.CHITRAQ_PASSPHRASE;
        const next = process.env.CHITRAQ_NEW_PASSPHRASE;
        if (!current || !next) {
          throw new Error('Set CHITRAQ_PASSPHRASE and CHITRAQ_NEW_PASSPHRASE.');
        }
        c.changeKeyPassphrase({ current, next, hint: flags.hint });
        console.log(`\n  changed     the passphrase\n`);
        break;
      }

      if (flags.remove) {
        const removed = c.removeApiKey({ provider: String(flags.remove) });
        console.log(`\n  removed the ${removed.provider} key\n`);
        break;
      }

      if (flags.test) {
        // Verifying a key already stored. The key never comes back out of the
        // store, so this rebuilds the provider from it internally and makes a
        // real call — the only way to know a credential still works.
        const provider = flags.test === true ? null : String(flags.test);
        const stored = c.apiKeys();
        const targets = provider ? stored.filter((k) => k.provider === provider) : stored;

        if (!targets.length) {
          console.log(`
  No stored key${provider ? ` for ${provider}` : ''}. Add one with: chitraq setup
`);
          process.exitCode = 1;
          break;
        }

        console.log('');
        for (const k of targets) {
          process.stdout.write(`  ${k.provider.padEnd(12)} `);
          const result = await c.verifyStoredKey(k.provider);
          if (result.ok) {
            console.log(`works — ${result.label}`);
            console.log(`  ${''.padEnd(12)} it said: ${truncate(result.sample, 60)}`);
          } else {
            console.log(`FAILED — ${result.error}`);
            process.exitCode = 1;
          }
        }
        console.log('');
        break;
      }

      if (flags.set) {
        const provider = String(flags.set);
        // Read from an environment variable rather than an argument. A key on
        // the command line lands in shell history and in the process list,
        // where it outlives any care taken storing it.
        const key = process.env.CHITRAQ_KEY;
        if (!key) {
          console.log(`\n  Put the key in CHITRAQ_KEY, not on the command line:`);
          console.log(`\n    CHITRAQ_KEY=sk-... chitraq keys --set ${provider}`);
          console.log(`\n  An argument would be recorded in your shell history and visible`);
          console.log(`  to anything that can list processes.\n`);
          process.exitCode = 1;
          break;
        }

        const result = c.setApiKey({ provider, key, label: flags.label });
        console.log(`\n  ${(result.replaced ? 'replaced' : 'stored').padEnd(10)}  the ${provider} key (\u2026${result.hint})`);
        if (result.active) {
          console.log(`  active      Chitraq will use it for ${provider} from now on`);
        } else {
          console.log(`  \u26a0 stored but not active: ${result.error ?? 'nothing here can use a key for that provider yet'}`);
        }
        console.log('');
        break;
      }

      const lockState = c.keyLockState();
      if (lockState.exists && !lockState.unlocked) {
        console.log(`\n  These keys are behind a passphrase, and this session does not have it.`);
        if (lockState.hint) console.log(`  hint: ${lockState.hint}`);
        console.log(`\n    CHITRAQ_PASSPHRASE='...' chitraq keys\n`);
        break;
      }

      const stored = c.apiKeys();
      if (!stored.length) {
        console.log(`\n  No keys stored. Chitraq works without any \u2014 this is only for`);
        console.log(`  reaching a model it does not run itself.`);
        console.log(`\n    CHITRAQ_KEY=sk-... chitraq keys --set anthropic\n`);
        break;
      }
      console.log('');
      for (const k of stored) {
        const state = !k.readable ? 'unreadable' : k.active ? 'active' : 'stored';
        console.log(`  ${k.provider.padEnd(12)} ${k.masked.padEnd(8)} ${state}`);
        console.log(`    ${dim(`added ${k.createdAt}${k.lastUsed ? ` \u00b7 last used ${k.lastUsed}` : ''}`)}`);
        if (!k.readable) {
          console.log(`    ${dim('sealed with a secret this machine no longer has \u2014 set it again')}`);
        }
      }
      console.log('');
      break;
    }

    case 'concepts': {
      if (flags.propose) {
        const result = await c.proposeConcepts({
          minDocuments: flags.min ? Number(flags.min) : undefined,
        });
        console.log(`\n  ${result.found} recurring idea(s), ${result.proposals.length} newly suggested`);
        if (result.proposals.length) console.log(`  Review with: chitraq review`);
        console.log('');
        break;
      }

      const found = c.concepts({ minDocuments: flags.min ? Number(flags.min) : undefined });
      if (!found.length) {
        console.log(`\n  Nothing recurs across enough of your notes yet.`);
        console.log(`  A concept here means a phrase running through several separate`);
        console.log(`  pieces of knowledge \u2014 it needs a body of notes to find one.\n`);
        break;
      }
      console.log('');
      for (const concept of found) {
        console.log(`  ${concept.phrase}`);
        console.log(`    ${dim(`${concept.documents} notes \u00b7 ${concept.occurrences} mentions \u00b7 confidence ${concept.confidence}`)}`);
      }
      console.log(`\n  Suggest these as entities with: chitraq concepts --propose\n`);
      break;
    }

    case 'watch': {
      const target = rest[0];
      if (!target) throw new Error('Give a folder to watch.');

      const info = await stat(target).catch(() => null);
      if (!info?.isDirectory()) throw new Error(`${target} is not a folder.`);

      const opts = {
        recursive: !flags['no-recursive'],
        include: splitList(flags.include),
        only: !!flags.only,
        extract: !flags['no-extract'],
      };

      // Catch up first. A watcher that only notices changes made while it was
      // running leaves a gap nobody can see, and "why is yesterday's note
      // missing" is not a question a memory engine should provoke.
      const initial = await c.ingestFolder(target, opts);
      console.log(`\n  watching    ${target}`);
      if (initial.captured.length) console.log(`  caught up   ${initial.captured.length} new file(s)`);
      console.log(`  ${dim('This runs in the foreground and stops with Ctrl-C. Nothing is installed.')}`);
      if (opts.extract) {
        console.log(`  ${dim('Each change is read for knowledge, which takes time with a local model.')}`);
      }
      console.log('');

      const watcher = c.watch(target, {
        ...opts,
        onEvent: (event) => {
          if (event.type === 'failed') {
            console.log(`  ! ${event.paths.join(', ')}  ${event.error}`);
            return;
          }
          if (event.type === 'error') {
            console.log(`  ! watch error: ${event.error}`);
            return;
          }
          for (const item of event.result?.captured ?? []) {
            console.log(`  + ${stamp()}  ${item.file.relative}`);
          }
          for (const item of event.result?.unchanged ?? []) {
            console.log(`  \u00b7 ${stamp()}  ${item.file.relative}  ${dim('unchanged')}`);
          }
        },
      });

      await new Promise((resolve) => {
        process.on('SIGINT', () => {
          console.log(`\n\n  stopping\u2026 (${watcher.state().queued} still queued)`);
          watcher.stop();
          watcher.done.then(resolve);
        });
      });

      const final = watcher.state();
      console.log(`  captured    ${final.captured} file(s) while watching\n`);
      break;
    }

    case 'tokens': {
      if (flags.revoke) {
        const revoked = c.revokeToken({ name: String(flags.revoke) });
        console.log(
          revoked.alreadyRevoked
            ? `\n  "${revoked.name}" was already revoked\n`
            : `\n  revoked "${revoked.name}" \u2014 it stops working immediately\n`
        );
        break;
      }

      if (flags.new) {
        const issued = c.issueToken({
          name: String(flags.new),
          scope: String(flags.scope ?? 'read'),
          expiresInDays: flags.days ? Number(flags.days) : undefined,
          note: flags.note,
        });

        console.log(`\n  ${issued.token}`);
        console.log(`\n  name        ${issued.name}`);
        console.log(`  scope       ${issued.scope} \u2014 ${SCOPE_MEANS[issued.scope]}`);
        console.log(`  expires     ${issued.expiresAt ?? 'never'}`);
        // Said plainly, because it is true and because the usual mistake is
        // assuming it can be looked up again later.
        console.log(`\n  Copy it now. Chitraq keeps a hash and cannot show it to you again.`);
        console.log(`  Put it in the other project as CHITRAQ_TOKEN.\n`);
        break;
      }

      const issued = c.tokens();
      if (!issued.length) {
        console.log(`\n  No tokens. Your other programs reach this memory over HTTP:`);
        console.log(`\n    chitraq tokens --new formfit --scope write`);
        console.log(`\n  A token narrows what the holder may do. Presenting none changes`);
        console.log(`  nothing, so this is for scoping a program down, not letting it in.\n`);
        break;
      }
      console.log('');
      for (const token of issued) {
        const state = token.revokedAt ? 'revoked' : token.active ? token.scope : 'expired';
        console.log(`  ${token.name.padEnd(20)} ${token.masked.padEnd(14)} ${state}`);
        console.log(
          `    ${dim(`used ${token.useCount} time(s)${token.lastUsed ? `, last ${token.lastUsed}` : ''}`)}`
        );
      }
      console.log('');
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
      const answered = await c.ask(joined, {
        escalate: flags.better ? 'always' : undefined,
        cache: flags['no-cache'] ? false : undefined,
      });

      console.log('');
      if (answered.grounded) {
        console.log(`  ${wrap(answered.answer, 2)}`);
        console.log('');
        const how = answered.cached
          ? 'from an earlier answer'
          : answered.escalated
            ? `written by ${answered.provider}`
            : 'quoted from your own words — no model was called';
        console.log(`  ${dim(`${how} · ${answered.citations.length} item(s) cited`)}`);
        if (answered.ladder?.canEscalate) {
          const wait = answered.ladder.estimatedWaitMs
            ? ` (about ${Math.round(answered.ladder.estimatedWaitMs / 1000)}s on this machine)`
            : '';
          console.log(`  ${dim(`for a written answer instead:  chitraq ask "…" --better${wait}`)}`);
        }
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

    case 'entities': {
      const all = c.entities({ entityType: flags.type, limit: Number(flags.limit ?? 50) });
      if (!all.length) {
        console.log('\n  Nothing resolved yet. Capture some notes with names in them.\n');
        break;
      }
      console.log('');
      for (const e of all) {
        const aliases = e.attrs.aliases?.length ? dim(`  (also ${e.attrs.aliases.join(', ')})`) : '';
        console.log(
          `  ${String(e.mentions).padStart(3)}×  ${e.title}${aliases}  ${dim(`[${e.attrs.entityType}] ${e.id}`)}`
        );
      }

      const duplicates = c.duplicateEntities();
      if (duplicates.length) {
        console.log(`\n  ${duplicates.length} possible duplicate(s):`);
        for (const d of duplicates) {
          console.log(`    "${d.a.title}" / "${d.b.title}"  ${dim(d.because)}`);
          console.log(`      ${dim(`chitraq merge ${d.a.id} ${d.b.id}`)}`);
        }
      }
      console.log('');
      break;
    }

    case 'merge': {
      const [keepId, mergeId] = rest;
      if (!keepId || !mergeId) throw new Error('Usage: chitraq merge <keepId> <mergeId>');
      const result = c.mergeEntities(keepId, mergeId, flags.reason);
      console.log(
        `\n  merged — ${result.movedRelations} mention(s) moved, kept as aliases: ${result.aliases.join(', ') || 'none'}\n`
      );
      break;
    }

    case 'notices': {
      const notices = c.notices();
      if (!notices.length) {
        console.log('\n  Nothing to flag.\n');
        break;
      }
      console.log('');
      for (const n of notices) {
        console.log(`  ${n.message}`);
        console.log(`    ${dim(n.because)}`);
        for (const oid of n.objectIds) console.log(`    ${dim(oid)}`);
        console.log('');
      }
      break;
    }

    case 'costs': {
      const report = c.costs();
      console.log(`\n  ${report.totals.cost} across ${report.totals.calls} calls since ${report.since.slice(0, 10)}`);
      if (report.totals.failures) console.log(`  ${report.totals.failures} call(s) failed`);

      if (report.byProvider.length) {
        console.log('\n  by provider');
        for (const p of report.byProvider) {
          console.log(
            `    ${String(p.calls).padStart(5)}  ${String(p.provider).padEnd(12)} ${p.cost}` +
              dim(`  ${p.avg_latency_ms ?? '?'}ms avg`)
          );
        }
      }
      if (report.byCapability.length) {
        console.log('\n  by capability');
        for (const cap of report.byCapability) {
          console.log(`    ${String(cap.calls).padStart(5)}  ${String(cap.capability).padEnd(20)} ${cap.cost}`);
        }
      }
      console.log('');
      break;
    }

    case 'import': {
      const target = rest[0];
      if (!target) throw new Error('Give the path to a Chitraq export.');
      const payload = JSON.parse(await readFile(target, 'utf8'));

      const result = await c.import(payload, { dryRun: !!flags['dry-run'] });
      const counts = Object.entries(result.imported).map(([k, n]) => `${n} ${k}`).join(', ');

      console.log(`\n  ${result.dryRun ? 'would import' : 'imported'}  ${counts || 'nothing new'}`);
      const skipped = Object.entries(result.skipped).map(([k, n]) => `${n} ${k}`).join(', ');
      if (skipped) console.log(`  already here  ${skipped}`);
      for (const w of result.warnings) console.log(`  ⚠ ${w}`);
      console.log('');
      break;
    }

    case 'review': {
      if (flags['accept-all'] || flags['accept-above'] || flags['reject-all']) {
        const result = await c.reviewAll({
          action: flags['reject-all'] ? 'reject' : 'accept',
          minConfidence: flags['accept-above'] ? Number(flags['accept-above']) : undefined,
          note: 'bulk review from the command line',
        });
        console.log(`\n  ${result.succeeded.length} applied, ${result.failed.length} could not be`);
        for (const f of result.failed.slice(0, 5)) console.log(`    ${dim(`${f.id}: ${f.error}`)}`);
        console.log('');
        break;
      }

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
      console.log(`  Accept with: chitraq accept <id>   ·   Decline with: chitraq reject <id>`);
      console.log(`  Or in bulk:  ${bulkAdvice(c.pendingStats())}\n`);
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
    --accept-all    accept every pending proposal (with 'review')
    --accept-above <n>  accept proposals at or above this confidence
    --dry-run       for 'import' and folder 'ingest': write nothing, report what would happen
    (a PDF needing a password reads it from CHITRAQ_PDF_PASSWORD, not a flag)
    --limit <n>     how many results
    --better        ask a model instead of quoting your own words
    --no-cache      skip the answer cache
    --why           show why each search result ranked where it did
    --context       show the context an answer was built from

  Options for 'tokens'
    --new <name>    mint a token for a program, e.g. --new formfit
    --scope <s>     read (default), write, or admin
    --days <n>      expire after this many days; omitted means never
    --revoke <name> stop a token working, keeping the record it existed

  Options for 'keys'
    --set <provider>   store a key, read from the CHITRAQ_KEY variable
    --remove <provider>  forget a stored key
    --label <text>     a name for it, so you know which key it is
    --lock             put a passphrase over stored keys (CHITRAQ_PASSPHRASE)
    --unlock           remove the passphrase, back to file-secret sealing
    --change-passphrase  CHITRAQ_PASSPHRASE to CHITRAQ_NEW_PASSPHRASE
    --hint <text>      a reminder shown when locked; never the passphrase

  Options for 'sync'
    --push          only send; do not take anything in
    --pull          only receive; send nothing
    --token <t>     a session token, if the other side requires a login
    --dry-run       report what would move, write nothing on either side

  Options for ingesting a folder
    --no-extract    capture the text only; do not propose knowledge (much faster)
    --include <a,b> also capture these extensions, e.g. --include json,csv
    --only          treat --include as the complete list, not an addition
    --no-recursive  only the folder itself
    --hidden        include dotfiles and dot-folders
    --max-mb <n>    skip files larger than this (default 10)
    --rescan        read every file again, even ones that have not changed

  Examples
    chitraq remember "Chose SQLite because it needs no server"
    chitraq ingest notes/architecture.md
    chitraq ingest ~/Documents/notes --dry-run
    chitraq ingest ~/Documents/notes --no-extract
    chitraq search "kind:decision sqlite after:2025-01"
    chitraq ask "why did we drop the redis cache"
    chitraq review
    chitraq sync http://192.168.1.20:4317 --dry-run
    chitraq tokens --new my-other-app --scope write
`);
  process.exitCode = code;
}


/**
 * Capture a folder, reporting as it goes.
 *
 * A bulk import is the one Chitraq operation that can run for an hour, so it is
 * the one that most needs to say what it is doing. Every file prints a line,
 * and the run can be stopped at any point without losing what it has already
 * taken in.
 *
 * @param {string} target
 * @param {Record<string, any>} flags
 * @param {import('../chitraq.js').Chitraq} c
 */
async function ingestFolder(target, flags, c) {
  /** @type {any} */
  const opts = {
    recursive: !flags['no-recursive'],
    hidden: !!flags.hidden,
    include: splitList(flags.include),
    only: !!flags.only,
    limit: flags.limit ? Number(flags.limit) : undefined,
    maxBytes: flags['max-mb'] ? Number(flags['max-mb']) * 1024 * 1024 : undefined,
    extract: !flags['no-extract'],
    rescan: !!flags.rescan,
  };

  const plan = await planFolder(target, opts);
  const skips = skipSummary(plan.skipped);

  console.log(`\n  ${target}`);
  console.log(`  ${plan.files.length} document(s) to capture across ${plan.directories} folder(s)`);
  if (plan.limited) console.log(`  stopping at --limit ${opts.limit}`);
  for (const [reason, n] of Object.entries(skips)) {
    console.log(`  skipped     ${String(n).padStart(4)}  ${reason.replace(/-/g, ' ')}`);
  }
  if (skips['unsupported-type']) {
    console.log(`  types captured by default: ${DOCUMENT_EXTENSIONS.join(', ')} — widen with --include`);
  }

  // Honest about an empty result too: a folder of .ts files reports why it
  // found nothing rather than shrugging.
  if (!plan.files.length) {
    console.log(`\n  Nothing here to capture.\n`);
    return;
  }

  if (flags['dry-run']) {
    console.log('');
    for (const f of plan.files) console.log(`    ${f.relative}`);
    console.log(`\n  Dry run — nothing was written. Drop --dry-run to capture these.\n`);
    return;
  }

  if (opts.extract) {
    console.log(`\n  Each file is read and its contents proposed as knowledge. With a local`);
    console.log(`  model this takes time; --no-extract captures the text only, and is fast.`);
    console.log(`  Stopping with Ctrl-C is safe: finished files stay, and running this`);
    console.log(`  again skips them.`);
  }
  console.log('');

  const width = String(plan.files.length).length;
  const result = await c.ingestFolder(target, {
    ...opts,
    plan,
    onProgress: ({ index, total, file, outcome, detail }) => {
      const mark = outcome === 'failed' ? '!' : outcome === 'already captured' ? '·' : '+';
      const counter = `${String(index).padStart(width)}/${total}`;
      console.log(`  ${mark} ${counter}  ${truncatePath(file.relative, 52).padEnd(52)} ${detail ?? outcome}`);
    },
  });

  console.log(`\n  captured    ${result.captured.length} new`);
  if (result.unchanged.length) {
    console.log(`  untouched   ${result.unchanged.length} not modified since last time (not re-read)`);
  }
  if (result.duplicates.length) console.log(`  unchanged   ${result.duplicates.length} already in memory`);
  if (result.failures.length) {
    console.log(`  failed      ${result.failures.length}`);
    for (const f of result.failures.slice(0, 10)) console.log(`      ${f.file.relative}: ${f.error}`);
    if (result.failures.length > 10) console.log(`      …and ${result.failures.length - 10} more`);
  }
  if (opts.extract) {
    console.log(`  proposed    ${result.proposed} pieces of knowledge`);
    if (result.accepted) console.log(`  accepted    ${result.accepted} automatically by policy`);
  }
  console.log(`  took        ${Math.round(result.elapsedMs / 1000)}s`);

  console.log('');
  const waiting = result.proposed - result.accepted;
  if (waiting > 0) {
    console.log(`  The text is stored, but none of it is searchable yet: ${waiting} proposal(s)`);
    console.log(`  are waiting for you. Nothing enters memory until you say so.`);
    console.log(`\n    chitraq review                       look at them`);
    console.log(`    ${bulkAdvice(c.pendingStats())}`);
  } else if (!opts.extract && result.captured.length) {
    console.log(`  The text is stored verbatim, but --no-extract means nothing was read`);
    console.log(`  out of it, so there is nothing to search yet. Run this again without`);
    console.log(`  that flag when you want it turned into knowledge.`);
  }
  console.log('');
}

/**
 * Render an applied/skipped tally, leaving out the zeroes.
 * @param {Record<string, number>} counts
 */
function describeCounts(counts) {
  const parts = Object.entries(counts ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return parts.length ? parts.join(', ') : 'nothing';
}

/**
 * Suggest a bulk review command that will actually do something.
 *
 * Recommending a fixed threshold is only honest when confidence varies. When
 * a model emits one default for nearly everything — which a small local one
 * routinely does — the threshold silently takes almost nothing, and the
 * person concludes the extraction found nothing worth keeping.
 *
 * @param {any} stats from chitraq.pendingStats()
 */
function bulkAdvice(stats) {
  if (!stats?.total) return 'chitraq review --accept-all';

  if (stats.degenerate) {
    return (
      `chitraq review --accept-all\n` +
      `  ${dim(`${Math.round(stats.commonestShare * 100)}% of these carry the same confidence ` +
        `(${stats.commonest}), so a threshold would not sort them. Judge them by source instead.`)}`
    );
  }

  // Offer a threshold only where it leaves a useful amount on each side.
  for (const t of [0.7, 0.6, 0.5]) {
    const n = stats.wouldAcceptAbove(t);
    if (n >= 3 && n < stats.total) {
      return `chitraq review --accept-above ${t}   ${dim(`takes ${n} of ${stats.total}`)}`;
    }
  }
  return `chitraq review --accept-all   ${dim(`all ${stats.total}`)}`;
}

/** What each scope actually permits, in the words the help uses. */
const SCOPE_MEANS = {
  read: 'search, ask, recall',
  write: 'all of read, plus capture and review',
  admin: 'everything, including erase and credentials',
};

/** Wall-clock time, so a long watch reads as a log rather than a wall. */
function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

/** @param {any} v */
function splitList(v) {
  if (typeof v !== 'string') return undefined;
  return v.split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * Shorten a path from the left. The filename is the part worth reading, so it
 * is the part that survives.
 *
 * @param {string} s @param {number} n
 */
function truncatePath(s, n) {
  return s.length <= n ? s : `…${s.slice(-(n - 1))}`;
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
