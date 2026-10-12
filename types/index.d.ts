/**
 * One session as the history file under `<config dir>/session-history/<id>.json` keeps it.
 */
export type SessionRecord = {
  id: string
  name: string | null
  /**
   * Where the name comes from, highest priority first: `/rename`, a title a small model wrote from the
   * first prompt, or the first prompt's opening line until that title arrives.
   */
  nameSource: 'renamed' | 'generated' | 'prompt' | null
  /** The directory the session's transcript belongs to: where `claude --resume` has to run. */
  cwd: string
  /** ISO timestamp of the session's first launch. */
  createdAt: string
  /** ISO timestamp of the latest prompt; null while no prompt was sent (nothing to resume). */
  lastMessageAt: string | null
  messageCount: number
  /**
   * What the session's last close left: `complete` when nothing was left to do, `pending` when work or a decision
   * was still open; null until a close labels it, and again after every prompt.
   */
  status: SessionStatus | null
  /**
   * Why the last close could not label the session (no answer, an unexpected reply, a failure); null when it did,
   * or when no close tried since the last prompt.
   */
  labelError: string | null
}

export type SessionStatus = 'complete' | 'pending'

/**
 * What the `/sessions` pane draws: the history as it was read when the command ran.
 */
export type SessionHistoryView = {
  sessions: SessionRecord[]
  currentId: string
  currentCwd: string
  home: string
  loadedAt: number
  /** History files that could not be read or parsed. */
  unreadable: string[]
  /**
   * What keeps sessions from being labeled at close: an exit bound too short for it, closes that could not label.
   */
  warnings: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-history': {
      view: SessionHistoryView | null
      filter: string
      showFinished: boolean
    }
  }
}
