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
import { openAiCompatibleProvider, PRESETS } from './openai-compatible.js';

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

  // Everything that speaks the OpenAI chat shape gets a builder of its own,
  // so `chitraq keys --set groq` works the same way `--set anthropic` does
  // and the key store stays ignorant that they share an adapter.
  ...Object.fromEntries(
    Object.keys(PRESETS).map((preset) => [
      preset,
      /**
       * @param {string} key
       * @param {any} opts
       */
      (key, opts = {}) =>
        openAiCompatibleProvider({
          preset,
          apiKey: key,
          baseUrl: opts.baseUrl,
          model: opts.model,
          // Threaded through so setup can verify a key against a stub in
          // tests without reaching the network.
          fetch: opts.fetch,
        }),
    ])
  ),
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
    //
    // Keyed off the *provider name*, not the adapter's own id. Those are the
    // same for Anthropic and Whisper and are not for anything sharing an
    // adapter: the OpenAI-compatible one calls itself
    // `openai-compatible:groq`, which would have registered as
    // `openai-compatible:groq:key` while `keyedIdFor('groq')` said
    // `groq:key`. Nothing would have found the provider it had just built.
    id: keyedIdFor(provider),
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
