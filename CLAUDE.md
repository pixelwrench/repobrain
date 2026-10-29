# CLAUDE.md

RepoBrain: an open-source Claude Code plugin and CLI that turns merged code changes into spaced-repetition cards, drafted locally by the user's own Claude.

- Node 24+. `npm test`, `npm run typecheck`, `npm run build`.
- Source in `src/`, tests in `test/` (Vitest). Tests build real temporary git repos and point `REPOBRAIN_HOME` at a temp dir.
- Tests never run the real `claude` CLI: inject a fake `RunClaude`.
- Secret-looking test fixtures are built by string concatenation so secret scanners don't flag this repo.
- `dist/` is committed, because a plugin installed from GitHub runs it without `npm install`. `npm run build` bundles `src/bin.ts` and `src/hook-bin.ts` with esbuild. After changing `src/`, rebuild and commit `dist/` in the same commit; `npm run check:dist` fails if it's stale.
