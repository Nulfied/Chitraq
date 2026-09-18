/**
 * Reading images and audio.
 *
 * Both providers are exercised against stand-in servers speaking the real
 * protocols — Ollama's `/api/generate` with images, and the OpenAI-compatible
 * `/v1/audio/transcriptions`. That proves the request shape, the error paths
 * and the result mapping. It does not prove any particular model's behaviour,
 * and nothing here should be read as claiming it does.
 *
 * The properties that matter most are the negative ones. Capture must never
 * depend on a vision model being present, fast, or right — an image with no
 * provider, with a broken provider, or with a provider that returns nothing
 * must all end the same way: bytes stored, honest note, nothing invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Chitraq } from '../src/chitraq.js';
import { ollamaVisionProvider } from '../src/intelligence/providers/ollama-vision.js';
import { whisperProvider } from '../src/intelligence/providers/whisper.js';
import { Capability } from '../src/intelligence/registry.js';

/** A one-pixel PNG. Real bytes, so the media type is detected for real. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * @param {(req: any, body: string) => {status?: number, body: any}} handler
 */
async function standIn(handler) {
  /** @type {any[]} */
  const seen = [];
  const server = createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      seen.push({ url: req.url, method: req.method, raw, text: raw.toString('utf8') });
      const out = handler(req, raw.toString('utf8'));
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {any} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

// ============================================================== vision

test('the vision provider sends the image and returns a transcription', async (t) => {
  const ollama = await standIn((req) => {
    if (req.url === '/api/tags') return { body: { models: [{ name: 'llava:latest' }] } };
    return { body: { response: JSON.stringify({ text: 'WHITEBOARD: ship in March', legible: true }) } };
  });
  t.after(() => ollama.close());

  const provider = ollamaVisionProvider({ baseUrl: ollama.url, model: 'llava' });
  assert.equal(await provider.available(), true);

  const result = await provider.capabilities[Capability.OcrImage].run({ bytes: PNG });
  assert.equal(result.text, 'WHITEBOARD: ship in March');
  assert.equal(result.legible, true);
  assert.equal(result.model, 'ollama:llava');
  assert.match(result.uncertainty, /reading pixels/);

  // The image really went over the wire, base64-encoded as Ollama wants it.
  const generate = ollama.seen.find((r) => r.url === '/api/generate');
  const sent = JSON.parse(generate.text);
  assert.equal(sent.images[0], PNG.toString('base64'));
  assert.equal(sent.options.temperature, 0, 'transcription is not a creative act');
});

test('a vision model that writes prose instead of JSON is still believed', async (t) => {
  const ollama = await standIn((req) => {
    if (req.url === '/api/tags') return { body: { models: [{ name: 'llava' }] } };
    return { body: { response: 'Meeting notes: launch slipped to April' } };
  });
  t.after(() => ollama.close());

  const provider = ollamaVisionProvider({ baseUrl: ollama.url, model: 'llava' });
  const result = await provider.capabilities[Capability.OcrImage].run({ bytes: PNG });

  // It read the image. Throwing that away over a schema it ignored would lose
  // real work for a formatting mistake.
  assert.match(result.text, /launch slipped to April/);
  assert.equal(result.legible, true);
});

test('a model claiming it read nothing, having read nothing, is believed too', async (t) => {
  const ollama = await standIn((req) => {
    if (req.url === '/api/tags') return { body: { models: [{ name: 'llava' }] } };
    return { body: { response: JSON.stringify({ text: '', legible: true, note: 'no text visible' }) } };
  });
  t.after(() => ollama.close());

  const provider = ollamaVisionProvider({ baseUrl: ollama.url, model: 'llava' });
  const result = await provider.capabilities[Capability.OcrImage].run({ bytes: PNG });
  assert.equal(result.text, '');
  assert.equal(result.legible, false, 'produced text is the evidence, not the flag');
});

test('a running Ollama without the vision model is not a vision provider', async (t) => {
  const ollama = await standIn(() => ({ body: { models: [{ name: 'llama3.2:latest' }] } }));
  t.after(() => ollama.close());

  const provider = ollamaVisionProvider({ baseUrl: ollama.url, model: 'llava' });
  assert.equal(await provider.available(), false, 'text models cannot see');
});

test('vision does not claim the scanned-document slot', () => {
  const provider = ollamaVisionProvider();
  const served = Object.keys(provider.capabilities);
  assert.ok(served.includes(Capability.OcrImage));
  assert.ok(served.includes(Capability.DescribeImage));
  // A scanned PDF needs rasterising, which needs a dependency Chitraq does not
  // take. Claiming the slot and guessing would produce confident nonsense.
  assert.ok(!served.includes(Capability.OcrDocument), 'ocr.document stays honestly empty');
});

// ============================================================== speech

test('the speech provider posts real multipart audio and maps the transcript', async (t) => {
  const whisper = await standIn((req) => {
    if (req.url === '/v1/models') return { body: { data: [{ id: 'whisper-1' }] } };
    return {
      body: {
        text: 'We agreed to ship in March.',
        language: 'en',
        duration: 4.2,
        segments: [{ start: 0, end: 4.2, text: ' We agreed to ship in March.' }],
      },
    };
  });
  t.after(() => whisper.close());

  const provider = whisperProvider({ baseUrl: whisper.url });
  assert.equal(await provider.available(), true);

  const audio = Buffer.from('ID3 fake audio bytes');
  const result = await provider.capabilities[Capability.Transcribe].run({
    bytes: audio,
    filename: 'memo.mp3',
    mediaType: 'audio/mpeg',
  });

  assert.equal(result.text, 'We agreed to ship in March.');
  assert.equal(result.language, 'en');
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].text, 'We agreed to ship in March.', 'trimmed');
  assert.match(result.uncertainty, /machine's hearing/);

  const post = whisper.seen.find((r) => r.url === '/v1/audio/transcriptions');
  assert.equal(post.method, 'POST');
  assert.match(post.text, /name="file"/, 'multipart, as the API requires');
  assert.match(post.text, /fake audio bytes/, 'and the bytes are actually in it');
  assert.match(post.text, /verbose_json/, 'asks for segments, which become locators');
});

