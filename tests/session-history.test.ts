import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SessionRecord } from '../types'
import {
  addTranscriptEntry,
  cleanTitle,
  conversationExcerpt,
  emptyTranscriptSummary,
  excerptLine,
  labelFailureWarning,
  mergeRecords,
  nameFromPrompt,
  parseRecord,
  parseSessionsArgs,
  projectFolderName,
  recordFromTranscript,
  relativeTime,
  resumeCommand,
  summarizeTranscriptText,
  visibleSessions,
} from '../hooks/history'
import type { ExcerptLine, TranscriptSummary } from '../hooks/history'
import { labelPrompt, labelTimeoutMs, limitWarning, parseLabel } from '../hooks/label'

const HOME = '/home/tester'
const DIR = `${HOME}/.claude/session-history`
const START = Date.parse('2026-10-11T10:00:00.000Z')
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const TYPED_PROMPT = { wait: false, origin: { kind: 'composer' } } as const

type File = { text: string; mtimeMs: number }

/**
 * Answers `$.fs` from memory, beneath the plugin.
 */
function memoryFs(on: On): Map<string, File> {
  const files = new Map<string, File>()
  let tick = 0

  on('fs.write', ($, e) => {
    tick += 1
    files.set(e.path, { text: e.text, mtimeMs: tick })

    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const file = files.get(e.path)

    return file === undefined ? { deny: `ENOENT: ${e.path}` } : { value: file.text }
  })
  on('fs.exists', ($, e) => ({
    value: files.has(e.path) || [...files.keys()].some(path => path.startsWith(`${e.path}/`)),
  }))
  on('fs.list', ($, e) => ({
    value: [...files.entries()]
      .filter(([path]) => path.startsWith(`${e.path}/`))
      .map(([path, file]) => ({
        name: path.slice(e.path.length + 1),
        kind: 'file' as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      })),
  }))

  return files
}

type Setup = {
  cwd: string
  sessionId: string
  /** When the session first launched; the clock's start unless given. */
  startedAt?: number
  /** Prompts the session had before the test's own. */
  turns?: number
  dropPrompts?: true
  /** Transcript entries by session id, kept where Claude Code keeps transcripts of sessions started at `cwd`. */
  transcripts?: Record<string, unknown[]>
  /** The environment beside HOME; the exit bound is raised to 10 s unless given. */
  env?: Record<string, string>
}

/**
 * The engine beneath the plugin: a session at `cwd` whose prompts enter (or are dropped) and are counted.
 */
