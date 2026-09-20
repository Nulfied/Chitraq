/**
 * First run: pick an intelligence, paste a key, prove it works.
 *
 * Chitraq works with nothing configured — the deterministic floor is not a
 * placeholder — but the difference a real model makes to extraction and
 * answering is large, and until now finding that out meant reading the
 * README, learning that keys are stored encrypted, discovering the
 * `CHITRAQ_KEY` environment variable, and guessing which providers exist.
 *
 * It also fixes something more specific. The Claude adapter had never been
 * run against a live API, because a key costs money. Shipping code nobody
 * has executed is bad; the honest repair is not to pretend otherwise but to
 * make the moment a key arrives the moment it gets tested. So this does not
 * store a key and hope. It makes a real call with it, shows what came back,
 * and only stores it if that worked. Every user verifies their own path.
 *
 * Three rules it holds:
 *
 *   **The key is typed, never passed.** Not an argument, so it stays out of
 *   shell history and out of the process list. Not echoed, so it stays off
 *   the screen. It goes straight to the encrypted store.
 *
 *   **Free before paid.** The list leads with providers that have a no-cost
 *   tier, because the person most helped by this is the one who cannot spend
 *   anything. Paid options are there and are labelled.
 *
 *   **Nothing happens silently.** Turning on remote calls is a real change —
 *   text leaves the machine — so it is stated and confirmed, not implied by
 *   having pasted a key.
 */

import { PRESETS } from '../intelligence/providers/openai-compatible.js';
import { Capability } from '../intelligence/registry.js';
import { providerFromKey } from '../intelligence/providers/from-key.js';

// Named rather than written inline. These began as literal control bytes
// in the source, which works and is a bad idea: an unprintable byte is
// invisible in review and the kind of thing an editor silently eats.
const CTRL_C = '\u0003';
const BACKSPACE = '\u0008';
const DELETE = '\u007f';

/** Where Ollama listens unless told otherwise. */
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

/**
 * @typedef {object} Choice
 * @property {string} name      provider key, as the key store names it
 * @property {string} label
 * @property {'free'|'paid'} cost
 * @property {string|null} keyUrl
 * @property {string} note
 */

/**
 * The providers offered, free tiers first.
 *
 * Anthropic is included and is last, because it is the best of these and the
 * one nobody can try without paying — putting it first would lead with the
 * door that is closed.
 *
 * @returns {Choice[]}
 */
export function choices() {
  const fromPresets = Object.entries(PRESETS)
    .filter(([name]) => name !== 'local')
    .map(([name, p]) => ({
      name,
      label: p.label,
      cost: /** @type {'free'|'paid'} */ (p.cost),
      keyUrl: p.keyUrl,
      note: p.cost === 'free' ? 'has a free tier' : 'metered',
    }));

  const local = {
    name: 'local',
    label: PRESETS.local.label,
    cost: /** @type {'free'|'paid'} */ ('free'),
    keyUrl: null,
    note: 'llama.cpp, LM Studio, vLLM — nothing leaves the machine',
  };

  const anthropic = {
    name: 'anthropic',
    label: 'Claude',
    cost: /** @type {'free'|'paid'} */ ('paid'),
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: 'highest quality; needs the SDK — npm install @anthropic-ai/sdk',
  };

  const free = fromPresets.filter((c) => c.cost === 'free');
  const paid = fromPresets.filter((c) => c.cost === 'paid');
  return [...free, local, ...paid, anthropic];
}

/**
 * Is Ollama running, and with what?
 *
 * Asked before anything else because if it is there the answer may be "you
 * already have what you need" — and a setup flow that sells a remote key to
 * somebody with a local model running is not helping.
 *
 * @param {{fetch?: typeof fetch, url?: string}} [opts]
 */
export async function probeOllama(opts = {}) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const url = `${(opts.url ?? OLLAMA).replace(/\/+$/, '')}/api/tags`;
  try {
    const response = await doFetch(url, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { running: false, models: [] };
    const payload = await response.json();
    const models = (payload?.models ?? []).map((/** @type {any} */ m) => m.name).filter(Boolean);
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  }
}

