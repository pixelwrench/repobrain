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

/** Each tool's input, strict, so an extra or misspelt field fails a test too. */
export const toolInputs: Record<string, z.ZodType> = {
  link_repo: linkRepoInput.strict(),
  submit_cards: submitCardsInput.extend({ cards: z.array(submittedCard.strict()).max(20) }).strict(),
  update_anchors: updateAnchorsInput.strict(),
};
