import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookFailure, Register, RenderSurface } from 'claude-code'

import type { SessionHistoryView, SessionRecord } from '../types'
import {
  applyTouch,
  assertSessionId,
  byLastMessage,
  cleanTitle,
  fit,
  matchesFilter,
  parseRecord,
  relativeTime,
  resumeCommand,
  tildify,
} from './history'
import type { Touch } from './history'

const PANE = 'session-history'
const MAX_FILES = 300
const MAX_ROWS = 100
const MAX_TEXT_ROWS = 20
const TITLE_MODEL = 'haiku'
const TITLE_PROMPT_LENGTH = 2000

/**
 * Prompt origins that are the person's own messages: typed at the prompt, or sent through Remote Control.
 */
const USER_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge'])

const viewAtom = atom({ plugin: 'session-history', key: 'view' } as const, null)
const filterAtom = atom({ plugin: 'session-history', key: 'filter' } as const, '')

type Engine = EngineInterface

async function historyDir($: Engine): Promise<string> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')

  if (configDir !== undefined && configDir !== '') {
    return `${configDir}/session-history`
  }

  const home = await $.env.get('HOME')

  if (home === undefined || home === '') {
    throw new Error('session-history: neither CLAUDE_CONFIG_DIR nor HOME is set, so there is no place for the history')
  }

  return `${home}/.claude/session-history`
}

function recordPath(dir: string, id: string): string {
  return `${dir}/${assertSessionId(id)}.json`
}

async function readRecord($: Engine, path: string): Promise<SessionRecord | null> {
  if (!(await $.fs.exists(path))) {
    return null
  }

  return parseRecord(await $.fs.read(path), path)
}

async function writeRecord($: Engine, path: string, record: SessionRecord): Promise<void> {
  await $.fs.write(path, `${JSON.stringify(record, null, 2)}\n`)
}

/**
 * Upserts the current session's history file; says which session that is and whether this touch named it
 * from its first prompt.
 */
async function touchSession($: Engine, touch: Touch): Promise<{ id: string; isNamedFromPrompt: boolean }> {
  const id = await $.session.id()
  const path = recordPath(await historyDir($), id)
  const existing = await readRecord($, path)
  const record = applyTouch(existing, touch, {
    id,
    cwd: await $.session.root(),
    startedAt: new Date((await $.session.usage()).startedAt).toISOString(),
    turns: await $.session.turns(),
    now: new Date(await $.clock.now()).toISOString(),
  })

  await writeRecord($, path, record)

  return { id, isNamedFromPrompt: record.nameSource === 'prompt' && existing?.nameSource !== 'prompt' }
}

/**
 * Replaces the prompt-line name with a short title from a small model; a `/rename` meanwhile is kept.
 */
async function generateName($: Engine, id: string, prompt: string): Promise<void> {
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

  const path = recordPath(await historyDir($), id)
  const current = await readRecord($, path)

  if (current === null || current.nameSource !== 'prompt') {
    return
  }

  await writeRecord($, path, { ...current, name: title, nameSource: 'generated' })
}

async function loadView($: Engine): Promise<SessionHistoryView> {
  const dir = await historyDir($)
  const currentId = await $.session.id()
  const view: SessionHistoryView = {
    sessions: [],
    currentId,
    currentCwd: await $.session.root(),
    home: (await $.env.get('HOME')) ?? '',
    loadedAt: await $.clock.now(),
    unreadable: [],
  }

  if (!(await $.fs.exists(dir))) {
    return view
  }

  const files = (await $.fs.list(dir))
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES)
  const reads = await Promise.all(
    files.map(async file => {
      const path = `${dir}/${file.name}`

      try {
        return parseRecord(await $.fs.read(path), path)
      } catch (error) {
        return `${path} (${error instanceof Error ? error.message : String(error)})`
      }
    }),
  )

  for (const result of reads) {
    if (typeof result === 'string') {
      view.unreadable.push(result)
    } else if (result.lastMessageAt !== null && result.id !== currentId) {
      view.sessions.push(result)
    }
  }

  view.sessions.sort(byLastMessage)

  return view
}

function describe(record: SessionRecord, view: SessionHistoryView): string {
  const last = record.lastMessageAt === null ? 'never' : relativeTime(record.lastMessageAt, view.loadedAt)

  return `${tildify(record.cwd, view.home)} · ${last} · started ${relativeTime(record.createdAt, view.loadedAt)}`
}

function listAsText(view: SessionHistoryView, matching: SessionRecord[]): string {
  if (matching.length === 0) {
    return 'No sessions in the history match.'
  }

  const lines = matching.slice(0, MAX_TEXT_ROWS).flatMap((record, index) => [
    `${index + 1}. ${record.name ?? record.id} (${describe(record, view)})`,
    `   ${record.cwd === view.currentCwd ? `/resume ${record.id}` : resumeCommand(record)}`,
  ])

  return [`Sessions, most recent first (${matching.length} total):`, ...lines].join('\n')
}

