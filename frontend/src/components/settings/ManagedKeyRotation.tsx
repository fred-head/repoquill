import { useState } from 'react'
import { apiFetch } from '../../api'

type KeyAssignment = { notebookId: string; notebookName: string }
type ManagedSSHKey = {
  keyId: string
  publicKey: string
  fingerprint?: string
  assigned: boolean
  assignments?: KeyAssignment[]
}
type Notebook = { id: string; name: string; remoteUrl?: string; branch?: string }
type ConnectionResult = { state: string; message: string }
type HostKey = { keyType: string; fingerprint: string }
type HostTrust = {
  state: string
  message: string
  requestId?: string
  host: string
  port: number
  presentedKeys: HostKey[]
  previouslyTrustedKeys?: HostKey[]
}
type ReplacementKey = { keyId: string; publicKey: string; fingerprint: string }

async function responseJSON<T>(response: Response): Promise<T> {
  let body: T & { error?: string; message?: string }
  try {
    body = await response.json() as T & { error?: string; message?: string }
  } catch {
    throw new Error(`Request failed (${response.status})`)
  }
  if (!response.ok) throw new Error(body.message || body.error || `Request failed (${response.status})`)
  return body
}

export function ManagedKeyRotation({ keyInfo, onChanged }: { keyInfo: ManagedSSHKey; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [notebooksBusy, setNotebooksBusy] = useState(false)
  const [notebookID, setNotebookID] = useState('')
  const [replacement, setReplacement] = useState<ReplacementKey>()
  const [connection, setConnection] = useState<ConnectionResult>()
  const [hostTrust, setHostTrust] = useState<HostTrust>()
  const [busy, setBusy] = useState(false)
  const [trustBusy, setTrustBusy] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [switched, setSwitched] = useState(false)
  const [rotatedNotebookID, setRotatedNotebookID] = useState('')

  const assignments = keyInfo.assignments ?? []
  const selectedNotebook = notebooks.find((notebook) => notebook.id === notebookID)
  const selectedAssignment = assignments.find((assignment) => assignment.notebookId === notebookID)
  const remainingAssignments = assignments.filter((assignment) => assignment.notebookId !== (switched ? rotatedNotebookID : notebookID))

  async function beginRotation() {
    setOpen(true)
    setNotebooksBusy(true)
    setError('')
    setReplacement(undefined)
    setConnection(undefined)
    setHostTrust(undefined)
    setSwitched(false)
    setRotatedNotebookID('')
    setConfirming(false)
    setCopyStatus('')
    const nextNotebookID = assignments[0]?.notebookId ?? ''
    setNotebookID(nextNotebookID)
    try {
      const response = await apiFetch('/api/notebooks')
      const data = await responseJSON<{ notebooks: Notebook[] }>(response)
      setNotebooks(data.notebooks)
      if (!data.notebooks.some((notebook) => notebook.id === nextNotebookID) && nextNotebookID) {
        setError('The assigned notebook could not be found. Refresh the key list and try again.')
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Notebook details could not be loaded.')
    } finally {
      setNotebooksBusy(false)
    }
  }

  function changeNotebook(nextNotebookID: string) {
    setNotebookID(nextNotebookID)
    setReplacement(undefined)
    setConnection(undefined)
    setHostTrust(undefined)
    setCopyStatus('')
    setError('')
  }

  async function generateReplacement() {
    setBusy(true)
    setError('')
    try {
      const response = await apiFetch('/api/notebooks/ssh-key', { method: 'POST' })
      setReplacement(await responseJSON<ReplacementKey>(response))
      setConnection(undefined)
      setHostTrust(undefined)
      await onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'A replacement key could not be generated.')
    } finally {
      setBusy(false)
    }
  }

  async function testConnection() {
    if (!replacement || !selectedNotebook?.remoteUrl) return
    setBusy(true)
    setError('')
    setConnection(undefined)
    setHostTrust(undefined)
    try {
      const response = await apiFetch('/api/notebooks/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repositoryUrl: selectedNotebook.remoteUrl,
          branch: selectedNotebook.branch ?? '',
          authType: 'managed-ssh',
          keyId: replacement.keyId,
        }),
      })
      const result = await responseJSON<ConnectionResult>(response)
      setConnection(result)
      if (result.state === 'host_verification_failed') {
        const discoveryResponse = await apiFetch('/api/notebooks/ssh-host/discover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repositoryUrl: selectedNotebook.remoteUrl }),
        })
        setHostTrust(await responseJSON<HostTrust>(discoveryResponse))
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The repository connection test failed.')
    } finally {
      setBusy(false)
    }
  }

  async function trustHost() {
    if (!hostTrust?.requestId) return
    setTrustBusy(true)
    setError('')
    try {
      const response = await apiFetch('/api/notebooks/ssh-host/trust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: hostTrust.requestId }),
      })
      await responseJSON<HostTrust>(response)
      setHostTrust(undefined)
      await testConnection()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The SSH host could not be trusted.')
    } finally {
      setTrustBusy(false)
    }
  }

  async function switchNotebookKey() {
    if (!replacement || !selectedNotebook) return
    setBusy(true)
    setError('')
    try {
      const response = await apiFetch(`/api/notebooks/${encodeURIComponent(selectedNotebook.id)}/ssh-key`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedKeyId: keyInfo.keyId, keyId: replacement.keyId }),
      })
      await responseJSON<{ notebookId: string; keyId: string }>(response)
      setRotatedNotebookID(selectedNotebook.id)
      setSwitched(true)
      setConfirming(false)
      await onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The notebook key could not be changed.')
    } finally {
      setBusy(false)
    }
  }

  async function copyPublicKey() {
    if (!replacement) return
    try {
      await navigator.clipboard.writeText(replacement.publicKey)
      setCopyStatus('Public key copied')
    } catch {
      setCopyStatus('Copy failed. Select and copy the public key manually.')
    }
  }

  function close() {
    if (busy || trustBusy) return
    setOpen(false)
    setConfirming(false)
  }

  return <>
    {assignments.length > 0 && <button type="button" onClick={() => void beginRotation()} className="min-h-10 rounded-md px-3 text-xs text-amber-300 hover:bg-zinc-800">Rotate…</button>}
    {open && <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/75 p-3 sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <div role="dialog" aria-modal="true" aria-labelledby="rotate-key-title" className="flex max-h-[92vh] w-full max-w-xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <header className="border-b border-zinc-800 px-5 py-4">
          <h2 id="rotate-key-title" className="text-lg font-semibold">Rotate managed SSH key</h2>
          <p className="mt-1 text-xs leading-5 text-zinc-400">The current key stays assigned until a replacement passes its connection test and you confirm the switch.</p>
        </header>
        <div className="min-h-0 space-y-4 overflow-y-auto p-4 sm:p-5">
          {error && <p role="alert" className="rounded-md border border-red-900/70 bg-red-950/30 p-3 text-xs leading-5 text-red-200">{error}</p>}
          {assignments.length > 1 && !switched && <label className="block text-xs text-zinc-300">Notebook to rotate<select aria-label="Notebook to rotate" disabled={busy || !!replacement} value={notebookID} onChange={(event) => changeNotebook(event.target.value)} className="mt-1.5 min-h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 disabled:opacity-50">{assignments.map((assignment) => <option key={assignment.notebookId} value={assignment.notebookId}>{assignment.notebookName}</option>)}</select></label>}
          {notebooksBusy && <p role="status" className="text-xs text-zinc-500">Loading notebook details…</p>}
          {!notebooksBusy && selectedAssignment && !selectedNotebook && <p role="alert" className="text-xs text-red-300">The assigned notebook is no longer registered.</p>}
          {selectedNotebook && <div className="rounded-md border border-zinc-800 p-3 text-xs">
            <p className="font-medium text-zinc-100">{selectedNotebook.name}</p>
            <p className="mt-1 break-all text-zinc-500">{selectedNotebook.remoteUrl}</p>
            <p className="mt-1 text-zinc-500">Branch: {selectedNotebook.branch || 'Remote default'}</p>
          </div>}

          {!replacement && <section className="rounded-md border border-zinc-800 p-3">
            <h3 className="text-sm font-medium text-zinc-100">1. Generate a replacement</h3>
            <p className="mt-1 text-xs leading-5 text-zinc-400">RepoQuill creates a separate key. The current private key is not changed.</p>
            <button type="button" disabled={busy || notebooksBusy || !selectedNotebook} onClick={() => void generateReplacement()} className="mt-3 min-h-10 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">{busy ? 'Generating…' : 'Generate replacement key'}</button>
          </section>}

          {replacement && !switched && <>
            <section className="rounded-md border border-zinc-800 p-3">
              <h3 className="text-sm font-medium text-zinc-100">2. Register the public key</h3>
              <p className="mt-1 text-xs leading-5 text-zinc-400">Add this public key to the repository at your Git provider. Grant write access if RepoQuill must synchronize changes back to it. The private key stays on this server.</p>
              <label className="mt-3 block text-xs text-zinc-300">Public key<textarea readOnly rows={3} value={replacement.publicKey} className="mt-1.5 w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-[11px] leading-4 text-zinc-300" /></label>
              <p className="mt-2 break-all font-mono text-[10px] text-zinc-500">Fingerprint: {replacement.fingerprint || 'unavailable'}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2"><button type="button" onClick={() => void copyPublicKey()} className="min-h-10 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-800">Copy public key</button><span role="status" className="text-[11px] text-zinc-500">{copyStatus}</span></div>
            </section>

            <section className="rounded-md border border-zinc-800 p-3">
              <h3 className="text-sm font-medium text-zinc-100">3. Test host trust and repository access</h3>
              <p className="mt-1 text-xs leading-5 text-zinc-400">The test uses the replacement key and the notebook’s existing repository. Host fingerprints remain subject to explicit review.</p>
              <button type="button" disabled={busy || trustBusy || !selectedNotebook?.remoteUrl} onClick={() => void testConnection()} className="mt-3 min-h-10 rounded-md bg-amber-500 px-4 text-xs font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40">{busy ? 'Testing…' : 'Test connection'}</button>
              {connection && <p role="status" className={`mt-3 text-xs leading-5 ${connection.state === 'success' ? 'text-emerald-400' : 'text-red-300'}`}>{connection.message}</p>}
              {hostTrust && <div className={`mt-3 rounded-md border p-3 ${hostTrust.state === 'host_key_changed' ? 'border-red-700 bg-red-950/30' : 'border-amber-700/70 bg-amber-950/20'}`}>
                <h4 className="text-sm font-semibold text-zinc-100">{hostTrust.state === 'host_key_changed' ? 'SSH host key changed' : 'Unknown SSH host'}</h4>
                <p className="mt-2 text-xs text-zinc-300">Git server: {hostTrust.host}{hostTrust.port !== 22 ? `:${hostTrust.port}` : ''}</p>
                <FingerprintList title="Presented fingerprints" keys={hostTrust.presentedKeys} />
                {hostTrust.previouslyTrustedKeys && <FingerprintList title="Previously trusted fingerprints" keys={hostTrust.previouslyTrustedKeys} />}
                <p className="mt-3 text-xs leading-5 text-zinc-400">{hostTrust.state === 'host_key_changed' ? 'The server identity differs from the one RepoQuill previously trusted. The connection is blocked. Verify the change independently before changing host trust.' : 'Compare these fingerprints with a trusted source before approving this Git server.'}</p>
                {hostTrust.state === 'unknown_host' && hostTrust.requestId && <button type="button" disabled={trustBusy} onClick={() => void trustHost()} className="mt-3 min-h-10 rounded-md bg-amber-500 px-3 text-xs font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40">{trustBusy ? 'Trusting…' : 'Trust this Git server and retest'}</button>}
              </div>}
              {connection?.state === 'success' && <button type="button" onClick={() => setConfirming(true)} className="mt-3 min-h-10 rounded-md border border-emerald-800 px-3 text-xs text-emerald-300 hover:bg-emerald-950/40">Review key switch…</button>}
            </section>
            <p className="text-[11px] leading-5 text-zinc-500">If you close this flow after generating a key, it remains unused in RepoQuill and can be deleted from the key list.</p>
          </>}

          {switched && <section role="status" className="rounded-md border border-emerald-800/70 bg-emerald-950/20 p-3 text-xs leading-5 text-zinc-200">
            <h3 className="font-semibold text-emerald-300">Notebook key updated</h3>
            {remainingAssignments.length > 0 ? <>
              <p className="mt-2">The old key remains assigned to these notebooks. Keep its provider entry until each one is rotated:</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">{remainingAssignments.map((assignment) => <li key={assignment.notebookId}>{assignment.notebookName}</li>)}</ul>
            </> : <p className="mt-2">The old key is now unused. Remove its public key from the Git provider, then optionally delete the local key from the key list.</p>}
            <p className="mt-2 text-zinc-400">If access to the replacement is later revoked, the old key remains available locally for recovery as long as it is still authorized by the provider.</p>
          </section>}
        </div>
        <footer className="flex justify-end border-t border-zinc-800 p-4"><button type="button" onClick={close} disabled={busy || trustBusy} className="min-h-10 rounded-md border border-zinc-700 px-4 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">{switched ? 'Done' : 'Close'}</button></footer>
      </div>
      {confirming && replacement && selectedNotebook && <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-4">
        <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-key-switch-title" className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
          <h3 id="confirm-key-switch-title" className="text-lg font-semibold">Switch {selectedNotebook.name} to the replacement key?</h3>
          <p className="mt-3 text-sm leading-6 text-zinc-400">RepoQuill will test repository access again, then update this notebook’s saved key assignment. The current key files will remain unchanged.</p>
          <p className="mt-2 break-all font-mono text-[11px] text-zinc-500">Replacement fingerprint: {replacement.fingerprint || 'unavailable'}</p>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" disabled={busy} onClick={() => setConfirming(false)} className="min-h-11 rounded-md border border-zinc-700 px-4 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button><button type="button" disabled={busy} onClick={() => void switchNotebookKey()} className="min-h-11 rounded-md bg-amber-500 px-4 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40">{busy ? 'Testing and switching…' : 'Confirm and switch'}</button></div>
        </div>
      </div>}
    </div>}
  </>
}

function FingerprintList({ title, keys }: { title: string; keys: HostKey[] }) {
  return <div className="mt-3"><p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{title}</p><ul className="mt-1 space-y-2">{keys.map((key) => <li key={`${key.keyType}:${key.fingerprint}`} className="rounded border border-zinc-700/80 bg-zinc-950/60 p-2"><span className="text-xs font-medium uppercase text-zinc-300">{key.keyType}</span><code className="mt-1 block break-all text-[11px] leading-5 text-zinc-300">{key.fingerprint}</code></li>)}</ul></div>
}
