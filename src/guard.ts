import type { CardBody } from "./format.js";

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "aws-access-key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/ },
  { name: "github-token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: "stripe-key", re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "stripe-webhook-secret", re: /\bwhsec_[A-Za-z0-9]{24,}\b/ },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "openai-key", re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    name: "assignment",
    re: /[A-Za-z0-9_-]*(api[_-]?key|secret|token|passw(or)?d|pwd|credential)[A-Za-z0-9_-]*["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i,
  },
  {
    // Unquoted values (.env, YAML). Values that look like code (calls, templates,
    // trailing , or ;, dotted property paths) are not flagged.
    name: "assignment-unquoted",
    re: /^[+\- ]?\s*[A-Za-z0-9_]*(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY)[A-Za-z0-9_]*\s*[:=]\s*(?![A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+\s*$)[^\s"'`${}(),;]{12,}\s*$/im,
  },
  // $ { } excluded from the password so templated URLs aren't flagged.
  { name: "connection-string", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/${}]{6,}@/i },
];

export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

const SENSITIVE_PATH =
  /(^|\/)(\.env[^/]*|\.npmrc|\.netrc|\.pypirc|\.pgpass|credentials\.json|service-account[^/]*\.json|[^/]*\.(pem|key|p12|pfx|p8|jks|keystore|tfstate)|id_(rsa|ed25519|ecdsa)[^/]*)$/;

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** Undoes git's C-style path quoting ("caf\303\251" -> "café"). */
function unquote(s: string): string {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const bytes: number[] = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[i + 1] ?? "";
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += 3;
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Every path a file section mentions: diff --git, rename/copy, and ---/+++ lines. */
function sectionPaths(header: string): string[] {
  const paths: string[] = [];
  const stripPrefix = (p: string) => p.replace(/^[ab]\//, "");
  const lines = header.split("\n");
  const git = lines[0]!.slice("diff --git ".length);
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(git);
  if (quoted && (quoted[1]!.startsWith('"') || quoted[2]!.startsWith('"') || /^a\//.test(quoted[1]!))) {
    paths.push(stripPrefix(unquote(quoted[1]!)), stripPrefix(unquote(quoted[2]!)));
  } else if (git.startsWith("a/")) {
    // Unquoted paths with spaces: when both sides are the same path, split in half.
    const half = (git.length - 1) / 2;
    if (Number.isInteger(half) && git[half] === " " && git.slice(half + 1).startsWith("b/") && git.slice(2, half) === git.slice(half + 3)) {
      paths.push(git.slice(2, half));
    }
  }
  for (const line of lines.slice(1)) {
    const m = /^(rename from|rename to|copy from|copy to|---|\+\+\+) (.+)$/.exec(line);
    if (!m) continue;
    let p = unquote(m[2]!.replace(/\t$/, ""));
    if (m[1] === "---" || m[1] === "+++") {
      if (p === "/dev/null") continue;
      p = stripPrefix(p);
    }
    paths.push(p);
  }
  return paths.filter((p) => p.length > 0);
}

export interface FilteredDiff {
  diff: string;
  droppedHunks: number;
  droppedFiles: number;
}

/** Removes sensitive files and any hunk containing a secret before the diff reaches a model. */
export function filterDiff(diff: string): FilteredDiff {
  let droppedHunks = 0;
  let droppedFiles = 0;
  const kept: string[] = [];
  for (const file of diff.split(/^(?=diff --git )/m).filter((s) => s.length > 0)) {
    const [header = "", ...hunks] = file.split(/^(?=@@ )/m);
    const paths = file.startsWith("diff --git ") ? sectionPaths(header) : [];
    // Fail closed: no path we can check means we can't tell it's safe.
    if (paths.length === 0 || paths.some((p) => SENSITIVE_PATH.test(p)) || findSecrets(header).length > 0) {
      droppedFiles++;
      continue;
    }
    const safe = hunks.filter((h) => {
      const bad = findSecrets(h).length > 0;
      if (bad) droppedHunks++;
      return !bad;
    });
    if (hunks.length > 0 && safe.length === 0) {
      droppedFiles++;
      continue;
    }
    kept.push(header + safe.join(""));
  }
  return { diff: kept.join(""), droppedHunks, droppedFiles };
}

const URL_RE = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\./i;
// Case-sensitive letter so "answer a question" isn't flagged.
const LETTER_REF = /\b([Oo]ptions?|[Aa]nswer|[Cc]hoices?)[\s:]+[A-D]\b|\([A-D]\)|\b[A-D]\)\s|\b[A-D] is (the )?(correct|right|wrong)/;

export function cardText(body: CardBody): string {
  return body.kind === "mcq" ? [body.question, ...body.choices, body.explanation].join("\n") : `${body.front}\n${body.back}`;
}

/** Problems that disqualify a drafted card; empty when the card is usable. */
export function validateCard(body: CardBody): string[] {
  const problems: string[] = [];
  const text = cardText(body);
  if (URL_RE.test(text)) problems.push("contains a URL");
  const secrets = findSecrets(text);
  if (secrets.length > 0) problems.push(`contains a secret (${secrets.join(", ")})`);
  if (text.length > 1200) problems.push("too long");
  if (body.kind === "mcq") {
    if (!body.question.trim()) problems.push("empty question");
    if (body.choices.length !== 4 || body.choices.some((c) => !c.trim())) problems.push("needs four non-empty options");
    if (new Set(body.choices.map((c) => c.trim().toLowerCase())).size !== body.choices.length) problems.push("options repeat");
    if (!(body.correctChoice >= 0 && body.correctChoice < body.choices.length)) problems.push("correct option out of range");
    if (!body.explanation.trim()) problems.push("no explanation");
    if (LETTER_REF.test(body.explanation)) problems.push("explanation names an option by letter");
  } else if (!body.front.trim() || !body.back.trim()) {
    problems.push("empty side");
  }
  return problems;
}

/**
 * Spreads correct answers evenly across A-D within a batch. LLM-written
 * multiple-choice questions cluster on one letter (braineos-issues#91).
 */
export function rebalanceAnswers<T extends { body: CardBody }>(cards: T[], seed: number): T[] {
  let n = 0;
  return cards.map((card) => {
    const b = card.body;
    if (b.kind !== "mcq" || b.choices.length !== 4 || !Number.isInteger(b.correctChoice) || b.correctChoice < 0 || b.correctChoice > 3) {
      return card;
    }
    const target = (((seed + n++) % 4) + 4) % 4;
    const choices = [...b.choices];
    [choices[b.correctChoice], choices[target]] = [choices[target], choices[b.correctChoice]];
    return { ...card, body: { ...b, choices, correctChoice: target } };
  });
}
