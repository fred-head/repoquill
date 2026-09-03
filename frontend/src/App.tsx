import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { AutoLockController, autoLockOptions, loadAutoLockPreference, parseAutoLockMinutes, saveAutoLockPreference, type AutoLockMinutes } from './app/autoLock'
import { readConflictDecisionDraft, removeConflictDecisionDraft, writeConflictDecisionDraft } from './app/conflictDraftStorage'
import { documentStats } from './app/documentStats'
import { defaultSyncPreferences, loadSyncPreferences, saveSyncPreferences, type SyncPreferences } from './app/syncPreferences'
import { apiFetch, listenForAuthEvents, notifyAuthChanged, setCSRFToken } from './api'

const MarkdownEditor = lazy(() => import('./components/editor/MarkdownEditor').then((module) => ({ default: module.MarkdownEditor })))

type Health = 'checking' | 'online' | 'offline'
type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict'
type GitState = 'clean' | 'local_changes' | 'remote_changes' | 'diverged' | 'synced' | 'sync_failed' | 'conflict' | 'invalid'
type ReceivedChange = { kind: 'added' | 'updated' | 'moved' | 'deleted'; path: string; fromPath?: string }
type GitStatus = { state: GitState; branch?: string; ahead?: number; behind?: number; conflictFiles?: string[]; message?: string; lastSyncedAt?: string; receivedChanges?: ReceivedChange[] }
type NoteHistoryEntry = { versionId: string; timestamp: string; summary: string; path: string }
type NoteHistoryVersion = NoteHistoryEntry & { content: string }
type NoteHistoryResult = { entries: NoteHistoryEntry[]; limited: boolean }
type Theme = 'dark' | 'light'
type TreeNode = { name: string; path: string; type: 'directory' | 'file'; children?: TreeNode[] }
type FileResponse = { path: string; content: string; version: string }
type Draft = FileResponse & { savedContent: string }
type MenuState = { entry?: TreeNode; x: number; y: number }
type CleanupAsset = { path: string; size: number }
type CleanupFailure = { path: string; error: string }
type TrashItem = { id:string; originalPath:string; type:'file'|'directory'; deletedAt:string; size:number }
type LinkRewrite = { notePath:string; nextNotePath:string; line:number; before:string; after:string }
type MoveLinkPreview = { source:string; target:string; token:string; rewrites:LinkRewrite[] }
type ConflictItem = { path:string; kind:'markdown'|'image'|'binary'|'modify_delete'; yourExists:boolean; otherExists:boolean; yourContent?:string; otherContent?:string }
type ConflictOverview = { token:string; items:ConflictItem[] }
type ConflictDecision = { path:string; action:string; content?:string }
type GitAuthType = 'managed-ssh' | 'existing-server-ssh'
type GitProvider = 'github' | 'gitlab' | 'forgejo' | 'other'
type ConnectionResult = { state: string; message: string }
type HostKeyInfo = { keyType: string; fingerprint: string }
type HostTrustDiscovery = { state: string; message: string; requestId?: string; host: string; port: number; presentedKeys: HostKeyInfo[]; previouslyTrustedKeys?: HostKeyInfo[] }
type ManagedSSHKey = { keyId: string; publicKey: string; createdAt: string; fingerprint?: string; assigned: boolean; notebookName?: string }
type NotebookInfo = { id: string; name: string; remoteUrl?: string; branch?: string; authType?: GitAuthType; keyId?: string }
type NotebookCheck = { state:string; message:string }
type NotebookHealth = { localFiles:NotebookCheck; writeAccess:NotebookCheck; connection:NotebookCheck; pendingWork:NotebookCheck; lastSyncedAt?:string }
type SearchResult = { path: string; type: 'directory' | 'file' | 'content'; line?: number; excerpt?: string }
type NoteTab = { path: string; readOnly: boolean }
type RecoveryDraft = { notebookId: string; path: string; content: string; version: string; savedContent: string; capturedAt: string }
type CreateEntryRequest = { type:'file'|'directory'; parent:string; suggested:string }
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
const expandedFoldersStorageKey = 'repoquill.expanded-folders'
const themeStorageKey = 'repoquill.theme'
const installPromptDismissedStorageKey = 'repoquill.install-prompt-dismissed'
const noteSwitchSyncFreshnessMs = 45_000
const recoveryDraftStorageKey = 'repoquill.recovery-draft'

function loadRecoveryDraft(): RecoveryDraft | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(recoveryDraftStorageKey) ?? 'null') as RecoveryDraft | null
    return value?.path && value.version ? value : undefined
  } catch {
    return undefined
  }
}

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

