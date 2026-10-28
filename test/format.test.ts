import { describe, expect, it } from "vitest";
import { areaOf, CardFormatError, parseCard, serializeCard, type Card } from "../src/format.js";

const base: Card = {
  id: "abc1234567-1",
  repo: "braineos",
  merge: "abc1234567def",
  mergeTitle: "feat: referral codes: 50% off",
  area: "web/src/server",
  createdAt: "2026-11-02T09:00:00.000Z",
  status: "draft",
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

  it("names the area by directory depth", () => {
    expect(areaOf("web/src/server/mcp/tools.ts", 3)).toBe("web/src/server");
    expect(areaOf("src/a.ts", 3)).toBe("src");
    expect(areaOf("README.md", 3)).toBe("(root)");
  });
});
