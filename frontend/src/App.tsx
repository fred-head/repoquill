import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { AutoLockController, autoLockOptions, loadAutoLockPreference, parseAutoLockMinutes, saveAutoLockPreference, type AutoLockMinutes } from './app/autoLock'
import { documentStats } from './app/documentStats'
import { defaultSyncPreferences, loadSyncPreferences, saveSyncPreferences, type SyncPreferences } from './app/syncPreferences'

const MarkdownEditor = lazy(() => import('./components/editor/MarkdownEditor').then((module) => ({ default: module.MarkdownEditor })))

type Health = 'checking' | 'online' | 'offline'
type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict'
type GitState = 'clean' | 'local_changes' | 'remote_changes' | 'diverged' | 'synced' | 'sync_failed' | 'conflict' | 'invalid'
type GitStatus = { state: GitState; branch?: string; ahead?: number; behind?: number; conflictFiles?: string[]; message?: string; lastSyncedAt?: string }
type Theme = 'dark' | 'light'
type TreeNode = { name: string; path: string; type: 'directory' | 'file'; children?: TreeNode[] }
type FileResponse = { path: string; content: string; version: string }
type Draft = FileResponse & { savedContent: string }
type MenuState = { entry: TreeNode; x: number; y: number }
type CleanupAsset = { path: string; size: number }
type CleanupFailure = { path: string; error: string }
type GitAuthType = 'managed-ssh' | 'existing-server-ssh'
type ConnectionResult = { state: string; message: string }
type HostKeyInfo = { keyType: string; fingerprint: string }
type HostTrustDiscovery = { state: string; message: string; requestId?: string; host: string; port: number; presentedKeys: HostKeyInfo[]; previouslyTrustedKeys?: HostKeyInfo[] }
type ManagedSSHKey = { keyId: string; publicKey: string; createdAt: string; fingerprint?: string; assigned: boolean; notebookName?: string }
type NotebookInfo = { id: string; name: string; remoteUrl?: string; branch?: string; authType?: GitAuthType; keyId?: string }
type SearchResult = { path: string; type: 'directory' | 'file' | 'content'; line?: number; excerpt?: string }
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
const expandedFoldersStorageKey = 'repoquill.expanded-folders'
const themeStorageKey = 'repoquill.theme'
const noteSwitchSyncFreshnessMs = 45_000

function loadTheme(): Theme {
  const stored = localStorage.getItem(themeStorageKey)
  if (stored === 'dark' || stored === 'light') return stored
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function loadExpandedFolders(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(expandedFoldersStorageKey) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator < 0 ? '' : path.slice(0, separator)
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

function findTreeNode(entries: TreeNode[], path: string): TreeNode | undefined {
  for (const entry of entries) {
    if (entry.path === path) return entry
    const child = entry.children && findTreeNode(entry.children, path)
    if (child) return child
  }
}

class APIError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.'
}

async function responseJSON<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new APIError(body.error ?? `Request failed (${response.status})`, response.status)
  return body
}

