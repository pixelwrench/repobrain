import path from "node:path";
import { createEmptyCard, fsrs, generatorParameters, Rating, type Card as FsrsCard } from "ts-fsrs";
import type { Card } from "./format.js";
import { appendJsonl, readJson, repoDir, writeFileAtomic } from "./store.js";

// FSRS-6 (the ts-fsrs 6 default, 21 parameters) with whole-day intervals:
// no fuzz and no same-day learning steps, because reviews happen when the user asks.
const scheduler = fsrs(generatorParameters({ enable_fuzz: false, enable_short_term: false }));

export type Grade = "right" | "wrong" | "didnt-know";

type Stored = Omit<FsrsCard, "due" | "last_review"> & { due: string; last_review?: string };

const revive = (s: Stored): FsrsCard => ({ ...s, due: new Date(s.due), last_review: s.last_review ? new Date(s.last_review) : undefined });
const toStored = (c: FsrsCard): Stored => ({ ...c, due: c.due.toISOString(), last_review: c.last_review?.toISOString() });

/** Right maps to Good and anything else to Again: FSRS works with pass/fail grading. */
export function nextState(current: FsrsCard | undefined, grade: Grade, now: Date): FsrsCard {
  const rating = grade === "right" ? Rating.Good : Rating.Again;
  return scheduler.next(current ?? createEmptyCard(now), now, rating).card;
}

const schedulePath = (key: string): string => path.join(repoDir(key), "schedule.json");

/** A missing schedule is empty; a corrupt one throws rather than silently losing review history. */
export function loadSchedule(key: string): Record<string, FsrsCard> {
  const raw = readJson<Record<string, Stored>>(schedulePath(key), {});
  return Object.fromEntries(Object.entries(raw).map(([id, s]) => [id, revive(s)]));
}

function saveSchedule(key: string, sched: Record<string, FsrsCard>): void {
  const stored = Object.fromEntries(Object.entries(sched).map(([id, c]) => [id, toStored(c)]));
  writeFileAtomic(schedulePath(key), JSON.stringify(stored, null, 2) + "\n");
}

export function recordGrade(key: string, cardId: string, grade: Grade, now: Date): FsrsCard {
  const sched = loadSchedule(key);
  const next = nextState(sched[cardId], grade, now);
  sched[cardId] = next;
  saveSchedule(key, sched);
  appendJsonl(key, "reviews.jsonl", { card: cardId, grade, at: now.toISOString(), due: next.due.toISOString() });
  return next;
}

/** Kept cards that are new or due, most overdue first. Orphaned cards are never quizzed. */
export function dueCards(cards: Card[], sched: Record<string, FsrsCard>, now: Date): Card[] {
  return cards
    .filter((c) => c.status === "kept" && c.anchor.status !== "orphaned")
    .filter((c) => !sched[c.id] || sched[c.id].due <= now)
    .sort((a, b) => (sched[a.id]?.due.getTime() ?? 0) - (sched[b.id]?.due.getTime() ?? 0));
}
