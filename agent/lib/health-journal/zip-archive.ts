/**
 * Reads named entries of a zip archive, including WinZip AES-encrypted ones, without dependencies.
 *
 * Export:
 * - `readZipEntries`: the uncompressed bytes of the entries a predicate selects.
 *
 * Key constructs:
 * - Sizes and offsets come from the central directory: Zepp writes its entries with a data
 *   descriptor (flag bit 3), so the local headers carry zero sizes.
 * - WinZip AES (method 99, extra field 0x9901): PBKDF2-HMAC-SHA1 with 1000 iterations derives the
 *   AES key, the HMAC key and a 2-byte password check; the data is AES-CTR with a little-endian
 *   counter starting at 1, authenticated by the first 10 bytes of HMAC-SHA1 over the ciphertext.
 *   Node's CTR mode counts big-endian, so the keystream is built block by block with AES-ECB.
 * - Traditional PKWARE encryption is refused: it is broken, and Zepp does not use it.
 * - Limits: entries are inflated with `maxOutputLength`, bounded by both the entry limit and what
 *   the total limit has left, and the number of selected entries is capped, so a zip bomb fails
 *   instead of filling memory; ZIP64 archives are refused (an export of years is a few megabytes).
 */
import { createCipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export class ZipArchiveError extends Error {
  constructor(
    readonly reason:
      | "corrupt"
      | "encrypted_unsupported"
      | "password_required"
      | "password_wrong"
      | "too_large"
      | "unsupported",
  ) {
    super(`zip archive: ${reason}`);
    this.name = "ZipArchiveError";
  }
}

interface CentralEntry {
  compressedSize: number;
  extra: Buffer;
  flags: number;
  localOffset: number;
  method: number;
  name: string;
  size: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function centralDirectory(zip: Buffer): CentralEntry[] {
  const searchFrom = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = zip.length - 22; offset >= searchFrom; offset -= 1) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new ZipArchiveError("corrupt");
  const count = zip.readUInt16LE(eocd + 10);
  const size = zip.readUInt32LE(eocd + 12);
  let offset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff)
    throw new ZipArchiveError("unsupported");
  const entries: CentralEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE)
      throw new ZipArchiveError("corrupt");
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > zip.length) throw new ZipArchiveError("corrupt");
    entries.push({
      compressedSize: zip.readUInt32LE(offset + 20),
      extra: zip.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength),
      flags: zip.readUInt16LE(offset + 8),
      localOffset: zip.readUInt32LE(offset + 42),
      method: zip.readUInt16LE(offset + 10),
      name: zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"),
      size: zip.readUInt32LE(offset + 24),
    });
    offset = end;
  }
  return entries;
}

function entryData(zip: Buffer, entry: CentralEntry): Buffer {
  const offset = entry.localOffset;
  if (offset + 30 > zip.length || zip.readUInt32LE(offset) !== LOCAL_SIGNATURE)
    throw new ZipArchiveError("corrupt");
  const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
  const end = start + entry.compressedSize;
  if (end > zip.length) throw new ZipArchiveError("corrupt");
  return zip.subarray(start, end);
}

function aesExtra(extra: Buffer): { method: number; strength: number } {
  for (let offset = 0; offset + 4 <= extra.length;) {
    const id = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    if (offset + 4 + length > extra.length) break;
    if (id === 0x9901 && length >= 7)
      return { method: extra.readUInt16LE(offset + 9), strength: extra.readUInt8(offset + 8) };
    offset += 4 + length;
  }
  throw new ZipArchiveError("corrupt");
}

function aesCtrLittleEndian(key: Buffer, data: Buffer): Buffer {
  const cipher = createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  cipher.setAutoPadding(false);
  const blocks = Math.ceil(data.length / 16);
  const counters = Buffer.alloc(blocks * 16);
  for (let block = 0; block < blocks; block += 1) {
    // A 128-bit little-endian counter from 1; an export never needs more than the low 48 bits.
    counters.writeUIntLE(block + 1, block * 16, 6);
  }
  const stream = Buffer.concat([cipher.update(counters), cipher.final()]);
  const plain = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) plain[index] = data[index]! ^ stream[index]!;
  return plain;
}

function decryptAes(data: Buffer, strength: number, password: string): Buffer {
  const keyLength = { 1: 16, 2: 24, 3: 32 }[strength];
  if (keyLength === undefined) throw new ZipArchiveError("unsupported");
  const saltLength = keyLength / 2;
  if (data.length < saltLength + 2 + 10) throw new ZipArchiveError("corrupt");
  const salt = data.subarray(0, saltLength);
  const check = data.subarray(saltLength, saltLength + 2);
  const cipherText = data.subarray(saltLength + 2, data.length - 10);
  const mac = data.subarray(data.length - 10);
  const derived = pbkdf2Sync(Buffer.from(password, "utf8"), salt, 1000, keyLength * 2 + 2, "sha1");
  if (!timingSafeEqual(derived.subarray(keyLength * 2), check))
    throw new ZipArchiveError("password_wrong");
  const expected = createHmac("sha1", derived.subarray(keyLength, keyLength * 2))
    .update(cipherText)
    .digest()
    .subarray(0, 10);
  if (!timingSafeEqual(expected, mac)) throw new ZipArchiveError("corrupt");
  return aesCtrLittleEndian(derived.subarray(0, keyLength), cipherText);
}

/** `maxBytes` bounds the real output: a declared size is the archive's claim, not a fact. */
function decompress(data: Buffer, method: number, size: number, maxBytes: number): Buffer {
  if (size > maxBytes) throw new ZipArchiveError("too_large");
  if (method === 0) {
    if (data.length > maxBytes) throw new ZipArchiveError("too_large");
    return Buffer.from(data);
  }
  if (method !== 8) throw new ZipArchiveError("unsupported");
  try {
    return inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
      throw new ZipArchiveError("too_large");
    throw new ZipArchiveError("corrupt");
  }
}

export function readZipEntries(
  zip: Buffer,
  select: (name: string) => boolean,
  options: {
    maxEntries: number;
    maxEntryBytes: number;
    maxTotalBytes: number;
    password: string | null;
  },
): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  let total = 0;
  let selected = 0;
  for (const entry of centralDirectory(zip)) {
    if (!select(entry.name)) continue;
    // Every selected entry counts, a repeated name too: each one would be decrypted again.
    selected += 1;
    if (selected > options.maxEntries) throw new ZipArchiveError("too_large");
    let data = entryData(zip, entry);
    let method = entry.method;
    if ((entry.flags & 1) !== 0) {
      if (entry.method !== 99) throw new ZipArchiveError("encrypted_unsupported");
      if (options.password === null) throw new ZipArchiveError("password_required");
      const aes = aesExtra(entry.extra);
      data = decryptAes(data, aes.strength, options.password);
      method = aes.method;
    }
    // Each entry may use only what the total has left, so memory never exceeds the total.
    const bytes = decompress(
      data,
      method,
      entry.size,
      Math.min(options.maxEntryBytes, options.maxTotalBytes - total),
    );
    total += bytes.length;
    result.set(entry.name, bytes);
  }
  return result;
}
