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
}

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
}

declare module 'claude-code' {
  interface PluginState {
    'session-history': {
      view: SessionHistoryView | null
      filter: string
    }
  }
}
