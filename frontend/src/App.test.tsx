// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('repoquill.auto-lock-minutes', '1')
  let active = 'personal'
  let notebooks = [{ id: 'local', name: 'repos' }, { id: 'personal', name: 'Personal Notes', branch: 'main' }, { id: 'work', name: 'Work', branch: 'main' }]
  let noteContent = '# Auto-lock note'
  let noteVersion = 'v1'
  let notePath = 'Note.md'
  let noteTrashed = false
  let trashItems: Array<{id:string;originalPath:string;type:'file';deletedAt:string;size:number}> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/health') return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/notebook') return Response.json({ name: active === 'personal' ? 'Personal Notes' : 'Work', configured: true })
    if (url === '/api/notebooks') return Response.json({ activeId: active, notebooks })
    if (url === '/api/notebooks/work/activate' && init?.method === 'POST') { active = 'work'; return Response.json({ id: 'work', name: 'Work' }) }
    if (url === '/api/notebooks/local' && init?.method === 'DELETE') { notebooks = notebooks.filter((notebook) => notebook.id !== 'local'); return new Response(null, { status: 204 }) }
    if (url === '/api/repository/tree') return Response.json({ entries: active === 'personal' ? [...(noteTrashed ? [] : [{ name: notePath, path: notePath, type: 'file' }]), { name: 'Second.md', path: 'Second.md', type: 'file' }] : [{ name: 'Work.md', path: 'Work.md', type: 'file' }] })
    if (url === '/api/repository/search?q=auto-lock') return Response.json({ results: [{ path: 'Note.md', type: 'content', line: 1, excerpt: '# Auto-lock note' }] })
    if (url === '/api/repository/git/status') return Response.json({ state: 'clean', branch: 'main' })
    if (url === '/api/repository/git/sync' && init?.method === 'POST') return Response.json({ state: 'synced', branch: 'main' })
    if (url === '/api/repository/git/sync-background' && init?.method === 'POST') return Response.json({ status: 'accepted' }, { status: 202 })
    if (url === '/api/repository/history?path=Note.md') return Response.json({ entries: [{ versionId: 'a'.repeat(40), timestamp: '2026-08-20T10:00:00Z', summary: 'Earlier note', path: 'Note.md' }] })
    if (url.startsWith('/api/repository/history/version?')) return Response.json({ versionId: 'a'.repeat(40), timestamp: '2026-08-20T10:00:00Z', summary: 'Earlier note', path: 'Note.md', content: '# Earlier note' })
    if (url === '/api/repository/history/restore' && init?.method === 'POST') { noteContent = '# Earlier note'; noteVersion = 'v-restored'; return Response.json({ path: 'Note.md', content: noteContent, version: noteVersion }) }
    if (url === '/api/repository/move/preview' && init?.method === 'POST') { const body = JSON.parse(String(init.body)); return Response.json({ source:body.source,target:body.target,token:'rewrite-token',rewrites:[{notePath:'Second.md',nextNotePath:'Second.md',line:1,before:'Note.md',after:body.target}] }) }
    if (url === '/api/repository/move' && init?.method === 'POST') { const body = JSON.parse(String(init.body)); notePath = body.target; return Response.json({ path:body.target,rewrites:[] }) }
    if (url === '/api/repository/entry?path=Note.md' && init?.method === 'DELETE') { noteTrashed = true; const item = { id: 'b'.repeat(32), originalPath: 'Note.md', type: 'file' as const, deletedAt: '2026-08-28T10:00:00Z', size: 42 }; trashItems = [item]; return Response.json(item) }
    if (url === '/api/repository/trash') return Response.json({ items: trashItems })
    if (url === `/api/repository/trash/${'b'.repeat(32)}/restore` && init?.method === 'POST') { noteTrashed = false; const item = trashItems[0]; trashItems = []; return Response.json(item) }
    if (url === `/api/repository/trash/${'b'.repeat(32)}` && init?.method === 'DELETE') { const item = trashItems[0]; trashItems = []; return Response.json(item) }
    if (url.includes('Second.md')) return Response.json({ path: 'Second.md', content: '# Second note', version: 'v2' })
    if (url.startsWith('/api/repository/file?')) return Response.json({ path: notePath, content: noteContent, version: noteVersion })
    return Response.json({ error: 'unexpected request' }, { status: 500 })
  }))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('App auto-lock integration', () => {
  it('keeps the note visible when inactivity changes it to Read only', async () => {
    const view = render(<App />)
    await waitFor(() => expect((view.container.querySelector('[aria-haspopup="menu"]') as HTMLElement).textContent).toContain('Notebooks'))
    await waitFor(() => expect(view.getAllByRole('button', { name: 'Personal Notes' }).length).toBeGreaterThan(0))
    expect(view.getByText('Create in:').parentElement?.textContent).toContain('Personal Notes')
    expect(view.container.textContent).not.toContain('Local repository')
    expect(view.container.textContent).not.toContain('Repository Root')
    const noteButton = await view.findByRole('button', { name: 'Note' })
    fireEvent.click(noteButton)
	await waitFor(() => expect(view.container.textContent).toContain('Auto-lock note'), { timeout: 5000 })

    vi.useFakeTimers()
    // Changing the setting restarts the same active timer under fake timers.
    fireEvent.click(view.getByRole('button', { name: 'Settings' }))
    await act(async () => {
      fireEvent.change(view.getByLabelText('Auto-lock notes'), { target: { value: '5' } })
      await Promise.resolve()
    })
    fireEvent.click(view.getByRole('button', { name: 'Done' }))
    await act(async () => {
      vi.advanceTimersByTime(300_000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(view.getByRole('button', { name: '🔒 Read only' })).toBeTruthy()
    expect(view.container.textContent).toContain('Auto-lock note')
  })

  it('opens primary notebook navigation, onboarding, and switches without stale tree state', async () => {
    const view = render(<App />)
    await waitFor(() => expect((view.container.querySelector('[aria-haspopup="menu"]') as HTMLElement).textContent).toContain('Notebooks'))
    await waitFor(() => expect(view.getAllByRole('button', { name: 'Personal Notes' }).length).toBeGreaterThan(0))
    const switcher = view.container.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement
    fireEvent.click(switcher)
    expect(view.getByRole('menuitemradio', { name: 'Personal Notes' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(view.getByRole('menuitem', { name: '+ Add Notebook' }))
    expect(view.getByRole('heading', { name: 'Add Notebook' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(switcher)
    fireEvent.click(view.getByRole('menuitemradio', { name: 'Work' }))
    await waitFor(() => expect(switcher.textContent).toContain('Notebooks'))
    expect(view.queryByRole('button', { name: 'Note' })).toBeNull()
    await waitFor(() => expect(view.getAllByRole('button', { name: 'Work' }).length).toBeGreaterThan(0))
	await waitFor(() => {
		const syncCalls = vi.mocked(globalThis.fetch).mock.calls.filter(([url, init]) => String(url) === '/api/repository/git/sync' && init?.method === 'POST')
		// Startup/focus triggers are browser-timing dependent; switching must add
		// a synchronization request without requiring an incidental focus event.
		expect(syncCalls.length).toBeGreaterThanOrEqual(2)
	}, { timeout: 5000 })
  }, 10_000)

  it('offers notebook onboarding instead of a synthetic local notebook on a fresh installation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/health') return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/notebook') return Response.json({ name: 'Notebook', configured: false })
      if (url === '/api/notebooks') return Response.json({ activeId: '', notebooks: [] })
      if (url === '/api/repository/tree') return Response.json({ error: 'repository is not configured' }, { status: 503 })
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }))

    const view = render(<App />)
    expect(await view.findByRole('heading', { name: 'Connect your first notebook' })).toBeTruthy()
    expect(view.getByText('No notebook yet')).toBeTruthy()
    expect(view.queryByText(/Set REPOQUILL_REPOSITORY/)).toBeNull()
    expect((view.getByRole('button', { name: 'Sync' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(view.getAllByRole('button', { name: 'Add Notebook' })[0])
    expect(view.getByRole('heading', { name: 'Add Notebook' })).toBeTruthy()
  })

  it('unregisters an inactive legacy notebook without presenting file deletion', async () => {
    const view = render(<App />)
    const switcher = view.container.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement
    await waitFor(() => expect(switcher.textContent).toContain('Notebooks'))
    await waitFor(() => expect(view.getAllByRole('button', { name: 'Personal Notes' }).length).toBeGreaterThan(0))
    fireEvent.click(switcher)
    fireEvent.click(view.getByRole('menuitem', { name: 'Manage Notebooks' }))
    const legacyCard = (await view.findByRole('heading', { name: 'repos' })).closest('section') as HTMLElement
    const remove = Array.from(legacyCard.querySelectorAll('button')).find(button => button.textContent === 'Remove…')!
    fireEvent.click(remove)
    fireEvent.click(view.getByRole('button', { name: 'Remove registration' }))
    await waitFor(() => expect(view.queryByRole('heading', { name: 'repos' })).toBeNull())
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([url, init]) => String(url) === '/api/notebooks/local' && init?.method === 'DELETE')).toBe(true)
  })

  it('opens, switches, and closes notes in session tabs without duplicate editors', async () => {
    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'Note' }))
    await waitFor(() => expect(view.container.textContent).toContain('Auto-lock note'))
    expect(view.getAllByRole('tab')).toHaveLength(1)

    fireEvent.click(view.getByRole('button', { name: 'Second' }), { ctrlKey: true })
    await waitFor(() => expect(view.container.textContent).toContain('Second note'))
    expect(view.getAllByRole('tab')).toHaveLength(2)
    expect(view.getByRole('tab', { name: 'Second' }).getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })
    await waitFor(() => expect(view.container.textContent).toContain('Auto-lock note'))
    expect(view.getByRole('tab', { name: 'Note' }).getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
    await waitFor(() => expect(view.queryByRole('tab', { name: 'Note' })).toBeNull())
    expect(view.getAllByRole('tab')).toHaveLength(1)
    expect(view.container.textContent).toContain('Second note')
  })

  it('previews and confirms portable link rewrites before renaming a note', async () => {
    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name:'Note' }))
    await waitFor(() => expect(view.container.textContent).toContain('Auto-lock note'))
    fireEvent.click(view.getByRole('button', { name:'Selected item actions' }))
    fireEvent.click(view.getByRole('menuitem', { name:'Rename' }))
    fireEvent.change(view.getByLabelText('New name'), { target:{ value:'Renamed.md' } })
    fireEvent.submit(view.getByLabelText('New name').closest('form')!)
    const dialog = await view.findByRole('dialog', { name:'Update note links?' })
    expect(dialog.textContent).toContain('Second.md')
    expect(dialog.textContent).toContain('Note.md')
    expect(dialog.textContent).toContain('Renamed.md')
    fireEvent.click(view.getByRole('button', { name:'Move and update links' }))
    await waitFor(() => expect(view.getByRole('button', { name:'Renamed' })).toBeTruthy())
    const moveCall = vi.mocked(globalThis.fetch).mock.calls.find(([url,init]) => String(url)==='/api/repository/move' && init?.method==='POST')
    expect(JSON.parse(String(moveCall?.[1]?.body))).toEqual({ source:'Note.md',target:'Renamed.md',rewriteToken:'rewrite-token' })
  })

	it('guides a non-technical user through an overlapping Markdown change', async () => {
		const fallback = vi.mocked(globalThis.fetch)
		let resolved = false
		vi.stubGlobal('fetch',vi.fn(async (input:RequestInfo|URL,init?:RequestInit) => {
			const url = String(input)
			if (url === '/api/repository/git/status' && !resolved) return Response.json({ state:'conflict',branch:'main',conflictFiles:['Note.md'] })
			if (url === '/api/repository/git/conflicts') return Response.json({ token:'conflict-token',items:[{ path:'Note.md',kind:'markdown',yourExists:true,otherExists:true,yourContent:'# Your version',otherContent:'# Other version' }] })
			if (url === '/api/repository/git/conflicts/resolve' && init?.method === 'POST') { resolved=true; return Response.json({ state:'synced',message:'done',safetyPoint:'recovery-1' }) }
			return fallback(input,init)
		}))
		const view = render(<App />)
		fireEvent.click(await view.findByRole('button',{ name:'Note' }))
		await waitFor(()=>expect(view.container.textContent).toContain('Auto-lock note'))
		fireEvent.click(view.getByRole('button',{ name:/Synchronization: Your decision is required/ }))
		fireEvent.click(await view.findByRole('button',{ name:'Review affected items' }))
		const assistant = await view.findByRole('dialog',{ name:'Choose the resulting content' })
		expect(assistant.textContent).toContain('Your version')
		expect(assistant.textContent).toContain('Other version')
		fireEvent.click(view.getByRole('button',{ name:'Use your version' }))
		fireEvent.click(view.getByRole('button',{ name:'Review complete — apply' }))
		await waitFor(()=>expect(view.queryByRole('dialog',{ name:'Choose the resulting content' })).toBeNull())
		const call = vi.mocked(globalThis.fetch).mock.calls.find(([url,request])=>String(url)==='/api/repository/git/conflicts/resolve'&&request?.method==='POST')
		expect(JSON.parse(String(call?.[1]?.body))).toEqual({ token:'conflict-token',decisions:[{ path:'Note.md',action:'use_yours' }] })
	})

  it('views a readable note history diff and restores through a normal version-checked save', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'Note' }))
    await waitFor(() => expect(view.container.textContent).toContain('Auto-lock note'))
    fireEvent.click(view.getByRole('button', { name: 'Version history' }))

    const dialog = await view.findByRole('dialog', { name: 'Version history' })
    fireEvent.click(await view.findByRole('button', { name: /Earlier note/ }))
    const comparison = await view.findByRole('region', { name: 'Version comparison' })
    expect(comparison.textContent).toContain('Earlier note')
    expect(comparison.textContent).toContain('Auto-lock note')

    fireEvent.click(view.getByRole('button', { name: 'Restore this version' }))
    await waitFor(() => expect(view.queryByRole('dialog', { name: 'Version history' })).toBeNull())
    await waitFor(() => expect(view.container.textContent).toContain('Earlier note'))
    const restoreCall = vi.mocked(globalThis.fetch).mock.calls.find(([url, init]) => String(url) === '/api/repository/history/restore' && init?.method === 'POST')
    expect(restoreCall).toBeTruthy()
    expect(JSON.parse(String(restoreCall?.[1]?.body))).toEqual({ path: 'Note.md', versionId: 'a'.repeat(40), expectedVersion: 'v1' })
    expect(dialog).toBeTruthy()
  })

  it('moves a note to notebook Trash and restores it from the touch-friendly Trash view', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'Note' }))
    await waitFor(() => expect(view.container.textContent).toContain('Auto-lock note'))
    fireEvent.click(view.getByRole('button', { name: 'Selected item actions' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Move to Trash' }))
    await waitFor(() => expect(view.queryByRole('button', { name: 'Note' })).toBeNull())

    fireEvent.click(view.getByRole('button', { name: 'Open Trash' }))
    expect(await view.findByRole('dialog', { name: 'Trash' })).toBeTruthy()
    expect(view.getByText('Note.md')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(view.getByText('Restored “Note.md”.')).toBeTruthy())
    await waitFor(() => expect(view.getByRole('button', { name: 'Note' })).toBeTruthy())
    expect(view.getByText('Trash is empty.')).toBeTruthy()
  })

  it('requires explicit confirmation before permanently deleting a trashed note', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const view = render(<App />)
    fireEvent.click(await view.findByRole('button', { name: 'Note' }))
    fireEvent.click(view.getByRole('button', { name: 'Selected item actions' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Move to Trash' }))
    await waitFor(() => expect(view.queryByRole('button', { name: 'Note' })).toBeNull())
    fireEvent.click(view.getByRole('button', { name: 'Open Trash' }))
    fireEvent.click(await view.findByRole('button', { name: 'Permanently delete' }))
    await waitFor(() => expect(view.getByText('Trash is empty.')).toBeTruthy())
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('cannot be undone in RepoQuill'))
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([url, init]) => String(url) === `/api/repository/trash/${'b'.repeat(32)}` && init?.method === 'DELETE')).toBe(true)
  })

  it('requests best-effort background sync when a saved tab closes', async () => {
    render(<App />)
    await waitFor(() => expect(vi.mocked(globalThis.fetch).mock.calls.some(([url]) => String(url) === '/api/notebooks')).toBe(true))
    window.dispatchEvent(new Event('pagehide'))
    await waitFor(() => expect(vi.mocked(globalThis.fetch).mock.calls.some(([url, init]) => String(url) === '/api/repository/git/sync-background' && init?.method === 'POST' && init.keepalive === true)).toBe(true))
  })

  it('searches the active notebook and opens a content result', async () => {
    const view = render(<App />)
    const search = await view.findByRole('searchbox', { name: 'Search this notebook' })
    fireEvent.change(search, { target: { value: 'auto-lock' } })
    const result = await view.findByRole('button', { name: /Note.*L1/ })
    expect(result.textContent).toContain('Auto-lock note')
    fireEvent.click(result)
    await waitFor(() => expect(view.container.textContent).toContain('Auto-lock note'))
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([url]) => String(url) === '/api/repository/search?q=auto-lock')).toBe(true)
  })

  it('opens mobile notebook navigation and closes it after choosing a note', async () => {
    const view = render(<App />)
    const openNavigation = view.getByRole('button', { name: 'Open notebook navigation' })
    const navigation = view.getByRole('complementary', { name: 'Notebook navigation' })
    expect(navigation.className).toContain('-translate-x-full')
    fireEvent.click(openNavigation)
    expect(openNavigation.getAttribute('aria-expanded')).toBe('true')
    expect(navigation.className).toContain('translate-x-0')
    fireEvent.click(await view.findByRole('button', { name: 'Note' }))
    await waitFor(() => expect(openNavigation.getAttribute('aria-expanded')).toBe('false'))
  })

  it('reports offline mode and offers browser-provided PWA installation', async () => {
    const view = render(<App />)
    window.dispatchEvent(new Event('offline'))
    expect(await view.findByText('Offline.')).toBeTruthy()

    const prompt = vi.fn(async () => undefined)
    const event = new Event('beforeinstallprompt') as Event & { prompt: typeof prompt; userChoice: Promise<{ outcome: 'accepted' }> }
    event.prompt = prompt
    event.userChoice = Promise.resolve({ outcome: 'accepted' })
    window.dispatchEvent(event)
    const install = await view.findByRole('button', { name: 'Install app' })
    fireEvent.click(install)
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce())
  })

  it('keeps the PWA installation suggestion dismissed', async () => {
    const view = render(<App />)
    const event = new Event('beforeinstallprompt') as InstallPromptEventForTest
    event.prompt = vi.fn(async () => undefined)
    event.userChoice = Promise.resolve({ outcome: 'dismissed' })
    window.dispatchEvent(event)
    fireEvent.click(await view.findByRole('button', { name: 'Dismiss install suggestion' }))
    expect(localStorage.getItem('repoquill.install-prompt-dismissed')).toBe('true')
    expect(view.queryByText('Install RepoQuill for a standalone app experience.')).toBeNull()

    cleanup()
    const nextView = render(<App />)
    window.dispatchEvent(event)
    expect(nextView.queryByText('Install RepoQuill for a standalone app experience.')).toBeNull()
  })

  it('opens the same guided assistant when a recovery draft overlaps a server change', async () => {
    const draft = { notebookId: 'personal', path: 'Note.md', content: '# Unsaved recovery', savedContent: '# Older copy', version: 'older-version', capturedAt: '2026-08-27T09:00:00Z' }
    sessionStorage.setItem('repoquill.recovery-draft', JSON.stringify(draft))
    const view = render(<App authMode="local" />)

    fireEvent.click(await view.findByRole('button', { name: 'Review draft' }))
		const assistant = await view.findByRole('dialog',{ name:'Choose the resulting content' })
		expect(assistant.textContent).toContain('Unsaved recovery')
		expect(assistant.textContent).toContain('Auto-lock note')
    expect(JSON.parse(sessionStorage.getItem('repoquill.recovery-draft') ?? 'null')).toEqual(draft)
		fireEvent.click(view.getByRole('button',{ name:'Use other version' }))
		fireEvent.click(view.getByRole('button',{ name:'Review complete — apply' }))
		await waitFor(()=>expect(view.queryByRole('dialog',{ name:'Choose the resulting content' })).toBeNull())
		expect(sessionStorage.getItem('repoquill.recovery-draft')).toBeNull()
		expect(view.container.textContent).toContain('Auto-lock note')
  })
})

type InstallPromptEventForTest = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
