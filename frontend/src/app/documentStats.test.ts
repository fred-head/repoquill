import { describe, expect, it } from 'vitest'
import { documentStats } from './documentStats'

describe('documentStats', () => {
  it('counts prose without treating Markdown punctuation as words', () => {
    expect(documentStats('# Hello **wide world**')).toEqual({ words: 3, characters: 22, lines: 1 })
  })

  it('counts Unicode characters and common line endings', () => {
    expect(documentStats('Grüße 👋\r\nNeue Zeile')).toEqual({ words: 3, characters: 19, lines: 2 })
  })

  it('reports an empty document without an artificial line', () => {
    expect(documentStats('')).toEqual({ words: 0, characters: 0, lines: 0 })
  })
})
