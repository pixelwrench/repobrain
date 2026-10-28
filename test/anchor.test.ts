import { describe, expect, it } from "vitest";
import { locateAnchor, makeAnchor } from "../src/anchor.js";
import type { Anchor } from "../src/format.js";
import { fileAt } from "../src/git.js";
import { commit, makeRepo } from "./helpers.js";

/** The anchor's status in the file at `rev`. */
const statusAt = (repo: string, rev: string, a: Anchor) => locateAnchor(fileAt(repo, rev, a.path), a).status;

const FILE = ["export function applyReferral(code: string) {", "  const ref = lookup(code);", "  if (!ref) return null;", "  return discount(ref);", "}", ""].join("\n");

describe("anchors", () => {
  it("anchors a line range and keeps a symbol only if it exists", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": FILE }, "add referral");
    const a = makeAnchor(repo, sha, "src/ref.ts", 1, 5, "applyReferral")!;
    expect(a).toMatchObject({ path: "src/ref.ts", symbol: "applyReferral", startLine: 1, endLine: 5, lines: 5, status: "fresh" });
    expect(makeAnchor(repo, sha, "src/ref.ts", 1, 5, "noSuchSymbol")!.symbol).toBeNull();
    expect(makeAnchor(repo, sha, "src/missing.ts", 1, 5, null)).toBeNull();
  });

  it("matches a symbol only as a whole word", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": "export function applyReferral() {\n  return discount();\n}\n" }, "add");
    expect(makeAnchor(repo, sha, "src/ref.ts", 1, 3, "ref")!.symbol).toBeNull();
    expect(makeAnchor(repo, sha, "src/ref.ts", 1, 3, "Referral")!.symbol).toBeNull();
    expect(makeAnchor(repo, sha, "src/ref.ts", 1, 3, "apply.*")!.symbol).toBeNull();
    expect(makeAnchor(repo, sha, "src/ref.ts", 1, 3, "applyReferral")!.symbol).toBe("applyReferral");
  });

  it("returns null for a directory or an empty path", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": FILE }, "add referral");
    expect(makeAnchor(repo, sha, "src", 1, 5, null)).toBeNull();
    expect(makeAnchor(repo, sha, "", 1, 5, null)).toBeNull();
  });

  it("rejects a start past the end, swaps a reversed range and truncates fractions", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": FILE }, "add referral");
    expect(makeAnchor(repo, sha, "src/ref.ts", 6, 8, null)).toBeNull();
    expect(makeAnchor(repo, sha, "src/ref.ts", 5, 1, null)).toMatchObject({ startLine: 1, endLine: 5, lines: 5 });
    expect(makeAnchor(repo, sha, "src/ref.ts", 1.7, 4.9, null)).toMatchObject({ startLine: 1, endLine: 4, lines: 4 });
    expect(makeAnchor(repo, sha, "src/ref.ts", 2, 99, null)).toMatchObject({ startLine: 2, endLine: 5 });
  });

  it("keeps a short but meaningful single line", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/c.ts": "const MAX_RETRIES = 3;\n" }, "add");
    expect(makeAnchor(repo, sha, "src/c.ts", 1, 1, null)).toMatchObject({ startLine: 1, endLine: 1, lines: 1 });
  });

  it("counts letters and digits in any script as meaningful", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/名前.ts": "価格 = 税金 + 送料 + 手数料\n" }, "add");
    expect(makeAnchor(repo, sha, "src/名前.ts", 1, 1, null)).toMatchObject({ startLine: 1, endLine: 1, lines: 1 });
  });

  it("widens a trivial block, and gives up when the area stays trivial", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": FILE, "src/braces.ts": "{\n  {\n  }\n  });\n}\n})\n" }, "add");
    const a = makeAnchor(repo, sha, "src/ref.ts", 5, 5, null)!;
    expect(a.startLine).toBeLessThan(5);
    expect(a.endLine - a.startLine + 1).toBeLessThanOrEqual(5);
    expect(a.lines).toBeGreaterThan(1);
    expect(makeAnchor(repo, sha, "src/braces.ts", 3, 3, null)).toBeNull();
  });

  it("stays fresh when other code moves the block or it is re-indented", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": FILE }, "add referral");
    const a = makeAnchor(repo, sha, "src/ref.ts", 1, 5, null)!;
    const moved = "import { lookup } from './db';\n\n" + FILE.replace(/^ {2}/gm, "    ");
    const head = commit(repo, { "src/ref.ts": moved }, "move");
    expect(statusAt(repo, head, a)).toBe("fresh");
  });

  it("stays fresh with CRLF line endings or blank lines inside the block", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": FILE }, "add referral");
    const a = makeAnchor(repo, sha, "src/ref.ts", 1, 5, null)!;
    const crlf = commit(repo, { "src/ref.ts": FILE.replace(/\n/g, "\r\n") }, "crlf");
    expect(statusAt(repo, crlf, a)).toBe("fresh");
    const spaced = commit(repo, { "src/ref.ts": FILE.replace("return null;\n", "return null;\n\n   \n") }, "spaced");
    expect(statusAt(repo, spaced, a)).toBe("fresh");
  });

  it("reports changed when the block's code changes", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": FILE }, "add referral");
    const a = makeAnchor(repo, sha, "src/ref.ts", 1, 5, null)!;
    const head = commit(repo, { "src/ref.ts": FILE.replace("return null", "throw new Error('bad code')") }, "change");
    expect(statusAt(repo, head, a)).toBe("changed");
  });

  it("reports changed for an anchor whose line count is impossible", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": FILE }, "add referral");
    const a = makeAnchor(repo, sha, "src/ref.ts", 1, 5, null)!;
    expect(statusAt(repo, sha, { ...a, lines: 0 })).toBe("changed");
    expect(statusAt(repo, sha, { ...a, lines: 99 })).toBe("changed");
  });

  it("reports orphaned when the file is deleted", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": FILE, "keep.txt": "k\n" }, "add referral");
    const a = makeAnchor(repo, sha, "src/ref.ts", 1, 5, null)!;
    const head = commit(repo, { "src/ref.ts": null }, "delete");
    expect(statusAt(repo, head, a)).toBe("orphaned");
  });

  it("reports orphaned when the path has become a directory", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": FILE }, "add referral");
    const a = makeAnchor(repo, sha, "src/ref.ts", 1, 5, null)!;
    const head = commit(repo, { "src/ref.ts": null, "src/ref.ts/index.ts": FILE }, "now a dir");
    expect(statusAt(repo, head, a)).toBe("orphaned");
  });

  it("locates a moved block by its original line numbers, blank lines and CRLF included", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": FILE }, "add referral");
    const a = makeAnchor(repo, sha, "src/ref.ts", 2, 4, null)!;
    const lines = FILE.split("\n");
    const moved = ["// header", "", "", lines[0], lines[1], "", lines[2], lines[3], lines[4], ""].join("\r\n");
    expect(locateAnchor(moved, a)).toEqual({ status: "fresh", startLine: 5, endLine: 8 });
    expect(locateAnchor(FILE.replace("return null", "return 0"), a)).toEqual({ status: "changed" });
    expect(locateAnchor(null, a)).toEqual({ status: "orphaned" });
  });

  it("picks the copy nearest the old range when a block appears twice", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": FILE }, "add referral");
    const a = makeAnchor(repo, sha, "src/ref.ts", 1, 5, null)!;
    const twice = FILE + "\n".repeat(20) + FILE;
    expect(locateAnchor(twice, a)).toEqual({ status: "fresh", startLine: 1, endLine: 5 });
    expect(locateAnchor(twice, { ...a, startLine: 25, endLine: 29 })).toEqual({ status: "fresh", startLine: 26, endLine: 30 });
  });
});
