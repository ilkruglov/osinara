/**
 * Large strings of a Workflow payload stored once, by content hash.
 *
 * Exports:
 * - `splitPayload`: takes a serialized payload (`devl` JSON, optionally `zstd`-compressed), lifts
 *   every top-level string of at least `PAYLOAD_BLOB_MIN_CHARS` into a blob keyed by its SHA-256
 *   and returns the payload with markers in their place; `null` when there is nothing to lift.
 * - `joinPayload`: the inverse, given the blobs.
 * - `isSplitPayload`, `payloadBlobHashes`: whether stored bytes carry markers, and which blobs they need.
 * - `escapePayload`, `isEscapedPayload`, `unescapePayload`: opaque bytes that happen to start like a
 *   stored envelope get an `oblr` prefix on the way in and lose it on the way out.
 * - `createPayloadBlobCache`: bounded in-process cache of blob bytes.
 *
 * Key constructs:
 * - A production sample (4 October 2026, 4 000 events over 3 days) decoded to 104 MB, of which
 *   49 MB were strings of 2 KB and more, and only 1.9 MB of those were distinct: the system prompt
 *   (18 KB, 851 copies), instruction blocks (6 KB, 616 copies), the history snapshot of each
 *   session repeated on every turn. Compressed, the eight most repeated strings were 44 % of the
 *   stored bytes.
 * - devalue serializes to one flat JSON array whose strings are top-level elements, so a top-level
 *   scan is complete and the structure stays untouched; a marker is an object with one reserved
 *   key, which no devalue element is.
 * - The stored envelope is `oblz` + zstd(marked JSON) when the original was compressed, `oblb` +
 *   marked JSON when it was not; the prefix alone tells the form. The runtime never sees it: every
 *   read of the world restores the original form before handing the payload on.
 */
import { createHash } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

export const PAYLOAD_BLOB_MIN_CHARS = 2_048;
export const PAYLOAD_BLOB_MARKER_KEY = "\u0000osinara-blob";

const ZSTD = "zstd";
const DEVL = "devl";
const STORED_COMPRESSED = "oblz";
const STORED_PLAIN = "oblb";
const ESCAPED = "oblr";
const RESERVED_PREFIXES = new Set([STORED_COMPRESSED, STORED_PLAIN, ESCAPED]);

const prefixOf = (bytes            ) => bytes.length >= 4 ? Buffer.from(bytes.buffer, bytes.byteOffset, 4).toString("latin1") : "";
const rest = (bytes            ) => Buffer.from(bytes.buffer, bytes.byteOffset + 4, bytes.length - 4);
const concat = (prefix        , body        ) => new Uint8Array(Buffer.concat([Buffer.from(prefix, "latin1"), body]));

export const payloadBlobHash = (value        ) => createHash("sha256").update(value, "utf8").digest("hex");

                               
                                                             
                                 
                     
 

export function splitPayload(bytes            , minChars = PAYLOAD_BLOB_MIN_CHARS)                      {
  const prefix = prefixOf(bytes);
  if (prefix !== ZSTD && prefix !== DEVL) return null;
  const compressed = prefix === ZSTD;
  const body = compressed ? new Uint8Array(zstdDecompressSync(rest(bytes))) : bytes;
  if (prefixOf(body) !== DEVL) return null;
  let flat         ;
  try {
    flat = JSON.parse(rest(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(flat)) return null;
  const blobs = new Map                    ();
  for (let i = 0; i < flat.length; i += 1) {
    const value = flat[i];
    if (typeof value !== "string" || value.length < minChars) continue;
    const hash = payloadBlobHash(value);
    if (!blobs.has(hash)) blobs.set(hash, new Uint8Array(Buffer.from(value, "utf8")));
    flat[i] = { [PAYLOAD_BLOB_MARKER_KEY]: hash };
  }
  if (blobs.size === 0) return null;
  const json = Buffer.from(JSON.stringify(flat), "utf8");
  return { blobs, stored: compressed ? concat(STORED_COMPRESSED, zstdCompressSync(json)) : concat(STORED_PLAIN, json) };
}

/** Whether these stored bytes carry blob markers; a prefix check, nothing is decompressed. */
export function isSplitPayload(bytes            )          {
  const prefix = prefixOf(bytes);
  return prefix === STORED_PLAIN || prefix === STORED_COMPRESSED;
}

/** Bytes that start like one of the stored envelopes are wrapped so a read cannot mistake them. */
export function escapePayload(bytes            )             {
  return RESERVED_PREFIXES.has(prefixOf(bytes)) ? concat(ESCAPED, Buffer.from(bytes)) : bytes;
}

export function isEscapedPayload(bytes            )          {
  return prefixOf(bytes) === ESCAPED;
}

export function unescapePayload(bytes            )             {
  return isEscapedPayload(bytes) ? new Uint8Array(rest(bytes)) : bytes;
}

function parseStored(bytes            )                                                  {
  const prefix = prefixOf(bytes);
  if (prefix !== STORED_PLAIN && prefix !== STORED_COMPRESSED) return null;
  const compressed = prefix === STORED_COMPRESSED;
  const json = compressed ? zstdDecompressSync(rest(bytes)) : rest(bytes);
  return { compressed, flat: JSON.parse(json.toString("utf8"))              };
}

const markerOf = (value         )                =>
  value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value                           )[PAYLOAD_BLOB_MARKER_KEY] === "string"
    ? (value                          )[PAYLOAD_BLOB_MARKER_KEY] 
    : null;

export function payloadBlobHashes(bytes            )           {
  const stored = parseStored(bytes);
  if (!stored) return [];
  return [...new Set(stored.flat.map(markerOf).filter((hash)                 => hash !== null))];
}

export function joinPayload(bytes            , lookup                                          )             {
  const stored = parseStored(bytes);
  if (!stored) return bytes;
  const flat = stored.flat.map((value) => {
    const hash = markerOf(value);
    if (hash === null) return value;
    const blob = lookup(hash);
    if (blob === undefined) throw new Error(`AGENT_WORKFLOW_PAYLOAD_BLOB_MISSING: ${hash}`);
    return Buffer.from(blob).toString("utf8");
  });
  const body = Buffer.concat([Buffer.from(DEVL, "latin1"), Buffer.from(JSON.stringify(flat), "utf8")]);
  return stored.compressed ? concat(ZSTD, zstdCompressSync(body)) : new Uint8Array(body);
}

                                   
                
                                            
                                             
                        
 

/**
 * Keeps the most recently set blobs within `maxBytes`; distinct blobs are few (193 in the sample).
 * A blob larger than the whole budget is not kept at all. Readers never depend on an entry
 * surviving: a restore collects the blobs it needs for itself first.
 */
export function createPayloadBlobCache(maxBytes = 64 * 1024 * 1024)                   {
  const entries = new Map                    ();
  let bytes = 0;
  return {
    clear() {
      entries.clear();
      bytes = 0;
    },
    get(hash) {
      const value = entries.get(hash);
      if (value === undefined) return undefined;
      entries.delete(hash);
      entries.set(hash, value);
      return value;
    },
    set(hash, value) {
      if (entries.has(hash) || value.length > maxBytes) return;
      entries.set(hash, value);
      bytes += value.length;
      while (bytes > maxBytes) {
        const [oldest, oldestValue] = entries.entries().next().value                        ;
        entries.delete(oldest);
        bytes -= oldestValue.length;
      }
    },
    get size() { return bytes; },
  };
}
