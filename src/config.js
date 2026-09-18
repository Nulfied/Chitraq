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
  };
}
