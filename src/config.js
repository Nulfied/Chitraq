/**
 * Configuration.
 *
 * Chitraq must be useful the moment it starts, with nothing configured. Every
 * value here has a working default; environment variables only widen what is
 * permitted. In particular, no remote provider is ever enabled implicitly —
 * setting a key makes a provider *available*, and `CHITRAQ_ALLOW_REMOTE`
 * makes it *usable*. Two separate decisions, because "I have an API key" and
 * "send my memory to a server" are two separate things.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { anthropicProvider } from './intelligence/providers/anthropic.js';
import { ollamaProvider } from './intelligence/providers/ollama.js';
import { ollamaVisionProvider } from './intelligence/providers/ollama-vision.js';
import { whisperProvider } from './intelligence/providers/whisper.js';
import { openAiCompatibleProvider } from './intelligence/providers/openai-compatible.js';

/**
 * @returns {{path: string, host: string, port: number, policy: object, providers: any[], notes: string[]}}
 */
export function loadConfig(env = process.env) {
  /** @type {string[]} */
  const notes = [];
  /** @type {any[]} */
  const providers = [];

  const path = env.CHITRAQ_DB || join(homedir(), '.chitraq', 'memory.chitraq');

  // Ollama is registered whenever a base URL is plausible. Its own health check
  // decides whether it is actually usable, so a machine without it simply
  // routes to the deterministic floor.
  if (env.CHITRAQ_OLLAMA !== 'off') {
    providers.push(
      ollamaProvider({
        baseUrl: env.OLLAMA_HOST || 'http://127.0.0.1:11434',
        model: env.CHITRAQ_OLLAMA_MODEL || 'llama3.2',
        embedModel: env.CHITRAQ_OLLAMA_EMBED || 'nomic-embed-text',
      })
    );
    notes.push('Ollama provider registered (used automatically if it is running with the needed models).');

    // Registered separately because it is a separate model that is separately
    // absent. Its health check asks for the vision model by name, so a machine
    // with only llama3.2 pulled routes images nowhere, which is correct.
    providers.push(
      ollamaVisionProvider({
        baseUrl: env.OLLAMA_HOST || 'http://127.0.0.1:11434',
        // No default. Naming one would mean "install exactly this or get
        // nothing"; left unset, whichever vision model is already pulled is
        // the one used.
        model: env.CHITRAQ_OLLAMA_VISION,
      })
    );
  }

  // Speech needs a server somebody chose to run, so it is opt-in by address
  // rather than assumed on a default port. Nothing is guessed here.
  if (env.CHITRAQ_WHISPER) {
    providers.push(
      whisperProvider({
        baseUrl: env.CHITRAQ_WHISPER,
        model: env.CHITRAQ_WHISPER_MODEL,
        apiKey: env.CHITRAQ_WHISPER_KEY,
        language: env.CHITRAQ_WHISPER_LANG,
      })
    );
    notes.push(`Whisper provider registered at ${env.CHITRAQ_WHISPER}.`);
  }

  // Anything speaking the OpenAI chat shape — a hosted free tier, or
  // llama.cpp/LM Studio/vLLM on this machine. Addressed rather than assumed,
  // the same way Whisper is: there is no default port worth guessing, and a
  // provider registered at an address nobody chose would be a surprise.
  //
  // A hosted one is normally added through `chitraq setup`, which stores the
  // key encrypted. This path exists for a local server, which has no key to
  // store, and for anyone who would rather configure by environment.
  if (env.CHITRAQ_OPENAI_URL || env.CHITRAQ_OPENAI_PRESET) {
    providers.push(
      openAiCompatibleProvider({
        preset: env.CHITRAQ_OPENAI_PRESET,
        baseUrl: env.CHITRAQ_OPENAI_URL,
        model: env.CHITRAQ_OPENAI_MODEL,
        apiKey: env.CHITRAQ_OPENAI_KEY,
      })
    );
    notes.push(
      `OpenAI-compatible provider registered at ${env.CHITRAQ_OPENAI_URL ?? env.CHITRAQ_OPENAI_PRESET}.`
    );
  }

  if (env.ANTHROPIC_API_KEY) {
    providers.push(
      anthropicProvider({
        model: env.CHITRAQ_ANTHROPIC_MODEL,
        effort: /** @type {any} */ (env.CHITRAQ_ANTHROPIC_EFFORT) || 'high',
      })
    );
    notes.push('Claude provider registered.');
  }

  const allowRemote = env.CHITRAQ_ALLOW_REMOTE === 'true';
  const allowPaid = env.CHITRAQ_ALLOW_PAID === 'true';

  if (env.ANTHROPIC_API_KEY && !allowRemote) {
    notes.push(
      'A Claude key is present but remote calls are off. Set CHITRAQ_ALLOW_REMOTE=true and ' +
        'CHITRAQ_ALLOW_PAID=true to let Chitraq use it.'
    );
  }

  return {
    path,
    host: env.CHITRAQ_HOST || '127.0.0.1',
    port: Number(env.CHITRAQ_PORT || 4317),
    providers,
    notes,
    policy: {
      prefer: /** @type {any} */ (env.CHITRAQ_PREFER) || 'quality',
      allowRemote,
      allowPaid,
      maxCostMicros: Number(env.CHITRAQ_MAX_COST_MICROS || (allowPaid ? 10_000 : 0)),
      timeoutMs: Number(env.CHITRAQ_TIMEOUT_MS || 60_000),
    },
    allowOpen: env.CHITRAQ_ALLOW_OPEN === 'true',
  };
}