function setup(on: On, options: Setup) {
  const files = memoryFs(on)
  const clock = mock.clock(on, { now: START })
  let turns = options.turns ?? 0
  const logs: string[] = []

  mock.env(on, { HOME, ...(options.env ?? { CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: '10000' }) })
  on('session.root', () => ({ value: options.cwd }))
  on('session.id', () => ({ value: options.sessionId }))
  on('session.usage', () => ({
    value: { startedAt: options.startedAt ?? START, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('session.turns', () => ({ value: turns }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('process.run', ($, e) => {
    const [command, flag, bytes, path] = e.argv
    const file = path === undefined ? undefined : files.get(path)

    if (command !== 'tail' || flag !== '-c' || file === undefined) {
      return { value: { exitCode: 1, stdout: '', stderr: `tail: ${path}: No such file or directory`, isStdoutTruncated: false, isStderrTruncated: false } }
    }

    return { value: { exitCode: 0, stdout: file.text.slice(-Number(bytes)), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.log', ($, e) => {
    logs.push(`${e.to}: ${e.text}`)

    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => {
    if (options.dropPrompts) {
      return { drop: 'not allowed' }
    }

    turns += 1

    return { text: e.text }
  })

  for (const [id, entries] of Object.entries(options.transcripts ?? {})) {
    files.set(`${HOME}/.claude/projects/${projectFolderName(options.cwd)}/${id}.jsonl`, {
      text: entries.map(entry => `${JSON.stringify(entry)}\n`).join(''),
      mtimeMs: 0,
    })
  }

  return { files, clock, logs }
}

function summarize(entries: unknown[]): TranscriptSummary {
  const summary = emptyTranscriptSummary()

  for (const entry of entries) {
    addTranscriptEntry(summary, entry)
  }

  return summary
}

function readRecord(files: Map<string, File>, id: string): SessionRecord {
  const file = files.get(`${DIR}/${id}.json`)

  if (file === undefined) {
    throw new Error(`no history file for ${id}`)
  }

  return JSON.parse(file.text) as SessionRecord
}

function seed(files: Map<string, File>, record: SessionRecord, mtimeMs: number) {
  files.set(`${DIR}/${record.id}.json`, { text: JSON.stringify(record), mtimeMs })
}

function record(overrides: Partial<SessionRecord> & Pick<SessionRecord, 'id'>): SessionRecord {
  return {
    name: null,
    nameSource: null,
    cwd: '/work/a',
    createdAt: '2026-10-10T08:00:00.000Z',
    lastMessageAt: '2026-10-11T09:00:00.000Z',
    messageCount: 3,
    status: null,
    labelError: null,
    ...overrides,
  }
}

describe('helpers', () => {
  test('should name a session after the first non-empty line of its prompt', async () => {
    expect(nameFromPrompt('\n  Fix   the flaky webhook test\nmore detail')).toBe('Fix the flaky webhook test')
    expect(nameFromPrompt('/sessions')).toBe(null)
    expect(nameFromPrompt('   ')).toBe(null)
    expect(nameFromPrompt('x'.repeat(80))).toBe(`${'x'.repeat(59)}…`)
  })

  test('should clean a model title reply', async () => {
    expect(cleanTitle('"Session history plugin."\nextra')).toBe('Session history plugin')
    expect(cleanTitle('  ')).toBe(null)
  })

  test('should quote directories that need it in the resume command', async () => {
    expect(resumeCommand(record({ id: 'abc', cwd: '/work/b' }))).toBe('cd /work/b && claude --resume abc')
    expect(resumeCommand(record({ id: 'abc', cwd: "/work/it's here" }))).toBe(
      "cd '/work/it'\\''s here' && claude --resume abc",
    )
  })

  test('should describe times relative to now', async () => {
    expect(relativeTime('2026-10-11T09:58:30.000Z', START)).toBe('1m ago')
    expect(relativeTime('2026-10-11T07:00:00.000Z', START)).toBe('3h ago')
    expect(relativeTime('2026-10-08T10:00:00.000Z', START)).toBe('3d ago')
    expect(relativeTime('2026-08-01T10:00:00.000Z', START)).toBe('2026-08-01')
  })

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

  test('should say how many sessions a close could not label, and the latest reason', async () => {
    expect(labelFailureWarning([record({ id: 'a' }), record({ id: 'b', status: 'complete' })])).toBe(null)
    expect(
      labelFailureWarning([
        record({ id: 'older', labelError: 'no answer (api-error)', lastMessageAt: '2026-10-11T08:00:00.000Z' }),
        record({ id: 'newer', labelError: 'throw: model not allowed', lastMessageAt: '2026-10-11T09:00:00.000Z' }),
      ]),
    ).toBe(
      '2 sessions could not be labeled when they closed (latest: throw: model not allowed). They stay listed; '
        + 'node scripts/backfill.mjs --label retries them.',
    )
  })
})

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
    expect(
      excerptLine('user', [
        {
          type: 'text',
          text: 'This session is being continued from a previous conversation that ran out of context. The summary '
            + 'below covers the earlier portion.\n\n9. Optional Next Step: push the branch',
        },
      ]),
    ).toBe(null)
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

  test('should read the end of a transcript cut in the middle of a line', async () => {
    const text = [
      'ext": "the rest of a line tail cut in half"}]}}',
      JSON.stringify({ type: 'user', timestamp: '2026-10-01T09:30:00.000Z', message: { content: 'Ship it' } }),
      '{"type": "assistant", "message": {"content": [{"type": "text", "text": "Ship',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Shipped.' }] } }),
      '',
    ].join('\n')

    expect(summarizeTranscriptText(text).tail).toEqual([
      { role: 'user', text: 'Ship it' },
      { role: 'assistant', text: 'Shipped.' },
    ])
  })
})

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

describe('recording', () => {
  test('should record a session on start and update it on every prompt', async ($, on) => {
    const { files, clock } = setup(on, { cwd: '/work/a', sessionId: 's1' })
    const asked: string[] = []

    on('model.complete', ($, e) => {
      asked.push(e.prompt)

      return { value: { isAnswered: true, text: '"Session history plugin."', usage: USAGE } }
    })

    await $.session.start({ cwd: '/work/a', surface: 'terminal', isInteractive: true })

    expect(readRecord(files, 's1')).toEqual({
      id: 's1',
      name: null,
      nameSource: null,
      cwd: '/work/a',
      createdAt: '2026-10-11T10:00:00.000Z',
      lastMessageAt: null,
      messageCount: 0,
      status: null,
      labelError: null,
    })

    await clock.advance(60_000)
    await $.prompt.submit({
      ...TYPED_PROMPT,
      text: 'I want to build a plugin that keeps a session history\nwith details',
    })

    expect(readRecord(files, 's1')).toEqual({
      id: 's1',
      name: 'I want to build a plugin that keeps a session history',
      nameSource: 'prompt',
      cwd: '/work/a',
      createdAt: '2026-10-11T10:00:00.000Z',
      lastMessageAt: '2026-10-11T10:01:00.000Z',
      messageCount: 1,
      status: null,
      labelError: null,
    })

    await clock.advance(1)

    expect(asked).toHaveLength(1)
    expect(readRecord(files, 's1')).toEqual({
      id: 's1',
      name: 'Session history plugin',
      nameSource: 'generated',
      cwd: '/work/a',
      createdAt: '2026-10-11T10:00:00.000Z',
      lastMessageAt: '2026-10-11T10:01:00.000Z',
      messageCount: 1,
      status: null,
      labelError: null,
    })

    await clock.advance(59_999)
    await $.prompt.submit({ ...TYPED_PROMPT, text: 'now add tests' })
    await clock.advance(1)

    expect(asked).toHaveLength(1)
    expect(readRecord(files, 's1')).toEqual({
      id: 's1',
      name: 'Session history plugin',
      nameSource: 'generated',
      cwd: '/work/a',
      createdAt: '2026-10-11T10:00:00.000Z',
      lastMessageAt: '2026-10-11T10:02:00.000Z',
      messageCount: 2,
      status: null,
      labelError: null,
    })
  })

  test('should record a session it first sees mid-way with its real start and prompt count', async ($, on) => {
    const startedAt = Date.parse('2026-10-11T08:00:00.000Z')
    const { files } = setup(on, { cwd: '/work/a', sessionId: 's1', startedAt, turns: 5 })

    await $.session.start({ cwd: '/work/a', surface: 'terminal', isInteractive: true })

    expect(readRecord(files, 's1')).toEqual({
      id: 's1',
      name: null,
      nameSource: null,
      cwd: '/work/a',
      createdAt: '2026-10-11T08:00:00.000Z',
      lastMessageAt: null,
      messageCount: 5,
      status: null,
      labelError: null,
    })
  })

  test('should keep a /rename title over the generated one', async ($, on) => {
    const { files, clock } = setup(on, { cwd: '/work/a', sessionId: 's1' })

    on('model.complete', () => ({ value: { isAnswered: true, text: 'Generated title', usage: USAGE } }))
    on('command.run', { command: 'rename' }, () => ({ text: 'Renamed.' }))

    await $.prompt.submit({ ...TYPED_PROMPT, text: 'Debug the deploy' })
    await $.command.run({ ...TYPED, command: 'rename', args: 'Deploy debugging' })
    await clock.advance(1)

    expect(readRecord(files, 's1')).toEqual({
      id: 's1',
      name: 'Deploy debugging',
      nameSource: 'renamed',
      cwd: '/work/a',
      createdAt: '2026-10-11T10:00:00.000Z',
      lastMessageAt: '2026-10-11T10:00:00.000Z',
      messageCount: 1,
      status: null,
      labelError: null,
    })
  })

  test('should not record a prompt a hook dropped', async ($, on) => {
    const { files } = setup(on, { cwd: '/work/a', sessionId: 's1', dropPrompts: true })

    await $.prompt.submit({ ...TYPED_PROMPT, text: 'Dropped prompt' })

    expect(files.size).toBe(0)
  })

  test('should not record headless sessions or prompts that are not the person\'s own', async ($, on) => {
    const { files } = setup(on, { cwd: '/work/a', sessionId: 's1' })

    await $.session.start({ cwd: '/work/a', surface: null, isInteractive: false })
    await $.prompt.submit({ ...TYPED_PROMPT, text: 'From the SDK', origin: { kind: 'sdk' } })
    await $.prompt.submit({ ...TYPED_PROMPT, text: 'A task finished', origin: { kind: 'task-notification' } })

    expect(files.size).toBe(0)
  })
  test('should clear the label when a closed session gets a new prompt', async ($, on) => {
    const { files } = setup(on, { cwd: '/work/a', sessionId: 's1', turns: 3 })

    seed(
      files,
      record({ id: 's1', name: 'Done work', nameSource: 'generated', status: 'complete', labelError: 'no answer (aborted)' }),
      1,
    )
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
})

describe('labeling at close', () => {
  const END = { reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } } as const
  const CONVERSATION = [
    { type: 'user', timestamp: '2026-10-11T09:00:00.000Z', message: { role: 'user', content: 'Create the repo on GitHub' } },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'gh repo view' } }] },
    },
    {
      type: 'user',
      timestamp: '2026-10-11T09:00:05.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'not found' }] },
    },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Should it be public or private?' }] } },
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
    const { files, logs } = setup(on, { cwd: '/work/a', sessionId: 's1', transcripts: { s1: CONVERSATION } })
    const asked = answer(on, 'Pending')

    seed(files, record({ id: 's1', name: 'GitHub repo', labelError: 'no answer (api-error)' }), 1)

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
    const { files } = setup(on, { cwd: '/work/a', sessionId: 'fresh', transcripts: { old: CONVERSATION } })

    answer(on, 'complete')
    seed(files, record({ id: 'old', name: 'Before the clear' }), 1)
    await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } })

    expect(readRecord(files, 'old').status).toBe('complete')
    expect(files.has(`${DIR}/fresh.json`)).toBe(false)
  })

  test('should not ask about headless sessions, sessions without a prompt or conversations without text', async ($, on) => {
    const toolOnly = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
      {
        type: 'user',
        timestamp: '2026-10-11T09:00:05.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      },
    ]
    const { files, logs } = setup(on, { cwd: '/work/a', sessionId: 's1', transcripts: { s1: toolOnly } })
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

  test('should keep why when the session has no transcript where its directory says', async ($, on) => {
    const { files, logs } = setup(on, { cwd: '/work/a', sessionId: 's1' })
    const asked = answer(on, 'complete')

    seed(files, record({ id: 's1' }), 1)
    await $.session.end(END)

    expect(asked).toEqual([])
    expect(readRecord(files, 's1').labelError).toBe('no transcript at /home/tester/.claude/projects/-work-a/s1.jsonl')
    expect(logs).toEqual(['debug: session-history: no transcript at /home/tester/.claude/projects/-work-a/s1.jsonl to label s1'])
  })

  test('should leave a session unlabeled and log why when the reply is not a label', async ($, on) => {
    const { files, logs } = setup(on, { cwd: '/work/a', sessionId: 's1', transcripts: { s1: CONVERSATION } })

    answer(on, 'Pending — no answer yet')
    seed(files, record({ id: 's1' }), 1)
    await $.session.end(END)

    expect(readRecord(files, 's1')).toEqual(record({ id: 's1', labelError: 'unexpected reply: "Pending — no answer yet"' }))
    expect(logs).toEqual(['debug: session-history: labeling s1 got an unexpected reply: "Pending — no answer yet"'])
  })

  test('should leave a session unlabeled and log why when the model does not answer', async ($, on) => {
    const { files, logs } = setup(on, { cwd: '/work/a', sessionId: 's1', transcripts: { s1: CONVERSATION } })

    on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: USAGE } }))
    seed(files, record({ id: 's1' }), 1)
    await $.session.end(END)

    expect(readRecord(files, 's1')).toEqual(record({ id: 's1', labelError: 'no answer (empty-reply)' }))
    expect(logs).toEqual(['debug: session-history: labeling s1 got no answer (empty-reply)'])
  })

  test('should let the session end and log the failure when labeling throws', async ($, on) => {
    const { files, logs } = setup(on, { cwd: '/work/a', sessionId: 's1', transcripts: { s1: CONVERSATION } })

    on('model.complete', () => ({ deny: 'offline' }))
    seed(files, record({ id: 's1' }), 1)

    expect(await $.session.end(END)).toEqual({ sessionId: 's1' })
    expect(readRecord(files, 's1').status).toBe(null)
    expect(readRecord(files, 's1').labelError).toContain('throw: ')
    expect(readRecord(files, 's1').labelError).toContain('offline')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('debug: session-history: labeling the session failed (throw)')
    expect(logs[0]).toContain('offline')
  })
})

