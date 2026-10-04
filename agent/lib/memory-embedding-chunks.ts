/**
 * Deterministic memory embedding chunking.
 *
 * Exports:
 * - `MemoryEmbeddingChunkText`: source-aligned text chunk metadata.
 * - `chunkMemoryContent`: chunks along paragraph and sentence boundaries under a length cap.
 * - `chunkMemoryQuery`: the same complete coverage without the stored-memory length cap.
 *
 * Key construct:
 * - A chunk is one paragraph (a heading-sized one joins the next), or, when a paragraph is
 *   longer than the cap, a run of whole sentences (then clauses, then words) of it with an
 *   overlap that starts at a clause boundary. Fixed 400-character windows cut discussion summaries of three to four thousand
 *   characters into a dozen pieces with cuts mid-sentence and overlaps mid-word
 *   (5 October 2026); a thesis of a summary is now one vector where it fits in the cap.
 * - The cap is in characters because the embedder refuses more than 512 tokens: Russian prose
 *   is about 0.27 tokens a character, so a thousand characters leave a wide margin; text that
 *   is punctuation or emoji throughout can reach the limit, and the indexing worker then
 *   retries the record with the narrow cap.
 */
import { AppError } from "./app-error.js";
import {
  MEMORY_CONTENT_MAX_LENGTH,
  MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS,
  MEMORY_EMBEDDING_CHUNK_MIN_BOUNDARY_CHARACTERS,
  MEMORY_EMBEDDING_CHUNK_MIN_PARAGRAPH_CHARACTERS,
  MEMORY_EMBEDDING_CHUNK_OVERLAP_CHARACTERS,
  MEMORY_EMBEDDING_QUERY_CHUNK_MAX_CHARACTERS,
} from "./memory-config.js";

export interface MemoryEmbeddingChunkText {
  chunkIndex: number;
  content: string;
  endOffset: number;
  startOffset: number;
}

export interface MemoryEmbeddingChunkOptions {
  /** Longest chunk in UTF-16 code units; the stored-memory cap when absent. */
  maxCharacters?: number;
}

