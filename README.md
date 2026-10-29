# RepoBrain

Remember the code your AI agents write. RepoBrain is a Claude Code plugin and a small TypeScript CLI. When a change is merged into your default branch, your own Claude drafts a few spaced-repetition cards about it: why the code is the way it is, where behaviour lives, and what breaks if it changes. Once a week you keep, fix or drop the drafts in `/repobrain:week`, and `/repobrain:review` quizzes you on the ones you kept. Scheduling uses FSRS-6.

**Your source files and diffs never leave your machine except to your own Claude, which drafts the cards.** In practice: the merge's secret-filtered diff and its one-line title go through your own `claude` CLI to Anthropic, or to whichever provider your `claude` is set up to use, and nowhere else. RepoBrain has no telemetry, and works with no account or server: cards, review history and scores are plain files in `~/.repobrain`. You can choose to sync a repository's cards with the RepoBrain site. That never sends your source files or diffs, but card text can quote short fragments of code (see [Sync with the RepoBrain site](#sync-with-the-repobrain-site-optional)).

## Requirements

- **Node 24 or later, as the `node` on your PATH.** The SessionStart hook and the `repobrain` shim both run whichever `node` comes first on PATH in the shell Claude Code starts from. If you use nvm or similar, check `node --version` there.
- macOS or Linux.
- The Claude Code CLI (`claude`), installed and logged in.
- git.

## Install

In Claude Code:

```sh
claude plugin marketplace add pixelwrench/repobrain
claude plugin install repobrain@repobrain
```

The repository ships a built `dist/`, so there is nothing to compile. To work on RepoBrain itself, see [Development](#development).

Then open Claude Code in a repository you want cards for and run `/repobrain:connect`. It offers to draft cards for the last week's merges straight away. For a codebase you're new to, `/repobrain:baseline` drafts cards about the code as it stands (see [Baseline](#baseline)).

## How capture works

1. **When it runs.** The plugin's SessionStart hook runs when a session starts, resumes or clears. It does nothing unless the session's folder is inside a connected repository or one of its git worktrees. Worktrees share the main repository's cards. In a connected repository it starts `repobrain capture` in the background and returns at once, so the session isn't held up.
2. **What it picks up.** Capture runs `git fetch origin` quietly (ssh in batch mode, unless you set your own `GIT_SSH_COMMAND` or `core.sshCommand`), then finds the default branch: origin's default branch, else `origin/main` or `origin/master`, else a local `main`, `master` or your `init.defaultBranch`, else the checked-out branch. It takes the first-parent commits on that branch since it last ran, so each merge counts once, at most 5 per run. The rest wait for the next session. On the very first run it only records where the branch is, unless you pass `--since`.
3. **The diff.** For each merge, it takes the diff against the first parent. It leaves out lockfiles, minified files, source maps, snapshots, `dist/`, `build/`, `vendor/`, `node_modules/`, `.env*`, `*.pem`, `*.key` and anything in `.repobrain/ignore`. A merge whose raw diff is over 60,000 bytes is skipped. The secret filter (see [Privacy and safety](#privacy-and-safety)) then removes sensitive files and any hunk that looks like it holds a secret.
4. **Drafting.** It runs `claude -p` with:
   - no tools (`--tools ""`) and no MCP servers;
   - one turn;
   - a $0.50 budget per merge (`REPOBRAIN_MAX_BUDGET_USD`);
   - a 3-minute timeout.

   It runs from an empty folder (`~/.repobrain/run`) with no settings files loaded, so no project settings, hooks or plugins apply. Claude Code still reads CLAUDE.md files from that folder's parents, so your user-level `~/.claude/CLAUDE.md`, a `~/CLAUDE.md`, and any CLAUDE.md above a custom `REPOBRAIN_HOME` may load. Model usage is billed to your own Claude account or plan. Claude checks the budget after its turn, so a single merge can go somewhat over it: with the defaults, expect a session start to spend up to about 5 merges × $0.50, around $2.50, but that is not a hard ceiling.

   Each call's cost, as `claude` reports it (`total_cost_usd`), goes on that merge's line in `capture.log`, and `repobrain capture` prints the run's total as `costUsd`. When `claude` reports no cost, the log says "cost unknown" and the total leaves it out; RepoBrain never estimates one.
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
   - `changed`: the file is there but the block isn't. The card is flagged in `/repobrain:week`, and `/repobrain:review` warns that the answer may be out of date.
   - `orphaned`: the file is gone. The card is flagged, and it is never quizzed. If the file comes back with the block in it, the card is fresh again.

**When something goes wrong.** Capture writes what happened to `capture.log`.
- **Claude unavailable.** If `claude` is missing, logged out, offline, rate-limited, or gets an auth (401, 403), rate-limit (429) or server (5xx) error from the API, the run stops and nothing counts against the merge. It tries again at the next session start. `/repobrain:week` shows how long Claude has been unavailable.
- **A merge fails.** If Claude runs but fails on one merge (an error result, any other API error such as 400 "prompt is too long", the timeout, or too much output), or git fails on that merge's diff, the merge gets a strike. After 3 strikes in a row it is skipped.
- **Unexpected errors.** If a capture fails for another reason, such as git failing to list merges, `/repobrain:week` shows the last error until a capture completes.
- **Over budget, or nothing usable.** A merge that hits the budget is skipped at once, because retrying would spend the same again. So is a reply with no usable JSON.
- **History rewritten.** After a force-push, capture restarts from the common ancestor. If the commit it last saw shares no history with the branch, it starts again from the current head; merges in between never become cards.
- **Already handled.** A card you have already kept or dropped is never overwritten by a retry. Only one capture runs per repository at a time.

## Baseline

Capture only sees new merges. If you're new to a codebase, `/repobrain:baseline` drafts cards about the code as it stands, in the order a newcomer would learn it. From then on, merges keep the deck current as usual.

1. **Plan** (`repobrain baseline plan`). RepoBrain lists the text files at the head of the default branch with their line counts, leaving out the same paths capture leaves out of diffs (the excluded paths, `.repobrain/ignore`, and the sensitive file names under [Privacy and safety](#privacy-and-safety)). The list is capped at 3,000 paths; over the cap, the shallowest paths are kept, so the top-level structure always makes it in. It sends that list and the first 8,000 bytes of the root README (only if the secret filter finds nothing in it) to your own `claude -p`. Claude replies with up to 12 areas, each with a name, a one-line reason and up to 8 files from the list. Planning sends no other file contents. The plan is saved to `baseline.json`, and you can skip areas before anything is drafted.
2. **Draft** (`repobrain baseline draft --next`, or an area's id). For one area, RepoBrain reads its files at the commit the plan was made at. It drops any file with a sensitive name or anything that looks like a secret, and skips files once the area would go over 60,000 bytes. The rest go to Claude with line numbers, as data. Claude writes up to 8 cards about where behaviour lives, how the parts fit together, why it's built this way, and what breaks if it changes. They are checked and anchored like merge cards, at the plan's commit, and written as drafts.
3. **Curate and review as usual.** Baseline cards show up in `/repobrain:week` under "Baseline: <area name>". Every capture checks their anchors, so a merge that changes the code a baseline card describes flags it.

**Pacing and cost.** Each area is one `claude -p` call, with the same flags, empty folder, budget and timeout as capture, and only when you ask, so you approve the spend area by area. The plan is one more call. Each call's reported cost goes to `capture.log` and the command's output, and `repobrain baseline status` sums the known costs. If Claude is unavailable the area stays planned; if the call fails, runs over budget or yields no usable cards, the area is marked failed and can be drafted again by id. A baseline and a capture never run at the same time. `plan --force` starts a new plan at the current head, with new card ids; cards already drafted stay as they are.

## Sync with the RepoBrain site (optional)

Without this, everything stays on your machine. With it, your cards live on the RepoBrain site: you curate them there or in Claude Code, and the site schedules your reviews.

1. **Sign in once:** `repobrain login`. It opens the site in your browser and stores the sign-in in `auth.json`.
2. **Link a repository:** `repobrain link`, from inside it. This uploads every card the repository has, with its status. Your local review history isn't uploaded, so the site's schedule starts fresh. Linking again later carries your local keep and drop decisions only for cards the site still holds as drafts; a card you already kept or dropped on the site keeps the site's decision.

From then on, each capture uploads new drafts and anchor changes in the background, within 90 seconds. If the upload fails, the capture still stands, and the cards are sent next time.

**What is sent.** Only finished cards, after the secret filter:
- each card's text, id, area and status;
- its anchor metadata: the commit, path, symbol, line range, fingerprint and anchor status;
- the merge's commit id and title, and whether the card came from a merge or a baseline;
- the repository's folder name;
- your review grades;
- card text you fix with `curate`.

Your source files and diffs are never sent. Card text, written by your Claude, can name identifiers or quote short fragments of code, and file paths and symbol names are sent as anchor metadata. The site scans the cards for secrets again and refuses any that look like they hold one. `repobrain link` lists the cards it refused, `capture.log` notes them, and `curate` says why when you try to keep one. A refused card can still be dropped, locally.

**The site becomes the source for curation and reviews.**
- `/repobrain:week` lists the site's drafts and flagged cards. Your decisions are saved on the site, then in the local card file, and also show on the site's page for the repository.
- `/repobrain:review` gets its due cards from the site, which schedules them with FSRS, and records your grades there.
- Only `week` works offline: when the site can't be reached, it shows the local cards and says why. The other commands report the error.
- `repobrain stats` stays local. It keeps counting the plugin's drafts and curation decisions, but its review counts stop growing once the repository is linked.
- Every command that uses the site gives up after 45 seconds.

**Stopping.** `repobrain unlink` stops syncing the repository; the site keeps its copy of the cards. `repobrain logout` forgets the sign-in on this machine.

**Which site.** `--site`, else `REPOBRAIN_SITE`, else `https://repobrain.com`. Until the site is deployed, pass `--site http://localhost:3000` to `login` and `link` to use a local copy. Plain `http` is accepted only for `localhost`, `127.0.0.1` and `[::1]`.

## Options

These are environment variables, read by the background capture. Set them in the environment you start Claude Code from.

| Variable | Default | Effect |
| --- | --- | --- |
| `REPOBRAIN_HOME` | `~/.repobrain` | Where config, cards and state live. |
| `REPOBRAIN_MAX_BUDGET_USD` | `0.50` | Budget per merge, passed to `claude --max-budget-usd`. Must be a positive number; anything else falls back to the default. |
| `REPOBRAIN_SETTING_SOURCES` | `""` | `""` loads no Claude settings files. `user` also loads `~/.claude/settings.json`, for people whose Claude auth is set there. That also turns on your user-level hooks and plugins in the drafting run, so they run once per merge (RepoBrain's own hook does nothing there). Any other value counts as `""`, so a repository's project or local settings never load. |
| `REPOBRAIN_MODEL` | unset | The model for drafting, passed to `claude --model` (an alias such as `sonnet`, or a full model name). Unset uses your `claude` default. |
| `REPOBRAIN_SITE` | `https://repobrain.com` | The RepoBrain site for `login`, `logout` and `link`, when `--site` isn't given. A linked repository keeps the site it was linked to. |

**`.repobrain/ignore`**, at the root of your repository: one git pathspec glob per line, relative to the repository root, such as `**/fixtures/**` or `secrets/**`, and `#` for comments. Matching paths are never sent to Claude. This is not gitignore syntax: a leading `/` is accepted and stripped, but there is no `!` negation, no `..`, and a pattern without `**/` matches from the root only. Lines starting with `!` or `:`, lines with a `..` segment, and any line git rejects as a pathspec are skipped, and each one is noted in `capture.log`. If git still rejects the exclude list for a merge, capture stops without counting it against the merge, and `/repobrain:week` shows the error.

## Commands

In Claude Code:

| Command | What it does |
| --- | --- |
| `/repobrain:connect` | Connects the current repository and offers to draft cards for the last week's merges. |
| `/repobrain:baseline` | Plans the codebase's areas in learning order, lets you skip some, and drafts the next area's cards in the background. |
| `/repobrain:week` | Goes through draft cards, and kept cards whose code changed or was removed, change by change: keep, fix or drop each one. |
| `/repobrain:review` | Quizzes you on due cards one at a time and records each answer. |

The plugin puts the `repobrain` CLI on the PATH of Claude Code's Bash tool. Outside Claude Code, run `bin/repobrain` from the checkout. Every subcommand prints JSON. It exits with 0 on success, 1 on failure and 2 on bad arguments, and accepts `--repo <path>` (default: the current folder).

| Subcommand | What it does |
| --- | --- |
| `connect [path] [--area-depth N]` | Connects a repository. Cards are grouped into areas by their first N folders (default 3). |
| `capture [--since DATE] [--max N] [--no-fetch]` | Drafts cards from new merges now. `--since` (git date syntax) applies on the first run, `--max` defaults to 5, and `--no-fetch` skips `git fetch`. |
| `week` | Lists draft and flagged cards by area and change (a merge, or a baseline area), plus unreadable card files and capture problems. |
| `curate <id> keep\|fix\|drop` | Records a decision. Keeping or fixing a changed card re-anchors it at the default branch's head. |
| `curate <id> fix --path P --lines S-E [--symbol X\|--no-symbol]` | Re-points a card at other code on the default branch. |
| `show <id>` | Shows the card's code as it was written against it, next to the code at the default branch's head. |
| `due [--limit N]` | Lists the questions for due cards, without answers (default limit 10). |
| `answer <id>` | Shows a kept card's answer. |
| `grade <id> right\|wrong\|didnt-know` | Records a review and schedules the card. Right counts as Good; the others count as Again. |
| `stats` | Counts cards by status, curation decisions and reviews, overall and by source (`bySource`: merge or baseline). |
| `card <id>` | Prints the path of a card's file. |
| `baseline plan [--force] [--no-fetch]` | Plans the baseline's areas, or prints the existing plan. `--force` re-plans at the current head. |
| `baseline draft <area-id>\|--next` | Drafts one area's cards: a named planned or failed area, or the first planned one. |
| `baseline status` | Shows the plan, each area's status, totals and the total known cost. |
| `baseline skip <area-id>`, `baseline unskip <area-id>` | Skips a planned or failed area, or puts a skipped one back. |
| `login [--site URL]` | Signs in to the RepoBrain site in your browser (OAuth with PKCE, redirecting back to a one-off listener on 127.0.0.1), and stores the tokens in `auth.json`. Waits up to 5 minutes. Tokens are never printed. |
| `logout [--site URL]` | Forgets that site's sign-in. Other sites are kept. |
| `link [--site URL]` | Links the repository to the site and uploads all its cards. Needs `login` first. Linking again, or to another site, uploads them all again. |
| `unlink` | Stops syncing the repository. The site keeps its copy of the cards. |

In a linked repository, `week`, `curate`, `due`, `show`, `answer` and `grade` use the site (see [Sync with the RepoBrain site](#sync-with-the-repobrain-site-optional)). `due` then lists cards by the site's card ids, and `show`, `answer` and `grade` take those ids.

## Files

```
~/.repobrain/
  config.json           connected repositories, and the site each linked one syncs with
  auth.json             each site's OAuth client and tokens, from repobrain login (mode 0600; keep it private)
  auth.json.lock        held briefly while auth.json is updated or a sign-in is refreshed
  run/                  empty folder that claude -p runs in
  capture-errors.log    capture errors that couldn't be tied to a repository, and anything a background capture prints to stderr
  repos/<key>/          one per repository; <key> is the folder name plus a short hash of its path
    cards/<id>.md       one file per card
    state.json          the last merge processed, recent merges, strikes, Claude availability, the last capture error, and what the site has been sent
    schedule.json       FSRS state per card
    reviews.jsonl       every grade
    curation.jsonl      every keep, fix and drop
    baseline.json       the baseline plan: its commit, and each area's files, status, card count and cost
    capture.log         what each capture and baseline call did, with its cost
    capture.lock        held while a capture runs
```

## Card format

Front matter holds one JSON value per line. The body uses plain labels. When you fix a card in `/repobrain:week`, Claude edits only the body; the CLI keeps the front matter (status and anchor) up to date.

```
---
id: "4be1c09f2a-1"
repo: "shop-api"
merge: "4be1c09f2a7d3e5b8c6a1f0e9d2b7c4a5e6f8a91"
merge_title: "Retry webhook deliveries with backoff"
area: "src/webhooks"
created_at: "2026-10-28T09:12:44.000Z"
status: "draft"
source: "merge"
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

A flashcard uses `Front:` and `Back:` instead. `source` is `merge` or `baseline`; a card file without it is a merge card. A baseline card's `merge` holds the baseline commit and its `merge_title` is `Baseline: <area name>`.

## Privacy and safety

- **What is sent, and where.** For each merge: a fixed prompt, the merge's title (one line, up to 200 characters) and its filtered diff. For a baseline plan: the file list with line counts and the README excerpt; for each baseline area: its filtered files (see [Baseline](#baseline)). They go to your `claude` CLI, which sends them to Anthropic or to the provider it is configured for. Apart from that, RepoBrain's only network call is `git fetch origin`, unless you link a repository to the RepoBrain site, which then gets that repository's cards, anchor metadata and your review grades, but never your source files or diffs. Card text can name identifiers or quote short fragments of code (see [Sync with the RepoBrain site](#sync-with-the-repobrain-site-optional)).
- **What is filtered first.**
  - Excluded paths (above) and `.repobrain/ignore`.
  - Whole files with sensitive names: `.env*`, `.npmrc`, `.netrc`, `.pypirc`, `.pgpass`, `credentials.json`, `service-account*.json`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.p8`, `*.jks`, `*.keystore`, `*.tfstate`, `id_rsa*`, `id_ed25519*` and `id_ecdsa*`.
  - Any hunk that matches a secret pattern: AWS, GitHub, Stripe, npm, Slack, Google, Anthropic and OpenAI keys, private keys, JWTs, secret-looking assignments, and URLs with passwords in them.
  - Any file whose path can't be read.

  The filter is a built-in pattern set, not a guarantee. Use `.repobrain/ignore` for anything that must never be sent.
- **The model can do nothing but reply.** It runs with no tools, no MCP servers and one turn, from an empty folder, and the diff is passed to it as data. Its reply is parsed as JSON and checked before anything is written. Cards containing URLs or secret-looking text are rejected.
- **Everything stays local unless you link.** Cards, grades, schedules and logs live in `~/.repobrain`. Nothing is synced until you run `repobrain link`.
- **No pressure.** There are no streaks, no daily goals and nothing locked behind reviews. Review when you want to.

## Development

```sh
npm install
npm test            # Vitest; tests use temporary git repos and never call the real claude
npm run typecheck
npm run build       # type-checks, then bundles src/ into dist/ with esbuild
npm run check:dist  # fails if the committed dist/ is out of date
```

`dist/` is committed so a GitHub install needs no build step. Commit it with the source change that produced it.

To try a local checkout as the plugin, add it as a marketplace in place of GitHub: `claude plugin marketplace add "$PWD"`, then `claude plugin install repobrain@repobrain`.

### After changing the code

The installed plugin runs from Claude Code's plugin cache, a copy made at install time, so rebuilding the checkout doesn't change what runs. To pick up a change:

1. Bump `version` in `.claude-plugin/plugin.json`.
2. `npm run build`.
3. `claude plugin marketplace update repobrain`, then `claude plugin update repobrain@repobrain`.

Or uninstall and install again: `claude plugin uninstall repobrain@repobrain`, then `claude plugin install repobrain@repobrain`. Start a new Claude Code session afterwards.

## Licence

MIT. See [LICENSE](LICENSE).