describe('backfill', () => {
  test('should turn a transcript into a history record', async () => {
    const summary = summarize([
      { type: 'permission-mode', permissionMode: 'default' },
      {
        type: 'user',
        entrypoint: 'cli',
        cwd: '/work/repo/.claude/worktrees/owl',
        timestamp: '2026-10-01T09:00:00.000Z',
        message: { content: '<command-name>/model</command-name>' },
      },
      { type: 'user', isMeta: true, timestamp: '2026-10-01T09:00:01.000Z', message: { content: 'Caveat: ...' } },
      {
        type: 'user',
        timestamp: '2026-10-01T09:01:00.000Z',
        message: { content: [{ type: 'text', text: 'Fix the flaky webhook test' }] },
      },
      { type: 'assistant', timestamp: '2026-10-01T09:01:30.000Z', message: { content: [] } },
      {
        type: 'user',
        timestamp: '2026-10-01T09:02:00.000Z',
        message: { content: [{ type: 'tool_result', content: 'ok' }] },
      },
      { type: 'ai-title', aiTitle: 'Flaky webhook test fix' },
      { type: 'relocated', relocatedCwd: '/work/repo' },
      { type: 'user', isSidechain: true, timestamp: '2026-10-01T09:20:00.000Z', message: { content: 'Explore' } },
      { type: 'user', timestamp: '2026-10-01T09:30:00.000Z', message: { content: 'and the retry case' } },
      {
        type: 'user',
        timestamp: '2026-10-01T10:00:00.000Z',
        message: { content: '<task-notification>\n<task-id>1</task-id>' },
      },
      'not an entry',
    ])

    expect(recordFromTranscript('abc', '-work-repo', summary)).toEqual({
      record: {
        id: 'abc',
        name: 'Flaky webhook test fix',
        nameSource: 'generated',
        cwd: '/work/repo',
        createdAt: '2026-10-01T09:00:00.000Z',
        lastMessageAt: '2026-10-01T09:30:00.000Z',
        messageCount: 2,
        status: null,
        labelError: null,
      },
      isCwdGuessed: false,
    })
  })

  test('should prefer a /rename title and skip headless and prompt-less transcripts', async () => {
    const prompt = { type: 'user', cwd: '/work/a', timestamp: '2026-10-01T09:00:00.000Z', message: { content: 'Hi' } }

    expect(
      recordFromTranscript('r', '-work-a', summarize([
        { ...prompt, entrypoint: 'cli' },
        { type: 'custom-title', customTitle: ' Weekly cost report ' },
        { type: 'ai-title', aiTitle: 'AWS cost report' },
      ])),
    ).toEqual({
      record: {
        id: 'r',
        name: 'Weekly cost report',
        nameSource: 'renamed',
        cwd: '/work/a',
        createdAt: '2026-10-01T09:00:00.000Z',
        lastMessageAt: '2026-10-01T09:00:00.000Z',
        messageCount: 1,
        status: null,
        labelError: null,
      },
      isCwdGuessed: false,
    })
    expect(recordFromTranscript('h', '-work-a', summarize([{ ...prompt, entrypoint: 'sdk-ts' }]))).toEqual({
      skip: 'headless (sdk-ts)',
    })
    expect(
      recordFromTranscript('e', '-work-a', summarize([
        { ...prompt, entrypoint: 'cli', message: { content: '<local-command-stdout>Bye!</local-command-stdout>' } },
      ])),
    ).toEqual({ skip: 'no prompts' })
    expect(recordFromTranscript('g', '-elsewhere', summarize([{ ...prompt, entrypoint: 'cli' }]))).toMatchObject({
      record: { cwd: '/work/a' },
      isCwdGuessed: true,
    })
  })

  test('should keep the better name and the widest span when merging with a recorded session', async () => {
    const found = record({
      id: 'm',
      name: 'From the transcript',
      nameSource: 'generated',
      cwd: '/work/b',
      createdAt: '2026-10-10T08:00:00.000Z',
      lastMessageAt: '2026-10-11T09:30:00.000Z',
      messageCount: 7,
    })
    const renamed = record({
      id: 'm',
      name: 'Live rename',
      nameSource: 'renamed',
      createdAt: '2026-10-11T09:00:00.000Z',
      lastMessageAt: '2026-10-11T10:00:00.000Z',
      messageCount: 2,
    })

    expect(mergeRecords(renamed, found)).toEqual({
      id: 'm',
      name: 'Live rename',
      nameSource: 'renamed',
      cwd: '/work/b',
      createdAt: '2026-10-10T08:00:00.000Z',
      lastMessageAt: '2026-10-11T10:00:00.000Z',
      messageCount: 7,
      status: null,
      labelError: null,
    })
    expect(mergeRecords(record({ id: 'm', name: 'A later prompt', nameSource: 'prompt' }), found)).toEqual(found)
    expect(mergeRecords(null, found)).toEqual(found)
  })
  test('should read a record without a label as unlabeled', async () => {
    const { status: _, labelError: __, ...unlabeled } = record({ id: 'old' })

    expect(parseRecord(JSON.stringify(unlabeled), 'old.json')).toEqual(record({ id: 'old' }))
    expect(parseRecord(JSON.stringify({ ...unlabeled, status: 'done' }), 'old.json')).toEqual(record({ id: 'old' }))
    expect(parseRecord(JSON.stringify({ ...unlabeled, status: 'pending' }), 'old.json').status).toBe('pending')
  })

  test('should keep a label unless the transcript has a later prompt', async () => {
    const labeled = record({ id: 'm', status: 'pending', lastMessageAt: '2026-10-11T09:00:00.000Z' })

    expect(mergeRecords(labeled, record({ id: 'm', lastMessageAt: '2026-10-11T09:00:00.400Z' })).status).toBe('pending')
    expect(mergeRecords(labeled, record({ id: 'm', lastMessageAt: '2026-10-11T11:00:00.000Z' })).status).toBe(null)
  })
})

