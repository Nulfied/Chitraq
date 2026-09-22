/**
 * The PDF standard security handler, so an "encrypted" PDF can be read.
 *
 * Most PDFs people call encrypted are not protecting anything from the
 * person holding them. A bank statement, an exam form, a government
 * download: these open in any reader with no prompt, because the *user*
 * password is empty. What is set is the *owner* password, which expresses a
 * wish about printing and copying that every reader is free to ignore and
 * most do. Chitraq refusing to read a file its owner can open on any phone
 * was not security, it was a gap.
 *
 * So this derives the file encryption key from an empty user password, and
 * from a supplied one when there is a real user password. Everything the
 * specification calls for and nothing it does not:
 *
 *   R2, R3, R4   Algorithm 2, MD5-derived, RC4 or AES-128 per object
 *   R5           SHA-256 with salts, AES-256, file key unwrapped from /UE
 *   R6           the hardened hash of Algorithm 2.B, otherwise as R5
 *
 * RC4 is written out below because Node removed it, and it is twenty lines.
 * Everything else — MD5, SHA-256/384/512, AES-CBC — is `node:crypto`.
 *
 * **What this is not.** It is not a way past a password nobody gave you. A
 * document with a real user password fails the key check and is reported as
 * needing one. Nothing here guesses, brute-forces, or works around a
 * password that is actually protecting something.
 *
 * That check is worth a sentence of its own, because leaving it out is the
 * easy mistake. Revisions 2 to 4 will derive a key from *any* password —
 * there is nothing in the derivation that can fail. Without Algorithm 6 a
 * wrong password produced a wrong key, decrypted to rubbish, and the caller
 * announced "no text layer found, most likely a scanned document". Not a
 * refusal: a confident wrong answer about what kind of file it was.
 *
 * Checked against pypdf, which encrypts the fixtures in
 * `test/fixtures/pdf-crypt/`. The failure worth guarding against is not a
 * crash: it is a key that is almost right, producing bytes that are almost a
 * content stream, from which almost-text gets stored as though somebody
 * wrote it. So the test asserts the decrypted text equals the original,
 * rather than that decryption returned something.
 */

import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

/** The padding string from the specification, used to fix a password at 32 bytes. */
const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** Appended when deriving a per-object key for AES, per the specification. */
const AES_SALT = Buffer.from([0x73, 0x41, 0x6c, 0x54]);

export class PdfCryptError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PdfCryptError';
  }
}

/**
 * RC4, because Node will not do it any more and the format still uses it.
 *
 * @param {Buffer} key
 * @param {Buffer} data
 */
function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }

  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 0xff;
    b = (b + s[a]) & 0xff;
    [s[a], s[b]] = [s[b], s[a]];
    out[k] = data[k] ^ s[(s[a] + s[b]) & 0xff];
  }
  return out;
}

/** @param {Buffer} data */
const md5 = (data) => createHash('md5').update(data).digest();

/**
 * @param {Buffer} key
 * @param {Buffer} data  leading 16 bytes are the initialisation vector
 */
function aesCbcDecrypt(key, data) {
  if (data.length <= 16) return Buffer.alloc(0);
  const decipher = createDecipheriv(key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc', key, data.subarray(0, 16));
  decipher.setAutoPadding(false);
  const out = Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]);

  // PKCS#7, removed by hand because a wrong key produces a wrong final byte
  // and `setAutoPadding(true)` would throw on it. Here a bad pad simply
  // means the caller gets bytes that will not parse, which is the honest
  // outcome and is caught by the key check rather than by an exception.
  const pad = out[out.length - 1];
  return pad >= 1 && pad <= 16 && pad <= out.length ? out.subarray(0, out.length - pad) : out;
}

/**
 * @param {string} algorithm
 * @param {Buffer} key
 * @param {Buffer} data
 */
