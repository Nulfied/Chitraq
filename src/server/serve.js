#!/usr/bin/env node
/**
 * Start Chitraq: memory engine, HTTP API and web interface.
 *
 *     npm start
 *
 * Binds to loopback by default. Memory lives in ~/.chitraq/memory.chitraq
 * unless CHITRAQ_DB says otherwise.
 */

import { Chitraq } from '../chitraq.js';
import { createApp } from './http.js';
import { loadConfig } from '../config.js';

const config = loadConfig();

// `--db <path>` overrides the configured store, so a demo or a second
// workspace can be opened without touching the one you actually use.
const dbFlag = process.argv.indexOf('--db');
if (dbFlag > -1 && process.argv[dbFlag + 1]) config.path = process.argv[dbFlag + 1];

const chitraq = new Chitraq({
  path: config.path,
  policy: config.policy,
  providers: config.providers,
});

const server = createApp(chitraq);

server.listen(config.port, config.host, async () => {
  const { coverage } = await chitraq.capabilities();
  const stats = chitraq.stats();

  console.log('');
  console.log('  Chitraq — the memory engine');
  console.log(`  http://${config.host}:${config.port}`);
  console.log('');
  console.log(`  memory     ${config.path}`);
  console.log(`  holding    ${stats.objects} objects, ${stats.relations} relations, ${stats.sources} sources`);
  console.log(`  pending    ${stats.pendingProposals} proposals, ${stats.openConflicts} open conflicts`);
  console.log('');

  const degraded = Object.entries(coverage).filter(([, c]) => c.degraded).map(([k]) => k);
  const missing = Object.entries(coverage).filter(([, c]) => !c.best).map(([k]) => k);

  console.log(`  answering  ${coverage['answer']?.best ?? 'nothing'}`);
  console.log(`  embedding  ${coverage['embed.text']?.best ?? 'nothing'}`);
  if (degraded.length) {
    console.log(`  note       ${degraded.length} capabilities are on the built-in deterministic floor`);
  }
  if (missing.length) {
    console.log(`  note       no provider for: ${missing.join(', ')}`);
  }
  for (const n of config.notes) console.log(`  ·          ${n}`);
  console.log('');
});

/** Close the store cleanly so WAL data is checkpointed rather than left behind. */
function shutdown(signal) {
  console.log(`\n  ${signal} — closing memory cleanly.`);
  server.close(() => {
    try {
      chitraq.close();
    } catch {
      // Already closed; nothing to recover.
    }
    process.exit(0);
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
