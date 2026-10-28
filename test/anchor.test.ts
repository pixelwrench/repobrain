import { describe, expect, it } from "vitest";
import { checkAnchor, makeAnchor } from "../src/anchor.js";
import { commit, makeRepo } from "./helpers.js";

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

  it("stays fresh when other code moves the block or it is re-indented", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": FILE }, "add referral");
    const a = makeAnchor(repo, sha, "src/ref.ts", 1, 5, null)!;
    const moved = "import { lookup } from './db';\n\n" + FILE.replace(/^ {2}/gm, "    ");
    const head = commit(repo, { "src/ref.ts": moved }, "move");
    expect(checkAnchor(repo, head, a)).toBe("fresh");
  });

  it("reports changed when the block's code changes", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": FILE }, "add referral");
    const a = makeAnchor(repo, sha, "src/ref.ts", 1, 5, null)!;
    const head = commit(repo, { "src/ref.ts": FILE.replace("return null", "throw new Error('bad code')") }, "change");
    expect(checkAnchor(repo, head, a)).toBe("changed");
  });

  it("reports orphaned when the file is deleted", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "src/ref.ts": FILE, "keep.txt": "k\n" }, "add referral");
    const a = makeAnchor(repo, sha, "src/ref.ts", 1, 5, null)!;
    const head = commit(repo, { "src/ref.ts": null }, "delete");
    expect(checkAnchor(repo, head, a)).toBe("orphaned");
  });
});
