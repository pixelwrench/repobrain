import { describe, expect, it } from "vitest";
import { ANCHOR_STATUSES, areaOf, CARD_STATUSES, CardFormatError, parseCard, serializeCard, type Card } from "../src/format.js";

const base: Card = {
  id: "abc1234567-1",
  repo: "braineos",
  merge: "abc1234567def",
  mergeTitle: "feat: referral codes: 50% off",
  area: "web/src/server",
  createdAt: "2026-11-02T09:00:00.000Z",
  status: "draft",
  source: "merge",
  anchor: {
    commit: "abc1234567def", path: "web/src/server/referrals.ts", symbol: "applyReferral",
    startLine: 10, endLine: 24, lines: 12, fingerprint: "0123456789abcdef", status: "fresh",
  },
  body: {
    kind: "mcq",
    question: "Why is the referral discount applied at checkout rather than at sign-up?",
    choices: ["The coupon needs a Stripe customer", "To avoid double discounts", "Sign-up has no price", "It is faster"],
    correctChoice: 0,
    explanation: "The coupon attaches to a Stripe customer, which only exists at checkout.",
  },
};

describe("card format", () => {
  it("round-trips a multiple-choice card", () => {
    expect(parseCard(serializeCard(base))).toEqual(base);
  });

  it("round-trips a baseline card, and writes source always", () => {
    const card: Card = { ...base, source: "baseline", mergeTitle: "Baseline: Entry points" };
    expect(parseCard(serializeCard(card))).toEqual(card);
    expect(serializeCard(base)).toContain('source: "merge"');
  });

  it("reads a card file without source, as written before baselines, as a merge card", () => {
    const text = serializeCard(base).replace(/^source: .*\n/m, "");
    expect(text).not.toContain("source:");
    expect(parseCard(text)).toEqual(base);
  });

  it("rejects an unknown source", () => {
    expect(() => parseCard(serializeCard(base).replace('source: "merge"', 'source: "import"'))).toThrow(/source must be one of merge, baseline/);
  });

  it("round-trips a flashcard", () => {
    const card: Card = { ...base, body: { kind: "flashcard", front: "Where are referral codes checked?", back: "`applyReferral`" } };
    expect(parseCard(serializeCard(card))).toEqual(card);
  });

  it("uses the content vaults' question syntax and JSON front-matter values", () => {
    const text = serializeCard(base);
    expect(text).toContain("Q: Why is the referral discount");
    expect(text).toContain("Correct: A");
    expect(text).toContain('merge_title: "feat: referral codes: 50% off"');
  });

  it("collapses newlines in card text", () => {
    const card: Card = { ...base, body: { ...base.body, question: "Why\n   this?" } as Card["body"] };
    expect(parseCard(serializeCard(card)).body).toMatchObject({ question: "Why this?" });
  });

  it("rejects a multiple-choice card missing option D", () => {
    const text = serializeCard(base).replace(/^D: .*\n/m, "");
    expect(() => parseCard(text)).toThrow(CardFormatError);
  });

  it("rejects an invalid answer letter", () => {
    const text = serializeCard(base).replace("Correct: A", "Correct: E");
    expect(() => parseCard(text)).toThrow(/A, B, C or D/);
  });

  it("keeps wrapped lines in a hand-edited body", () => {
    const text = serializeCard(base).replace(/^Q: .*$/m, "Q: What\n  continued here\n\nstill more");
    expect(parseCard(text).body).toMatchObject({ question: "What continued here still more" });
  });

  it("ignores lines before the first label", () => {
    const text = serializeCard(base).replace(/^Q: /m, "stray preamble\nQ: ");
    expect(parseCard(text).body).toMatchObject({ question: base.body.kind === "mcq" ? base.body.question : "" });
  });

  it("round-trips text containing a carriage return or line separator", () => {
    for (const q of ["a\rb", "a b", "a b"]) {
      const card: Card = { ...base, body: { ...base.body, question: q } as Card["body"] };
      expect(parseCard(serializeCard(card)).body).toMatchObject({ question: "a b" });
    }
  });

  it("exports the allowed statuses", () => {
    expect(CARD_STATUSES).toEqual(["draft", "kept", "dropped"]);
    expect(ANCHOR_STATUSES).toEqual(["fresh", "changed", "orphaned"]);
  });

  it("rejects an unknown card status", () => {
    const text = serializeCard(base).replace('status: "draft"', 'status: "maybe"');
    expect(() => parseCard(text)).toThrow(/status must be one of/);
  });

  it("rejects an unknown anchor status", () => {
    const text = serializeCard(base).replace('anchor_status: "fresh"', 'anchor_status: "stale"');
    expect(() => parseCard(text)).toThrow(/anchor_status must be one of/);
  });

  it("accepts a label with no space or an empty value", () => {
    const text = serializeCard(base).replace("Correct: A", "Correct:A").replace(/^Explanation: .*$/m, "Explanation:");
    const body = parseCard(text).body;
    expect(body).toMatchObject({ correctChoice: 0, explanation: "" });
  });

  it("round-trips a choice whose text looks like a label", () => {
    const card: Card = { ...base, body: { ...base.body, choices: ["Correct: B", "B: x", "Q: y", "d"] } as Card["body"] };
    expect(parseCard(serializeCard(card))).toEqual(card);
  });

  it("refuses to serialise a multiple-choice card without exactly 4 choices", () => {
    const card = { ...base, body: { ...base.body, choices: ["a", "b", "c"] } as Card["body"] };
    expect(() => serializeCard(card)).toThrow(CardFormatError);
  });

  it("refuses to serialise a multiple-choice card with an out-of-range answer", () => {
    for (const correctChoice of [-1, 4, 1.5]) {
      const card = { ...base, body: { ...base.body, correctChoice } as Card["body"] };
      expect(() => serializeCard(card)).toThrow(CardFormatError);
    }
  });

  it("names the area by directory depth", () => {
    expect(areaOf("web/src/server/mcp/tools.ts", 3)).toBe("web/src/server");
    expect(areaOf("src/a.ts", 3)).toBe("src");
    expect(areaOf("README.md", 3)).toBe("(root)");
  });
});
