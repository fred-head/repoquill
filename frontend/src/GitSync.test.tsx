// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App, DocumentStatusBar } from './App'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', ResizeObserverStub)
vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Git synchronization UI', () => {
  it('keeps local save and Git synchronization states distinct', () => {
    const view = render(<DocumentStatusBar status="saved" gitStatus={{ state: 'sync_failed', message: 'Remote unavailable' }} gitSyncing={false} markdown="hello world" />)
    expect(view.getByText('Saved on this server')).toBeTruthy()
    const synchronization = view.getByLabelText('Synchronization: Synchronization could not finish. Open details')
    expect(synchronization).toBeTruthy()
    expect(synchronization.getAttribute('title')).toContain('saved on this RepoQuill server')
  })

  it('runs manual sync and reports the successful repository state', async () => {
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
    await waitFor(() => expect(view.getByLabelText('Synchronization: Changes waiting to synchronize. Open details')).toBeTruthy())

    fireEvent.click(view.getByRole('button', { name: 'Sync' }))
    await waitFor(() => expect(view.getByLabelText('Synchronization: Everything is up to date. Open details')).toBeTruthy())
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/repository/git/sync' && init?.method === 'POST')).toBe(true)
  })

  it('keeps conflicts visible as a critical textual state', () => {
    const view = render(<DocumentStatusBar status="saved" gitStatus={{ state: 'conflict', conflictFiles: ['Note.md'] }} gitSyncing={false} markdown="note" />)
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
    await waitFor(() => expect(view.container.textContent).toContain('First note'))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/repository/git/sync')).toBe(true))

    fireEvent.click(view.getByRole('button', { name: 'Second' }))
    await waitFor(() => expect(view.container.textContent).toContain('Second note'))
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

  it('announces received notebook changes without replacing the current note', async () => {
    localStorage.setItem('repoquill.sync-preferences', JSON.stringify({ scheduledMinutes: 0, inactivityMinutes: 0, syncOnNotebookSwitch: false, syncOnClose: false, syncOnStartup: false, syncOnFocus: false, syncBeforeOpeningNote: false }))
    let synchronized = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ status: 'ok' })
      if (url === '/api/notebook') return Response.json({ name: 'Private', configured: true })
      if (url === '/api/notebooks') return Response.json({ activeId: 'private', notebooks: [{ id: 'private', name: 'Private' }] })
      if (url === '/api/repository/tree') return Response.json({ entries: [{ name: 'Current.md', path: 'Current.md', type: 'file' }] })
      if (url === '/api/repository/git/status') return Response.json({ state: synchronized ? 'synced' : 'remote_changes', branch: 'main' })
      if (url.startsWith('/api/repository/file?')) return Response.json({ path: 'Current.md', content: 'Current note', version: 'v1' })
      if (url === '/api/repository/git/sync' && init?.method === 'POST') {
        synchronized = true
        return Response.json({ state: 'synced', branch: 'main', receivedChanges: [{ kind: 'added', path: 'External.md' }] })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })
    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'Current' }))
    await waitFor(() => expect(view.container.textContent).toContain('Current note'))
    fireEvent.click(view.getByRole('button', { name: 'Sync' }))

    expect(await view.findByRole('status', { name: 'New notebook changes received' })).toBeTruthy()
    expect(view.getByText('Current note')).toBeTruthy()
    expect(view.getByRole('button', { name: 'External.md' })).toBeTruthy()
  })
})
