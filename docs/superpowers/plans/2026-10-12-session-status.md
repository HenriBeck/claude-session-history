# Session Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a session closes, Haiku labels it `complete` or `pending`; `/sessions` hides complete sessions until a
toggle shows them, and the backfill labels the sessions already in the history.

**Architecture:**
- A `session.end` hook reads the end of the conversation, asks Haiku for one word and writes it to the session's
  history record. It stays inside the exit's time bound, which the install raises to 10 s.
- Pure helpers carry the logic so they can be unit tested:
  - `hooks/history.ts`: records, the conversation excerpt and the list filtering.
  - `hooks/label.ts` (new): the model contract, its timing and the limit warning.
- The `/sessions` pane reads a new `showFinished` atom. The backfill script labels old sessions through
  `claude -p`, building the same excerpt and the same prompt.

**Tech Stack:** Claude Code 2.1.296 function-hook plugin (TypeScript/TSX, `claude-code` and `claude-code/testing`
modules), Node 23.6+ for `scripts/backfill.mjs`, `expect` for the real-session check.

**Spec:** `docs/superpowers/specs/2026-10-12-session-status-design.md`

## Global Constraints

- **Where to work:** in the worktree `~/Projects/personal/claude-session-history-status` (branch `session-status`)
  until Task 8. `~/Projects/personal/claude-session-history` (master) is symlinked into `~/.claude/skills` and
  hot-reloads into every open Claude Code session.
- **Events:** never hook `classic.*` events. User plugins don't receive them.
- **`status` values:** `SessionRecord.status` is `'complete' | 'pending' | null`. A missing or unknown value reads as
  `null`.
- **Excerpt:** at most 8,000 characters, the end of the conversation, as `User:` and `Claude:` paragraphs.
- **Model call:**
  - Model `haiku`, `maxTokens: 5`, `effort: 'low'`.
  - Timeout: `min(remainingMs - 300, 9000)`; the call is skipped below 500 ms.
- **Time-limit setting:**
  - The variable is `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`. It's set to `"10000"` in the `env` of
    `~/.claude/settings.json`.
  - `/sessions` warns when it's unset or below 5000.
- **UI copy:**
  - Markers: `•` pending, `✓` complete. The toggle reads `Show N finished` or `Hide finished`.
  - The text-only listing ends with `N finished sessions hidden; /sessions --all lists them.`
- **Failure logging:** failures at session end go to `$.ui.log(..., { to: 'debug' })`, never swallowed. A failed
  label leaves `status` `null`.
- **History file writes:** pretty JSON plus a trailing newline. The backfill sets each file's mtime to its
  `lastMessageAt` after every write.
- **Code style:**
  - No semicolons, single quotes, 2-space indent, `if` blocks with braces, a blank line after a block.
  - Comments describe the current state, never the history of a change.
  - Text files end with a newline.
- **Commits:** imperative subject, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never use
  `--no-verify`.
- **Commands:**
  - Tests: `claude plugin test .`
  - Manifest: `claude plugin validate .`
  - Types: `npx -p typescript tsc -p .`. It needs `.claude-plugin/types`, which Task 1 copies into the worktree.

## Review Focus

1. **Exiting with the default 1.5 s limit:** exit must not hang, and the session stays listed with the reason in the
   debug log. Tested by `labelTimeoutMs` unit tests (Task 3) and real check A (Task 8).
2. **`/clear`:** the conversation that ended is labeled under `e.sessionId`, not under the id of the session that
   follows. Tested by a kit test (Task 4).
3. **Unusual conversations:**
   - The last turns are only tool traffic.
   - Prompts start with `<system-reminder>`.
   - There's a single 20,000-character paste.
   - Nothing labelable is left.

   The excerpt must stay bounded, and an empty excerpt means no model call plus a debug line. Tested by unit tests
   (Task 2) and a kit test (Task 4).
4. **Haiku's reply variants:** `**Complete**.`, `"Pending"`, or a whole sentence. Only a bare word counts. Tested by
   unit tests (Task 3) and a kit test (Task 4).
5. **A filter that matches only finished sessions:** no rows, the toggle shows the count, and Enter resumes nothing.
   Tested by a pane test (Task 5).

---

### Task 1: Worktree and the `status` field on records

**Files:**
- Modify: `types/index.d.ts` (`SessionRecord`)
- Modify: `hooks/history.ts` (`applyTouch`, `parseRecord`, `recordFromTranscript`, `mergeRecords`)
- Test: `tests/session-history.test.ts`

**Interfaces:**
- Produces:
  - `type SessionStatus = 'complete' | 'pending'` (exported from `types/index.d.ts`).
  - `SessionRecord.status: SessionStatus | null`.
  - `applyTouch` sets `status: null` on a prompt.
  - `parseRecord` normalizes `status`.
  - `mergeRecords` keeps `existing.status` unless the found prompt is more than 60 s later.

- [ ] **Step 1: Create the worktree**

```bash
cd ~/Projects/personal/claude-session-history
git worktree add ../claude-session-history-status -b session-status
cp -R .claude-plugin/types ../claude-session-history-status/.claude-plugin/types
cd ../claude-session-history-status
claude plugin test .
```

Expected: `14 pass`, `0 fail`. All later commands run in `~/Projects/personal/claude-session-history-status`.

- [ ] **Step 2: Write the failing tests**

In `tests/session-history.test.ts`:

a) Import `parseRecord` from `'../hooks/history'`. Add it to the existing import list, which stays alphabetical.

b) Give the `record()` helper a default `status`:

```ts
function record(overrides: Partial<SessionRecord> & Pick<SessionRecord, 'id'>): SessionRecord {
  return {
    name: null,
    nameSource: null,
    cwd: '/work/a',
    createdAt: '2026-10-10T08:00:00.000Z',
    lastMessageAt: '2026-10-11T09:00:00.000Z',
    messageCount: 3,
    status: null,
    ...overrides,
  }
}
```

c) Add `status: null,` after `messageCount` in every full record literal that a `toEqual` checks. These are the
objects at the current lines 180–188, 196–204, 209–217, 224–232, 241–249, 262–270, 328–336, 351–359 and 395–403.

d) Add these tests. The first goes in `describe('recording')`; the others go in `describe('backfill')`:

```ts
  test('should clear the label when a closed session gets a new prompt', async ($, on) => {
    const { files } = setup(on, { cwd: '/work/a', sessionId: 's1', turns: 3 })

    seed(files, record({ id: 's1', name: 'Done work', nameSource: 'generated', status: 'complete' }), 1)
    await $.prompt.submit({ ...TYPED_PROMPT, text: 'One more thing' })

    expect(readRecord(files, 's1')).toEqual(record({
      id: 's1',
      name: 'Done work',
      nameSource: 'generated',
      lastMessageAt: '2026-10-11T10:00:00.000Z',
      messageCount: 4,
      status: null,
    }))
  })
```

```ts
  test('should read a record without a label as unlabeled', async () => {
    const { status: _, ...unlabeled } = record({ id: 'old' })

    expect(parseRecord(JSON.stringify(unlabeled), 'old.json')).toEqual(record({ id: 'old' }))
    expect(parseRecord(JSON.stringify({ ...unlabeled, status: 'done' }), 'old.json')).toEqual(record({ id: 'old' }))
    expect(parseRecord(JSON.stringify({ ...unlabeled, status: 'pending' }), 'old.json').status).toBe('pending')
  })

  test('should keep a label unless the transcript has a later prompt', async () => {
    const labeled = record({ id: 'm', status: 'pending', lastMessageAt: '2026-10-11T09:00:00.000Z' })

    expect(mergeRecords(labeled, record({ id: 'm', lastMessageAt: '2026-10-11T09:00:00.400Z' })).status).toBe('pending')
    expect(mergeRecords(labeled, record({ id: 'm', lastMessageAt: '2026-10-11T11:00:00.000Z' })).status).toBe(null)
  })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `claude plugin test .`
Expected: FAIL. The records the plugin writes have no `status`, and `parseRecord` and `mergeRecords` don't set it.

- [ ] **Step 4: Add the field**

In `types/index.d.ts`, add this after `messageCount: number` inside `SessionRecord`:

```ts
  /**
   * What the session's last close left: `complete` when nothing was left to do, `pending` when work or a decision
   * was still open; null until a close labels it, and again after every prompt.
   */
  status: SessionStatus | null
