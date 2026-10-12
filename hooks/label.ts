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
