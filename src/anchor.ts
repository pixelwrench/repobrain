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

/** A block needs at least this many letters, digits or underscores (any script) to be worth anchoring. */
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
  for (const l of lines) n += l.replace(/[^\p{L}\p{N}_]/gu, "").length;
  return n;
}

/** Matches `symbol` as a whole word. Lookarounds rather than \b, so symbols that start or end with `$` still match whole. */
function symbolPattern(symbol: string): RegExp {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
}

function hasSymbol(content: string, symbol: string): boolean {
  return symbolPattern(symbol).test(content);
}

/** 1-based lines where `symbol` occurs as a whole word, matched as makeAnchor matches symbols. */
export function findSymbolLines(content: string | null, symbol: string): number[] {
  if (content === null) return [];
  const re = symbolPattern(symbol);
  return content.split("\n").flatMap((line, i) => (re.test(line) ? [i + 1] : []));
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
  return locateAnchor(fileAt(repo, rev, anchor.path), anchor).status;
}

/** Where an anchored block is in a file: fresh with its current line range, or changed, or orphaned. */
export type AnchorMatch = { status: "fresh"; startLine: number; endLine: number } | { status: "changed" | "orphaned" };

/**
 * Finds the anchored block in `content` (the file's text, or null when the file is gone).
 * When the block appears more than once, the copy nearest the anchor's old start line wins.
 */
export function locateAnchor(content: string | null, anchor: Anchor): AnchorMatch {
  if (content === null) return { status: "orphaned" };
  // Line numbers (1-based) of the trimmed, non-blank lines, so a window maps back to a range.
  const lines: string[] = [];
  const lineNos: number[] = [];
  content.split("\n").forEach((raw, i) => {
    const l = raw.trim();
    if (l.length > 0) {
      lines.push(l);
      lineNos.push(i + 1);
    }
  });
  const k = anchor.lines;
  if (!Number.isInteger(k) || k < 1 || k > lines.length) return { status: "changed" };
  // Join once and hash substrings, so each window costs one hash and no array copies.
  // Lines are trimmed and non-empty, so a window's substring equals lines.slice(...).join("\n").
  const joined = lines.join("\n");
  const offsets: number[] = [0];
  for (const l of lines) offsets.push(offsets[offsets.length - 1] + l.length + 1);
  let best: { startLine: number; endLine: number } | null = null;
  for (let i = 0; i + k <= lines.length; i++) {
    if (hashOf(joined.slice(offsets[i], offsets[i + k] - 1)) !== anchor.fingerprint) continue;
    const found = { startLine: lineNos[i], endLine: lineNos[i + k - 1] };
    if (!best || Math.abs(found.startLine - anchor.startLine) < Math.abs(best.startLine - anchor.startLine)) best = found;
  }
  return best ? { status: "fresh", ...best } : { status: "changed" };
}