test('a server that answers with plain text is still a working server', async (t) => {
  const whisper = await standIn((req) => {
    if (req.url === '/v1/models') return { body: { data: [] } };
    return { body: 'Just the words, no JSON.' };
  });
  t.after(() => whisper.close());

  const provider = whisperProvider({ baseUrl: whisper.url });
  const result = await provider.capabilities[Capability.Transcribe].run({ bytes: Buffer.from('x') });
  assert.equal(result.text, 'Just the words, no JSON.');
  assert.deepEqual(result.segments, []);
});

test('an empty transcript is an error, not an empty success', async (t) => {
  const whisper = await standIn(() => ({ body: { text: '   ' } }));
  t.after(() => whisper.close());

  const provider = whisperProvider({ baseUrl: whisper.url });
  await assert.rejects(
    () => provider.capabilities[Capability.Transcribe].run({ bytes: Buffer.from('x') }),
    /no transcript/
  );
});

test('transcribing nothing is refused before any request is made', async () => {
  const provider = whisperProvider({ baseUrl: 'http://127.0.0.1:1' });
  await assert.rejects(
    () => provider.capabilities[Capability.Transcribe].run({ bytes: new Uint8Array() }),
    /No audio/
  );
});

// ============================================== capture, end to end

test('an image with no provider is captured verbatim and reported honestly', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  const result = await c.ingest({ bytes: PNG, filename: 'whiteboard.png', keepBlob: true });

  assert.equal(result.parsed.text, '');
  assert.equal(result.parsed.needsCapability, 'ocr.image', 'names what would unlock it');
  assert.equal(result.reading, null);
  assert.equal(result.proposals.length, 0, 'nothing invented from an unread image');

  const stored = c.db.prepare('SELECT blob, media_type FROM source WHERE id = ?').get(result.source.id);
  assert.equal(stored.media_type, 'image/png');
  assert.ok(stored.blob?.byteLength > 0, 'the bytes are kept regardless');
});

