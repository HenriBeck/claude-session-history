# Session status: label sessions complete or pending at close

## Goal

`/sessions` is for getting back to unfinished work. Sessions whose work is done crowd that list. When a session
closes, a small model labels it **complete** or **pending**. `/sessions` hides complete sessions by default, and a
toggle shows them again.

## Decisions

| Question | Decision |
| --- | --- |
| When is a session labeled? | In the `session.end` hook, while Claude Code waits for it. |
| Which labels? | `complete` or `pending`, with no note of what is left. |
| What is hidden? | Only `complete`. Pending and unlabeled sessions stay listed. |
| Sessions already in the history | `scripts/backfill.mjs --label` labels them once. |

## Record

`SessionRecord` gains `status: 'complete' | 'pending' | null` and `labelError: string | null` (why the last close
could not label it).

- `parseRecord` reads a file without `status` as `null`.
- `applyTouch` sets `status` to `null` on every prompt, so a resumed session is listed again until its next close.
- `mergeRecords` (backfill) keeps the existing `status`, unless the transcript has a prompt later than the
  record's `lastMessageAt`. In that case it becomes `null`.

## Labeling at close

The `session.end` hook labels the ending session (`e.sessionId`) before it calls `next(e)`.

- **When it labels:** for every end reason (`prompt_input_exit`, `other`, `clear`, `resume`, `logout`), but only
  when the session's record exists and has a `lastMessageAt`.
  - Headless runs never get a record, so they are skipped without extra state.
- **What the model sees:** the conversation comes from `$.session.messages({ as: 'api' })`, and `conversationExcerpt`
  turns it into an excerpt:
  - Only the `text` blocks of user and assistant messages, written as `User:` and `Claude:` paragraphs.
  - User messages that `promptText` rejects (tool results, wrapper tags, empty) are skipped, and so is the summary
    a compaction leaves (it opens with "This session is being continued from a previous conversation"), as the
    backfill skips `isCompactSummary` entries.
  - The excerpt keeps the end of the conversation, at most 8,000 characters. A message longer than that keeps its
    tail.
- **The model call:** `$.model.complete` with `model: 'haiku'`, `effort: 'low'` and `maxTokens: 5`. The system prompt
  and prompt come from `labelPrompt(excerpt)`.
  - **Pending:** the last assistant message asks the user a question or for a decision the user has not answered;
    work the user asked for is unfinished, failing or blocked; or the assistant said it would do something next.
  - **Complete:** anything else. Optional offers at the end ("I can also add a license") do not make a session
    pending.
  - The reply has to be exactly one of the two words.
- **Reading the reply:** `parseLabel` lowercases the reply and strips anything that is not a letter from both ends
  (quotes, markdown, a period). Anything other than `complete` or `pending` is a failure.
- **Time limit:** the call runs inside the end event's wall-clock bound.
  - It passes `next.signal` and the `timeoutMs` that `labelTimeoutMs(next.budget.remainingMs)` gives: what is left
    minus 300 ms for the record write and core, at most 9 s. With less than 500 ms left it skips the call.
  - The bound is 1.5 s unless `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` raises it. The install sets it to `10000`
    in the `env` of `~/.claude/settings.json`.
- **On failure:** `status` stays `null`, so the session stays listed. The reason is kept on the record as
  `labelError` and goes to the debug log (`$.ui.log(..., { to: 'debug' })`), which is only written under `--debug`.
  - `/sessions` turns `labelError` into a warning line: how many sessions a close could not label, and the latest
    reason. A prompt, a later successful label or `backfill.mjs --label` clears it.
  - A skipped call, an unanswered call, an empty excerpt or an unexpected reply is logged by the hook itself.
  - A throw or a timeout, including a write error, is logged by the hook's `.catch` as
    `session-history: labeling the session failed (...)`.
  - The `.catch` handler then calls `next(e)`.
- **Write order:** the hook writes through `serialized`, like the other history writes.

## `/sessions`

- **Visible sessions:** `visibleSessions(sessions, filter, showFinished)` returns the matching rows and the number
  of matching `complete` sessions it hid.
- **Pane state:** `PluginState['session-history']` gains `showFinished: boolean`. `/sessions` resets it to `false`
  each time it runs.
- **Header:**
  - The first row is a `Button`: `Show N finished` while finished sessions are hidden, `Hide finished` while they
    are shown. N counts hidden sessions that match the filter.
  - With no finished matches, the button is left out.
- **Row markers:** `•` for pending, `✓` for complete, a space for unlabeled, then the existing `↗` / space for the
  directory.
- **Enter in the filter** resumes the first visible match.
- **Limit warning:** when `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` is unset or below 5000, the pane shows a warning
  line saying that labels at close will time out, and how to set the variable.
- **Text fallback** (the pane cannot be placed):
  - The limit warning, when there is one, is its first line, so `claude -p /sessions` shows whether the setting
    reaches the plugin.
  - Finished sessions are left out, followed by `N finished sessions hidden; /sessions --all lists them`.
  - An `--all` token in the arguments includes them and is removed from the filter.

## Backfill labeling

`node scripts/backfill.mjs --label` runs the normal backfill, then labels every record whose `status` is `null` and
whose transcript is still there.

- **Reading transcripts:** `addTranscriptEntry` also keeps the excerpt lines (`excerptLine`, the same function the
  live hook runs on `$.session.messages`), so the excerpt and the prompt match the live hook.
  - It keeps only the text blocks of user and assistant entries that are not sidechain, meta or compact
    summaries.
  - The text is trimmed to the 8,000-character tail as it streams, so large transcripts stay small in memory.
- **The model call:** each label is one `claude -p --model haiku --no-session-persistence --tools ""
  --strict-mcp-config --setting-sources project --disable-slash-commands --system-prompt <system>` call, run in a
  temporary directory.
  - The extra flags keep MCP servers, user hooks and skills out of the call: they would add seconds and context to
    each call.
  - The prompt goes in on stdin.
  - Each call has a 60 s timeout.
  - Four calls run at once.
  - `parseLabel` reads the output.
- **Output:** the script prints how many sessions it labeled complete, pending and failed, and each failure with
  its session id and reason. With `--dry-run` it prints how many it would label and makes no calls.

## Testing

- **Unit tests** for `conversationExcerpt`, `labelPrompt`, `parseLabel` and `visibleSessions`. Also: `applyTouch`
  clears the status, `parseRecord` treats a missing status as `null`, `mergeRecords` drops a stale status, and
  the transcript summary keeps the tail messages.
- **Engine-kit tests:**
  - `session.end` writes `pending` and `complete`, and skips a session without a record.
  - It leaves `null` and logs on an unexpected reply or an unanswered call.
  - A prompt clears the status.
  - The pane hides finished sessions, counts them on the toggle, shows them after a press, and shows the limit
    warning.
- **Real-session check:**
  - With the variable set, run an interactive session under `expect`, send one prompt, `/exit`, and check that the
    record has a label.
  - Repeat once without the variable to see the 1.5 s bound and the logged failure.
  - The test kit models neither the bound nor the `classic.*` bypass, so this check is required.

## Out of scope

- A note of what is left on pending sessions.
- Changing a label by hand.
- Labeling after every answer, or later when `/sessions` opens.