/**
 * Is this address reachable only from the machine it runs on?
 *
 * The whole of 127.0.0.0/8 is loopback, not just 127.0.0.1. `0.0.0.0` and
 * `::` are the opposite of loopback — they mean every interface — and are
 * the two people actually reach for when they want sync to work, which is
 * exactly the case this exists to catch.
 *
 * @param {string} host
 */
export function isLoopbackHost(host) {
  const h = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Why this configuration must not be served, if it must not be.
 *
 * Authentication does not exist until an account does. That is a reasonable
 * default for a memory reached only from the machine holding it, and it is
 * the wrong default the moment the address changes — because nothing else
 * stands between the network and the whole store.
 *
 * It is worth being precise about the size of that. An open port here does
 * not expose "some notes": `GET /api/export` is the entire workspace,
 * `GET /api/keys` lists the API keys, `GET /api/tokens` lists the
 * credentials issued to other programs, and `DELETE /api/objects/:id`
 * destroys knowledge. An access token cannot save it either, because a token
 * narrows what a caller may do and is never demanded — an anonymous request
 * is not a request with an empty scope, it is a request that skipped the
 * check.
 *
 * So this refuses at startup rather than warning. A warning scrolls past in
 * a terminal nobody is watching, and the failure it precedes is silent: the
 * memory works perfectly while being readable by the network. Refusing costs
 * one environment variable and happens at the moment the mistake is made.
 *
 * @param {{host: string, authEnabled: boolean, allowOpen?: boolean}} state
 * @returns {string|null} the refusal, or null when serving is fine
 */
export function refuseToServe({ host, authEnabled, allowOpen = false }) {
  if (authEnabled || allowOpen || isLoopbackHost(host)) return null;

  return [
    `Refusing to serve ${host} with no account.`,
    '',
    `  Chitraq asks for credentials once an account exists, and there is no`,
    `  account here — so every route is open, including the whole-workspace`,
    `  export, the list of stored API keys, and deleting knowledge. On`,
    `  ${host} that is open to the network, not to you.`,
    '',
    '  Either of these fixes it:',
    '',
    '    create an account            open the web interface on 127.0.0.1 and',
    '                                 sign up; every route then needs a login',
    '                                 or an access token',
    '',
    '    keep it to this machine      unset CHITRAQ_HOST, or set it to 127.0.0.1',
    '',
    '  If the network this is on is genuinely trusted and you want it open',
    '  anyway, say so explicitly:',
    '',
    '    CHITRAQ_ALLOW_OPEN=true',
  ].join('\n');
}
