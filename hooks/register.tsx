import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookFailure, Register, RenderSurface, UiLogSink } from 'claude-code'

import type { SessionHistoryView, SessionRecord } from '../types'
import {
  applyTouch,
  assertSessionId,
  byLastMessage,
  cleanTitle,
  conversationExcerpt,
  excerptLine,
  fit,
  labelFailureWarning,
  parseRecord,
  parseSessionsArgs,
  relativeTime,
  resumeCommand,
  statusMarker,
  tildify,
  visibleSessions,
} from './history'
import type { Touch } from './history'
import { LABEL_MODEL, labelPrompt, labelTimeoutMs, limitWarning, parseLabel } from './label'

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
const showFinishedAtom = atom({ plugin: 'session-history', key: 'showFinished' } as const, false)

type Engine = EngineInterface

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

/**
 * Labels an ending session complete or pending from the end of its conversation, within what the exit leaves.
 *
 * Sessions without a record (headless runs) or without a prompt are left alone; a skipped or unusable answer
 * leaves the session unlabeled, so `/sessions` keeps listing it, and keeps why on its record and in the debug log.
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
    const left = Math.floor(context.remainingMs())

    $.ui.log(`session-history: no time left to label ${id} (${left} ms)`, { to: 'debug' })
    await recordLabelError($, id, `no time left at close (${left} ms)`, context.serialize)

    return
  }

  const reply = await $.model.complete(
    { model: LABEL_MODEL, ...labelPrompt(excerpt), maxTokens: 5, effort: 'low', timeoutMs },
    { signal: context.signal },
  )

  if (!reply.isAnswered) {
    $.ui.log(`session-history: labeling ${id} got no answer (${reply.reason})`, { to: 'debug' })
    await recordLabelError($, id, `no answer (${reply.reason})`, context.serialize)

    return
  }

  const status = parseLabel(reply.text)

  if (status === null) {
    const shown = JSON.stringify(reply.text.slice(0, 200))

    $.ui.log(`session-history: labeling ${id} got an unexpected reply: ${shown}`, { to: 'debug' })
    await recordLabelError($, id, `unexpected reply: ${shown}`, context.serialize)

    return
  }

  await context.serialize(async () => {
    const current = await readRecord($, path)

    if (current !== null) {
      await writeRecord($, path, { ...current, status, labelError: null })
    }
  })
}

/**
 * Keeps why a close could not label a session on its record, so `/sessions` can say so.
 */
async function recordLabelError($: Engine, id: string, reason: string, serialize: Serialize): Promise<void> {
  await serialize(async () => {
    const path = recordPath(await historyDir($), id)
    const current = await readRecord($, path)

    if (current !== null) {
      await writeRecord($, path, { ...current, labelError: reason })
    }
  })
}

async function loadView($: Engine): Promise<SessionHistoryView> {
  const dir = await historyDir($)
  const currentId = await $.session.id()
  const limit = limitWarning(await $.env.get('CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS'))
  const view: SessionHistoryView = {
    sessions: [],
    currentId,
    currentCwd: await $.session.root(),
    home: (await $.env.get('HOME')) ?? '',
    loadedAt: await $.clock.now(),
    unreadable: [],
    warnings: limit === null ? [] : [limit],
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
  const failures = labelFailureWarning(view.sessions)

  if (failures !== null) {
    view.warnings.push(failures)
  }

  return view
}

function describe(record: SessionRecord, view: SessionHistoryView): string {
  const last = record.lastMessageAt === null ? 'never' : relativeTime(record.lastMessageAt, view.loadedAt)

  return `${tildify(record.cwd, view.home)} · ${last} · started ${relativeTime(record.createdAt, view.loadedAt)}`
}

function listAsText(view: SessionHistoryView, rows: SessionRecord[], hiddenFinished: number): string {
  const lines = rows.slice(0, MAX_TEXT_ROWS).flatMap((record, index) => [
    `${index + 1}. ${record.status === null ? '' : `${statusMarker(record)} `}${record.name ?? record.id} (${describe(record, view)})`,
    `   ${record.cwd === view.currentCwd ? `/resume ${record.id}` : resumeCommand(record)}`,
  ])

  return [
    ...view.warnings,
    ...(rows.length === 0
      ? ['No sessions in the history match.']
      : [`Sessions, most recent first (${rows.length} total):`, ...lines]),
    ...(hiddenFinished === 0 ? [] : [`${hiddenFinished} finished sessions hidden; /sessions --all lists them.`]),
  ].join('\n')
}

/**
 * Logs a failed history hook, to the transcript unless `to` says otherwise; the event itself goes on, so a lost
 * entry never blocks a session.
 */
function reportFailure($: Engine, what: string, error: HookFailure, to: UiLogSink = 'transcript') {
  if (error.kind !== 're-entry') {
    $.ui.log(`session-history: ${what} failed (${error.kind}): ${error.message ?? 'no message'}`, { to })
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
        generateName($, id, prompt, serialized).catch(error => {
          $.ui.log(`session-history: naming the session failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      })
    }

    return result
  }).catch(($, e, next) => {
    reportFailure($, 'recording the prompt', next.error)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await labelSession($, e.sessionId, {
      remainingMs: () => next.budget.remainingMs,
      signal: next.signal,
      serialize: serialized,
    })

    return next(e)
  }).catch(async ($, e, next) => {
    reportFailure($, 'labeling the session', next.error, 'debug')

    if (next.error.kind !== 're-entry') {
      const reason = `${next.error.kind}: ${next.error.message ?? 'no message'}`

      await recordLabelError($, e.sessionId, reason, serialized).catch(error => {
        $.ui.log(`session-history: keeping the labeling failure failed: ${error instanceof Error ? error.message : String(error)}`, {
          to: 'debug',
        })
      })
    }

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
        {view.warnings.map(warning => (
          <Text key={`warning:${warning}`} color="yellow">
            {fit(warning, width * 3)}
          </Text>
        ))}
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
}