/**
 * Puts a failed history hook in the transcript; the event itself goes on, so a lost entry never blocks a session.
 */
function reportFailure($: Engine, what: string, error: HookFailure) {
  if (error.kind !== 're-entry') {
    $.ui.log(`session-history: ${what} failed (${error.kind}): ${error.message ?? 'no message'}`)
  }
}

async function resume($: Engine, record: SessionRecord, view: SessionHistoryView, surface: RenderSurface) {
  if (record.cwd === view.currentCwd) {
    await $.ui.close({ id: PANE })
    $.command.run({ command: 'resume', args: record.id }).catch(error => {
      $.ui.toast(`Could not resume ${record.id}: ${error instanceof Error ? error.message : String(error)}`)
    })

    return
  }

  const command = resumeCommand(record)
  const copied = await $.ui.copy({ text: command, surface })
  const where = tildify(record.cwd, view.home)

  $.ui.toast(
    copied.isCopied
      ? `That session lives in ${where}. Copied to the clipboard: ${command}`
      : `That session lives in ${where}. Run in a shell: ${command}`,
    { timeoutMs: 10_000 },
  )
}

export const register: Register = on => {
  let writes: Promise<unknown> = Promise.resolve()

  /**
   * Runs history writes one after another so a prompt and a title landing together never overwrite each other.
   */
  function serialized<T>(write: () => Promise<T>): Promise<T> {
    const run = writes.then(write)

    writes = run.catch(() => undefined)

    return run
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sessions',
      description: 'Browse and resume earlier sessions',
      argumentHint: '[filter]',
    })

    const result = await next(e)

    if (e.isInteractive) {
      await serialized(() => touchSession($, { title: null, prompt: null }))
    }

    return result
  }).catch(($, e, next) => {
    reportFailure($, 'recording the session start', next.error)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)

    if (result.drop !== undefined || !USER_ORIGINS.has(e.origin.kind)) {
      return result
    }

    const prompt = result.text
    const { id, isNamedFromPrompt } = await serialized(() => touchSession($, { title: null, prompt }))

    if (isNamedFromPrompt) {
      $.clock.after(0, () => {
        serialized(() => generateName($, id, prompt)).catch(error => {
          $.ui.log(`session-history: naming the session failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      })
    }

    return result
  }).catch(($, e, next) => {
    reportFailure($, 'recording the prompt', next.error)

    return next(e)
  })

  on('command.run', { command: 'rename' }, async ($, e, next) => {
    const result = await next(e)
    const name = e.args.trim()

    if (name !== '') {
      await serialized(() => touchSession($, { title: name, prompt: null }))
    }

    return result
  }).catch(($, e, next) => {
    reportFailure($, 'recording the new name', next.error)

    return next(e)
  })

  on('command.run', { command: 'sessions' }, async ($, e) => {
    const view = await loadView($)
    const filter = e.args.trim()
    const matching = view.sessions.filter(record => matchesFilter(record, filter))

    await update($, viewAtom, () => view)
    await update($, filterAtom, () => filter)

    if (view.unreadable.length > 0) {
      $.ui.toast(`Skipped ${view.unreadable.length} unreadable history file(s): ${view.unreadable.join(', ')}`)
    }

    const opened = await $.ui.open({ id: PANE, title: 'Sessions', focus: true, closeOnEscape: true })

    if (!opened.isPlaced) {
      return { text: listAsText(view, matching) }
    }

    return { text: `Listed ${matching.length} earlier sessions. Pick one to resume; Esc closes the list.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const filter = await read($, filterAtom)

    if (view === null) {
      return <Text dimColor>Run /sessions to load the session history.</Text>
    }

    const width = e.props.bodyColumns
    const matching = view.sessions.filter(record => matchesFilter(record, filter)).slice(0, MAX_ROWS)
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
            const first = view.sessions.find(record => matchesFilter(record, value))

            return first === undefined ? undefined : resume($, first, view, input.surface)
          }}
        />
      )
    }

    return (
      <Box flexDirection="column">
        {filterInput}
        <Text dimColor>
          {fit(`${matching.length} sessions · ↗ = other directory, copies a resume command`, width)}
        </Text>
        {matching.length === 0 && <Text dimColor>No sessions match.</Text>}
        {matching.map(record => {
          const marker = record.cwd === view.currentCwd ? '  ' : '↗ '
          const name = fit(record.name ?? record.id, nameWidth).padEnd(nameWidth)

          return (
            <Button key={`session:${record.id}`} plain onPress={press => resume($, record, view, press.surface)}>
              {marker}
              {name}
              <Text dimColor> {fit(describe(record, view), Math.max(0, width - nameWidth - 3))}</Text>
            </Button>
          )
        })}
      </Box>
    )
  })
}
