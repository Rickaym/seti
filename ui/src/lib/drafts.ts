const PREFIX = 'seti.draft.'
/** Longer text is cut to this many characters, so one paste cannot fill the origin's storage. */
export const MAX_DRAFT_CHARS = 20_000

export const taskDraftKey = (taskId: string) => `task.${taskId}`
export const NEW_TASK_PROMPT = 'new-task.prompt'
export const EA_CHAT_DRAFT = 'ea.chat'
export const TEAM_CHAT_DRAFT = 'team.chat'

/** Unsent text kept in localStorage per key; storage that throws or is full loses the draft only. */
export const drafts = {
  read: (key: string): string => {
    try {
      return localStorage.getItem(PREFIX + key) ?? ''
    } catch {
      return ''
    }
  },
  write: (key: string, text: string): void => {
    try {
      if (text.trim() === '') {
        localStorage.removeItem(PREFIX + key)
      } else {
        localStorage.setItem(PREFIX + key, text.slice(0, MAX_DRAFT_CHARS))
      }
    } catch {
      return
    }
  },
}