describe('/sessions', () => {
  const PANE = {
    plugin: 'session-history',
    component: 'Pane',
    requestId: 'session-history',
    props: {
      title: 'Sessions',
      isFocused: true,
      bodyColumns: 100,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  } as const

  test('should list resumable sessions and resume or copy depending on the directory', async ($, on) => {
    const { files } = setup(on, { cwd: '/work/a', sessionId: 'current' })
    const resumed: string[] = []
    const copied: string[] = []
    const closed: string[] = []

    seed(files, record({ id: 'here', name: 'Here session', lastMessageAt: '2026-10-11T09:00:00.000Z' }), 1)
    seed(files, record({ id: 'there', name: 'There session', cwd: '/work/b', lastMessageAt: '2026-10-11T08:00:00.000Z' }), 2)
    seed(files, record({ id: 'empty', lastMessageAt: null }), 3)
    seed(files, record({ id: 'current', name: 'This session' }), 4)
    seed(files, record({ id: 'newest', name: 'Newest', lastMessageAt: '2026-10-11T09:30:00.000Z' }), 5)

    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', ($, e) => {
      closed.push(e.id)

      return { value: undefined }
    })
    on('ui.copy', ($, e) => {
      copied.push(e.text)

      return { value: { isCopied: true } }
    })
    on('command.run', { command: 'resume' }, ($, e) => {
      resumed.push(e.args)

      return { text: '' }
    })

    await $.session.start({ cwd: '/work/a', surface: 'terminal', isInteractive: true })
    const ran = await $.command.run({ ...TYPED, command: 'sessions', args: '' })

    expect(ran.text).toBe('Listed 3 earlier sessions. Pick one to resume; Esc closes the list.')

    for (const surface of ['terminal', 'desktop'] as const) {
      resumed.length = 0
      copied.length = 0

      const ui = await $.ui.mount({ ...PANE, surface })
      const rows = await ui.findAll({ type: 'Button' })

      expect(rows.map(row => row.key)).toEqual(['session:newest', 'session:here', 'session:there'])

      await ui.press({ key: 'session:here' })

      expect(closed).toContain('session-history')
      expect(resumed).toEqual(['here'])

      await ui.press({ key: 'session:there' })

      expect(copied).toEqual(['cd /work/b && claude --resume there'])
      expect(resumed).toEqual(['here'])

      await ui.input({ key: 'filter', text: 'there', kind: 'change' })

      expect((await ui.findAll({ type: 'Button' })).map(row => row.key)).toEqual(['session:there'])

      await ui.input({ key: 'filter', text: '', kind: 'change' })
      await ui.unmount()
    }
  })

  test('should answer with a text list where no pane can be placed', async ($, on) => {
    const { files } = setup(on, { cwd: '/work/a', sessionId: 'current' })

    seed(files, record({ id: 'here', name: 'Here session' }), 1)
    seed(files, record({ id: 'there', name: 'There session', cwd: '/work/b' }), 2)
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface' } }))

    await $.session.start({ cwd: '/work/a', surface: null, isInteractive: false })
    const ran = await $.command.run({ ...TYPED, command: 'sessions', args: 'there' })

    expect(ran.text).toBe(
      [
        'Sessions, most recent first (1 total):',
        '1. There session (/work/b · 1h ago · started 1d ago)',
        '   cd /work/b && claude --resume there',
      ].join('\n'),
    )
  })

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

  test('should warn about the exit bound before anything was recorded', async ($, on) => {
    setup(on, { cwd: '/work/a', sessionId: 'current', env: {} })
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface' } }))

    const listed = await $.command.run({ ...TYPED, command: 'sessions', args: '' })

    expect(listed.text).toBe([limitWarning(undefined), 'No sessions in the history match.'].join('\n'))
  })

  test('should warn while the exit bound is too short and list finished sessions with --all', async ($, on) => {
    const { files } = setup(on, { cwd: '/work/a', sessionId: 'current', env: {} })

    seed(files, record({ id: 'here', name: 'Here session', labelError: 'no answer (aborted)' }), 1)
    seed(files, record({ id: 'done', name: 'Done session', status: 'complete' }), 2)
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface' } }))

    const listed = await $.command.run({ ...TYPED, command: 'sessions', args: '' })
    const all = await $.command.run({ ...TYPED, command: 'sessions', args: '--all done' })

    expect(listed.text).toBe(
      [
        limitWarning(undefined),
        '1 sessions could not be labeled when they closed (latest: no answer (aborted)). They stay listed; '
          + 'node scripts/backfill.mjs --label retries them.',
        'Sessions, most recent first (1 total):',
        '1. Here session (/work/a · 1h ago · started 1d ago)',
        '   /resume here',
        '1 finished sessions hidden; /sessions --all lists them.',
      ].join('\n'),
    )
    expect(all.text).toBe(
      [
        limitWarning(undefined),
        '1 sessions could not be labeled when they closed (latest: no answer (aborted)). They stay listed; '
          + 'node scripts/backfill.mjs --label retries them.',
        'Sessions, most recent first (1 total):',
        '1. ✓ Done session (/work/a · 1h ago · started 1d ago)',
        '   /resume done',
      ].join('\n'),
    )
  })
})
