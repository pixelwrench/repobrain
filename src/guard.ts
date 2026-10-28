import type { CardBody } from "./format.js";

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "aws-access-key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "github-token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: "stripe-key", re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "openai-key", re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "assignment", re: /\b(api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i },
  { name: "connection-string", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{6,}@/i },
];

export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

const SENSITIVE_PATH = /(^|\/)(\.env[^/]*|[^/]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)[^/]*)$/;

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
    const path = /^diff --git a\/(\S+) b\/(\S+)/.exec(file)?.[2] ?? "";
    const [header, ...hunks] = file.split(/^(?=@@ )/m);
    if (SENSITIVE_PATH.test(path) || findSecrets(header).length > 0) {
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
const LETTER_REF = /\b([Oo]ption|[Aa]nswer|[Cc]hoice)\s+[A-D]\b|\b[A-D]\)\s/;

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
    if (b.kind !== "mcq") return card;
    const target = (seed + n++) % 4;
    const choices = [...b.choices];
    [choices[b.correctChoice], choices[target]] = [choices[target], choices[b.correctChoice]];
    return { ...card, body: { ...b, choices, correctChoice: target } };
  });
}
