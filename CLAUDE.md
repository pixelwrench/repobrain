# CLAUDE.md

CodeBrain: an open-source Claude Code plugin and library that turns merged code changes into spaced-repetition cards, drafted locally by the user's own Claude. Design and plan: `docs/plans/2026-10-28-codebrain-design.md` and `docs/plans/2026-10-28-codebrain-phase1-plan.md` in the braineos repo.

- Node 24+. `npm test`, `npm run typecheck`, `npm run build`.
- Source in `src/`, tests in `test/` (Vitest). Tests build real temporary git repos and point `CODEBRAIN_HOME` at a temp dir.
- Tests never run the real `claude` CLI: inject a fake `RunClaude`.
- Secret-looking test fixtures are built by string concatenation so secret scanners don't flag this repo.

## Shared rules

The rules every repo shares are in `~/Dev/CLAUDE.md`. This repo: default branch `main`; no remote yet (the owner decides on public GitHub `pixelwrench/codebrain`). Status app key: `braineos`.
