import type { SessionRecord } from '../types'

const NAME_LENGTH = 60
const SESSION_ID = /^[A-Za-z0-9_-]+$/
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/
const NAME_RANK = { renamed: 3, generated: 2, prompt: 1 } as const

/**
 * Transcript user entries the engine wrote around a prompt rather than the person typing one.
 */
const WRAPPED_INPUT =
  /^<(task-notification|local-command-[a-z]+|command-(name|message|args)|bash-(input|stdout|stderr)|scheduled-task|system-reminder)[\s>]/

/**
 * Transcript entrypoints of sessions a person drove; `sdk-ts` and `sdk-cli` are headless runs.
 */
const INTERACTIVE_ENTRYPOINTS = new Set(['cli', 'claude-desktop'])

/**
 * What one session event contributes to its record: `prompt` is null for a session start or a rename.
 */
export type Touch = {
  /** A `/rename` title; it names the session over everything else. */
  title: string | null
  prompt: string | null
}

/**
 * What the engine says about the session at the moment of a touch.
 */
export type SessionFacts = {
  id: string
  /** The session's project root; a record keeps the one it was created with. */
  cwd: string
  /** ISO time of the session's first launch. */
  startedAt: string
  /** Prompts the user has sent in the session so far. */
  turns: number
  now: string
}

export function assertSessionId(id: string): string {
  if (!SESSION_ID.test(id)) {
    throw new Error(`session-history: refusing to use "${id}" as a history file name`)
  }

  return id
}

/**
 * The opening line of a prompt, cut to a list-friendly length; null for slash commands and empty prompts.
 */
export function nameFromPrompt(prompt: string): string | null {
  const line = prompt
    .split('\n')
    .map(part => part.trim())
    .find(part => part !== '')

  if (line === undefined || line.startsWith('/')) {
    return null
  }

  const collapsed = line.replace(/\s+/g, ' ')

  return collapsed.length > NAME_LENGTH ? `${collapsed.slice(0, NAME_LENGTH - 1)}…` : collapsed
}

export function applyTouch(existing: SessionRecord | null, touch: Touch, facts: SessionFacts): SessionRecord {
  const base: SessionRecord = existing ?? {
    id: facts.id,
    name: null,
    nameSource: null,
    cwd: facts.cwd,
    createdAt: facts.startedAt,
    lastMessageAt: null,
    messageCount: 0,
  }

  return {
    ...base,
    ...pickName(base, touch),
    lastMessageAt: touch.prompt === null ? base.lastMessageAt : facts.now,
    messageCount: facts.turns,
  }
}

/**
 * A `/rename` title always wins; otherwise the first prompt names the session once.
 */
function pickName(base: SessionRecord, touch: Touch): Pick<SessionRecord, 'name' | 'nameSource'> {
  const title = touch.title?.trim() ?? ''

  if (title !== '') {
    return { name: title, nameSource: 'renamed' }
  }

  const fromPrompt = base.name === null && touch.prompt !== null ? nameFromPrompt(touch.prompt) : null

  if (fromPrompt !== null) {
    return { name: fromPrompt, nameSource: 'prompt' }
  }

  return { name: base.name, nameSource: base.nameSource }
}

/**
 * The first line of a model's title reply, without quotes or a trailing period; null when nothing is left.
 */
export function cleanTitle(reply: string): string | null {
  const line = reply.trim().split('\n')[0] ?? ''
  const title = line.replace(/^["'`*#\s]+|["'`*.\s]+$/g, '').trim()

  if (title === '') {
    return null
  }

  return title.length > NAME_LENGTH ? `${title.slice(0, NAME_LENGTH - 1)}…` : title
}

export function parseRecord(text: string, path: string): SessionRecord {
  const value: unknown = JSON.parse(text)
  const isRecord = typeof value === 'object'
    && value !== null
    && typeof (value as SessionRecord).id === 'string'
    && typeof (value as SessionRecord).cwd === 'string'
    && typeof (value as SessionRecord).createdAt === 'string'

  if (!isRecord) {
    throw new Error(`session-history: ${path} is not a session record`)
  }

  return value as SessionRecord
}

/**
 * The folder under `<config dir>/projects` that holds the transcripts of sessions started in `cwd`.
 */
export function projectFolderName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * What the backfill gathers from one transcript, entry by entry.
 */
export type TranscriptSummary = {
  /** Directories the transcript names, first seen first. */
  cwds: string[]
  entrypoint: string | null
  firstAt: string | null
  lastPromptAt: string | null
  prompts: number
  promptName: string | null
  aiTitle: string | null
  customTitle: string | null
}

type TranscriptEntry = {
  type?: unknown
  timestamp?: unknown
  cwd?: unknown
  relocatedCwd?: unknown
  worktreeSession?: { originalCwd?: unknown } | null
  entrypoint?: unknown
  isSidechain?: unknown
  isMeta?: unknown
  isCompactSummary?: unknown
  aiTitle?: unknown
  customTitle?: unknown
  message?: { content?: unknown } | null
}

export function emptyTranscriptSummary(): TranscriptSummary {
  return {
    cwds: [],
    entrypoint: null,
    firstAt: null,
    lastPromptAt: null,
    prompts: 0,
    promptName: null,
    aiTitle: null,
    customTitle: null,
  }
}

/**
 * Folds one parsed transcript line into `summary`.
 */
export function addTranscriptEntry(summary: TranscriptSummary, value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    return
  }

  const entry = value as TranscriptEntry

  for (const cwd of [entry.cwd, entry.relocatedCwd, entry.worktreeSession?.originalCwd]) {
    if (typeof cwd === 'string' && cwd !== '' && !summary.cwds.includes(cwd)) {
      summary.cwds.push(cwd)
    }
  }

  if (summary.entrypoint === null && typeof entry.entrypoint === 'string') {
    summary.entrypoint = entry.entrypoint
  }

  if (summary.firstAt === null && typeof entry.timestamp === 'string') {
    summary.firstAt = entry.timestamp
  }

  if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
    summary.aiTitle = cleanTitle(entry.aiTitle)
  }

  if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
    summary.customTitle = entry.customTitle.trim() === '' ? null : entry.customTitle.trim()
  }

  if (entry.type !== 'user' || entry.isSidechain === true || entry.isMeta === true || entry.isCompactSummary === true) {
    return
  }

  const text = promptText(entry.message?.content)

  if (text === null || typeof entry.timestamp !== 'string') {
    return
  }

  summary.prompts += 1
  summary.lastPromptAt = entry.timestamp
  summary.promptName ??= nameFromPrompt(text)
}

