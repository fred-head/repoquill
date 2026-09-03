// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsDialog } from './App'
import { setCSRFToken } from './api'
import './styles.css'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
})

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response
}

function beginOnboarding(view: ReturnType<typeof render>, address = 'git@example.test:user/notes.git') {
  fireEvent.click(view.getByRole('button', { name: 'Another Git server' }))
  fireEvent.change(view.getByLabelText('Notebook name'), { target: { value: 'Private' } })
  fireEvent.change(view.getByLabelText('Repository SSH address'), { target: { value: address } })
}

function beginGitHubOnboarding(view: ReturnType<typeof render>, address = 'git@github.com:fred-head/private-notes.git') {
  fireEvent.click(view.getByRole('button', { name: 'GitHub' }))
  fireEvent.change(view.getByLabelText('Notebook name'), { target: { value: 'Private notes' } })
  fireEvent.change(view.getByLabelText('GitHub repository address'), { target: { value: address } })
}

describe('Settings asset cleanup', () => {
  it('keeps the GitHub path keyboard-operable at a narrow PWA-sized viewport', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const user = userEvent.setup()
    const view = render(<SettingsDialog mode="onboarding" autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onClose={vi.fn()} />)
    const githubButton = view.getByRole('button', { name: 'GitHub' })

    githubButton.focus()
    await user.keyboard('{Enter}')

    expect(view.getByLabelText('Notebook name')).toBeTruthy()
    expect(view.getByLabelText('GitHub repository address')).toBeTruthy()
    expect(view.getByRole('link', { name: 'Create a repository on GitHub' })).toBeTruthy()
    expect(view.getByRole('dialog').className).toContain('w-full')
  })

  it('guides GitHub beginners to create a repository and copy its SSH address', () => {
    const view = render(<SettingsDialog mode="onboarding" autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onClose={vi.fn()} />)

    fireEvent.click(view.getByRole('button', { name: 'GitHub' }))
    expect(view.getByText('Start with a GitHub repository')).toBeTruthy()
    const createLink = view.getByRole('link', { name: 'Create a repository on GitHub' }) as HTMLAnchorElement
    expect(createLink.href).toBe('https://github.com/new')
    expect(createLink.target).toBe('_blank')
    expect(view.getByText('Find this address in GitHub')).toBeTruthy()
    expect(view.getByText('Code')).toBeTruthy()
    expect(view.getByText('SSH')).toBeTruthy()

    fireEvent.change(view.getByLabelText('Notebook name'), { target: { value: 'Private notes' } })
    fireEvent.change(view.getByLabelText('GitHub repository address'), { target: { value: 'https://github.com/fred-head/private-notes' } })
    expect(view.getByRole('alert').textContent).toContain('Code → SSH')
    expect(view.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true)

    fireEvent.change(view.getByLabelText('GitHub repository address'), { target: { value: 'git@github.com:fred-head/private-notes.git' } })
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(false)
  })

  it('explains managed keys, GitHub deploy-key setup, retry, and the final review', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const publicKey = 'ssh-ed25519 AAAAGITHUB repoquill-key'
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ keyId: '0123456789abcdef0123456789abcdef', publicKey }))
      .mockResolvedValueOnce(jsonResponse({ state: 'authentication_failed', message: 'Permission denied.' }))
      .mockResolvedValueOnce(jsonResponse({ state: 'success', message: 'Connection successful' }))
    const view = render(<SettingsDialog mode="onboarding" autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onClose={vi.fn()} />)

    beginGitHubOnboarding(view)
    fireEvent.change(view.getByLabelText(/Branch/), { target: { value: 'main' } })
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    expect(view.getByText('Give this notebook secure access')).toBeTruthy()
    expect(view.getByText(/personal SSH private key/)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Generate key' }))
    await waitFor(() => expect(view.getByDisplayValue(publicKey)).toBeTruthy())
    expect(view.getByText('Add this public key in GitHub')).toBeTruthy()
    expect(view.getByText(/Enable “Allow write access”/)).toBeTruthy()
    const instructions = view.getByRole('link', { name: 'Open full GitHub key instructions' }) as HTMLAnchorElement
    expect(instructions.target).toBe('_blank')
    fireEvent.click(view.getByRole('button', { name: 'Copy public key' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(publicKey))

    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    expect(view.getByText('Check the connection')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(view.getByText('Permission denied.')).toBeTruthy())
    expect(view.getByText(/GitHub did not accept this key/).textContent).toContain('Allow write access')
    expect(view.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(view.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(view.getByText('Connection successful')).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    expect(view.getByText('Review notebook connection')).toBeTruthy()
    for (const label of ['Notebook', 'Git service', 'Git server', 'Repository', 'Branch', 'Access method', 'Connection status']) {
      expect(view.getAllByText(label).length).toBeGreaterThan(0)
    }
    expect(view.getByText(/normal Markdown files inside the Git repository/)).toBeTruthy()
    expect(view.getByText(/separately sends saved changes/).textContent).toContain('receives remote changes')
    expect(fetchMock.mock.calls).toHaveLength(3)
  })

  it.each([
    ['authentication_failed', 'GitHub did not accept this key'],
    ['repository_not_found', 'repository could not be opened'],
    ['branch_not_found', 'selected branch does not exist'],
    ['network_failed', 'could not reach the Git server'],
  ])('shows an actionable GitHub %s connection failure without resetting the wizard', async (state, expected) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ state, message: 'Connection test failed.' }))
    const view = render(<SettingsDialog mode="onboarding" autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onClose={vi.fn()} />)
    beginGitHubOnboarding(view)
    fireEvent.change(view.getByLabelText(/Branch/), { target: { value: 'main' } })
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    fireEvent.click(view.getByRole('radio', { name: /Existing server SSH configuration/ }))
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    fireEvent.click(view.getByRole('button', { name: 'Test connection' }))

    await waitFor(() => expect(view.getByText(expected, { exact: false })).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Back' }))
    fireEvent.click(view.getByRole('button', { name: 'Back' }))
    expect((view.getByLabelText('Notebook name') as HTMLInputElement).value).toBe('Private notes')
    expect((view.getByLabelText('GitHub repository address') as HTMLInputElement).value).toBe('git@github.com:fred-head/private-notes.git')
    expect((view.getByLabelText(/Branch/) as HTMLInputElement).value).toBe('main')
  })

  it('clones and activates an existing Git repository', async () => {
    const onNotebookAdded = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ state: 'success', message: 'Connection successful' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'abc', name: 'Private', localPath: '/data/repos/abc', branch: 'main' }))
    const view = render(<SettingsDialog mode="onboarding" autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onNotebookAdded={onNotebookAdded} onClose={onClose} />)
    beginOnboarding(view)
    fireEvent.change(view.getByLabelText(/Branch/), { target: { value: 'main' } })
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    fireEvent.click(view.getByRole('radio', { name: /Existing server SSH configuration/ }))
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    fireEvent.click(view.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(view.getByText('Connection successful')).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    expect(view.getByText('example.test')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Connect notebook' }))
    await waitFor(() => expect(onNotebookAdded).toHaveBeenCalledTimes(1))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ name: 'Private', repositoryUrl: 'git@example.test:user/notes.git', branch: 'main', authType: 'existing-server-ssh', keyId: '' })
  })

  it('keeps the active connection-test and review steps visible', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ state: 'success', message: 'Connection successful' }))
    const view = render(<SettingsDialog mode="onboarding" autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onClose={vi.fn()} />)

    beginOnboarding(view)
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    fireEvent.click(view.getByRole('radio', { name: /Existing server SSH configuration/ }))
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))

    const connectionStep = view.getByText('Check the connection').closest('.space-y-3') as HTMLElement
    expect(window.getComputedStyle(connectionStep).display).not.toBe('none')
    expect(view.queryByLabelText('Notebook name')).toBeNull()

    fireEvent.click(view.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(view.getByText('Connection successful')).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))

    const reviewStep = view.getByText('Review notebook connection').closest('.rounded-md') as HTMLElement
    expect(window.getComputedStyle(reviewStep).display).not.toBe('none')
    expect(view.getByRole('button', { name: 'Connect notebook' })).toBeTruthy()
  })

  it('generates and exposes only a managed public key before connection testing', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const publicKey = 'ssh-ed25519 AAAATEST repoquill-key'
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ keyId: '0123456789abcdef0123456789abcdef', publicKey }, true))
      .mockResolvedValueOnce(jsonResponse({ state: 'authentication_failed', message: 'SSH authentication failed.' }))
    const view = render(<SettingsDialog mode="onboarding" autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onClose={vi.fn()} />)
    beginOnboarding(view)
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    fireEvent.click(view.getByRole('button', { name: 'Generate key' }))
    await waitFor(() => expect(view.getByDisplayValue(publicKey)).toBeTruthy())
    expect(view.container.textContent).not.toContain('PRIVATE KEY')
    fireEvent.click(view.getByRole('button', { name: 'Copy public key' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(publicKey))
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    fireEvent.click(view.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(view.getByText('SSH authentication failed.')).toBeTruthy())
    expect(fetchMock.mock.calls[1][0]).toBe('/api/notebooks/test-connection')
    expect(view.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true)
  })

  it('requires explicit host trust and retries connection after approval', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ keyId: '0123456789abcdef0123456789abcdef', publicKey: 'ssh-ed25519 AAAATEST repoquill-key' }))
      .mockResolvedValueOnce(jsonResponse({ state: 'host_verification_failed', message: 'SSH host verification failed.' }))
      .mockResolvedValueOnce(jsonResponse({ state: 'unknown_host', message: 'Review host.', requestId: 'abcdef0123456789abcdef0123456789', host: 'git.example.test', port: 2222, presentedKeys: [{ keyType: 'ed25519', fingerprint: 'SHA256:presented' }] }))
      .mockResolvedValueOnce(jsonResponse({ state: 'trusted', message: 'SSH host trusted.', host: 'git.example.test', port: 2222, presentedKeys: [{ keyType: 'ed25519', fingerprint: 'SHA256:presented' }] }))
      .mockResolvedValueOnce(jsonResponse({ state: 'authentication_failed', message: 'Host trusted, but authentication failed.' }))
    const view = render(<SettingsDialog mode="onboarding" autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onClose={vi.fn()} />)
    beginOnboarding(view, 'ssh://git@git.example.test:2222/user/notes.git')
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    fireEvent.click(view.getByRole('button', { name: 'Generate key' }))
    await waitFor(() => expect(view.getByText('Key generated')).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    fireEvent.click(view.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(view.getByText('Unknown SSH host')).toBeTruthy())
    expect(view.getByText('git.example.test:2222')).toBeTruthy()
    expect(view.getByText('SHA256:presented')).toBeTruthy()
    expect(fetchMock.mock.calls).toHaveLength(3)
    fireEvent.click(view.getByRole('button', { name: 'Trust this Git server' }))
    await waitFor(() => expect(view.getByText('Host trusted, but authentication failed.')).toBeTruthy())
    expect(fetchMock.mock.calls[3][0]).toBe('/api/notebooks/ssh-host/trust')
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({ requestId: 'abcdef0123456789abcdef0123456789' })
    expect(fetchMock.mock.calls[4][0]).toBe('/api/notebooks/test-connection')
  })

  it('blocks one-click replacement when a trusted host key changed', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ state: 'host_verification_failed', message: 'SSH host verification failed.' }))
      .mockResolvedValueOnce(jsonResponse({ state: 'host_key_changed', message: 'Changed.', host: 'git.example.test', port: 22, presentedKeys: [{ keyType: 'ed25519', fingerprint: 'SHA256:new' }], previouslyTrustedKeys: [{ keyType: 'ed25519', fingerprint: 'SHA256:old' }] }))
    const view = render(<SettingsDialog mode="onboarding" autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onClose={vi.fn()} />)
    beginOnboarding(view, 'git@git.example.test:user/notes.git')
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    fireEvent.click(view.getByRole('radio', { name: /Existing server SSH configuration/ }))
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    fireEvent.click(view.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(view.getByText('SSH host key changed')).toBeTruthy())
    expect(view.getByText('SHA256:new')).toBeTruthy()
    expect(view.getByText('SHA256:old')).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Trust this Git server' })).toBeNull()
    expect(fetchMock.mock.calls).toHaveLength(2)
  })

  it('lists managed keys and deletes only an explicitly confirmed unused key', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const assigned = { keyId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', publicKey: 'ssh-ed25519 ASSIGNED', createdAt: '2026-08-21T10:00:00Z', assigned: true, notebookName: 'Private' }
    const unused = { keyId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', publicKey: 'ssh-ed25519 UNUSED', createdAt: '2026-08-21T11:00:00Z', assigned: false }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ keys: [unused, assigned] }))
      .mockResolvedValueOnce(jsonResponse({ deleted: unused.keyId }))
      .mockResolvedValueOnce(jsonResponse({ keys: [assigned] }))
    const view = render(<SettingsDialog autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onClose={vi.fn()} />)
    expect(view.queryByLabelText('Notebook name')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Load keys' }))
    await waitFor(() => expect(view.getByText('Assigned to Private')).toBeTruthy())
    expect(view.getByText('Unused')).toBeTruthy()
    const assignedCard = view.getByText('Assigned to Private').closest('.rounded-md') as HTMLElement
    expect((assignedCard.querySelector('button:last-of-type') as HTMLButtonElement).disabled).toBe(true)
    const unusedCard = view.getByText('Unused').closest('.rounded-md') as HTMLElement
    fireEvent.click(Array.from(unusedCard.querySelectorAll('button')).find((button) => button.textContent === 'Delete')!)
    expect(view.getByRole('alertdialog', { name: 'Delete unused SSH key?' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Delete key' }))
    await waitFor(() => expect(view.queryByText('Unused')).toBeNull())
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/notebooks/ssh-keys/${unused.keyId}`)
    expect(fetchMock.mock.calls[1][1]?.method).toBe('DELETE')
  })

  it('reuses only an unassigned managed key during onboarding', async () => {
    const available = { keyId: 'cccccccccccccccccccccccccccccccc', publicKey: 'ssh-ed25519 AVAILABLE', fingerprint: 'SHA256:available', createdAt: '2026-08-21T11:00:00Z', assigned: false }
    const assigned = { keyId: 'dddddddddddddddddddddddddddddddd', publicKey: 'ssh-ed25519 ASSIGNED', fingerprint: 'SHA256:assigned', createdAt: '2026-08-21T10:00:00Z', assigned: true, notebookName: 'Work' }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ keys: [available, assigned] }))
    const view = render(<SettingsDialog mode="onboarding" autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onClose={vi.fn()} />)
    beginOnboarding(view)
    fireEvent.click(view.getByRole('button', { name: 'Continue' }))
    fireEvent.click(view.getByRole('radio', { name: 'Use existing key' }))
    const selector = await view.findByLabelText('Existing unassigned key')
    expect(selector.textContent).toContain('SHA256:available')
    expect(selector.textContent).not.toContain('SHA256:assigned')
    fireEvent.change(selector, { target: { value: available.keyId } })
    expect(view.getByDisplayValue(available.publicKey)).toBeTruthy()
  })

  it('exposes only the two timing controls for automatic sync behavior', () => {
    const onSyncPreferences = vi.fn()
    const preferences = { scheduledMinutes: 15 as const, inactivityMinutes: 2 as const, syncOnNotebookSwitch: true, syncOnClose: true, syncOnStartup: true, syncOnFocus: true, syncBeforeOpeningNote: true }
    const view = render(<SettingsDialog autoLockMinutes={0} onAutoLockMinutes={vi.fn()} syncPreferences={preferences} onSyncPreferences={onSyncPreferences} onClose={vi.fn()} />)
    fireEvent.change(view.getByLabelText('Scheduled sync'), { target: { value: '30' } })
    expect(onSyncPreferences).toHaveBeenCalledWith({ ...preferences, scheduledMinutes: 30 })
    fireEvent.change(view.getByLabelText('Sync after editing inactivity'), { target: { value: '5' } })
    expect(onSyncPreferences).toHaveBeenCalledWith({ ...preferences, inactivityMinutes: 5 })
    expect(view.queryByLabelText('Synchronize before switching notebooks')).toBeNull()
    expect(view.queryByText('Notebooks', { selector: 'h3' })).toBeNull()
  })

  it('scans, allows selection, confirms, and deletes only selected assets', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ assets: [
        { path: 'Note.assets/unused.png', size: 2048 },
        { path: 'Note.assets/keep.jpg', size: 1024 },
      ] }))
      .mockResolvedValueOnce(jsonResponse({ deleted: ['Note.assets/unused.png'], failures: [] }))
    const view = render(<SettingsDialog autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onClose={vi.fn()} />)

    fireEvent.click(view.getByRole('button', { name: 'Scan' }))
    await waitFor(() => expect(view.getByText('Note.assets/unused.png')).toBeTruthy())
    const keepCheckbox = view.getByText('Note.assets/keep.jpg').closest('label')!.querySelector('input')!
    fireEvent.click(keepCheckbox)
    fireEvent.click(view.getByRole('button', { name: 'Delete selected (1)' }))

    expect(view.getByRole('alertdialog', { name: 'Delete 1 unreferenced asset?' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Delete assets' }))
    await waitFor(() => expect(view.queryByText('Note.assets/unused.png')).toBeNull())
    expect(view.getByText('Note.assets/keep.jpg')).toBeTruthy()
    expect(fetchMock.mock.calls[1][0]).toBe('/api/repository/assets/cleanup')
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ paths: ['Note.assets/unused.png'] })
  })

  it('reports assets retained by backend revalidation', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ assets: [{ path: 'Note.assets/race.png', size: 10 }] }))
      .mockResolvedValueOnce(jsonResponse({ deleted: [], failures: [{ path: 'Note.assets/race.png', error: 'asset is referenced or no longer eligible' }] }))
    const view = render(<SettingsDialog autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onClose={vi.fn()} />)

    fireEvent.click(view.getByRole('button', { name: 'Scan' }))
    await waitFor(() => expect(view.getByText('Note.assets/race.png')).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Delete selected (1)' }))
    fireEvent.click(view.getByRole('button', { name: 'Delete assets' }))
    await waitFor(() => expect(view.getByText('Some assets were kept:')).toBeTruthy())
    expect(view.getAllByText(/asset is referenced or no longer eligible/).length).toBeGreaterThan(0)
  })

  it('shows security administration, active sessions, and the running version', async () => {
    setCSRFToken('csrf-before')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (input === '/api/auth/security') return jsonResponse({ sessionSettings: { lifetimeHours: 12, idleHours: 168, rememberDays: 30 } })
      if (input === '/api/auth/sessions') return jsonResponse({ sessions: [{ id: 'opaque-id', createdAt: '2026-08-27T08:00:00Z', lastActivityAt: '2026-08-27T09:00:00Z', idleExpiresAt: '2026-09-03T09:00:00Z', absoluteExpiresAt: '2026-08-27T20:00:00Z', clientDescription: 'Firefox on Linux', current: true }] })
      if (input === '/api/auth/password' && init?.method === 'PUT') return jsonResponse({ csrfToken: 'csrf-after' })
      return jsonResponse({ error: 'unexpected request' }, false)
    })
    const view = render(<SettingsDialog authMode="local" runningVersion="0.2.0-alpha.2" autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onClose={vi.fn()} />)

    await waitFor(() => expect(view.getByText('Firefox on Linux')).toBeTruthy())
    expect(view.getByText(/RepoQuill 0.2.0-alpha.2/)).toBeTruthy()
    expect(view.getByText('· Current')).toBeTruthy()

    const passwordForm = view.getAllByText('Change password').find((element) => element.tagName === 'H4')!.closest('form')!
    fireEvent.change(passwordForm.querySelector('input[name="currentPassword"]')!, { target: { value: 'old-password-123' } })
    fireEvent.change(view.getByLabelText('New password'), { target: { value: 'new-password-123' } })
    fireEvent.change(view.getByLabelText('Confirm new password'), { target: { value: 'new-password-123' } })
    fireEvent.click(view.getByRole('button', { name: 'Change password' }))
    await waitFor(() => expect(view.getByText('Password changed. All other sessions were signed out.')).toBeTruthy())
    const passwordRequest = fetchMock.mock.calls.find(([url]) => url === '/api/auth/password')
    expect(new Headers(passwordRequest?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-before')
  })

  it('requires recovery-code confirmation before activating MFA', async () => {
    let enabled = false
    const recoveryCodes = ['AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', 'FFFFF-GGGGG-HHHHH-IIIII-JJJJJ']
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (input === '/api/auth/security') return jsonResponse({ sessionSettings: { lifetimeHours: 12, idleHours: 168, rememberDays: 30 }, mfaEnabled: enabled })
      if (input === '/api/auth/sessions') return jsonResponse({ sessions: [] })
		if (input === '/api/auth/mfa/enroll') return jsonResponse({ secret: 'BASE32SECRET', qrCode: 'data:image/png;base64,AAAA', recoveryCodes })
		if (input === '/api/auth/mfa/enrollment' && init?.method === 'DELETE') return jsonResponse({ cancelled: true })
      if (input === '/api/auth/mfa/confirm') { enabled = true; return jsonResponse({ mfaEnabled: true }) }
      return jsonResponse({ error: `unexpected ${String(input)} ${init?.method}` }, false)
    })
    const view = render(<SettingsDialog authMode="local" autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onClose={vi.fn()} />)
    await waitFor(() => expect(view.getByRole('button', { name: 'Set up authenticator' })).toBeTruthy())
    fireEvent.change(view.container.querySelector('input[name="mfaPassword"]')!, { target: { value: 'a sufficiently long password' } })
    fireEvent.click(view.getByRole('button', { name: 'Set up authenticator' }))
		expect(await view.findByAltText('TOTP enrollment QR code')).toBeTruthy()
		expect(view.getByText(recoveryCodes[0])).toBeTruthy()
		fireEvent.click(view.getByRole('button', { name: 'Cancel setup' }))
		await waitFor(() => expect(view.getByRole('button', { name: 'Set up authenticator' })).toBeTruthy())
		expect(vi.mocked(globalThis.fetch).mock.calls.some(([url, init]) => url === '/api/auth/mfa/enrollment' && init?.method === 'DELETE')).toBe(true)
		fireEvent.change(view.container.querySelector('input[name="mfaPassword"]')!, { target: { value: 'a sufficiently long password' } })
		fireEvent.click(view.getByRole('button', { name: 'Set up authenticator' }))
		expect(await view.findByAltText('TOTP enrollment QR code')).toBeTruthy()
		expect((view.getByRole('button', { name: 'Enable MFA' }) as HTMLButtonElement).form?.checkValidity()).toBe(false)
    fireEvent.click(view.getByLabelText('I stored these recovery codes safely.'))
    fireEvent.change(view.getByLabelText('Current code from the new authenticator'), { target: { value: '123456' } })
    fireEvent.click(view.getByRole('button', { name: 'Enable MFA' }))
    await waitFor(() => expect(view.getByText('Two-factor authentication enabled.')).toBeTruthy())
  })

  it('shows a persistent explicit warning when built-in authentication is disabled', () => {
    const view = render(<SettingsDialog authMode="disabled" autoLockMinutes={0} onAutoLockMinutes={vi.fn()} onClose={vi.fn()} />)
    expect(view.getByRole('alert').textContent).toContain('Built-in authentication is disabled')
    expect(view.getByRole('alert').textContent).toContain('forward-auth')
  })
})
