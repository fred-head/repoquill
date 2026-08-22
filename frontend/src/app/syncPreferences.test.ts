import { describe, expect, it } from 'vitest'
import { defaultSyncPreferences, loadSyncPreferences, saveSyncPreferences } from './syncPreferences'

describe('sync preferences', () => {
  it('loads safe defaults from malformed values', () => {
    expect(loadSyncPreferences({ getItem: () => '{bad' })).toEqual(defaultSyncPreferences)
  })

  it('round-trips individual sync behavior', () => {
    let stored = ''
    const value = { scheduledMinutes: 30 as const, inactivityMinutes: 0 as const, syncOnNotebookSwitch: false, syncOnClose: true, syncOnStartup: false, syncOnFocus: true, syncBeforeOpeningNote: false }
    saveSyncPreferences({ setItem: (_key, next) => { stored = next } }, value)
    expect(loadSyncPreferences({ getItem: () => stored })).toEqual(value)
  })
})
