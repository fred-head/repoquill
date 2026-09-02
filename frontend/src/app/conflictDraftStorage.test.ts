import { describe, expect, it } from 'vitest'
import { clearConflictDecisionDrafts, conflictDecisionStorageKey, readConflictDecisionDraft, removeConflictDecisionDraft, writeConflictDecisionDraft } from './conflictDraftStorage'

function fakeStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial))
  return {
    get length() { return values.size },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  }
}

describe('conflict decision draft storage', () => {
  it('uses a namespaced per-conflict key', () => {
    expect(conflictDecisionStorageKey('opaque-token')).toBe('repoquill:conflict-decisions:opaque-token')
  })

  it('clears only conflict drafts when authentication ends', () => {
    const storage = fakeStorage({
      'repoquill:conflict-decisions:first': 'sensitive note draft',
      'repoquill:conflict-decisions:second': 'another draft',
      'repoquill.recovery-draft': 'separate recovery workflow',
    })

    clearConflictDecisionDrafts(storage)

    expect([...storage.values.entries()]).toEqual([
      ['repoquill.recovery-draft', 'separate recovery workflow'],
    ])
  })

  it('reads, writes, and removes a tab-scoped draft without surfacing storage failures', () => {
    const storage = fakeStorage({})
    writeConflictDecisionDraft(storage, 'token', 'combined note')
    expect(readConflictDecisionDraft(storage, 'token')).toBe('combined note')
    removeConflictDecisionDraft(storage, 'token')
    expect(readConflictDecisionDraft(storage, 'token')).toBeNull()

    const unavailable = new Proxy({}, { get: () => { throw new DOMException('blocked', 'SecurityError') } }) as Storage
    expect(() => writeConflictDecisionDraft(unavailable, 'token', 'note')).not.toThrow()
    expect(() => removeConflictDecisionDraft(unavailable, 'token')).not.toThrow()
    expect(() => clearConflictDecisionDrafts(unavailable)).not.toThrow()
    expect(readConflictDecisionDraft(unavailable, 'token')).toBeNull()
  })
})
