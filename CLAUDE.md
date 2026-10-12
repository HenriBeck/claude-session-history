# claude-session-history

A Claude Code plugin that records every interactive session to `~/.claude/session-history/<session-id>.json`
(under `$CLAUDE_CONFIG_DIR` when set) and lets you find and resume them with `/sessions`. Haiku titles sessions
in the background and labels them **complete** or **pending** when they close. See `README.md` for user-facing
behavior.

## Layout

- `hooks/register.tsx` — plugin entry point (listed in `hooks/hooks.json`). It wires the engine events
  (`session.start`, `prompt.submit`, `session.end`), the `/sessions` command and its pane, and the Haiku calls.
- `hooks/history.ts` — pure logic: record parsing and merging, naming, transcript parsing, excerpt building,
  filtering, formatting. Keep I/O out of it so it stays testable and the backfill script can import it.
- `hooks/label.ts` — the complete/pending labeler: prompt, reply parsing, timeout budget against
  `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`.
- `types/index.d.ts` — shared types (`SessionRecord`, `SessionStatus`, …).
- `scripts/backfill.mjs` — fills the history from transcripts under `~/.claude/projects`; `--label` labels
  unlabeled sessions via `claude -p --model haiku`. Imports the TypeScript in `hooks/` directly (Node ≥ 23.6).
- `tests/session-history.test.ts` — tests using `claude-code/testing`.
- `docs/superpowers/` — design specs and implementation plans. Update the plan as work progresses.
- `.claude-plugin/types/` — Claude Code's plugin API types, written by Claude Code when a session loads the plugin.
  Don't edit them by hand.

## Commands

```sh
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .           # typecheck; needs .claude-plugin/types
node scripts/backfill.mjs --dry-run  # try the backfill without writing anything
```

Run the tests and the typecheck before you commit.

## Guidelines

- **Small, working commits.** Each commit should compile and pass tests. Write the subject as a plain sentence in
  the imperative, with no conventional-commit prefix. Use the body to explain *why*, especially what a real run
  showed.
- **Pure logic in `history.ts`/`label.ts`, effects in `register.tsx`.** New behavior should come with tests on the
  pure part.
- **Match the existing style.** No semicolons, single quotes, 2-space indent, `import type` for types. Name
  constants in `UPPER_SNAKE` with a `/** doc comment */` that explains what the value means, not only what it is.
- **Fail visibly.** Don't swallow errors. When a close can't label a session, the reason stays on the record
  (`labelError`) and `/sessions` shows it.
- **Respect engine limits.** Session-end hooks share a time budget, and `$.process.run` caps output at 4 MiB.
  Check the constants in `label.ts` and `register.tsx` before you add work to a close.
- **Record only interactive sessions.** Headless runs (`claude -p`, the SDK) must never be recorded.
- **Keep backfill and live behavior in sync.** Both use `mergeRecords` and the same transcript parser, so a
  change to one path has to hold for the other.
- **Keep docs in step.** When user-facing behavior or settings change, update `README.md`.
- Text files end with a trailing newline.
