import { createHash } from "node:crypto";
import type { Anchor, AnchorStatus } from "./format.js";
import { fileAt } from "./git.js";

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

export function makeAnchor(repo: string, commit: string, path: string, startLine: number, endLine: number, symbol: string | null): Anchor | null {
  const content = fileAt(repo, commit, path);
  if (content === null) return null;
  const all = content.split("\n");
  const start = Math.max(1, Math.min(startLine, all.length));
  const end = Math.max(start, Math.min(endLine, all.length));
  const block = normalizedLines(all.slice(start - 1, end).join("\n"));
  if (block.length === 0) return null;
  return {
    commit, path, symbol: symbol && content.includes(symbol) ? symbol : null,
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
