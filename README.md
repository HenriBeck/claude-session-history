# claude-session-history

A Claude Code plugin that keeps a history of your sessions, so you can get back to a long-running one without
keeping its terminal tab open or remembering its session ID.

## What it does

- Records every interactive session in `~/.claude/session-history/<session-id>.json` (under `$CLAUDE_CONFIG_DIR`
  when that is set): its name, the directory it belongs to, when it started, when you last sent a message, and how
  many messages you sent.
- Names a session after the first line of its first prompt, then replaces that with a short title Haiku writes in
  the background. A `/rename` title always wins.
- Labels a session **complete** or **pending** when it closes (`/exit`, Ctrl+C, closing the tab, `/clear`,
  `/resume`): Haiku reads the end of the conversation and calls it pending when a question to you is unanswered,
  requested work is unfinished, or Claude said it would do something next. A new prompt clears the label.
- `/sessions` hides complete sessions. **Show N finished** in the list shows them again, and `/sessions --all`
  includes them in the text listing. Pending sessions are marked `•`, complete ones `✓`.
- `/sessions [filter]` lists earlier sessions, most recent first. Type to filter by name, directory or ID; pick one
  (or press Enter for the first match) to resume it.
  - A session from the current directory is resumed in place with `/resume`.
  - A session from another directory can't be resumed in place, so the plugin copies
    `cd <dir> && claude --resume <id>` to your clipboard instead.
- Headless runs (`claude -p`, the Agent SDK) are not recorded.

## Install

Clone the repository and link it into Claude Code's skills folder, which loads plugins found there in every session:

```sh
git clone https://github.com/HenriBeck/claude-session-history.git
ln -s "$PWD/claude-session-history" ~/.claude/skills/session-history
```

New sessions load it as `session-history@skills-dir`. In sessions that are already open, run `/reload-plugins`.
Interactive sessions watch the folder, so edits to the repository reload the plugin on their own.

Labeling at close needs more time than Claude Code gives exit hooks by default (1.5 s). Raise it in
`~/.claude/settings.json`; closing a session then waits for the label, usually 1–3 s and at most 10 s:

```json
{
  "env": {
    "CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS": "10000"
  }
}
```

`/sessions` shows a warning while the setting is missing.

## Backfill

Sessions from before the plugin was installed can be added from the transcripts Claude Code keeps under
`~/.claude/projects`:

```sh
node scripts/backfill.mjs --dry-run   # show what would be written
node scripts/backfill.mjs
```

It needs Node 23.6 or later, since it imports the plugin's TypeScript directly. Running it again is safe: a session
already in the history keeps its better name and the widest time span.

`--label` then labels every session that has no label yet, one `claude -p --model haiku` call each, four at a
time:

```sh
node scripts/backfill.mjs --label --dry-run   # count the sessions it would label
node scripts/backfill.mjs --label
```

## Limitations

- Claude Code deletes transcripts after `cleanupPeriodDays` (30 days by default). Their history entries stay listed
  but can no longer be resumed.
- A session whose process is killed (or that crashes) gets no label at close and stays listed; the next
  `backfill.mjs --label` labels it.
- The plugin records sessions through the `session.start` and `prompt.submit` events. User plugins don't receive the
  `classic.*` (settings hook) events, so those can't be used for this.

## Development

```sh
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .   # needs .claude-plugin/types, which Claude Code writes once a session loads the plugin
```
