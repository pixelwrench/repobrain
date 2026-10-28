/**
 * The card file format: JSON-valued front matter plus a body in the content
 * vaults' question syntax (Q:/A:-D:/Correct:/Explanation: or Front:/Back:),
 * so the braineos vault importer can read cards later.
 */

export const CARD_STATUSES = ["draft", "kept", "dropped"] as const;
export const ANCHOR_STATUSES = ["fresh", "changed", "orphaned"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];
export type AnchorStatus = (typeof ANCHOR_STATUSES)[number];

export interface Anchor {
  commit: string;
  path: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  /** Non-blank lines in the anchored block, after normalising. */
  lines: number;
  fingerprint: string;
  status: AnchorStatus;
}

export type CardBody =
  | { kind: "mcq"; question: string; choices: string[]; correctChoice: number; explanation: string }
  | { kind: "flashcard"; front: string; back: string };

export interface Card {
  id: string;
  repo: string;
  merge: string;
  mergeTitle: string;
  area: string;
  createdAt: string;
  status: CardStatus;
  anchor: Anchor;
  body: CardBody;
}

export class CardFormatError extends Error {}

export const LETTERS = ["A", "B", "C", "D"];

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function serializeCard(card: Card): string {
  const a = card.anchor;
  const meta: Record<string, unknown> = {
    id: card.id, repo: card.repo, merge: card.merge, merge_title: card.mergeTitle, area: card.area,
    created_at: card.createdAt, status: card.status,
    anchor_commit: a.commit, anchor_path: a.path, anchor_symbol: a.symbol, anchor_start: a.startLine,
    anchor_end: a.endLine, anchor_lines: a.lines, anchor_fingerprint: a.fingerprint, anchor_status: a.status,
  };
  const front = Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
  const b = card.body;
  if (b.kind === "mcq") {
    if (b.choices.length !== LETTERS.length) throw new CardFormatError("a multiple-choice card needs exactly 4 choices");
    if (!Number.isInteger(b.correctChoice) || b.correctChoice < 0 || b.correctChoice >= LETTERS.length) {
      throw new CardFormatError("correctChoice must be 0-3");
    }
  }
  const body =
    b.kind === "mcq"
      ? [
          `Q: ${oneLine(b.question)}`,
          ...b.choices.map((c, i) => `${LETTERS[i]}: ${oneLine(c)}`),
          `Correct: ${LETTERS[b.correctChoice]}`,
          `Explanation: ${oneLine(b.explanation)}`,
        ].join("\n")
      : [`Front: ${oneLine(b.front)}`, `Back: ${oneLine(b.back)}`].join("\n");
  return `---\n${front}\n---\n\n${body}\n`;
}

export function parseCard(text: string): Card {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new CardFormatError("missing front matter");
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(": ");
    if (i < 0) continue;
    try {
      meta[line.slice(0, i)] = JSON.parse(line.slice(i + 2));
    } catch {
      throw new CardFormatError(`bad value for ${line.slice(0, i)}`);
    }
  }
  const fields = new Map<string, string>();
  let last: string | null = null;
  for (const line of m[2].split("\n")) {
    const f = /^(Q|A|B|C|D|Correct|Explanation|Front|Back):\s?(.*)$/.exec(line);
    if (f) {
      last = f[1];
      fields.set(last, f[2].trim());
    } else if (last !== null && line.trim() !== "") {
      // A wrapped line continues the last label's value.
      fields.set(last, [fields.get(last), line.trim()].filter(Boolean).join(" "));
    }
  }
  let body: CardBody;
  if (fields.has("Q")) {
    const choices = LETTERS.map((l) => fields.get(l));
    if (choices.some((c) => !c)) throw new CardFormatError("a multiple-choice card needs options A-D");
    const correctChoice = LETTERS.indexOf((fields.get("Correct") ?? "").toUpperCase());
    if (correctChoice < 0) throw new CardFormatError("Correct must be A, B, C or D");
    body = { kind: "mcq", question: fields.get("Q")!, choices: choices as string[], correctChoice, explanation: fields.get("Explanation") ?? "" };
  } else if (fields.has("Front") && fields.has("Back")) {
    body = { kind: "flashcard", front: fields.get("Front")!, back: fields.get("Back")! };
  } else {
    throw new CardFormatError("no Q: or Front:/Back: block");
  }
  const str = (k: string): string => {
    const v = meta[k];
    if (typeof v !== "string") throw new CardFormatError(`missing ${k}`);
    return v;
  };
  const num = (k: string): number => {
    const v = meta[k];
    if (typeof v !== "number") throw new CardFormatError(`missing ${k}`);
    return v;
  };
  const oneOf = <T extends string>(k: string, allowed: readonly T[]): T => {
    const v = str(k);
    if (!(allowed as readonly string[]).includes(v)) throw new CardFormatError(`${k} must be one of ${allowed.join(", ")}`);
    return v as T;
  };
  return {
    id: str("id"), repo: str("repo"), merge: str("merge"), mergeTitle: str("merge_title"), area: str("area"),
    createdAt: str("created_at"), status: oneOf("status", CARD_STATUSES),
    anchor: {
      commit: str("anchor_commit"), path: str("anchor_path"),
      symbol: typeof meta.anchor_symbol === "string" ? meta.anchor_symbol : null,
      startLine: num("anchor_start"), endLine: num("anchor_end"), lines: num("anchor_lines"),
      fingerprint: str("anchor_fingerprint"), status: oneOf("anchor_status", ANCHOR_STATUSES),
    },
    body,
  };
}

/** The first `depth` directories of a path, or "(root)" for a top-level file. */
export function areaOf(path: string, depth: number): string {
  const dirs = path.split("/").slice(0, -1);
  return dirs.length === 0 ? "(root)" : dirs.slice(0, depth).join("/");
}
