import type { CallOptions, Remote } from "../src/remote.js";
import { RemoteError } from "../src/remote.js";
import type { SubmitCardsInput } from "../src/sync.js";
import { toolInputs } from "./site-contract.js";

export interface FakeRemote extends Remote {
  calls: { tool: string; args: Record<string, unknown>; opts?: CallOptions }[];
}

export interface FakeRemoteOptions {
  /** Card ids submit_cards rejects. */
  reject?: Set<string>;
  /** A failure to throw for a tool call, or null to answer it. */
  fail?: (tool: string) => RemoteError | null;
  /** How long each call takes; an aborted signal ends the wait, as the real client does. */
  delayMs?: number;
  /** Answers for tools, by name, overriding the defaults below. */
  answers?: Record<string, (args: Record<string, unknown>) => unknown>;
}

/** An empty week as the site's get_week returns it. */
export const emptySiteWeek = () => ({
  drafts: 0, flagged: 0, areas: {}, unreadable: [], claudeUnavailable: null, lastCaptureError: null, stateError: null, lesson: null,
});

/**
 * A Remote that records its calls and checks each one against the site's contract (a schema failure throws,
 * as the site would refuse it); submit_cards accepts every card unless `reject` names it.
 */
export function fakeRemote(opts: FakeRemoteOptions = {}): FakeRemote {
  const calls: FakeRemote["calls"] = [];
  return {
    calls,
    async call<T>(tool: string, args: Record<string, unknown>, callOpts?: CallOptions): Promise<T> {
      calls.push({ tool, args: structuredClone(args), opts: callOpts });
      const schema = toolInputs[tool];
      if (!schema) throw new RemoteError(`unknown tool ${tool}`, "tool");
      const parsed = schema.safeParse(args);
      if (!parsed.success) throw new Error(`${tool} input breaks the site's contract: ${parsed.error.message}`);
      if (opts.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, opts.delayMs);
          callOpts?.signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new RemoteError("aborted", "network"))), { once: true });
        });
      }
      const failure = opts.fail?.(tool);
      if (failure) throw failure;
      const answer = opts.answers?.[tool];
      if (answer) return answer(args) as T;
      if (tool === "get_week") return emptySiteWeek() as T;
      if (tool === "curate_card") return { id: args.id, curation: args.decision === "drop" ? "dropped" : "kept" } as T;
      if (tool === "get_due_cards") return { deckId: args.deckId, cards: [] } as T;
      if (tool === "get_deck") return { id: args.deckId, cardCount: 0, cards: [], nextOffset: null } as T;
      if (tool === "record_quiz_results") {
        const outcomes = args.outcomes as { correct: boolean }[];
        return { recorded: outcomes.length, correct: outcomes.filter((o) => o.correct).length, streakDays: 1 } as T;
      }
      if (tool === "link_repo") return { repoId: "repo-1", deckId: "deck-1", created: true } as T;
      if (tool === "submit_cards") {
        const ids = (args as unknown as SubmitCardsInput).cards.map((c) => c.id);
        return {
          accepted: ids.filter((id) => !opts.reject?.has(id)),
          unchanged: [],
          rejected: ids.filter((id) => opts.reject?.has(id)).map((id) => ({ id, reason: "looks like a secret" })),
        } as T;
      }
      return { updated: (args.anchors as unknown[]).length } as T;
    },
    close: async () => {},
  };
}

export const submits = (r: FakeRemote): SubmitCardsInput[] =>
  r.calls.filter((c) => c.tool === "submit_cards").map((c) => c.args as unknown as SubmitCardsInput);

export const callsTo = (r: FakeRemote, tool: string) => r.calls.filter((c) => c.tool === tool).map((c) => c.args);

export const anchorPushes = (r: FakeRemote) =>
  r.calls.filter((c) => c.tool === "update_anchors").map((c) => c.args as { repo: string; anchors: { id: string; status: string; startLine: number; endLine: number }[] });
