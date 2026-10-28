---
description: Connect this repository to CodeBrain so merged changes become review cards
allowed-tools: Bash(codebrain *)
---
Run `codebrain connect` in the current repository and report the result. Every `codebrain` command prints JSON; on a non-zero exit it carries an `error` field: tell the user the error and stop.

Then explain in two sentences: from now on, whenever a Claude Code session starts here, CodeBrain uses your own Claude in the background to draft a few cards from new merges on the default branch; your code is never sent anywhere else. `/codebrain:week` is where you keep, fix or drop them, and `/codebrain:review` quizzes you.

Ask whether to draft cards for the last week now. If yes, say it may take a minute or two, then run `codebrain capture --since "7 days ago" --max 5` and report from its JSON:
- `status: "done"`: how many merges were processed (`processed`), how many cards were written (`cardsWritten`) and how many merges were skipped (`skipped`). If nothing was processed and this repository was connected before, say capture only drafts merges since it last ran.
- `status: "locked"`: another capture is already running here; its cards will show up in `/codebrain:week`.
- `status: "initialized"`: nothing was drafted; capture starts from the latest merge, and new merges from now on become cards.
- `status: "failed"`: show the `error`. If it says claude is missing, logged out, offline or rate-limited, say capture will try again at the next session start.

If the user says no, say that new merges from now on will be drafted automatically.