function markdownPaths(entries: TreeNode[]): string[] {
  const result:string[] = []
  for (const entry of entries) {
    if (entry.type === 'file') result.push(entry.path)
    else if (entry.children) result.push(...markdownPaths(entry.children))
  }
  return result
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

export function App({ authMode = 'disabled', runningVersion = 'dev', onLoggedOut = () => undefined }: { authMode?: 'local'|'disabled'; runningVersion?:string; onLoggedOut?:()=>void } = {}) {
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [autoLockMinutes, setAutoLockMinutes] = useState<AutoLockMinutes>(() => loadAutoLockPreference(localStorage))
  const [syncPreferences, setSyncPreferences] = useState<SyncPreferences>(() => loadSyncPreferences(localStorage))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [notebookSwitcherOpen, setNotebookSwitcherOpen] = useState(false)
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine)
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent>()
  const [installPromptDismissed, setInstallPromptDismissed] = useState(() => localStorage.getItem(installPromptDismissedStorageKey) === 'true')
  const [addNotebookOpen, setAddNotebookOpen] = useState(false)
  const [manageNotebooksOpen, setManageNotebooksOpen] = useState(false)
  const [notebooks, setNotebooks] = useState<NotebookInfo[]>([])
  const [activeNotebookID, setActiveNotebookID] = useState('')
  const [readOnly, setReadOnly] = useState(false)
  const [health, setHealth] = useState<Health>('checking')
  const [notebookName, setNotebookName] = useState('Notebook')
  const [notebookConfigured, setNotebookConfigured] = useState<boolean>()
  const [entries, setEntries] = useState<TreeNode[]>([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError] = useState<string>()
  const [selectedPath, setSelectedPath] = useState<string>()
  const [tabs, setTabs] = useState<NoteTab[]>([])
  const [note, setNote] = useState<FileResponse>()
  const [noteLoading, setNoteLoading] = useState(false)
  const [noteError, setNoteError] = useState<string>()
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [saveError, setSaveError] = useState<string>()
  const [gitStatus, setGitStatus] = useState<GitStatus>({ state: 'invalid', message: 'Checking Git status…' })
  const [gitSyncing, setGitSyncing] = useState(false)
	const [syncDetailsOpen, setSyncDetailsOpen] = useState(false)
	const [conflictOverview, setConflictOverview] = useState<ConflictOverview>()
	const [saveConflict, setSaveConflict] = useState<{ overview:ConflictOverview; server:FileResponse }>()
	const [conflictLoading, setConflictLoading] = useState(false)
	const [conflictError, setConflictError] = useState<string>()
	const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState<string>()
	const [lastSyncAttemptAt, setLastSyncAttemptAt] = useState<string>()
	const [lastSyncError, setLastSyncError] = useState<string>()
	const [nextScheduledSyncAt, setNextScheduledSyncAt] = useState<string>()
	const [receivedChanges, setReceivedChanges] = useState<ReceivedChange[]>([])
  const [historyPath, setHistoryPath] = useState<string>()
  const [editorRevision, setEditorRevision] = useState(0)
  const [trashOpen, setTrashOpen] = useState(false)
  const [operationError, setOperationError] = useState<string>()
  const [operationNotice, setOperationNotice] = useState<string>()
  const [operationBusy, setOperationBusy] = useState(false)
  const [createRequest, setCreateRequest] = useState<CreateEntryRequest>()
  const [deleteRequest, setDeleteRequest] = useState<TreeNode>()
  const [selectedItem, setSelectedItem] = useState<TreeNode>()
  const [contextMenu, setContextMenu] = useState<MenuState>()
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [renameEntry, setRenameEntry] = useState<TreeNode>()
  const [renameValue, setRenameValue] = useState('')
  const [moveEntry, setMoveEntry] = useState<TreeNode>()
  const [moveDestination, setMoveDestination] = useState('')
  const [moveLinkPreview, setMoveLinkPreview] = useState<{ entry:TreeNode; preview:MoveLinkPreview }>()
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(loadExpandedFolders)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string>()
  const [recoveryDraft, setRecoveryDraft] = useState<RecoveryDraft|undefined>(loadRecoveryDraft)
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
  const activeNotebookIDRef = useRef(activeNotebookID)

  activeNotebookIDRef.current = activeNotebookID
  const preserveRecoveryDraft = useCallback(() => {
    const draft = activeDraft.current
    if (!draft || draft.content === draft.savedContent) return
    const recovery = { notebookId: activeNotebookIDRef.current, path: draft.path, content: draft.content, version: draft.version, savedContent: draft.savedContent, capturedAt: new Date().toISOString() }
    try { sessionStorage.setItem(recoveryDraftStorageKey, JSON.stringify(recovery)) } catch { return }
    setRecoveryDraft(recovery)
  }, [])

  useEffect(() => listenForAuthEvents(() => {
    preserveRecoveryDraft()
    setReadOnly(true)
  }, () => undefined), [preserveRecoveryDraft])

  useEffect(() => {
    const handleOnline = () => setBrowserOnline(true)
    const handleOffline = () => setBrowserOnline(false)
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault()
      if (!installPromptDismissed) setInstallPrompt(event as InstallPromptEvent)
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
  }, [installPromptDismissed])

  useEffect(() => {
    const query = searchQuery.trim()
    if (!query) return
    const controller = new AbortController()
    const timer = globalThis.setTimeout(async () => {
      setSearchLoading(true)
      setSearchError(undefined)
      try {
        const response = await apiFetch(`/api/repository/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
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

  useEffect(() => {
    if (!operationNotice) return
    const timer = globalThis.setTimeout(() => setOperationNotice(undefined), 8000)
    return () => globalThis.clearTimeout(timer)
  }, [operationNotice])

  const loadTree = useCallback(async () => {
    setTreeLoading(true)
    setTreeError(undefined)
    try {
      const response = await apiFetch('/api/repository/tree')
      const data = await responseJSON<{ entries: TreeNode[] }>(response)
      setEntries(data.entries)
      setNotebookConfigured(true)
      setHealth('online')
    } catch (error) {
      setTreeError(messageFrom(error))
      if (messageFrom(error) === 'repository is not configured') setNotebookConfigured(false)
    } finally {
      setTreeLoading(false)
    }
  }, [])

  const refreshGitStatus = useCallback(async () => {
    if (notebookConfigured !== true) {
      const status: GitStatus = { state: 'invalid', message: notebookConfigured === false ? 'Add a notebook to enable synchronization.' : 'Checking notebook configuration…' }
      gitStatusRef.current = status
      setGitStatus(status)
      return
    }
    try {
      const response = await apiFetch('/api/repository/git/status')
      const status = await responseJSON<GitStatus>(response)
      gitStatusRef.current = status
      setGitStatus(status)
		if (status.lastSyncedAt) {
			lastSuccessfulSync.current = Date.parse(status.lastSyncedAt) || 0
			setLastSuccessfulSyncAt(status.lastSyncedAt)
		}
    } catch (error) {
      const status: GitStatus = { state: 'sync_failed', message: messageFrom(error) }
      gitStatusRef.current = status
      setGitStatus(status)
    }
  }, [notebookConfigured])

  const loadNotebookInfo = useCallback(async () => {
    try {
      const response = await apiFetch('/api/notebook')
      const data = await responseJSON<{ name: string; configured: boolean }>(response)
      setNotebookConfigured(data.configured)
      setNotebookName(data.configured ? data.name || 'Notebook' : 'Notebooks')
    } catch {
      setNotebookName('Notebook')
    }
  }, [])

  const loadNotebooks = useCallback(async () => {
    try {
      const response = await apiFetch('/api/notebooks')
      const data = await responseJSON<{ activeId: string; notebooks: NotebookInfo[] }>(response)
      setNotebooks(data.notebooks)
      setActiveNotebookID(data.activeId)
      const active = data.notebooks.find((notebook) => notebook.id === data.activeId)
      if (active) setNotebookName(active.name)
      return data
    } catch {
      // Directly configured notebooks remain usable without a registry.
    }
  }, [])

  useEffect(() => {
    apiFetch('/api/health').then((response) => {
      if (!response.ok) throw new Error('health check failed')
      setHealth('online')
    }).catch(() => setHealth('offline'))
    apiFetch('/api/repository/tree').then(responseJSON<{ entries: TreeNode[] }>).then((data) => {
      setEntries(data.entries)
      setNotebookConfigured(true)
      setHealth('online')
    }).catch((error: unknown) => { const message = messageFrom(error); setTreeError(message); if (message === 'repository is not configured') setNotebookConfigured(false) }).finally(() => setTreeLoading(false))
    apiFetch('/api/notebook').then(responseJSON<{ name: string; configured: boolean }>).then((data) => { setNotebookConfigured(data.configured); setNotebookName(data.configured ? data.name || 'Notebook' : 'Notebooks') }).catch(() => setNotebookName('Notebook'))
    apiFetch('/api/notebooks').then(responseJSON<{ activeId: string; notebooks: NotebookInfo[] }>).then((data) => { setNotebooks(data.notebooks); setActiveNotebookID(data.activeId); const active = data.notebooks.find((notebook) => notebook.id === data.activeId); if (active) setNotebookName(active.name) }).catch(() => undefined)

    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      const draft = activeDraft.current
      if (draft && draft.content !== draft.savedContent) {
        preserveRecoveryDraft()
        event.preventDefault()
        return
      }
      if (syncPreferencesRef.current.syncOnClose && !closeSyncTriggered.current) {
        closeSyncTriggered.current = true
        void apiFetch('/api/repository/git/sync-background', { method: 'POST', keepalive: true })
      }
    }
    const syncOnPageHide = () => {
      const draft = activeDraft.current
      if (draft && draft.content !== draft.savedContent) {
        preserveRecoveryDraft()
        return
      }
      if (!syncPreferencesRef.current.syncOnClose || closeSyncTriggered.current) return
      closeSyncTriggered.current = true
      void apiFetch('/api/repository/git/sync-background', { method: 'POST', keepalive: true })
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    window.addEventListener('pagehide', syncOnPageHide)
    return () => {
      window.removeEventListener('beforeunload', warnBeforeUnload)
      window.removeEventListener('pagehide', syncOnPageHide)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (inactivitySyncTimer.current) clearTimeout(inactivitySyncTimer.current)
    }
  }, [preserveRecoveryDraft])

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
		if (syncPreferences.scheduledMinutes === 0) {
			const clearSchedule = globalThis.setTimeout(() => setNextScheduledSyncAt(undefined), 0)
			return () => globalThis.clearTimeout(clearSchedule)
		}
		const intervalMilliseconds = syncPreferences.scheduledMinutes * 60_000
		const scheduleNext = () => setNextScheduledSyncAt(new Date(Date.now() + intervalMilliseconds).toISOString())
		const initialSchedule = globalThis.setTimeout(scheduleNext, 0)
		const interval = globalThis.setInterval(() => {
			scheduleNext()
			void syncRepositoryRef.current()
		}, intervalMilliseconds)
		return () => {
			globalThis.clearTimeout(initialSchedule)
			globalThis.clearInterval(interval)
		}
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
    const operation = apiFetch(`/api/repository/file?path=${encodeURIComponent(snapshot.path)}`, {
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
		if (recoveryDraft?.path === snapshot.path) { sessionStorage.removeItem(recoveryDraftStorageKey); setRecoveryDraft(undefined) }
      }
    } catch (error) {
		const isConflict = error instanceof APIError && error.status === 409
		setSaveStatus(isConflict ? 'conflict' : 'error')
      setSaveError(messageFrom(error))
		if (isConflict) {
			const recovery = { notebookId:activeNotebookIDRef.current,path:snapshot.path,content:snapshot.content,version:snapshot.version,savedContent:draft.savedContent,capturedAt:new Date().toISOString() }
			try { sessionStorage.setItem(recoveryDraftStorageKey,JSON.stringify(recovery)); setRecoveryDraft(recovery) } catch { /* the in-memory editor still preserves this version */ }
			try {
				const server = await responseJSON<FileResponse>(await apiFetch(`/api/repository/file?path=${encodeURIComponent(snapshot.path)}`))
				setSaveConflict({ server,overview:{ token:`save:${server.version}`,items:[{ path:snapshot.path,kind:'markdown',yourExists:true,otherExists:true,yourContent:snapshot.content,otherContent:server.content }] } })
			} catch { /* retry remains available without discarding the draft */ }
		}
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
    if (notebookConfigured !== true) return false
    if (syncPromise.current) return syncPromise.current
    const operation = (async () => {
      setGitSyncing(true)
		setLastSyncAttemptAt(new Date().toISOString())
		setLastSyncError(undefined)
      try {
        do {
          syncRequested.current = false
          if (!(await saveDraft())) return false
          const syncedGeneration = localChangeGeneration.current
          const response = await apiFetch('/api/repository/git/sync', { method: 'POST' })
          const result = await responseJSON<GitStatus>(response)
          gitStatusRef.current = result
          setGitStatus(result)
			if (result.state !== 'synced') {
				setLastSyncError(result.message ?? 'Synchronization needs attention.')
				return false
			}

          lastSuccessfulSync.current = result.lastSyncedAt ? Date.parse(result.lastSyncedAt) || Date.now() : Date.now()
			setLastSuccessfulSyncAt(result.lastSyncedAt ?? new Date().toISOString())
			if (result.receivedChanges?.length) setReceivedChanges(result.receivedChanges)
          lastSyncedGeneration.current = syncedGeneration
          await loadTree()

          const statusResponse = await apiFetch('/api/repository/git/status')
          const inspected = await responseJSON<GitStatus>(statusResponse)
          gitStatusRef.current = inspected
          setGitStatus(inspected)
			if (inspected.lastSyncedAt) {
				lastSuccessfulSync.current = Date.parse(inspected.lastSyncedAt) || lastSuccessfulSync.current
				setLastSuccessfulSyncAt(inspected.lastSyncedAt)
			}
          if (localChangeGeneration.current !== syncedGeneration || inspected.state === 'local_changes' || inspected.state === 'diverged') {
            syncRequested.current = true
          }
        } while (syncRequested.current)
        return true
      } catch (error) {
        const status: GitStatus = { state: 'sync_failed', message: messageFrom(error) }
        gitStatusRef.current = status
        setGitStatus(status)
		setLastSyncError(messageFrom(error))
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

	async function openConflictAssistant() {
		setConflictLoading(true)
		setConflictError(undefined)
		try {
			const response = await apiFetch('/api/repository/git/conflicts')
			setConflictOverview(await responseJSON<ConflictOverview>(response))
			setSyncDetailsOpen(false)
		} catch (error) {
			setConflictError(messageFrom(error))
		} finally {
			setConflictLoading(false)
		}
	}

  async function applyConflictResolution(token:string, decisions:ConflictDecision[]) {
		setConflictLoading(true)
		setConflictError(undefined)
		setOperationNotice(undefined)
		try {
			const response = await apiFetch('/api/repository/git/conflicts/resolve', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ token,decisions }) })
			const result = await responseJSON<{ state:GitState; message:string; safetyPoint?:string }>(response)
			removeConflictDecisionDraft(sessionStorage, token)
			setConflictOverview(undefined)
			await loadTree()
			await refreshGitStatus()
			if (result.state === 'conflict') await openConflictAssistant()
			else setOperationNotice(result.safetyPoint ? `Changes synchronized. Recovery point: ${result.safetyPoint}` : 'Changes synchronized.')
		} catch (error) {
			setConflictError(messageFrom(error))
			try { const current = await responseJSON<ConflictOverview>(await apiFetch('/api/repository/git/conflicts')); setConflictOverview(current) } catch { /* source versions remain in Git */ }
		} finally {
			setConflictLoading(false)
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

	async function applySaveConflict(decisions:ConflictDecision[]) {
		const pending = saveConflict
		const decision = decisions[0]
		if (!pending || !decision) return
		setConflictLoading(true)
		setConflictError(undefined)
		try {
			let resolved = pending.server
			if (decision.action !== 'use_other') {
				const content = decision.action === 'edit_combined' ? decision.content ?? '' : pending.overview.items[0].yourContent ?? ''
				const response = await apiFetch('/api/repository/file/resolve-conflict',{ method:'POST',headers:{ 'Content-Type':'application/json' },body:JSON.stringify({ path:pending.server.path,expectedVersion:pending.server.version,content }) })
				resolved = (await responseJSON<{ file:FileResponse }>(response)).file
			}
			activeDraft.current = { ...resolved,savedContent:resolved.content }
			setNote(resolved)
			setSelectedPath(resolved.path)
			setSelectedItem(findTreeNode(entries,resolved.path) ?? { name:baseName(resolved.path),path:resolved.path,type:'file' })
			setTabs((current)=>current.some((tab)=>tab.path===resolved.path)?current:[...current,{ path:resolved.path,readOnly:false }])
			setReadOnly(false)
			setSaveConflict(undefined)
			removeConflictDecisionDraft(sessionStorage, pending.overview.token)
			setSaveStatus('saved')
			setSaveError(undefined)
			sessionStorage.removeItem(recoveryDraftStorageKey)
			setRecoveryDraft(undefined)
			localChangeGeneration.current += decision.action === 'use_other' ? 0 : 1
			void refreshGitStatus()
		} catch (error) {
			setConflictError(messageFrom(error))
			try {
				const server = await responseJSON<FileResponse>(await apiFetch(`/api/repository/file?path=${encodeURIComponent(pending.server.path)}`))
				setSaveConflict({ server,overview:{ token:`save:${server.version}`,items:[{ ...pending.overview.items[0],otherContent:server.content }] } })
			} catch { /* both in-memory versions remain available */ }
		} finally { setConflictLoading(false) }
	}

  useEffect(() => {
    syncRepositoryRef.current = syncRepository
  })

  useEffect(() => {
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

  useEffect(() => {
    if (notebookConfigured && syncPreferencesRef.current.syncOnStartup) void syncRepositoryRef.current()
  }, [notebookConfigured])

  async function activateClonedNotebook() {
    activeDraft.current = undefined
    setTabs([])
    setSelectedPath(undefined)
    setSelectedItem(undefined)
    setNote(undefined)
    setNoteError(undefined)
    setSaveStatus('saved')
    setExpandedFolders(new Set())
		setReceivedChanges([])
		setLastSyncError(undefined)
    setHistoryPath(undefined)
    await loadTree()
    await loadNotebookInfo()
    await loadNotebooks()
    await refreshGitStatus()
  }

  async function refreshNotebookRegistrations() {
    const data = await loadNotebooks()
    if (data?.activeId) {
      await loadNotebookInfo()
      return
    }
    activeDraft.current = undefined
    setTabs([])
    setSelectedPath(undefined)
    setSelectedItem(undefined)
    setNote(undefined)
    setEntries([])
    setNotebookConfigured(false)
    setNotebookName('Notebooks')
    setTreeError(undefined)
    setGitStatus({ state: 'invalid', message: 'Add a notebook to enable synchronization.' })
  }

  async function switchNotebook(notebook: NotebookInfo) {
    setMobileNavigationOpen(false)
    setNotebookSwitcherOpen(false)
    setOperationNotice(undefined)
    if (notebook.id === activeNotebookID) return
    if (!(await saveDraft())) return
    if (syncPreferences.syncOnNotebookSwitch) await syncRepository()
    setOperationBusy(true)
    setOperationError(undefined)
    try {
      const response = await apiFetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/activate`, { method: 'POST' })
      await responseJSON<NotebookInfo>(response)
      activeDraft.current = undefined
      setTabs([])
      setSelectedPath(undefined)
      setSelectedItem(undefined)
      setNote(undefined)
      setNoteError(undefined)
      setEntries([])
      setExpandedFolders(new Set())
      setNotebookName(notebook.name)
      setActiveNotebookID(notebook.id)
		setReceivedChanges([])
		setLastSyncError(undefined)
    setHistoryPath(undefined)
      if (syncPreferences.syncOnNotebookSwitch) await syncRepository()
      await loadTree()
      await refreshGitStatus()
    } catch (error) {
      setOperationError(messageFrom(error))
    } finally {
      setOperationBusy(false)
    }
  }

  async function openNote(path: string, disposition: 'current' | 'new' = 'current') {
    if (path === selectedPath) return
    if (!(await saveDraft())) return
    setNoteLoading(true)
    setNoteError(undefined)
    setSaveError(undefined)
    try {
      const response = await apiFetch(`/api/repository/file?path=${encodeURIComponent(path)}`)
      const loaded = await responseJSON<FileResponse>(response)
      const existingTab = tabs.find((tab) => tab.path === path)
      setTabs((current) => {
        if (current.some((tab) => tab.path === path)) return current
        const nextTab = { path, readOnly: false }
        if (disposition === 'new' || !selectedPath || current.length === 0) return [...current, nextTab]
        return current.map((tab) => tab.path === selectedPath ? nextTab : tab)
      })
      activeDraft.current = { ...loaded, savedContent: loaded.content }
      setNote(loaded)
      setSelectedPath(path)
      const treeEntry = findTreeNode(entries, path)
      if (treeEntry) setSelectedItem(treeEntry)
      setExpandedFolders((current) => {
        const next = new Set(current)
        let folder = parentPath(path)
        while (folder) {
          next.add(folder)
          folder = parentPath(folder)
        }
        return next
      })
      updateReadOnly(existingTab?.readOnly ?? false, path)
      setSaveStatus('saved')
      if (syncPreferences.syncBeforeOpeningNote) requestNoteSwitchSync()
    } catch (error) {
      setNoteError(messageFrom(error))
    } finally {
      setNoteLoading(false)
    }
  }

  async function restoreRecoveryDraft() {
    if (!recoveryDraft) return
    if (recoveryDraft.notebookId && activeNotebookID && recoveryDraft.notebookId !== activeNotebookID) {
      setOperationError('The recovery draft belongs to another notebook. Switch back to that notebook before restoring it.')
      return
    }
    try {
      const response = await apiFetch(`/api/repository/file?path=${encodeURIComponent(recoveryDraft.path)}`)
      const current = await responseJSON<FileResponse>(response)
      if (current.version !== recoveryDraft.version) {
		setSaveConflict({ server:current,overview:{ token:`save:${current.version}`,items:[{ path:current.path,kind:'markdown',yourExists:true,otherExists:true,yourContent:recoveryDraft.content,otherContent:current.content }] } })
		setOperationError(undefined)
        return
      }
      activeDraft.current = { ...current, content: recoveryDraft.content, savedContent: current.content }
      setNote({ ...current, content: recoveryDraft.content })
      setSelectedPath(current.path)
      setTabs((items) => items.some((tab) => tab.path === current.path) ? items : [...items, { path: current.path, readOnly: false }])
      setReadOnly(false)
      setSaveStatus('unsaved')
      setOperationError(undefined)
    } catch (caught) {
      setOperationError(messageFrom(caught))
    }
  }

  function discardRecoveryDraft() {
    sessionStorage.removeItem(recoveryDraftStorageKey)
    setRecoveryDraft(undefined)
  }

  async function closeTab(path: string) {
    const index = tabs.findIndex((tab) => tab.path === path)
    if (index < 0) return
    if (path !== selectedPath) {
      setTabs((current) => current.filter((tab) => tab.path !== path))
      return
    }
    if (!(await saveDraft())) return
    const remaining = tabs.filter((tab) => tab.path !== path)
    const next = remaining[Math.min(index, remaining.length - 1)]
    setTabs(remaining)
    activeDraft.current = undefined
    setNote(undefined)
    setSelectedPath(undefined)
    setSaveStatus('saved')
    setSaveError(undefined)
    if (next) await openNote(next.path)
  }

  async function activateTab(path: string) {
    if (path !== selectedPath) await openNote(path)
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

  function createEntry(type: 'file' | 'directory', relativeTo: TreeNode | undefined = selectedItem) {
    const parent = relativeTo?.type === 'directory' ? relativeTo.path : relativeTo ? parentPath(relativeTo.path) : ''
    const suggested = type === 'file' ? 'New note.md' : 'New folder'
    setCreateRequest({ type, parent, suggested })
  }

  async function submitCreateEntry(value:string) {
    const request = createRequest
    if (!request) return
    let name = value.trim()
    if (!name) return
    if (name.includes('/') || name.includes('\\')) {
      setOperationError('Enter a name only. Choose the destination folder in the tree.')
      return
    }
    if (request.type === 'file' && !name.toLowerCase().endsWith('.md')) name += '.md'
    const path = request.parent ? `${request.parent}/${name}` : name
    setCreateRequest(undefined)
    setOperationBusy(true)
    setOperationError(undefined)
    try {
      const response = await apiFetch('/api/repository/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, type:request.type }) })
      await responseJSON<{ path: string; type: string }>(response)
      if (request.parent) setExpandedFolders((current) => new Set(current).add(request.parent))
      await loadTree()
      setSelectedItem({ name: baseName(path), path, type:request.type })
      if (request.type === 'file') await openNote(path)
    } catch (error) {
      setOperationError(messageFrom(error))
    } finally {
      setOperationBusy(false)
    }
  }

  async function performMove(entry: TreeNode, target: string, rewriteToken?:string) {
    if (target === entry.path) return
    if (!(await saveDraft())) return
    setOperationBusy(true)
    setOperationError(undefined)
    try {
      if (!rewriteToken) {
        const previewResponse = await apiFetch('/api/repository/move/preview', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ source:entry.path, target }) })
        const preview = await responseJSON<MoveLinkPreview>(previewResponse)
        if (preview.rewrites.length > 0) {
          setMoveLinkPreview({ entry, preview })
          return
        }
      }
      const response = await apiFetch('/api/repository/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: entry.path, target, ...(rewriteToken ? { rewriteToken } : {}) }) })
      await responseJSON<{ path: string }>(response)
      const affectedPath = selectedPath === entry.path || selectedPath?.startsWith(`${entry.path}/`)
        ? target + selectedPath.slice(entry.path.length)
        : undefined
      const affectedReadOnly = affectedPath ? tabs.find((tab) => tab.path === selectedPath)?.readOnly : undefined
      setTabs((current) => current.map((tab) => tab.path === entry.path || tab.path.startsWith(`${entry.path}/`)
        ? { ...tab, path: target + tab.path.slice(entry.path.length) }
        : tab))
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
      if (affectedPath) {
        await openNote(affectedPath)
        updateReadOnly(affectedReadOnly ?? false, affectedPath)
      }
    } catch (error) {
      setOperationError(messageFrom(error))
    } finally {
      setOperationBusy(false)
    }
  }

  async function confirmMoveLinkRewrites() {
    const pending = moveLinkPreview
    if (!pending) return
    setMoveLinkPreview(undefined)
    await performMove(pending.entry, pending.preview.target, pending.preview.token)
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
    if (!(await saveDraft())) return
    setOperationBusy(true)
    setOperationError(undefined)
    try {
      const response = await apiFetch(`/api/repository/entry?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' })
      if (!response.ok) await responseJSON<never>(response)
      const activeDeleted = selectedPath === entry.path || selectedPath?.startsWith(`${entry.path}/`)
      const activeIndex = tabs.findIndex((tab) => tab.path === selectedPath)
      const remainingTabs = tabs.filter((tab) => tab.path !== entry.path && !tab.path.startsWith(`${entry.path}/`))
      setTabs(remainingTabs)
      if (activeDeleted) {
        activeDraft.current = undefined
        setNote(undefined)
        setSelectedPath(undefined)
        setSaveStatus('saved')
        setSaveError(undefined)
      }
      if (selectedItem?.path === entry.path || selectedItem?.path.startsWith(`${entry.path}/`)) setSelectedItem(undefined)
      setExpandedFolders((current) => new Set([...current].filter((folder) => folder !== entry.path && !folder.startsWith(`${entry.path}/`))))
      await loadTree()
      if (activeDeleted && remainingTabs.length > 0) {
        const next = remainingTabs[Math.min(Math.max(activeIndex, 0), remainingTabs.length - 1)]
        await openNote(next.path)
      }
    } catch (error) {
      setOperationError(messageFrom(error))
    } finally {
      setOperationBusy(false)
    }
  }

  function requestDeleteEntry(entry:TreeNode) {
    setContextMenu(undefined)
    setOverflowOpen(false)
    setDeleteRequest(entry)
  }

  function selectEntry(entry: TreeNode, disposition: 'current' | 'new' = 'current') {
    setSelectedItem(entry)
    setOverflowOpen(false)
    if (entry.type === 'file') {
      setMobileNavigationOpen(false)
      void openNote(entry.path, disposition)
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

  function openInternalNoteLink(path:string, disposition:'current'|'new') {
    const entry = findTreeNode(entries, path)
    if (!entry || entry.type !== 'file') {
      setOperationError(`Linked note not found: ${path}`)
      return
    }
    setOperationError(undefined)
    setSelectedItem(entry)
    setExpandedFolders((current) => {
      const next = new Set(current)
      let folder = parentPath(path)
      while (folder) { next.add(folder); folder = parentPath(folder) }
      return next
    })
    void openNote(path, disposition)
  }

  function showContextMenu(entry: TreeNode, event: MouseEvent) {
    event.preventDefault()
    setSelectedItem(entry)
    setOverflowOpen(false)
    setContextMenu({ entry, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 176)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 132)) })
  }

  function showRootContextMenu(event: MouseEvent) {
    event.preventDefault()
    setSelectedItem(undefined)
    setOverflowOpen(false)
    setContextMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 176)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 132)) })
  }

  async function logout() {
    setOperationError(undefined)
    try {
      await responseJSON(await apiFetch('/api/auth/logout', { method: 'POST' }))
      onLoggedOut()
    } catch (caught) {
      setOperationError(messageFrom(caught))
    }
  }

  function openEntryInNewTab(entry: TreeNode) {
    setContextMenu(undefined)
    setOverflowOpen(false)
    setSelectedItem(entry)
    setMobileNavigationOpen(false)
    void openNote(entry.path, 'new')
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
        if (saved && activeDraft.current?.path === path && editorActivity.current === activity) updateReadOnly(true, path)
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

  useEffect(() => {
    const handleTabKeys = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w' && selectedPath) {
        event.preventDefault()
        void closeTab(selectedPath)
        return
      }
      if (!event.ctrlKey || event.key !== 'Tab' || tabs.length < 2) return
      event.preventDefault()
      const currentIndex = Math.max(0, tabs.findIndex((tab) => tab.path === selectedPath))
      const direction = event.shiftKey ? -1 : 1
      const nextIndex = (currentIndex + direction + tabs.length) % tabs.length
      void activateTab(tabs[nextIndex].path)
    }
    window.addEventListener('keydown', handleTabKeys)
    return () => window.removeEventListener('keydown', handleTabKeys)
  })

  async function toggleReadOnly() {
    if (readOnly) {
      updateReadOnly(false)
      return
    }
    if (await saveDraft()) updateReadOnly(true)
  }

  async function openVersionHistory() {
    if (!selectedPath || !(await saveDraft())) return
    setHistoryPath(selectedPath)
  }

  async function restoreNoteVersion(versionId: string) {
    const draft = activeDraft.current
    if (!draft || draft.path !== historyPath) throw new Error('The active note changed. Reopen version history and try again.')
    const response = await apiFetch('/api/repository/history/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: draft.path, versionId, expectedVersion: draft.version }),
    })
    const restored = await responseJSON<FileResponse>(response)
    activeDraft.current = { ...restored, savedContent: restored.content }
    setNote(restored)
    setEditorRevision((current) => current + 1)
    setSaveStatus('saved')
    setSaveError(undefined)
    localChangeGeneration.current += 1
    await refreshGitStatus()
  }

  function updateReadOnly(value: boolean, path = selectedPath) {
    setReadOnly(value)
    if (path) setTabs((current) => current.map((tab) => tab.path === path ? { ...tab, readOnly: value } : tab))
  }

  const selectedFolderPath = selectedItem?.type === 'directory' ? selectedItem.path : selectedItem ? parentPath(selectedItem.path) : ''
  const createInName = selectedFolderPath ? baseName(selectedFolderPath) : notebookName

  async function installApplication() {
    if (!installPrompt) return
    await installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(undefined)
  }

  function dismissInstallPrompt() {
    localStorage.setItem(installPromptDismissedStorageKey, 'true')
    setInstallPromptDismissed(true)
    setInstallPrompt(undefined)
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100 lg:h-screen lg:flex-row lg:overflow-hidden">
      {mobileNavigationOpen && <button type="button" aria-label="Close notebook navigation" className="fixed inset-0 z-30 bg-black/65 lg:hidden" onClick={() => setMobileNavigationOpen(false)} />}
      <aside aria-label="Notebook navigation" className={`fixed inset-y-0 left-0 z-40 flex w-[min(20rem,calc(100vw-3rem))] shrink-0 flex-col border-r border-zinc-800 bg-zinc-900 shadow-2xl transition-transform duration-200 lg:static lg:z-auto lg:w-80 lg:translate-x-0 lg:bg-zinc-900/60 lg:shadow-none ${mobileNavigationOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <header className="relative border-b border-zinc-800 px-5 py-5"><div className="flex items-center justify-between gap-3"><div className="min-w-0 flex-1"><p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-400">RepoQuill</p><button type="button" aria-haspopup="menu" aria-expanded={notebookSwitcherOpen} onClick={() => setNotebookSwitcherOpen((open) => !open)} className="mt-1 flex min-h-9 max-w-full items-center gap-2 rounded-md pr-2 text-left text-lg font-semibold outline-none hover:text-amber-200 focus-visible:ring-2 focus-visible:ring-amber-500"><span className="truncate">Notebooks</span><span aria-hidden="true" className="text-sm text-zinc-500">▾</span></button></div><div className="flex items-center gap-2"><button type="button" onClick={() => setSettingsOpen(true)} className="rounded-md border border-zinc-700 p-2 text-zinc-300 hover:bg-zinc-800 hover:text-white" aria-label="Settings" title="Settings"><SettingsIcon /></button>{authMode === 'local' && <button type="button" onClick={() => void logout()} className="rounded-md border border-zinc-700 p-2 text-zinc-300 hover:bg-zinc-800 hover:text-white" aria-label="Sign out" title="Sign out"><LogoutIcon /></button>}<button type="button" onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}><span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span></button><StatusDot health={health} /></div></div>{notebookSwitcherOpen && <><button type="button" aria-label="Close notebook switcher" className="fixed inset-0 z-20 cursor-default" onClick={() => setNotebookSwitcherOpen(false)} /><div role="menu" aria-label="Notebooks" className="absolute top-[4.8rem] right-3 left-3 z-30 rounded-lg border border-zinc-700 bg-zinc-900 p-1.5 shadow-2xl">{notebooks.map((notebook) => <button key={notebook.id} type="button" role="menuitemradio" aria-checked={notebook.id === activeNotebookID} onClick={() => void switchNotebook(notebook)} className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-zinc-200 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"><span className="w-4 text-amber-400" aria-hidden="true">{notebook.id === activeNotebookID ? '✓' : ''}</span><span className="truncate">{notebook.name}</span></button>)}<div className="my-1 border-t border-zinc-700" /><button type="button" role="menuitem" onClick={() => { setNotebookSwitcherOpen(false); setAddNotebookOpen(true) }} className="min-h-11 w-full rounded-md px-3 text-left text-sm text-amber-300 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">+ Add Notebook</button><button type="button" role="menuitem" onClick={() => { setNotebookSwitcherOpen(false); setManageNotebooksOpen(true) }} className="min-h-11 w-full rounded-md px-3 text-left text-sm text-zinc-300 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">Manage Notebooks</button></div></>}</header>
        <div className="relative grid grid-cols-[1fr_1fr_auto_auto_auto] gap-1.5 border-b border-zinc-800 p-3">
          <TreeAction disabled={operationBusy || notebookConfigured === false} onClick={() => void createEntry('file')}>New Note</TreeAction>
          <TreeAction disabled={operationBusy || notebookConfigured === false} onClick={() => void createEntry('directory')}>New Folder</TreeAction>
          <TreeAction label="Refresh tree" disabled={operationBusy || notebookConfigured === false} onClick={() => void loadTree()}>↻</TreeAction>
          <TreeAction label="Selected item actions" disabled={operationBusy || !selectedItem} onClick={() => setOverflowOpen((open) => !open)}>•••</TreeAction>
          <TreeAction label="Open Trash" disabled={operationBusy || notebookConfigured === false} onClick={() => setTrashOpen(true)}>♲</TreeAction>
          {overflowOpen && <button type="button" className="fixed inset-0 z-20 cursor-default" aria-label="Close action menu" onClick={() => setOverflowOpen(false)} />}
          {overflowOpen && selectedItem && <div className="absolute top-12 right-3 z-30"><ActionMenu entry={selectedItem} onNewNote={(entry) => { setOverflowOpen(false); createEntry('file', entry) }} onNewFolder={(entry) => { setOverflowOpen(false); createEntry('directory', entry) }} onOpenNewTab={openEntryInNewTab} onRename={beginRename} onMove={beginMove} onDelete={requestDeleteEntry} /></div>}
        </div>
        {notebookConfigured !== false && <div className="border-b border-zinc-800 px-3 py-2 text-xs text-zinc-500">Create in: <span className="text-zinc-300">{createInName}</span></div>}
        {notebookConfigured !== false && <div className="border-b border-zinc-800 p-3">
          <div className="relative">
            <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-zinc-500">⌕</span>
            <input type="search" value={searchQuery} onChange={(event) => { const value = event.target.value; setSearchQuery(value); if (!value.trim()) { setSearchResults([]); setSearchLoading(false); setSearchError(undefined) } }} placeholder="Search this notebook" aria-label="Search this notebook" className="min-h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 py-2 pr-9 pl-9 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-amber-500 focus:ring-1 focus:ring-amber-500" />
            {searchQuery && <button type="button" onClick={() => { setSearchQuery(''); setSearchResults([]); setSearchLoading(false); setSearchError(undefined) }} aria-label="Clear search" className="absolute top-1/2 right-1.5 min-h-8 min-w-8 -translate-y-1/2 rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">×</button>}
          </div>
        </div>}
        <div className="max-h-80 overflow-y-auto p-3 lg:max-h-none lg:flex-1">
          {operationError && <div className="mb-3 rounded-lg border border-red-900/70 bg-red-950/30 p-3 text-sm text-red-200">{operationError}</div>}
          {operationNotice && <div role="status" className="mb-3 flex items-start justify-between gap-2 rounded-lg border border-emerald-900/70 bg-emerald-950/20 p-3 text-sm text-emerald-200"><span>{operationNotice}</span><button type="button" aria-label="Dismiss notification" onClick={() => setOperationNotice(undefined)} className="-m-1 min-h-8 min-w-8 shrink-0 rounded text-emerald-300 hover:bg-emerald-900/40">×</button></div>}
          {searchQuery.trim() && <SearchResults query={searchQuery.trim()} results={searchResults} loading={searchLoading} error={searchError} onSelect={selectSearchResult} />}
          {!searchQuery.trim() && <>
          {treeLoading && <SidebarMessage>Loading notebook…</SidebarMessage>}
          {notebookConfigured === false && <div className="rounded-lg border border-zinc-700 bg-zinc-950/40 p-4 text-sm text-zinc-300"><p className="font-medium text-zinc-100">No notebook yet</p><p className="mt-1 text-xs leading-5 text-zinc-500">Connect an existing notebook to start taking notes.</p><button type="button" className="mt-3 min-h-10 rounded-md bg-amber-500 px-3 text-xs font-semibold text-zinc-950 hover:bg-amber-400" onClick={() => setAddNotebookOpen(true)}>Add Notebook</button></div>}
          {treeError && notebookConfigured !== false && <div className="rounded-lg border border-red-900/70 bg-red-950/30 p-3 text-sm text-red-200"><p>{treeError}</p><button className="mt-3 rounded-md bg-red-900/60 px-3 py-1.5 text-xs hover:bg-red-800" onClick={() => void loadTree()}>Try again</button></div>}
          {!treeLoading && !treeError && <button type="button" onContextMenu={showRootContextMenu} className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${!selectedItem ? 'bg-amber-400/15 text-amber-200' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'}`} onClick={() => { setSelectedItem(undefined); setOverflowOpen(false) }}><span aria-hidden="true">⌂</span><span className="truncate">{notebookName}</span></button>}
          {!treeLoading && !treeError && entries.length === 0 && <SidebarMessage>No Markdown files found.</SidebarMessage>}
          {!treeLoading && !treeError && entries.length > 0 && <nav aria-label="Notebook notes"><ul className="space-y-0.5">{entries.map((entry) => <TreeEntry key={entry.path} entry={entry} selectedPath={selectedItem?.path} expandedFolders={expandedFolders} renamePath={renameEntry?.path} renameValue={renameValue} onSelect={selectEntry} onToggleFolder={toggleFolder} onContextMenu={showContextMenu} onRenameValue={setRenameValue} onRenameCommit={() => void commitRename()} onRenameCancel={() => setRenameEntry(undefined)} />)}</ul></nav>}
          </>}
        </div>
      </aside>

      <main className="flex min-h-screen min-w-0 flex-1 flex-col overflow-y-auto lg:min-h-[60vh]" style={{ '--editor-toolbar-top': tabs.length > 0 ? '99px' : '55px' } as CSSProperties}>
        <div className="sticky top-0 z-10 bg-zinc-950/90 backdrop-blur">
        <header className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-3 sm:gap-4 sm:px-8">
          <div className="flex min-w-0 items-center gap-2"><button type="button" aria-label="Open notebook navigation" aria-expanded={mobileNavigationOpen} onClick={() => setMobileNavigationOpen(true)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-700 text-lg text-zinc-300 hover:bg-zinc-800 lg:hidden">☰</button><p className="min-w-0 truncate text-sm text-zinc-400">{selectedPath ?? 'Select a Markdown file'}</p></div>
          <div className="flex shrink-0 items-center gap-2">{selectedPath && <><button type="button" onClick={() => void toggleReadOnly()} className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${readOnly ? 'border-amber-500 bg-amber-400/15 text-amber-200' : 'border-zinc-700 text-zinc-200 hover:bg-zinc-800'}`} aria-pressed={readOnly}>{readOnly ? '🔒 Read only' : '✎ Edit'}</button><button type="button" disabled={readOnly || saveStatus === 'saved' || saveStatus === 'saving'} onClick={() => void saveDraft()} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:cursor-default disabled:opacity-40">Save</button><button type="button" onClick={() => void openVersionHistory()} aria-label="Version history" title="Version history" className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800"><span aria-hidden="true">↶</span><span className="ml-1 hidden sm:inline">History</span></button></>}<button type="button" disabled={notebookConfigured === false || gitSyncing || saveStatus === 'saving' || saveStatus === 'error' || saveStatus === 'conflict'} onClick={() => void syncRepository()} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:cursor-default disabled:opacity-40">{gitSyncing ? 'Syncing…' : 'Sync'}</button></div>
        </header>
        {tabs.length > 0 && <NoteTabs tabs={tabs} activePath={selectedPath} onActivate={(path) => void activateTab(path)} onClose={(path) => void closeTab(path)} />}
        </div>
        {(!browserOnline || health === 'offline') && <div role="status" className="border-b border-amber-800/70 bg-amber-950/40 px-4 py-2 text-sm text-amber-100 sm:px-8"><strong>Offline.</strong> RepoQuill is online-first; viewing may continue, but editing and synchronization require the server connection.</div>}
        {recoveryDraft && <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-800/70 bg-amber-950/30 px-4 py-2 text-xs text-amber-100 sm:px-8"><span>An unsaved recovery draft for <strong>{recoveryDraft.path}</strong> was preserved after authentication ended.</span><span className="flex gap-2"><button type="button" onClick={()=>void restoreRecoveryDraft()} className="min-h-9 rounded border border-amber-700 px-3 hover:bg-amber-900/40">Review draft</button><button type="button" onClick={discardRecoveryDraft} className="min-h-9 rounded px-3 text-zinc-400 hover:bg-zinc-800">Discard</button></span></div>}
        {installPrompt && !installPromptDismissed && <div className="flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2 text-xs text-zinc-300 sm:px-8"><span>Install RepoQuill for a standalone app experience.</span><div className="flex shrink-0 items-center gap-1"><button type="button" onClick={() => void installApplication()} className="min-h-9 rounded-md border border-zinc-600 px-3 font-medium hover:bg-zinc-800">Install app</button><button type="button" onClick={dismissInstallPrompt} aria-label="Dismiss install suggestion" title="Dismiss" className="flex min-h-9 min-w-9 items-center justify-center rounded-md text-lg text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">×</button></div></div>}
		{receivedChanges.length > 0 && <ReceivedChangesNotice changes={receivedChanges} onOpen={(path) => void openNote(path, 'new')} onDismiss={() => setReceivedChanges([])} />}
        <article className={`mx-auto w-full max-w-4xl flex-1 px-5 sm:px-8 ${selectedPath ? 'pt-2 pb-8 sm:pt-2 sm:pb-12' : 'py-8 sm:py-12'}`}>
          {!selectedPath && <EmptyState notebookConfigured={notebookConfigured !== false} onAddNotebook={() => setAddNotebookOpen(true)} />}
          {noteLoading && <p className="text-sm text-zinc-400">Loading note…</p>}
          {noteError && <ErrorMessage>{noteError}</ErrorMessage>}
		  {saveError && <ErrorMessage>{saveStatus === 'conflict' ? 'This note changed elsewhere. Your version is still preserved in this editor and has not overwritten the other version. Review both versions before choosing the result.' : `This note could not be saved on the RepoQuill server. Your current editor content is still visible. Try saving again before leaving the note. Details: ${saveError}`}</ErrorMessage>}
          {!noteLoading && note && <Suspense fallback={<p className="text-sm text-zinc-400">Loading editor…</p>}><MarkdownEditor key={`${note.path}:${readOnly ? 'read' : 'edit'}:${editorRevision}`} documentKey={`${note.path}:${readOnly ? 'read' : 'edit'}:${editorRevision}`} notePath={note.path} markdown={note.content} readOnly={readOnly} onChange={updateDraft} notePaths={markdownPaths(entries)} onOpenNoteLink={openInternalNoteLink} /></Suspense>}
        </article>
		{selectedPath && note && <DocumentStatusBar status={saveStatus} gitStatus={gitStatus} gitSyncing={gitSyncing} markdown={note.content} onOpenSyncDetails={() => setSyncDetailsOpen(true)} />}
      </main>
      {contextMenu && <div className="fixed inset-0 z-40" onClick={() => setContextMenu(undefined)} onContextMenu={(event) => { event.preventDefault(); setContextMenu(undefined) }}><div className="fixed" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}><ActionMenu entry={contextMenu.entry} onNewNote={(entry) => { setContextMenu(undefined); createEntry('file', entry) }} onNewFolder={(entry) => { setContextMenu(undefined); createEntry('directory', entry) }} onOpenNewTab={openEntryInNewTab} onRename={beginRename} onMove={beginMove} onDelete={requestDeleteEntry} /></div></div>}
      {createRequest && <TextInputDialog title={createRequest.type === 'file' ? 'New Note' : 'New Folder'} label={createRequest.type === 'file' ? `Note name${createRequest.parent ? ` in ${createRequest.parent}` : ''}` : `Folder name${createRequest.parent ? ` in ${createRequest.parent}` : ''}`} initialValue={createRequest.suggested} confirmLabel="Create" onCancel={() => setCreateRequest(undefined)} onConfirm={(value) => void submitCreateEntry(value)} />}
      {deleteRequest && <ConfirmationDialog title="Move to Trash?" message={`Move “${deleteRequest.path}” to Trash?${deleteRequest.type === 'file' ? ' Its owned image assets will move with it.' : ' Everything inside this folder will move with it.'} You can restore it later.`} confirmLabel="Move to Trash" danger onCancel={() => setDeleteRequest(undefined)} onConfirm={() => { const entry = deleteRequest; setDeleteRequest(undefined); void deleteEntry(entry) }} />}
      {moveEntry && <FolderPicker entries={entries} notebookName={notebookName} moving={moveEntry} destination={moveDestination} onDestination={setMoveDestination} onCancel={() => setMoveEntry(undefined)} onConfirm={() => void confirmMove()} />}
      {moveLinkPreview && <MoveLinkPreviewDialog preview={moveLinkPreview.preview} onCancel={() => setMoveLinkPreview(undefined)} onConfirm={() => void confirmMoveLinkRewrites()} />}
      {settingsOpen && <SettingsDialog mode="settings" authMode={authMode} runningVersion={runningVersion} onLoggedOut={onLoggedOut} autoLockMinutes={autoLockMinutes} onAutoLockMinutes={setAutoLockMinutes} syncPreferences={syncPreferences} onSyncPreferences={setSyncPreferences} onClose={() => setSettingsOpen(false)} />}
      {addNotebookOpen && <SettingsDialog mode="onboarding" autoLockMinutes={autoLockMinutes} onAutoLockMinutes={setAutoLockMinutes} onNotebookAdded={async () => { await activateClonedNotebook(); setAddNotebookOpen(false); setManageNotebooksOpen(true) }} onClose={() => setAddNotebookOpen(false)} />}
      {manageNotebooksOpen && <ManageNotebooksDialog notebooks={notebooks} activeNotebookID={activeNotebookID} operationsBlocked={operationBusy || saveStatus === 'saving' || saveStatus === 'unsaved'} onChanged={refreshNotebookRegistrations} onClose={() => setManageNotebooksOpen(false)} />}
	  {syncDetailsOpen && <SynchronizationDetailsPanel saveStatus={saveStatus} gitStatus={gitStatus} syncing={gitSyncing} browserOnline={browserOnline && health !== 'offline'} lastSuccessfulSyncAt={lastSuccessfulSyncAt} lastSyncAttemptAt={lastSyncAttemptAt} lastSyncError={lastSyncError} nextScheduledSyncAt={nextScheduledSyncAt} receivedChanges={receivedChanges} onSync={() => void syncRepository()} onReviewConflicts={() => void openConflictAssistant()} conflictLoading={conflictLoading} conflictError={conflictError} onOpenNote={(path) => void openNote(path, 'new')} onOpenSettings={() => { setSyncDetailsOpen(false); setSettingsOpen(true) }} onCheckConnection={() => { setSyncDetailsOpen(false); setManageNotebooksOpen(true) }} onClose={() => setSyncDetailsOpen(false)} />}
	  {conflictOverview && <ConflictResolutionDialog overview={conflictOverview} busy={conflictLoading} error={conflictError} notePaths={markdownPaths(entries)} onPostpone={() => setConflictOverview(undefined)} onApply={(decisions) => void applyConflictResolution(conflictOverview.token,decisions)} />}
	  {saveConflict && <ConflictResolutionDialog overview={saveConflict.overview} busy={conflictLoading} error={conflictError} notePaths={markdownPaths(entries)} onPostpone={() => setSaveConflict(undefined)} onApply={(decisions) => void applySaveConflict(decisions)} />}
      {historyPath && note?.path === historyPath && <NoteHistoryDialog notePath={historyPath} currentContent={note.content} onRestore={restoreNoteVersion} onClose={() => setHistoryPath(undefined)} />}
      {trashOpen && <TrashDialog onChanged={loadTree} onClose={() => setTrashOpen(false)} />}
    </div>
  )
}

export function SettingsDialog({ mode = 'settings', authMode = 'disabled', runningVersion = 'dev', onLoggedOut = () => undefined, autoLockMinutes, onAutoLockMinutes, syncPreferences = defaultSyncPreferences, onSyncPreferences = () => undefined, onNotebookAdded, onClose }: { mode?: 'settings' | 'onboarding'; authMode?:'local'|'disabled'; runningVersion?:string; onLoggedOut?:()=>void; autoLockMinutes: AutoLockMinutes; onAutoLockMinutes: (value: AutoLockMinutes) => void; syncPreferences?: SyncPreferences; onSyncPreferences?: (value: SyncPreferences) => void; onNotebookAdded?: () => Promise<void> | void; onClose: () => void }) {
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
  const [onboardingStep,setOnboardingStep]=useState(1)
  const [provider,setProvider]=useState<GitProvider>()

  const providerDetails:Record<GitProvider,{name:string;example:string;instructions:string}>={
    github:{name:'GitHub',example:'git@github.com:owner/notes.git',instructions:'https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys'},
    gitlab:{name:'GitLab',example:'git@gitlab.com:owner/notes.git',instructions:'https://docs.gitlab.com/user/project/deploy_keys/'},
    forgejo:{name:'Forgejo / Gitea',example:'git@git.example.com:owner/notes.git',instructions:'https://forgejo.org/docs/latest/user/ssh-key/'},
    other:{name:'Another Git server',example:'git@git.example.com:owner/notes.git',instructions:'https://git-scm.com/book/en/v2/Git-on-the-Server-The-Protocols'},
  }
  function repositoryURLIssue(value:string){
    const trimmed=value.trim()
    if(!trimmed)return ''
    if(trimmed.startsWith('-'))return 'The repository address cannot start with an option character.'
    if(trimmed.includes('\\'))return 'Remove the backslash from the repository address.'
    if(/^\[.+\]\(.+\)$/i.test(trimmed))return 'Paste only the repository address, not a Markdown link.'
    if(/^(?:\.{0,2}\/|[A-Za-z]:[\\/])/i.test(trimmed))return 'Choose a Git server address, not a folder on the RepoQuill server.'
    if(/^https?:\/\//i.test(trimmed))return provider==='github'?'This looks like a GitHub website or HTTPS address. In GitHub, open your repository, choose Code → SSH, and copy the address that starts with git@github.com:.':'Alpha 2 uses SSH for private repository access. Open your Git service, choose its SSH clone option, and copy that address.'
    if(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)&&!/^ssh:\/\//i.test(trimmed))return 'This connection type is not supported here. Copy the SSH repository address from your Git service.'
    if(/^ssh:\/\//i.test(trimmed)){try{const parsed=new URL(trimmed);if(parsed.password)return 'Repository addresses must not contain a password or access token.';if(!parsed.hostname||!parsed.pathname||parsed.pathname==='/')return 'The SSH address must include both the Git server and repository path.'}catch{return 'This SSH repository address is malformed. Copy it again from your Git service.'}}
    else if(!/^[^@\s]+@[A-Za-z0-9._-]+:[^\s]+$/.test(trimmed))return 'Use an SSH repository address such as git@github.com:username/private-notes.git.'
    return ''
  }
  function repositoryHost(value:string){const trimmed=value.trim();try{if(/^ssh:\/\//i.test(trimmed))return new URL(trimmed).hostname}catch{return 'Invalid host'}const separator=trimmed.indexOf(':');const prefix=separator>=0?trimmed.slice(0,separator):trimmed;return prefix.includes('@')?prefix.slice(prefix.lastIndexOf('@')+1):prefix||'Unknown host'}
  function connectionAction(){
    const state=connectionResult?.state
    if(state==='authentication_failed')return provider==='github'?'GitHub did not accept this key. Check Repository Settings → Deploy keys, confirm that this public key was added to this repository, and enable “Allow write access”.':'The Git server did not accept this key. Confirm that the public key was added to this repository with write access.'
    if(state==='host_verification_failed')return `RepoQuill has not trusted ${repositoryHost(repositoryURL)} yet. Review the server identity below before continuing.`
    if(state==='repository_not_found')return 'RepoQuill reached the Git server, but the repository could not be opened. Check that it exists, the address is correct, and this key was added to that repository.'
    if(state==='branch_not_found'||state==='invalid_branch')return 'The selected branch does not exist. Leave the branch empty to use the repository default, or enter an existing branch name.'
    if(state==='network_failed')return 'RepoQuill could not reach the Git server from this host. Check DNS, outbound firewall rules, proxy or network configuration, and Internet connectivity.'
    return connectionResult&&state!=='success'?'Your notebook name, address, access method, and generated key are still here. Correct the failed step and test again.':''
  }

  const loadManagedKeys = useCallback(async () => {
    setManagedKeysBusy(true)
    setManagedKeysError(undefined)
    try {
      const response = await apiFetch('/api/notebooks/ssh-keys')
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
      const response = await apiFetch('/api/notebooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: notebookName, repositoryUrl: repositoryURL, branch: repositoryBranch, authType: gitAuthType, keyId: managedKey?.keyId ?? '' }) })
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
      const response = await apiFetch('/api/notebooks/ssh-key', { method: 'POST' })
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
      const response = await apiFetch(`/api/notebooks/ssh-keys/${encodeURIComponent(deleteKey.keyId)}`, { method: 'DELETE' })
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
      const response = await apiFetch('/api/notebooks/test-connection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryUrl: repositoryURL, branch: repositoryBranch, authType: gitAuthType, keyId: managedKey?.keyId ?? '' }) })
      const result = await responseJSON<ConnectionResult>(response)
      setConnectionResult(result)
      if (result.state === 'host_verification_failed') {
        const discoveryResponse = await apiFetch('/api/notebooks/ssh-host/discover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryUrl: repositoryURL }) })
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
      const response = await apiFetch('/api/notebooks/ssh-host/trust', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: hostTrust.requestId }) })
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
      const response = await apiFetch('/api/repository/assets/unreferenced')
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
      const response = await apiFetch('/api/repository/assets/cleanup', {
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
        <div className={`min-h-0 overflow-y-auto p-5 ${mode === 'settings' ? 'flex flex-col' : ''}`}>
          {mode === 'onboarding' && <section>
            <div className="flex items-center justify-between"><div><h3 className="text-sm font-semibold text-zinc-200">Connect a notebook</h3><p className="mt-1 text-xs text-zinc-500">Step {onboardingStep} of 5</p></div><div aria-label="Connection progress" className="flex gap-1">{[1,2,3,4,5].map(step=><span key={step} className={`h-1.5 w-6 rounded ${step<=onboardingStep?'bg-amber-500':'bg-zinc-700'}`}><span className="sr-only">Step {step}</span></span>)}</div></div>
            <p className="mt-3 rounded border border-zinc-800 p-3 text-xs leading-5 text-zinc-400">Connect an existing repository. RepoQuill does not create one through a provider API in Alpha 2.</p>
            {onboardingStep===1&&<div className="mt-3 grid gap-2 sm:grid-cols-2">{(Object.keys(providerDetails) as GitProvider[]).map(id=><button type="button" key={id} onClick={()=>{setProvider(id);setOnboardingStep(2)}} className="min-h-14 rounded border border-zinc-700 px-3 text-left text-sm hover:border-amber-500">{providerDetails[id].name}</button>)}</div>}
            <form id="notebook-onboarding-form" data-step={onboardingStep} className={`${onboardingStep===1?'hidden':'notebook-wizard mt-3 space-y-3'}`} onSubmit={(event) => void cloneNotebook(event)}>
              {onboardingStep===2&&provider==='github'&&<div className="rounded-md border border-zinc-700 bg-zinc-950/40 p-3 text-xs leading-5 text-zinc-300"><p className="font-medium text-zinc-100">Start with a GitHub repository</p><p className="mt-2">RepoQuill stores this notebook in a normal Git repository. If you do not already have one for these notes, create a new <strong>private repository</strong> on GitHub first.</p><p className="mt-2 text-zinc-500">RepoQuill connects to the repository without changing its format. Alpha 2 does not create repositories through the GitHub API.</p><a href="https://github.com/new" target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-10 items-center rounded-md border border-zinc-700 px-3 font-medium text-amber-300 hover:bg-zinc-800">Create a repository on GitHub</a></div>}
              <label className={`${onboardingStep===2?'block':'hidden'} text-xs text-zinc-300`}>Notebook name<input required maxLength={100} value={notebookName} onChange={(event) => setNotebookName(event.target.value)} className="mt-1.5 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500" placeholder="Private" /></label>
              <label className={`${onboardingStep===2?'block':'hidden'} text-xs text-zinc-300`}>{provider==='github'?'GitHub repository address':'Repository SSH address'}<input required value={repositoryURL} onChange={(event) => { setRepositoryURL(event.target.value); invalidateConnection() }} className="mt-1.5 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500" placeholder={provider?providerDetails[provider].example:'git@example.com:user/notes.git'} /></label>
              {onboardingStep===2&&repositoryURLIssue(repositoryURL)&&<p role="alert" className="text-xs text-amber-300">{repositoryURLIssue(repositoryURL)}</p>}
              {onboardingStep===2&&provider==='github'&&<div className="rounded-md border border-zinc-800 p-3 text-xs leading-5 text-zinc-400"><p className="font-medium text-zinc-200">Find this address in GitHub</p><ol className="mt-1 list-decimal space-y-1 pl-4"><li>Open the repository on GitHub.</li><li>Choose <strong>Code</strong>.</li><li>Choose <strong>SSH</strong>.</li><li>Copy the address.</li></ol><p className="mt-2">It should look like <code className="break-all text-zinc-300">git@github.com:username/private-notes.git</code>. The address from your browser bar is not the value needed here.</p></div>}
              {onboardingStep===2&&provider!=='github'&&<p className="text-[11px] text-zinc-500">Example: <code>{provider?providerDetails[provider].example:'git@example.com:user/notes.git'}</code></p>}
              <label className={`${onboardingStep===2?'block':'hidden'} text-xs text-zinc-300`}>Branch <span className="text-zinc-500">(optional; the remote default is discovered when left empty)</span><input value={repositoryBranch} onChange={(event) => { setRepositoryBranch(event.target.value); invalidateConnection() }} className="mt-1.5 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500" placeholder="Remote default branch" /></label>
              {onboardingStep===3&&<div className="rounded-md border border-zinc-800 p-3 text-xs leading-5 text-zinc-400"><p className="font-medium text-zinc-200">Give this notebook secure access</p><p className="mt-1">The recommended option creates a dedicated key for this notebook. Its private part stays on your RepoQuill server. Only the public key is shown here, and it is safe to copy into the repository settings.</p><p className="mt-2">The key gets access only to repositories where you explicitly add it. RepoQuill never asks for or uploads your personal SSH private key.</p></div>}
              <fieldset className={onboardingStep===3?'block':'hidden'}><legend className="text-xs text-zinc-300">Secure access</legend><label className="mt-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-zinc-800 px-3"><input type="radio" name="git-auth" value="managed-ssh" checked={gitAuthType === 'managed-ssh'} onChange={() => { setGitAuthType('managed-ssh'); invalidateConnection() }} className="h-4 w-4 accent-amber-500" /><span><span className="block text-sm text-zinc-200">RepoQuill-managed SSH key</span><span className="block text-[11px] text-zinc-500">Recommended · the private key stays on this server</span></span></label><label className="mt-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-zinc-800 px-3"><input type="radio" name="git-auth" value="existing-server-ssh" checked={gitAuthType === 'existing-server-ssh'} onChange={() => { setGitAuthType('existing-server-ssh'); invalidateConnection() }} className="h-4 w-4 accent-amber-500" /><span><span className="block text-sm text-zinc-200">Existing server SSH configuration</span><span className="block text-[11px] text-zinc-500">Advanced operator-managed credentials</span></span></label></fieldset>
              {onboardingStep===3&&gitAuthType === 'managed-ssh' && <div className="rounded-md border border-zinc-800 p-3"><div><p className="text-xs font-medium text-zinc-200">Dedicated SSH key</p><p className="mt-1 text-[11px] leading-4 text-zinc-500">The private key stays on the RepoQuill server.</p></div><div className="mt-3 grid gap-2 sm:grid-cols-2"><label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200"><input type="radio" name="key-source" checked={keySource === 'new'} onChange={() => { setKeySource('new'); setManagedKey(undefined); invalidateConnection() }} className="accent-amber-500" />Generate new key</label><label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200"><input type="radio" name="key-source" checked={keySource === 'existing'} onChange={() => { setKeySource('existing'); setManagedKey(undefined); invalidateConnection(); void loadManagedKeys() }} className="accent-amber-500" />Use existing key</label></div>{keySource === 'new' && !managedKey && <button type="button" disabled={keyBusy} onClick={() => void generateManagedKey()} className="mt-3 min-h-10 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">{keyBusy ? 'Generating…' : 'Generate key'}</button>}{keySource === 'existing' && <div className="mt-3">{managedKeysBusy && <p className="text-xs text-zinc-500">Loading keys…</p>}{managedKeysError && <p role="alert" className="text-xs text-red-300">{managedKeysError}</p>}{managedKeys && <label className="block text-xs text-zinc-300">Existing unassigned key<select value={managedKey?.keyId ?? ''} onChange={(event) => { const selected = managedKeys.find((key) => key.keyId === event.target.value && !key.assigned); setManagedKey(selected ? { keyId: selected.keyId, publicKey: selected.publicKey } : undefined); invalidateConnection() }} className="mt-1.5 min-h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100"><option value="">Select a key</option>{managedKeys.filter((key) => !key.assigned).map((key) => <option key={key.keyId} value={key.keyId}>{key.keyId.slice(0, 12)}… · {key.fingerprint || 'fingerprint unavailable'} · {new Date(key.createdAt).toLocaleDateString()}</option>)}</select></label>}{managedKeys && managedKeys.every((key) => key.assigned) && <p className="mt-2 text-xs text-zinc-500">No unassigned managed keys are available.</p>}</div>}{managedKey && <div className="mt-3"><p className="text-xs text-emerald-400">{keySource === 'new' ? 'Key generated' : 'Existing key selected'}</p><label className="mt-2 block text-xs text-zinc-300">Public key to add to {provider==='github'?'GitHub':'your Git service'}<textarea readOnly rows={4} value={managedKey.publicKey} className="mt-1.5 w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-[11px] leading-4 text-zinc-300" /></label><div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span role="status" className="text-[11px] text-zinc-500">{copyState}</span><button type="button" onClick={() => void copyPublicKey()} className="min-h-10 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-800">Copy public key</button></div>{provider==='github'?<div className="mt-3 rounded-md border border-amber-800/60 bg-amber-950/20 p-3 text-xs leading-5 text-zinc-300"><p className="font-medium text-zinc-100">Add this public key in GitHub</p><ol className="mt-1 list-decimal space-y-1 pl-4"><li>Open your repository.</li><li>Open <strong>Settings</strong> → <strong>Deploy keys</strong>.</li><li>Choose <strong>Add deploy key</strong>.</li><li>Paste the public key shown above.</li><li><strong className="text-amber-300">Enable “Allow write access”.</strong></li><li>Save the key.</li></ol><p className="mt-2 text-amber-200">Write access is required so RepoQuill can synchronize your changes back to GitHub.</p></div>:<p className="mt-2 text-xs leading-5 text-amber-300">Add this public key as a repository or deploy key with read and write access in your Git provider.</p>}</div>}</div>}
              {onboardingStep===4&&<div className="space-y-3"><div className="rounded-md border border-zinc-800 p-3 text-xs leading-5 text-zinc-400"><p className="font-medium text-zinc-200">Check the connection</p><p className="mt-1">{provider==='github'?'After adding the deploy key in GitHub, test whether RepoQuill can access this repository.':'After granting repository access, test whether RepoQuill can reach and use this repository.'}</p><p className="mt-2">Repository permission and Git-server identity are checked separately. RepoQuill never disables SSH host verification.</p></div><div className="rounded-md border border-zinc-800 p-3"><div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-medium text-zinc-200">Connection test</p><p className="mt-1 text-[11px] text-zinc-500">Your entered details stay in this wizard if the test fails.</p></div><button type="button" disabled={connectionBusy || !repositoryURL || (gitAuthType === 'managed-ssh' && !managedKey)} onClick={() => void testRepositoryConnection()} className="min-h-11 shrink-0 rounded-md bg-amber-500 px-4 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40">{connectionBusy ? 'Testing…' : 'Test connection'}</button></div>{connectionResult && <p role="status" className={`mt-3 text-xs leading-5 ${connectionResult.state === 'success' ? 'text-emerald-400' : 'text-red-300'}`}>{connectionResult.message}</p>}{connectionAction()&&<p className="mt-2 text-xs leading-5 text-amber-300">{connectionAction()}</p>}{hostTrust && <div className={`mt-3 rounded-md border p-3 ${hostTrust.state === 'host_key_changed' ? 'border-red-700 bg-red-950/30' : 'border-amber-700/70 bg-amber-950/20'}`}><h4 className="text-sm font-semibold text-zinc-100">{hostTrust.state === 'host_key_changed' ? 'SSH host key changed' : 'Unknown SSH host'}</h4><p className="mt-2 text-xs text-zinc-300"><span className="text-zinc-500">Git server:</span> {hostTrust.host}{hostTrust.port !== 22 ? `:${hostTrust.port}` : ''}</p><HostFingerprintList title="Presented fingerprints" keys={hostTrust.presentedKeys} />{hostTrust.previouslyTrustedKeys && <HostFingerprintList title="Previously trusted fingerprints" keys={hostTrust.previouslyTrustedKeys} />}<p className="mt-3 text-xs leading-5 text-zinc-400">{hostTrust.state === 'host_key_changed' ? 'The server identity no longer matches the identity previously trusted by RepoQuill. This can indicate a legitimate server-key rotation or a security problem. RepoQuill blocks the connection; review the server independently before changing the trust configuration.' : 'RepoQuill has not connected to this Git server before. Compare these fingerprints with a trusted source before approving them. This check helps prevent connecting to an unexpected server.'}</p>{hostTrust.state === 'unknown_host'&&provider==='github'&&<a href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints" target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-10 items-center rounded px-2 text-xs text-amber-300 hover:bg-zinc-800">Open GitHub’s official SSH fingerprints</a>}{hostTrust.state === 'unknown_host' && <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={() => setHostTrust(undefined)} className="min-h-11 rounded-md border border-zinc-700 px-4 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button><button type="button" disabled={trustBusy} onClick={() => void trustSSHHost()} className="min-h-11 rounded-md bg-amber-500 px-4 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40">{trustBusy ? 'Trusting…' : 'Trust this Git server'}</button></div>}</div>}</div></div>}
              {onboardingStep===3&&gitAuthType==='managed-ssh'&&managedKey&&provider&&<a href={providerDetails[provider].instructions} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center rounded px-2 text-xs text-amber-300 hover:bg-zinc-800">Open full {providerDetails[provider].name} key instructions</a>}
              {onboardingStep===5&&<div className="rounded-md border border-zinc-800 p-3"><h4 className="text-sm font-medium">Review notebook connection</h4><dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2"><div><dt className="text-zinc-500">Notebook</dt><dd className="mt-0.5">{notebookName}</dd></div><div><dt className="text-zinc-500">Git service</dt><dd className="mt-0.5">{provider?providerDetails[provider].name:'Git server'}</dd></div><div><dt className="text-zinc-500">Git server</dt><dd className="mt-0.5">{repositoryHost(repositoryURL)}</dd></div><div><dt className="text-zinc-500">Branch</dt><dd className="mt-0.5">{repositoryBranch||'Remote default branch'}</dd></div><div className="sm:col-span-2"><dt className="text-zinc-500">Repository</dt><dd className="mt-0.5 break-all">{repositoryURL}</dd></div><div><dt className="text-zinc-500">Access method</dt><dd className="mt-0.5">{gitAuthType==='managed-ssh'?'Dedicated RepoQuill-managed SSH key':'Existing server SSH configuration'}</dd></div><div><dt className="text-zinc-500">Connection status</dt><dd className="mt-0.5">{connectionResult?.state==='success'?'Connection successful':'Not confirmed'}</dd></div></dl><div className="mt-4 space-y-2 rounded-md bg-zinc-950/50 p-3 text-xs leading-5 text-zinc-400"><p>RepoQuill will copy this repository to the server and open it as a notebook. Your notes remain normal Markdown files inside the Git repository.</p><p><strong className="font-medium text-zinc-300">Saving</strong> writes a note to this RepoQuill server. <strong className="font-medium text-zinc-300">Synchronization</strong> separately sends saved changes to the Git service and receives remote changes.</p></div></div>}
              {cloneError && <p role="alert" className="rounded-md border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{cloneError}</p>}
            </form>
          </section>}

		  {mode === 'settings' && <section className="order-5 mt-6 border-t border-zinc-800 pt-5" aria-labelledby="ssh-keys-title">
			<div className="flex items-start justify-between gap-3"><div><h3 id="ssh-keys-title" className="text-sm font-semibold text-zinc-200">Advanced</h3><p className="mt-1 text-xs leading-5 text-zinc-500">Connection credentials and Git/SSH diagnostics. Most users do not need these controls after notebook setup.</p></div><button type="button" disabled={managedKeysBusy} onClick={() => void loadManagedKeys()} className="min-h-10 shrink-0 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">{managedKeys ? 'Refresh' : 'Load keys'}</button></div>
            {managedKeysError && <p role="alert" className="mt-3 rounded-md border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{managedKeysError}</p>}
            {managedKeysBusy && !managedKeys && <p className="mt-3 text-xs text-zinc-500">Loading managed keys…</p>}
            {managedKeys && <div className="mt-3 space-y-2">{managedKeys.length === 0 ? <p className="rounded-md border border-zinc-800 p-3 text-xs text-zinc-500">No managed SSH keys found.</p> : managedKeys.map((key) => <div key={key.keyId} className="rounded-md border border-zinc-800 p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-mono text-xs text-zinc-300">{key.keyId.slice(0, 12)}…</p><p className={`mt-1 text-xs ${key.assigned ? 'text-emerald-400' : 'text-amber-300'}`}>{key.assigned ? `Assigned to ${key.notebookName || 'notebook'}` : 'Unused'}</p><p className="mt-1 text-[11px] text-zinc-500">Created {new Date(key.createdAt).toLocaleString()}</p></div><div className="flex flex-wrap gap-1"><button type="button" onClick={() => void navigator.clipboard.writeText(key.publicKey)} className="min-h-10 rounded-md px-3 text-xs text-amber-300 hover:bg-zinc-800">Copy public key</button><button type="button" disabled={key.assigned} title={key.assigned ? 'Assigned keys cannot be deleted' : undefined} onClick={() => setDeleteKey(key)} className="min-h-10 rounded-md px-3 text-xs text-red-300 hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-35">Delete</button></div></div><details className="mt-2"><summary className="cursor-pointer text-xs text-zinc-500">Show public key</summary><code className="mt-2 block break-all rounded bg-zinc-950 p-2 text-[11px] leading-5 text-zinc-400">{key.publicKey}</code></details></div>)}</div>}
          </section>}

          {mode === 'settings' && <section className="order-1">
			<h3 className="text-sm font-semibold text-zinc-200">General</h3>
            <label className="mt-4 block text-sm text-zinc-300">Auto-lock notes<select value={autoLockMinutes} onChange={(event) => onAutoLockMinutes(parseAutoLockMinutes(event.target.value))} className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-amber-500">{autoLockOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <p className="mt-2 text-xs leading-5 text-zinc-500">Switch an editable note to Read only after no document changes. Reading, scrolling, and text selection do not reset the timer.</p>
			<div className="mt-5 border-t border-zinc-800 pt-5"><h3 className="text-sm font-semibold text-zinc-200">Synchronization</h3><p className="mt-1 text-xs leading-5 text-zinc-500">Saving writes a note to this RepoQuill server. Synchronization separately exchanges those saved changes with the connected service.</p><label className="mt-4 block text-sm text-zinc-300">Scheduled synchronization<select aria-label="Scheduled sync" value={syncPreferences.scheduledMinutes} onChange={(event) => onSyncPreferences({ ...syncPreferences, scheduledMinutes: Number(event.target.value) as SyncPreferences['scheduledMinutes'] })} className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"><option value={0}>Off</option><option value={5}>Every 5 minutes</option><option value={15}>Every 15 minutes</option><option value={30}>Every 30 minutes</option><option value={60}>Every hour</option></select></label><label className="mt-4 block text-sm text-zinc-300">Synchronize after editing inactivity<select aria-label="Sync after editing inactivity" value={syncPreferences.inactivityMinutes} onChange={(event) => onSyncPreferences({ ...syncPreferences, inactivityMinutes: Number(event.target.value) as SyncPreferences['inactivityMinutes'] })} className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"><option value={0}>Off</option><option value={1}>1 minute</option><option value={2}>2 minutes</option><option value={5}>5 minutes</option><option value={10}>10 minutes</option></select></label><p className="mt-3 text-xs leading-5 text-zinc-500">RepoQuill also synchronizes at safe transition points such as startup, returning to the app, and changing notes or notebooks. Closing-tab synchronization remains best effort because browsers cannot guarantee its completion.</p></div>
          </section>}

          {mode === 'settings' && <SecurityPanel authMode={authMode} runningVersion={runningVersion} onLoggedOut={onLoggedOut} />}

		  {mode === 'settings' && <section className="order-4 mt-6 border-t border-zinc-800 pt-5" aria-labelledby="maintenance-title">
            <div className="flex items-start justify-between gap-4">
			  <div><h3 id="maintenance-title" className="text-sm font-semibold text-zinc-200">Storage and recovery</h3><p className="mt-1 text-xs leading-5 text-zinc-500">Review image files in note-specific asset folders that are no longer referenced by Markdown. Nothing is removed without confirmation.</p></div>
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
        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-zinc-800 p-4">
          {mode === 'onboarding' ? <>
            <button type="button" onClick={onClose} className="min-h-10 rounded-md border border-zinc-700 px-4 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button>
            {onboardingStep > 1 && <button type="button" onClick={()=>setOnboardingStep(step=>Math.max(1,step-1))} className="min-h-10 rounded-md border border-zinc-700 px-4 text-sm text-zinc-200 hover:bg-zinc-800">Back</button>}
            {onboardingStep > 1 && onboardingStep < 5 && <button type="button" disabled={(onboardingStep===2&&(!notebookName||!!repositoryURLIssue(repositoryURL)))||(onboardingStep===3&&gitAuthType==='managed-ssh'&&!managedKey)||(onboardingStep===4&&connectionResult?.state!=='success')} onClick={()=>setOnboardingStep(step=>step+1)} className="min-h-10 rounded-md bg-amber-500 px-4 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40">Continue</button>}
            {onboardingStep === 5 && <button type="submit" form="notebook-onboarding-form" disabled={cloneBusy||connectionResult?.state!=='success'} className="min-h-10 rounded-md bg-amber-500 px-4 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40">{cloneBusy?'Cloning…':'Connect notebook'}</button>}
          </> : <button type="button" onClick={onClose} className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400">Done</button>}
        </footer>
      </div>

      {confirmCleanup && <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/75 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmCleanup(false) }}><div role="alertdialog" aria-modal="true" aria-labelledby="cleanup-confirm-title" className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"><h2 id="cleanup-confirm-title" className="text-lg font-semibold">Delete {selectedCount} unreferenced {selectedCount === 1 ? 'asset' : 'assets'}?</h2><p className="mt-3 text-sm leading-6 text-zinc-400">These files will be removed from the active notebook. Files included in an earlier synchronization may be recoverable from its version history; newly added files may not be.</p><div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={() => setConfirmCleanup(false)} className="min-h-11 rounded-md border border-zinc-700 px-4 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button><button type="button" onClick={() => void deleteSelectedAssets()} className="min-h-11 rounded-md bg-red-800 px-4 text-sm font-medium text-white hover:bg-red-700">Delete assets</button></div></div></div>}
      {deleteKey && <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/75 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteKey(undefined) }}><div role="alertdialog" aria-modal="true" aria-labelledby="delete-key-title" className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"><h2 id="delete-key-title" className="text-lg font-semibold">Delete unused SSH key?</h2><p className="mt-3 text-sm leading-6 text-zinc-400">The private and public key files for <span className="font-mono text-zinc-300">{deleteKey.keyId.slice(0, 12)}…</span> will be permanently removed from RepoQuill. Also remove its deploy-key entry from the Git provider if it was added there.</p><div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={() => setDeleteKey(undefined)} className="min-h-11 rounded-md border border-zinc-700 px-4 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button><button type="button" onClick={() => void deleteUnusedManagedKey()} className="min-h-11 rounded-md bg-red-800 px-4 text-sm font-medium text-white hover:bg-red-700">Delete key</button></div></div></div>}
    </div>
  )
}

type SecuritySession = { id:string; createdAt:string; lastActivityAt:string; idleExpiresAt:string; absoluteExpiresAt:string; revokedAt?:string; clientDescription:string; current:boolean }
type ServerSessionSettings = { idleHours:number; lifetimeHours:number; rememberDays:number }

function SecurityPanel({ authMode, runningVersion, onLoggedOut }: { authMode:'local'|'disabled'; runningVersion:string; onLoggedOut:()=>void }) {
  const [settings, setSettings] = useState<ServerSessionSettings>()
  const [sessions, setSessions] = useState<SecuritySession[]>([])
  const [mfaEnabled, setMFAEnabled] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (authMode !== 'local') return
    try {
      const [securityResponse, sessionsResponse] = await Promise.all([apiFetch('/api/auth/security'), apiFetch('/api/auth/sessions')])
      const security = await responseJSON<{sessionSettings:ServerSessionSettings;mfaEnabled:boolean}>(securityResponse)
      setSettings(security.sessionSettings)
      setMFAEnabled(security.mfaEnabled)
      setSessions((await responseJSON<{sessions:SecuritySession[]}>(sessionsResponse)).sessions)
    } catch (caught) { setError(messageFrom(caught)) }
  }, [authMode])
  useEffect(() => { queueMicrotask(() => void load()) }, [load])

  async function changePassword(event:FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form=event.currentTarget; const data=new FormData(form)
    if (data.get('newPassword') !== data.get('confirmNewPassword')) { setError('New passwords do not match.'); return }
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      const response=await apiFetch('/api/auth/password',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:data.get('currentPassword'),newPassword:data.get('newPassword'),mfaCode:data.get('passwordMfaCode')})})
      const result=await responseJSON<{csrfToken:string}>(response); setCSRFToken(result.csrfToken); form.reset(); setNotice('Password changed. All other sessions were signed out.'); notifyAuthChanged(); await load()
    } catch(caught){setError(messageFrom(caught))} finally{setBusy(false)}
  }

  async function saveDurations(event:FormEvent<HTMLFormElement>) {
    event.preventDefault(); if(!settings)return; const form=event.currentTarget; const data=new FormData(form); setBusy(true);setError(undefined);setNotice(undefined)
    try { const response=await apiFetch('/api/auth/security/session-settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...settings,currentPassword:data.get('settingsPassword'),mfaCode:data.get('settingsMfaCode')})}); const result=await responseJSON<{sessionSettings:ServerSessionSettings}>(response);setSettings(result.sessionSettings);form.reset();setNotice('Session durations saved. They apply to new logins.') } catch(caught){setError(messageFrom(caught))} finally{setBusy(false)}
  }

  async function revoke(path:string) { setBusy(true);setError(undefined);try{await responseJSON(await apiFetch(path,{method:'DELETE'}));await load()}catch(caught){setError(messageFrom(caught))}finally{setBusy(false)} }
  async function logout(){setBusy(true);try{await responseJSON(await apiFetch('/api/auth/logout',{method:'POST'}));onLoggedOut()}catch(caught){setError(messageFrom(caught));setBusy(false)}}

  const version = runningVersion || 'dev'
  return <section className="order-3 mt-6 border-t border-zinc-800 pt-5" aria-labelledby="security-title"><h3 id="security-title" className="text-sm font-semibold text-zinc-200">Security</h3>{authMode==='disabled'?<p role="alert" className="mt-3 rounded-md border border-amber-700/70 bg-amber-950/25 p-3 text-xs leading-5 text-amber-200"><strong>Built-in authentication is disabled.</strong> Restrict access through localhost, a private LAN/VPN/Tailscale network, or a deliberately configured external protection layer. Interactive forward-auth may expire independently and return login HTML to this PWA.</p>:<div className="mt-3 space-y-5">{error&&<p role="alert" className="rounded-md border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{error}</p>}{notice&&<p role="status" className="rounded-md border border-emerald-900/70 bg-emerald-950/20 p-3 text-xs text-emerald-300">{notice}</p>}<MFASettings enabled={mfaEnabled} busy={busy} setBusy={setBusy} onChanged={async()=>{await load()}} onLoggedOut={onLoggedOut} setError={setError} setNotice={setNotice}/><form onSubmit={(event)=>void changePassword(event)} className="space-y-3 rounded-md border border-zinc-800 p-3"><h4 className="text-sm font-medium">Change password</h4><p className="text-xs leading-5 text-zinc-500">Your current password confirms this sensitive change. All other sessions are revoked.</p><SecurityPassword name="currentPassword" label="Current password" autoComplete="current-password"/>{mfaEnabled&&<SecurityCode name="passwordMfaCode" label="Authenticator or recovery code"/>}<SecurityPassword name="newPassword" label="New password" autoComplete="new-password"/><SecurityPassword name="confirmNewPassword" label="Confirm new password" autoComplete="new-password"/><button disabled={busy} className="min-h-10 rounded-md border border-zinc-700 px-3 text-xs hover:bg-zinc-800 disabled:opacity-50">Change password</button></form>{settings&&<form onSubmit={(event)=>void saveDurations(event)} className="space-y-3 rounded-md border border-zinc-800 p-3"><h4 className="text-sm font-medium">Session durations</h4><label className="block text-xs text-zinc-300">Normal login lifetime<input type="number" min="1" max="24" value={settings.lifetimeHours} onChange={(event)=>setSettings({...settings,lifetimeHours:Number(event.target.value)})} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2"/> hours</label><label className="block text-xs text-zinc-300">Idle timeout<input type="number" min="1" max="720" value={settings.idleHours} onChange={(event)=>setSettings({...settings,idleHours:Number(event.target.value)})} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2"/> hours</label><label className="block text-xs text-zinc-300">Remembered device lifetime<input type="number" min="1" max="90" value={settings.rememberDays} onChange={(event)=>setSettings({...settings,rememberDays:Number(event.target.value)})} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2"/> days</label><SecurityPassword name="settingsPassword" label="Current password to save" autoComplete="current-password"/>{mfaEnabled&&<SecurityCode name="settingsMfaCode" label="Authenticator or recovery code"/>}<button disabled={busy} className="min-h-10 rounded-md border border-zinc-700 px-3 text-xs hover:bg-zinc-800 disabled:opacity-50">Save durations</button></form>}<div className="rounded-md border border-zinc-800 p-3"><div className="flex items-center justify-between gap-2"><div><h4 className="text-sm font-medium">Browser sessions</h4><p className="mt-1 text-xs text-zinc-500">Device descriptions use only the browser user agent.</p></div><button type="button" disabled={busy} onClick={()=>void revoke('/api/auth/sessions/others')} className="min-h-10 rounded px-2 text-xs text-amber-300 hover:bg-zinc-800">Sign out others</button></div><ul className="mt-3 space-y-2">{sessions.filter((session)=>!session.revokedAt).map((session)=><li key={session.id} className="rounded border border-zinc-800 p-2 text-xs"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-zinc-300">{session.clientDescription||'Unknown client'} {session.current&&<span className="text-emerald-400">· Current</span>}</p><p className="mt-1 text-zinc-500">Active {new Date(session.lastActivityAt).toLocaleString()}</p></div>{!session.current&&<button type="button" disabled={busy} onClick={()=>void revoke(`/api/auth/sessions/${encodeURIComponent(session.id)}`)} className="min-h-9 shrink-0 rounded px-2 text-red-300 hover:bg-red-950/40">Revoke</button>}</div></li>)}</ul><button type="button" disabled={busy} onClick={()=>void logout()} className="mt-4 min-h-10 rounded-md border border-red-900 px-3 text-xs text-red-300 hover:bg-red-950/40">Sign out this device</button></div></div>}<div className="mt-6 border-t border-zinc-800 pt-4 text-[11px] text-zinc-500"><p className="select-text">RepoQuill {version}</p>{version!=='dev'&&<a className="mt-1 inline-block text-amber-400 hover:underline" href={`https://github.com/fred-head/repoquill/releases/tag/v${encodeURIComponent(version)}`} target="_blank" rel="noreferrer">View release</a>}</div></section>
}

type MFAEnrollment = { secret:string; qrCode:string; recoveryCodes:string[] }
function MFASettings({enabled,busy,setBusy,onChanged,onLoggedOut,setError,setNotice}:{enabled:boolean;busy:boolean;setBusy:(value:boolean)=>void;onChanged:()=>Promise<void>;onLoggedOut:()=>void;setError:(value:string|undefined)=>void;setNotice:(value:string|undefined)=>void}) {
  const [enrollment,setEnrollment]=useState<MFAEnrollment>()
  const [shownCodes,setShownCodes]=useState<string[]>()
  async function begin(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=event.currentTarget;const data=new FormData(form);setBusy(true);setError(undefined);try{const response=await apiFetch('/api/auth/mfa/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:data.get('mfaPassword'),currentFactor:data.get('currentFactor')})});setEnrollment(await responseJSON<MFAEnrollment>(response));form.reset()}catch(caught){setError(messageFrom(caught))}finally{setBusy(false)}}
  async function confirm(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=event.currentTarget;const data=new FormData(form);setBusy(true);setError(undefined);try{const result=await responseJSON<{csrfToken:string}>(await apiFetch('/api/auth/mfa/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:data.get('confirmationCode'),recoveryCodesStored:data.get('codesStored')==='on'})}));setCSRFToken(result.csrfToken);setEnrollment(undefined);setNotice('Two-factor authentication enabled.');notifyAuthChanged();await onChanged()}catch(caught){setError(messageFrom(caught))}finally{setBusy(false)}}
  async function disable(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=event.currentTarget;const data=new FormData(form);setBusy(true);setError(undefined);try{await responseJSON(await apiFetch('/api/auth/mfa',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:data.get('disablePassword'),code:data.get('disableCode')})}));onLoggedOut()}catch(caught){setError(messageFrom(caught));setBusy(false)}}
  async function regenerate(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=event.currentTarget;const data=new FormData(form);setBusy(true);setError(undefined);try{const result=await responseJSON<{recoveryCodes:string[]}>(await apiFetch('/api/auth/mfa/recovery-codes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:data.get('recoveryPassword'),code:data.get('recoveryCode')})}));setShownCodes(result.recoveryCodes);form.reset()}catch(caught){setError(messageFrom(caught))}finally{setBusy(false)}}
  async function cancelEnrollment(){setBusy(true);setError(undefined);try{await responseJSON(await apiFetch('/api/auth/mfa/enrollment',{method:'DELETE'}));setEnrollment(undefined);setNotice('MFA setup cancelled.')}catch(caught){setError(messageFrom(caught))}finally{setBusy(false)}}
  return <div className="rounded-md border border-zinc-800 p-3"><h4 className="text-sm font-medium">Two-factor authentication</h4><p className="mt-1 text-xs leading-5 text-zinc-500">{enabled?'Enabled. A code is required after your password.':'Optional. Use any standard TOTP authenticator app.'}</p>{!enrollment&&<form onSubmit={(event)=>void begin(event)} className="mt-3 space-y-3"><SecurityPassword name="mfaPassword" label="Current password" autoComplete="current-password"/>{enabled&&<SecurityCode name="currentFactor" label="Current authenticator or recovery code"/>}<button disabled={busy} className="min-h-10 rounded border border-zinc-700 px-3 text-xs hover:bg-zinc-800">{enabled?'Replace authenticator':'Set up authenticator'}</button></form>}{enrollment&&<form onSubmit={(event)=>void confirm(event)} className="mt-4 space-y-3 rounded border border-amber-800/60 p-3"><p className="text-xs text-zinc-300">Scan this QR code locally with your authenticator app.</p><img src={enrollment.qrCode} alt="TOTP enrollment QR code" className="mx-auto h-56 w-56 rounded bg-white p-2"/><p className="break-all font-mono text-xs text-zinc-400">Manual secret: {enrollment.secret}</p><RecoveryCodes codes={enrollment.recoveryCodes}/><label className="flex items-start gap-2 text-xs text-zinc-300"><input name="codesStored" type="checkbox" required className="mt-0.5 h-4 w-4"/>I stored these recovery codes safely.</label><SecurityCode name="confirmationCode" label="Current code from the new authenticator"/><div className="flex flex-wrap gap-2"><button disabled={busy} className="min-h-10 rounded bg-amber-500 px-3 text-xs font-medium text-zinc-950">Enable MFA</button><button type="button" disabled={busy} onClick={()=>void cancelEnrollment()} className="min-h-10 rounded border border-zinc-700 px-3 text-xs text-zinc-300">Cancel setup</button></div></form>}{enabled&&<><form onSubmit={(event)=>void regenerate(event)} className="mt-4 space-y-3 border-t border-zinc-800 pt-4"><h5 className="text-xs font-medium">Generate new recovery codes</h5><SecurityPassword name="recoveryPassword" label="Current password" autoComplete="current-password"/><SecurityCode name="recoveryCode" label="Authenticator or recovery code"/><button disabled={busy} className="min-h-10 rounded border border-zinc-700 px-3 text-xs">Regenerate codes</button></form>{shownCodes&&<RecoveryCodes codes={shownCodes}/>}<form onSubmit={(event)=>void disable(event)} className="mt-4 space-y-3 border-t border-zinc-800 pt-4"><h5 className="text-xs font-medium text-red-300">Disable MFA</h5><SecurityPassword name="disablePassword" label="Current password" autoComplete="current-password"/><SecurityCode name="disableCode" label="Authenticator or recovery code"/><button disabled={busy} className="min-h-10 rounded border border-red-900 px-3 text-xs text-red-300">Disable and sign out all devices</button></form></>}</div>
}

function RecoveryCodes({codes}:{codes:string[]}) { return <div className="rounded border border-zinc-700 bg-zinc-950 p-3"><p className="mb-2 text-xs font-medium text-amber-300">Recovery codes — shown once</p><ul className="grid gap-1 font-mono text-xs sm:grid-cols-2">{codes.map((code)=><li key={code}>{code}</li>)}</ul></div> }
function SecurityCode({name,label}:{name:string;label:string}) { return <label className="block text-xs text-zinc-300">{label}<input name={name} required autoComplete="one-time-code" spellCheck={false} className="mt-1.5 min-h-10 w-full rounded border border-zinc-700 bg-zinc-950 px-3 font-mono text-sm"/></label> }

function SecurityPassword({name,label,autoComplete}:{name:string;label:string;autoComplete:string}) { return <label className="block text-xs text-zinc-300">{label}<input name={name} type="password" required minLength={15} maxLength={1024} autoComplete={autoComplete} className="mt-1.5 min-h-10 w-full rounded border border-zinc-700 bg-zinc-950 px-3 text-sm"/></label> }

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

function ManageNotebooksDialog({ notebooks, activeNotebookID, operationsBlocked, onChanged, onClose }: { notebooks: NotebookInfo[]; activeNotebookID: string; operationsBlocked:boolean; onChanged: () => Promise<void>; onClose: () => void }) {
  const [busy,setBusy]=useState(false); const [error,setError]=useState<string>(); const [health,setHealth]=useState<Record<string,NotebookHealth>>({}); const [editing,setEditing]=useState<NotebookInfo>(); const [name,setName]=useState(''); const [removing,setRemoving]=useState<NotebookInfo>(); const [deleteLocal,setDeleteLocal]=useState(false); const [confirmation,setConfirmation]=useState('')
  const checkHealth=useCallback(async(notebook:NotebookInfo,remote=false)=>{try{const response=await apiFetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/health${remote?'?remote=true':''}`);const result=await responseJSON<NotebookHealth>(response);setHealth(current=>({...current,[notebook.id]:result}))}catch(caught){setError(messageFrom(caught))}},[])
  useEffect(()=>{notebooks.forEach(notebook=>void checkHealth(notebook))},[notebooks,checkHealth])
  async function saveName(event:FormEvent){event.preventDefault();if(!editing)return;setBusy(true);setError(undefined);try{await responseJSON(await apiFetch(`/api/notebooks/${encodeURIComponent(editing.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})}));setEditing(undefined);await onChanged()}catch(caught){setError(messageFrom(caught))}finally{setBusy(false)}}
  async function remove(){if(!removing)return;setBusy(true);setError(undefined);try{const response=await apiFetch(`/api/notebooks/${encodeURIComponent(removing.id)}${deleteLocal?'?deleteLocal=true':''}`,{method:'DELETE',...(deleteLocal?{headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation})}:{})});if(!response.ok)await responseJSON(response);setRemoving(undefined);await onChanged()}catch(caught){setError(messageFrom(caught))}finally{setBusy(false)}}
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><div role="dialog" aria-modal="true" aria-labelledby="manage-notebooks-title" className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"><header className="border-b border-zinc-800 px-5 py-4"><h2 id="manage-notebooks-title" className="text-lg font-semibold">Manage Notebooks</h2><p className="mt-1 text-xs text-zinc-500">Names, connection health, and safe local registration controls.</p></header><div className="overflow-y-auto p-4 sm:p-5">{error&&<ErrorMessage>{error}</ErrorMessage>}{operationsBlocked&&<p role="status" className="mb-3 rounded border border-amber-800/60 p-3 text-xs text-amber-200">Finish the current save or notebook operation before renaming or removing a notebook.</p>}<div className="space-y-3">{notebooks.map(notebook=>{const item=health[notebook.id];return <section key={notebook.id} className="rounded-lg border border-zinc-800 p-3"><div className="flex flex-wrap items-center justify-between gap-2">{editing?.id===notebook.id?<form onSubmit={event=>void saveName(event)} className="flex flex-1 gap-2"><label className="sr-only" htmlFor={`notebook-name-${notebook.id}`}>Notebook name</label><input id={`notebook-name-${notebook.id}`} autoFocus required maxLength={100} value={name} onChange={event=>setName(event.target.value)} className="min-h-10 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 text-sm"/><button disabled={busy||operationsBlocked} className="rounded border border-zinc-700 px-3 text-xs">Save</button><button type="button" onClick={()=>setEditing(undefined)} className="px-2 text-xs text-zinc-400">Cancel</button></form>:<><div><h3 className="font-medium text-zinc-100">{notebook.name}</h3><p className="text-[11px] text-zinc-500">{notebook.id===activeNotebookID?'Currently open':'Not currently open'}</p></div><button type="button" disabled={busy||operationsBlocked} onClick={()=>{setEditing(notebook);setName(notebook.name)}} className="min-h-10 rounded px-3 text-xs text-amber-300 hover:bg-zinc-800">Rename</button></>}</div><div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">{item?<><HealthLine label="Local files" check={item.localFiles}/><HealthLine label="Write access" check={item.writeAccess}/><HealthLine label="Connected service" check={item.connection}/><HealthLine label="Pending work" check={item.pendingWork}/></>:<p className="text-zinc-500">Checking notebook…</p>}</div><div className="mt-3 flex flex-wrap items-center gap-2"><button type="button" disabled={busy} onClick={()=>void checkHealth(notebook,true)} className="min-h-10 rounded border border-zinc-700 px-3 text-xs">{item?.connection.state==='failed'?'Check connection':'Test connection'}</button>{item?.writeAccess.state==='failed'&&<span className="text-xs text-amber-300">Repair the mounted folder permissions, then retry.</span>}<span className="text-[11px] text-zinc-500">Last synchronized: {item?.lastSyncedAt?new Date(item.lastSyncedAt).toLocaleString():'Not recorded'}</span></div><details className="mt-3 text-xs"><summary className="cursor-pointer text-zinc-500">Technical details</summary><dl className="mt-2 grid gap-1 break-all text-zinc-400"><div><dt className="inline text-zinc-500">Address: </dt><dd className="inline">{notebook.remoteUrl||'No remote configured'}</dd></div><div><dt className="inline text-zinc-500">Branch: </dt><dd className="inline">{notebook.branch||'Remote default'}</dd></div><div><dt className="inline text-zinc-500">Credentials: </dt><dd className="inline">{notebook.authType==='managed-ssh'?`Managed key ${notebook.keyId?.slice(0,12)||''}…`:'Existing server SSH configuration'}</dd></div></dl></details>{(notebook.id!==activeNotebookID||notebooks.length===1)&&<button type="button" disabled={busy||operationsBlocked} onClick={()=>{setRemoving(notebook);setDeleteLocal(false);setConfirmation('')}} className="mt-3 min-h-10 rounded border border-red-900/70 px-3 text-xs text-red-300">Remove…</button>}</section>})}</div></div><footer className="flex justify-end border-t border-zinc-800 p-4"><button type="button" onClick={onClose} className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-950">Done</button></footer></div>{removing&&<div role="alertdialog" aria-modal="true" aria-labelledby="remove-notebook-title" className="fixed inset-0 z-10 flex items-center justify-center bg-black/75 p-4"><div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5"><h3 id="remove-notebook-title" className="font-semibold">Remove {removing.name}?</h3><p className="mt-2 text-xs leading-5 text-zinc-400">The safe default only removes this registration from RepoQuill. The local files and remote repository stay unchanged.</p><label className="mt-4 flex items-start gap-2 text-xs text-red-200"><input type="checkbox" checked={deleteLocal} onChange={event=>{setDeleteLocal(event.target.checked);setConfirmation('')}} className="mt-0.5"/>Also permanently delete this local working copy. The remote repository is never deleted.</label>{deleteLocal&&<label className="mt-3 block text-xs text-zinc-300">Type <strong>{removing.name}</strong> to confirm<input value={confirmation} onChange={event=>setConfirmation(event.target.value)} className="mt-1 min-h-10 w-full rounded border border-red-800 bg-zinc-950 px-2"/></label>}<div className="mt-5 flex justify-end gap-2"><button type="button" onClick={()=>setRemoving(undefined)} className="min-h-10 px-3 text-xs">Cancel</button><button type="button" disabled={busy||operationsBlocked||(deleteLocal&&confirmation!==removing.name)} onClick={()=>void remove()} className="min-h-10 rounded border border-red-800 px-3 text-xs text-red-200">{deleteLocal?'Delete local copy':'Remove registration'}</button></div></div></div>}</div>
}

function HealthLine({label,check}:{label:string;check:NotebookCheck}){const okay=check.state==='ok'||check.state==='clean'||check.state==='synced'||check.state==='success';return <div title={check.message} className="flex items-center justify-between gap-2 rounded bg-zinc-950/60 px-2 py-2"><span className="text-zinc-400">{label}</span><span className={okay?'text-emerald-400':check.state==='not_checked'?'text-zinc-500':'text-amber-300'}>{okay?'Ready':check.state==='not_checked'?'Not checked':'Needs attention'}</span></div>}

function SettingsIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.1A1.7 1.7 0 0 0 8.4 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.2V9.55h.1A1.7 1.7 0 0 0 4 8.4a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.46 3.6l.06.06A1.7 1.7 0 0 0 8.4 4a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1v-.1h4.05v.1A1.7 1.7 0 0 0 15 4a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8.4a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4.05h-.1A1.7 1.7 0 0 0 19.4 15Z"/></svg>
}

function LogoutIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 5H5.5A1.5 1.5 0 0 0 4 6.5v11A1.5 1.5 0 0 0 5.5 19H10"/><path d="M14 8l4 4-4 4M8 12h10"/></svg>
}

type TreeEntryProps = {
  entry: TreeNode
  selectedPath?: string
  expandedFolders: Set<string>
  renamePath?: string
  renameValue: string
  onSelect: (entry: TreeNode, disposition?: 'current' | 'new') => void
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
          : <button type="button" className="min-w-0 flex-1 truncate py-1.5 pr-2 text-left text-sm" onClick={(event) => onSelect(entry, !isFolder && (event.ctrlKey || event.metaKey) ? 'new' : 'current')} onAuxClick={(event) => { if (!isFolder && event.button === 1) { event.preventDefault(); onSelect(entry, 'new') } }} onDoubleClick={() => { if (isFolder) onToggleFolder(entry.path) }}>{isFolder ? entry.name : entry.name.replace(/\.md$/i, '')}</button>}
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

function TextInputDialog({ title, label, initialValue, confirmLabel, onCancel, onConfirm }: { title:string; label:string; initialValue:string; confirmLabel:string; onCancel:()=>void; onConfirm:(value:string)=>void }) {
  const [value,setValue]=useState(initialValue)
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onMouseDown={(event)=>{if(event.target===event.currentTarget)onCancel()}}><form role="dialog" aria-modal="true" aria-labelledby="text-input-dialog-title" onSubmit={(event)=>{event.preventDefault();onConfirm(value)}} className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"><h2 id="text-input-dialog-title" className="text-lg font-semibold">{title}</h2><label className="mt-4 block text-sm text-zinc-300">{label}<input autoFocus required value={value} onChange={(event)=>setValue(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-amber-500"/></label><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onCancel} className="min-h-10 rounded-md border border-zinc-700 px-4 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button><button className="min-h-10 rounded-md bg-amber-500 px-4 text-sm font-medium text-zinc-950 hover:bg-amber-400">{confirmLabel}</button></div></form></div>
}

function ConfirmationDialog({ title, message, confirmLabel, danger=false, busy=false, onCancel, onConfirm }: { title:string; message:string; confirmLabel:string; danger?:boolean; busy?:boolean; onCancel:()=>void; onConfirm:()=>void }) {
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4" onMouseDown={(event)=>{if(event.target===event.currentTarget&&!busy)onCancel()}}><section role="alertdialog" aria-modal="true" aria-labelledby="confirmation-dialog-title" aria-describedby="confirmation-dialog-message" className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"><h2 id="confirmation-dialog-title" className="text-lg font-semibold">{title}</h2><p id="confirmation-dialog-message" className="mt-3 text-sm leading-6 text-zinc-400">{message}</p><div className="mt-5 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onCancel} className="min-h-10 rounded-md border border-zinc-700 px-4 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">Cancel</button><button type="button" disabled={busy} onClick={onConfirm} className={`min-h-10 rounded-md px-4 text-sm font-medium disabled:opacity-40 ${danger?'border border-red-800 bg-red-950/40 text-red-200 hover:bg-red-950/70':'bg-amber-500 text-zinc-950 hover:bg-amber-400'}`}>{busy?'Working…':confirmLabel}</button></div></section></div>
}

function SearchResults({ query, results, loading, error, onSelect }: { query: string; results: SearchResult[]; loading: boolean; error?: string; onSelect: (result: SearchResult) => void }) {
  if (loading) return <SidebarMessage>Searching…</SidebarMessage>
  if (error) return <div className="rounded-lg border border-red-900/70 bg-red-950/30 p-3 text-sm text-red-200">Search failed: {error}</div>
  if (results.length === 0) return <SidebarMessage>No results for “{query}”.</SidebarMessage>
  return <nav aria-label="Search results"><p className="mb-2 px-2 text-xs text-zinc-500">{results.length === 100 ? 'First 100 results' : `${results.length} ${results.length === 1 ? 'result' : 'results'}`}</p><ul className="space-y-1">{results.map((result, index) => <li key={`${result.type}:${result.path}:${result.line ?? 0}:${index}`}><button type="button" onClick={() => onSelect(result)} className="w-full rounded-md px-2 py-2 text-left hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"><span className="flex items-center gap-2 text-sm text-zinc-200"><span aria-hidden="true" className="text-zinc-500">{result.type === 'directory' ? '▸' : result.type === 'file' ? '◇' : '≡'}</span><span className="truncate">{result.path.replace(/\.md$/i, '')}</span>{result.line && <span className="ml-auto shrink-0 text-xs text-zinc-500">L{result.line}</span>}</span>{result.excerpt && <span className="mt-1 block truncate pl-5 text-xs text-zinc-500">{result.excerpt}</span>}</button></li>)}</ul></nav>
}

function ActionMenu({ entry, onNewNote, onNewFolder, onOpenNewTab, onRename, onMove, onDelete }: { entry?: TreeNode; onNewNote: (entry?: TreeNode) => void; onNewFolder: (entry?: TreeNode) => void; onOpenNewTab: (entry: TreeNode) => void; onRename: (entry: TreeNode) => void; onMove: (entry: TreeNode) => void; onDelete: (entry: TreeNode) => void }) {
  return <div role="menu" className="w-44 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-2xl"><MenuButton onClick={() => onNewNote(entry)}>New Note</MenuButton><MenuButton onClick={() => onNewFolder(entry)}>New Folder</MenuButton>{entry && <div className="my-1 border-t border-zinc-800" />}{entry?.type === 'file' && <MenuButton onClick={() => onOpenNewTab(entry)}>Open in new tab</MenuButton>}{entry && <><MenuButton onClick={() => onRename(entry)}>Rename</MenuButton><MenuButton onClick={() => onMove(entry)}>Move…</MenuButton><MenuButton danger onClick={() => onDelete(entry)}>Move to Trash</MenuButton></>}</div>
}

function NoteTabs({ tabs, activePath, onActivate, onClose }: { tabs: NoteTab[]; activePath?: string; onActivate: (path: string) => void; onClose: (path: string) => void }) {
  return <nav aria-label="Open notes" className="flex h-11 min-w-0 items-end gap-0.5 overflow-x-auto border-b border-zinc-800 px-2 sm:px-6"><div role="tablist" className="flex min-w-max items-end gap-0.5">{tabs.map((tab) => <div key={tab.path} role="presentation" className={`group flex h-10 max-w-56 items-center rounded-t-md border border-b-0 ${tab.path === activePath ? 'border-zinc-700 bg-zinc-900 text-zinc-100' : 'border-transparent text-zinc-500 hover:bg-zinc-900/60 hover:text-zinc-300'}`}><button type="button" role="tab" aria-selected={tab.path === activePath} title={tab.path} onClick={() => onActivate(tab.path)} className="min-w-0 flex-1 truncate py-2.5 pl-3 text-left text-xs">{baseName(tab.path).replace(/\.md$/i, '')}</button><button type="button" aria-label={`Close ${baseName(tab.path).replace(/\.md$/i, '')}`} title="Close tab" onClick={() => onClose(tab.path)} className="mx-0.5 flex min-h-9 min-w-9 items-center justify-center rounded text-base text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">×</button></div>)}</div></nav>
}

function MenuButton({ children, danger, onClick }: { children: ReactNode; danger?: boolean; onClick: () => void }) {
  return <button type="button" role="menuitem" onClick={onClick} className={`block w-full rounded px-3 py-2 text-left text-sm ${danger ? 'text-red-300 hover:bg-red-950' : 'text-zinc-200 hover:bg-zinc-800'}`}>{children}</button>
}

function MoveLinkPreviewDialog({ preview, onCancel, onConfirm }: { preview:MoveLinkPreview; onCancel:()=>void; onConfirm:()=>void }) {
  const grouped = new Map<string,LinkRewrite[]>()
  for (const rewrite of preview.rewrites) grouped.set(rewrite.notePath, [...(grouped.get(rewrite.notePath) ?? []), rewrite])
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}><section role="dialog" aria-modal="true" aria-labelledby="move-links-title" className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"><header className="border-b border-zinc-800 px-4 py-3 sm:px-5"><h2 id="move-links-title" className="text-lg font-semibold">Update note links?</h2><p className="mt-1 text-sm text-zinc-400">Moving <span className="text-zinc-200">{preview.source}</span> to <span className="text-zinc-200">{preview.target}</span> requires {preview.rewrites.length} portable Markdown link {preview.rewrites.length === 1 ? 'update' : 'updates'}.</p></header><div className="min-h-0 overflow-y-auto p-4 sm:p-5"><p className="mb-4 text-sm leading-6 text-zinc-400">Review the exact changes below. RepoQuill will stop if any note changed after this preview, and will never guess about unsupported or ambiguous Markdown.</p><div className="space-y-3">{[...grouped.entries()].map(([notePath,rewrites]) => <section key={notePath} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3"><h3 className="text-sm font-medium text-zinc-200">{notePath}{rewrites[0].nextNotePath !== notePath && <span className="text-zinc-500"> → {rewrites[0].nextNotePath}</span>}</h3><ul className="mt-2 space-y-2">{rewrites.map((rewrite,index) => <li key={`${rewrite.line}:${index}`} className="text-xs"><span className="text-zinc-500">Line {rewrite.line}</span><div className="mt-1 break-all font-mono text-red-300">− {rewrite.before}</div><div className="break-all font-mono text-emerald-300">+ {rewrite.after}</div></li>)}</ul></section>)}</div></div><footer className="flex flex-wrap justify-end gap-2 border-t border-zinc-800 p-4"><button type="button" onClick={onCancel} className="min-h-10 rounded-md border border-zinc-700 px-4 text-sm text-zinc-300 hover:bg-zinc-800">Cancel move</button><button type="button" onClick={onConfirm} className="min-h-10 rounded-md bg-amber-500 px-4 text-sm font-medium text-zinc-950 hover:bg-amber-400">Move and update links</button></footer></section></div>
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

export function TrashDialog({ onChanged, onClose }: { onChanged:()=>Promise<void>; onClose:()=>void }) {
  const [items, setItems] = useState<TrashItem[]>()
  const [selectedIDs, setSelectedIDs] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [deleteConfirmation, setDeleteConfirmation] = useState<TrashItem[]>()

  const load = useCallback(async () => {
    setError(undefined)
    try {
      const response = await apiFetch('/api/repository/trash')
      const loaded = (await responseJSON<{items:TrashItem[]}>(response)).items
      setItems(loaded)
      setSelectedIDs((current) => new Set([...current].filter((id) => loaded.some((item) => item.id === id))))
    } catch (caught) {
      setError(messageFrom(caught))
    }
  }, [])

  useEffect(() => {
    queueMicrotask(() => void load())
    const closeOnEscape = (event:globalThis.KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [load, onClose])

  async function run(itemsToProcess:TrashItem[], operation:'restore'|'delete') {
    if (itemsToProcess.length === 0) return
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    const failures:string[] = []
    let completed = 0
    try {
      for (const item of itemsToProcess) {
        try {
          const suffix = operation === 'restore' ? '/restore' : ''
          const method = operation === 'restore' ? 'POST' : 'DELETE'
          await responseJSON<TrashItem>(await apiFetch(`/api/repository/trash/${encodeURIComponent(item.id)}${suffix}`, { method }))
          completed += 1
        } catch (caught) {
          failures.push(`${item.originalPath}: ${messageFrom(caught)}`)
        }
      }
      setSelectedIDs(new Set())
      if (completed > 0) {
        const successful = itemsToProcess.filter((item) => !failures.some((failure) => failure.startsWith(`${item.originalPath}:`)))
        setNotice(completed === 1 ? `${operation === 'restore' ? 'Restored' : 'Permanently deleted'} “${successful[0].originalPath}”.` : `${operation === 'restore' ? 'Restored' : 'Permanently deleted'} ${completed} items.`)
      }
      if (failures.length > 0) setError(`${failures.length} ${failures.length === 1 ? 'item could' : 'items could'} not be ${operation === 'restore' ? 'restored' : 'deleted'}: ${failures.join('; ')}`)
      await Promise.all([load(), operation === 'restore' ? onChanged() : Promise.resolve()])
    } finally {
      setBusy(false)
    }
  }

  function toggleSelection(id:string) {
    setSelectedIDs((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedItems = items?.filter((item) => selectedIDs.has(item.id)) ?? []
  const allSelected = Boolean(items?.length && selectedIDs.size === items.length)

  return <><div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section role="dialog" aria-modal="true" aria-labelledby="trash-title" className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"><header className="flex items-center justify-between gap-3 border-b border-zinc-800 px-5 py-4"><div><h2 id="trash-title" className="text-lg font-semibold">Trash</h2><p className="mt-1 text-xs leading-5 text-zinc-500">Deleted notes, folders, and their owned image assets remain ordinary notebook files until permanently deleted.</p></div><button type="button" autoFocus onClick={onClose} aria-label="Close Trash" className="min-h-10 min-w-10 rounded text-xl text-zinc-500 hover:bg-zinc-800">×</button></header>{items && items.length > 0 && <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2"><label className="flex min-h-10 items-center gap-2 text-xs text-zinc-300"><input type="checkbox" aria-label="Select all Trash items" checked={allSelected} onChange={() => setSelectedIDs(allSelected ? new Set() : new Set(items.map((item) => item.id)))} className="h-4 w-4 accent-amber-500"/>Select all</label><span className="text-xs text-zinc-500">{selectedIDs.size} selected</span><div className="ml-auto flex flex-wrap gap-2"><button type="button" disabled={busy || selectedItems.length === 0} onClick={() => void run(selectedItems, 'restore')} className="min-h-9 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">Restore selected</button><button type="button" disabled={busy || selectedItems.length === 0} onClick={() => setDeleteConfirmation(selectedItems)} className="min-h-9 rounded-md border border-red-900 px-3 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-40">Delete selected</button><button type="button" disabled={busy} onClick={() => setDeleteConfirmation(items)} className="min-h-9 rounded-md border border-red-900 px-3 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-40">Empty Trash</button></div></div>}<div className="overflow-y-auto p-4 sm:p-5">{error && <ErrorMessage>{error}</ErrorMessage>}{notice && <p role="status" className="mb-4 rounded-md border border-emerald-900/70 bg-emerald-950/20 p-3 text-sm text-emerald-300">{notice}</p>}{items === undefined && !error && <p className="text-sm text-zinc-500">Loading Trash…</p>}{items?.length === 0 && <div className="rounded-md border border-zinc-800 p-5 text-center"><p className="text-sm text-zinc-300">Trash is empty.</p><p className="mt-1 text-xs text-zinc-500">Items you delete from the notebook tree will appear here.</p></div>}<ul className="space-y-2">{items?.map((item) => <li key={item.id} className="rounded-md border border-zinc-800 p-3"><label className="flex cursor-pointer items-start gap-3"><input type="checkbox" aria-label={`Select ${item.originalPath}`} checked={selectedIDs.has(item.id)} onChange={() => toggleSelection(item.id)} className="mt-1 h-4 w-4 shrink-0 accent-amber-500"/><span className="min-w-0 flex-1"><span className="break-all text-sm text-zinc-200"><span aria-hidden="true" className="mr-2">{item.type === 'directory' ? '📁' : '◇'}</span>{item.originalPath}</span><span className="mt-1 block text-xs text-zinc-500">Deleted {new Date(item.deletedAt).toLocaleString()} · {formatBytes(item.size)}</span></span></label><div className="mt-2 flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => void run([item], 'restore')} className="min-h-9 rounded-md px-3 text-xs text-amber-300 hover:bg-zinc-800 disabled:opacity-40">Restore</button><button type="button" disabled={busy} onClick={() => setDeleteConfirmation([item])} className="min-h-9 rounded-md px-3 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-40">Permanently delete</button></div></li>)}</ul></div><footer className="flex justify-end border-t border-zinc-800 p-4"><button type="button" onClick={onClose} className="min-h-10 rounded-md border border-zinc-700 px-4 text-sm text-zinc-200 hover:bg-zinc-800">Done</button></footer></section></div>{deleteConfirmation && <ConfirmationDialog title="Permanently delete?" message={"Permanently delete "+deleteConfirmation.length+" "+(deleteConfirmation.length === 1 ? "item" : "items")+"? This cannot be undone in RepoQuill."} confirmLabel="Permanently delete" danger busy={busy} onCancel={() => setDeleteConfirmation(undefined)} onConfirm={() => { const pending=deleteConfirmation; setDeleteConfirmation(undefined); void run(pending,'delete') }}/>}</>
}

type NoteDiffLine = { kind: 'same' | 'removed' | 'added'; text: string }

function NoteHistoryDialog({ notePath, currentContent, onRestore, onClose }: { notePath:string; currentContent:string; onRestore:(versionId:string)=>Promise<void>; onClose:()=>void }) {
  const [entries, setEntries] = useState<NoteHistoryEntry[]>()
  const [limited, setLimited] = useState(false)
  const [selected, setSelected] = useState<NoteHistoryVersion>()
  const [loadingVersion, setLoadingVersion] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const controller = new AbortController()
    void apiFetch(`/api/repository/history?path=${encodeURIComponent(notePath)}`, { signal: controller.signal })
      .then(responseJSON<NoteHistoryResult>)
      .then((result) => { setEntries(result.entries); setLimited(result.limited) })
      .catch((caught:unknown) => { if (!controller.signal.aborted) setError(messageFrom(caught)) })
    const closeOnEscape = (event:globalThis.KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => { controller.abort(); window.removeEventListener('keydown', closeOnEscape) }
  }, [notePath, onClose])

  async function loadVersion(entry:NoteHistoryEntry) {
    setLoadingVersion(true)
    setError(undefined)
    try {
      const response = await apiFetch(`/api/repository/history/version?path=${encodeURIComponent(notePath)}&version=${encodeURIComponent(entry.versionId)}`)
      setSelected(await responseJSON<NoteHistoryVersion>(response))
    } catch (caught) {
      setError(messageFrom(caught))
    } finally {
      setLoadingVersion(false)
    }
  }

  async function restoreSelected() {
    if (!selected) return
    setConfirmRestore(false)
    setRestoring(true)
    setError(undefined)
    try {
      await onRestore(selected.versionId)
      onClose()
    } catch (caught) {
      setError(messageFrom(caught))
    } finally {
      setRestoring(false)
    }
  }

  const diff = selected ? readableNoteDiff(selected.content, currentContent) : []
  return <><div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-2 sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section role="dialog" aria-modal="true" aria-labelledby="note-history-title" className="flex max-h-[94vh] w-full max-w-5xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"><header className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3 sm:px-5"><div className="min-w-0"><h2 id="note-history-title" className="text-lg font-semibold">Version history</h2><p className="truncate text-xs text-zinc-500">{notePath}</p></div><button type="button" autoFocus onClick={onClose} aria-label="Close version history" className="min-h-10 min-w-10 rounded text-xl text-zinc-500 hover:bg-zinc-800">×</button></header><div className="grid min-h-0 flex-1 md:grid-cols-[17rem_1fr]"><aside aria-label="Note versions" className="max-h-56 overflow-y-auto border-b border-zinc-800 p-3 md:max-h-none md:border-r md:border-b-0">{entries === undefined && !error && <p className="p-2 text-sm text-zinc-500">Loading versions…</p>}{limited && <p role="status" className="mb-2 rounded border border-amber-800/60 bg-amber-950/25 p-2 text-xs leading-5 text-amber-200">This notebook has a shallow Git history, so older versions may not be available on this server.</p>}{entries?.length === 0 && <p className="p-2 text-sm leading-6 text-zinc-400">No synchronized versions are available for this note yet.</p>}<ul className="space-y-1">{entries?.map((entry) => <li key={entry.versionId}><button type="button" aria-pressed={selected?.versionId === entry.versionId} onClick={() => void loadVersion(entry)} className={`w-full rounded-md px-3 py-2 text-left ${selected?.versionId === entry.versionId ? 'bg-amber-400/15 text-amber-100' : 'text-zinc-300 hover:bg-zinc-800'}`}><span className="block text-xs font-medium">{new Date(entry.timestamp).toLocaleString()}</span><span className="mt-1 block truncate text-[11px] text-zinc-500">{entry.summary}</span>{entry.path !== notePath && <span className="mt-1 block truncate text-[11px] text-zinc-600">Previously: {entry.path}</span>}</button></li>)}</ul></aside><div className="min-h-0 overflow-y-auto p-4 sm:p-5">{error && <ErrorMessage>{error}</ErrorMessage>}{loadingVersion && <p className="text-sm text-zinc-500">Loading this version…</p>}{!selected && !loadingVersion && <div className="flex min-h-48 items-center justify-center text-center text-sm text-zinc-500">Choose a version to view its changes.</div>}{selected && !loadingVersion && <><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-medium text-zinc-200">Changes compared with the current note</h3><p className="mt-1 text-xs text-zinc-500">Removed lines use − and added lines use +. The underlying note remains ordinary Markdown.</p></div><button type="button" disabled={restoring} onClick={() => setConfirmRestore(true)} className="min-h-10 rounded-md bg-amber-500 px-4 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50">{restoring ? 'Restoring…' : 'Restore this version'}</button></div><div role="region" aria-label="Version comparison" className="mt-4 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950"><pre className="min-w-max p-3 font-mono text-xs leading-5">{diff.map((line,index) => <span key={`${index}:${line.kind}`} className={`block whitespace-pre-wrap break-words ${line.kind === 'removed' ? 'bg-red-950/35 text-red-200' : line.kind === 'added' ? 'bg-emerald-950/30 text-emerald-200' : 'text-zinc-500'}`}><span aria-hidden="true" className="mr-2 inline-block w-3 select-none text-zinc-600">{line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ' '}</span>{line.text || ' '}</span>)}</pre></div><details className="mt-4 rounded-md border border-zinc-800 p-3"><summary className="cursor-pointer text-sm text-zinc-300">View this complete Markdown version</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-400">{selected.content}</pre></details></>}</div></div></section></div>{confirmRestore && selected && <ConfirmationDialog title="Restore this version?" message={"Restore the version from "+new Date(selected.timestamp).toLocaleString()+"? Your current saved note will remain available in version history after the next synchronization."} confirmLabel="Restore version" onCancel={() => setConfirmRestore(false)} onConfirm={() => void restoreSelected()}/>}</>
}

function readableNoteDiff(previous:string, current:string):NoteDiffLine[] {
  const before = previous.split('\n')
  const after = current.split('\n')
  if (before.length * after.length > 160_000 || before.length > 800 || after.length > 800) return coarseNoteDiff(before, after)
  const columns = after.length + 1
  const table = new Uint16Array((before.length + 1) * columns)
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      table[left * columns + right] = before[left] === after[right]
        ? table[(left + 1) * columns + right + 1] + 1
        : Math.max(table[(left + 1) * columns + right], table[left * columns + right + 1])
    }
  }
  const result:NoteDiffLine[] = []
  let left = 0
  let right = 0
  while (left < before.length && right < after.length && result.length < 1600) {
    if (before[left] === after[right]) {
      result.push({ kind:'same', text:before[left] }); left += 1; right += 1
    } else if (table[(left + 1) * columns + right] >= table[left * columns + right + 1]) {
      result.push({ kind:'removed', text:before[left] }); left += 1
    } else {
      result.push({ kind:'added', text:after[right] }); right += 1
    }
  }
  while (left < before.length && result.length < 1600) result.push({ kind:'removed', text:before[left++] })
  while (right < after.length && result.length < 1600) result.push({ kind:'added', text:after[right++] })
  if (left < before.length || right < after.length) result.push({ kind:'same', text:'… comparison truncated …' })
  return result
}

function coarseNoteDiff(before:string[], after:string[]):NoteDiffLine[] {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (suffix < before.length-prefix && suffix < after.length-prefix && before[before.length-1-suffix] === after[after.length-1-suffix]) suffix += 1
  const result:NoteDiffLine[] = before.slice(0, Math.min(prefix, 100)).map((text) => ({ kind:'same', text }))
  if (prefix > 100) result.push({ kind:'same', text:'… unchanged lines omitted …' })
  result.push(...before.slice(prefix, before.length-suffix).slice(0, 700).map((text):NoteDiffLine => ({ kind:'removed', text })))
  result.push(...after.slice(prefix, after.length-suffix).slice(0, 700).map((text):NoteDiffLine => ({ kind:'added', text })))
  if (before.length-prefix-suffix > 700 || after.length-prefix-suffix > 700) result.push({ kind:'same', text:'… comparison truncated …' })
  result.push(...before.slice(before.length-Math.min(suffix,100)).map((text):NoteDiffLine => ({ kind:'same', text })))
  return result
}

type SyncPresentation = { label:string; happened:string; safety:string; next:string; attention:boolean }

function synchronizationPresentation(status: GitStatus, syncing: boolean): SyncPresentation {
	if (syncing) return { label: 'Synchronizing…', happened: 'RepoQuill is exchanging saved notebook changes with the connected service.', safety: 'Changes already saved on this server remain safe while this runs.', next: 'No action is needed.', attention: false }
	switch (status.state) {
	case 'clean':
	case 'synced':
		return { label: 'Everything is up to date', happened: 'The server and connected service have the same saved changes.', safety: 'Your synchronized notes are available in both places.', next: 'No action is needed.', attention: false }
	case 'local_changes':
		return { label: 'Changes waiting to synchronize', happened: 'This RepoQuill server contains saved changes that have not reached the connected service yet.', safety: 'The changes are saved on this server.', next: 'Choose Sync now or wait for the next automatic attempt.', attention: false }
	case 'remote_changes':
		return { label: 'New changes available', happened: 'The connected service contains newer notebook changes.', safety: 'RepoQuill has not overwritten your local files.', next: 'Choose Sync now to receive them.', attention: false }
	case 'diverged':
	case 'conflict':
		return { label: 'Your decision is required', happened: 'Two sets of changes overlap and automatic synchronization has paused.', safety: 'RepoQuill has preserved the available versions instead of choosing one silently.', next: 'Review the affected notes before synchronization continues.', attention: true }
	case 'sync_failed':
		return { label: 'Synchronization could not finish', happened: 'RepoQuill could not complete the exchange with the connected service.', safety: 'Notes already saved on this RepoQuill server remain saved here.', next: 'Retry or check the notebook connection.', attention: true }
	default:
		return { label: 'Notebook is currently unavailable', happened: 'RepoQuill cannot inspect the notebook connection right now.', safety: 'No note content was deliberately removed.', next: 'Check the notebook connection and server storage.', attention: true }
	}
}

function ReceivedChangesNotice({ changes, onOpen, onDismiss }: { changes:ReceivedChange[]; onOpen:(path:string)=>void; onDismiss:()=>void }) {
	const counts = changes.reduce<Record<string, number>>((result, change) => ({ ...result, [change.kind]: (result[change.kind] ?? 0) + 1 }), {})
	const summary = (['added', 'updated', 'moved', 'deleted'] as const).filter((kind) => counts[kind]).map((kind) => `${counts[kind]} ${kind}`).join(', ')
	return <section role="status" aria-label="New notebook changes received" className="border-b border-sky-900/60 bg-sky-950/20 px-4 py-2 text-xs text-zinc-200 sm:px-8"><div className="flex items-center justify-between gap-3"><span><strong>New changes were received.</strong> {summary}.</span><button type="button" onClick={onDismiss} aria-label="Dismiss received changes" className="min-h-9 min-w-9 rounded text-zinc-500 hover:bg-zinc-800">×</button></div><ul className="mt-1 flex flex-wrap gap-1.5">{changes.slice(0, 6).map((change) => <li key={`${change.kind}:${change.fromPath ?? ''}:${change.path}`}>{change.kind !== 'deleted' && change.path.toLowerCase().endsWith('.md') ? <button type="button" onClick={() => onOpen(change.path)} title="Open in a note tab" className="min-h-8 rounded border border-zinc-700 px-2 text-zinc-300 hover:bg-zinc-800">{change.kind === 'moved' ? `${change.fromPath} → ${change.path}` : change.path}</button> : <span className="inline-flex min-h-8 items-center rounded border border-zinc-800 px-2 text-zinc-500">{change.kind === 'moved' ? `${change.fromPath} → ${change.path}` : change.path}</span>}</li>)}</ul></section>
}

function SynchronizationDetailsPanel({ saveStatus, gitStatus, syncing, browserOnline, lastSuccessfulSyncAt, lastSyncAttemptAt, lastSyncError, nextScheduledSyncAt, receivedChanges, onSync, onReviewConflicts, conflictLoading, conflictError, onOpenNote, onOpenSettings, onCheckConnection, onClose }: { saveStatus:SaveStatus; gitStatus:GitStatus; syncing:boolean; browserOnline:boolean; lastSuccessfulSyncAt?:string; lastSyncAttemptAt?:string; lastSyncError?:string; nextScheduledSyncAt?:string; receivedChanges:ReceivedChange[]; onSync:()=>void; onReviewConflicts:()=>void; conflictLoading:boolean; conflictError?:string; onOpenNote:(path:string)=>void; onOpenSettings:()=>void; onCheckConnection:()=>void; onClose:()=>void }) {
	const presentation = synchronizationPresentation(gitStatus, syncing)
	const locallySafe = saveStatus === 'saved'
	return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section role="dialog" aria-modal="true" aria-labelledby="sync-details-title" className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"><header className="flex items-center justify-between border-b border-zinc-800 px-5 py-4"><div><h2 id="sync-details-title" className="text-lg font-semibold">Synchronization</h2><p className="mt-1 text-xs text-zinc-500">Notebook save and connection details</p></div><button type="button" onClick={onClose} aria-label="Close synchronization details" className="min-h-10 min-w-10 rounded text-xl text-zinc-500 hover:bg-zinc-800">×</button></header><div className="overflow-y-auto p-5"><div role="status" className={`rounded-lg border p-4 ${presentation.attention ? 'border-amber-800/70 bg-amber-950/20' : 'border-zinc-800 bg-zinc-950/30'}`}><p className="font-medium text-zinc-100">{presentation.label}</p><p className="mt-2 text-sm leading-6 text-zinc-300">{presentation.happened}</p><p className="mt-2 text-sm leading-6 text-zinc-400"><strong className="text-zinc-300">Your notes:</strong> {presentation.safety}</p><p className="mt-2 text-sm leading-6 text-zinc-400"><strong className="text-zinc-300">Next:</strong> {presentation.next}</p></div><dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2"><StatusDetail label="Saved on this server" value={locallySafe ? 'Yes' : saveStatus === 'saving' ? 'Saving…' : saveStatus === 'unsaved' ? 'Not yet' : 'Needs attention'} /><StatusDetail label="RepoQuill server" value={browserOnline ? 'Reachable' : 'Offline or unavailable'} /><StatusDetail label="Connected service" value={gitStatus.state === 'sync_failed' || gitStatus.state === 'invalid' ? 'Connection needs attention' : 'Available'} /><StatusDetail label="Synchronization" value={presentation.label} /><StatusDetail label="Last successful synchronization" value={formatStatusTime(lastSuccessfulSyncAt)} /><StatusDetail label="Next scheduled attempt" value={formatStatusTime(nextScheduledSyncAt, 'Not scheduled')} /></dl>{receivedChanges.length > 0 && <section className="mt-5"><h3 className="text-sm font-medium text-zinc-200">Recently received changes</h3><ul className="mt-2 space-y-1">{receivedChanges.map((change) => <li key={`${change.kind}:${change.fromPath ?? ''}:${change.path}`} className="flex min-h-10 items-center justify-between gap-2 rounded border border-zinc-800 px-3 text-xs"><span className="min-w-0 truncate text-zinc-400"><span className="mr-2 capitalize text-zinc-300">{change.kind}</span>{change.kind === 'moved' ? `${change.fromPath} → ${change.path}` : change.path}</span>{change.kind !== 'deleted' && change.path.toLowerCase().endsWith('.md') && <button type="button" onClick={() => onOpenNote(change.path)} className="shrink-0 rounded px-2 py-1.5 text-amber-300 hover:bg-zinc-800">Open in tab</button>}</li>)}</ul></section>}{(gitStatus.state === 'conflict' || gitStatus.state === 'diverged') && <section className="mt-5 rounded border border-amber-800/60 p-3"><h3 className="text-sm font-medium text-amber-200">Changes need your review</h3><p className="mt-1 text-xs leading-5 text-zinc-400">Automatic synchronization stays paused. RepoQuill has not silently selected either version.</p>{gitStatus.conflictFiles?.length ? <ul className="mt-2 space-y-1 text-xs text-zinc-300">{gitStatus.conflictFiles.map((path) => <li key={path} className="rounded border border-zinc-800 px-3 py-2"><span className="min-w-0 truncate">{path}</span></li>)}</ul> : null}<button type="button" disabled={conflictLoading} onClick={onReviewConflicts} className="mt-3 min-h-10 rounded-md bg-amber-500 px-4 text-sm font-medium text-zinc-950 disabled:opacity-40">{conflictLoading ? 'Loading preserved versions…' : 'Review affected items'}</button>{conflictError && <p role="alert" className="mt-2 text-xs text-red-300">{conflictError}</p>}</section>}<div className="mt-5 flex flex-wrap gap-2"><button type="button" disabled={syncing || !browserOnline || saveStatus === 'saving' || saveStatus === 'error' || saveStatus === 'conflict' || gitStatus.state === 'conflict' || gitStatus.state === 'diverged'} onClick={onSync} className="min-h-10 rounded-md bg-amber-500 px-4 text-sm font-medium text-zinc-950 disabled:opacity-40">{syncing ? 'Synchronizing…' : gitStatus.state === 'sync_failed' ? 'Retry synchronization' : 'Sync now'}</button>{(gitStatus.state === 'sync_failed' || gitStatus.state === 'invalid') && <button type="button" onClick={onCheckConnection} className="min-h-10 rounded-md border border-zinc-700 px-4 text-sm text-zinc-200 hover:bg-zinc-800">Check connection</button>}<button type="button" onClick={onOpenSettings} className="min-h-10 rounded-md border border-zinc-700 px-4 text-sm text-zinc-300 hover:bg-zinc-800">Open notebook settings</button></div><details className="mt-5 rounded border border-zinc-800 p-3 text-xs text-zinc-500"><summary className="cursor-pointer text-zinc-400">Technical details</summary><dl className="mt-3 grid gap-2"><StatusDetail label="Branch" value={gitStatus.branch || 'Unavailable'} /><StatusDetail label="Local commits ahead" value={String(gitStatus.ahead ?? 0)} /><StatusDetail label="Remote commits behind" value={String(gitStatus.behind ?? 0)} /><StatusDetail label="Last attempt" value={formatStatusTime(lastSyncAttemptAt)} />{(lastSyncError || gitStatus.message) && <StatusDetail label="Sanitized diagnostic" value={lastSyncError || gitStatus.message || ''} />}</dl></details></div></section></div>
}

function ConflictResolutionDialog({ overview, busy, error, notePaths, onPostpone, onApply }: { overview:ConflictOverview; busy:boolean; error?:string; notePaths:string[]; onPostpone:()=>void; onApply:(decisions:ConflictDecision[])=>void }) {
	const [activePath,setActivePath] = useState(overview.items[0]?.path ?? '')
	const [decisions,setDecisions] = useState<Record<string,ConflictDecision>>(() => {
		try {
			const saved = JSON.parse(readConflictDecisionDraft(sessionStorage, overview.token) ?? '{}') as Record<string,ConflictDecision>
			if (saved && typeof saved === 'object') return saved
		} catch { /* begin with conservative defaults */ }
		const defaults:Record<string,ConflictDecision> = {}
		for (const item of overview.items) {
			if (item.kind === 'modify_delete') defaults[item.path] = { path:item.path,action:item.yourExists ? 'keep_note' : item.otherExists ? 'use_other' : 'confirm_deletion' }
		}
		return defaults
	})
	useEffect(() => { writeConflictDecisionDraft(sessionStorage,overview.token,JSON.stringify(decisions)) },[decisions,overview.token])
	const item = overview.items.find((candidate) => candidate.path === activePath) ?? overview.items[0]
	const decision = item ? decisions[item.path] : undefined
	const complete = overview.items.length > 0 && overview.items.every((candidate) => Boolean(decisions[candidate.path]))
	function choose(action:string, content?:string) {
		if (!item) return
		setDecisions((current) => ({ ...current,[item.path]:{ path:item.path,action,...(content !== undefined ? { content } : {}) } }))
	}
	return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-2 sm:p-4"><section role="dialog" aria-modal="true" aria-labelledby="conflict-title" className="flex h-[95vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"><header className="border-b border-zinc-800 px-4 py-3 sm:px-5"><h2 id="conflict-title" className="text-lg font-semibold text-zinc-100">Choose the resulting content</h2><p className="mt-1 text-sm text-zinc-400">Two versions overlap. RepoQuill preserved both and paused synchronization. Review every affected item before anything is changed.</p></header><div className="grid min-h-0 flex-1 md:grid-cols-[16rem_1fr]"><nav aria-label="Affected notebook items" className="max-h-48 overflow-y-auto border-b border-zinc-800 p-2 md:max-h-none md:border-b-0 md:border-r"><p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Affected items ({overview.items.length})</p>{overview.items.map((candidate) => <button key={candidate.path} type="button" onClick={()=>setActivePath(candidate.path)} className={`mt-1 flex min-h-11 w-full items-center justify-between gap-2 rounded px-2 text-left text-sm ${candidate.path===item?.path?'bg-amber-400/15 text-amber-100':'text-zinc-300 hover:bg-zinc-800'}`}><span className="min-w-0 truncate">{candidate.path}</span><span aria-label={decisions[candidate.path]?'Decision selected':'Decision required'}>{decisions[candidate.path]?'✓':'!'}</span></button>)}</nav>{item && <main className="min-h-0 overflow-y-auto p-3 sm:p-5"><h3 className="break-all font-medium text-zinc-100">{item.path}</h3>{item.kind === 'markdown' && <><div className="mt-4 grid gap-3 lg:grid-cols-2"><VersionCard title="Your version" exists={item.yourExists} content={item.yourContent} /><VersionCard title="Other version" exists={item.otherExists} content={item.otherContent} /></div><details className="mt-3 rounded border border-zinc-800 p-3"><summary className="cursor-pointer text-sm text-zinc-300">Readable text comparison</summary><div className="mt-3 max-h-72 overflow-auto rounded bg-zinc-950 p-3 font-mono text-xs">{readableNoteDiff(item.otherContent ?? '',item.yourContent ?? '').map((line,index)=><div key={index} className={line.kind==='added'?'bg-emerald-950/40 text-emerald-200':line.kind==='removed'?'bg-red-950/40 text-red-200':'text-zinc-500'}><span aria-hidden="true" className="mr-2">{line.kind==='added'?'+':line.kind==='removed'?'−':' '}</span>{line.text || ' '}</div>)}</div></details><div className="mt-4 flex flex-wrap gap-2">{item.yourExists && <DecisionButton selected={decision?.action==='use_yours'} onClick={()=>choose('use_yours')}>Use your version</DecisionButton>}{item.otherExists && <DecisionButton selected={decision?.action==='use_other'} onClick={()=>choose('use_other')}>Use other version</DecisionButton>}{item.yourExists && item.otherExists && <DecisionButton selected={decision?.action==='edit_combined'} onClick={()=>choose('edit_combined',decision?.content ?? item.yourContent ?? '')}>Edit combined version</DecisionButton>}</div>{decision?.action==='edit_combined' && <div className="mt-4 rounded-lg border border-amber-800/50 p-3"><p className="mb-3 text-sm text-zinc-300">Combined result — this is the content that will be saved.</p><Suspense fallback={<p className="text-sm text-zinc-500">Loading editor…</p>}><MarkdownEditor documentKey={`conflict:${overview.token}:${item.path}`} notePath={item.path} markdown={decision.content ?? ''} readOnly={false} notePaths={notePaths} onChange={(content)=>choose('edit_combined',content)} /></Suspense></div>}</>}{item.kind === 'modify_delete' && <><p className="mt-4 rounded border border-amber-900/60 bg-amber-950/20 p-3 text-sm leading-6 text-zinc-300">{item.yourExists||item.otherExists?'One side kept this item while the other removed it. Keeping the available note or file is the safe default.':'This is an earlier path from an overlapping rename. The renamed copies remain listed separately; removing this obsolete path does not delete either renamed copy.'}</p><div className="mt-4 flex flex-wrap gap-2">{(item.yourExists||item.otherExists)&&<DecisionButton selected={decision?.action==='keep_note'||decision?.action==='use_other'} onClick={()=>choose(item.yourExists?'keep_note':'use_other')}>Keep {item.path.toLowerCase().endsWith('.md')?'note':'file'}</DecisionButton>}<DecisionButton danger selected={decision?.action==='confirm_deletion'} onClick={()=>choose('confirm_deletion')}>Confirm deletion</DecisionButton></div></>}{item.kind === 'image' && <><div className="mt-4 grid gap-3 sm:grid-cols-2"><ImageVersion title="Your image" path={item.path} side="yours" /><ImageVersion title="Other image" path={item.path} side="other" /></div><div className="mt-4 flex flex-wrap gap-2"><DecisionButton selected={decision?.action==='use_yours'} onClick={()=>choose('use_yours')}>Use your image</DecisionButton><DecisionButton selected={decision?.action==='use_other'} onClick={()=>choose('use_other')}>Use other image</DecisionButton><DecisionButton selected={decision?.action==='keep_both'} onClick={()=>choose('keep_both')}>Keep both</DecisionButton></div></>}{item.kind === 'binary' && <><p className="mt-4 text-sm text-zinc-400">This file cannot be compared as text. Choose which complete file should remain.</p><div className="mt-4 flex gap-2"><DecisionButton selected={decision?.action==='use_yours'} onClick={()=>choose('use_yours')}>Use your file</DecisionButton><DecisionButton selected={decision?.action==='use_other'} onClick={()=>choose('use_other')}>Use other file</DecisionButton></div></>}</main>}</div><footer className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 p-3 sm:px-5"><div>{error && <p role="alert" className="text-sm text-red-300">{error}</p>}<p className="text-xs text-zinc-500">You can postpone safely; Git keeps both source versions.</p></div><div className="flex gap-2"><button type="button" disabled={busy} onClick={onPostpone} className="min-h-10 rounded border border-zinc-700 px-4 text-sm text-zinc-300 hover:bg-zinc-800">Postpone</button><button type="button" disabled={busy||!complete} onClick={()=>onApply(overview.items.map((candidate)=>decisions[candidate.path]))} className="min-h-10 rounded bg-amber-500 px-4 text-sm font-medium text-zinc-950 disabled:opacity-40">{busy?'Revalidating and applying…':'Review complete — apply'}</button></div></footer></section></div>
}

function VersionCard({ title,exists,content }: { title:string; exists:boolean; content?:string }) { return <section className="rounded border border-zinc-800 bg-zinc-950/50 p-3"><h4 className="text-sm font-medium text-zinc-200">{title}</h4>{exists?<pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-zinc-400">{content}</pre>:<p className="mt-2 text-xs text-zinc-500">This version removed the note.</p>}</section> }
function ImageVersion({ title,path,side }: { title:string; path:string; side:'yours'|'other' }) { return <section className="rounded border border-zinc-800 bg-zinc-950/50 p-3"><h4 className="text-sm font-medium text-zinc-200">{title}</h4><img src={`/api/repository/git/conflict-version?path=${encodeURIComponent(path)}&side=${side}`} alt={`${title} for ${path}`} className="mt-3 max-h-80 w-full object-contain" /></section> }
function DecisionButton({ children,selected,danger=false,onClick }: { children:ReactNode; selected:boolean; danger?:boolean; onClick:()=>void }) { return <button type="button" aria-pressed={selected} onClick={onClick} className={`min-h-11 rounded border px-4 text-sm ${selected?'border-amber-500 bg-amber-400/15 text-amber-100':danger?'border-red-900 text-red-300 hover:bg-red-950/40':'border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}>{children}</button> }

function StatusDetail({ label, value }: { label:string; value:string }) { return <div className="rounded border border-zinc-800 p-3"><dt className="text-[11px] uppercase tracking-wide text-zinc-600">{label}</dt><dd className="mt-1 break-words text-xs text-zinc-300">{value}</dd></div> }
function formatStatusTime(value?:string, fallback='Not yet'):string { if (!value) return fallback; const date=new Date(value); return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString() }

export function DocumentStatusBar({ status, gitStatus, gitSyncing, markdown, onOpenSyncDetails = () => undefined }: { status: SaveStatus; gitStatus: GitStatus; gitSyncing: boolean; markdown: string; onOpenSyncDetails?:()=>void }) {
  const labels: Record<SaveStatus, string> = { saved: 'Saved on this server', unsaved: 'Changes not saved yet', saving: 'Saving on this server…', error: 'Save could not finish', conflict: 'Your decision is required' }
  const colors: Record<SaveStatus, string> = { saved: 'text-emerald-400', unsaved: 'text-amber-300', saving: 'text-zinc-400', error: 'text-red-400', conflict: 'text-red-400' }
	const synchronization = synchronizationPresentation(gitStatus, gitSyncing)
  const stats = documentStats(markdown)
  return <footer aria-label="Document status" className="sticky bottom-0 z-10 flex h-7 shrink-0 items-center gap-2.5 border-t border-zinc-800 bg-zinc-950/90 px-5 text-[11px] leading-none text-zinc-500 backdrop-blur sm:px-8"><span role="status" className={`truncate font-medium ${colors[status]}`}>{labels[status]}</span><span aria-hidden="true" className="text-zinc-700">•</span><button type="button" onClick={onOpenSyncDetails} aria-label={`Synchronization: ${synchronization.label}. Open details`} title={`${synchronization.happened} ${synchronization.safety}`} className={`truncate rounded px-1 py-1 font-medium hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-amber-500 ${synchronization.attention ? 'text-red-400' : gitStatus.state === 'synced' || gitStatus.state === 'clean' ? 'text-emerald-400' : 'text-zinc-400'}`}>{synchronization.label}</button><span aria-hidden="true" className="hidden text-zinc-700 sm:inline">•</span><span className="hidden sm:inline" aria-label={`${stats.words} words`}>{stats.words} words</span><span className="hidden md:inline" aria-label={`${stats.characters} characters`}>{stats.characters} characters</span><span className="hidden md:inline" aria-label={`${stats.lines} lines`}>{stats.lines} lines</span></footer>
}

function StatusDot({ health }: { health: Health }) {
  const label = health === 'online' ? 'Backend connected' : health === 'offline' ? 'Backend unavailable' : 'Checking backend'
  const color = health === 'online' ? 'bg-emerald-400' : health === 'offline' ? 'bg-red-400' : 'bg-amber-400'
  return <span className={`h-2.5 w-2.5 rounded-full ${color}`} role="status" aria-label={label} title={label} />
}

function SidebarMessage({ children }: { children: ReactNode }) { return <p className="px-2 py-3 text-sm text-zinc-500">{children}</p> }
function ErrorMessage({ children }: { children: ReactNode }) { return <p className="mb-5 rounded-lg border border-red-900/70 bg-red-950/30 p-4 text-sm text-red-200">{children}</p> }
function EmptyState({ notebookConfigured, onAddNotebook }: { notebookConfigured: boolean; onAddNotebook: () => void }) { return <div className="flex min-h-80 flex-col items-center justify-center text-center"><div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-2xl" aria-hidden="true">◇</div><h2 className="mt-5 text-xl font-semibold">{notebookConfigured ? 'Your Markdown stays yours' : 'Connect your first notebook'}</h2><p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">{notebookConfigured ? 'Choose a note from the notebook tree to edit it with Milkdown. Changes are autosaved after a short pause.' : 'RepoQuill works with ordinary Git repositories. Add one to browse and edit its portable Markdown notes.'}</p>{!notebookConfigured && <button type="button" onClick={onAddNotebook} className="mt-5 min-h-11 rounded-md bg-amber-500 px-4 text-sm font-semibold text-zinc-950 hover:bg-amber-400">Add Notebook</button>}</div> }