test('with a provider, an image becomes readable knowledge that knows it was read', async (t) => {
  const ollama = await standIn((req) => {
    if (req.url === '/api/tags') return { body: { models: [{ name: 'llava' }] } };
    return {
      body: {
        response: JSON.stringify({
          text: 'We measured p99 latency at 38ms. The trial lasts 14 days.',
          legible: true,
        }),
      },
    };
  });
  const c = new Chitraq({
    path: ':memory:',
    providers: [ollamaVisionProvider({ baseUrl: ollama.url, model: 'llava' })],
  });
  t.after(async () => {
    c.close();
    await ollama.close();
  });

  const result = await c.ingest({ bytes: PNG, filename: 'whiteboard.png' });

  assert.match(result.parsed.text, /p99 latency at 38ms/);
  assert.equal(result.parsed.needsCapability, null, 'the slot is served now');
  assert.equal(result.reading.via.capability, 'ocr.image');
  assert.equal(result.reading.via.provider, 'ollama-vision');
  assert.ok(result.proposals.length > 0, 'and it produced knowledge');

  // The distinction that must survive: this text is a machine's reading, not
  // the user's words. An answer built on it cannot honestly claim to quote.
  const meta = JSON.parse(
    String(c.db.prepare('SELECT meta FROM source WHERE id = ?').get(result.source.id).meta)
  );
  assert.equal(meta.textVia.capability, 'ocr.image');
  assert.equal(meta.textVia.provider, 'ollama-vision');

  // And the doubt is carried into every claim standing on it.
  for (const p of result.proposals) {
    assert.match(p.rationale, /read by ollama-vision rather than written/);
  }
});

test('a vision provider that fails leaves capture exactly as it was without one', async (t) => {
  const broken = await standIn((req) => {
    if (req.url === '/api/tags') return { body: { models: [{ name: 'llava' }] } };
    return { status: 500, body: { error: 'out of memory' } };
  });
  const c = new Chitraq({
    path: ':memory:',
    providers: [ollamaVisionProvider({ baseUrl: broken.url, model: 'llava' })],
  });
  t.after(async () => {
    c.close();
    await broken.close();
  });

  const result = await c.ingest({ bytes: PNG, filename: 'whiteboard.png', keepBlob: true });

  // Memory never depends on intelligence succeeding. This is that rule applied
  // to the newest place it could have been broken.
  assert.equal(result.source.id.startsWith('src_'), true, 'captured anyway');
  assert.equal(result.parsed.needsCapability, 'ocr.image', 'still honest about the gap');
  assert.equal(result.reading, null);
});

test('reading can be switched off per capture', async (t) => {
  const ollama = await standIn((req) => {
    if (req.url === '/api/tags') return { body: { models: [{ name: 'llava' }] } };
    return { body: { response: JSON.stringify({ text: 'should not be used', legible: true }) } };
  });
  const c = new Chitraq({
    path: ':memory:',
    providers: [ollamaVisionProvider({ baseUrl: ollama.url, model: 'llava' })],
  });
  t.after(async () => {
    c.close();
    await ollama.close();
  });

  const result = await c.ingest({ bytes: PNG, filename: 'x.png', read: false });
  assert.equal(result.reading, null);
  assert.equal(result.parsed.text, '');
  assert.ok(!ollama.seen.some((r) => r.url === '/api/generate'), 'no model was called at all');
});

test('audio becomes text, with timestamps kept as locators', async (t) => {
  const whisper = await standIn((req) => {
    if (req.url === '/v1/models') return { body: { data: [] } };
    return {
      body: {
        text: 'The pricing decision was forty dollars per seat.',
        language: 'en',
        segments: [{ start: 12.5, end: 18.0, text: 'The pricing decision was forty dollars per seat.' }],
      },
    };
  });
  const c = new Chitraq({
    path: ':memory:',
    providers: [whisperProvider({ baseUrl: whisper.url })],
  });
  t.after(async () => {
    c.close();
    await whisper.close();
  });

  const result = await c.ingest({
    bytes: Buffer.from('fake mp3'),
    filename: 'standup.mp3',
  });

  assert.match(result.parsed.text, /forty dollars per seat/);
  assert.equal(result.reading.via.capability, 'speech.transcribe');
  assert.equal(result.parsed.meta.segments[0].start, 12.5, 'when it was said is kept');
  assert.ok(result.proposals.length > 0);
});
