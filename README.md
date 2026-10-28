# CodeBrain

Remember the code your AI agents write. CodeBrain is a Claude Code plugin and a small TypeScript CLI. When a change is merged into your default branch, your own Claude drafts a few spaced-repetition cards about it: why the code is the way it is, where behaviour lives, and what breaks if it changes. Once a week you keep, fix or drop the drafts in `/codebrain:week`, and `/codebrain:review` quizzes you on the ones you kept. Scheduling uses FSRS-6.

**Your code never leaves your machine except to your own Claude, which drafts the cards.** In practice: the merge's secret-filtered diff and its one-line title go through your own `claude` CLI to Anthropic, or to whichever provider your `claude` is set up to use, and nowhere else. CodeBrain has no server, no account and no telemetry. Cards, review history and scores are plain files in `~/.codebrain`.

## Requirements

- **Node 24 or later, as the `node` on your PATH.** The SessionStart hook and the `codebrain` shim both run whichever `node` comes first on PATH in the shell Claude Code starts from. If you use nvm or similar, check `node --version` there.
- macOS or Linux.
- The Claude Code CLI (`claude`), installed and logged in.
- git.

## Install

A public plugin listing will come later. For now, install from a local checkout:

```sh
git clone <this repository> codebrain
cd codebrain
npm install && npm run build
claude plugin marketplace add "$PWD"
claude plugin install codebrain@codebrain-local
```

Then open Claude Code in a repository you want cards for and run `/codebrain:connect`. It offers to draft cards for the last week's merges straight away.

## How capture works

