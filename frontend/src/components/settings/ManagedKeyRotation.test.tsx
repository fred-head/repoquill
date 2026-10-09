// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedKeyRotation } from './ManagedKeyRotation'
import { setCSRFToken } from '../../api'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setCSRFToken()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
})

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 502, json: async () => body } as Response
}

const oldKey = {
  keyId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  publicKey: 'ssh-ed25519 OLD',
  assigned: true,
  assignments: [{ notebookId: 'notebook-1', notebookName: 'Private' }],
}
const replacement = {
  keyId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  publicKey: 'ssh-ed25519 NEW repoquill-new',
  fingerprint: 'SHA256:replacement',
}
const notebook = { id: 'notebook-1', name: 'Private', remoteUrl: 'git@example.test:owner/notes.git', branch: 'main' }

describe('managed SSH key rotation', () => {
  it('tests the replacement, asks for confirmation, and switches only the selected notebook', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const onChanged = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ notebooks: [notebook] }))
      .mockResolvedValueOnce(jsonResponse(replacement))
      .mockResolvedValueOnce(jsonResponse({ state: 'success', message: 'Repository connection successful.' }))
      .mockResolvedValueOnce(jsonResponse({ notebookId: notebook.id, keyId: replacement.keyId }))
    const view = render(<ManagedKeyRotation keyInfo={oldKey} onChanged={onChanged} />)

    fireEvent.click(view.getByRole('button', { name: 'Rotate…' }))
    await waitFor(() => expect(view.getByText(notebook.remoteUrl)).toBeTruthy())
    expect(view.getByRole('dialog').className).toContain('max-h-[92vh]')
    fireEvent.click(view.getByRole('button', { name: 'Generate replacement key' }))
    await waitFor(() => expect(view.getByDisplayValue(replacement.publicKey)).toBeTruthy())
    expect(view.getByText(new RegExp(`Fingerprint: ${replacement.fingerprint}`))).toBeTruthy()
    expect(view.getByText(/private key stays on this server/i)).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(view.getByText('Repository connection successful.')).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Review key switch…' }))
    const confirmation = view.getByRole('alertdialog', { name: `Switch ${notebook.name} to the replacement key?` })
    expect(confirmation).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Confirm and switch' }))
    await waitFor(() => expect(view.getByText('Notebook key updated')).toBeTruthy())

    expect(fetchMock.mock.calls[2][0]).toBe('/api/notebooks/test-connection')
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({ authType: 'managed-ssh', keyId: replacement.keyId, repositoryUrl: notebook.remoteUrl })
    expect(fetchMock.mock.calls[3][0]).toBe(`/api/notebooks/${notebook.id}/ssh-key`)
    expect(fetchMock.mock.calls[3][1]?.method).toBe('PATCH')
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({ expectedKeyId: oldKey.keyId, keyId: replacement.keyId })
    expect(onChanged).toHaveBeenCalledTimes(2)
    expect(view.container.textContent).not.toContain('PRIVATE KEY')
  })

  it('requires explicit trust for a new host and retests before allowing a switch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ notebooks: [notebook] }))
      .mockResolvedValueOnce(jsonResponse(replacement))
      .mockResolvedValueOnce(jsonResponse({ state: 'host_verification_failed', message: 'SSH host verification failed.' }))
      .mockResolvedValueOnce(jsonResponse({ state: 'unknown_host', message: 'Review host identity.', requestId: 'opaque-request', host: 'example.test', port: 22, presentedKeys: [{ keyType: 'ED25519', fingerprint: 'SHA256:presented' }] }))
      .mockResolvedValueOnce(jsonResponse({ state: 'unknown_host', message: 'Host trusted.' }))
      .mockResolvedValueOnce(jsonResponse({ state: 'success', message: 'Repository connection successful.' }))
    const view = render(<ManagedKeyRotation keyInfo={oldKey} onChanged={vi.fn().mockResolvedValue(undefined)} />)

    fireEvent.click(view.getByRole('button', { name: 'Rotate…' }))
    await waitFor(() => expect(view.getByText(notebook.remoteUrl)).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Generate replacement key' }))
    await waitFor(() => expect(view.getByDisplayValue(replacement.publicKey)).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(view.getByText('SHA256:presented')).toBeTruthy())
    expect(view.queryByRole('button', { name: 'Review key switch…' })).toBeNull()

    fireEvent.click(view.getByRole('button', { name: 'Trust this Git server and retest' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Review key switch…' })).toBeTruthy())
    expect(fetchMock.mock.calls[4][0]).toBe('/api/notebooks/ssh-host/trust')
    expect(fetchMock.mock.calls[5][0]).toBe('/api/notebooks/test-connection')
  })

  it('keeps the old key assigned to notebooks that have not been rotated yet', async () => {
    const multipleAssignments = {
      ...oldKey,
      assignments: [
        ...oldKey.assignments,
        { notebookId: 'notebook-2', notebookName: 'Work' },
      ],
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ notebooks: [notebook, { ...notebook, id: 'notebook-2', name: 'Work' }] }))
      .mockResolvedValueOnce(jsonResponse(replacement))
      .mockResolvedValueOnce(jsonResponse({ state: 'success', message: 'Repository connection successful.' }))
      .mockResolvedValueOnce(jsonResponse({ notebookId: notebook.id, keyId: replacement.keyId }))
    const view = render(<ManagedKeyRotation keyInfo={multipleAssignments} onChanged={vi.fn().mockResolvedValue(undefined)} />)

    fireEvent.click(view.getByRole('button', { name: 'Rotate…' }))
    await waitFor(() => expect(view.getByLabelText('Notebook to rotate')).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Generate replacement key' }))
    await waitFor(() => expect(view.getByDisplayValue(replacement.publicKey)).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Review key switch…' })).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Review key switch…' }))
    fireEvent.click(view.getByRole('button', { name: 'Confirm and switch' }))

    await waitFor(() => expect(view.getByText('Notebook key updated')).toBeTruthy())
    expect(view.getByText('Work')).toBeTruthy()
    expect(view.getByText(/Keep its provider entry until each one is rotated/)).toBeTruthy()
    expect(fetchMock.mock.calls[3][0]).toBe(`/api/notebooks/${notebook.id}/ssh-key`)
  })
})
