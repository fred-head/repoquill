export const conflictDecisionStoragePrefix = 'repoquill:conflict-decisions:'

type DraftStorage = Pick<Storage, 'getItem' | 'key' | 'length' | 'removeItem' | 'setItem'>

export function conflictDecisionStorageKey(token: string) {
  return `${conflictDecisionStoragePrefix}${token}`
}

export function readConflictDecisionDraft(storage: Pick<DraftStorage, 'getItem'>, token: string) {
  try { return storage.getItem(conflictDecisionStorageKey(token)) } catch { return null }
}

export function writeConflictDecisionDraft(storage: Pick<DraftStorage, 'setItem'>, token: string, value: string) {
  try { storage.setItem(conflictDecisionStorageKey(token), value) } catch { /* Git remains the durable recovery source. */ }
}

export function removeConflictDecisionDraft(storage: Pick<DraftStorage, 'removeItem'>, token: string) {
  try { storage.removeItem(conflictDecisionStorageKey(token)) } catch { /* Browser cleanup must not change the server result. */ }
}

export function clearConflictDecisionDrafts(storage: Pick<DraftStorage, 'key' | 'length' | 'removeItem'>) {
  const keys: string[] = []
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(conflictDecisionStoragePrefix)) keys.push(key)
    }
  } catch { return }
  for (const key of keys) {
    try { storage.removeItem(key) } catch { /* Continue clearing other drafts. */ }
  }
}
