import type { SessionRecord, SessionStatus } from '../types'

const NAME_LENGTH = 60
const SESSION_ID = /^[A-Za-z0-9_-]+$/
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/
const NAME_RANK = { renamed: 3, generated: 2, prompt: 1 } as const

/**
 * How much later a transcript may stamp a prompt than the live record of that same prompt.
 */
const SAME_PROMPT_MS = 60_000

/**
 * How much of a conversation's end the labeler reads, in characters.
 */
const EXCERPT_LENGTH = 8000

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
 * The opening of the summary a compaction leaves in place of the conversation it replaced; its "next step" and
 * "pending tasks" sections describe the past, not how the conversation ended.
 */
const COMPACT_SUMMARY = /^This session is being continued from a previous conversation/

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

/**
 * One message of a conversation as the labeler reads it: who wrote it, and its text.
 */
export type ExcerptLine = { role: 'user' | 'assistant'; text: string }

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
    status: null,
    labelError: null,
  }

  return {
    ...base,
    ...pickName(base, touch),
    lastMessageAt: touch.prompt === null ? base.lastMessageAt : facts.now,
    messageCount: facts.turns,
    status: touch.prompt === null ? base.status : null,
    labelError: touch.prompt === null ? base.labelError : null,
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

  const { status, labelError } = value as { status?: unknown; labelError?: unknown }

  return {
    ...(value as SessionRecord),
    status: readStatus(status),
    labelError: typeof labelError === 'string' ? labelError : null,
  }
}

function readStatus(value: unknown): SessionStatus | null {
  return value === 'complete' || value === 'pending' ? value : null
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
  /** The latest messages' text, as much as the labeler's excerpt can use. */
  tail: ExcerptLine[]
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
    tail: [],
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

  const text = promptText(entry.message?.content)

  if (text === null || typeof entry.timestamp !== 'string') {
    return
  }

  summary.prompts += 1
  summary.lastPromptAt = entry.timestamp
  summary.promptName ??= nameFromPrompt(text)
}

/**
 * Summarizes transcript text, such as the end of a transcript file; a line that is not JSON (the first one when the
 * end was cut from a longer file, a write cut short) is skipped.
 */
export function summarizeTranscriptText(text: string): TranscriptSummary {
  const summary = emptyTranscriptSummary()

  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue
    }

    let entry: unknown

    try {
      entry = JSON.parse(line)
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error
      }

      continue
    }

    addTranscriptEntry(summary, entry)
  }

  return summary
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
 * The text of one message for the labeler; null for tool traffic, other roles and messages without text.
 *
 * A user message carrying a tool result is tool output, not a prompt; text blocks the engine wrapped around a
 * prompt (reminders, command echoes) and a compaction's summary are dropped one by one.
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
    .filter(text => text !== '' && (role === 'assistant' || !(WRAPPED_INPUT.test(text) || COMPACT_SUMMARY.test(text))))

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
      status: null,
      labelError: null,
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
 * directory, the earliest start, the latest message, and the label unless a later prompt made it stale.
 */
export function mergeRecords(existing: SessionRecord | null, found: SessionRecord): SessionRecord {
  if (existing === null) {
    return found
  }

  const named = nameRank(existing) > nameRank(found) ? existing : found
  const isStale = isLaterPrompt(found.lastMessageAt, existing.lastMessageAt)

  return {
    id: found.id,
    name: named.name,
    nameSource: named.nameSource,
    cwd: found.cwd,
    createdAt: existing.createdAt < found.createdAt ? existing.createdAt : found.createdAt,
    lastMessageAt: latest(existing.lastMessageAt, found.lastMessageAt),
    messageCount: Math.max(existing.messageCount, found.messageCount),
    status: isStale ? null : existing.status,
    labelError: isStale ? null : existing.labelError,
  }
}

function latest(a: string | null, b: string | null): string | null {
  return (a ?? '') > (b ?? '') ? a : b
}

function isLaterPrompt(found: string | null, recorded: string | null): boolean {
  if (found === null) {
    return false
  }

  if (recorded === null) {
    return true
  }

  return Date.parse(found) - Date.parse(recorded) > SAME_PROMPT_MS
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

/**
 * What `/sessions` says when closes could not label sessions: how many, and the most recent one's reason.
 */
export function labelFailureWarning(sessions: readonly SessionRecord[]): string | null {
  const failed = sessions.filter(record => record.labelError !== null).sort(byLastMessage)
  const latest = failed[0]

  if (latest === undefined) {
    return null
  }

  return `${failed.length} sessions could not be labeled when they closed (latest: ${latest.labelError}). `
    + 'They stay listed; node scripts/backfill.mjs --label retries them.'
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
