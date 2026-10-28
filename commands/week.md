---
description: Go through draft CodeBrain cards and keep, fix or drop each one
allowed-tools: Bash(codebrain *), Read, Edit
---
Run `codebrain week` and read its JSON. Every `codebrain` command prints JSON; on a non-zero exit it carries an `error` field.

First, report problems before any cards:
- `claudeUnavailable` (not null): new merges aren't being drafted, because claude has been unavailable since `claudeUnavailable.since`. Show `claudeUnavailable.message` and suggest checking that `claude` is installed and logged in.
- `stateError` (not null): CodeBrain's state file for this repository is corrupt, so new merges aren't being drafted. Show the message; it names the file, `~/.codebrain/repos/<key>/state.json` (under `$CODEBRAIN_HOME` instead when that is set). The fix is to delete that file: the next capture then restarts from the current head of the default branch, so merges since the last capture are skipped and never become cards. Say so plainly and ask before deleting anything; delete it only if the user says yes. Cards, reviews and curation history are kept.
- `unreadable` (not empty): these card files can't be read, so they're left out below. List each `file` with its `error`, and offer to fix each one now (see "Repairing a card file").

If `drafts` and `flagged` are both 0, say so in one line (after any problems above) and stop.

Otherwise go area by area (the keys of `areas`), change by change (each group's `merge` and `title`). For each change, give one or two sentences on what it did, from its title and its cards. Then show its cards one at a time:
- Multiple choice (`body.kind: "mcq"`): the question and the four choices labelled A-D, with the correct one (`body.correct`) marked, and the explanation.
- Flashcard (`body.kind: "flashcard"`): the front and the back.

Then ask: keep, fix or drop?
- keep: `codebrain curate <id> keep`
- drop: `codebrain curate <id> drop`
- fix: ask what to change. Get the card's file with `codebrain card <id>` (its `path`), Read it, and Edit only the card text after the front matter (the second `---` line). Never change the front matter. Keep the labelled lines: `Q:`, `A:` to `D:`, `Correct:` (a single letter A-D) and `Explanation:` for multiple choice, or `Front:` and `Back:` for a flashcard. Write each label's text on one line; if a value does wrap, never start the wrapped line with a label such as `A:`, because it would be read as a new field. Then run `codebrain curate <id> fix`.

## Flagged cards

A card with `status: "kept"` is in the list because its code moved on since the card was kept:
- `anchor: "changed"`: the code at `path` has changed. Before asking keep, fix or drop, show the user the current code: get the card's file with `codebrain card <id>` and Read it for `anchor_start` and `anchor_end` in the front matter, then Read the file at `path` (relative to the repository root; this is the working copy, so if the current branch isn't the default branch, say so) around those lines, and say whether the card still holds. Keep and fix both re-anchor the card to the code on the default branch: when the curate output has `reanchored: true`, tell the user the card now points at `path` lines `startLine`-`endLine` so they can check it's the right code. If curate fails with "can't re-anchor", the code it described is gone, or its symbol was renamed or moved to another file: offer fix or drop. Rewriting only the card text won't help, because `curate fix` re-anchors the same way. To fix, find where the code now lives on the default branch, ask the user to confirm it, then Edit the card's front matter to point there: `anchor_path` (a JSON string), `anchor_start` and `anchor_end` (line numbers) and `anchor_symbol` (the new name as a JSON string, or `null`), and update the card text if it no longer matches. Change nothing else in the front matter. Then run `codebrain curate <id> fix`.
- `anchor: "orphaned"`: the code was removed. Explain that and offer only drop (`codebrain curate <id> drop`); keep fails on an orphaned card.

## Repairing a card file

If `codebrain curate` exits 1 with `unreadable: true`, the edit broke the card: tell the user the `reason`, Read the file at `path`, fix the card text (the labelled lines above; leave the front matter alone unless the `reason` points there), and run the same `codebrain curate <id> <decision>` again. For an `unreadable` file from `codebrain week`, do the same; the card id is the file name without `.md`.

## Other errors

If curate fails for any other reason, show its `error` and move on to the next card.

Don't quiz the user here. End with how many cards were kept, fixed and dropped.
