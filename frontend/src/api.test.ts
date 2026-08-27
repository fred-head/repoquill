// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, setCSRFToken } from './api'

afterEach(()=>{vi.restoreAllMocks();setCSRFToken();localStorage.clear();sessionStorage.clear()})

describe('authenticated API client',()=>{
  it('adds the in-memory CSRF token only to state-changing requests',async()=>{
    const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({ok:true}))
    setCSRFToken('session-csrf')
    await apiFetch('/api/read')
    await apiFetch('/api/write',{method:'POST'})
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('X-CSRF-Token')).toBeNull()
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('X-CSRF-Token')).toBe('session-csrf')
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('announces session expiry without turning it into a Git error',async()=>{
    vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({code:'authentication_required'},{status:401}))
    const listener=vi.fn();window.addEventListener('repoquill:auth-required',listener)
    await apiFetch('/api/repository/git/status')
    expect(listener).toHaveBeenCalledOnce()
    window.removeEventListener('repoquill:auth-required',listener)
  })
})
