// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App, DocumentStatusBar, ReceivedChangesNotice } from './App'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', ResizeObserverStub)
vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))

beforeEach(() => {
  localStorage.clear()
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

// Milkdown removes its global listeners 3 seconds after editor setup.
afterAll(async () => new Promise((resolve) => setTimeout(resolve, 3_100)))

describe('Git synchronization UI', () => {
  it('keeps local save and Git synchronization states distinct', () => {
    const view = render(<DocumentStatusBar status="saved" gitStatus={{ state: 'sync_failed', message: 'Remote unavailable' }} gitSyncing={false} stats={{ words: 2, characters: 11, lines: 1 }} />)
    expect(view.getByText('Saved on this server')).toBeTruthy()
    const synchronization = view.getByLabelText('Synchronization: Synchronization could not finish. Open details')
    expect(synchronization).toBeTruthy()
    expect(synchronization.getAttribute('title')).toContain('saved on this RepoQuill server')
  })

  it('normalizes legacy disabled safety triggers and reports automatic sync success', async () => {
    localStorage.setItem('repoquill.sync-preferences', JSON.stringify({ scheduledMinutes: 0, inactivityMinutes: 0, syncOnNotebookSwitch: false, syncOnClose: false, syncOnStartup: false, syncOnFocus: false, syncBeforeOpeningNote: false }))
    let synchronized = false
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ status: 'ok' })
      if (url === '/api/notebook') return Response.json({ name: 'Private', configured: true })
      if (url === '/api/repository/tree') return Response.json({ entries: [{ name: 'Note.md', path: 'Note.md', type: 'file' }] })
      if (url === '/api/repository/git/status') return Response.json(synchronized ? { state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString() } : { state: 'local_changes', branch: 'main' })
      if (url.startsWith('/api/repository/file?')) return Response.json({ path: 'Note.md', content: 'Saved note', version: 'v1' })
      if (url === '/api/repository/git/sync' && init?.method === 'POST') { synchronized = true; return Response.json({ state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString() }) }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })
    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'Note' }))
    await waitFor(() => expect(view.getByLabelText('Synchronization: Everything is up to date. Open details')).toBeTruthy())
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/repository/git/sync' && init?.method === 'POST')).toBe(true)
  })

  it('keeps conflicts visible as a critical textual state', () => {
    const view = render(<DocumentStatusBar status="saved" gitStatus={{ state: 'conflict', conflictFiles: ['Note.md'] }} gitSyncing={false} stats={{ words: 1, characters: 4, lines: 1 }} />)
    const synchronization = view.getByLabelText('Synchronization: Your decision is required. Open details')
    expect(synchronization).toBeTruthy()
    expect(synchronization.getAttribute('title')).toContain('preserved')
  })

  it('opens notes without waiting for an active background Git sync', async () => {
    localStorage.setItem('repoquill.sync-preferences', JSON.stringify({ scheduledMinutes: 0, inactivityMinutes: 0, syncOnNotebookSwitch: false, syncOnClose: false, syncOnStartup: false, syncOnFocus: false, syncBeforeOpeningNote: true }))
    let finishSync!: (response: Response) => void
    const delayedSync = new Promise<Response>((resolve) => { finishSync = resolve })
    let synchronized = false
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ status: 'ok' })
      if (url === '/api/notebook') return Response.json({ name: 'Private', configured: true })
      if (url === '/api/notebooks') return Response.json({ activeId: 'private', notebooks: [{ id: 'private', name: 'Private' }] })
      if (url === '/api/repository/tree') return Response.json({ entries: [{ name: 'First.md', path: 'First.md', type: 'file' }, { name: 'Second.md', path: 'Second.md', type: 'file' }] })
      if (url === '/api/repository/git/status') return Response.json(synchronized ? { state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString() } : { state: 'local_changes', branch: 'main' })
      if (url === '/api/repository/git/sync' && init?.method === 'POST') return delayedSync.then((response) => { synchronized = true; return response })
      if (url.includes('First.md')) return Response.json({ path: 'First.md', content: '# First note', version: 'v1' })
      if (url.includes('Second.md')) return Response.json({ path: 'Second.md', content: '# Second note', version: 'v2' })
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })
    const view = render(<App />)

    fireEvent.click(await view.findByRole('button', { name: 'First' }))
    await waitFor(() => expect(view.container.textContent).toContain('First note'), { timeout: 5000 })
    await waitFor(() => expect(view.getByLabelText('2 words')).toBeTruthy())
    expect(view.getByLabelText('10 characters')).toBeTruthy()
    expect(view.getByLabelText('1 lines')).toBeTruthy()
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/repository/git/sync')).toBe(true))

    fireEvent.click(view.getByRole('button', { name: 'Second' }))
    await waitFor(() => expect(view.container.textContent).toContain('Second note'), { timeout: 5000 })
    expect(view.getAllByText('Syncing…').length).toBeGreaterThan(0)

    finishSync(Response.json({ state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString() }))
    await waitFor(() => expect(view.getByLabelText('Synchronization: Everything is up to date. Open details')).toBeTruthy())
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/repository/git/sync')).toHaveLength(1)
  })

  it('opens human-readable synchronization details from the status bar', async () => {
    localStorage.setItem('repoquill.sync-preferences', JSON.stringify({ scheduledMinutes: 0, inactivityMinutes: 0, syncOnNotebookSwitch: false, syncOnClose: false, syncOnStartup: false, syncOnFocus: false, syncBeforeOpeningNote: false }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ status: 'ok' })
      if (url === '/api/notebook') return Response.json({ name: 'Private', configured: true })
      if (url === '/api/notebooks') return Response.json({ activeId: 'private', notebooks: [{ id: 'private', name: 'Private' }] })
      if (url === '/api/repository/tree') return Response.json({ entries: [{ name: 'Note.md', path: 'Note.md', type: 'file' }] })
      if (url === '/api/repository/git/status') return Response.json({ state: 'sync_failed', branch: 'main', message: 'Connection unavailable' })
      if (url.startsWith('/api/repository/file?')) return Response.json({ path: 'Note.md', content: 'Saved note', version: 'v1' })
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })
    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'Note' }))
    fireEvent.click(await view.findByLabelText('Synchronization: Synchronization could not finish. Open details'))

    expect(view.getByRole('dialog', { name: 'Synchronization' })).toBeTruthy()
    expect(view.getByText('Notes already saved on this RepoQuill server remain saved here.')).toBeTruthy()
    expect(view.getByRole('button', { name: 'Retry synchronization' })).toBeTruthy()
    expect(view.getByText('Technical details')).toBeTruthy()
  })

  it('refreshes the active note after an external update and uses its new save version', async () => {
    localStorage.setItem('repoquill.sync-preferences', JSON.stringify({ scheduledMinutes: 0, inactivityMinutes: 0, syncOnNotebookSwitch: false, syncOnClose: false, syncOnStartup: false, syncOnFocus: false, syncBeforeOpeningNote: false }))
    let syncCount = 0
    let content = 'Current note'
    let version = 'v1'
    let lastSaveVersion = ''
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ status: 'ok' })
      if (url === '/api/notebook') return Response.json({ name: 'Private', configured: true })
      if (url === '/api/notebooks') return Response.json({ activeId: 'private', notebooks: [{ id: 'private', name: 'Private' }] })
      if (url === '/api/repository/tree') return Response.json({ entries: [{ name: 'Current.md', path: 'Current.md', type: 'file' }] })
      if (url === '/api/repository/git/status') return Response.json({ state: syncCount > 0 ? 'synced' : 'remote_changes', branch: 'main', lastSyncedAt: syncCount > 0 ? new Date().toISOString() : undefined })
      if (url.startsWith('/api/repository/file?') && init?.method === 'PUT') {
        lastSaveVersion = String((JSON.parse(String(init.body)) as { version: string }).version)
        content = (JSON.parse(String(init.body)) as { content: string }).content
        version = 'v3'
        return Response.json({ path: 'Current.md', content, version })
      }
      if (url.startsWith('/api/repository/file?')) return Response.json({ path: 'Current.md', content, version })
      if (url === '/api/repository/git/sync' && init?.method === 'POST') {
        syncCount += 1
        if (syncCount === 1) return Response.json({ state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString() })
        content = 'Externally updated note'
        version = 'v2'
        return Response.json({ state: 'synced', branch: 'main', receivedChanges: [{ kind: 'updated', path: 'Current.md' }, { kind: 'added', path: 'External.md' }] })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })
    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'Current' }))
    await waitFor(() => expect(view.container.textContent).toContain('Current note'))
    fireEvent.click(await view.findByRole('button', { name: 'Sync' }))

    expect(await view.findByRole('status', { name: 'New notebook changes received' })).toBeTruthy()
    expect(await view.findByText('Externally updated note')).toBeTruthy()
    expect(view.queryByText('Current note')).toBeNull()
    expect(view.getByRole('button', { name: 'External.md' })).toBeTruthy()

    const editor = view.container.querySelector<HTMLElement>('.ProseMirror')
    expect(editor).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Insert table' }))
    fireEvent.click(view.getByRole('gridcell', { name: 'Insert 2 columns by 2 rows' }))
    await waitFor(() => expect(view.getByText('Changes not saved yet')).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(lastSaveVersion).toBe('v2'))
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).startsWith('/api/repository/file?') && init?.method === 'PUT')).toBe(true)

    fireEvent.click(view.getByRole('button', { name: 'Dismiss received changes' }))
    expect(view.queryByRole('status', { name: 'New notebook changes received' })).toBeNull()
    fireEvent.click(view.getByLabelText('Synchronization: Everything is up to date. Open details'))
    expect(view.getByRole('dialog', { name: 'Synchronization' })).toBeTruthy()
    expect(view.getByText('Recently received changes')).toBeTruthy()
    expect(view.getAllByRole('button', { name: 'Open in tab' })).toHaveLength(2)
  })

  it('refreshes a note opened while the startup synchronization is already running', async () => {
    localStorage.setItem('repoquill.sync-preferences', JSON.stringify({ scheduledMinutes: 0, inactivityMinutes: 0 }))
    let content = 'Current note'
    let version = 'v1'
    let finishSync!: (response: Response) => void
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ status: 'ok' })
      if (url === '/api/notebook') return Response.json({ name: 'Private', configured: true })
      if (url === '/api/notebooks') return Response.json({ activeId: 'private', notebooks: [{ id: 'private', name: 'Private' }] })
      if (url === '/api/repository/tree') return Response.json({ entries: [{ name: 'Current.md', path: 'Current.md', type: 'file' }] })
      if (url === '/api/repository/git/status') return Response.json({ state: 'remote_changes', branch: 'main' })
      if (url.startsWith('/api/repository/file?')) return Response.json({ path: 'Current.md', content, version })
      if (url === '/api/repository/git/sync' && init?.method === 'POST') {
        return new Promise<Response>((resolve) => { finishSync = (response) => { content = 'Updated during startup'; version = 'v2'; resolve(response) } })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })

    const view = render(<App />)
    await waitFor(() => expect(finishSync).toBeTypeOf('function'))
    fireEvent.click(await view.findByRole('button', { name: 'Current' }))
    await waitFor(() => expect(view.getByText('Current note')).toBeTruthy())
    finishSync(Response.json({ state: 'synced', branch: 'main', receivedChanges: [{ kind: 'updated', path: 'Current.md' }] }))

    expect(await view.findByText('Updated during startup')).toBeTruthy()
  })

  it('refreshes the note after the safe note-switch sync trigger', async () => {
    localStorage.setItem('repoquill.sync-preferences', JSON.stringify({ scheduledMinutes: 0, inactivityMinutes: 0 }))
    let syncCount = 0
    let content = 'Other note'
    let version = 'v1'
    let finishStartupSync!: (response: Response) => void
    const staleSyncTime = new Date(Date.now() - 60_000).toISOString()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ status: 'ok' })
      if (url === '/api/notebook') return Response.json({ name: 'Private', configured: true })
      if (url === '/api/notebooks') return Response.json({ activeId: 'private', notebooks: [{ id: 'private', name: 'Private' }] })
      if (url === '/api/repository/tree') return Response.json({ entries: [{ name: 'Current.md', path: 'Current.md', type: 'file' }, { name: 'Other.md', path: 'Other.md', type: 'file' }] })
      if (url === '/api/repository/git/status') return Response.json({ state: 'synced', branch: 'main', lastSyncedAt: syncCount === 1 ? staleSyncTime : new Date().toISOString() })
      if (url.startsWith('/api/repository/file?')) {
        const path = new URL(url, 'http://repoquill.test').searchParams.get('path')
        return Response.json({ path, content: path === 'Other.md' ? content : 'Current note', version: path === 'Other.md' ? version : 'v1' })
      }
      if (url === '/api/repository/git/sync' && init?.method === 'POST') {
        syncCount += 1
        if (syncCount === 1) return new Promise<Response>((resolve) => { finishStartupSync = resolve })
        content = 'Updated on safe note switch'
        version = 'v2'
        return Response.json({ state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString(), receivedChanges: [{ kind: 'updated', path: 'Other.md' }] })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })

    const view = render(<App />)
    await waitFor(() => expect(finishStartupSync).toBeTypeOf('function'))
    fireEvent.click(await view.findByRole('button', { name: 'Current' }))
    await waitFor(() => expect(view.getByText('Current note')).toBeTruthy())
    finishStartupSync(Response.json({ state: 'synced', branch: 'main', lastSyncedAt: staleSyncTime }))
    await view.findByRole('button', { name: 'Sync' })
    fireEvent.click(await view.findByRole('button', { name: 'Other' }))

    expect(await view.findByText('Updated on safe note switch')).toBeTruthy()
    expect(syncCount).toBe(2)
  })

  it('refreshes external updates in Read only mode without enabling editing', async () => {
    localStorage.setItem('repoquill.sync-preferences', JSON.stringify({ scheduledMinutes: 0, inactivityMinutes: 0 }))
    let syncCount = 0
    let content = 'Current note'
    let version = 'v1'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ status: 'ok' })
      if (url === '/api/notebook') return Response.json({ name: 'Private', configured: true })
      if (url === '/api/notebooks') return Response.json({ activeId: 'private', notebooks: [{ id: 'private', name: 'Private' }] })
      if (url === '/api/repository/tree') return Response.json({ entries: [{ name: 'Current.md', path: 'Current.md', type: 'file' }] })
      if (url === '/api/repository/git/status') return Response.json({ state: syncCount > 0 ? 'synced' : 'remote_changes', branch: 'main', lastSyncedAt: new Date().toISOString() })
      if (url.startsWith('/api/repository/file?')) return Response.json({ path: 'Current.md', content, version })
      if (url === '/api/repository/git/sync' && init?.method === 'POST') {
        syncCount += 1
        if (syncCount === 1) return Response.json({ state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString() })
        content = 'Updated read-only note'
        version = 'v2'
        return Response.json({ state: 'synced', branch: 'main', receivedChanges: [{ kind: 'updated', path: 'Current.md' }] })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })

    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'Current' }))
    await waitFor(() => expect(view.getByText('Current note')).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: '✎ Edit' }))
    await waitFor(() => expect(view.container.querySelector('.ProseMirror')?.getAttribute('contenteditable')).toBe('false'))
    fireEvent.click(await view.findByRole('button', { name: 'Sync' }))

    expect(await view.findByText('Updated read-only note')).toBeTruthy()
    expect(view.container.querySelector('.ProseMirror')?.getAttribute('contenteditable')).toBe('false')
  })

  it('keeps editor changes made while synchronization is pending instead of applying a remote refresh', async () => {
    localStorage.setItem('repoquill.sync-preferences', JSON.stringify({ scheduledMinutes: 0, inactivityMinutes: 0 }))
    let finishSync!: (response: Response) => void
    let fileReads = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ status: 'ok' })
      if (url === '/api/notebook') return Response.json({ name: 'Private', configured: true })
      if (url === '/api/notebooks') return Response.json({ activeId: 'private', notebooks: [{ id: 'private', name: 'Private' }] })
      if (url === '/api/repository/tree') return Response.json({ entries: [{ name: 'Current.md', path: 'Current.md', type: 'file' }] })
      if (url === '/api/repository/git/status') return Response.json({ state: 'local_changes', branch: 'main' })
      if (url.startsWith('/api/repository/file?') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { content: string }
        return Response.json({ path: 'Current.md', content: body.content, version: 'v2' })
      }
      if (url.startsWith('/api/repository/file?')) {
        fileReads += 1
        return Response.json({ path: 'Current.md', content: 'Current note', version: 'v1' })
      }
      if (url === '/api/repository/git/sync' && init?.method === 'POST') {
        return new Promise<Response>((resolve) => { finishSync = resolve })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })

    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'Current' }))
    await waitFor(() => expect(view.getByText('Current note')).toBeTruthy())
    await waitFor(() => expect(finishSync).toBeTypeOf('function'))
    const editor = view.container.querySelector<HTMLElement>('.ProseMirror')!
    fireEvent.click(view.getByRole('button', { name: 'Insert table' }))
    fireEvent.click(view.getByRole('gridcell', { name: 'Insert 2 columns by 2 rows' }))
    await waitFor(() => expect(view.getByText('Changes not saved yet')).toBeTruthy())
    expect(editor.querySelector('table')).toBeTruthy()

    finishSync(Response.json({ state: 'synced', branch: 'main', receivedChanges: [{ kind: 'updated', path: 'Current.md' }] }))
    await view.findByRole('status', { name: 'New notebook changes received' })
    await waitFor(() => expect(view.container.querySelector('.ProseMirror table')).toBeTruthy())
    expect(view.container.textContent).not.toContain('Remote replacement')
    expect(fileReads).toBe(1)
  })

  it('ignores a delayed active-note reload after the user selects another note', async () => {
    localStorage.setItem('repoquill.sync-preferences', JSON.stringify({ scheduledMinutes: 0, inactivityMinutes: 0 }))
    let syncCount = 0
    let remoteUpdate = false
    let releaseFirstReload!: (response: Response) => void
    let firstReloadStarted!: () => void
    const firstReload = new Promise<void>((resolve) => { firstReloadStarted = resolve })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ status: 'ok' })
      if (url === '/api/notebook') return Response.json({ name: 'Private', configured: true })
      if (url === '/api/notebooks') return Response.json({ activeId: 'private', notebooks: [{ id: 'private', name: 'Private' }] })
      if (url === '/api/repository/tree') return Response.json({ entries: [{ name: 'First.md', path: 'First.md', type: 'file' }, { name: 'Second.md', path: 'Second.md', type: 'file' }] })
      if (url === '/api/repository/git/status') return Response.json({ state: syncCount > 0 ? 'synced' : 'remote_changes', branch: 'main', lastSyncedAt: new Date().toISOString() })
      if (url.startsWith('/api/repository/file?')) {
        const path = new URL(url, 'http://repoquill.test').searchParams.get('path')
        if (path === 'First.md' && remoteUpdate) {
          firstReloadStarted()
          return new Promise<Response>((resolve) => { releaseFirstReload = resolve })
        }
        return Response.json({ path, content: path === 'Second.md' ? 'Second note' : 'First note', version: 'v1' })
      }
      if (url === '/api/repository/git/sync' && init?.method === 'POST') {
        syncCount += 1
        remoteUpdate = syncCount > 1
        return Response.json({ state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString(), receivedChanges: remoteUpdate ? [{ kind: 'updated', path: 'First.md' }] : [] })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })

    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'First' }))
    await waitFor(() => expect(view.getByText('First note')).toBeTruthy())
    fireEvent.click(await view.findByRole('button', { name: 'Sync' }))
    await firstReload
    fireEvent.click(view.getByRole('button', { name: 'Second' }))
    await waitFor(() => expect(view.getByText('Second note')).toBeTruthy())
    releaseFirstReload(Response.json({ path: 'First.md', content: 'Stale First note', version: 'v2' }))

    await waitFor(() => expect(view.container.querySelector('.ProseMirror')?.textContent).toContain('Second note'))
    expect(view.container.textContent).not.toContain('Stale First note')
    expect(view.getByText('Second.md')).toBeTruthy()
  })

  it('follows an external move into the open tab and selected note path', async () => {
    localStorage.setItem('repoquill.sync-preferences', JSON.stringify({ scheduledMinutes: 0, inactivityMinutes: 0 }))
    let syncCount = 0
    let renamedReads = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ status: 'ok' })
      if (url === '/api/notebook') return Response.json({ name: 'Private', configured: true })
      if (url === '/api/notebooks') return Response.json({ activeId: 'private', notebooks: [{ id: 'private', name: 'Private' }] })
      if (url === '/api/repository/tree') return Response.json({ entries: syncCount > 1 ? [{ name: 'Renamed.md', path: 'Renamed.md', type: 'file' }] : [{ name: 'Current.md', path: 'Current.md', type: 'file' }] })
      if (url === '/api/repository/git/status') return Response.json({ state: syncCount > 0 ? 'synced' : 'remote_changes', branch: 'main', lastSyncedAt: new Date().toISOString() })
      if (url.startsWith('/api/repository/file?')) {
        const path = new URL(url, 'http://repoquill.test').searchParams.get('path')
        if (path === 'Renamed.md') renamedReads += 1
        return Response.json({ path, content: path === 'Renamed.md' ? 'Moved note content' : 'Current note', version: path === 'Renamed.md' ? 'v2' : 'v1' })
      }
      if (url === '/api/repository/git/sync' && init?.method === 'POST') {
        syncCount += 1
        return Response.json({ state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString(), receivedChanges: syncCount > 1 ? [{ kind: 'moved', fromPath: 'Current.md', path: 'Renamed.md' }] : [] })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })

    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'Current' }))
    await waitFor(() => expect(view.getByText('Current note')).toBeTruthy())
    fireEvent.click(await view.findByRole('button', { name: 'Sync' }))
    await waitFor(() => expect(view.getByText('Renamed.md')).toBeTruthy())
    expect(view.getByRole('tab', { name: 'Renamed' })).toBeTruthy()
    expect(renamedReads).toBe(1)
    expect(await view.findByText('Moved note content')).toBeTruthy()
  })

  it('keeps edits made during an external move in the version conflict flow', async () => {
    localStorage.setItem('repoquill.sync-preferences', JSON.stringify({ scheduledMinutes: 0, inactivityMinutes: 0, syncOnNotebookSwitch: false, syncOnClose: false, syncOnStartup: false, syncOnFocus: false, syncBeforeOpeningNote: false }))
    let syncCount = 0
    let finishSync!: (response: Response) => void
    let remoteContent = 'Base note'
    let remoteVersion = 'v1'
    const writeVersions: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ status: 'ok' })
      if (url === '/api/notebook') return Response.json({ name: 'Private', configured: true })
      if (url === '/api/notebooks') return Response.json({ activeId: 'private', notebooks: [{ id: 'private', name: 'Private' }] })
      if (url === '/api/repository/tree') return Response.json({ entries: syncCount > 0 ? [{ name: 'Renamed.md', path: 'Renamed.md', type: 'file' }] : [{ name: 'Current.md', path: 'Current.md', type: 'file' }] })
      if (url === '/api/repository/git/status') return Response.json({ state: syncCount > 0 ? 'synced' : 'remote_changes', branch: 'main', lastSyncedAt: new Date().toISOString() })
      if (url.startsWith('/api/repository/file?') && init?.method === 'PUT') {
        const expectedVersion = (JSON.parse(String(init.body)) as { version: string }).version
        writeVersions.push(expectedVersion)
        if (expectedVersion !== remoteVersion) return Response.json({ error: 'file version conflict' }, { status: 409 })
        remoteContent = (JSON.parse(String(init.body)) as { content: string }).content
        remoteVersion = 'v3'
        return Response.json({ path: 'Renamed.md', content: remoteContent, version: remoteVersion })
      }
      if (url.startsWith('/api/repository/file?')) {
        const path = new URL(url, 'http://repoquill.test').searchParams.get('path')
        return Response.json({ path, content: path === 'Renamed.md' ? remoteContent : 'Base note', version: path === 'Renamed.md' ? remoteVersion : 'v1' })
      }
      if (url === '/api/repository/git/sync' && init?.method === 'POST') {
        syncCount += 1
        if (syncCount === 1) return Response.json({ state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString() })
        return new Promise<Response>((resolve) => { finishSync = (response) => { remoteContent = 'Remote moved note'; remoteVersion = 'v2'; resolve(response) } })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })

    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'Current' }))
    await waitFor(() => expect(view.getByText('Base note')).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Sync' }))
    await waitFor(() => expect(finishSync).toBeTypeOf('function'))
    fireEvent.click(view.getByRole('button', { name: 'Insert table' }))
    fireEvent.click(view.getByRole('gridcell', { name: 'Insert 2 columns by 2 rows' }))
    await waitFor(() => expect(view.getByText('Changes not saved yet')).toBeTruthy())

    finishSync(Response.json({ state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString(), receivedChanges: [{ kind: 'moved', fromPath: 'Current.md', path: 'Renamed.md' }] }))
    const conflict = await view.findByRole('dialog', { name: 'Choose the resulting content' })
    expect(conflict.textContent).toContain('Base note')
    expect(conflict.textContent).toContain('Remote moved note')
    await waitFor(() => expect(writeVersions).toHaveLength(1), { timeout: 3000 })
    expect(writeVersions).toEqual(['v1'])
    expect(remoteContent).toBe('Remote moved note')
  })

  it('preserves an externally deleted note and recovers it to a new Markdown file', async () => {
    localStorage.setItem('repoquill.sync-preferences', JSON.stringify({ scheduledMinutes: 0, inactivityMinutes: 0 }))
    let syncCount = 0
    let finishSync!: (response: Response) => void
    let recoveredContent = ''
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ status: 'ok' })
      if (url === '/api/notebook') return Response.json({ name: 'Private', configured: true })
      if (url === '/api/notebooks') return Response.json({ activeId: 'private', notebooks: [{ id: 'private', name: 'Private' }] })
      if (url === '/api/repository/tree') return Response.json({ entries: syncCount > 1 ? [] : [{ name: 'Current.md', path: 'Current.md', type: 'file' }] })
      if (url === '/api/repository/git/status') return Response.json({ state: syncCount > 0 ? 'synced' : 'remote_changes', branch: 'main', lastSyncedAt: new Date().toISOString() })
      if (url === '/api/repository/git/sync' && init?.method === 'POST') {
        syncCount += 1
        if (syncCount === 1) return Response.json({ state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString() })
        return new Promise<Response>((resolve) => { finishSync = resolve })
      }
      if (url.startsWith('/api/repository/file?') && init?.method === 'PUT') {
        const path = new URL(url, 'http://repoquill.test').searchParams.get('path')
        if (path === 'Current.md') return Response.json({ error: 'file not found' }, { status: 404 })
        recoveredContent = (JSON.parse(String(init.body)) as { content: string }).content
        return Response.json({ path, content: recoveredContent, version: 'recovered-v2' })
      }
      if (url === '/api/repository/entries' && init?.method === 'POST') return Response.json({ path: 'Current (recovered).md', type: 'file' }, { status: 201 })
      if (url.startsWith('/api/repository/file?')) {
        const path = new URL(url, 'http://repoquill.test').searchParams.get('path')
        return Response.json({ path, content: path === 'Current (recovered).md' ? '# Current (recovered)' : 'Current note', version: path === 'Current (recovered).md' ? 'recovered-v1' : 'v1' })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })

    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'Current' }))
    await waitFor(() => expect(view.getByText('Current note')).toBeTruthy())
    fireEvent.click(await view.findByRole('button', { name: 'Sync' }))
    await waitFor(() => expect(finishSync).toBeTypeOf('function'))
    fireEvent.click(view.getByRole('button', { name: 'Insert table' }))
    fireEvent.click(view.getByRole('gridcell', { name: 'Insert 2 columns by 2 rows' }))
    await waitFor(() => expect(view.getByText('Changes not saved yet')).toBeTruthy())
    finishSync(Response.json({ state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString(), receivedChanges: [{ kind: 'deleted', path: 'Current.md' }] }))
    await view.findByRole('status', { name: 'New notebook changes received' })
    expect(view.getByText('This note was deleted in another synchronization.')).toBeTruthy()
    expect(view.container.querySelector('.ProseMirror table')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Recover as new note' }))
    expect(view.getByRole('dialog', { name: 'Recover deleted note' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Recover' }))

    expect(await view.findByText('Current (recovered).md')).toBeTruthy()
    expect(recoveredContent).toContain('|')
  })

  it('loads the latest contents when an inactive open tab is activated', async () => {
    localStorage.setItem('repoquill.sync-preferences', JSON.stringify({ scheduledMinutes: 0, inactivityMinutes: 0 }))
    let syncCount = 0
    let secondWasUpdated = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ status: 'ok' })
      if (url === '/api/notebook') return Response.json({ name: 'Private', configured: true })
      if (url === '/api/notebooks') return Response.json({ activeId: 'private', notebooks: [{ id: 'private', name: 'Private' }] })
      if (url === '/api/repository/tree') return Response.json({ entries: [{ name: 'First.md', path: 'First.md', type: 'file' }, { name: 'Second.md', path: 'Second.md', type: 'file' }] })
      if (url === '/api/repository/git/status') return Response.json({ state: syncCount > 0 ? 'synced' : 'remote_changes', branch: 'main', lastSyncedAt: new Date().toISOString() })
      if (url.startsWith('/api/repository/file?')) {
        const path = new URL(url, 'http://repoquill.test').searchParams.get('path')
        return Response.json({ path, content: path === 'Second.md' ? secondWasUpdated ? 'Latest second note' : 'Old second note' : 'First note', version: secondWasUpdated && path === 'Second.md' ? 'v2' : 'v1' })
      }
      if (url === '/api/repository/git/sync' && init?.method === 'POST') {
        syncCount += 1
        secondWasUpdated = syncCount > 1
        return Response.json({ state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString(), receivedChanges: secondWasUpdated ? [{ kind: 'updated', path: 'Second.md' }] : [] })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })

    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'First' }))
    await waitFor(() => expect(view.getByText('First note')).toBeTruthy())
    fireEvent.contextMenu(view.getByRole('button', { name: 'Second' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Open in new tab' }))
    await waitFor(() => expect(view.getByText('Old second note')).toBeTruthy())
    fireEvent.click(view.getByRole('tab', { name: 'First' }))
    fireEvent.click(await view.findByRole('button', { name: 'Sync' }))
    await view.findByRole('status', { name: 'New notebook changes received' })
    expect(view.container.querySelector('.ProseMirror')?.textContent).toContain('First note')
    fireEvent.click(view.getByRole('tab', { name: 'Second' }))
    expect(await view.findByText('Latest second note')).toBeTruthy()
  })

  it.each(['focus', 'scheduled', 'inactivity'] as const)('refreshes the active note after %s-triggered synchronization', async (trigger) => {
    localStorage.setItem('repoquill.sync-preferences', JSON.stringify({ scheduledMinutes: trigger === 'scheduled' ? 5 : 0, inactivityMinutes: trigger === 'inactivity' ? 1 : 0 }))
    const intervalSpy = trigger === 'scheduled' ? vi.spyOn(globalThis, 'setInterval') : undefined
    const timeoutSpy = trigger === 'inactivity' ? vi.spyOn(globalThis, 'setTimeout') : undefined
    let syncCount = 0
    let content = 'Current note'
    let version = 'v1'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ status: 'ok' })
      if (url === '/api/notebook') return Response.json({ name: 'Private', configured: true })
      if (url === '/api/notebooks') return Response.json({ activeId: 'private', notebooks: [{ id: 'private', name: 'Private' }] })
      if (url === '/api/repository/tree') return Response.json({ entries: [{ name: 'Current.md', path: 'Current.md', type: 'file' }] })
      if (url === '/api/repository/git/status') return Response.json({ state: syncCount > 0 ? 'synced' : 'remote_changes', branch: 'main', lastSyncedAt: syncCount > 0 ? new Date().toISOString() : undefined })
      if (url.startsWith('/api/repository/file?') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { content: string }
        content = body.content
        version = 'local-v2'
        return Response.json({ path: 'Current.md', content, version })
      }
      if (url.startsWith('/api/repository/file?')) return Response.json({ path: 'Current.md', content, version })
      if (url === '/api/repository/git/sync' && init?.method === 'POST') {
        syncCount += 1
        if (syncCount === 1) return Response.json({ state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString() })
        content = `Updated by ${trigger} sync`
        version = 'remote-v3'
        return Response.json({ state: 'synced', branch: 'main', lastSyncedAt: new Date().toISOString(), receivedChanges: [{ kind: 'updated', path: 'Current.md' }] })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })

    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'Current' }))
    await waitFor(() => expect(view.getByText('Current note')).toBeTruthy())

    if (trigger === 'focus') {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      fireEvent.focus(window)
    } else if (trigger === 'scheduled') {
      await waitFor(() => expect(intervalSpy?.mock.calls.some(([, delay]) => delay === 5 * 60_000)).toBe(true))
      const scheduledCall = intervalSpy?.mock.calls.find(([, delay]) => delay === 5 * 60_000)
      const scheduledCallback = scheduledCall?.[0]
      expect(scheduledCallback).toBeTypeOf('function')
      await act(async () => { if (typeof scheduledCallback === 'function') scheduledCallback() })
    } else {
      fireEvent.click(view.getByRole('button', { name: 'Insert table' }))
      fireEvent.click(view.getByRole('gridcell', { name: 'Insert 2 columns by 2 rows' }))
      await waitFor(() => expect(view.getByText('Changes not saved yet')).toBeTruthy())
      await waitFor(() => expect(timeoutSpy?.mock.calls.some(([, delay]) => delay === 60_000)).toBe(true))
      const inactivityCall = timeoutSpy?.mock.calls.find(([, delay]) => delay === 60_000)
      const inactivityCallback = inactivityCall?.[0]
      expect(inactivityCallback).toBeTypeOf('function')
      await act(async () => { if (typeof inactivityCallback === 'function') inactivityCallback() })
    }

    expect(await view.findByText(`Updated by ${trigger} sync`)).toBeTruthy()
    expect(syncCount).toBeGreaterThan(1)
  })

  it('automatically dismisses a received-changes banner and resets for a newer batch', async () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    const first = [{ kind: 'added' as const, path: 'First.md' }]
    const second = [{ kind: 'updated' as const, path: 'Second.md' }]
    const view = render(<ReceivedChangesNotice changes={first} onOpen={vi.fn()} onDismiss={onDismiss} />)

    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(onDismiss).not.toHaveBeenCalled()
    view.rerender(<ReceivedChangesNotice changes={second} onOpen={vi.fn()} onDismiss={onDismiss} />)
    await act(async () => { vi.advanceTimersByTime(11_999) })
    expect(onDismiss).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it.each(['hover', 'focus', 'pointer'] as const)('defers automatic dismissal during active %s interaction', async (interaction) => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    const view = render(<ReceivedChangesNotice changes={[{ kind: 'added', path: 'External.md' }]} onOpen={vi.fn()} onDismiss={onDismiss} />)
    const notice = view.getByRole('status', { name: 'New notebook changes received' })
    const dismiss = view.getByRole('button', { name: 'Dismiss received changes' })

    if (interaction === 'hover') fireEvent.pointerEnter(notice, { pointerType: 'mouse' })
    else if (interaction === 'focus') fireEvent.focus(dismiss)
    else fireEvent.pointerDown(notice)
    await act(async () => { vi.advanceTimersByTime(20_000) })
    expect(onDismiss).not.toHaveBeenCalled()

    if (interaction === 'hover') fireEvent.pointerLeave(notice, { pointerType: 'mouse' })
    else if (interaction === 'focus') fireEvent.blur(dismiss, { relatedTarget: null })
    else fireEvent.pointerUp(notice)
    await act(async () => { vi.advanceTimersByTime(12_000) })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
