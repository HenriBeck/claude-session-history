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
  requested work is unfinished, or Claude said it would do something next. A new prompt clears the label. When a
  close can't label a session (no answer, an error), `/sessions` says so and keeps the session listed.
- `/sessions` hides complete sessions. **Show N finished** in the list shows them again, and `/sessions --all`
  includes them in the text listing. Pending sessions are marked `•`, complete ones `✓`.
- `/sessions [filter]` lists earlier sessions, most recent first. Type to filter by name, directory or ID; pick one
  (or press Enter for the first match) to resume it.
  - A session from the current directory is resumed in place with `/resume`.
  - A session from another directory can't be resumed in place, so the plugin copies
    `cd <dir> && claude --resume <id>` to your clipboard instead.
- Headless runs (`claude -p`, the Agent SDK) are not recorded.

## Install

Needs Claude Code 2.1.275 or later on macOS or Linux.

1. **Install the plugin.** In any Claude Code session, run:

   ```
   /plugin install session-history --marketplace HenriBeck/claude-session-history
   ```

   Answer `y` to add the marketplace, then press Enter to install it for your user. The plugin is active right away
   and loads in every new session. From a shell, the same install is:

   ```sh
   claude plugin install session-history --marketplace HenriBeck/claude-session-history
   ```

2. **Give sessions time to label themselves when they close.** Claude Code gives exit hooks 1.5 s by default, and
   most labels take longer than that. Add the setting to `~/.claude/settings.json`, inside the `env` block if you
   already have one:

   ```json
   {
     "env": {
       "CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS": "10000"
     }
   }
   ```

   Closing a session then waits for its label, usually 1–3 s and at most 10 s. `/sessions` shows a warning until
   the setting is there.

3. **Check that it works.** Start a new session and run `/sessions`. It lists every session since the install except
   the one you are in. To add sessions from before the install, run the [backfill](#backfill).

### Update and uninstall

```sh
claude plugin update session-history@claude-session-history     # then /reload-plugins in open sessions
claude plugin uninstall session-history@claude-session-history
```

Uninstalling leaves the history in `~/.claude/session-history`. Delete that folder to remove it as well.

### From a clone

To work on the plugin, load it from a clone instead. Claude Code loads every plugin in `~/.claude/skills`:

```sh
git clone https://github.com/HenriBeck/claude-session-history.git
mkdir -p ~/.claude/skills
ln -s "$PWD/claude-session-history" ~/.claude/skills/session-history
```

New sessions load it as `session-history@skills-dir`; in sessions that are already open, run `/reload-plugins`.
Interactive sessions watch the folder, so edits to the clone reload the plugin on their own. Keep only one of the
two installs, since each copy would record every session and register `/sessions`.

## Backfill

Sessions from before the plugin was installed can be added from the transcripts Claude Code keeps under
`~/.claude/projects`. The script lives in this repository, so run it from a clone:

```sh
git clone https://github.com/HenriBeck/claude-session-history.git
cd claude-session-history
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
