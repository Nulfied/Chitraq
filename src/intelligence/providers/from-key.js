/**
 * Building a provider from a key somebody supplied.
 *
 * The one place that knows which adapter a stored key belongs to. Everything
 * else — the key store, the registry, the router — stays ignorant of vendors,
 * which is the point of having a capability layer at all.
 *
 * A provider built here is marked `keyed`, and the id it registers under is
 * suffixed so that a person's own key never silently overwrites an installation
 * key set by whoever runs the server. Those are different arrangements with
 * different bills attached.
 */

import { anthropicProvider } from './anthropic.js';
import { whisperProvider } from './whisper.js';

/** How a stored key becomes a working provider. */
const BUILDERS = {
  /**
   * @param {string} key
   * @param {any} opts
   */
  anthropic: (key, opts = {}) =>
    anthropicProvider({
      apiKey: key,
      model: opts.model,
      effort: opts.effort ?? 'high',
    }),

  /**
   * @param {string} key
   * @param {any} opts
   */
  whisper: (key, opts = {}) =>
    whisperProvider({
      baseUrl: opts.baseUrl ?? 'http://127.0.0.1:8080',
      model: opts.model,
      apiKey: key,
    }),
};

/** Providers a key can currently be turned into. */
export const BUILDABLE = Object.freeze(Object.keys(BUILDERS));

/**
 * @param {string} provider
 * @param {string} key
 * @param {object} [opts]
 * @returns {import('../registry.js').Provider|null} null when nothing can use it
 */
export function providerFromKey(provider, key, opts = {}) {
  const build = BUILDERS[provider];
  if (!build) return null;

  const built = build(key, opts);
  return {
    ...built,
    // Distinct from an installation-wide provider of the same vendor, so both
    // can exist and the router can tell them apart.
    id: `${built.id}:key`,
    label: `${built.label} (your key)`,
    keyed: true,
    keyOwner: opts.principalId ?? null,
  };
}

/**
 * The registry id a keyed provider takes, without building it.
 * @param {string} provider
 */
export function keyedIdFor(provider) {
  return `${provider}:key`;
}
