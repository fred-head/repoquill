// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthGate } from './AuthGate'

afterEach(()=>{cleanup();vi.restoreAllMocks();localStorage.clear();sessionStorage.clear()})
beforeEach(()=>{Object.defineProperty(window,'matchMedia',{configurable:true,value:vi.fn().mockReturnValue({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()})})})

describe('browser authentication lifecycle',()=>{
  it('shows first-run setup as a responsive application screen',async()=>{
    vi.spyOn(globalThis,'fetch').mockImplementation(async(input)=>{
      const url=String(input)
      if(url==='/api/auth/status')return Response.json({mode:'local',setupRequired:true,authenticated:false})
      if(url==='/api/health')return Response.json({status:'ok',version:'dev'})
      return Response.json({})
    })
    const view=render(<AuthGate/>)
    expect(await view.findByRole('heading',{name:'Set up your owner password'})).toBeTruthy()
    expect(view.getByLabelText('One-time setup token')).toBeTruthy()
    expect(view.getAllByLabelText(/password/i)).toHaveLength(2)
  })

  it('logs in without storing credentials in browser storage',async()=>{
    let authenticated=false
    vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      const url=String(input)
      if(url==='/api/auth/status')return Response.json({mode:'local',setupRequired:false,authenticated,csrfToken:authenticated?'csrf':''})
      if(url==='/api/auth/login'){authenticated=true;return Response.json({authenticated:true,csrfToken:'csrf'})}
      if(url==='/api/health')return Response.json({status:'ok',version:'dev'})
      if(url==='/api/repository/tree')return Response.json({entries:[]})
      if(url==='/api/notebook')return Response.json({name:'Notebook',configured:false})
      if(url==='/api/notebooks')return Response.json({activeId:'',notebooks:[]})
      if(url==='/api/repository/git/status')return Response.json({state:'invalid'})
      return Response.json({}, {status:init?.method==='POST'?200:404})
    })
    const view=render(<AuthGate/>)
    fireEvent.change(await view.findByLabelText('Password'),{target:{value:'a sufficiently long password'}})
    fireEvent.click(view.getByLabelText('Remember this device'))
    fireEvent.click(view.getByRole('button',{name:'Sign in'}))
    await waitFor(()=>expect(view.getByText('No notebook yet')).toBeTruthy())
    expect(localStorage.getItem('repoquill.password')).toBeNull()
    expect(sessionStorage.getItem('repoquill.password')).toBeNull()
  })
})
