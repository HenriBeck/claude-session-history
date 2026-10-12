import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SessionRecord } from '../types'
import {
  addTranscriptEntry,
  cleanTitle,
  conversationExcerpt,
  emptyTranscriptSummary,
  excerptLine,
  mergeRecords,
  nameFromPrompt,
  parseRecord,
  recordFromTranscript,
  relativeTime,
  resumeCommand,
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
}

/**
 * The engine beneath the plugin: a session at `cwd` whose prompts enter (or are dropped) and are counted.
 */
function setup(on: On, options: Setup) {
  const files = memoryFs(on)
  const clock = mock.clock(on, { now: START })
  let turns = options.turns ?? 0

  mock.env(on, { HOME })
  on('session.root', () => ({ value: options.cwd }))
  on('session.id', () => ({ value: options.sessionId }))
  on('session.usage', () => ({
    value: { startedAt: options.startedAt ?? START, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('session.turns', () => ({ value: turns }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => {
    if (options.dropPrompts) {
      return { drop: 'not allowed' }
    }

    turns += 1

    return { text: e.text }
  })

  return { files, clock }
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
    })
    expect(mergeRecords(record({ id: 'm', name: 'A later prompt', nameSource: 'prompt' }), found)).toEqual(found)
    expect(mergeRecords(null, found)).toEqual(found)
  })
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
})