```

and below the `SessionRecord` type:

```ts
export type SessionStatus = 'complete' | 'pending'
```

In `hooks/history.ts`:

1. Change the import to `import type { SessionRecord, SessionStatus } from '../types'`.
2. Add these constants below `NAME_RANK`:

```ts
/**
 * How much later a transcript may stamp a prompt than the live record of that same prompt.
 */
const SAME_PROMPT_MS = 60_000
```

3. In `applyTouch`, add `status: null,` to the `base` literal after `messageCount: 0,`. Add this to the returned
   object after `messageCount: facts.turns,`:

```ts
    status: touch.prompt === null ? base.status : null,
```

4. Replace the last line of `parseRecord` (`return value as SessionRecord`) with:

```ts
  return { ...(value as SessionRecord), status: readStatus((value as { status?: unknown }).status) }
```

   Add this below `parseRecord`:

```ts
function readStatus(value: unknown): SessionStatus | null {
  return value === 'complete' || value === 'pending' ? value : null
}
```

5. In `recordFromTranscript`, add `status: null,` after `messageCount: summary.prompts,`.
6. In `mergeRecords`, add this after the `messageCount` line of the returned object:

```ts
    status: isLaterPrompt(found.lastMessageAt, existing.lastMessageAt) ? null : existing.status,