/**
 * Make one real call with a key and say what happened.
 *
 * This is the point of the whole file. A key that is stored but never used
 * is a key you find out about later, in the middle of something else, from
 * an error that does not mention setup. Summarise is the cheapest capability
 * and exercises the entire path: request shape, auth, structured output,
 * parsing.
 *
 * @param {string} provider
 * @param {string} key
 * @param {{model?: string, baseUrl?: string, fetch?: typeof fetch}} [opts]
 * @returns {Promise<{ok: true, label: string, sample: string} | {ok: false, label: string, error: string}>}
 */
export async function verifyKey(provider, key, opts = {}) {
  const built = providerFromKey(provider, key, {
    model: opts.model,
    baseUrl: opts.baseUrl,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  if (!built) {
    return { ok: false, label: provider, error: `No adapter knows what to do with "${provider}".` };
  }

  const capability = built.capabilities?.[Capability.Summarize];
  if (!capability) {
    return { ok: false, label: built.label, error: 'This provider does not summarise.' };
  }

  try {
    const result = await capability.run({
      text:
        'Chitraq is a persistent computational memory. A deterministic core owns identity, ' +
        'versioning and provenance, while replaceable intelligence works over it.',
      maxSentences: 1,
    });
    const sample = String(result?.summary ?? '').trim();
    if (!sample) return { ok: false, label: built.label, error: 'It replied, but with nothing.' };
    return { ok: true, label: built.label, sample };
  } catch (err) {
    return {
      ok: false,
      label: built.label,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Read a line without putting it on the screen.
 *
 * Node has no masked prompt, so this is raw mode by hand. It matters: a key
 * echoed into a terminal ends up in scrollback, in screen shares and in
 * whatever the terminal logs.
 *
 * @param {string} prompt
 * @returns {Promise<string>}
 */
export function askSecret(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(new Error('A key can only be typed into a terminal.'));
      return;
    }

    process.stdout.write(prompt);
    let value = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    /** @param {string} chunk */
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          done();
          return;
        }
        if (ch === CTRL_C) {
          // Ctrl-C during a key prompt should leave nothing behind.
          done(new Error('cancelled'));
          return;
        }
        if (ch === BACKSPACE || ch === DELETE) {
          value = value.slice(0, -1);
          continue;
        }
        // Ignore the rest of the control range rather than storing it.
        if (ch >= ' ') value += ch;
      }
    };

    /** @param {Error} [err] */
    function done(err) {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    }

    input.on('data', onData);
  });
}

/**
 * Read a visible line — a menu choice, a yes or no.
 *
 * @param {string} prompt
 * @returns {Promise<string>}
 */
export function askLine(prompt) {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const input = process.stdin;
    input.resume();
    input.setEncoding('utf8');

    /** @param {string} chunk */
    const onData = (chunk) => {
      input.off('data', onData);
      input.pause();
      resolve(String(chunk).trim());
    };
    input.once('error', reject);
    input.on('data', onData);
  });
}

/**
 * The whole first-run conversation.
 *
 * @param {any} chitraq
 * @param {{path?: string}} [info]
 */
