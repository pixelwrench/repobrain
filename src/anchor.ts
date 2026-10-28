/**
 * Anchors tie a card to the block of code it describes. The fingerprint is a
 * hash of the block's trimmed, non-blank lines, and checkAnchor looks for that
 * block anywhere in the file at a later revision.
 *
 * Known limit (v1, by design): if a block appears more than once in a file,
 * the anchor stays fresh while any copy is unchanged, even if the copy the
 * card was written about has changed.
 */
import { createHash } from "node:crypto";
import type { Anchor, AnchorStatus } from "./format.js";
import { fileAt } from "./git.js";

/** A block needs at least this many identifier characters to be worth anchoring. */
const MIN_WORD_CHARS = 8;
/** How far makeAnchor widens a trivial block, in lines. */
const MAX_WIDENED_LINES = 5;

/** Trimmed, non-blank lines: re-indenting or adding blank lines doesn't change a fingerprint. */
export function normalizedLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

function hashOf(joined: string): string {
  return createHash("sha256").update(joined).digest("hex").slice(0, 16);
}

export function fingerprintOf(lines: string[]): string {
  return hashOf(lines.join("\n"));
}

function wordChars(lines: string[]): number {
  let n = 0;
  for (const l of lines) n += l.replace(/[^A-Za-z0-9_]/g, "").length;
  return n;
}

function hasSymbol(content: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Lookarounds rather than \b, so symbols that start or end with `$` still match whole.
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(content);
}

export function makeAnchor(repo: string, commit: string, path: string, startLine: number, endLine: number, symbol: string | null): Anchor | null {
  const content = fileAt(repo, commit, path);
  if (content === null) return null;
  const all = content.split("\n");
  const lastLine = content.endsWith("\n") ? all.length - 1 : all.length;
  let start = Math.trunc(startLine);
  let end = Math.trunc(endLine);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end) [start, end] = [end, start];
  if (start > lastLine) return null;
  start = Math.max(1, start);
  end = Math.min(Math.max(start, end), lastLine);
  const blockOf = () => normalizedLines(all.slice(start - 1, end).join("\n"));
  let block = blockOf();
  // A trivial block such as `}` matches everywhere, so widen it a line at a time on each side.
  while (wordChars(block) < MIN_WORD_CHARS && end - start + 1 < MAX_WIDENED_LINES && (start > 1 || end < lastLine)) {
    if (start > 1) start--;
    if (end - start + 1 < MAX_WIDENED_LINES && end < lastLine) end++;
    block = blockOf();
  }
  if (wordChars(block) < MIN_WORD_CHARS) return null;
  return {
    commit, path, symbol: symbol && hasSymbol(content, symbol) ? symbol : null,
    startLine: start, endLine: end, lines: block.length, fingerprint: fingerprintOf(block), status: "fresh",
  };
}

/** Whether the anchored block still exists anywhere in the file at `rev`. */
export function checkAnchor(repo: string, rev: string, anchor: Anchor): AnchorStatus {
  const content = fileAt(repo, rev, anchor.path);
  if (content === null) return "orphaned";
  const lines = normalizedLines(content);
  const k = anchor.lines;
  if (!Number.isInteger(k) || k < 1 || k > lines.length) return "changed";
  // Join once and hash substrings, so each window costs one hash and no array copies.
  // Lines are trimmed and non-empty, so a window's substring equals lines.slice(...).join("\n").
  const joined = lines.join("\n");
  const offsets: number[] = [0];
  for (const l of lines) offsets.push(offsets[offsets.length - 1] + l.length + 1);
  for (let i = 0; i + k <= lines.length; i++) {
    if (hashOf(joined.slice(offsets[i], offsets[i + k] - 1)) === anchor.fingerprint) return "fresh";
  }
  return "changed";
}
