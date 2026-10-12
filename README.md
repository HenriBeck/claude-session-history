# claude-session-history

A Claude Code plugin that keeps a history of your sessions, so you can get back to a long-running one without
keeping its terminal tab open or remembering its session ID.

## What it does

- Records every interactive session in `~/.claude/session-history/<session-id>.json` (under `$CLAUDE_CONFIG_DIR`
  when that is set): its name, the directory it belongs to, when it started, when you last sent a message, and how
  many messages you sent.
- Names a session after the first line of its first prompt, then replaces that with a short title Haiku writes in
  the background. A `/rename` title always wins.
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

## Backfill

Sessions from before the plugin was installed can be added from the transcripts Claude Code keeps under
`~/.claude/projects`:

```sh
node scripts/backfill.mjs --dry-run   # show what would be written
node scripts/backfill.mjs
```

It needs Node 23.6 or later, since it imports the plugin's TypeScript directly. Running it again is safe: a session
already in the history keeps its better name and the widest time span.

## Limitations

- Claude Code deletes transcripts after `cleanupPeriodDays` (30 days by default). Their history entries stay listed
  but can no longer be resumed.
- The plugin records sessions through the `session.start` and `prompt.submit` events. User plugins don't receive the
  `classic.*` (settings hook) events, so those can't be used for this.

## Development

```sh
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .   # needs .claude-plugin/types, which Claude Code writes once a session loads the plugin
```