function aesNoIv(algorithm, key, data) {
  const decipher = createDecipheriv(algorithm, key, Buffer.alloc(16));
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * @typedef {object} Encryption
 * @property {number} v
 * @property {number} r
 * @property {Buffer} o
 * @property {Buffer} u
 * @property {Buffer|null} ue
 * @property {number} p
 * @property {number} length   key length in bytes
 * @property {boolean} encryptMetadata
 * @property {'rc4'|'aes'|'none'} method
 * @property {Buffer} id       the first element of the trailer /ID
 */

/**
 * The file encryption key, or null when a password is genuinely required.
 *
 * @param {Encryption} enc
 * @param {string} password
 * @returns {Buffer|null}
 */
export function fileKey(enc, password = '') {
  if (enc.r >= 5) return keyR5orR6(enc, password);

  const key = keyR2toR4(enc, password);
  // Revisions 2 to 4 derive a key from any password at all, so without this
  // check a wrong password yields a wrong key, decrypts to rubbish, and the
  // caller reports "no text layer — probably a scanned document". That was
  // the real behaviour before this was added: not a refusal, a misdiagnosis.
  return validatesR2toR4(enc, key) ? key : null;
}

/**
 * Algorithm 6: does this key actually open the document?
 *
 * Recomputes the /U entry from the key and compares. For revision 2 that is
 * the padding string encrypted once; for 3 and 4 it is a digest of the
 * padding and the file identifier, put through twenty RC4 passes with the
 * key bytes shifted by the round number, of which only the first sixteen
 * bytes are meaningful — the rest is arbitrary padding the writer chose.
 *
 * @param {Encryption} enc
 * @param {Buffer} key
 */
function validatesR2toR4(enc, key) {
  if (enc.r === 2) return rc4(key, PAD).equals(enc.u.subarray(0, 32));

  const digest = md5(Buffer.concat([PAD, enc.id]));
  let value = rc4(key, digest);
  for (let round = 1; round <= 19; round++) {
    const shifted = Buffer.from(key.map((byte) => byte ^ round));
    value = rc4(shifted, value);
  }
  return value.subarray(0, 16).equals(enc.u.subarray(0, 16));
}

/**
 * Algorithm 2: the MD5-based derivation used by revisions 2 to 4.
 *
 * @param {Encryption} enc
 * @param {string} password
 */
function keyR2toR4(enc, password) {
  const supplied = Buffer.from(password, 'latin1');
  const padded = Buffer.concat([supplied, PAD]).subarray(0, 32);

  const permissions = Buffer.alloc(4);
  // Signed, little-endian. /P is written as a negative number in most files
  // and a wrong sign here yields a wrong key with no other symptom.
  permissions.writeInt32LE(enc.p | 0, 0);

  const parts = [padded, enc.o.subarray(0, 32), permissions, enc.id];
  if (enc.r >= 4 && !enc.encryptMetadata) parts.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));

  let digest = md5(Buffer.concat(parts));
  if (enc.r >= 3) {
    // Fifty further rounds over the first n bytes only. Hashing all sixteen
    // each time is the classic way to get a key that is right for 40-bit
    // files and wrong for every 128-bit one.
    for (let i = 0; i < 50; i++) digest = md5(digest.subarray(0, enc.length));
  }
  return digest.subarray(0, enc.r === 2 ? 5 : enc.length);
}

/**
 * Revisions 5 and 6: SHA-256 with salts, and the file key wrapped in /UE.
 *
 * @param {Encryption} enc
 * @param {string} password
 */
function keyR5orR6(enc, password) {
  const supplied = Buffer.from(password, 'utf8').subarray(0, 127);
  const validationSalt = enc.u.subarray(32, 40);
  const keySalt = enc.u.subarray(40, 48);

  const check = enc.r === 5
    ? createHash('sha256').update(Buffer.concat([supplied, validationSalt])).digest()
    : hardenedHash(supplied, validationSalt, Buffer.alloc(0));

  // The specification's own check. This is what makes a real user password a
  // refusal rather than a wrong answer.
  if (!check.equals(enc.u.subarray(0, 32))) return null;
  if (!enc.ue) throw new PdfCryptError('Revision 5 or 6 encryption with no /UE entry.');

  const intermediate = enc.r === 5
    ? createHash('sha256').update(Buffer.concat([supplied, keySalt])).digest()
    : hardenedHash(supplied, keySalt, Buffer.alloc(0));

  // /UE holds the file key under AES-256-CBC with a zero IV and no padding.
  return aesNoIv('aes-256-cbc', intermediate, enc.ue.subarray(0, 32));
}

/**
 * Algorithm 2.B — the iterated hash introduced in revision 6.
 *
 * Deliberately literal. It rounds at least 64 times and then keeps going
 * while the last byte of the AES output exceeds the round number minus 32,
 * which reads like a mistake and is not: it is what the specification says,
 * and a shortcut here yields a key that is wrong only for some documents.
 *
 * @param {Buffer} password
 * @param {Buffer} salt
 * @param {Buffer} userKey  empty when validating a user password
 */
function hardenedHash(password, salt, userKey) {
  let k = createHash('sha256').update(Buffer.concat([password, salt, userKey])).digest();

  for (let round = 0; ; round++) {
    const block = Buffer.concat([password, k, userKey]);
    const k1 = Buffer.concat(Array.from({ length: 64 }, () => block));

    // Encryption here, not decryption: the round function encrypts with the
    // first half of the running hash as key and the second half as IV.
    const cipher = createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(k1), cipher.final()]);

    // The sum of the first sixteen bytes, modulo three, picks the digest.
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += encrypted[i];
    const algorithm = ['sha256', 'sha384', 'sha512'][sum % 3];
    k = createHash(algorithm).update(encrypted).digest();

    if (round >= 63 && encrypted[encrypted.length - 1] <= round - 31) break;
  }
  return k.subarray(0, 32);
}

/**
 * Decrypt one string or stream.
 *
 * @param {Buffer} key       the file encryption key
 * @param {Encryption} enc
 * @param {number} objNum
 * @param {number} genNum
 * @param {Buffer} data
 */
export function decryptObject(key, enc, objNum, genNum, data) {
  if (enc.method === 'none') return data;

  // Revision 5 and 6 use the file key directly; there is no per-object key.
  if (enc.r >= 5) return aesCbcDecrypt(key, data);

  const extra = Buffer.alloc(5);
  extra.writeUIntLE(objNum & 0xffffff, 0, 3);
  extra.writeUIntLE(genNum & 0xffff, 3, 2);

  const parts = [key, extra];
  if (enc.method === 'aes') parts.push(AES_SALT);

  const objectKey = md5(Buffer.concat(parts)).subarray(0, Math.min(key.length + 5, 16));
  return enc.method === 'aes' ? aesCbcDecrypt(objectKey, data) : rc4(objectKey, data);
}

export { rc4 };