```

   Update its doc comment to `Combines a recorded session with what its transcript says: the better-sourced name,
   the transcript's directory, the earliest start, the latest message, and the label unless a later prompt made it
   stale.` Add this below `latest()`:

```ts
function isLaterPrompt(found: string | null, recorded: string | null): boolean {
  if (found === null) {
    return false
  }

  if (recorded === null) {
    return true
  }

  return Date.parse(found) - Date.parse(recorded) > SAME_PROMPT_MS
}
```

- [ ] **Step 5: Run the tests and the type check**

Run: `claude plugin test . && npx -p typescript tsc -p .`
Expected: `17 pass`, `0 fail`; tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add types/index.d.ts hooks/history.ts tests/session-history.test.ts
git commit -F - <<'EOF'
Add a complete/pending status to session records

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Conversation excerpt and the transcript tail

**Files:**
- Modify: `hooks/history.ts`
- Test: `tests/session-history.test.ts`

**Interfaces:**
- Consumes: `WRAPPED_INPUT` (already in `history.ts`).
- Produces:
  - `type ExcerptLine = { role: 'user' | 'assistant'; text: string }`.
  - `excerptLine(role: unknown, content: unknown): ExcerptLine | null`.
  - `conversationExcerpt(lines: readonly ExcerptLine[], limit?: number): string`.
  - `TranscriptSummary.tail: ExcerptLine[]`.

- [ ] **Step 1: Write the failing tests**

Add `conversationExcerpt` and `excerptLine` to the `'../hooks/history'` import, and `ExcerptLine` to its type import.
Add a `describe('excerpt')` block after `describe('helpers')`:

```ts
describe('excerpt', () => {
  test('should keep the text of a conversation and drop tool traffic and engine wrappers', async () => {
    expect(excerptLine('user', 'Fix the test')).toEqual({ role: 'user', text: 'Fix the test' })
    expect(
      excerptLine('user', [
        { type: 'text', text: '<system-reminder>\nToday is Monday\n</system-reminder>' },
        { type: 'text', text: 'Fix the test' },
      ]),
    ).toEqual({ role: 'user', text: 'Fix the test' })
    expect(excerptLine('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }])).toBe(null)
    expect(
      excerptLine('assistant', [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'Running the tests.' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      ]),
    ).toEqual({ role: 'assistant', text: 'Running the tests.' })
    expect(excerptLine('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }])).toBe(null)
    expect(excerptLine('system', 'x')).toBe(null)
  })

  test('should keep the end of a conversation within the excerpt length', async () => {
    const lines: ExcerptLine[] = [
      { role: 'user', text: 'First request' },
      { role: 'assistant', text: 'x'.repeat(50) },
      { role: 'user', text: 'Second request' },
      { role: 'assistant', text: 'Done. Should I push it?' },
    ]

    expect(conversationExcerpt(lines, 1000)).toBe(
      `User: First request\n\nClaude: ${'x'.repeat(50)}\n\nUser: Second request\n\nClaude: Done. Should I push it?`,
    )
    expect(conversationExcerpt(lines, 60)).toBe('…xxxx\n\nUser: Second request\n\nClaude: Done. Should I push it?')

    const pasted = conversationExcerpt([{ role: 'user', text: 'y'.repeat(20_000) }])

    expect(pasted).toHaveLength(8000)
    expect(pasted.startsWith('…y')).toBe(true)
    expect(conversationExcerpt([])).toBe('')
  })

  test('should keep the latest messages of a transcript for the labeler', async () => {
    const summary = summarize([
      { type: 'user', timestamp: '2026-10-01T09:00:00.000Z', message: { content: 'Old request' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'z'.repeat(9000) }] } },
      { type: 'user', isSidechain: true, timestamp: '2026-10-01T09:10:00.000Z', message: { content: 'Explore' } },
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'Subagent report' }] } },
      {
        type: 'user',
        timestamp: '2026-10-01T09:20:00.000Z',
        message: { content: [{ type: 'tool_result', content: 'ok' }] },
      },
      { type: 'user', timestamp: '2026-10-01T09:30:00.000Z', message: { content: 'Ship it' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Shipped.' }] } },
    ])

    expect(summary.tail).toEqual([
      { role: 'assistant', text: 'z'.repeat(9000) },
      { role: 'user', text: 'Ship it' },
      { role: 'assistant', text: 'Shipped.' },
    ])
    expect(summary.prompts).toBe(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test .`
Expected: FAIL. `excerptLine` and `conversationExcerpt` aren't exported, and `summary.tail` is undefined.

- [ ] **Step 3: Implement**

In `hooks/history.ts`, add this below `SAME_PROMPT_MS`:

```ts
/**
 * How much of a conversation's end the labeler reads, in characters.
 */
const EXCERPT_LENGTH = 8000
```

Add this below the `SessionFacts` type:

```ts
/**
 * One message of a conversation as the labeler reads it: who wrote it, and its text.
 */
export type ExcerptLine = { role: 'user' | 'assistant'; text: string }
```

Add `tail` to `TranscriptSummary`, after `customTitle`:

```ts
  /** The latest messages' text, as much as the labeler's excerpt can use. */
  tail: ExcerptLine[]
```

Add `tail: [],` to `emptyTranscriptSummary()`.

In `addTranscriptEntry`, replace the block from
`if (entry.type !== 'user' || entry.isSidechain === true || ...) {` through `return` and `}` with:

```ts
  if (entry.isSidechain === true || entry.isMeta === true || entry.isCompactSummary === true) {
    return
  }

  if (entry.type === 'user' || entry.type === 'assistant') {
    const line = excerptLine(entry.type, entry.message?.content)

    if (line !== null) {
      keepTail(summary.tail, line)
    }
  }

  if (entry.type !== 'user') {
    return
  }
```

The prompt-counting lines that follow (`const text = promptText(...)` and the rest) stay unchanged.

Add these below `promptText`:

```ts
/**
 * The text of one message for the labeler; null for tool traffic, other roles and messages without text.
 *
 * A user message carrying a tool result is tool output, not a prompt; text blocks the engine wrapped around a
 * prompt (reminders, command echoes) are dropped one by one.
 */
export function excerptLine(role: unknown, content: unknown): ExcerptLine | null {
  if (role !== 'user' && role !== 'assistant') {
    return null
  }

  let blocks: { type?: unknown; text?: unknown }[] = []

  if (typeof content === 'string') {
    blocks = [{ type: 'text', text: content }]
  } else if (Array.isArray(content)) {
    blocks = content as { type?: unknown; text?: unknown }[]
  }

  if (role === 'user' && blocks.some(block => block.type === 'tool_result')) {
    return null
  }

  const texts = blocks
    .flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text.trim()] : []))
    .filter(text => text !== '' && (role === 'assistant' || !WRAPPED_INPUT.test(text)))

  return texts.length === 0 ? null : { role, text: texts.join('\n') }
}

/**
 * The end of a conversation as `User:` and `Claude:` paragraphs, at most `limit` characters: older messages are
 * dropped first, and the oldest one kept loses its beginning when it does not fit whole.
 */
export function conversationExcerpt(lines: readonly ExcerptLine[], limit = EXCERPT_LENGTH): string {
  const paragraphs: string[] = []
  let room = limit

  for (const line of [...lines].reverse()) {
    if (room <= 0) {
      break
    }

    const paragraph = `${line.role === 'user' ? 'User' : 'Claude'}: ${line.text}`

    paragraphs.unshift(paragraph.length > room ? `…${paragraph.slice(paragraph.length - room + 1)}` : paragraph)
    room -= paragraph.length + 2
  }

  return paragraphs.join('\n\n')
}

/**
 * Appends `line`, then drops the oldest lines once the ones after them fill the excerpt on their own.
 */
function keepTail(tail: ExcerptLine[], line: ExcerptLine): void {
  tail.push(line)

  let length = tail.reduce((sum, kept) => sum + kept.text.length, 0)

  while (tail.length > 1 && length - (tail[0]?.text.length ?? 0) >= EXCERPT_LENGTH) {
    length -= tail.shift()?.text.length ?? 0
  }
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `claude plugin test . && npx -p typescript tsc -p .`
Expected: `20 pass`, `0 fail`; tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add hooks/history.ts tests/session-history.test.ts
git commit -F - <<'EOF'
Build the conversation excerpt the session labeler reads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: The label contract (`hooks/label.ts`)

**Files:**
- Create: `hooks/label.ts`
- Test: `tests/session-history.test.ts`

**Interfaces:**
- Consumes: `SessionStatus` from `../types`.
- Produces:
  - `LABEL_MODEL = 'haiku'` and `END_LIMIT_VARIABLE = 'CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS'`.
  - `labelPrompt(excerpt: string): { system: string; prompt: string }`.
  - `parseLabel(reply: string): SessionStatus | null`.
  - `labelTimeoutMs(remainingMs: number): number | null`.
  - `limitWarning(value: string | undefined): string | null`.

- [ ] **Step 1: Write the failing tests**

Add `import { labelPrompt, labelTimeoutMs, limitWarning, parseLabel } from '../hooks/label'` after the
`'../hooks/history'` imports. Then add:

```ts
describe('label', () => {
  test('should put the excerpt and the rules into the label prompt', async () => {
    const { system, prompt } = labelPrompt('User: Hi\n\nClaude: Hello')

    expect(system).toContain('complete and pending')
    expect(prompt).toContain('Answer "pending" if:')
    expect(prompt).toContain('Reply with one word: complete or pending.')
    expect(prompt.endsWith('<conversation>\nUser: Hi\n\nClaude: Hello\n</conversation>')).toBe(true)
  })

  test('should read a label reply strictly', async () => {
    expect(parseLabel('pending')).toBe('pending')
    expect(parseLabel(' **Complete**.\n')).toBe('complete')
    expect(parseLabel('"Pending"')).toBe('pending')
    expect(parseLabel('Pending — the user has not chosen yet')).toBe(null)
    expect(parseLabel('')).toBe(null)
  })

  test('should fit the label call into what is left of the exit bound', async () => {
    expect(labelTimeoutMs(Infinity)).toBe(9000)
    expect(labelTimeoutMs(10_000)).toBe(9000)
    expect(labelTimeoutMs(1400)).toBe(1100)
    expect(labelTimeoutMs(700)).toBe(null)
  })

  test('should warn while the exit bound is too short for labels', async () => {
    expect(limitWarning(undefined)).toContain('"CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS": "10000"')
    expect(limitWarning('')).not.toBe(null)
    expect(limitWarning('1500')).not.toBe(null)
    expect(limitWarning('soon')).not.toBe(null)
    expect(limitWarning('10000')).toBe(null)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test .`
Expected: FAIL. The module `../hooks/label` doesn't exist.

- [ ] **Step 3: Create `hooks/label.ts`**

```ts
import type { SessionStatus } from '../types'

export const LABEL_MODEL = 'haiku'

/**
 * The setting that bounds every `session.end` hook together; 1500 ms when unset.
 */
export const END_LIMIT_VARIABLE = 'CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS'

/** The longest a label call may take, inside the 10 s bound the install sets. */
const LABEL_TIMEOUT_MS = 9000
/** What the record write and the engine's own end work need after the call. */
const END_RESERVE_MS = 300
/** Below this, a call cannot get an answer back; the hook skips it. */
const MIN_LABEL_MS = 500
/** The bound below which labels at close mostly time out. */
const MIN_END_LIMIT_MS = 5000

/**
 * What the labeler asks a small model about a conversation that just closed.
 */
export function labelPrompt(excerpt: string): { system: string; prompt: string } {
  return {
    system: 'You sort closed coding sessions into complete and pending, so a history list can hide the complete ones.',
    prompt: [
      'Below is the end of a conversation between a user and Claude, a coding assistant. The user has just closed it.',
      '',
      'Answer "pending" if:',
      '- Claude\'s last message asks the user a question or for a decision, and the user has not answered it;',
      '- work the user asked for is unfinished, failing or blocked; or',
      '- Claude said it would do something next.',
      '',
      'Answer "complete" otherwise. Optional offers at the end, such as "I can also add a license", do not make '
        + 'a session pending.',
      '',
      'Reply with one word: complete or pending.',
      '',
      '<conversation>',
      excerpt,
      '</conversation>',
    ].join('\n'),
  }
}

/**
 * The label in a model's reply: one of the two words, with quotes, markdown or a period around it; null otherwise.
 */
export function parseLabel(reply: string): SessionStatus | null {
  const word = reply.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '')

  return word === 'complete' || word === 'pending' ? word : null
}

/**
 * How long the label call may take with `remainingMs` of the exit left; null when that is too little to try.
 */
export function labelTimeoutMs(remainingMs: number): number | null {
  const available = remainingMs - END_RESERVE_MS

  if (available < MIN_LABEL_MS) {
    return null
  }

  return Math.min(available, LABEL_TIMEOUT_MS)
}

/**
 * What `/sessions` says while the exit bound (`value`, the variable's text) is too short for labels at close.
 */
export function limitWarning(value: string | undefined): string | null {
  const ms = Number(value ?? '')

  if (value !== undefined && value.trim() !== '' && Number.isFinite(ms) && ms >= MIN_END_LIMIT_MS) {
    return null
  }

  return 'Sessions are labeled complete or pending when they close, which takes longer than Claude Code waits by '
    + `default. Add "${END_LIMIT_VARIABLE}": "10000" to "env" in ~/.claude/settings.json.`
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `claude plugin test . && npx -p typescript tsc -p .`
Expected: `24 pass`, `0 fail`; tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add hooks/label.ts tests/session-history.test.ts
git commit -F - <<'EOF'
Add the prompt, reply parsing and timing for session labels

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Label sessions in the `session.end` hook

**Files:**
- Modify: `hooks/register.tsx`
- Test: `tests/session-history.test.ts`

**Interfaces:**
- Consumes:
  - From `./history`: `excerptLine` and `conversationExcerpt` (Task 2).
  - From `./label`: `LABEL_MODEL`, `labelPrompt`, `parseLabel` and `labelTimeoutMs` (Task 3).
  - `SessionRecord.status` (Task 1).
- Produces:
  - The `session.end` hook.
  - `reportFailure($, what, error, to?)`.
  - `generateName` and `labelSession` take a `Serialize` function and hold the write queue only while they write.

- [ ] **Step 1: Extend the test engine and write the failing tests**

In `tests/session-history.test.ts`:

a) Add this type above `type Setup`:

```ts
/**
 * One message of the main conversation as `$.session.messages({ as: 'api' })` answers it.
 */
type ConversationMessage = { role: 'user' | 'assistant'; content: { type: string; [field: string]: unknown }[] }
```

b) Add these to `Setup`:

```ts
  /** The main conversation's messages; none unless given. */
  messages?: ConversationMessage[]
  /** The environment beside HOME; the exit bound is raised to 10 s unless given. */
  env?: Record<string, string>
```

c) In `setup`:
- Replace `mock.env(on, { HOME })` with:

```ts
  mock.env(on, { HOME, ...(options.env ?? { CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: '10000' }) })
```

- Add these engine answers after `on('session.start', ...)`:

```ts
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.messages', () => ({ value: options.messages ?? [] }))
  on('ui.log', ($, e) => {
    logs.push(`${e.to}: ${e.text}`)

    return { value: undefined }
  })
```

- Declare `const logs: string[] = []` next to `let turns`, and return `{ files, clock, logs }`.

d) Add the import `labelPrompt` (already imported in Task 3). Add this block after `describe('recording')`:

```ts
describe('labeling at close', () => {
  const END = { reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } } as const
  const CONVERSATION: ConversationMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Create the repo on GitHub' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'gh repo view' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'not found' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Should it be public or private?' }] },
  ]

  type Asked = { model: string; system?: string; prompt: string; timeoutMs?: number }

  function answer(on: On, text: string): Asked[] {
    const asked: Asked[] = []

    on('model.complete', ($, e) => {
      asked.push({ model: e.model, system: e.system, prompt: e.prompt, timeoutMs: e.timeoutMs })

      return { value: { isAnswered: true, text, usage: USAGE } }
    })

    return asked
  }

  test('should label a closed session from the end of its conversation', async ($, on) => {
    const { files, logs } = setup(on, { cwd: '/work/a', sessionId: 's1', messages: CONVERSATION })
    const asked = answer(on, 'Pending')

    seed(files, record({ id: 's1', name: 'GitHub repo' }), 1)

    expect(await $.session.end(END)).toEqual({ sessionId: 's1' })
    expect(readRecord(files, 's1')).toEqual(record({ id: 's1', name: 'GitHub repo', status: 'pending' }))
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      model: 'haiku',
      ...labelPrompt('User: Create the repo on GitHub\n\nClaude: Should it be public or private?'),
    })
    expect(asked[0]?.timeoutMs).toBeGreaterThan(0)
    expect(asked[0]?.timeoutMs).toBeLessThanOrEqual(9000)
    expect(logs).toEqual([])
  })

  test('should label the conversation a /clear ended, not the session that follows', async ($, on) => {
    const { files } = setup(on, { cwd: '/work/a', sessionId: 'fresh', messages: CONVERSATION })

    answer(on, 'complete')
    seed(files, record({ id: 'old', name: 'Before the clear' }), 1)
    await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } })

    expect(readRecord(files, 'old').status).toBe('complete')
    expect(files.has(`${DIR}/fresh.json`)).toBe(false)
  })

  test('should not ask about headless sessions, sessions without a prompt or conversations without text', async ($, on) => {
    const toolOnly: ConversationMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]
    const { files, logs } = setup(on, { cwd: '/work/a', sessionId: 's1', messages: toolOnly })
    const asked = answer(on, 'complete')

    await $.session.end(END)
    seed(files, record({ id: 's1', lastMessageAt: null }), 1)
    await $.session.end(END)
    seed(files, record({ id: 's1' }), 2)
    await $.session.end(END)

    expect(asked).toEqual([])
    expect(readRecord(files, 's1').status).toBe(null)
    expect(logs).toEqual(['debug: session-history: s1 has no conversation text to label'])
  })

  test('should leave a session unlabeled and log why when the reply is not a label', async ($, on) => {
    const { files, logs } = setup(on, { cwd: '/work/a', sessionId: 's1', messages: CONVERSATION })

    answer(on, 'Pending — no answer yet')
    seed(files, record({ id: 's1' }), 1)
    await $.session.end(END)

    expect(readRecord(files, 's1').status).toBe(null)
    expect(logs).toEqual(['debug: session-history: labeling s1 got an unexpected reply: "Pending — no answer yet"'])
  })

  test('should leave a session unlabeled and log why when the model does not answer', async ($, on) => {
    const { files, logs } = setup(on, { cwd: '/work/a', sessionId: 's1', messages: CONVERSATION })

    on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply' } }))
    seed(files, record({ id: 's1' }), 1)
    await $.session.end(END)

    expect(readRecord(files, 's1').status).toBe(null)
    expect(logs).toEqual(['debug: session-history: labeling s1 got no answer (empty-reply)'])
  })

  test('should let the session end and log the failure when labeling throws', async ($, on) => {
    const { files, logs } = setup(on, { cwd: '/work/a', sessionId: 's1', messages: CONVERSATION })

    on('model.complete', () => ({ deny: 'offline' }))
    seed(files, record({ id: 's1' }), 1)

    expect(await $.session.end(END)).toEqual({ sessionId: 's1' })
    expect(readRecord(files, 's1').status).toBe(null)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('debug: session-history: labeling the session failed (throw)')
    expect(logs[0]).toContain('offline')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test .`
Expected: FAIL. No `session.end` hook exists, so no model call is made and `status` stays `null`.

- [ ] **Step 3: Implement**

In `hooks/register.tsx`:

1. Change the type import to:

```ts
import type { EngineInterface, HookFailure, Register, RenderSurface, UiLogSink } from 'claude-code'
```

   Add `conversationExcerpt` and `excerptLine` to the `./history` import. Add this below it:

```ts
import { LABEL_MODEL, labelPrompt, labelTimeoutMs, parseLabel } from './label'
```

2. Add this below `type Engine = EngineInterface`:

```ts
/**
 * Runs one history write after the ones already queued.
 */
type Serialize = <T>(write: () => Promise<T>) => Promise<T>

/**
 * What a label at close works within: the exit's time bound and its abort signal.
 */
type LabelContext = {
  /** What is left of the exit's bound in milliseconds, read fresh. */
  remainingMs: () => number
  signal: AbortSignal
  serialize: Serialize
}
```

3. Replace `generateName` with a version that holds the write queue only while it writes:

```ts
/**
 * Replaces the prompt-line name with a short title from a small model; a `/rename` meanwhile is kept.
 */
async function generateName($: Engine, id: string, prompt: string, serialize: Serialize): Promise<void> {
  const reply = await $.model.complete({
    model: TITLE_MODEL,
    system: 'You name coding sessions so they can be found again in a history list.',
    prompt: 'Write a 3 to 6 word title for a coding session that starts with the request below. '
      + `Reply with the title only.\n\n<request>\n${prompt.slice(0, TITLE_PROMPT_LENGTH)}\n</request>`,
    maxTokens: 30,
    effort: 'low',
    timeoutMs: 15_000,
  })

  if (!reply.isAnswered) {
    return
  }

  const title = cleanTitle(reply.text)

  if (title === null) {
    return
  }

  await serialize(async () => {
    const path = recordPath(await historyDir($), id)
    const current = await readRecord($, path)

    if (current === null || current.nameSource !== 'prompt') {
      return
    }

    await writeRecord($, path, { ...current, name: title, nameSource: 'generated' })
  })
}
```

   Add `labelSession` below it:

```ts
/**
 * Labels an ending session complete or pending from the end of its conversation, within what the exit leaves.
 *
 * Sessions without a record (headless runs) or without a prompt are left alone; a skipped or unusable answer
 * leaves the session unlabeled, so `/sessions` keeps listing it, and says why in the debug log.
 */
async function labelSession($: Engine, id: string, context: LabelContext): Promise<void> {
  const path = recordPath(await historyDir($), id)
  const record = await readRecord($, path)

  if (record === null || record.lastMessageAt === null) {
    return
  }

  const messages = await $.session.messages({ as: 'api' })
  const excerpt = conversationExcerpt(messages.flatMap(message => excerptLine(message.role, message.content) ?? []))

  if (excerpt === '') {
    $.ui.log(`session-history: ${id} has no conversation text to label`, { to: 'debug' })

    return
  }

  const timeoutMs = labelTimeoutMs(context.remainingMs())

  if (timeoutMs === null) {
    $.ui.log(`session-history: no time left to label ${id} (${Math.floor(context.remainingMs())} ms)`, { to: 'debug' })

    return
  }

  const reply = await $.model.complete(
    { model: LABEL_MODEL, ...labelPrompt(excerpt), maxTokens: 5, effort: 'low', timeoutMs },
    { signal: context.signal },
  )

  if (!reply.isAnswered) {
    $.ui.log(`session-history: labeling ${id} got no answer (${reply.reason})`, { to: 'debug' })

    return
  }

  const status = parseLabel(reply.text)

  if (status === null) {
    $.ui.log(`session-history: labeling ${id} got an unexpected reply: ${JSON.stringify(reply.text.slice(0, 200))}`, {
      to: 'debug',
    })

    return
  }

  await context.serialize(async () => {
    const current = await readRecord($, path)

    if (current !== null) {
      await writeRecord($, path, { ...current, status })
    }
  })
}
```

4. Replace `reportFailure` with:

```ts
/**
 * Logs a failed history hook, to the transcript unless `to` says otherwise; the event itself goes on, so a lost
 * entry never blocks a session.
 */
function reportFailure($: Engine, what: string, error: HookFailure, to: UiLogSink = 'transcript') {
  if (error.kind !== 're-entry') {
    $.ui.log(`session-history: ${what} failed (${error.kind}): ${error.message ?? 'no message'}`, { to })
  }
}
```

5. In the `prompt.submit` hook, replace the naming call inside `$.clock.after(0, ...)` with:

```ts
      $.clock.after(0, () => {
        generateName($, id, prompt, serialized).catch(error => {
          $.ui.log(`session-history: naming the session failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      })
```

6. Add the hook after the `prompt.submit` hook:

```ts
  on('session.end', async ($, e, next) => {
    await labelSession($, e.sessionId, {
      remainingMs: () => next.budget.remainingMs,
      signal: next.signal,
      serialize: serialized,
    })

    return next(e)
  }).catch(($, e, next) => {
    reportFailure($, 'labeling the session', next.error, 'debug')

    return next(e)
  })
```

- [ ] **Step 4: Run the tests and the type check**

Run: `claude plugin test . && npx -p typescript tsc -p .`
Expected: `30 pass`, `0 fail`; tsc exits 0. If the `deny` test fails because `model.complete` doesn't take
`{ deny }`, use `() => { throw new Error('offline') }` as its answer and keep the assertions.

- [ ] **Step 5: Commit**

```bash
git add hooks/register.tsx tests/session-history.test.ts
git commit -F - <<'EOF'
Label sessions complete or pending when they close

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Hide finished sessions in `/sessions`, with a toggle

**Files:**
- Modify: `types/index.d.ts` (`SessionHistoryView`, `PluginState`)
- Modify: `hooks/history.ts` (list helpers)
- Modify: `hooks/register.tsx` (`loadView`, `listAsText`, the `sessions` command, the pane)
- Test: `tests/session-history.test.ts`

**Interfaces:**
- Consumes:
  - `END_LIMIT_VARIABLE` and `limitWarning` (Task 3).
  - `SessionRecord.status` (Task 1).
- Produces:
  - `visibleSessions(sessions, filter, showFinished): { rows: SessionRecord[]; finished: number }`.
  - `statusMarker(record): string`.
  - `parseSessionsArgs(args): { filter: string; showAll: boolean }`.
  - `SessionHistoryView.warning: string | null`.
  - `PluginState['session-history'].showFinished: boolean`.

- [ ] **Step 1: Write the failing tests**

Add `parseSessionsArgs` and `visibleSessions` to the `'../hooks/history'` import. Add these to `describe('helpers')`:

```ts
  test('should list finished sessions only when asked and count the ones it hid', async () => {
    const sessions = [
      record({ id: 'open', name: 'Open work', status: 'pending' }),
      record({ id: 'done', name: 'Done work', status: 'complete' }),
      record({ id: 'new', name: 'New work' }),
    ]

    expect(visibleSessions(sessions, '', false)).toEqual({ rows: [sessions[0], sessions[2]], finished: 1 })
    expect(visibleSessions(sessions, '', true)).toEqual({ rows: sessions, finished: 1 })
    expect(visibleSessions(sessions, 'done', false)).toEqual({ rows: [], finished: 1 })
    expect(visibleSessions(sessions, 'open', false)).toEqual({ rows: [sessions[0]], finished: 0 })
  })

  test('should read --all out of the /sessions arguments', async () => {
    expect(parseSessionsArgs('  deploy  fix ')).toEqual({ filter: 'deploy fix', showAll: false })
    expect(parseSessionsArgs('--all deploy')).toEqual({ filter: 'deploy', showAll: true })
    expect(parseSessionsArgs('')).toEqual({ filter: '', showAll: false })
  })
```

Add these to `describe('/sessions')`:

```ts
  test('should hide finished sessions until the toggle shows them', async ($, on) => {
    const { files } = setup(on, { cwd: '/work/a', sessionId: 'current' })
    const resumed: string[] = []

    seed(files, record({ id: 'open', name: 'Open work', status: 'pending', lastMessageAt: '2026-10-11T09:30:00.000Z' }), 1)
    seed(files, record({ id: 'done', name: 'Done work', status: 'complete', lastMessageAt: '2026-10-11T09:00:00.000Z' }), 2)
    seed(files, record({ id: 'new', name: 'Unlabeled work', lastMessageAt: '2026-10-11T08:00:00.000Z' }), 3)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', () => ({ value: undefined }))
    on('command.run', { command: 'resume' }, ($, e) => {
      resumed.push(e.args)

      return { text: '' }
    })

    await $.session.start({ cwd: '/work/a', surface: 'terminal', isInteractive: true })
    await $.command.run({ ...TYPED, command: 'sessions', args: '' })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const keys = async () => (await ui.findAll({ type: 'Button' })).map(row => row.key)
    const toggle = async () => (await ui.findAll({ key: 'toggle-finished' }))[0]?.text

    expect(await keys()).toEqual(['toggle-finished', 'session:open', 'session:new'])
    expect(await toggle()).toBe('Show 1 finished')
    expect(await ui.findAll({ text: /CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS/ })).toEqual([])

    await ui.press({ key: 'toggle-finished' })

    expect(await keys()).toEqual(['toggle-finished', 'session:open', 'session:done', 'session:new'])
    expect(await toggle()).toBe('Hide finished')

    await ui.press({ key: 'toggle-finished' })
    await ui.input({ key: 'filter', text: 'done', kind: 'change' })

    expect(await keys()).toEqual(['toggle-finished'])
    expect(await toggle()).toBe('Show 1 finished')

    await ui.input({ key: 'filter', text: 'done', kind: 'submit' })

    expect(resumed).toEqual([])

    await ui.unmount()
  })

  test('should warn while the exit bound is too short and list finished sessions with --all', async ($, on) => {
    const { files } = setup(on, { cwd: '/work/a', sessionId: 'current', env: {} })

    seed(files, record({ id: 'here', name: 'Here session' }), 1)
    seed(files, record({ id: 'done', name: 'Done session', status: 'complete' }), 2)
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface' } }))

    const listed = await $.command.run({ ...TYPED, command: 'sessions', args: '' })
    const all = await $.command.run({ ...TYPED, command: 'sessions', args: '--all done' })

    expect(listed.text).toBe(
      [
        limitWarning(undefined),
        'Sessions, most recent first (1 total):',
        '1. Here session (/work/a · 1h ago · started 1d ago)',
        '   /resume here',
        '1 finished sessions hidden; /sessions --all lists them.',
      ].join('\n'),
    )
    expect(all.text).toBe(
      [
        limitWarning(undefined),
        'Sessions, most recent first (1 total):',
        '1. ✓ Done session (/work/a · 1h ago · started 1d ago)',
        '   /resume done',
      ].join('\n'),
    )
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test .`
Expected: FAIL. `visibleSessions` and `parseSessionsArgs` aren't exported, the pane has no toggle, and the text
listing has neither the warning nor the hidden-count line.

- [ ] **Step 3: Implement the helpers and types**

In `types/index.d.ts`, add this to `SessionHistoryView` after `unreadable`:

```ts
  /** Why sessions are not being labeled at close, while the exit bound is too short; null when it is long enough. */
  warning: string | null
```

and to `PluginState['session-history']`:

```ts
      showFinished: boolean
```

In `hooks/history.ts`, add these below `matchesFilter`:

```ts
/**
 * What `/sessions` lists for `filter`: the matching sessions, finished ones only when `showFinished`, and how many
 * finished ones matched.
 */
export function visibleSessions(
  sessions: readonly SessionRecord[],
  filter: string,
  showFinished: boolean,
): { rows: SessionRecord[]; finished: number } {
  const matching = sessions.filter(record => matchesFilter(record, filter))
  const finished = matching.filter(record => record.status === 'complete').length

  return { rows: showFinished ? matching : matching.filter(record => record.status !== 'complete'), finished }
}

export function statusMarker(record: SessionRecord): string {
  if (record.status === 'pending') {
    return '•'
  }

  return record.status === 'complete' ? '✓' : ' '
}

/**
 * `/sessions` arguments: an `--all` token lists finished sessions too; the other words are the filter.
 */
export function parseSessionsArgs(args: string): { filter: string; showAll: boolean } {
  const words = args.trim().split(/\s+/).filter(word => word !== '')

  return { filter: words.filter(word => word !== '--all').join(' '), showAll: words.includes('--all') }
}
```

- [ ] **Step 4: Implement the command and the pane**

In `hooks/register.tsx`:

1. Add `parseSessionsArgs`, `statusMarker` and `visibleSessions` to the `./history` import. Remove
   `matchesFilter`, which nothing uses any more. Extend the `./label` import with `END_LIMIT_VARIABLE` and
   `limitWarning`.
2. Add the atom below `filterAtom`:

```ts
const showFinishedAtom = atom({ plugin: 'session-history', key: 'showFinished' } as const, false)
```

3. In `loadView`, add this to the `view` literal after `unreadable: [],`:

```ts
    warning: limitWarning(await $.env.get(END_LIMIT_VARIABLE)),
```

4. Replace `listAsText` with:

```ts
function listAsText(view: SessionHistoryView, rows: SessionRecord[], hiddenFinished: number): string {
  const lines = rows.slice(0, MAX_TEXT_ROWS).flatMap((record, index) => [
    `${index + 1}. ${record.status === null ? '' : `${statusMarker(record)} `}${record.name ?? record.id} (${describe(record, view)})`,
    `   ${record.cwd === view.currentCwd ? `/resume ${record.id}` : resumeCommand(record)}`,
  ])

  return [
    ...(view.warning === null ? [] : [view.warning]),
    ...(rows.length === 0
      ? ['No sessions in the history match.']
      : [`Sessions, most recent first (${rows.length} total):`, ...lines]),
    ...(hiddenFinished === 0 ? [] : [`${hiddenFinished} finished sessions hidden; /sessions --all lists them.`]),
  ].join('\n')
}
```

5. Replace the `command.run` `{ command: 'sessions' }` hook body with:

```ts
  on('command.run', { command: 'sessions' }, async ($, e) => {
    const view = await loadView($)
    const { filter, showAll } = parseSessionsArgs(e.args)
    const { rows, finished } = visibleSessions(view.sessions, filter, showAll)

    await update($, viewAtom, () => view)
    await update($, filterAtom, () => filter)
    await update($, showFinishedAtom, () => showAll)

    if (view.unreadable.length > 0) {
      $.ui.toast(`Skipped ${view.unreadable.length} unreadable history file(s): ${view.unreadable.join(', ')}`)
    }

    const opened = await $.ui.open({ id: PANE, title: 'Sessions', focus: true, closeOnEscape: true })

    if (!opened.isPlaced) {
      return { text: listAsText(view, rows, showAll ? 0 : finished) }
    }

    return { text: `Listed ${rows.length} earlier sessions. Pick one to resume; Esc closes the list.` }
  })
```

6. Replace the `ui.render` Pane hook with:

```tsx
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const filter = await read($, filterAtom)
    const showFinished = await read($, showFinishedAtom)

    if (view === null) {
      return <Text dimColor>Run /sessions to load the session history.</Text>
    }

    const width = e.props.bodyColumns
    const { rows, finished } = visibleSessions(view.sessions, filter, showFinished)
    const shown = rows.slice(0, MAX_ROWS)
    const nameWidth = Math.min(48, Math.max(12, Math.floor(width * 0.45)))
    let filterInput = null

    if (e.surface !== 'mobile') {
      const { Input } = $.ui.resolve(e)

      filterInput = (
        <Input
          key="filter"
          label="Filter"
          placeholder="name, directory or id; Enter resumes the first match"
          value={filter}
          autoFocus
          onInput={value => update($, filterAtom, () => value)}
          onSubmit={(value, input) => {
            const first = visibleSessions(view.sessions, value, showFinished).rows[0]

            return first === undefined ? undefined : resume($, first, view, input.surface)
          }}
        />
      )
    }

    return (
      <Box flexDirection="column">
        {filterInput}
        {view.warning !== null && <Text color="yellow">{fit(view.warning, width * 3)}</Text>}
        {finished > 0 && (
          <Button key="toggle-finished" onPress={() => update($, showFinishedAtom, isShown => !isShown)}>
            {showFinished ? 'Hide finished' : `Show ${finished} finished`}
          </Button>
        )}
        <Text dimColor>
          {fit(`${shown.length} sessions · • pending · ✓ finished · ↗ other directory, copies a resume command`, width)}
        </Text>
        {shown.length === 0 && <Text dimColor>No sessions match.</Text>}
        {shown.map(record => {
          const marker = `${statusMarker(record)}${record.cwd === view.currentCwd ? ' ' : '↗'} `
          const name = fit(record.name ?? record.id, nameWidth).padEnd(nameWidth)

          return (
            <Button key={`session:${record.id}`} plain onPress={press => resume($, record, view, press.surface)}>
              {marker}
              {name}
              <Text dimColor> {fit(describe(record, view), Math.max(0, width - nameWidth - 4))}</Text>
            </Button>
          )
        })}
      </Box>
    )
  })
```

- [ ] **Step 5: Run the tests and the type check**

Run: `claude plugin test . && npx -p typescript tsc -p .`
Expected: `34 pass`, `0 fail`; tsc exits 0. The earlier `/sessions` tests still pass. Their sessions are unlabeled, so
no toggle is drawn, and `setup` raises the exit bound, so no warning is shown.

- [ ] **Step 6: Commit**

```bash
git add types/index.d.ts hooks/history.ts hooks/register.tsx tests/session-history.test.ts
git commit -F - <<'EOF'
Hide finished sessions in /sessions behind a toggle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: `backfill.mjs --label`

**Files:**
- Modify: `scripts/backfill.mjs`

**Interfaces:**
- Consumes:
  - `conversationExcerpt` and `TranscriptSummary.tail` (Task 2).
  - `labelPrompt`, `parseLabel` and `LABEL_MODEL` from `../hooks/label.ts` (Task 3).
  - `SessionRecord.status` (Task 1).

The script has no unit-test harness. Its logic is the tested helpers, and Step 2 verifies the discovery and
excerpt wiring with a dry run.

The first real label call runs in Task 8 Step 8, against the real history. It can't run here against a throwaway
`CLAUDE_CONFIG_DIR`: the spawned `claude -p` would inherit that directory and lose its login. Labeling is
idempotent: it only touches `status: null` records and writes a status only after a valid reply. So a failure there
is fixed and rerun.

- [ ] **Step 1: Replace `scripts/backfill.mjs`**

```js
// Fills the session history from the transcripts Claude Code keeps under `<config dir>/projects`, so sessions
// from before the plugin recorded them can be found and resumed with /sessions. With --label it then asks Haiku,
// through `claude -p`, to label every session still unlabeled complete or pending, as the plugin does at close.
//
// Usage: node scripts/backfill.mjs [--dry-run] [--label]      (Node 23.6 or later: it imports the plugin's TypeScript)
//
// A session the history already holds keeps its better name, widest span and label (mergeRecords). Each written
// file's modification time is set to the session's last message, the order /sessions reads the history in.

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'

import {
  addTranscriptEntry,
  assertSessionId,
  conversationExcerpt,
  emptyTranscriptSummary,
  mergeRecords,
  parseRecord,
  recordFromTranscript,
} from '../hooks/history.ts'
import { LABEL_MODEL, labelPrompt, parseLabel } from '../hooks/label.ts'

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/
const LABEL_CONCURRENCY = 4
const LABEL_TIMEOUT_MS = 60_000

const isDryRun = process.argv.includes('--dry-run')
const isLabeling = process.argv.includes('--label')
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const projectsDir = join(configDir, 'projects')
const historyDir = join(configDir, 'session-history')

/**
 * Reads a transcript line by line; a line that is not JSON (a write cut short) is counted, not read.
 */
async function summarizeTranscript(path) {
  const summary = emptyTranscriptSummary()
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  let malformed = 0

  for await (const line of lines) {
    if (line.trim() === '') {
      continue
    }

    let entry

    try {
      entry = JSON.parse(line)
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error
      }

      malformed += 1
      continue
    }

    addTranscriptEntry(summary, entry)
  }

  return { summary, malformed }
}

async function readExisting(path) {
  try {
    return parseRecord(await readFile(path, 'utf8'), path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

function serialize(record) {
  return `${JSON.stringify(record, null, 2)}\n`
}

async function writeRecord(path, record) {
  const lastMessage = new Date(record.lastMessageAt ?? record.createdAt)

  await mkdir(historyDir, { recursive: true })
  await writeFile(path, serialize(record))
  await utimes(path, lastMessage, lastMessage)
}

/**
 * One `claude -p` call with no tools, MCP servers, user settings or skills: the reply's text.
 */
function askClaude(system, prompt, cwd) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--model', LABEL_MODEL,
      '--no-session-persistence',
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', 'project',
      '--disable-slash-commands',
      '--system-prompt', system,
    ]
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: LABEL_TIMEOUT_MS })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(stdout)
      } else if (signal !== null) {
        reject(new Error(`claude was stopped by ${signal} (${LABEL_TIMEOUT_MS / 1000} s limit)`))
      } else {
        reject(new Error(`claude exited ${code}: ${stderr.trim().slice(0, 300)}`))
      }
    })
    child.stdin.end(prompt)
  })
}

async function label(item, cwd) {
  const { system, prompt } = labelPrompt(item.excerpt)
  const reply = await askClaude(system, prompt, cwd)
  const status = parseLabel(reply)

  if (status === null) {
    throw new Error(`unexpected reply ${JSON.stringify(reply.trim().slice(0, 100))}`)
  }

  const current = parseRecord(await readFile(item.target, 'utf8'), item.target)

  await writeRecord(item.target, { ...current, status })

  return status
}

/**
 * Labels `items` a few at a time, printing each result as it comes.
 */
async function labelAll(items) {
  const cwd = await mkdtemp(join(tmpdir(), 'session-history-label-'))
  const results = { complete: 0, pending: 0, failed: [] }
  let next = 0

  async function worker() {
    while (next < items.length) {
      const item = items[next]

      next += 1

      try {
        const status = await label(item, cwd)

        results[status] += 1
        console.log(`${status.padEnd(8)} ${item.name}`)
      } catch (error) {
        results.failed.push(`${item.id}: ${error.message}`)
        console.log(`failed   ${item.name}`)
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: LABEL_CONCURRENCY }, worker))
  } finally {
    await rm(cwd, { recursive: true })
  }

  return results
}

const counts = { created: 0, updated: 0, unchanged: 0 }
const skipped = new Map()
const problems = []
const toLabel = []
const folders = (await readdir(projectsDir, { withFileTypes: true })).filter(entry => entry.isDirectory())

for (const folder of folders) {
  const transcripts = (await readdir(join(projectsDir, folder.name))).filter(name => SESSION_FILE.test(name))

  for (const file of transcripts) {
    const id = assertSessionId(basename(file, '.jsonl'))
    const transcript = join(projectsDir, folder.name, file)
    const { summary, malformed } = await summarizeTranscript(transcript)

    if (malformed > 0) {
      problems.push(`${transcript}: skipped ${malformed} line(s) that are not JSON`)
    }

    const result = recordFromTranscript(id, folder.name, summary)

    if ('skip' in result) {
      skipped.set(result.skip, (skipped.get(result.skip) ?? 0) + 1)
      continue
    }

    if (result.isCwdGuessed) {
      problems.push(`${transcript}: no directory it names matches its folder; using ${result.record.cwd}`)
    }

    const target = join(historyDir, `${id}.json`)
    let existing

    try {
      existing = await readExisting(target)
    } catch (error) {
      problems.push(`${target}: left as it is, it could not be read (${error.message})`)
      continue
    }

    const merged = mergeRecords(existing, result.record)

    if (isLabeling && merged.status === null) {
      const excerpt = conversationExcerpt(summary.tail)

      if (excerpt === '') {
        problems.push(`${transcript}: no conversation text to label`)
      } else {
        toLabel.push({ id, target, excerpt, name: merged.name ?? id })
      }
    }

    if (existing !== null && serialize(existing) === serialize(merged)) {
      counts.unchanged += 1
      continue
    }

    counts[existing === null ? 'created' : 'updated'] += 1

    if (isDryRun) {
      console.log(`${existing === null ? 'create' : 'update'}  ${merged.lastMessageAt}  ${merged.name ?? id}  (${merged.cwd})`)
      continue
    }

    await writeRecord(target, merged)
  }
}

const verb = isDryRun ? 'Would write' : 'Wrote'

console.log(`${verb} ${counts.created} new and ${counts.updated} updated session(s) to ${historyDir}; ${counts.unchanged} unchanged.`)

for (const [reason, count] of skipped) {
  console.log(`Skipped ${count} transcript(s): ${reason}`)
}

if (isLabeling && isDryRun) {
  console.log(`Would label ${toLabel.length} session(s).`)
} else if (isLabeling) {
  const results = await labelAll(toLabel)

  console.log(`Labeled ${results.complete} complete and ${results.pending} pending; ${results.failed.length} failed.`)

  for (const failure of results.failed) {
    problems.push(`label ${failure}`)
  }
}

for (const problem of problems) {
  console.warn(`warning: ${problem}`)
}
```

- [ ] **Step 2: Dry-run against the real history**

Run: `node scripts/backfill.mjs --label --dry-run | tail -5`
Expected:
- `Would write 0 new and N updated session(s) …`. The updates are records gaining `status: null`, because records
  without the field serialize differently now.
- `Would label M session(s).` M should be roughly the history size, about 140.
- No stack trace.

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill.mjs
git commit -F - <<'EOF'
Label unlabeled sessions from their transcripts with backfill --label

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

a) In **What it does**, add these bullets after the naming bullet:

```markdown
- Labels a session **complete** or **pending** when it closes (`/exit`, Ctrl+C, closing the tab, `/clear`,
  `/resume`): Haiku reads the end of the conversation and calls it pending when a question to you is unanswered,
  requested work is unfinished, or Claude said it would do something next. A new prompt clears the label.
- `/sessions` hides complete sessions. **Show N finished** in the list shows them again, and `/sessions --all`
  includes them in the text listing. Pending sessions are marked `•`, complete ones `✓`.
```

b) In **Install**, add this after the `ln -s` block:

````markdown
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
````

c) In **Backfill**, add this after the existing paragraph:

````markdown
`--label` then labels every session that has no label yet, one `claude -p --model haiku` call each, four at a
time:

```sh
node scripts/backfill.mjs --label --dry-run   # count the sessions it would label
node scripts/backfill.mjs --label
```
````

d) In **Limitations**, add:

```markdown
- A session whose process is killed (or that crashes) gets no label at close and stays listed; the next
  `backfill.mjs --label` labels it.
```

- [ ] **Step 2: Validate**

Run: `claude plugin validate .`
Expected: `✔ Validation passed`. The marketplace-install warning that was already there may remain.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -F - <<'EOF'
Document session labels, the exit time setting and backfill --label

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 8: Merge, configure, verify in real sessions, label the history

**Files:**
- Modify: `~/.claude/settings.json` (`env`)
- Create (scratch, not committed): `$SCRATCH/probe.exp`

- [ ] **Step 1: Run the full checks in the worktree**

Run: `claude plugin validate . && claude plugin test . && npx -p typescript tsc -p .`
Expected: validation passes, `34 pass`, `0 fail`, and tsc exits 0.

- [ ] **Step 2: Fast-forward master**

```bash
cd ~/Projects/personal/claude-session-history
git merge --ff-only session-status
git worktree remove ../claude-session-history-status
git branch -d session-status
```

Open sessions now hot-reload the new code.

- [ ] **Step 3: Write the probe script**

Use the session's scratchpad directory for `$SCRATCH`. Create `$SCRATCH/probe.exp`:

```tcl
#!/usr/bin/expect -f
# Usage: expect probe.exp <dir> <prompt> <ending: /exit or /clear>
# Starts an interactive session in <dir>, sends one prompt, ends it, and prints how long the ending took.
set timeout 120
set dir [lindex $argv 0]
set prompt [lindex $argv 1]
set ending [lindex $argv 2]
cd $dir
spawn claude --model haiku --debug
expect {
  -timeout 15
  -re "(?i)trust" { send "\r" }
  timeout {}
}
sleep 8
send -- "$prompt\r"
sleep 25
set start [clock milliseconds]
send -- "$ending\r"
if {$ending eq "/clear"} {
  sleep 12
  send -- "/exit\r"
}
expect eof
puts "\nending took [expr {[clock milliseconds] - $start}] ms"
```

- [ ] **Step 4: Check A, without the setting**

```bash
PROBE="$SCRATCH/label-probe-a" && mkdir -p "$PROBE"
echo /sessions | claude -p 2>&1 | head -2
expect "$SCRATCH/probe.exp" "$PROBE" "Ask me whether I prefer tea or coffee. Do not use any tools." /exit | tail -1
F=$(grep -l "label-probe-a" ~/.claude/session-history/*.json) && cat "$F"
grep -h "session-history" ~/.claude/debug/"$(basename "$F" .json)".txt | tail -5
```

Expected:
- The `claude -p /sessions` output starts with the `Sessions are labeled complete or pending when they close…`
  warning.
- The ending took under about 2,500 ms.
- The record has `"status": null` with a debug line saying why (`no time left`, `no answer (aborted)` or
  `labeling the session failed (timeout)`), or a label if Haiku answered within the 1.5 s.

- [ ] **Step 5: Add the setting**

Read `~/.claude/settings.json`. Add `"CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS": "10000"` inside `env`, creating
`env` if it's missing. Keep every other key as it is. Then run:

Run: `echo /sessions | claude -p 2>&1 | head -2`
Expected: no warning line. That shows the settings `env` reaches `$.env.get`.

- [ ] **Step 6: Check B, pending at `/exit`, complete at `/clear`**

```bash
PROBE="$SCRATCH/label-probe-b" && mkdir -p "$PROBE"
expect "$SCRATCH/probe.exp" "$PROBE" "Ask me whether I prefer tea or coffee. Do not use any tools." /exit | tail -1
grep -h '"status"' $(grep -l "label-probe-b" ~/.claude/session-history/*.json)
PROBE="$SCRATCH/label-probe-c" && mkdir -p "$PROBE"
expect "$SCRATCH/probe.exp" "$PROBE" "What is 2 + 2? Answer with just the number. Do not use any tools." /clear | tail -1
grep -h '"status"' $(grep -l "label-probe-c" ~/.claude/session-history/*.json)
```

Expected:
- `label-probe-b` has `"status": "pending"`, and its ending took under 10,000 ms.
- `label-probe-c` has `"status": "complete"`. That's the conversation `/clear` ended. The session after the clear
  has no prompt, so it has no record, or a record without a label.

If a check fails:
1. Read the probe session's debug log (`grep session-history ~/.claude/debug/<id>.txt`).
2. Fix on master with a failing test first.
3. Rerun the check.
4. After three failed attempts, stop and report.

- [ ] **Step 7: Remove the probe sessions**

```bash
grep -l "label-probe-" ~/.claude/session-history/*.json
```

Look at the listed files: they must be only the probe records. Then delete them, along with the probe transcripts'
project folders:

```bash
grep -l "label-probe-" ~/.claude/session-history/*.json | xargs rm
command ls -d ~/.claude/projects/*label-probe-*
rm -rf ~/.claude/projects/*label-probe-*
```

- [ ] **Step 8: Label the history**

```bash
cd ~/Projects/personal/claude-session-history
node scripts/backfill.mjs --label | tail -15
```

Expected: `Labeled X complete and Y pending; Z failed.`, where X + Y is roughly the history size. Report the counts
and any failures, plus five pending session names for the user to sanity-check.

- [ ] **Step 9: Confirm the repo is clean and ask before pushing**

Run: `git -C ~/Projects/personal/claude-session-history status --short --branch`
Expected: clean, ahead of `origin/master`. Don't push. Ask the user, since the repository is public.