const WHITESPACE_PATTERN = /\s/u;
const PARAGRAPH_BREAK_PATTERN = /\n+/gu;
// Boundary classes from strongest to weakest: a cut is made after the boundary character(s).
const SENTENCE_END_PATTERN = /[.!?…]["»)]?\s/u;
const CLAUSE_END_PATTERN = /[;:]\s|\s[—–-]\s/u;

interface Span {
  end: number;
  start: number;
}

function trimmedSpan(content: string, span: Span): Span {
  let { start, end } = span;
  while (start < end && WHITESPACE_PATTERN.test(content[start]!)) start += 1;
  while (end > start && WHITESPACE_PATTERN.test(content[end - 1]!)) end -= 1;
  return { end, start };
}

/** Code units that cannot end a chunk: the first half of a surrogate pair stays with its second. */
function wholeCharacterEnd(content: string, end: number): number {
  return end < content.length && content.codePointAt(end - 1)! > 0xffff ? end - 1 : end;
}

function wholeCharacterStart(content: string, start: number): number {
  return start > 0 && content.codePointAt(start - 1)! > 0xffff ? start + 1 : start;
}

/** The last boundary of the strongest class inside [from, to); -1 when the window has none. */
function lastBoundary(content: string, from: number, to: number): number {
  const window = content.slice(from, to);
  for (const pattern of [SENTENCE_END_PATTERN, CLAUSE_END_PATTERN]) {
    let last = -1;
    const global = new RegExp(pattern.source, "gu");
    for (const match of window.matchAll(global)) {
      // The cut sits after the boundary and its trailing whitespace: the next chunk starts clean.
      last = from + match.index + match[0].length;
    }
    if (last !== -1) return last;
  }
  for (let index = to; index > from; index -= 1) {
    if (WHITESPACE_PATTERN.test(content[index - 1]!)) return index;
  }
  return -1;
}

/** Splits one paragraph longer than the cap along sentences, clauses, then words. */
function splitLongParagraph(content: string, paragraph: Span, maxCharacters: number): Span[] {
  const minBoundary = Math.min(MEMORY_EMBEDDING_CHUNK_MIN_BOUNDARY_CHARACTERS, Math.floor(maxCharacters / 2));
  const overlap = Math.min(MEMORY_EMBEDDING_CHUNK_OVERLAP_CHARACTERS, Math.floor(maxCharacters / 4));
  const spans: Span[] = [];
  let start = paragraph.start;
  while (start < paragraph.end) {
    const hardEnd = Math.min(start + maxCharacters, paragraph.end);
    let end = hardEnd;
    if (hardEnd < paragraph.end) {
      const boundary = lastBoundary(content, start + minBoundary, hardEnd);
      end = boundary === -1 ? hardEnd : boundary;
    }
    end = wholeCharacterEnd(content, end);
    spans.push({ end, start });
    if (end >= paragraph.end) break;
    // The next chunk begins a little before this one ended, at the last sentence or clause
    // boundary inside the overlap, else at a word start, so a thought that crosses the cut is
    // whole in one of them; progress is strict.
    // The word start is looked for inside the overlap only: text without whitespace (a key,
    // a hash, a run of emoji) otherwise walked back to the chunk start one character at a time
    // and a four-thousand-character record became three thousand chunks (Codex review).
    const overlapFrom = Math.max(start + 1, end - overlap);
    let wordStart = overlapFrom;
    const wordSearchFloor = Math.max(start + 1, end - 2 * overlap);
    while (wordStart > wordSearchFloor && !WHITESPACE_PATTERN.test(content[wordStart - 1]!)) wordStart -= 1;
    if (wordStart === wordSearchFloor && !WHITESPACE_PATTERN.test(content[wordStart - 1]!)) wordStart = overlapFrom;
    const boundary = lastBoundary(content, wordStart, end - 1);
    start = wholeCharacterStart(content, boundary === -1 ? wordStart : boundary);
  }
  return spans;
}

function paragraphs(content: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  for (const match of content.matchAll(PARAGRAPH_BREAK_PATTERN)) {
    if (match.index > start) spans.push({ end: match.index, start });
    start = match.index + match[0].length;
  }
  if (start < content.length) spans.push({ end: content.length, start });
  return spans;
}

function chunkText(content: string, maxCharacters: number): MemoryEmbeddingChunkText[] {
  if (!content.trim()) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_INPUT_INVALID",
      "Текст памяти невозможно подготовить для смыслового поиска",
    );
  }
  // A paragraph is a thesis and gets its own vector: packing three into one chunk lost a
  // buried thesis on the eval (its similarity fell under the threshold among the other two).
  // Only a short paragraph, a heading or a date line, joins the next one; a paragraph over the
  // cap is split on its own. Chunks never overlap across paragraphs.
  const spans: Span[] = [];
  let open: Span | null = null;
  for (const paragraph of paragraphs(content)) {
    if (paragraph.end - paragraph.start > maxCharacters) {
      if (open) spans.push(open);
      open = null;
      spans.push(...splitLongParagraph(content, paragraph, maxCharacters));
      continue;
    }
    if (open && (open.end - open.start < MEMORY_EMBEDDING_CHUNK_MIN_PARAGRAPH_CHARACTERS) &&
        paragraph.end - open.start <= maxCharacters) {
      open = { end: paragraph.end, start: open.start };
      continue;
    }
    if (open) spans.push(open);
    open = { ...paragraph };
  }
  if (open) spans.push(open);

  const chunks: MemoryEmbeddingChunkText[] = [];
  for (const span of spans) {
    const bounds = trimmedSpan(content, span);
    if (bounds.start >= bounds.end) continue;
    chunks.push({
      chunkIndex: chunks.length,
      content: content.slice(bounds.start, bounds.end),
      endOffset: bounds.end,
      startOffset: bounds.start,
    });
  }
  if (chunks.length === 0) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_INPUT_INVALID",
      "Текст памяти не образовал ни одного фрагмента для поиска",
    );
  }
  return chunks;
}

export function chunkMemoryContent(
  content: string,
  options: MemoryEmbeddingChunkOptions = {},
): MemoryEmbeddingChunkText[] {
  if (content.length > MEMORY_CONTENT_MAX_LENGTH) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_INPUT_INVALID",
      "Текст памяти превышает допустимый размер смыслового индекса",
    );
  }
  return chunkText(content, options.maxCharacters ?? MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS);
}

export function chunkMemoryQuery(query: string): MemoryEmbeddingChunkText[] {
  return chunkText(query, MEMORY_EMBEDDING_QUERY_CHUNK_MAX_CHARACTERS);
}
