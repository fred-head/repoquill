const legacyDraftKeys = new Set(['repoquill.recovery-draft'])
const legacyDraftPrefixes = ['repoquill:conflict-decisions:', 'varianotes:conflict-decisions:']

type KeyStorage = Pick<Storage, 'key' | 'length' | 'removeItem'>

/** Remove note-bearing browser drafts left by older versions of the app. */
export function clearLegacySessionDrafts(storage: KeyStorage) {
  const keys = new Set<string>(legacyDraftKeys)
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key && legacyDraftPrefixes.some((prefix) => key.startsWith(prefix))) keys.add(key)
    }
  } catch {
    // Continue clearing the fixed legacy keys even if enumeration is blocked.
  }

  for (const key of keys) {
    try { storage.removeItem(key) } catch { /* Continue clearing other legacy drafts. */ }
  }
}
