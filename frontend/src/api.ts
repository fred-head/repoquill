export type AuthStatus = {
  mode: 'local' | 'disabled'
  setupRequired: boolean
  authenticated: boolean
  csrfToken?: string
}

let csrfToken = ''
const authRequiredEvent = 'repoquill:auth-required'
const authChangedEvent = 'repoquill:auth-changed'
const channelName = 'repoquill-auth'

export function setCSRFToken(token?: string) {
  csrfToken = token ?? ''
}

export function currentCSRFToken() { return csrfToken }

export class AuthStatusError extends Error { constructor(message:string, readonly kind:'backend'|'update'){super(message)} }

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) headers.set('X-CSRF-Token', csrfToken)
  const response = await fetch(input, { ...init, headers })
  if (response.status === 401) {
    setCSRFToken()
    window.dispatchEvent(new CustomEvent(authRequiredEvent))
  }
  return response
}

export async function authStatus(signal?: AbortSignal): Promise<AuthStatus> {
  const response = await fetch('/api/auth/status', { signal, cache: 'no-store' })
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) throw new AuthStatusError('The frontend does not match the backend.', 'update')
  const body = await response.json() as AuthStatus & { error?: string }
  if (response.status === 404) throw new AuthStatusError('The backend does not support this frontend authentication contract.', 'update')
  if (!response.ok) throw new AuthStatusError(body.error ?? `Authentication status failed (${response.status})`, 'backend')
  setCSRFToken(body.csrfToken)
  return body
}

export function notifyAuthChanged() {
  window.dispatchEvent(new CustomEvent(authChangedEvent))
  if ('BroadcastChannel' in window) {
    const channel = new BroadcastChannel(channelName)
    channel.postMessage('changed')
    channel.close()
  }
}

export function listenForAuthEvents(onRequired: () => void, onChanged: () => void): () => void {
  const required = () => onRequired()
  const changed = () => onChanged()
  window.addEventListener(authRequiredEvent, required)
  window.addEventListener(authChangedEvent, changed)
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel(channelName) : undefined
  if (channel) channel.onmessage = changed
  return () => {
    window.removeEventListener(authRequiredEvent, required)
    window.removeEventListener(authChangedEvent, changed)
    channel?.close()
  }
}
