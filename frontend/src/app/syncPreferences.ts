export type SyncPreferences = {
  scheduledMinutes: 0 | 5 | 15 | 30 | 60
  inactivityMinutes: 0 | 1 | 2 | 5 | 10
  syncOnNotebookSwitch: boolean
  syncOnClose: boolean
  syncOnStartup: boolean
  syncOnFocus: boolean
  syncBeforeOpeningNote: boolean
}

export const defaultSyncPreferences: SyncPreferences = {
  scheduledMinutes: 15,
  inactivityMinutes: 2,
  syncOnNotebookSwitch: true,
  syncOnClose: true,
  syncOnStartup: true,
  syncOnFocus: true,
  syncBeforeOpeningNote: true,
}

const storageKey = 'repoquill.sync-preferences'

export function loadSyncPreferences(storage: Pick<Storage, 'getItem'>): SyncPreferences {
  try {
    const value = JSON.parse(storage.getItem(storageKey) ?? '{}') as Partial<SyncPreferences>
    return {
      scheduledMinutes: [0, 5, 15, 30, 60].includes(Number(value.scheduledMinutes)) ? value.scheduledMinutes as SyncPreferences['scheduledMinutes'] : defaultSyncPreferences.scheduledMinutes,
      inactivityMinutes: [0, 1, 2, 5, 10].includes(Number(value.inactivityMinutes)) ? value.inactivityMinutes as SyncPreferences['inactivityMinutes'] : defaultSyncPreferences.inactivityMinutes,
      syncOnNotebookSwitch: typeof value.syncOnNotebookSwitch === 'boolean' ? value.syncOnNotebookSwitch : defaultSyncPreferences.syncOnNotebookSwitch,
      syncOnClose: typeof value.syncOnClose === 'boolean' ? value.syncOnClose : defaultSyncPreferences.syncOnClose,
      syncOnStartup: typeof value.syncOnStartup === 'boolean' ? value.syncOnStartup : defaultSyncPreferences.syncOnStartup,
      syncOnFocus: typeof value.syncOnFocus === 'boolean' ? value.syncOnFocus : defaultSyncPreferences.syncOnFocus,
      syncBeforeOpeningNote: typeof value.syncBeforeOpeningNote === 'boolean' ? value.syncBeforeOpeningNote : defaultSyncPreferences.syncBeforeOpeningNote,
    }
  } catch {
    return defaultSyncPreferences
  }
}

export function saveSyncPreferences(storage: Pick<Storage, 'setItem'>, value: SyncPreferences) {
  storage.setItem(storageKey, JSON.stringify(value))
}