export async function runSetup(chitraq, info = {}) {
  const line = (s = '') => console.log(s);

  line('');
  line('  Chitraq — setup');
  line('');
  if (info.path) line(`  memory     ${info.path}`);

  const existing = chitraq.apiKeys();
  if (existing.length) {
    line(`  configured ${existing.map((/** @type {any} */ k) => k.provider).join(', ')}`);
  }
  line('');

  // Step one is always the same question: do you already have what you need?
  process.stdout.write('  Looking for Ollama... ');
  const ollama = await probeOllama();
  if (ollama.running) {
    line(`found, ${ollama.models.length} model(s)`);
    if (ollama.models.length) line(`  ${''.padEnd(9)} ${ollama.models.slice(0, 4).join(', ')}`);
    line('');
    line('  That is a working local intelligence: free, private, nothing leaves');
    line('  this machine. Chitraq will use it. A hosted model is usually better');
    line('  at extraction and answering, and you can add one below.');
  } else {
    line('not running');
    line('');
    line('  Chitraq works without any model — the built-in deterministic floor');
    line('  handles every capability offline. It will not connect "car" to');
    line('  "automobile", which is the main thing a real model buys you.');
    line('');
    line('  For a local one: install Ollama, then `ollama pull llama3.2`.');
  }
  line('');

  if (!process.stdin.isTTY) {
    line('  Not a terminal, so there is nothing to type into. To add a key');
    line('  without an interactive prompt:');
    line('');
    line('    CHITRAQ_KEY=... chitraq keys --set groq');
    line('    chitraq keys --test');
    line('');
    return;
  }

  const options = choices();
  line('  Add a hosted model? Free tiers first.');
  line('');
  options.forEach((choice, i) => {
    const tag = choice.cost === 'free' ? 'free' : 'paid';
    line(`    ${String(i + 1).padStart(2)}. ${choice.label.padEnd(30)} ${tag.padEnd(5)} ${choice.note}`);
  });
  line('');
  line('     0. skip — use what is already here');
  line('');

  const picked = await askLine('  Choose a number: ');
  const index = Number(picked);
  if (!picked || index === 0 || !Number.isInteger(index) || index < 1 || index > options.length) {
    line('');
    line('  Nothing added. Run `chitraq setup` again whenever you want to.');
    line('');
    return;
  }

  const choice = options[index - 1];
  line('');
  line(`  ${choice.label}`);
  if (choice.keyUrl) line(`  Get a key: ${choice.keyUrl}`);
  line('');

  /** @type {string} */
  let key = '';
  /** @type {string|undefined} */
  let baseUrl;

  if (choice.name === 'local') {
    const given = await askLine(`  Base URL [${PRESETS.local.baseUrl}]: `);
    line('');
    baseUrl = given || PRESETS.local.baseUrl;
    // A server on this machine has no credential, so there is nothing to put
    // in the key store — and putting a placeholder there would list a "key"
    // that is not one. It is configured by address, the same way Whisper is.
    key = '';
  } else {
    line('  Paste the key. It will not appear on screen, and it is stored');
    line('  encrypted rather than in a file you could accidentally commit.');
    line('');
    try {
      key = await askSecret('  Key: ');
    } catch {
      line('  Cancelled.');
      line('');
      return;
    }
    if (!key) {
      line('  Nothing pasted. Nothing stored.');
      line('');
      return;
    }
  }

  // Verify before storing. A key that turns out to be wrong should fail here,
  // while the person is looking at it, and not weeks later inside an ingest.
  process.stdout.write('  Checking it works... ');
  const result = await verifyKey(choice.name, key, { baseUrl });

  if (!result.ok) {
    line('failed');
    line('');
    line(`  ${result.error}`);
    line('');
    line('  Nothing was stored.');
    if (choice.name === 'local') {
      line('');
      line('  Check the server is running and that the URL includes the path it');
      line('  serves on — llama.cpp and LM Studio both expect /v1 on the end.');
    } else {
      line('');
      line('  Common causes: a key copied with a space on the end, a model name');
      line('  the provider has since retired (the defaults here do go stale), or');
      line('  a free tier that needs activating in the console first.');
    }
    line('');
    process.exitCode = 1;
    return;
  }

  line('works');
  line(`  It said: ${result.sample}`);
  line('');

  if (choice.name === 'local') {
    line('  Nothing to store — a local server is configured by address, not by');
    line('  credential. Set this and Chitraq will use it every time:');
    line('');
    line(`    CHITRAQ_OPENAI_URL=${baseUrl}`);
    line('');
    line('  Put it in your shell profile to make it stick. If your server needs');
    line('  a particular model name, add CHITRAQ_OPENAI_MODEL too.');
    line('');
    line('  Done. `chitraq status` shows what is available now.');
    line('');
    return;
  }

  const stored = chitraq.setApiKey({ provider: choice.name, key, label: choice.label });
  line(`  stored     the ${choice.name} key (…${stored.hint}), encrypted`);

  // Turning on remote calls sends text off this machine. That is a real
  // change and it gets asked for, not assumed from having pasted a key.
  const remote = choice.name !== 'local';
  if (remote) {
    line('');
    line('  Using this means the text of what you capture is sent to');
    line(`  ${choice.label} when Chitraq asks it something. Remote calls are`);
    line('  off until you say otherwise.');
    const yes = await askLine('  Turn them on? [y/N]: ');
    if (/^y(es)?$/i.test(yes)) {
      chitraq.setPolicy({ allowRemote: true, ...(choice.cost === 'paid' ? { allowPaid: true } : {}) });
      line(`  enabled    remote calls${choice.cost === 'paid' ? ', including paid ones' : ' (this tier is free)'}`);
    } else {
      line('  left off   the key is stored; run `chitraq setup` again to enable');
    }
  }

  line('');
  line('  Done. `chitraq status` shows what is available now.');
  line('');
}
