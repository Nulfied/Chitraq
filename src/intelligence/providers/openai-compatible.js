/**
 * Any model that speaks the OpenAI chat shape — which is most of them.
 *
 * Chitraq's remote intelligence was one adapter for one vendor, and that
 * vendor charges. For anyone who cannot spend money on an API — a student,
 * most of the world — the whole of Path B was decorative. This is the answer
 * to that: one adapter, plain `fetch`, no SDK and no dependency, pointed at
 * whichever endpoint the person running it has access to.
 *
 * It is not a second brain. The prompts, schemas and parsing all come from
 * `grounded.js`, the same ones the Claude adapter uses. Only the request
 * differs. That is deliberate, and it is what makes the shared file testable
 * against something free.
 *
 * Presets exist for the hosts people are most likely to reach for, and they
 * are conveniences rather than endorsements. **Model names move.** The
 * defaults here were right when written and will rot; `--model` overrides
 * any of them, and a wrong model name produces a clear error from the
 * provider rather than a wrong answer.
 *
 * Two shapes of structured output are tried, in order:
 *
 *   1. `json_schema`, which constrains generation and is what the schemas in
 *      `grounded.js` are written for.
 *   2. `json_object` with the schema pasted into the system prompt, for the
 *      hosts that accept only that.
 *
 * The fallback is a real downgrade and is treated as one: a model told about
 * a schema in prose can ignore it, so the result is parsed and checked the
 * same way, and a miss is an error rather than a shrug.
 */

import { groundedCapabilities } from './grounded.js';

/**
 * Hosts that speak this protocol. `baseUrl` ends before `/chat/completions`.
 *
 * `free` here means the host offers a no-cost tier, not that every model on
 * it is free. It decides whether the router needs `allowPaid`, so it is
 * conservative: anything metered by default is marked paid.
 */
export const PRESETS = {
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    cost: 'free',
    keyUrl: 'https://console.groq.com/keys',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    cost: 'free',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  cerebras: {
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    model: 'llama-3.3-70b',
    cost: 'free',
    keyUrl: 'https://cloud.cerebras.ai',
  },
  github: {
    label: 'GitHub Models',
    baseUrl: 'https://models.github.ai/inference',
    model: 'openai/gpt-4o-mini',
    cost: 'free',
    keyUrl: 'https://github.com/settings/tokens',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct',
    cost: 'paid',
    keyUrl: 'https://openrouter.ai/keys',
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
    cost: 'paid',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    cost: 'paid',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    cost: 'paid',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  /**
   * Anything served locally on the same protocol — llama.cpp, LM Studio,
   * vLLM, Jan. No key, nothing leaves the machine, so no policy gate.
   */
  local: {
    label: 'Local OpenAI-compatible server',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'local-model',
    cost: 'free',
    locality: 'local',
    keyUrl: null,
  },
};

/** Preset names, for the CLI and for error messages. */
export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));

/**
 * @param {object} opts
 * @param {string} [opts.preset]      a key of PRESETS
 * @param {string} [opts.apiKey]
 * @param {string} [opts.baseUrl]     overrides the preset
 * @param {string} [opts.model]       overrides the preset; model names move
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetch] injected for tests
 * @returns {import('../registry.js').Provider}
 */
