import { describe, expect, it } from "vitest";
import { filterDiff, findSecrets, rebalanceAnswers, validateCard } from "../src/guard.js";
import type { CardBody } from "../src/format.js";

// Built by concatenation so secret scanners don't flag this repo.
const AWS = "AKIA" + "Z7XQ2M4N6P8R0T1V";
const STRIPE = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc";
const PRIVATE_KEY_HEADER = "-----BEGIN RSA " + "PRIVATE KEY-----";
const PASSWORD_LINE = "pass" + 'word = "hunter2' + 'hunter2"';

const mcq = (over: Partial<Extract<CardBody, { kind: "mcq" }>> = {}): CardBody => ({
  kind: "mcq",
  question: "Why does capture compare commits instead of using git's post-merge hook?",
  choices: ["Remote merges never fire the hook", "The hook is slower", "Hooks need root", "Git removed the hook"],
  correctChoice: 0,
  explanation: "Merges made on GitHub or Bitbucket never run a local hook.",
  ...over,
});

describe("findSecrets", () => {
  it("spots common credentials", () => {
    expect(findSecrets(`key = ${AWS}`)).toContain("aws-access-key");
    expect(findSecrets(STRIPE)).toContain("stripe-key");
    expect(findSecrets(PRIVATE_KEY_HEADER)).toContain("private-key");
    expect(findSecrets(PASSWORD_LINE)).toContain("assignment");
  });
  it("ignores ordinary code", () => {
    expect(findSecrets("const total = items.reduce((a, b) => a + b, 0);")).toEqual([]);
  });
});

describe("filterDiff", () => {
  const diff = [
    "diff --git a/web/src/pay.ts b/web/src/pay.ts",
    "index 1111111..2222222 100644",
    "--- a/web/src/pay.ts",
    "+++ b/web/src/pay.ts",
    "@@ -1,3 +1,4 @@",
    ' import Stripe from "stripe";',
    `+const fallbackKey = "${STRIPE}";`,
    " export const x = 1;",
    "@@ -10,2 +11,3 @@ export function pay() {",
    "   return charge();",
    "+  // retry once on network errors",
    " }",
    "diff --git a/.env.local b/.env.local",
    "index 3333333..4444444 100644",
    "--- a/.env.local",
    "+++ b/.env.local",
    "@@ -0,0 +1 @@",
    "+FOO=bar",
    "",
  ].join("\n");

  it("drops hunks with secrets and sensitive files, keeps the rest", () => {
    const out = filterDiff(diff);
    expect(out.diff).toContain("retry once on network errors");
    expect(out.diff).not.toContain(STRIPE);
    expect(out.diff).not.toContain(".env.local");
    expect(out.droppedHunks).toBe(1);
    expect(out.droppedFiles).toBe(1);
  });
});

describe("validateCard", () => {
  it("accepts a good card", () => expect(validateCard(mcq())).toEqual([]));
  it("rejects URLs", () => expect(validateCard(mcq({ explanation: "See https://example.com" }))).toContain("contains a URL"));
  it("rejects secrets", () => expect(validateCard(mcq({ question: `What is ${AWS}?` })).join()).toMatch(/secret/));
  it("rejects repeated options", () => expect(validateCard(mcq({ choices: ["a", "a", "b", "c"] }))).toContain("options repeat"));
  it("rejects explanations that name options by letter", () =>
    expect(validateCard(mcq({ explanation: "Option B is wrong because hooks run locally." }))).toContain("explanation names an option by letter"));
});

describe("rebalanceAnswers", () => {
  it("spreads correct answers across A-D and keeps each answer correct", () => {
    const cards = [0, 1, 2, 3].map((i) => ({ id: String(i), body: mcq({ choices: [`right ${i}`, "w1", "w2", "w3"] }) }));
    const out = rebalanceAnswers(cards, 1);
    const positions = out.map((c) => (c.body.kind === "mcq" ? c.body.correctChoice : -1));
    expect(new Set(positions)).toEqual(new Set([0, 1, 2, 3]));
    out.forEach((c, i) => {
      if (c.body.kind === "mcq") expect(c.body.choices[c.body.correctChoice]).toBe(`right ${i}`);
    });
  });
});