/**
 * The text a person typed in a user entry; null for tool results, engine wrappers and empty content.
 */
function promptText(content: unknown): string | null {
  let text = ''

  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    for (const block of content as { type?: unknown; text?: unknown }[]) {
      if (block.type === 'tool_result') {
        return null
      }

      if (block.type === 'text' && typeof block.text === 'string') {
        text = text === '' ? block.text : `${text}\n${block.text}`
      }
    }
  }

  const trimmed = text.trim()

  return trimmed === '' || WRAPPED_INPUT.test(trimmed) ? null : trimmed
}

/**
 * The history record a transcript makes, or why it makes none.
 *
 * The directory is the one whose project folder holds the transcript, since that is where `claude --resume`
 * finds it; `isCwdGuessed` says no named directory matched `folder` and the first one was taken.
 */
export function recordFromTranscript(
  id: string,
  folder: string,
  summary: TranscriptSummary,
): { record: SessionRecord; isCwdGuessed: boolean } | { skip: string } {
  if (summary.entrypoint !== null && !INTERACTIVE_ENTRYPOINTS.has(summary.entrypoint)) {
    return { skip: `headless (${summary.entrypoint})` }
  }

  if (summary.lastPromptAt === null) {
    return { skip: 'no prompts' }
  }

  const matching = summary.cwds.find(cwd => projectFolderName(cwd) === folder)
  const cwd = matching ?? summary.cwds[0]

  if (cwd === undefined) {
    return { skip: 'no directory' }
  }

  return {
    record: {
      id,
      ...nameFromTranscript(summary),
      cwd,
      createdAt: summary.firstAt ?? summary.lastPromptAt,
      lastMessageAt: summary.lastPromptAt,
      messageCount: summary.prompts,
    },
    isCwdGuessed: matching === undefined,
  }
}

function nameFromTranscript(summary: TranscriptSummary): Pick<SessionRecord, 'name' | 'nameSource'> {
  if (summary.customTitle !== null) {
    return { name: summary.customTitle, nameSource: 'renamed' }
  }

  if (summary.aiTitle !== null) {
    return { name: summary.aiTitle, nameSource: 'generated' }
  }

  if (summary.promptName !== null) {
    return { name: summary.promptName, nameSource: 'prompt' }
  }

  return { name: null, nameSource: null }
}

/**
 * Combines a recorded session with what its transcript says: the better-sourced name, the transcript's
 * directory, the earliest start and the latest message.
 */
export function mergeRecords(existing: SessionRecord | null, found: SessionRecord): SessionRecord {
  if (existing === null) {
    return found
  }

  const named = nameRank(existing) > nameRank(found) ? existing : found

  return {
    id: found.id,
    name: named.name,
    nameSource: named.nameSource,
    cwd: found.cwd,
    createdAt: existing.createdAt < found.createdAt ? existing.createdAt : found.createdAt,
    lastMessageAt: latest(existing.lastMessageAt, found.lastMessageAt),
    messageCount: Math.max(existing.messageCount, found.messageCount),
  }
}

function latest(a: string | null, b: string | null): string | null {
  return (a ?? '') > (b ?? '') ? a : b
}

function nameRank(record: SessionRecord): number {
  return record.nameSource === null ? 0 : NAME_RANK[record.nameSource]
}

export function matchesFilter(record: SessionRecord, filter: string): boolean {
  const needle = filter.trim().toLowerCase()

  if (needle === '') {
    return true
  }

  return [record.name ?? '', record.cwd, record.id].some(field => field.toLowerCase().includes(needle))
}

export function byLastMessage(a: SessionRecord, b: SessionRecord): number {
  return (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')
}

export function shellQuote(value: string): string {
  return SHELL_SAFE.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

export function resumeCommand(record: SessionRecord): string {
  return `cd ${shellQuote(record.cwd)} && claude --resume ${record.id}`
}

export function tildify(path: string, home: string): string {
  if (home !== '' && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`
  }

  return path
}

export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso)
  const minutes = Math.floor((now - then) / 60_000)

  if (minutes < 1) {
    return 'just now'
  }

  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.floor(minutes / 60)

  if (hours < 24) {
    return `${hours}h ago`
  }

  const days = Math.floor(hours / 24)

  return days < 14 ? `${days}d ago` : iso.slice(0, 10)
}

export function fit(text: string, width: number): string {
  if (width <= 1) {
    return ''
  }

  return text.length > width ? `${text.slice(0, width - 1)}…` : text
}
