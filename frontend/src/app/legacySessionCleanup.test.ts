import { describe, expect, it } from 'vitest'
import { clearLegacySessionDrafts } from './legacySessionCleanup'

function fakeStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial))
  return {
    get length() { return values.size },
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    values,
  }
}

describe('legacy browser draft cleanup', () => {
  it('removes note-bearing drafts while keeping unrelated settings', () => {
    const storage = fakeStorage({
      'repoquill:conflict-decisions:first': 'sensitive combined note',
      'repoquill:conflict-decisions:second': 'another note',
      'repoquill.recovery-draft': 'recovery note',
      'repoquill.theme': 'light',
    })

    clearLegacySessionDrafts(storage)

    expect([...storage.values.entries()]).toEqual([['repoquill.theme', 'light']])
  })

  it('does not throw when browser storage is unavailable', () => {
    const unavailable = new Proxy({}, { get: () => { throw new DOMException('blocked', 'SecurityError') } }) as Storage
    expect(() => clearLegacySessionDrafts(unavailable)).not.toThrow()
  })
})
