---
description: Go through draft CodeBrain cards and keep, fix or drop each one
allowed-tools: Bash(codebrain *), Read, Edit(~/.codebrain/**)
---
If `codebrain` isn't found, say the plugin's CLI isn't built or installed (run `npm run build` in the plugin's folder) and stop. Every `codebrain` command prints JSON; on a non-zero exit it carries an `error` field.

Run `codebrain week`. If it fails, show the error and stop; if it says the repository isn't connected, suggest `/codebrain:connect`.

Report problems first:
- `claudeUnavailable`: new merges aren't being drafted; claude has been unavailable since `since`. Show `message` and suggest checking that `claude` is installed and logged in.
- `lastCaptureError`: the last capture run failed unexpectedly at `at` (a git error, say), so new merges may not be drafted. Show `message`. If it mentions a pathspec or `.codebrain/ignore`, suggest checking that file's lines: one git glob per line, no `!` lines. It clears once a capture completes.
- `stateError`: CodeBrain's state file for this repository is corrupt, so new merges aren't being drafted. Show the message. The fix is to delete exactly the file it names; the next capture then restarts from the default branch's current head, so merges since the last capture never become cards. Say so plainly, and delete it only if the user says yes.
- `unreadable`: these card files can't be read and are left out. List each `file` and `error`, and offer to repair them (see below).

If `drafts` and `flagged` are both 0, say so in one line and stop.

Otherwise go area by area (the keys of `areas`), change by change (each group's `title`). For each change, give one or two sentences on what it did, from its title and cards. Then show its cards one at a time: for multiple choice (`body.kind: "mcq"`) the question, choices A-D with `body.correct` marked, and the explanation; for a flashcard the front and back. Ask: keep, fix or drop?
- keep: `codebrain curate <id> keep`
- drop: `codebrain curate <id> drop`
- fix: ask what to change, unless the user already said. Get the file with `codebrain card <id>`, Read it, and Edit only the labelled lines after the front matter (`Q:`, `A:`-`D:`, `Correct:` as one letter, `Explanation:`, or `Front:`, `Back:`). Never edit the front matter. Keep each label's text on one line; a wrapped line must never start with a label such as `A:`. Then run `codebrain curate <id> fix`.

## Flagged cards (`status: "kept"`)

- `anchor: "changed"`: run `codebrain show <id>`, show `atCommit.lines` (the code the card was written against) next to `atHead.lines` (the code on the default branch now), and say whether the card still holds. If `atHead.symbolFound` is false, say the code shown from the default branch is the same line range, not located by symbol, so it may not be the same code. Then ask keep, fix or drop. Keep and fix re-anchor the card: when curate returns `reanchored: true`, tell the user it now points at `path` lines `startLine`-`endLine` so they can check; if they say that's the wrong code, re-point it (below). If curate says it can't re-anchor, re-point it (below) or drop it.
- `anchor: "orphaned"`: the code was removed. Drop it, or re-point it if the code moved.

To re-point: find where the code now lives on the default branch, confirm the file and lines with the user, then run `codebrain curate <id> fix --path P --lines S-E`, adding `--symbol X` if the symbol was renamed or `--no-symbol` if it no longer has one. If the card text also needs fixing, Edit the text first (as above, without running `curate <id> fix` on its own), then run the single re-point command.

## Repairing a card file

If curate exits 1 with `unreadable: true`, or `week` listed an `unreadable` file, Read that file, fix the labelled lines after the front matter, and run `codebrain week` again.

If curate fails for any other reason, show its `error` and go on to the next card.

Don't quiz the user here. End with how many cards were kept, fixed and dropped.