export function openAiCompatibleProvider(opts = {}) {
  const preset = PRESETS[opts.preset ?? ''] ?? null;
  const baseUrl = (opts.baseUrl ?? preset?.baseUrl ?? '').replace(/\/+$/, '');
  const label = preset?.label ?? hostOf(baseUrl);
  const locality = /** @type {'local'|'remote'} */ (
    preset?.locality ?? (isLocal(baseUrl) ? 'local' : 'remote')
  );
  // Most local servers serve one model and ignore this field. Defaulting to
  // an OpenAI model name there put "gpt-4o-mini" in the status output beside
  // somebody's llama.cpp, which is a small lie told every time they look.
  const model = opts.model ?? preset?.model ?? (locality === 'local' ? 'local-model' : 'gpt-4o-mini');
  // A model on this machine costs nothing to call, so it must not be put
  // behind the paid gate — that would demand CHITRAQ_ALLOW_PAID for something
  // that never bills anybody, which is both wrong and the opposite of the
  // mistake people worry about. Without a preset and without a local address,
  // assume paid: guessing free about somebody's metered endpoint is the
  // expensive direction to be wrong in.
  const cost = /** @type {'free'|'paid'} */ (
    preset?.cost ?? (locality === 'local' ? 'free' : 'paid')
  );
  const maxTokens = opts.maxTokens ?? 8000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const doFetch = opts.fetch ?? globalThis.fetch;

  /** Set once a host has rejected json_schema, so the cost is paid once. */
  let schemaMode = /** @type {'schema'|'object'|'unknown'} */ ('unknown');

  /**
   * @param {{system: string, user: string, schema: object, think?: boolean}} req
   */
  async function ask({ system, user, schema }) {
    if (!baseUrl) throw new Error('No base URL: give a preset or a baseUrl.');

    if (schemaMode !== 'object') {
      try {
        const out = await call(system, user, schema, true);
        schemaMode = 'schema';
        return out;
      } catch (err) {
        // Only a refusal of the *format* is worth retrying. A bad key or a
        // missing model would fail identically the second time, and retrying
        // those just doubles the wait before the real message appears.
        if (!isFormatRejection(err)) throw err;
        schemaMode = 'object';
      }
    }
    return call(system, user, schema, false);
  }

  /**
   * @param {string} system
   * @param {string} user
   * @param {object} schema
   * @param {boolean} strict
   */
  async function call(system, user, schema, strict) {
    /** @type {any} */
    const body = {
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'system',
          content: strict
            ? system
            : // The downgrade path. Saying "JSON" is required by some hosts
              // before they will honour json_object at all.
              `${system}\n\nReply with JSON only, matching this schema exactly:\n${JSON.stringify(schema)}`,
        },
        { role: 'user', content: user },
      ],
    };
    body.response_format = strict
      ? { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } }
      : { type: 'json_object' };

    const signal = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(`${label} could not be reached: ${why}`);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 400);
      throw new Error(`${label} returned ${response.status}. ${detail}`.trim());
    }

    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error(`${label} returned no content.`);
    }

    try {
      return JSON.parse(stripFence(text));
    } catch {
      throw new Error(`${label} returned output that was not valid JSON.`);
    }
  }

  return {
    id: `openai-compatible:${opts.preset ?? hostOf(baseUrl)}`,
    label: `${label} (${model})`,
    locality,
    cost,
    model,
    modelVersion: model,
    deterministic: false,

    available: async () => {
      if (!baseUrl) return false;
      // A remote host needs a key; a local server does not.
      return locality === 'local' || !!opts.apiKey;
    },

    capabilities: groundedCapabilities({
      ask,
      // Rated below Claude and above the deterministic floor. Honest rather
      // than flattering: these are mostly smaller models, and the router
      // should prefer a better one when the person has configured it.
      tuning: {
        answer: { quality: 0.82, latencyMs: 3000, costMicros: cost === 'free' ? 0 : 500 },
        'extract.claims': { quality: 0.8, latencyMs: 3000, costMicros: cost === 'free' ? 0 : 400 },
        summarize: { quality: 0.82, latencyMs: 2000, costMicros: cost === 'free' ? 0 : 200 },
        'detect.conflict': { quality: 0.78, latencyMs: 2000, costMicros: cost === 'free' ? 0 : 250 },
        'relate.propose': { quality: 0.76, latencyMs: 2000, costMicros: cost === 'free' ? 0 : 250 },
        'interpret.query': { quality: 0.78, latencyMs: 1200, costMicros: cost === 'free' ? 0 : 100 },
      },
    }),
  };
}

/**
 * Did the host refuse the *format*, rather than the request?
 *
 * Worth being narrow about. Retrying a bad key or an unknown model in a
 * weaker mode wastes a second round trip and then reports the weaker mode's
 * error, which is further from the real problem.
 *
 * @param {unknown} err
 */
function isFormatRejection(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (!/\b(400|422|404)\b/.test(message)) return false;
  return /json_schema|response_format|structured|schema|not supported|unsupported/i.test(message);
}

/**
 * Some models wrap JSON in a fenced code block however they are asked not to.
 *
 * @param {string} text
 */
function stripFence(text) {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return fenced ? fenced[1] : text;
}

/** @param {string} url */
function isLocal(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname);
  } catch {
    return false;
  }
}

/** @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'openai-compatible';
  }
}
