import * as z from "zod/v4";

// Copies of the site's tool inputs (the repo-sync contract), so the fake remote refuses anything the site would.
// Keep these in step with the site's schemas.

export const repoKey = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);
export const sha = z.string().regex(/^[0-9a-f]{7,64}$/);

export const linkRepoInput = z.object({ key: repoKey, name: z.string().trim().min(1).max(100) });

const anchor = z.object({
  commit: sha,
  path: z.string().min(1).max(500),
  symbol: z.string().max(200).nullable(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  fingerprint: z.string().min(8).max(128),
  status: z.enum(["fresh", "changed", "orphaned"]),
});

const body = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mcq"), question: z.string().min(1).max(1200), choices: z.array(z.string().min(1).max(400)).min(2).max(6),
    correctChoice: z.number().int().min(0), explanation: z.string().min(1).max(1200),
  }),
  z.object({ kind: z.literal("flashcard"), front: z.string().min(1).max(1200), back: z.string().min(1).max(1200) }),
]);

export const submittedCard = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/),
  area: z.string().max(200),
  status: z.enum(["draft", "kept", "dropped"]),
  body,
  anchor,
});

export const submitCardsInput = z.object({
  repo: repoKey,
  merge: sha,
  mergeTitle: z.string().min(1).max(300),
  source: z.enum(["merge", "baseline"]),
  cards: z.array(submittedCard).max(20),
});

export const updateAnchorsInput = z.object({
  repo: repoKey,
  anchors: z
    .array(z.object({ id: submittedCard.shape.id, status: anchor.shape.status, startLine: z.number().int().min(1), endLine: z.number().int().min(1) }))
    .max(2000),
});

export const getWeekInput = z.object({ repo: repoKey });
export const curateCardInput = z.object({
  repo: repoKey,
  id: submittedCard.shape.id,
  decision: z.enum(["keep", "fix", "drop"]),
  // Only with "fix": the corrected card. Same shape as a submitted body.
  body: body.optional(),
});

// The site's existing quiz tools (web/src/server/mcp/tools.ts).
export const getDueCardsInput = z.object({ deckId: z.string().min(1).optional() });
export const getDeckInput = z.object({ deckId: z.string().min(1), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional() });
export const recordQuizResultsInput = z.object({
  deckId: z.string().min(1),
  outcomes: z.array(z.object({ cardId: z.string().min(1), correct: z.boolean() })).min(1).max(500),
});

const strictBody = z.discriminatedUnion("kind", [body.options[0].strict(), body.options[1].strict()]);

/** Each tool's input, strict, so an extra or misspelt field fails a test too. */
export const toolInputs: Record<string, z.ZodType> = {
  link_repo: linkRepoInput.strict(),
  submit_cards: submitCardsInput.extend({ cards: z.array(submittedCard.strict()).max(20) }).strict(),
  update_anchors: updateAnchorsInput.strict(),
  get_week: getWeekInput.strict(),
  curate_card: curateCardInput.extend({ body: strictBody.optional() }).strict(),
  get_due_cards: getDueCardsInput.strict(),
  get_deck: getDeckInput.strict(),
  record_quiz_results: recordQuizResultsInput.extend({ outcomes: z.array(recordQuizResultsInput.shape.outcomes.element.strict()).min(1).max(500) }).strict(),
};

// ---- Outputs: what the site's quiz tools return (cardForMcp in web/src/server/mcp/tools.ts). ----

/** A repo card's link back to the plugin: its card id and the site's copy of its anchor. */
const repoCard = z.object({ id: submittedCard.shape.id, path: z.string(), startLine: z.number().int(), endLine: z.number().int(), status: anchor.shape.status }).strict();

export const mcpCard = z.union([
  z.object({
    id: z.string(), kind: z.literal("MULTIPLE_CHOICE"), term: z.string(), definition: z.string(), choices: z.array(z.string()),
    explanation: z.string().nullable(), repoCard: repoCard.optional(),
  }).strict(),
  z.object({ id: z.string(), term: z.string(), definition: z.string(), repoCard: repoCard.optional() }).strict(),
]);

/** Each tool's output, where the plugin reads it, so a fake answer the site couldn't give fails a test. */
export const toolOutputs: Record<string, z.ZodType> = {
  get_due_cards: z.union([
    z.object({ deckId: z.string(), cards: z.array(mcpCard) }),
    z.object({ deckId: z.string(), locked: z.literal(true), message: z.string(), cards: z.array(mcpCard).max(0) }),
  ]),
  get_deck: z.object({ id: z.string(), cards: z.array(mcpCard), nextOffset: z.number().int().nullable() }),
  record_quiz_results: z.object({ recorded: z.number().int(), correct: z.number().int(), skipped: z.array(z.string()), streakDays: z.number().int() }).strict(),
};
