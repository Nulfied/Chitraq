/**
 * Speech to text, against a local Whisper server.
 *
 * This fills the last declared-but-empty slot: `speech.transcribe`. A voice
 * memo becomes text, the text becomes proposals, and the audio stays captured
 * verbatim either way.
 *
 * There is no bundled speech engine and there will not be one — a real one is
 * tens of megabytes of model and a native build, which is exactly the kind of
 * dependency Chitraq does not take. Instead this talks to a server you already
 * run, over the OpenAI-compatible transcription API that every local Whisper
 * server speaks:
 *
 *     whisper.cpp        ./server --port 8080
 *     faster-whisper-server / Speaches   (docker, port 8000)
 *     any OpenAI-compatible endpoint
 *
 *     CHITRAQ_WHISPER=http://127.0.0.1:8080
 *
 * **Verification status.** The protocol is covered by a stand-in server in the
 * test suite, the same way Ollama was before it could be run live. That proves
 * the request shape, the multipart body, the error paths and the result
 * mapping. It does not prove any particular engine's behaviour, and this file
 * should not claim otherwise until someone has run it against one.
 *
 * **What comes out is a machine's hearing, not a transcript of record.** Names,
 * numbers and anything said quietly are where it fails, and it fails by writing
 * something plausible rather than by stopping. Everything returned here says so.
 */

import { Capability } from '../registry.js';

/**
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]   e.g. http://127.0.0.1:8080
 * @param {string} [opts.model]
 * @param {string} [opts.apiKey]    some servers want one; local ones usually do not
 * @param {string} [opts.language]  ISO code; omitted means auto-detect
 * @param {number} [opts.timeoutMs]
 * @returns {import('../registry.js').Provider}
 */
export function whisperProvider(opts = {}) {
  const baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const model = opts.model ?? 'whisper-1';
  // Transcription is roughly real-time on CPU, so an hour of audio is an hour
  // of work. This ceiling is for a long meeting recording, not a voice memo.
  const timeoutMs = opts.timeoutMs ?? 900_000;

  return {
    id: 'whisper',
    label: `Whisper (${model} at ${baseUrl})`,
    locality: 'local',
    cost: 'free',
    model,
    modelVersion: model,
    deterministic: false,

    available: async () => {
      try {
        // Servers differ on what they expose, so this asks the one endpoint the
        // OpenAI-compatible surface guarantees. Anything that answers at all is
        // treated as present; the real call will say if it is not.
        const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
      } catch {
        return false;
      }
    },

    capabilities: {
      [Capability.Transcribe]: {
        quality: 0.75,
        latencyMs: 30_000,
        costMicros: 0,
        run: async (task) => {
          const bytes = task.bytes ?? task.audio;
          if (!bytes?.length) throw new Error('No audio to transcribe.');

          const form = new FormData();
          form.set('file', new Blob([bytes], { type: task.mediaType ?? 'audio/mpeg' }), task.filename ?? 'audio');
          form.set('model', task.model ?? model);
          // verbose_json gives segments with timestamps, which become evidence
          // locators — "he said it at 14:22" is worth more than a wall of text.
          form.set('response_format', 'verbose_json');
          if (opts.language) form.set('language', opts.language);
          if (task.prompt) form.set('prompt', task.prompt);

          /** @type {Record<string, string>} */
          const headers = {};
          if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

          const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
            method: 'POST',
            headers,
            body: form,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) {
            throw new Error(
              `Whisper server returned ${res.status}: ${(await res.text()).slice(0, 200)}`
            );
          }

          const raw = await res.text();
          const data = safeJson(raw);
          // Not every server honours verbose_json. A plain-text body is still a
          // transcript, and refusing it would fail on a working setup.
          const text = String(data?.text ?? raw ?? '').trim();
          if (!text) throw new Error('The Whisper server returned no transcript.');

          const segments = (data?.segments ?? [])
            .map((s) => ({
              start: Number(s.start ?? 0),
              end: Number(s.end ?? 0),
              text: String(s.text ?? '').trim(),
            }))
            .filter((s) => s.text);

          return {
            text,
            language: data?.language ?? opts.language ?? null,
            duration: Number.isFinite(data?.duration) ? Number(data.duration) : null,
            segments,
            model: `whisper:${model}`,
            method: 'transcribed by a local speech model',
            uncertainty:
              'A machine\'s hearing, not a transcript of record. Names, numbers and ' +
              'anything said quietly are where it goes wrong, and it goes wrong by ' +
              'writing something plausible rather than by stopping.',
          };
        },
      },
    },
  };
}

/** @param {string} raw */
function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
