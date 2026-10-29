import { RemoteError, type Remote } from "../src/remote.js";
import type { SubmitCardsInput } from "../src/sync.js";

export interface FakeRemote extends Remote {
  calls: { tool: string; args: Record<string, unknown> }[];
}

/** A Remote that records its calls; submit_cards accepts every card unless `reject` names it. */
export function fakeRemote(opts: { reject?: Set<string>; fail?: (tool: string) => RemoteError | null } = {}): FakeRemote {
  const calls: FakeRemote["calls"] = [];
  return {
    calls,
    async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ tool, args: structuredClone(args) });
      const failure = opts.fail?.(tool);
      if (failure) throw failure;
      if (tool === "link_repo") return { repoId: "repo-1", deckId: "deck-1", created: true } as T;
      if (tool === "submit_cards") {
        const ids = (args as unknown as SubmitCardsInput).cards.map((c) => c.id);
        return {
          accepted: ids.filter((id) => !opts.reject?.has(id)),
          unchanged: [],
          rejected: ids.filter((id) => opts.reject?.has(id)).map((id) => ({ id, reason: "looks like a secret" })),
        } as T;
      }
      if (tool === "update_anchors") return { updated: (args.anchors as unknown[]).length } as T;
      throw new RemoteError(`unknown tool ${tool}`, "tool");
    },
    close: async () => {},
  };
}

export const submits = (r: FakeRemote): SubmitCardsInput[] =>
  r.calls.filter((c) => c.tool === "submit_cards").map((c) => c.args as unknown as SubmitCardsInput);
