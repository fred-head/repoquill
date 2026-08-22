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
  localStorage.setItem('repoquill.auto-lock-minutes', '1')
  let active = 'personal'
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/health') return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/notebook') return Response.json({ name: active === 'personal' ? 'Personal Notes' : 'Work' })
    if (url === '/api/notebooks') return Response.json({ activeId: active, notebooks: [{ id: 'personal', name: 'Personal Notes', branch: 'main' }, { id: 'work', name: 'Work', branch: 'main' }] })
    if (url === '/api/notebooks/work/activate' && init?.method === 'POST') { active = 'work'; return Response.json({ id: 'work', name: 'Work' }) }
    if (url === '/api/repository/tree') return Response.json({ entries: active === 'personal' ? [{ name: 'Note.md', path: 'Note.md', type: 'file' }] : [{ name: 'Work.md', path: 'Work.md', type: 'file' }] })
    if (url === '/api/repository/search?q=auto-lock') return Response.json({ results: [{ path: 'Note.md', type: 'content', line: 1, excerpt: '# Auto-lock note' }] })
    if (url === '/api/repository/git/status') return Response.json({ state: 'clean', branch: 'main' })
    if (url === '/api/repository/git/sync' && init?.method === 'POST') return Response.json({ state: 'synced', branch: 'main' })
    if (url === '/api/repository/git/sync-background' && init?.method === 'POST') return Response.json({ status: 'accepted' }, { status: 202 })
    if (url.startsWith('/api/repository/file?')) return Response.json({ path: 'Note.md', content: '# Auto-lock note', version: 'v1' })
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
    await waitFor(() => expect((view.container.querySelector('[aria-haspopup="menu"]') as HTMLElement).textContent).toContain('Personal Notes'))
    expect(view.getAllByRole('button', { name: 'Personal Notes' }).length).toBeGreaterThan(0)
    expect(view.getByText('Create in:').parentElement?.textContent).toContain('Personal Notes')
    expect(view.container.textContent).not.toContain('Local repository')
    expect(view.container.textContent).not.toContain('Repository Root')
    const noteButton = await view.findByRole('button', { name: 'Note' })
    fireEvent.click(noteButton)
    await waitFor(() => expect(view.container.textContent).toContain('Auto-lock note'))

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
    await waitFor(() => expect((view.container.querySelector('[aria-haspopup="menu"]') as HTMLElement).textContent).toContain('Personal Notes'))
    const switcher = view.container.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement
    fireEvent.click(switcher)
    expect(view.getByRole('menuitemradio', { name: 'Personal Notes' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(view.getByRole('menuitem', { name: '+ Add Notebook' }))
    expect(view.getByRole('heading', { name: 'Add Notebook' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(switcher)
    fireEvent.click(view.getByRole('menuitemradio', { name: 'Work' }))
    await waitFor(() => expect(switcher.textContent).toContain('Work'))
    expect(view.queryByRole('button', { name: 'Note' })).toBeNull()
    await waitFor(() => expect(view.getAllByRole('button', { name: 'Work' }).length).toBeGreaterThan(0))
    const syncCalls = vi.mocked(globalThis.fetch).mock.calls.filter(([url, init]) => String(url) === '/api/repository/git/sync' && init?.method === 'POST')
    expect(syncCalls.length).toBeGreaterThanOrEqual(3)
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
})
