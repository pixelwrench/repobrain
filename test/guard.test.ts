import { describe, expect, it } from "vitest";
import { filterDiff, findSecrets, rebalanceAnswers, validateCard } from "../src/guard.js";
import type { CardBody } from "../src/format.js";

// Built by concatenation so secret scanners don't flag this repo.
const AWS = "AKIA" + "Z7XQ2M4N6P8R0T1V";
const STRIPE = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc";
const PRIVATE_KEY_HEADER = "-----BEGIN RSA " + "PRIVATE KEY-----";
const PASSWORD_LINE = "pass" + 'word = "hunter2' + 'hunter2"';
const NPM = "npm_" + "A1b2C3d4E5f6G7h8I9j0" + "K1l2M3n4O5p6Q7r8";
const WHSEC = "whsec_" + "A1b2C3d4E5f6G7h8I9j0K1l2";
const PGP_HEADER = "-----BEGIN PGP " + "PRIVATE KEY BLOCK-----";
const VALUE = "s3cr3t" + "Value" + "12345";

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
  it("spots npm tokens, Stripe webhook secrets and PGP private keys", () => {
    expect(findSecrets(`//registry.npmjs.org/:_authToken=${NPM}`)).toContain("npm-token");
    expect(findSecrets(`const hook = "${WHSEC}";`)).toContain("stripe-webhook-secret");
    expect(findSecrets(PGP_HEADER)).toContain("private-key");
  });
  it("spots assignments to secret-named variables", () => {
    expect(findSecrets("DB_PASS" + `WORD = "${VALUE}"`)).toContain("assignment");
    expect(findSecrets("const clientSec" + `ret = "${VALUE}";`)).toContain("assignment");
    expect(findSecrets("aws_secret_access_" + `key = "${VALUE}"`)).toContain("assignment");
    expect(findSecrets("+  pass" + "word: correcthorse" + "battery")).toContain("assignment-unquoted");
    expect(findSecrets("API_" + "TOKEN=" + VALUE)).toContain("assignment-unquoted");
  });
  it("ignores ordinary code", () => {
    for (const line of [
      "const total = items.reduce((a, b) => a + b, 0);",
      "token = getToken()",
      "const token = req.headers.authorization",
      "  password: process.env.DB_PASSWORD",
      "  token: req.headers.authorization,",
      "const url = `postgres://${user}:${password}@${host}/app`;",
      'if (password.length < 12) throw new Error("password too short");',
      'export const API_URL = process.env.API_URL ?? "";',
      "const secret = await vault.read(name);",
    ]) {
      expect(findSecrets(line), line).toEqual([]);
    }
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
  it("rejects explanations that name options by letter", () => {
    for (const explanation of [
      "Option B is wrong because hooks run locally.",
      "B is correct.",
      "The answer is (B).",
      "Options A and C are wrong.",
      "Answer: B",
    ]) {
      expect(validateCard(mcq({ explanation })), explanation).toContain("explanation names an option by letter");
    }
  });
  it("allows ordinary uses of the word answer", () =>
    expect(validateCard(mcq({ explanation: "Hooks run locally, so they can't answer a question about remote merges." }))).toEqual([]));
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

describe("rebalanceAnswers edge cases", () => {
  it("leaves malformed cards untouched", () => {
    const three = { body: mcq({ choices: ["x", "y", "z"], correctChoice: 0 }) };
    const fractional = { body: mcq({ correctChoice: 1.5 }) };
    const outOfRange = { body: mcq({ correctChoice: 4 }) };
    const out = rebalanceAnswers([three, fractional, outOfRange], 1);
    expect(out[0]).toBe(three);
    expect(out[1]).toBe(fractional);
    expect(out[2]).toBe(outOfRange);
  });
  it("handles negative seeds", () => {
    const cards = [0, 1, 2, 3].map((i) => ({ body: mcq({ choices: [`right ${i}`, "w1", "w2", "w3"] }) }));
    const out = rebalanceAnswers(cards, -5);
    out.forEach((c, i) => {
      if (c.body.kind !== "mcq") throw new Error("expected mcq");
      expect(c.body.correctChoice).toBeGreaterThanOrEqual(0);
      expect(c.body.correctChoice).toBeLessThan(4);
      expect(c.body.choices[c.body.correctChoice]).toBe(`right ${i}`);
    });
    expect(new Set(out.map((c) => (c.body.kind === "mcq" ? c.body.correctChoice : -1)))).toEqual(new Set([0, 1, 2, 3]));
  });
});

describe("filterDiff edge cases", () => {
  const lines = (...l: string[]) => l.join("\n") + "\n";
  const envBody = "FOO=" + "bar";

  it("drops a renamed sensitive file even when the new name looks safe", () => {
    const d = lines(
      "diff --git a/.env b/defaults.txt",
      "similarity index 90%",
      "rename from .env",
      "rename to defaults.txt",
      "index 1111111..2222222 100644",
      "--- a/.env",
      "+++ b/defaults.txt",
      "@@ -1 +1,2 @@",
      ` ${envBody}`,
      "+BAZ=qux",
    );
    const out = filterDiff(d);
    expect(out.diff).toBe("");
    expect(out.droppedFiles).toBe(1);
  });

  it("drops a pure rename or copy of a sensitive file", () => {
    const rename = lines("diff --git a/.env b/config/defaults.txt", "similarity index 100%", "rename from .env", "rename to config/defaults.txt");
    const copy = lines("diff --git a/certs/a.pem b/notes.txt", "similarity index 100%", "copy from certs/a.pem", "copy to notes.txt");
    expect(filterDiff(rename)).toEqual({ diff: "", droppedHunks: 0, droppedFiles: 1 });
    expect(filterDiff(copy)).toEqual({ diff: "", droppedHunks: 0, droppedFiles: 1 });
  });

  it("keeps a safe rename", () => {
    const d = lines("diff --git a/src/old.ts b/src/new.ts", "similarity index 100%", "rename from src/old.ts", "rename to src/new.ts");
    expect(filterDiff(d)).toEqual({ diff: d, droppedHunks: 0, droppedFiles: 0 });
  });

  it("keeps a binary file but drops a sensitive binary", () => {
    const png = lines("diff --git a/img/logo.png b/img/logo.png", "index 1111111..2222222 100644", "Binary files a/img/logo.png and b/img/logo.png differ");
    const p12 = lines("diff --git a/certs/server.p12 b/certs/server.p12", "index 1111111..2222222 100644", "Binary files a/certs/server.p12 and b/certs/server.p12 differ");
    expect(filterDiff(png)).toEqual({ diff: png, droppedHunks: 0, droppedFiles: 0 });
    expect(filterDiff(p12)).toEqual({ diff: "", droppedHunks: 0, droppedFiles: 1 });
  });

  it("keeps a mode-only change but drops one on a sensitive file", () => {
    const sh = lines("diff --git a/scripts/run.sh b/scripts/run.sh", "old mode 100644", "new mode 100755");
    const env = lines("diff --git a/.env.production b/.env.production", "old mode 100644", "new mode 100600");
    expect(filterDiff(sh)).toEqual({ diff: sh, droppedHunks: 0, droppedFiles: 0 });
    expect(filterDiff(env)).toEqual({ diff: "", droppedHunks: 0, droppedFiles: 1 });
  });

  it("handles paths with spaces", () => {
    const safe = lines(
      "diff --git a/docs/my notes.md b/docs/my notes.md",
      "index 1111111..2222222 100644",
      "--- a/docs/my notes.md",
      "+++ b/docs/my notes.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    );
    const env = lines(
      "diff --git a/config dir/.env b/config dir/.env",
      "index 1111111..2222222 100644",
      "--- a/config dir/.env",
      "+++ b/config dir/.env",
      "@@ -1 +1 @@",
      `+${envBody}`,
    );
    const envModeOnly = lines("diff --git a/config dir/.env b/config dir/.env", "old mode 100644", "new mode 100600");
    expect(filterDiff(safe)).toEqual({ diff: safe, droppedHunks: 0, droppedFiles: 0 });
    expect(filterDiff(env)).toEqual({ diff: "", droppedHunks: 0, droppedFiles: 1 });
    expect(filterDiff(envModeOnly)).toEqual({ diff: "", droppedHunks: 0, droppedFiles: 1 });
  });

  it("unquotes git-quoted paths, including octal escapes", () => {
    const env = lines(
      'diff --git "a/caf\\303\\251 \\"x\\"/.env" "b/caf\\303\\251 \\"x\\"/.env"',
      "new file mode 100644",
      "index 0000000..2222222",
      "--- /dev/null",
      '+++ "b/caf\\303\\251 \\"x\\"/.env"',
      "@@ -0,0 +1 @@",
      `+${envBody}`,
    );
    const safe = lines('diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"', "old mode 100644", "new mode 100755");
    expect(filterDiff(env)).toEqual({ diff: "", droppedHunks: 0, droppedFiles: 1 });
    expect(filterDiff(safe)).toEqual({ diff: safe, droppedHunks: 0, droppedFiles: 0 });
  });

  it("fails closed when no path can be determined", () => {
    const d = lines("diff --git garbled", "old mode 100644", "new mode 100755");
    expect(filterDiff(d)).toEqual({ diff: "", droppedHunks: 0, droppedFiles: 1 });
  });

  it("keeps later hunks after a dropped one and counts correctly", () => {
    const d = lines(
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "+const first = 1;",
      "@@ -5 +5 @@",
      `+const k = "${STRIPE}";`,
      "@@ -9 +9 @@",
      "+const third = 3;",
      "@@ -20 +20 @@",
      `+const aws = "${AWS}";`,
    );
    const out = filterDiff(d);
    expect(out.diff).toContain("const first = 1;");
    expect(out.diff).toContain("const third = 3;");
    expect(out.diff).toContain("+++ b/src/a.ts");
    expect(out.diff).not.toContain(STRIPE);
    expect(out.diff).not.toContain(AWS);
    expect(out.droppedHunks).toBe(2);
    expect(out.droppedFiles).toBe(0);
  });

  it("drops newly sensitive file types", () => {
    for (const p of [".npmrc", "home/.netrc", ".pypirc", ".pgpass", "keys/AuthKey.p8", "app/release.jks", "android/app.keystore", "credentials.json", "gcp/service-account-prod.json", "infra/terraform.tfstate"]) {
      const d = lines(`diff --git a/${p} b/${p}`, "old mode 100644", "new mode 100600");
      expect(filterDiff(d).droppedFiles, p).toBe(1);
    }
  });
});
