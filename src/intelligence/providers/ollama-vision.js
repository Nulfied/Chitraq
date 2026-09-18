/**
 * Ollama vision — reading images, locally and free.
 *
 * Chitraq has always captured images faithfully and then said, honestly, that
 * it could not read them. This fills two of the three slots it was pointing at:
 * `ocr.image` and `vision.describe`. A photographed whiteboard, a screenshot of
 * a chat, a scanned receipt — text out of pixels, on your own machine, with the
 * image never leaving it.
 *
 *     ollama pull llava            # or moondream (small), llama3.2-vision (better)
 *
 * **What this deliberately does not serve: `ocr.document`.** A scanned PDF holds
 * pages as embedded images, and getting them out means rasterising or decoding
 * JPEG/JBIG2/CCITT streams. Every route to that is a dependency, and Chitraq has
 * none. So a scanned PDF is still captured verbatim and still reported as
 * unreadable. Pretending otherwise — running the raw stream through a vision
 * model and hoping — would produce confident nonsense, which is worse than the
 * honest gap.
 *
 * **What comes out of here is a reading, not the document's own words.** A model
 * that misreads "38ms" as "88ms" produces text indistinguishable from a quote.
 * Everything this returns is marked with the model that produced it so the rest
 * of the system can keep the distinction that matters: your words, versus a
 * machine's transcription of your words.
 */

import { Capability } from '../registry.js';

/**
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.model]      a vision model, e.g. llava or llama3.2-vision
 * @param {number} [opts.timeoutMs]
 * @returns {import('../registry.js').Provider}
 */
export function ollamaVisionProvider(opts = {}) {
  const baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = opts.model ?? 'llava';
  // Vision on CPU is slow and the images can be large, so the ceiling is higher
  // than the text provider's. Being killed at 60s mid-transcription wastes the
  // whole run.
  const timeoutMs = opts.timeoutMs ?? 180_000;

  /**
   * @param {{prompt: string, images: string[], system?: string, schema?: object}} req
   */
  async function generate(req) {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: req.prompt,
        system: req.system,
        images: req.images,
        format: req.schema,
        stream: false,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Ollama vision returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }

  return {
    id: 'ollama-vision',
    label: `Ollama vision (${model})`,
    locality: 'local',
    cost: 'free',
    model,
    modelVersion: model,
    deterministic: false,

    available: async () => {
      try {
        const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return false;
        const { models = [] } = await res.json();
        // The needed model, specifically. A running Ollama with only a text
        // model is not a vision provider, and reporting available here would
        // route images to something that cannot see them.
        return models.some((m) => String(m.name).split(':')[0] === model.split(':')[0]);
      } catch {
        return false;
      }
    },

    capabilities: {
      [Capability.OcrImage]: {
        quality: 0.62,
        latencyMs: 20_000,
        costMicros: 0,
        run: async (task) => {
          const data = await generate({
            system: OCR_SYSTEM,
            prompt: 'Transcribe every word visible in this image.',
            images: [toBase64(task.bytes ?? task.image)],
            schema: {
              type: 'object',
              required: ['text', 'legible'],
              properties: {
                text: { type: 'string' },
                legible: { type: 'boolean' },
                note: { type: 'string' },
              },
            },
          });
          const result = parseJson(data.response);
          const text = String(result.text ?? '').trim();

          return {
            text,
            // Same lesson the text adapter learned: small models report badly
            // about themselves. Produced text is the evidence that it read
            // something; the flag is not.
            legible: text.length > 0,
            note: result.note ?? null,
            model: `ollama:${model}`,
            method: 'transcribed by a local vision model',
            uncertainty:
              'This is a model reading pixels, not the document\'s own text. ' +
              'Numbers and names are where it goes wrong. Check anything that matters.',
          };
        },
      },

      [Capability.DescribeImage]: {
        quality: 0.6,
        latencyMs: 18_000,
        costMicros: 0,
        run: async (task) => {
          const data = await generate({
            system: DESCRIBE_SYSTEM,
            prompt: task.question ?? 'Describe what this image shows.',
            images: [toBase64(task.bytes ?? task.image)],
            schema: {
              type: 'object',
              required: ['description'],
              properties: {
                description: { type: 'string' },
                text: { type: 'string' },
                objects: { type: 'array', items: { type: 'string' } },
              },
            },
          });
          const result = parseJson(data.response);
          return {
            description: String(result.description ?? '').trim(),
            text: result.text ? String(result.text).trim() : null,
            objects: (result.objects ?? []).map(String).filter(Boolean),
            model: `ollama:${model}`,
            method: 'described by a local vision model',
            uncertainty: 'A model\'s impression of an image, not a fact about it.',
          };
        },
      },
    },
  };
}

const OCR_SYSTEM = `You transcribe text from images. You do not describe them.

Write out every word you can read, keeping the original order and line breaks. Keep numbers exactly as they appear — do not round, reformat or correct them. If part is unreadable, write [unclear] in its place rather than guessing.

If the image contains no text at all, return an empty string and say so in note. Never describe the picture. Never add words that are not visible in it.`;

const DESCRIBE_SYSTEM = `You describe images plainly and without embellishment.

Say what is actually visible. Do not guess at intent, mood, or what happened outside the frame. If the image contains readable text, put it in the text field as well. If you are unsure what something is, say so rather than choosing the most likely label.`;

/**
 * Ollama wants base64, and callers have bytes.
 * @param {Uint8Array|Buffer|string} input
 */
function toBase64(input) {
  if (typeof input === 'string') return input;
  if (!input?.length) throw new Error('No image bytes to read.');
  return Buffer.from(input).toString('base64');
}

/** @param {string} raw */
function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // A vision model that ignores the schema and writes prose has still read
    // the image. Keeping the prose beats throwing the work away.
    return { text: String(raw ?? '').trim(), description: String(raw ?? '').trim() };
  }
}