export function App() {
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [autoLockMinutes, setAutoLockMinutes] = useState<AutoLockMinutes>(() => loadAutoLockPreference(localStorage))
  const [syncPreferences, setSyncPreferences] = useState<SyncPreferences>(() => loadSyncPreferences(localStorage))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [notebookSwitcherOpen, setNotebookSwitcherOpen] = useState(false)
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine)
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent>()
  const [addNotebookOpen, setAddNotebookOpen] = useState(false)
  const [manageNotebooksOpen, setManageNotebooksOpen] = useState(false)
  const [notebooks, setNotebooks] = useState<NotebookInfo[]>([])
  const [activeNotebookID, setActiveNotebookID] = useState('')
  const [readOnly, setReadOnly] = useState(false)
  const [health, setHealth] = useState<Health>('checking')
  const [notebookName, setNotebookName] = useState('Notebook')
  const [entries, setEntries] = useState<TreeNode[]>([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError] = useState<string>()
  const [selectedPath, setSelectedPath] = useState<string>()
  const [note, setNote] = useState<FileResponse>()
  const [noteLoading, setNoteLoading] = useState(false)
  const [noteError, setNoteError] = useState<string>()
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [saveError, setSaveError] = useState<string>()
  const [gitStatus, setGitStatus] = useState<GitStatus>({ state: 'invalid', message: 'Checking Git status…' })
  const [gitSyncing, setGitSyncing] = useState(false)
  const [operationError, setOperationError] = useState<string>()
  const [operationBusy, setOperationBusy] = useState(false)
  const [selectedItem, setSelectedItem] = useState<TreeNode>()
  const [contextMenu, setContextMenu] = useState<MenuState>()
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [renameEntry, setRenameEntry] = useState<TreeNode>()
  const [renameValue, setRenameValue] = useState('')
  const [moveEntry, setMoveEntry] = useState<TreeNode>()
  const [moveDestination, setMoveDestination] = useState('')
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(loadExpandedFolders)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string>()
  const activeDraft = useRef<Draft | undefined>(undefined)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const savePromise = useRef<Promise<FileResponse> | undefined>(undefined)
  const syncPromise = useRef<Promise<boolean> | undefined>(undefined)
  const syncRequested = useRef(false)
  const localChangeGeneration = useRef(0)
  const lastSyncedGeneration = useRef(0)
  const lastSuccessfulSync = useRef(0)
  const gitStatusRef = useRef(gitStatus)
  const inactivitySyncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const syncRepositoryRef = useRef<() => Promise<boolean>>(async () => false)
  const syncPreferencesRef = useRef(syncPreferences)
  const closeSyncTriggered = useRef(false)
  const lastFocusSync = useRef(0)
  const editorActivity = useRef(0)
  const autoLockExpire = useRef<() => void>(() => undefined)
  const autoLockController = useRef<AutoLockController | null>(null)

  useEffect(() => {
    const handleOnline = () => setBrowserOnline(true)
    const handleOffline = () => setBrowserOnline(false)
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    const handleInstalled = () => setInstallPrompt(undefined)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    window.addEventListener('beforeinstallprompt', handleInstallPrompt)
    window.addEventListener('appinstalled', handleInstalled)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt)
      window.removeEventListener('appinstalled', handleInstalled)
    }
  }, [])

  useEffect(() => {
    const query = searchQuery.trim()
    if (!query) return
    const controller = new AbortController()
    const timer = globalThis.setTimeout(async () => {
      setSearchLoading(true)
      setSearchError(undefined)
      try {
        const response = await fetch(`/api/repository/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        const data = await responseJSON<{ results: SearchResult[] }>(response)
        setSearchResults(data.results)
      } catch (error) {
        if (!controller.signal.aborted) setSearchError(messageFrom(error))
      } finally {
        if (!controller.signal.aborted) setSearchLoading(false)
      }
    }, 250)
    return () => {
      globalThis.clearTimeout(timer)
      controller.abort()
    }
  }, [activeNotebookID, searchQuery])

  const loadTree = useCallback(async () => {
    setTreeLoading(true)
    setTreeError(undefined)
    try {
      const response = await fetch('/api/repository/tree')
      const data = await responseJSON<{ entries: TreeNode[] }>(response)
      setEntries(data.entries)
      setHealth('online')
    } catch (error) {
      setTreeError(messageFrom(error))
    } finally {
      setTreeLoading(false)
    }
  }, [])

  const refreshGitStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/repository/git/status')
      const status = await responseJSON<GitStatus>(response)
      gitStatusRef.current = status
      setGitStatus(status)
      if (status.lastSyncedAt) lastSuccessfulSync.current = Date.parse(status.lastSyncedAt) || 0
    } catch (error) {
      const status: GitStatus = { state: 'sync_failed', message: messageFrom(error) }
      gitStatusRef.current = status
      setGitStatus(status)
    }
  }, [])

  const loadNotebookInfo = useCallback(async () => {
    try {
      const response = await fetch('/api/notebook')
      const data = await responseJSON<{ name: string }>(response)
      setNotebookName(data.name || 'Notebook')
    } catch {
      setNotebookName('Notebook')
    }
  }, [])

  const loadNotebooks = useCallback(async () => {
    try {
      const response = await fetch('/api/notebooks')
      const data = await responseJSON<{ activeId: string; notebooks: NotebookInfo[] }>(response)
      setNotebooks(data.notebooks)
      setActiveNotebookID(data.activeId)
      const active = data.notebooks.find((notebook) => notebook.id === data.activeId)
      if (active) setNotebookName(active.name)
    } catch {
      // Directly configured notebooks remain usable without a registry.
    }
  }, [])

  useEffect(() => {
    fetch('/api/health').then((response) => {
      if (!response.ok) throw new Error('health check failed')
      setHealth('online')
    }).catch(() => setHealth('offline'))
    fetch('/api/repository/tree').then(responseJSON<{ entries: TreeNode[] }>).then((data) => {
      setEntries(data.entries)
      setHealth('online')
    }).catch((error: unknown) => setTreeError(messageFrom(error))).finally(() => setTreeLoading(false))
    fetch('/api/notebook').then(responseJSON<{ name: string }>).then((data) => setNotebookName(data.name || 'Notebook')).catch(() => setNotebookName('Notebook'))
    fetch('/api/notebooks').then(responseJSON<{ activeId: string; notebooks: NotebookInfo[] }>).then((data) => { setNotebooks(data.notebooks); setActiveNotebookID(data.activeId); const active = data.notebooks.find((notebook) => notebook.id === data.activeId); if (active) setNotebookName(active.name) }).catch(() => undefined)

    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      const draft = activeDraft.current
      if (draft && draft.content !== draft.savedContent) {
        event.preventDefault()
        return
      }
      if (syncPreferencesRef.current.syncOnClose && !closeSyncTriggered.current) {
        closeSyncTriggered.current = true
        void fetch('/api/repository/git/sync-background', { method: 'POST', keepalive: true })
      }
    }
    const syncOnPageHide = () => {
      const draft = activeDraft.current
      if (!syncPreferencesRef.current.syncOnClose || closeSyncTriggered.current || draft && draft.content !== draft.savedContent) return
      closeSyncTriggered.current = true
      void fetch('/api/repository/git/sync-background', { method: 'POST', keepalive: true })
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    window.addEventListener('pagehide', syncOnPageHide)
    return () => {
      window.removeEventListener('beforeunload', warnBeforeUnload)
      window.removeEventListener('pagehide', syncOnPageHide)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (inactivitySyncTimer.current) clearTimeout(inactivitySyncTimer.current)
    }
  }, [])

  useEffect(() => {
    const initial = globalThis.setTimeout(() => { void refreshGitStatus() }, 0)
    const interval = globalThis.setInterval(() => { void refreshGitStatus() }, 15_000)
    return () => { globalThis.clearTimeout(initial); globalThis.clearInterval(interval) }
  }, [refreshGitStatus])

  useEffect(() => {
    localStorage.setItem(expandedFoldersStorageKey, JSON.stringify([...expandedFolders]))
  }, [expandedFolders])

  useEffect(() => {
    document.documentElement.classList.toggle('theme-light', theme === 'light')
    document.documentElement.style.colorScheme = theme
    localStorage.setItem(themeStorageKey, theme)
  }, [theme])

  useEffect(() => {
    saveAutoLockPreference(localStorage, autoLockMinutes)
  }, [autoLockMinutes])

  useEffect(() => {
    syncPreferencesRef.current = syncPreferences
    saveSyncPreferences(localStorage, syncPreferences)
  }, [syncPreferences])

  useEffect(() => {
    if (syncPreferences.scheduledMinutes === 0) return
    const interval = globalThis.setInterval(() => { void syncRepositoryRef.current() }, syncPreferences.scheduledMinutes * 60_000)
    return () => globalThis.clearInterval(interval)
  }, [syncPreferences.scheduledMinutes])

  useEffect(() => {
    if (addNotebookOpen && syncPreferences.syncOnNotebookSwitch) void syncRepositoryRef.current()
  }, [addNotebookOpen, syncPreferences.syncOnNotebookSwitch])

  async function saveDraft(): Promise<boolean> {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (savePromise.current) {
      try {
        await savePromise.current
      } catch {
        return false
      }
    }

    const draft = activeDraft.current
    if (!draft || draft.content === draft.savedContent) {
      setSaveStatus('saved')
      return true
    }

    const snapshot = { path: draft.path, content: draft.content, version: draft.version }
    setSaveStatus('saving')
    setSaveError(undefined)
    const operation = fetch(`/api/repository/file?path=${encodeURIComponent(snapshot.path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: snapshot.content, version: snapshot.version }),
    }).then(responseJSON<FileResponse>)
    savePromise.current = operation

    try {
      const saved = await operation
      const current = activeDraft.current
      if (current?.path === snapshot.path) {
        current.version = saved.version
        current.savedContent = snapshot.content
      }
    } catch (error) {
      setSaveStatus(error instanceof APIError && error.status === 409 ? 'conflict' : 'error')
      setSaveError(messageFrom(error))
      return false
    } finally {
      savePromise.current = undefined
    }

    const current = activeDraft.current
    if (current?.path === snapshot.path && current.content !== current.savedContent) return saveDraft()
    setSaveStatus('saved')
    void refreshGitStatus()
    return true
  }

  async function syncRepository(): Promise<boolean> {
    if (syncPromise.current) return syncPromise.current
    const operation = (async () => {
      setGitSyncing(true)
      try {
        do {
          syncRequested.current = false
          if (!(await saveDraft())) return false
          const syncedGeneration = localChangeGeneration.current
          const response = await fetch('/api/repository/git/sync', { method: 'POST' })
          const result = await responseJSON<GitStatus>(response)
          gitStatusRef.current = result
          setGitStatus(result)
          if (result.state !== 'synced') return false

          lastSuccessfulSync.current = result.lastSyncedAt ? Date.parse(result.lastSyncedAt) || Date.now() : Date.now()
          lastSyncedGeneration.current = syncedGeneration
          await loadTree()

          const statusResponse = await fetch('/api/repository/git/status')
          const inspected = await responseJSON<GitStatus>(statusResponse)
          gitStatusRef.current = inspected
          setGitStatus(inspected)
          if (inspected.lastSyncedAt) lastSuccessfulSync.current = Date.parse(inspected.lastSyncedAt) || lastSuccessfulSync.current
          if (localChangeGeneration.current !== syncedGeneration || inspected.state === 'local_changes' || inspected.state === 'diverged') {
            syncRequested.current = true
          }
        } while (syncRequested.current)
        return true
      } catch (error) {
        const status: GitStatus = { state: 'sync_failed', message: messageFrom(error) }
        gitStatusRef.current = status
        setGitStatus(status)
        return false
      } finally {
        setGitSyncing(false)
      }
    })()
    syncPromise.current = operation
    try {
      return await operation
    } finally {
      syncPromise.current = undefined
    }
  }

  function requestNoteSwitchSync() {
    const status = gitStatusRef.current.state
    const recentlySynced = Date.now() - lastSuccessfulSync.current < noteSwitchSyncFreshnessMs
    const clean = status === 'clean' || status === 'synced'
    const noNewLocalChanges = localChangeGeneration.current === lastSyncedGeneration.current
    if (recentlySynced && clean && noNewLocalChanges) return
    void syncRepository()
  }

  useEffect(() => {
    syncRepositoryRef.current = syncRepository
  })

  useEffect(() => {
    if (syncPreferencesRef.current.syncOnStartup) void syncRepositoryRef.current()
    const syncAfterFocus = () => {
      if (!syncPreferencesRef.current.syncOnFocus || document.visibilityState === 'hidden') return
      const now = Date.now()
      if (now - lastFocusSync.current < 5_000) return
      lastFocusSync.current = now
      void syncRepositoryRef.current()
    }
    window.addEventListener('focus', syncAfterFocus)
    document.addEventListener('visibilitychange', syncAfterFocus)
    return () => {
      window.removeEventListener('focus', syncAfterFocus)
      document.removeEventListener('visibilitychange', syncAfterFocus)
    }
  }, [])

  async function activateClonedNotebook() {
    activeDraft.current = undefined
    setSelectedPath(undefined)
    setSelectedItem(undefined)
    setNote(undefined)
    setNoteError(undefined)
    setSaveStatus('saved')
    setExpandedFolders(new Set())
    await loadTree()
    await loadNotebookInfo()
    await loadNotebooks()
    await refreshGitStatus()
  }

  async function switchNotebook(notebook: NotebookInfo) {
    setMobileNavigationOpen(false)
    setNotebookSwitcherOpen(false)
    if (notebook.id === activeNotebookID) return
    if (!(await saveDraft())) return
    if (syncPreferences.syncOnNotebookSwitch) await syncRepository()
    setOperationBusy(true)
    setOperationError(undefined)
    try {
      const response = await fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/activate`, { method: 'POST' })
      await responseJSON<NotebookInfo>(response)
      activeDraft.current = undefined
      setSelectedPath(undefined)
      setSelectedItem(undefined)
      setNote(undefined)
      setNoteError(undefined)
      setEntries([])
      setExpandedFolders(new Set())
      setNotebookName(notebook.name)
      setActiveNotebookID(notebook.id)
      if (syncPreferences.syncOnNotebookSwitch) await syncRepository()
      await loadTree()
      await refreshGitStatus()
    } catch (error) {
      setOperationError(messageFrom(error))
    } finally {
      setOperationBusy(false)
    }
  }

  async function openNote(path: string) {
    if (path === selectedPath) return
    if (!(await saveDraft())) return
    setNoteLoading(true)
    setNoteError(undefined)
    setSaveError(undefined)
    try {
      const response = await fetch(`/api/repository/file?path=${encodeURIComponent(path)}`)
      const loaded = await responseJSON<FileResponse>(response)
      activeDraft.current = { ...loaded, savedContent: loaded.content }
      setNote(loaded)
      setSelectedPath(path)
      setReadOnly(false)
      setSaveStatus('saved')
      if (syncPreferences.syncBeforeOpeningNote) requestNoteSwitchSync()
    } catch (error) {
      setNoteError(messageFrom(error))
    } finally {
      setNoteLoading(false)
    }
  }

  function updateDraft(markdown: string) {
    const draft = activeDraft.current
    if (!draft || draft.content === markdown) return
    draft.content = markdown
    localChangeGeneration.current += 1
    setNote((current) => current?.path === draft.path ? { ...current, content: markdown } : current)
    editorActivity.current += 1
    autoLockController.current?.activity()
    setSaveStatus('unsaved')
    setSaveError(undefined)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void saveDraft() }, 800)
    if (inactivitySyncTimer.current) clearTimeout(inactivitySyncTimer.current)
    if (syncPreferences.inactivityMinutes > 0) {
      inactivitySyncTimer.current = setTimeout(() => { void syncRepositoryRef.current() }, syncPreferences.inactivityMinutes * 60_000)
    }
  }

  async function createEntry(type: 'file' | 'directory') {
    const parent = selectedItem?.type === 'directory' ? selectedItem.path : selectedItem ? parentPath(selectedItem.path) : ''
    const suggested = type === 'file' ? 'New note.md' : 'New folder'
    let name = window.prompt(type === 'file' ? `New note name${parent ? ` in ${parent}` : ''}` : 'New folder name', suggested)?.trim()
    if (!name) return
    if (name.includes('/') || name.includes('\\')) {
      setOperationError('Enter a name only. Choose the destination folder in the tree.')
      return
    }
    if (type === 'file' && !name.toLowerCase().endsWith('.md')) name += '.md'
    const path = parent ? `${parent}/${name}` : name
    setOperationBusy(true)
    setOperationError(undefined)
    try {
      const response = await fetch('/api/repository/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, type }) })
      await responseJSON<{ path: string; type: string }>(response)
      if (parent) setExpandedFolders((current) => new Set(current).add(parent))
      await loadTree()
      setSelectedItem({ name: baseName(path), path, type })
      if (type === 'file') await openNote(path)
    } catch (error) {
      setOperationError(messageFrom(error))
    } finally {
      setOperationBusy(false)
    }
  }

  async function performMove(entry: TreeNode, target: string) {
    if (target === entry.path) return
    if (!(await saveDraft())) return
    setOperationBusy(true)
    setOperationError(undefined)
    try {
      const response = await fetch('/api/repository/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: entry.path, target }) })
      await responseJSON<{ path: string }>(response)
      const affectedPath = selectedPath === entry.path || selectedPath?.startsWith(`${entry.path}/`)
        ? target + selectedPath.slice(entry.path.length)
        : undefined
      if (selectedItem && (selectedItem.path === entry.path || selectedItem.path.startsWith(`${entry.path}/`))) {
        const movedSelectionPath = target + selectedItem.path.slice(entry.path.length)
        setSelectedItem({ ...selectedItem, path: movedSelectionPath, name: baseName(movedSelectionPath) })
      }
      setExpandedFolders((current) => {
        const next = new Set<string>()
        for (const folder of current) {
          next.add(folder === entry.path || folder.startsWith(`${entry.path}/`) ? target + folder.slice(entry.path.length) : folder)
        }
        return next
      })
      if (affectedPath) {
        activeDraft.current = undefined
        setNote(undefined)
        setSelectedPath(undefined)
      }
      await loadTree()
      if (affectedPath) await openNote(affectedPath)
    } catch (error) {
      setOperationError(messageFrom(error))
    } finally {
      setOperationBusy(false)
    }
  }

  function beginRename(entry: TreeNode) {
    setContextMenu(undefined)
    setOverflowOpen(false)
    setRenameEntry(entry)
    setRenameValue(entry.name)
  }

  async function commitRename() {
    const entry = renameEntry
    let name = renameValue.trim()
    if (!entry || !name) return
    if (name.includes('/') || name.includes('\\')) {
      setOperationError('A name cannot contain path separators.')
      return
    }
    if (entry.type === 'file' && !name.toLowerCase().endsWith('.md')) name += '.md'
    setRenameEntry(undefined)
    const parent = parentPath(entry.path)
    await performMove(entry, parent ? `${parent}/${name}` : name)
  }

  function beginMove(entry: TreeNode) {
    setContextMenu(undefined)
    setOverflowOpen(false)
    setMoveEntry(entry)
    setMoveDestination(parentPath(entry.path))
  }

  async function confirmMove() {
    if (!moveEntry) return
    const entry = moveEntry
    const target = moveDestination ? `${moveDestination}/${entry.name}` : entry.name
    setMoveEntry(undefined)
    await performMove(entry, target)
  }

  async function deleteEntry(entry: TreeNode) {
    const assetWarning = entry.type === 'file' ? ' Its owned .assets directory will also be deleted if present.' : ' Everything inside this folder will also be deleted.'
    if (!window.confirm(`Permanently delete “${entry.path}”?${assetWarning}`)) return
    if (!(await saveDraft())) return
    setOperationBusy(true)
    setOperationError(undefined)
    try {
      const response = await fetch(`/api/repository/entry?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' })
      if (!response.ok) await responseJSON<never>(response)
      if (selectedPath === entry.path || selectedPath?.startsWith(`${entry.path}/`)) {
        activeDraft.current = undefined
        setNote(undefined)
        setSelectedPath(undefined)
        setSaveStatus('saved')
        setSaveError(undefined)
      }
      if (selectedItem?.path === entry.path || selectedItem?.path.startsWith(`${entry.path}/`)) setSelectedItem(undefined)
      setExpandedFolders((current) => new Set([...current].filter((folder) => folder !== entry.path && !folder.startsWith(`${entry.path}/`))))
      await loadTree()
    } catch (error) {
      setOperationError(messageFrom(error))
    } finally {
      setOperationBusy(false)
    }
  }

  function selectEntry(entry: TreeNode) {
    setSelectedItem(entry)
    setOverflowOpen(false)
    if (entry.type === 'file') {
      setMobileNavigationOpen(false)
      void openNote(entry.path)
    }
  }

  function selectSearchResult(result: SearchResult) {
    if (result.type !== 'directory') {
      setMobileNavigationOpen(false)
      const entry = findTreeNode(entries, result.path)
      if (entry) setSelectedItem(entry)
      setExpandedFolders((current) => {
        const next = new Set(current)
        let folder = parentPath(result.path)
        while (folder) {
          next.add(folder)
          folder = parentPath(folder)
        }
        return next
      })
      void openNote(result.path)
      return
    }
    const entry = findTreeNode(entries, result.path)
    if (entry) setSelectedItem(entry)
    setExpandedFolders((current) => {
      const next = new Set(current)
      let folder = result.path
      while (folder) {
        next.add(folder)
        folder = parentPath(folder)
      }
      return next
    })
    setSearchQuery('')
  }

  function showContextMenu(entry: TreeNode, event: MouseEvent) {
    event.preventDefault()
    setSelectedItem(entry)
    setOverflowOpen(false)
    setContextMenu({ entry, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 176)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 132)) })
  }

  function toggleFolder(path: string) {
    setExpandedFolders((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  useEffect(() => {
    autoLockExpire.current = () => {
      const path = selectedPath
      const activity = editorActivity.current
      if (!path || readOnly) return
      void saveDraft().then((saved) => {
        if (saved && activeDraft.current?.path === path && editorActivity.current === activity) setReadOnly(true)
      })
    }
  })

  useEffect(() => {
    const controller = new AutoLockController(() => autoLockExpire.current())
    autoLockController.current = controller
    return () => controller.dispose()
  }, [])

  useEffect(() => {
    autoLockController.current?.update(autoLockMinutes, Boolean(selectedPath) && !readOnly)
  }, [autoLockMinutes, readOnly, selectedPath])

  async function toggleReadOnly() {
    if (readOnly) {
      setReadOnly(false)
      return
    }
    if (await saveDraft()) setReadOnly(true)
  }

  const selectedFolderPath = selectedItem?.type === 'directory' ? selectedItem.path : selectedItem ? parentPath(selectedItem.path) : ''
  const createInName = selectedFolderPath ? baseName(selectedFolderPath) : notebookName

  async function installApplication() {
    if (!installPrompt) return
    await installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(undefined)
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100 lg:h-screen lg:flex-row lg:overflow-hidden">
      {mobileNavigationOpen && <button type="button" aria-label="Close notebook navigation" className="fixed inset-0 z-30 bg-black/65 lg:hidden" onClick={() => setMobileNavigationOpen(false)} />}
      <aside aria-label="Notebook navigation" className={`fixed inset-y-0 left-0 z-40 flex w-[min(20rem,calc(100vw-3rem))] shrink-0 flex-col border-r border-zinc-800 bg-zinc-900 shadow-2xl transition-transform duration-200 lg:static lg:z-auto lg:w-80 lg:translate-x-0 lg:bg-zinc-900/60 lg:shadow-none ${mobileNavigationOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <header className="relative border-b border-zinc-800 px-5 py-5"><div className="flex items-center justify-between gap-3"><div className="min-w-0 flex-1"><p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-400">RepoQuill</p><button type="button" aria-haspopup="menu" aria-expanded={notebookSwitcherOpen} onClick={() => setNotebookSwitcherOpen((open) => !open)} className="mt-1 flex min-h-9 max-w-full items-center gap-2 rounded-md pr-2 text-left text-lg font-semibold outline-none hover:text-amber-200 focus-visible:ring-2 focus-visible:ring-amber-500"><span className="truncate">{notebookName}</span><span aria-hidden="true" className="text-xs text-zinc-500">▾</span></button></div><div className="flex items-center gap-2"><button type="button" onClick={() => setSettingsOpen(true)} className="rounded-md border border-zinc-700 p-2 text-zinc-300 hover:bg-zinc-800 hover:text-white" aria-label="Settings" title="Settings"><SettingsIcon /></button><button type="button" onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}><span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span></button><StatusDot health={health} /></div></div>{notebookSwitcherOpen && <><button type="button" aria-label="Close notebook switcher" className="fixed inset-0 z-20 cursor-default" onClick={() => setNotebookSwitcherOpen(false)} /><div role="menu" aria-label="Notebooks" className="absolute top-[4.8rem] right-3 left-3 z-30 rounded-lg border border-zinc-700 bg-zinc-900 p-1.5 shadow-2xl">{notebooks.map((notebook) => <button key={notebook.id} type="button" role="menuitemradio" aria-checked={notebook.id === activeNotebookID} onClick={() => void switchNotebook(notebook)} className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-zinc-200 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"><span className="w-4 text-amber-400" aria-hidden="true">{notebook.id === activeNotebookID ? '✓' : ''}</span><span className="truncate">{notebook.name}</span></button>)}<div className="my-1 border-t border-zinc-700" /><button type="button" role="menuitem" onClick={() => { setNotebookSwitcherOpen(false); setAddNotebookOpen(true) }} className="min-h-11 w-full rounded-md px-3 text-left text-sm text-amber-300 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">+ Add Notebook</button><button type="button" role="menuitem" onClick={() => { setNotebookSwitcherOpen(false); setManageNotebooksOpen(true) }} className="min-h-11 w-full rounded-md px-3 text-left text-sm text-zinc-300 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">Manage Notebooks</button></div></>}</header>
        <div className="relative grid grid-cols-[1fr_1fr_auto_auto] gap-1.5 border-b border-zinc-800 p-3">
          <TreeAction disabled={operationBusy} onClick={() => void createEntry('file')}>New Note</TreeAction>
          <TreeAction disabled={operationBusy} onClick={() => void createEntry('directory')}>New Folder</TreeAction>
          <TreeAction label="Refresh tree" disabled={operationBusy} onClick={() => void loadTree()}>↻</TreeAction>
          <TreeAction label="Selected item actions" disabled={operationBusy || !selectedItem} onClick={() => setOverflowOpen((open) => !open)}>•••</TreeAction>
          {overflowOpen && <button type="button" className="fixed inset-0 z-20 cursor-default" aria-label="Close action menu" onClick={() => setOverflowOpen(false)} />}
          {overflowOpen && selectedItem && <div className="absolute top-12 right-3 z-30"><ActionMenu entry={selectedItem} onRename={beginRename} onMove={beginMove} onDelete={(entry) => { setOverflowOpen(false); void deleteEntry(entry) }} /></div>}
        </div>
        <div className="border-b border-zinc-800 px-3 py-2 text-xs text-zinc-500">Create in: <span className="text-zinc-300">{createInName}</span></div>
        <div className="border-b border-zinc-800 p-3">
          <div className="relative">
            <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-zinc-500">⌕</span>
            <input type="search" value={searchQuery} onChange={(event) => { const value = event.target.value; setSearchQuery(value); if (!value.trim()) { setSearchResults([]); setSearchLoading(false); setSearchError(undefined) } }} placeholder="Search this notebook" aria-label="Search this notebook" className="min-h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 py-2 pr-9 pl-9 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-amber-500 focus:ring-1 focus:ring-amber-500" />
            {searchQuery && <button type="button" onClick={() => { setSearchQuery(''); setSearchResults([]); setSearchLoading(false); setSearchError(undefined) }} aria-label="Clear search" className="absolute top-1/2 right-1.5 min-h-8 min-w-8 -translate-y-1/2 rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">×</button>}
          </div>
        </div>
        <div className="max-h-80 overflow-y-auto p-3 lg:max-h-none lg:flex-1">
          {operationError && <div className="mb-3 rounded-lg border border-red-900/70 bg-red-950/30 p-3 text-sm text-red-200">{operationError}</div>}
          {searchQuery.trim() && <SearchResults query={searchQuery.trim()} results={searchResults} loading={searchLoading} error={searchError} onSelect={selectSearchResult} />}
          {!searchQuery.trim() && <>
          {treeLoading && <SidebarMessage>Loading repository…</SidebarMessage>}
          {treeError && <div className="rounded-lg border border-red-900/70 bg-red-950/30 p-3 text-sm text-red-200"><p>{treeError}</p>{treeError === 'repository is not configured' && <p className="mt-2 text-xs text-red-300/80">Set REPOQUILL_REPOSITORY and restart the backend.</p>}<button className="mt-3 rounded-md bg-red-900/60 px-3 py-1.5 text-xs hover:bg-red-800" onClick={() => void loadTree()}>Try again</button></div>}
          {!treeLoading && !treeError && <button type="button" className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${!selectedItem ? 'bg-amber-400/15 text-amber-200' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'}`} onClick={() => { setSelectedItem(undefined); setOverflowOpen(false) }}><span aria-hidden="true">⌂</span><span className="truncate">{notebookName}</span></button>}
          {!treeLoading && !treeError && entries.length === 0 && <SidebarMessage>No Markdown files found.</SidebarMessage>}
          {!treeLoading && !treeError && entries.length > 0 && <nav aria-label="Notebook notes"><ul className="space-y-0.5">{entries.map((entry) => <TreeEntry key={entry.path} entry={entry} selectedPath={selectedItem?.path} expandedFolders={expandedFolders} renamePath={renameEntry?.path} renameValue={renameValue} onSelect={selectEntry} onToggleFolder={toggleFolder} onContextMenu={showContextMenu} onRenameValue={setRenameValue} onRenameCommit={() => void commitRename()} onRenameCancel={() => setRenameEntry(undefined)} />)}</ul></nav>}
          </>}
        </div>
      </aside>

      <main className="flex min-h-screen min-w-0 flex-1 flex-col overflow-y-auto lg:min-h-[60vh]">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-950/90 px-3 py-3 backdrop-blur sm:gap-4 sm:px-8">
          <div className="flex min-w-0 items-center gap-2"><button type="button" aria-label="Open notebook navigation" aria-expanded={mobileNavigationOpen} onClick={() => setMobileNavigationOpen(true)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-700 text-lg text-zinc-300 hover:bg-zinc-800 lg:hidden">☰</button><p className="min-w-0 truncate text-sm text-zinc-400">{selectedPath ?? 'Select a Markdown file'}</p></div>
          <div className="flex shrink-0 items-center gap-2">{selectedPath && <><button type="button" onClick={() => void toggleReadOnly()} className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${readOnly ? 'border-amber-500 bg-amber-400/15 text-amber-200' : 'border-zinc-700 text-zinc-200 hover:bg-zinc-800'}`} aria-pressed={readOnly}>{readOnly ? '🔒 Read only' : '✎ Edit'}</button><button type="button" disabled={readOnly || saveStatus === 'saved' || saveStatus === 'saving'} onClick={() => void saveDraft()} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:cursor-default disabled:opacity-40">Save</button></>}<button type="button" disabled={gitSyncing || saveStatus === 'saving' || saveStatus === 'error' || saveStatus === 'conflict'} onClick={() => void syncRepository()} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:cursor-default disabled:opacity-40">{gitSyncing ? 'Syncing…' : 'Sync'}</button></div>
        </header>
        {(!browserOnline || health === 'offline') && <div role="status" className="border-b border-amber-800/70 bg-amber-950/40 px-4 py-2 text-sm text-amber-100 sm:px-8"><strong>Offline.</strong> RepoQuill is online-first; viewing may continue, but editing and synchronization require the server connection.</div>}
        {installPrompt && <div className="flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2 text-xs text-zinc-300 sm:px-8"><span>Install RepoQuill for a standalone app experience.</span><button type="button" onClick={() => void installApplication()} className="min-h-9 shrink-0 rounded-md border border-zinc-600 px-3 font-medium hover:bg-zinc-800">Install app</button></div>}
        <article className={`mx-auto w-full max-w-4xl flex-1 px-5 sm:px-8 ${selectedPath ? 'pt-2 pb-8 sm:pt-2 sm:pb-12' : 'py-8 sm:py-12'}`}>
          {!selectedPath && <EmptyState />}
          {noteLoading && <p className="text-sm text-zinc-400">Loading note…</p>}
          {noteError && <ErrorMessage>{noteError}</ErrorMessage>}
          {saveError && <ErrorMessage>{saveStatus === 'conflict' ? 'Save stopped: the file changed outside RepoQuill. Your edits remain in the editor; copy them somewhere safe before reloading the page to resolve the conflict.' : `Save failed: ${saveError}`}</ErrorMessage>}
          {!noteLoading && note && <Suspense fallback={<p className="text-sm text-zinc-400">Loading editor…</p>}><MarkdownEditor key={`${note.path}:${readOnly ? 'read' : 'edit'}`} documentKey={`${note.path}:${readOnly ? 'read' : 'edit'}`} notePath={note.path} markdown={note.content} readOnly={readOnly} onChange={updateDraft} /></Suspense>}
        </article>
        {selectedPath && note && <DocumentStatusBar status={saveStatus} gitStatus={gitStatus} gitSyncing={gitSyncing} markdown={note.content} />}
      </main>
      {contextMenu && <div className="fixed inset-0 z-40" onClick={() => setContextMenu(undefined)} onContextMenu={(event) => { event.preventDefault(); setContextMenu(undefined) }}><div className="fixed" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}><ActionMenu entry={contextMenu.entry} onRename={beginRename} onMove={beginMove} onDelete={(entry) => { setContextMenu(undefined); void deleteEntry(entry) }} /></div></div>}
      {moveEntry && <FolderPicker entries={entries} notebookName={notebookName} moving={moveEntry} destination={moveDestination} onDestination={setMoveDestination} onCancel={() => setMoveEntry(undefined)} onConfirm={() => void confirmMove()} />}
      {settingsOpen && <SettingsDialog mode="settings" autoLockMinutes={autoLockMinutes} onAutoLockMinutes={setAutoLockMinutes} syncPreferences={syncPreferences} onSyncPreferences={setSyncPreferences} onClose={() => setSettingsOpen(false)} />}
      {addNotebookOpen && <SettingsDialog mode="onboarding" autoLockMinutes={autoLockMinutes} onAutoLockMinutes={setAutoLockMinutes} onNotebookAdded={async () => { await activateClonedNotebook(); setAddNotebookOpen(false) }} onClose={() => setAddNotebookOpen(false)} />}
      {manageNotebooksOpen && <ManageNotebooksDialog notebooks={notebooks} activeNotebookID={activeNotebookID} onClose={() => setManageNotebooksOpen(false)} />}
    </div>
  )
}

export function SettingsDialog({ mode = 'settings', autoLockMinutes, onAutoLockMinutes, syncPreferences = defaultSyncPreferences, onSyncPreferences = () => undefined, onNotebookAdded, onClose }: { mode?: 'settings' | 'onboarding'; autoLockMinutes: AutoLockMinutes; onAutoLockMinutes: (value: AutoLockMinutes) => void; syncPreferences?: SyncPreferences; onSyncPreferences?: (value: SyncPreferences) => void; onNotebookAdded?: () => Promise<void> | void; onClose: () => void }) {
  const [cleanupAssets, setCleanupAssets] = useState<CleanupAsset[]>()
  const [selectedAssets, setSelectedAssets] = useState<Set<string>>(new Set())
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [cleanupError, setCleanupError] = useState<string>()
  const [cleanupFailures, setCleanupFailures] = useState<CleanupFailure[]>([])
  const [confirmCleanup, setConfirmCleanup] = useState(false)
  const [notebookName, setNotebookName] = useState('')
  const [repositoryURL, setRepositoryURL] = useState('')
  const [repositoryBranch, setRepositoryBranch] = useState('')
  const [gitAuthType, setGitAuthType] = useState<GitAuthType>('managed-ssh')
  const [managedKey, setManagedKey] = useState<{ keyId: string; publicKey: string }>()
  const [keySource, setKeySource] = useState<'new' | 'existing'>('new')
  const [keyBusy, setKeyBusy] = useState(false)
  const [copyState, setCopyState] = useState<string>()
  const [connectionResult, setConnectionResult] = useState<ConnectionResult>()
  const [connectionBusy, setConnectionBusy] = useState(false)
  const [hostTrust, setHostTrust] = useState<HostTrustDiscovery>()
  const [trustBusy, setTrustBusy] = useState(false)
  const [cloneBusy, setCloneBusy] = useState(false)
  const [cloneError, setCloneError] = useState<string>()
  const [managedKeys, setManagedKeys] = useState<ManagedSSHKey[]>()
  const [managedKeysError, setManagedKeysError] = useState<string>()
  const [managedKeysBusy, setManagedKeysBusy] = useState(false)
  const [deleteKey, setDeleteKey] = useState<ManagedSSHKey>()

  const loadManagedKeys = useCallback(async () => {
    setManagedKeysBusy(true)
    setManagedKeysError(undefined)
    try {
      const response = await fetch('/api/notebooks/ssh-keys')
      const data = await responseJSON<{ keys: ManagedSSHKey[] }>(response)
      setManagedKeys(data.keys)
    } catch (error) {
      setManagedKeysError(messageFrom(error))
    } finally {
      setManagedKeysBusy(false)
    }
  }, [])

  async function cloneNotebook(event: FormEvent) {
    event.preventDefault()
    setCloneBusy(true)
    setCloneError(undefined)
    try {
      const response = await fetch('/api/notebooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: notebookName, repositoryUrl: repositoryURL, branch: repositoryBranch, authType: gitAuthType, keyId: managedKey?.keyId ?? '' }) })
      await responseJSON<{ id: string; name: string; localPath: string; branch: string }>(response)
      await onNotebookAdded?.()
      onClose()
    } catch (error) {
      setCloneError(messageFrom(error))
    } finally {
      setCloneBusy(false)
    }
  }

  function invalidateConnection() { setConnectionResult(undefined); setHostTrust(undefined) }

  async function generateManagedKey() {
    setKeyBusy(true)
    setCloneError(undefined)
    setCopyState(undefined)
    try {
      const response = await fetch('/api/notebooks/ssh-key', { method: 'POST' })
      setManagedKey(await responseJSON<{ keyId: string; publicKey: string }>(response))
      invalidateConnection()
    } catch (error) {
      setCloneError(messageFrom(error))
    } finally {
      setKeyBusy(false)
    }
  }

  async function deleteUnusedManagedKey() {
    if (!deleteKey || deleteKey.assigned) return
    setManagedKeysBusy(true)
    setManagedKeysError(undefined)
    try {
      const response = await fetch(`/api/notebooks/ssh-keys/${encodeURIComponent(deleteKey.keyId)}`, { method: 'DELETE' })
      await responseJSON<{ deleted: string }>(response)
      setDeleteKey(undefined)
      await loadManagedKeys()
    } catch (error) {
      setManagedKeysError(messageFrom(error))
      setDeleteKey(undefined)
      setManagedKeysBusy(false)
    }
  }

  async function copyPublicKey() {
    if (!managedKey) return
    try {
      await navigator.clipboard.writeText(managedKey.publicKey)
      setCopyState('Public key copied')
    } catch {
      setCopyState('Copy failed. Select and copy the public key manually.')
    }
  }

  async function testRepositoryConnection() {
    setConnectionBusy(true)
    setCloneError(undefined)
    setConnectionResult(undefined)
    try {
      const response = await fetch('/api/notebooks/test-connection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryUrl: repositoryURL, branch: repositoryBranch, authType: gitAuthType, keyId: managedKey?.keyId ?? '' }) })
      const result = await responseJSON<ConnectionResult>(response)
      setConnectionResult(result)
      if (result.state === 'host_verification_failed') {
        const discoveryResponse = await fetch('/api/notebooks/ssh-host/discover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryUrl: repositoryURL }) })
        setHostTrust(await responseJSON<HostTrustDiscovery>(discoveryResponse))
      }
    } catch (error) {
      setConnectionResult({ state: 'failed', message: messageFrom(error) })
    } finally {
      setConnectionBusy(false)
    }
  }

  async function trustSSHHost() {
    if (!hostTrust?.requestId) return
    setTrustBusy(true)
    setCloneError(undefined)
    try {
      const response = await fetch('/api/notebooks/ssh-host/trust', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: hostTrust.requestId }) })
      await responseJSON<HostTrustDiscovery>(response)
      setHostTrust(undefined)
      await testRepositoryConnection()
    } catch (error) {
      setCloneError(messageFrom(error))
    } finally {
      setTrustBusy(false)
    }
  }

  async function scanAssets() {
    setCleanupBusy(true)
    setCleanupError(undefined)
    setCleanupFailures([])
    try {
      const response = await fetch('/api/repository/assets/unreferenced')
      const data = await responseJSON<{ assets: CleanupAsset[] }>(response)
      setCleanupAssets(data.assets)
      setSelectedAssets(new Set(data.assets.map((asset) => asset.path)))
    } catch (error) {
      setCleanupError(messageFrom(error))
    } finally {
      setCleanupBusy(false)
    }
  }

  async function deleteSelectedAssets() {
    const paths = [...selectedAssets]
    if (paths.length === 0) return
    setConfirmCleanup(false)
    setCleanupBusy(true)
    setCleanupError(undefined)
    setCleanupFailures([])
    try {
      const response = await fetch('/api/repository/assets/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      })
      const result = await responseJSON<{ deleted: string[]; failures: CleanupFailure[] }>(response)
      const deleted = new Set(result.deleted)
      setCleanupAssets((current) => current?.filter((asset) => !deleted.has(asset.path)))
      setSelectedAssets(new Set(result.failures.map((failure) => failure.path)))
      setCleanupFailures(result.failures)
    } catch (error) {
      setCleanupError(messageFrom(error))
    } finally {
      setCleanupBusy(false)
    }
  }

  const selectedCount = selectedAssets.size
  const totalSize = cleanupAssets?.reduce((total, asset) => total + asset.size, 0) ?? 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby="settings-title" className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <header className="shrink-0 border-b border-zinc-800 px-5 py-4"><h2 id="settings-title" className="text-lg font-semibold">{mode === 'onboarding' ? 'Add Notebook' : 'Settings'}</h2></header>
        <div className={`overflow-y-auto p-5 ${mode === 'settings' ? 'flex flex-col' : ''}`}>
          {mode === 'onboarding' && <section>
            <h3 className="text-sm font-semibold text-zinc-200">Notebook</h3>
            <p className="mt-1 text-xs leading-5 text-zinc-500">Clone an existing provider-independent Git repository and make it the active notebook.</p>
            <form className="mt-3 space-y-3" onSubmit={(event) => void cloneNotebook(event)}>
              <label className="block text-xs text-zinc-300">Notebook name<input required maxLength={100} value={notebookName} onChange={(event) => setNotebookName(event.target.value)} className="mt-1.5 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500" placeholder="Private" /></label>
              <label className="block text-xs text-zinc-300">Repository URL<input required value={repositoryURL} onChange={(event) => { setRepositoryURL(event.target.value); invalidateConnection() }} className="mt-1.5 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500" placeholder="git@example.com:user/notes.git" /></label>
              <label className="block text-xs text-zinc-300">Branch <span className="text-zinc-500">(optional)</span><input value={repositoryBranch} onChange={(event) => { setRepositoryBranch(event.target.value); invalidateConnection() }} className="mt-1.5 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500" placeholder="Default branch" /></label>
              <fieldset><legend className="text-xs text-zinc-300">Authentication</legend><label className="mt-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-zinc-800 px-3"><input type="radio" name="git-auth" value="managed-ssh" checked={gitAuthType === 'managed-ssh'} onChange={() => { setGitAuthType('managed-ssh'); invalidateConnection() }} className="h-4 w-4 accent-amber-500" /><span><span className="block text-sm text-zinc-200">RepoQuill-managed SSH key</span><span className="block text-[11px] text-zinc-500">Recommended · no personal private key upload</span></span></label><label className="mt-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-zinc-800 px-3"><input type="radio" name="git-auth" value="existing-server-ssh" checked={gitAuthType === 'existing-server-ssh'} onChange={() => { setGitAuthType('existing-server-ssh'); invalidateConnection() }} className="h-4 w-4 accent-amber-500" /><span><span className="block text-sm text-zinc-200">Existing server SSH configuration</span><span className="block text-[11px] text-zinc-500">Advanced operator-managed credentials</span></span></label></fieldset>
              {gitAuthType === 'managed-ssh' && <div className="rounded-md border border-zinc-800 p-3"><div><p className="text-xs font-medium text-zinc-200">Dedicated SSH key</p><p className="mt-1 text-[11px] leading-4 text-zinc-500">The private key stays on the RepoQuill server.</p></div><div className="mt-3 grid gap-2 sm:grid-cols-2"><label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200"><input type="radio" name="key-source" checked={keySource === 'new'} onChange={() => { setKeySource('new'); setManagedKey(undefined); invalidateConnection() }} className="accent-amber-500" />Generate new key</label><label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200"><input type="radio" name="key-source" checked={keySource === 'existing'} onChange={() => { setKeySource('existing'); setManagedKey(undefined); invalidateConnection(); void loadManagedKeys() }} className="accent-amber-500" />Use existing key</label></div>{keySource === 'new' && !managedKey && <button type="button" disabled={keyBusy} onClick={() => void generateManagedKey()} className="mt-3 min-h-10 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">{keyBusy ? 'Generating…' : 'Generate key'}</button>}{keySource === 'existing' && <div className="mt-3">{managedKeysBusy && <p className="text-xs text-zinc-500">Loading keys…</p>}{managedKeysError && <p role="alert" className="text-xs text-red-300">{managedKeysError}</p>}{managedKeys && <label className="block text-xs text-zinc-300">Existing unassigned key<select value={managedKey?.keyId ?? ''} onChange={(event) => { const selected = managedKeys.find((key) => key.keyId === event.target.value && !key.assigned); setManagedKey(selected ? { keyId: selected.keyId, publicKey: selected.publicKey } : undefined); invalidateConnection() }} className="mt-1.5 min-h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100"><option value="">Select a key</option>{managedKeys.filter((key) => !key.assigned).map((key) => <option key={key.keyId} value={key.keyId}>{key.keyId.slice(0, 12)}… · {key.fingerprint || 'fingerprint unavailable'} · {new Date(key.createdAt).toLocaleDateString()}</option>)}</select></label>}{managedKeys && managedKeys.every((key) => key.assigned) && <p className="mt-2 text-xs text-zinc-500">No unassigned managed keys are available.</p>}</div>}{managedKey && <div className="mt-3"><p className="text-xs text-emerald-400">{keySource === 'new' ? 'Key generated' : 'Existing key selected'}</p><label className="mt-2 block text-xs text-zinc-300">SSH public key<textarea readOnly rows={4} value={managedKey.publicKey} className="mt-1.5 w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-[11px] leading-4 text-zinc-300" /></label><div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span role="status" className="text-[11px] text-zinc-500">{copyState}</span><button type="button" onClick={() => void copyPublicKey()} className="min-h-10 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-800">Copy public key</button></div><p className="mt-2 text-xs leading-5 text-amber-300">Add this key as a repository/deploy key with read and write access in your Git provider.</p></div>}</div>}
              <div className="rounded-md border border-zinc-800 p-3"><div className="flex items-center justify-between gap-3"><div><p className="text-xs font-medium text-zinc-200">Connection</p><p className="mt-1 text-[11px] text-zinc-500">Secure SSH host verification remains enabled.</p></div><button type="button" disabled={connectionBusy || !repositoryURL || (gitAuthType === 'managed-ssh' && !managedKey)} onClick={() => void testRepositoryConnection()} className="min-h-10 shrink-0 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">{connectionBusy ? 'Testing…' : 'Test connection'}</button></div>{connectionResult && <p role="status" className={`mt-2 text-xs leading-5 ${connectionResult.state === 'success' ? 'text-emerald-400' : 'text-red-300'}`}>{connectionResult.message}</p>}{hostTrust && <div className={`mt-3 rounded-md border p-3 ${hostTrust.state === 'host_key_changed' ? 'border-red-700 bg-red-950/30' : 'border-amber-700/70 bg-amber-950/20'}`}><h4 className="text-sm font-semibold text-zinc-100">{hostTrust.state === 'host_key_changed' ? 'SSH host key changed' : 'Unknown SSH host'}</h4><p className="mt-2 text-xs text-zinc-300"><span className="text-zinc-500">Host:</span> {hostTrust.host}{hostTrust.port !== 22 ? `:${hostTrust.port}` : ''}</p><HostFingerprintList title="Presented fingerprints" keys={hostTrust.presentedKeys} />{hostTrust.previouslyTrustedKeys && <HostFingerprintList title="Previously trusted fingerprints" keys={hostTrust.previouslyTrustedKeys} />}<p className="mt-3 text-xs leading-5 text-zinc-400">{hostTrust.state === 'host_key_changed' ? 'The presented identity no longer matches RepoQuill’s trusted key. This may be a legitimate rotation or a security problem. Connection is blocked; an administrator must review the trust store manually.' : 'Compare these fingerprints with a trusted source for your Git server. Discovery alone does not verify the server identity.'}</p>{hostTrust.state === 'unknown_host' && <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={() => setHostTrust(undefined)} className="min-h-11 rounded-md border border-zinc-700 px-4 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button><button type="button" disabled={trustBusy} onClick={() => void trustSSHHost()} className="min-h-11 rounded-md bg-amber-500 px-4 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40">{trustBusy ? 'Trusting…' : 'Trust host'}</button></div>}</div>}</div>
              {cloneError && <p role="alert" className="rounded-md border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{cloneError}</p>}
              <div className="flex justify-end"><button type="submit" disabled={cloneBusy || connectionResult?.state !== 'success'} className="min-h-10 rounded-md border border-zinc-700 px-4 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">{cloneBusy ? 'Cloning…' : 'Clone and add'}</button></div>
            </form>
          </section>}

          {mode === 'settings' && <section className="order-3 mt-6 border-t border-zinc-800 pt-5" aria-labelledby="ssh-keys-title">
            <div className="flex items-start justify-between gap-3"><div><h3 id="ssh-keys-title" className="text-sm font-semibold text-zinc-200">Git / SSH</h3><p className="mt-1 text-xs leading-5 text-zinc-500">Managed keys remain on the server. Only their public halves are shown here.</p></div><button type="button" disabled={managedKeysBusy} onClick={() => void loadManagedKeys()} className="min-h-10 shrink-0 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">{managedKeys ? 'Refresh' : 'Load keys'}</button></div>
            {managedKeysError && <p role="alert" className="mt-3 rounded-md border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{managedKeysError}</p>}
            {managedKeysBusy && !managedKeys && <p className="mt-3 text-xs text-zinc-500">Loading managed keys…</p>}
            {managedKeys && <div className="mt-3 space-y-2">{managedKeys.length === 0 ? <p className="rounded-md border border-zinc-800 p-3 text-xs text-zinc-500">No managed SSH keys found.</p> : managedKeys.map((key) => <div key={key.keyId} className="rounded-md border border-zinc-800 p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-mono text-xs text-zinc-300">{key.keyId.slice(0, 12)}…</p><p className={`mt-1 text-xs ${key.assigned ? 'text-emerald-400' : 'text-amber-300'}`}>{key.assigned ? `Assigned to ${key.notebookName || 'notebook'}` : 'Unused'}</p><p className="mt-1 text-[11px] text-zinc-500">Created {new Date(key.createdAt).toLocaleString()}</p></div><div className="flex flex-wrap gap-1"><button type="button" onClick={() => void navigator.clipboard.writeText(key.publicKey)} className="min-h-10 rounded-md px-3 text-xs text-amber-300 hover:bg-zinc-800">Copy public key</button><button type="button" disabled={key.assigned} title={key.assigned ? 'Assigned keys cannot be deleted' : undefined} onClick={() => setDeleteKey(key)} className="min-h-10 rounded-md px-3 text-xs text-red-300 hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-35">Delete</button></div></div><details className="mt-2"><summary className="cursor-pointer text-xs text-zinc-500">Show public key</summary><code className="mt-2 block break-all rounded bg-zinc-950 p-2 text-[11px] leading-5 text-zinc-400">{key.publicKey}</code></details></div>)}</div>}
          </section>}

          {mode === 'settings' && <section className="order-1">
            <h3 className="text-sm font-semibold text-zinc-200">Editor</h3>
            <label className="mt-4 block text-sm text-zinc-300">Auto-lock notes<select value={autoLockMinutes} onChange={(event) => onAutoLockMinutes(parseAutoLockMinutes(event.target.value))} className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-amber-500">{autoLockOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <p className="mt-2 text-xs leading-5 text-zinc-500">Switch an editable note to Read only after no document changes. Reading, scrolling, and text selection do not reset the timer.</p>
            <div className="mt-5 border-t border-zinc-800 pt-5"><h3 className="text-sm font-semibold text-zinc-200">Git synchronization</h3><p className="mt-1 text-xs leading-5 text-zinc-500">Local saves remain independent. Automatic Git sync commits, fetches, rebases, and pushes using the active notebook.</p><label className="mt-4 block text-sm text-zinc-300">Scheduled sync<select aria-label="Scheduled sync" value={syncPreferences.scheduledMinutes} onChange={(event) => onSyncPreferences({ ...syncPreferences, scheduledMinutes: Number(event.target.value) as SyncPreferences['scheduledMinutes'] })} className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"><option value={0}>Off</option><option value={5}>Every 5 minutes</option><option value={15}>Every 15 minutes</option><option value={30}>Every 30 minutes</option><option value={60}>Every hour</option></select></label><label className="mt-4 block text-sm text-zinc-300">Sync after editing inactivity<select aria-label="Sync after editing inactivity" value={syncPreferences.inactivityMinutes} onChange={(event) => onSyncPreferences({ ...syncPreferences, inactivityMinutes: Number(event.target.value) as SyncPreferences['inactivityMinutes'] })} className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"><option value={0}>Off</option><option value={1}>1 minute</option><option value={2}>2 minutes</option><option value={5}>5 minutes</option><option value={10}>10 minutes</option></select></label><label className="mt-4 flex min-h-11 items-center gap-3 text-sm text-zinc-300"><input type="checkbox" checked={syncPreferences.syncOnNotebookSwitch} onChange={(event) => onSyncPreferences({ ...syncPreferences, syncOnNotebookSwitch: event.target.checked })} className="h-5 w-5 accent-amber-500" />Sync before switching notebooks</label><label className="mt-2 flex min-h-11 items-center gap-3 text-sm text-zinc-300"><input type="checkbox" checked={syncPreferences.syncOnClose} onChange={(event) => onSyncPreferences({ ...syncPreferences, syncOnClose: event.target.checked })} className="h-5 w-5 accent-amber-500" />Best-effort sync when closing the tab</label><p className="mt-2 text-xs leading-5 text-zinc-500">Browsers cannot guarantee completion during tab or browser shutdown. Unsaved editor content still triggers the normal leave warning instead of starting Git sync.</p></div>
            <label className="mt-2 flex min-h-11 items-center gap-3 text-sm text-zinc-300"><input type="checkbox" checked={syncPreferences.syncOnStartup} onChange={(event) => onSyncPreferences({ ...syncPreferences, syncOnStartup: event.target.checked })} className="h-5 w-5 accent-amber-500" />Sync when RepoQuill opens</label>
            <label className="mt-2 flex min-h-11 items-center gap-3 text-sm text-zinc-300"><input type="checkbox" checked={syncPreferences.syncOnFocus} onChange={(event) => onSyncPreferences({ ...syncPreferences, syncOnFocus: event.target.checked })} className="h-5 w-5 accent-amber-500" />Sync when returning to the tab</label>
            <label className="mt-2 flex min-h-11 items-center gap-3 text-sm text-zinc-300"><input type="checkbox" checked={syncPreferences.syncBeforeOpeningNote} onChange={(event) => onSyncPreferences({ ...syncPreferences, syncBeforeOpeningNote: event.target.checked })} className="h-5 w-5 accent-amber-500" />Background sync after switching notes</label>
          </section>}

          {mode === 'settings' && <section className="order-2 mt-6 border-t border-zinc-800 pt-5" aria-labelledby="maintenance-title">
            <div className="flex items-start justify-between gap-4">
              <div><h3 id="maintenance-title" className="text-sm font-semibold text-zinc-200">Maintenance</h3><p className="mt-1 text-xs leading-5 text-zinc-500">Find image files in note-specific asset folders that are no longer referenced by Markdown.</p></div>
              <button type="button" disabled={cleanupBusy} onClick={() => void scanAssets()} className="min-h-10 shrink-0 rounded-md border border-zinc-700 px-3 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">{cleanupBusy ? 'Scanning…' : cleanupAssets ? 'Scan again' : 'Scan'}</button>
            </div>

            {cleanupError && <p role="alert" className="mt-3 rounded-md border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{cleanupError}</p>}
            {cleanupAssets && <div className="mt-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400"><span>{cleanupAssets.length} {cleanupAssets.length === 1 ? 'file' : 'files'} · {formatBytes(totalSize)}</span>{cleanupAssets.length > 0 && <button type="button" onClick={() => setSelectedAssets(selectedCount === cleanupAssets.length ? new Set() : new Set(cleanupAssets.map((asset) => asset.path)))} className="min-h-9 rounded px-2 text-amber-300 hover:bg-zinc-800">{selectedCount === cleanupAssets.length ? 'Select none' : 'Select all'}</button>}</div>
              {cleanupAssets.length === 0
                ? <p className="mt-3 rounded-md border border-zinc-800 p-3 text-sm text-zinc-400">No unreferenced image assets found.</p>
                : <div className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-md border border-zinc-800 p-1">{cleanupAssets.map((asset) => <label key={asset.path} className="flex min-h-11 cursor-pointer items-center gap-3 rounded px-2 py-1.5 hover:bg-zinc-800"><input type="checkbox" checked={selectedAssets.has(asset.path)} onChange={(event) => setSelectedAssets((current) => { const next = new Set(current); if (event.target.checked) next.add(asset.path); else next.delete(asset.path); return next })} className="h-5 w-5 shrink-0 accent-amber-500" /><span className="min-w-0 flex-1"><span className="block break-all text-xs text-zinc-200">{asset.path}</span><span className="text-[11px] text-zinc-500">{formatBytes(asset.size)}</span></span></label>)}</div>}
              {cleanupFailures.length > 0 && <div role="alert" className="mt-3 rounded-md border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200"><p className="font-medium">Some assets were kept:</p><ul className="mt-1 space-y-1">{cleanupFailures.map((failure) => <li key={failure.path} className="break-all">{failure.path}: {failure.error}</li>)}</ul></div>}
              {cleanupAssets.length > 0 && <div className="mt-3 flex justify-end"><button type="button" disabled={cleanupBusy || selectedCount === 0} onClick={() => setConfirmCleanup(true)} className="min-h-10 rounded-md bg-red-900/70 px-4 text-sm font-medium text-red-100 hover:bg-red-800 disabled:opacity-40">Delete selected ({selectedCount})</button></div>}
            </div>}
          </section>}
        </div>
        <footer className="flex shrink-0 justify-end border-t border-zinc-800 p-4"><button type="button" onClick={onClose} className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400">{mode === 'onboarding' ? 'Cancel' : 'Done'}</button></footer>
      </div>

      {confirmCleanup && <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/75 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmCleanup(false) }}><div role="alertdialog" aria-modal="true" aria-labelledby="cleanup-confirm-title" className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"><h2 id="cleanup-confirm-title" className="text-lg font-semibold">Delete {selectedCount} unreferenced {selectedCount === 1 ? 'asset' : 'assets'}?</h2><p className="mt-3 text-sm leading-6 text-zinc-400">These files will be removed from the repository working tree. Previously committed files may be recoverable through Git; new uncommitted files may not be.</p><div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={() => setConfirmCleanup(false)} className="min-h-11 rounded-md border border-zinc-700 px-4 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button><button type="button" onClick={() => void deleteSelectedAssets()} className="min-h-11 rounded-md bg-red-800 px-4 text-sm font-medium text-white hover:bg-red-700">Delete assets</button></div></div></div>}
      {deleteKey && <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/75 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteKey(undefined) }}><div role="alertdialog" aria-modal="true" aria-labelledby="delete-key-title" className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"><h2 id="delete-key-title" className="text-lg font-semibold">Delete unused SSH key?</h2><p className="mt-3 text-sm leading-6 text-zinc-400">The private and public key files for <span className="font-mono text-zinc-300">{deleteKey.keyId.slice(0, 12)}…</span> will be permanently removed from RepoQuill. Also remove its deploy-key entry from the Git provider if it was added there.</p><div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={() => setDeleteKey(undefined)} className="min-h-11 rounded-md border border-zinc-700 px-4 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button><button type="button" onClick={() => void deleteUnusedManagedKey()} className="min-h-11 rounded-md bg-red-800 px-4 text-sm font-medium text-white hover:bg-red-700">Delete key</button></div></div></div>}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`
}

function HostFingerprintList({ title, keys }: { title: string; keys: HostKeyInfo[] }) {
  return <div className="mt-3"><p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{title}</p><ul className="mt-1 space-y-2">{keys.map((key) => <li key={`${key.keyType}:${key.fingerprint}`} className="rounded border border-zinc-700/80 bg-zinc-950/60 p-2"><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium uppercase text-zinc-300">{key.keyType}</span><button type="button" onClick={() => void navigator.clipboard.writeText(key.fingerprint)} className="min-h-9 rounded px-2 text-xs text-amber-300 hover:bg-zinc-800" aria-label={`Copy ${key.keyType} fingerprint`}>Copy</button></div><code className="mt-1 block break-all text-[11px] leading-5 text-zinc-300">{key.fingerprint}</code></li>)}</ul></div>
}

function ManageNotebooksDialog({ notebooks, activeNotebookID, onClose }: { notebooks: NotebookInfo[]; activeNotebookID: string; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><div role="dialog" aria-modal="true" aria-labelledby="manage-notebooks-title" className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"><header className="border-b border-zinc-800 px-5 py-4"><h2 id="manage-notebooks-title" className="text-lg font-semibold">Manage Notebooks</h2><p className="mt-1 text-xs text-zinc-500">Notebook details and synchronization configuration.</p></header><div className="overflow-y-auto p-5"><div className="space-y-2">{notebooks.map((notebook) => <section key={notebook.id} className="rounded-md border border-zinc-800 p-3"><div className="flex items-center justify-between gap-2"><h3 className="font-medium text-zinc-200">{notebook.name}</h3>{notebook.id === activeNotebookID && <span className="text-xs text-emerald-400">Active</span>}</div>{notebook.remoteUrl ? <p className="mt-2 break-all text-xs text-zinc-400">{notebook.remoteUrl}</p> : <p className="mt-2 text-xs text-zinc-500">Locally configured notebook</p>}{notebook.branch && <p className="mt-1 text-xs text-zinc-500">Branch: {notebook.branch}</p>}</section>)}</div></div><footer className="flex justify-end border-t border-zinc-800 p-4"><button type="button" onClick={onClose} className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400">Done</button></footer></div></div>
}

function SettingsIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.1A1.7 1.7 0 0 0 8.4 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.2V9.55h.1A1.7 1.7 0 0 0 4 8.4a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.46 3.6l.06.06A1.7 1.7 0 0 0 8.4 4a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1v-.1h4.05v.1A1.7 1.7 0 0 0 15 4a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8.4a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4.05h-.1A1.7 1.7 0 0 0 19.4 15Z"/></svg>
}

type TreeEntryProps = {
  entry: TreeNode
  selectedPath?: string
  expandedFolders: Set<string>
  renamePath?: string
  renameValue: string
  onSelect: (entry: TreeNode) => void
  onToggleFolder: (path: string) => void
  onContextMenu: (entry: TreeNode, event: MouseEvent) => void
  onRenameValue: (value: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
}

function TreeEntry(props: TreeEntryProps) {
  const { entry, selectedPath, expandedFolders, renamePath, renameValue, onSelect, onToggleFolder, onContextMenu, onRenameValue, onRenameCommit, onRenameCancel } = props
  const isFolder = entry.type === 'directory'
  const expanded = expandedFolders.has(entry.path)
  const isRenaming = renamePath === entry.path

  return (
    <li>
      <div
        onContextMenu={(event) => onContextMenu(entry, event)}
        className={`flex items-center rounded-md ${selectedPath === entry.path ? 'bg-amber-400/15 text-amber-200' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'}`}
      >
        {isFolder ? <button type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${entry.name}`} aria-expanded={expanded} className="h-8 w-7 shrink-0 text-xs text-zinc-500" onClick={() => onToggleFolder(entry.path)}>{expanded ? '▾' : '▸'}</button> : <span className="w-7 shrink-0" />}
        <span aria-hidden="true" className="mr-2">{isFolder ? '📁' : '◇'}</span>
        {isRenaming
          ? <InlineRename value={renameValue} onChange={onRenameValue} onCommit={onRenameCommit} onCancel={onRenameCancel} />
          : <button type="button" className="min-w-0 flex-1 truncate py-1.5 pr-2 text-left text-sm" onClick={() => onSelect(entry)} onDoubleClick={() => { if (isFolder) onToggleFolder(entry.path) }}>{isFolder ? entry.name : entry.name.replace(/\.md$/i, '')}</button>}
      </div>
      {isFolder && expanded && entry.children && <ul className="ml-4 border-l border-zinc-800 pl-2">{entry.children.map((child) => <TreeEntry key={child.path} {...props} entry={child} />)}</ul>}
    </li>
  )
}

function InlineRename({ value, onChange, onCommit, onCancel }: { value: string; onChange: (value: string) => void; onCommit: () => void; onCancel: () => void }) {
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') { event.preventDefault(); onCancel() }
  }
  return <form className="min-w-0 flex-1 pr-1" onSubmit={(event: FormEvent) => { event.preventDefault(); onCommit() }}><input autoFocus value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={handleKeyDown} className="w-full rounded border border-amber-500 bg-zinc-950 px-1.5 py-1 text-sm text-zinc-100 outline-none" aria-label="New name" /></form>
}

function TreeAction({ children, label, disabled, onClick }: { children: ReactNode; label?: string; disabled: boolean; onClick: () => void }) { return <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="rounded-md border border-zinc-700 px-2 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-40">{children}</button> }

function SearchResults({ query, results, loading, error, onSelect }: { query: string; results: SearchResult[]; loading: boolean; error?: string; onSelect: (result: SearchResult) => void }) {
  if (loading) return <SidebarMessage>Searching…</SidebarMessage>
  if (error) return <div className="rounded-lg border border-red-900/70 bg-red-950/30 p-3 text-sm text-red-200">Search failed: {error}</div>
  if (results.length === 0) return <SidebarMessage>No results for “{query}”.</SidebarMessage>
  return <nav aria-label="Search results"><p className="mb-2 px-2 text-xs text-zinc-500">{results.length === 100 ? 'First 100 results' : `${results.length} ${results.length === 1 ? 'result' : 'results'}`}</p><ul className="space-y-1">{results.map((result, index) => <li key={`${result.type}:${result.path}:${result.line ?? 0}:${index}`}><button type="button" onClick={() => onSelect(result)} className="w-full rounded-md px-2 py-2 text-left hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"><span className="flex items-center gap-2 text-sm text-zinc-200"><span aria-hidden="true" className="text-zinc-500">{result.type === 'directory' ? '▸' : result.type === 'file' ? '◇' : '≡'}</span><span className="truncate">{result.path.replace(/\.md$/i, '')}</span>{result.line && <span className="ml-auto shrink-0 text-xs text-zinc-500">L{result.line}</span>}</span>{result.excerpt && <span className="mt-1 block truncate pl-5 text-xs text-zinc-500">{result.excerpt}</span>}</button></li>)}</ul></nav>
}

function ActionMenu({ entry, onRename, onMove, onDelete }: { entry: TreeNode; onRename: (entry: TreeNode) => void; onMove: (entry: TreeNode) => void; onDelete: (entry: TreeNode) => void }) {
  return <div role="menu" className="w-40 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-2xl"><MenuButton onClick={() => onRename(entry)}>Rename</MenuButton><MenuButton onClick={() => onMove(entry)}>Move…</MenuButton><MenuButton danger onClick={() => onDelete(entry)}>Delete</MenuButton></div>
}

function MenuButton({ children, danger, onClick }: { children: ReactNode; danger?: boolean; onClick: () => void }) {
  return <button type="button" role="menuitem" onClick={onClick} className={`block w-full rounded px-3 py-2 text-left text-sm ${danger ? 'text-red-300 hover:bg-red-950' : 'text-zinc-200 hover:bg-zinc-800'}`}>{children}</button>
}

function FolderPicker({ entries, notebookName, moving, destination, onDestination, onCancel, onConfirm }: { entries: TreeNode[]; notebookName: string; moving: TreeNode; destination: string; onDestination: (path: string) => void; onCancel: () => void; onConfirm: () => void }) {
  const folders = flattenFolders(entries).filter(({ node }) => moving.type !== 'directory' || (node.path !== moving.path && !node.path.startsWith(`${moving.path}/`)))
  const unchanged = parentPath(moving.path) === destination
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}><div role="dialog" aria-modal="true" aria-labelledby="move-title" className="flex max-h-[80vh] w-full max-w-md flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"><header className="border-b border-zinc-800 px-5 py-4"><h2 id="move-title" className="font-semibold">Move “{moving.name}”</h2><p className="mt-1 text-xs text-zinc-400">Choose a destination folder.</p></header><div className="overflow-y-auto p-3"><FolderChoice label={notebookName} depth={0} selected={destination === ''} onClick={() => onDestination('')} />{folders.map(({ node, depth }) => <FolderChoice key={node.path} label={node.name} depth={depth} selected={destination === node.path} onClick={() => onDestination(node.path)} />)}</div><footer className="flex justify-end gap-2 border-t border-zinc-800 p-4"><button type="button" onClick={onCancel} className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button><button type="button" disabled={unchanged} onClick={onConfirm} className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40">Move here</button></footer></div></div>
}

function flattenFolders(entries: TreeNode[], depth = 0): { node: TreeNode; depth: number }[] {
  return entries.flatMap((entry) => entry.type === 'directory' ? [{ node: entry, depth }, ...flattenFolders(entry.children ?? [], depth + 1)] : [])
}

function FolderChoice({ label, depth, selected, onClick }: { label: string; depth: number; selected: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }} className={`flex w-full items-center gap-2 rounded-md py-2 pr-3 text-left text-sm ${selected ? 'bg-amber-400/15 text-amber-200' : 'text-zinc-300 hover:bg-zinc-800'}`}><span aria-hidden="true">📁</span><span className="truncate">{label}</span></button>
}

export function DocumentStatusBar({ status, gitStatus, gitSyncing, markdown }: { status: SaveStatus; gitStatus: GitStatus; gitSyncing: boolean; markdown: string }) {
  const labels: Record<SaveStatus, string> = { saved: 'Saved', unsaved: 'Unsaved', saving: 'Saving…', error: 'Save failed', conflict: 'Conflict' }
  const colors: Record<SaveStatus, string> = { saved: 'text-emerald-400', unsaved: 'text-amber-300', saving: 'text-zinc-400', error: 'text-red-400', conflict: 'text-red-400' }
  const gitLabels: Record<GitState, string> = { clean: 'Clean', local_changes: 'Local changes', remote_changes: 'Remote changes', diverged: 'Diverged', synced: 'Synced', sync_failed: 'Sync failed', conflict: 'Git conflict', invalid: 'Git unavailable' }
  const gitLabel = gitSyncing ? 'Syncing…' : gitLabels[gitStatus.state]
  const gitCritical = gitStatus.state === 'sync_failed' || gitStatus.state === 'conflict' || gitStatus.state === 'invalid'
  const gitTitle = [gitStatus.message, gitStatus.conflictFiles?.length ? `Conflicts: ${gitStatus.conflictFiles.join(', ')}` : ''].filter(Boolean).join(' ')
  const stats = documentStats(markdown)
  return <footer aria-label="Document status" className="sticky bottom-0 z-10 flex h-7 shrink-0 items-center gap-2.5 border-t border-zinc-800 bg-zinc-950/90 px-5 text-[11px] leading-none text-zinc-500 backdrop-blur sm:px-8"><span role="status" className={`font-medium ${colors[status]}`}>{labels[status]}</span><span aria-hidden="true" className="text-zinc-700">•</span><span role="status" aria-label={`Git: ${gitLabel}`} title={gitTitle || undefined} className={gitCritical ? 'font-medium text-red-400' : gitStatus.state === 'synced' ? 'font-medium text-emerald-400' : 'font-medium text-zinc-400'}>{gitLabel}</span><span aria-hidden="true" className="hidden text-zinc-700 sm:inline">•</span><span className="hidden sm:inline" aria-label={`${stats.words} words`}>{stats.words} words</span><span className="hidden md:inline" aria-label={`${stats.characters} characters`}>{stats.characters} characters</span><span className="hidden md:inline" aria-label={`${stats.lines} lines`}>{stats.lines} lines</span></footer>
}

function StatusDot({ health }: { health: Health }) {
  const label = health === 'online' ? 'Backend connected' : health === 'offline' ? 'Backend unavailable' : 'Checking backend'
  const color = health === 'online' ? 'bg-emerald-400' : health === 'offline' ? 'bg-red-400' : 'bg-amber-400'
  return <span className={`h-2.5 w-2.5 rounded-full ${color}`} role="status" aria-label={label} title={label} />
}

function SidebarMessage({ children }: { children: ReactNode }) { return <p className="px-2 py-3 text-sm text-zinc-500">{children}</p> }
function ErrorMessage({ children }: { children: ReactNode }) { return <p className="mb-5 rounded-lg border border-red-900/70 bg-red-950/30 p-4 text-sm text-red-200">{children}</p> }
function EmptyState() { return <div className="flex min-h-80 flex-col items-center justify-center text-center"><div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-2xl" aria-hidden="true">◇</div><h2 className="mt-5 text-xl font-semibold">Your Markdown stays yours</h2><p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">Choose a note from the repository tree to edit it with Milkdown. Changes are autosaved after a short pause.</p></div> }
