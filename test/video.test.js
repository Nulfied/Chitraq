/**
 * Video, and telling two failures apart.
 *
 * A video is a container holding a video track and an audio track, and the
 * audio inside it is compressed — almost always AAC. Whisper wants raw
 * samples. So somebody has to unwrap the container and decode the audio,
 * and that somebody is ffmpeg, which every mainstream Whisper server already
 * bundles: Speaches, faster-whisper-server, WhisperX, whisper.cpp when built
 * with it.
 *
 * That makes video a bring-your-own-provider capability exactly like audio,
 * and it works today. Chitraq hands over the bytes and records what comes
 * back, with provenance. It carries no decoder of its own and says so.
 *
 * The bug these tests exist for was in the reporting. A configured Whisper
 * server that rejected an MP4 produced "stored as-is; reading it needs
 * speech.transcribe" — the same words used when *nothing* is installed. It
 * reads as "you have no transcriber" and sends somebody to install the
 * server they are already running.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Chitraq } from '../src/chitraq.js';
import { whisperProvider } from '../src/intelligence/providers/whisper.js';

/** A stand-in video: a real MP4 box header, then filler. */
function videoBytes(megabytes = 1) {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x20]),
    Buffer.from('ftypisom'),
    Buffer.alloc(megabytes * 1024 * 1024, 0x11),
  ]);
}

/**
 * A Whisper server that either transcribes or refuses.
 *
 * @param {{transcript?: string, reject?: string}} behaviour
 */
async function whisperServer(behaviour) {
  /** @type {any[]} */
  const received = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'whisper-1' }] }));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('latin1');
    received.push({
      bytes: Buffer.byteLength(body, 'latin1'),
      type: /Content-Type:\s*(\S+)/i.exec(body)?.[1] ?? null,
    });

    if (behaviour.reject) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: behaviour.reject }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        text: behaviour.transcript,
        segments: [{ start: 0, end: 3.2, text: behaviour.transcript }],
      })
    );
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {any} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('a video is transcribed and becomes searchable knowledge', async (t) => {
  const server = await whisperServer({
    transcript: 'We dropped the Redis cache because SQLite was already fast enough.',
  });
  const c = new Chitraq({
    path: ':memory:',
    providers: [whisperProvider({ baseUrl: server.url })],
  });
  t.after(async () => {
    c.close();
    await server.close();
  });

  const result = await c.ingest({
    bytes: videoBytes(1),
    filename: 'standup.mp4',
    uri: 'file:///standup.mp4',
  });

  assert.equal(result.source.media_type, 'video/mp4');
  assert.match(result.parsed.text, /Redis cache/);

  // The whole container went to the server, which is correct: unwrapping it
  // is the server's job and Chitraq does not pretend otherwise.
  assert.equal(server.received.length, 1);
  assert.equal(server.received[0].type, 'video/mp4');

  // And the source records that a machine produced this text, not a person.
  assert.ok(result.reading, 'the reading is reported');
  assert.equal(result.reading.via.capability, 'speech.transcribe');
});

test('a server that refuses the container is not reported as a missing provider', async (t) => {
  // The bug. Both cases used to print "reading it needs speech.transcribe".
  const server = await whisperServer({ reject: 'failed to read audio data' });
  const c = new Chitraq({
    path: ':memory:',
    providers: [whisperProvider({ baseUrl: server.url })],
  });
  t.after(async () => {
    c.close();
    await server.close();
  });

  const result = await c.ingest({
    bytes: videoBytes(1),
    filename: 'standup.mp4',
    uri: 'file:///standup.mp4',
  });

  assert.ok(result.parsed.readFailed, 'the failure is recorded as a failure');
  assert.equal(result.parsed.readFailed.capability, 'speech.transcribe');

  // The server's own words, because they say more than anything written here.
  assert.match(result.parsed.readFailed.error, /failed to read audio data|400/);
  assert.ok(result.parsed.readFailed.provider, 'and which provider said it');

  // The bytes are kept regardless. A file that could not be read is still a
  // file somebody chose to keep.
  assert.ok(result.source.id);
});

test('with no provider at all, it says that instead', async (t) => {
  // The other case, which must stay distinguishable from the one above.
  const c = new Chitraq({ path: ':memory:', providers: [] });
  t.after(() => c.close());

  const result = await c.ingest({
    bytes: videoBytes(1),
    filename: 'standup.mp4',
    uri: 'file:///standup.mp4',
  });

  assert.equal(result.parsed.readFailed, undefined, 'nothing failed; nothing was tried');
  assert.equal(result.parsed.needsCapability, 'speech.transcribe', 'the slot is named');
});

test('audio and video take the same path, because they are the same problem', async (t) => {
  const server = await whisperServer({ transcript: 'Spoken words from a recording.' });
  const c = new Chitraq({
    path: ':memory:',
    providers: [whisperProvider({ baseUrl: server.url })],
  });
  t.after(async () => {
    c.close();
    await server.close();
  });

  for (const filename of ['meeting.mp3', 'meeting.mp4', 'meeting.m4a', 'meeting.mov']) {
    const result = await c.ingest({
      bytes: videoBytes(1),
      filename,
      uri: `file:///${filename}`,
    });
    assert.match(result.parsed.text, /Spoken words/, filename);
  }
});