1. **When it runs.** The plugin's SessionStart hook runs when a session starts, resumes or clears. It does nothing unless the session's folder is inside a connected repository or one of its git worktrees. Worktrees share the main repository's cards. In a connected repository it starts `codebrain capture` in the background and returns at once, so the session isn't held up.
2. **What it picks up.** Capture runs `git fetch origin` quietly (ssh in batch mode, unless you set your own `GIT_SSH_COMMAND` or `core.sshCommand`), then finds the default branch: origin's default branch, else `origin/main` or `origin/master`, else a local `main`, `master` or your `init.defaultBranch`, else the checked-out branch. It takes the first-parent commits on that branch since it last ran, so each merge counts once, at most 5 per run. The rest wait for the next session. On the very first run it only records where the branch is, unless you pass `--since`.
3. **The diff.** For each merge, it takes the diff against the first parent. It leaves out lockfiles, minified files, source maps, snapshots, `dist/`, `build/`, `vendor/`, `node_modules/`, `.env*`, `*.pem`, `*.key` and anything in `.codebrain/ignore`. A merge whose raw diff is over 60,000 bytes is skipped. The secret filter (see [Privacy and safety](#privacy-and-safety)) then removes sensitive files and any hunk that looks like it holds a secret.
4. **Drafting.** It runs `claude -p` with:
   - no tools (`--tools ""`) and no MCP servers;
   - one turn;
   - a $0.50 budget per merge (`CODEBRAIN_MAX_BUDGET_USD`);
   - a 3-minute timeout.

   It runs from an empty folder (`~/.codebrain/run`) with no settings files loaded, so no project settings, hooks or plugins apply. Claude Code still reads CLAUDE.md files from that folder's parents, so your user-level `~/.claude/CLAUDE.md`, a `~/CLAUDE.md`, and any CLAUDE.md above a custom `CODEBRAIN_HOME` may load. Model usage is billed to your own Claude account or plan. Claude checks the budget after its turn, so a single merge can go somewhat over it: with the defaults, expect a session start to spend up to about 5 merges × $0.50, around $2.50, but that is not a hard ceiling.
5. **Checking the cards.** Claude returns up to 5 cards per merge, multiple choice or flashcard. A card is rejected if:
   - it contains a URL or anything that looks like a secret;
   - it is over 1,200 characters;
   - it has empty or repeated options, or no explanation;
   - its explanation names an option by letter;
   - it is about a file that isn't in the diff;
   - it can't be anchored.

   Correct answers are then spread across A-D, since models tend to put them on one letter. Cards are written as drafts.
6. **Anchors.** Each card is tied to the block of code it describes by a fingerprint of the block's trimmed, non-blank lines. A block too trivial to recognise, such as a lone `}`, is widened to up to 5 lines. Each capture that finds the default branch checks every kept card against its head, even when the run stops early because Claude is unavailable or a merge failed:
   - `fresh`: the block is still there somewhere in the file. If it moved, the card's line range moves with it.
   - `changed`: the file is there but the block isn't. The card is flagged in `/codebrain:week`, and `/codebrain:review` warns that the answer may be out of date.
   - `orphaned`: the file is gone. The card is flagged, and it is never quizzed. If the file comes back with the block in it, the card is fresh again.

**When something goes wrong.** Capture writes what happened to `capture.log`.
- **Claude unavailable.** If `claude` is missing, logged out, offline, rate-limited, or gets an auth (401, 403), rate-limit (429) or server (5xx) error from the API, the run stops and nothing counts against the merge. It tries again at the next session start. `/codebrain:week` shows how long Claude has been unavailable.
- **A merge fails.** If Claude runs but fails on one merge (an error result, any other API error such as 400 "prompt is too long", the timeout, or too much output), or git fails on that merge's diff, the merge gets a strike. After 3 strikes in a row it is skipped.
- **Unexpected errors.** If a capture fails for another reason, such as git failing to list merges, `/codebrain:week` shows the last error until a capture completes.
- **Over budget, or nothing usable.** A merge that hits the budget is skipped at once, because retrying would spend the same again. So is a reply with no usable JSON.
- **History rewritten.** After a force-push, capture restarts from the common ancestor. If the commit it last saw shares no history with the branch, it starts again from the current head; merges in between never become cards.
- **Already handled.** A card you have already kept or dropped is never overwritten by a retry. Only one capture runs per repository at a time.

## Options

These are environment variables, read by the background capture. Set them in the environment you start Claude Code from.

| Variable | Default | Effect |
| --- | --- | --- |
| `CODEBRAIN_HOME` | `~/.codebrain` | Where config, cards and state live. |
| `CODEBRAIN_MAX_BUDGET_USD` | `0.50` | Budget per merge, passed to `claude --max-budget-usd`. Must be a positive number; anything else falls back to the default. |
| `CODEBRAIN_SETTING_SOURCES` | `""` | `""` loads no Claude settings files. `user` also loads `~/.claude/settings.json`, for people whose Claude auth is set there. That also turns on your user-level hooks and plugins in the drafting run, so they run once per merge (CodeBrain's own hook does nothing there). Any other value counts as `""`, so a repository's project or local settings never load. |
| `CODEBRAIN_MODEL` | unset | The model for drafting, passed to `claude --model` (an alias such as `sonnet`, or a full model name). Unset uses your `claude` default. |

**`.codebrain/ignore`**, at the root of your repository: one git pathspec glob per line, relative to the repository root, such as `**/fixtures/**` or `secrets/**`, and `#` for comments. Matching paths are never sent to Claude. This is not gitignore syntax: a leading `/` is accepted and stripped, but there is no `!` negation, and a pattern without `**/` matches from the root only. Lines starting with `!` or `:` are skipped, and each one is noted in `capture.log`.

## Commands

In Claude Code:

| Command | What it does |
| --- | --- |
| `/codebrain:connect` | Connects the current repository and offers to draft cards for the last week's merges. |
| `/codebrain:week` | Goes through draft cards, and kept cards whose code changed or was removed, change by change: keep, fix or drop each one. |
| `/codebrain:review` | Quizzes you on due cards one at a time and records each answer. |

The plugin puts the `codebrain` CLI on the PATH of Claude Code's Bash tool. Outside Claude Code, run `bin/codebrain` from the checkout. Every subcommand prints JSON. It exits with 0 on success, 1 on failure and 2 on bad arguments, and accepts `--repo <path>` (default: the current folder).

| Subcommand | What it does |
| --- | --- |
| `connect [path] [--area-depth N]` | Connects a repository. Cards are grouped into areas by their first N folders (default 3). |
| `capture [--since DATE] [--max N] [--no-fetch]` | Drafts cards from new merges now. `--since` (git date syntax) applies on the first run, `--max` defaults to 5, and `--no-fetch` skips `git fetch`. |
| `week` | Lists draft and flagged cards by area and merge, plus unreadable card files and capture problems. |
| `curate <id> keep\|fix\|drop` | Records a decision. Keeping or fixing a changed card re-anchors it at the default branch's head. |
| `curate <id> fix --path P --lines S-E [--symbol X\|--no-symbol]` | Re-points a card at other code on the default branch. |
| `show <id>` | Shows the card's code as it was written against it, next to the code at the default branch's head. |
| `due [--limit N]` | Lists the questions for due cards, without answers (default limit 10). |
| `answer <id>` | Shows a kept card's answer. |
| `grade <id> right\|wrong\|didnt-know` | Records a review and schedules the card. Right counts as Good; the others count as Again. |
| `stats` | Counts cards by status, curation decisions and reviews. |
| `card <id>` | Prints the path of a card's file. |

## Files

```
~/.codebrain/
  config.json           connected repositories
  run/                  empty folder that claude -p runs in
  capture-errors.log    capture errors that couldn't be tied to a repository, and anything a background capture prints to stderr
  repos/<key>/          one per repository; <key> is the folder name plus a short hash of its path
    cards/<id>.md       one file per card
    state.json          the last merge processed, recent merges, strikes, Claude availability, the last capture error
    schedule.json       FSRS state per card
    reviews.jsonl       every grade
    curation.jsonl      every keep, fix and drop
    capture.log         what each capture did
    capture.lock        held while a capture runs
```

## Card format

Front matter holds one JSON value per line. The body uses plain labels. When you fix a card in `/codebrain:week`, Claude edits only the body; the CLI keeps the front matter (status and anchor) up to date.

```
---
id: "4be1c09f2a-1"
repo: "shop-api"
merge: "4be1c09f2a7d3e5b8c6a1f0e9d2b7c4a5e6f8a91"
merge_title: "Retry webhook deliveries with backoff"
area: "src/webhooks"
created_at: "2026-10-28T09:12:44.000Z"
status: "draft"
anchor_commit: "4be1c09f2a7d3e5b8c6a1f0e9d2b7c4a5e6f8a91"
anchor_path: "src/webhooks/deliver.ts"
anchor_symbol: "nextDelay"
anchor_start: 14
anchor_end: 22
anchor_lines: 8
anchor_fingerprint: "9f2c41d07ab3e855"
anchor_status: "fresh"
---

Q: Why does nextDelay add random jitter to the backoff?
A: So retries from many failed deliveries don't all hit the receiver at once
B: To stay under the queue's message size limit
C: Because the timer API rounds delays to whole seconds
D: To keep delivery order the same across retries
Correct: A
Explanation: Without jitter, deliveries that failed together retry together and can overload the receiver again. Message size, timer rounding and ordering are unrelated to the delay.
```

A flashcard uses `Front:` and `Back:` instead.

## Privacy and safety

- **What is sent, and where.** For each merge: a fixed prompt, the merge's title (one line, up to 200 characters) and its filtered diff. They go to your `claude` CLI, which sends them to Anthropic or to the provider it is configured for. CodeBrain sends nothing anywhere else. The only other network call it makes is `git fetch origin`.
- **What is filtered first.**
  - Excluded paths (above) and `.codebrain/ignore`.
  - Whole files with sensitive names: `.env*`, `.npmrc`, `.netrc`, `.pypirc`, `.pgpass`, `credentials.json`, `service-account*.json`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.p8`, `*.jks`, `*.keystore`, `*.tfstate`, `id_rsa*`, `id_ed25519*` and `id_ecdsa*`.
  - Any hunk that matches a secret pattern: AWS, GitHub, Stripe, npm, Slack, Google, Anthropic and OpenAI keys, private keys, JWTs, secret-looking assignments, and URLs with passwords in them.
  - Any file whose path can't be read.

  The filter is a built-in pattern set, not a guarantee. Use `.codebrain/ignore` for anything that must never be sent.
- **The model can do nothing but reply.** It runs with no tools, no MCP servers and one turn, from an empty folder, and the diff is passed to it as data. Its reply is parsed as JSON and checked before anything is written. Cards containing URLs or secret-looking text are rejected.
- **Everything stays local.** Cards, grades, schedules and logs live only in `~/.codebrain`. Nothing is synced.
- **No pressure.** There are no streaks, no daily goals and nothing locked behind reviews. Review when you want to.

## Development

```sh
npm install
npm test            # Vitest; tests use temporary git repos and never call the real claude
npm run typecheck
npm run build       # compiles src/ to dist/
```

### After changing the code

The installed plugin runs from Claude Code's plugin cache, a copy made at install time, so rebuilding the checkout doesn't change what runs. To pick up a change:

1. Bump `version` in `.claude-plugin/plugin.json`.
2. `npm run build`.
3. `claude plugin marketplace update codebrain-local`, then `claude plugin update codebrain@codebrain-local`.

Or uninstall and install again: `claude plugin uninstall codebrain@codebrain-local`, then `claude plugin install codebrain@codebrain-local`. Start a new Claude Code session afterwards.

## Licence

MIT. See [LICENSE](LICENSE).
