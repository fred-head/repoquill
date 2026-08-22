// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { MarkdownEditor } from './MarkdownEditor'

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub)

beforeEach(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MarkdownEditor read-only mode', () => {
  it('mounts in Edit and Read only without losing the document', async () => {
    const properties = { notePath: 'Note.md', markdown: '# Visible note', onChange: vi.fn() }
    const view = render(<MarkdownEditor key="edit" documentKey="edit" readOnly={false} {...properties} />)
    await waitFor(() => expect(view.container.textContent).toContain('Visible note'))
    expect(view.container.querySelector('.ProseMirror')?.getAttribute('contenteditable')).toBe('true')

    view.rerender(<MarkdownEditor key="read" documentKey="read" readOnly {...properties} />)
    await waitFor(() => expect(view.container.textContent).toContain('Visible note'))
    expect(view.container.querySelector('.ProseMirror')?.getAttribute('contenteditable')).toBe('false')
    expect(view.getByRole('button', { name: 'Bold' }).hasAttribute('disabled')).toBe(true)
  })

  it('applies a heading and inserts the selected portable GFM table size', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="toolbar" notePath="Note.md" markdown="Text" readOnly={false} onChange={onChange} />)
    await waitFor(() => expect(view.container.textContent).toContain('Text'))
    fireEvent.change(view.getByLabelText('Block type'), { target: { value: 'heading-2' } })
    await waitFor(() => expect(onChange.mock.calls.some(([markdown]) => String(markdown).startsWith('## Text'))).toBe(true))
    fireEvent.click(view.getByRole('button', { name: 'Insert table' }))
    expect(view.getByRole('dialog', { name: 'Insert table' })).toBeTruthy()
    expect(view.getAllByRole('gridcell')).toHaveLength(100)
    fireEvent.pointerEnter(view.getByRole('gridcell', { name: 'Insert 4 columns by 3 rows' }))
    expect(view.getByText(/4 × 3/)).toBeTruthy()
    fireEvent.click(view.getByRole('gridcell', { name: 'Insert 4 columns by 3 rows' }))
    await waitFor(() => {
      const tableMarkdown = onChange.mock.calls.map(([value]) => String(value)).find((value) => value.includes('|'))
      expect(tableMarkdown).toBeTruthy()
      const lines = tableMarkdown!.split('\n').filter((line) => line.startsWith('|'))
      expect(lines).toHaveLength(4) // header, separator and two body rows
      expect(lines[0].split('|')).toHaveLength(6) // four cells plus outer separators
    })
  })

  it('edits the current table structurally, supports undo, and deletes it', async () => {
    const onChange = vi.fn()
    const markdown = '| A | B |\n| --- | --- |\n| 1 | 2 |'
    const view = render(<MarkdownEditor documentKey="table-edit" notePath="Note.md" markdown={markdown} readOnly={false} onChange={onChange} />)

    await waitFor(() => expect(view.getByRole('toolbar', { name: 'Table editing' })).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Add row below' }))
    await waitFor(() => expect(onChange.mock.calls.some(([value]) => String(value).split('\n').filter((line) => line.startsWith('|')).length === 4)).toBe(true))

    fireEvent.click(view.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0]).split('\n').filter((line) => line.startsWith('|'))).toHaveLength(3))

    fireEvent.click(view.getByRole('button', { name: 'Add column right' }))
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0]).split('\n')[0].split('|')).toHaveLength(5))
    fireEvent.click(view.getByRole('button', { name: 'Delete current column' }))
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0]).split('\n')[0].split('|')).toHaveLength(4))

    fireEvent.click(view.getByRole('button', { name: 'Delete table' }))
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0])).not.toContain('|'))
  })

  it('shows table controls on the first pointer interaction with a table', async () => {
    const markdown = 'Intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |'
    const view = render(<MarkdownEditor documentKey="table-pointer" notePath="Note.md" markdown={markdown} readOnly={false} onChange={vi.fn()} />)
    await waitFor(() => expect(view.container.querySelector('table')).toBeTruthy())
    expect(view.queryByRole('toolbar', { name: 'Table editing' })).toBeNull()

    fireEvent.pointerDown(view.container.querySelector('td')!)
    expect(view.getByRole('toolbar', { name: 'Table editing' })).toBeTruthy()
  })

  it('replaces an image reference with a new asset and removes only its Markdown node', async () => {
    const onChange = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ path: 'Note.assets/new-image.png' }),
    } as Response)
    const markdown = 'Before ![Diagram](<Note.assets/old-image.png>) after'
    const view = render(<MarkdownEditor documentKey="image-edit" notePath="Note.md" markdown={markdown} readOnly={false} onChange={onChange} />)
    const image = await waitFor(() => {
      const element = view.container.querySelector('img')
      expect(element).toBeTruthy()
      return element!
    })

    fireEvent.pointerDown(image)
    await waitFor(() => expect(view.getByRole('toolbar', { name: 'Image editing' })).toBeTruthy())
    expect(view.getByRole('button', { name: 'Alt text' })).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'Replace image' }))
    const replacement = view.container.querySelector('input[type="file"]:not([multiple])') as HTMLInputElement
    fireEvent.change(replacement, { target: { files: [new File(['replacement'], 'replacement.png', { type: 'image/png' })] } })
    await waitFor(() => expect(onChange.mock.calls.some(([value]) => String(value).includes('![Diagram]') && String(value).includes('Note.assets/new-image.png'))).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' })

    fireEvent.click(view.getByRole('button', { name: 'Remove image' }))
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0])).not.toContain('Note.assets/new-image.png'))
    expect(fetchMock).toHaveBeenCalledTimes(1) // Removing the node never deletes either asset file.
    fetchMock.mockRestore()
  })

  it('does not expose table mutation controls in read-only mode', async () => {
    const onChange = vi.fn()
    const markdown = '| A | B |\n| --- | --- |\n| 1 | 2 |'
    const view = render(<MarkdownEditor documentKey="table-read" notePath="Note.md" markdown={markdown} readOnly onChange={onChange} />)
    await waitFor(() => expect(view.container.querySelector('table')).toBeTruthy())
    expect(view.queryByRole('toolbar', { name: 'Table editing' })).toBeNull()
    expect(view.getByRole('button', { name: 'Insert table' }).hasAttribute('disabled')).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('filters slash commands and inserts portable Markdown structures', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="slash" notePath="Note.md" markdown="" readOnly={false} onChange={onChange} />)
    const editor = await waitFor(() => {
      const element = view.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    editor.focus()
    await userEvent.type(editor, '/he', { skipClick: true })

    const menu = await view.findByRole('listbox', { name: 'Slash commands' })
    await waitFor(() => {
      expect(menu.textContent).toContain('Heading 1')
      expect(menu.textContent).not.toContain('Bullet list')
    })
    const headingTwo = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((option) => option.textContent?.includes('Heading 2'))
    expect(headingTwo).toBeTruthy()
    fireEvent.click(headingTwo!)
    await waitFor(() => expect(onChange.mock.calls.some(([markdown]) => String(markdown).startsWith('##'))).toBe(true))
    expect(view.queryByRole('listbox', { name: 'Slash commands' })).toBeNull()
  })

  it('navigates and closes slash commands from the keyboard', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="slash-keyboard" notePath="Note.md" markdown="" readOnly={false} onChange={onChange} />)
    const editor = await waitFor(() => {
      const element = view.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    editor.focus()
    await userEvent.type(editor, '/co', { skipClick: true })

    const menu = await view.findByRole('listbox', { name: 'Slash commands' })
    await waitFor(() => expect(menu.textContent).not.toContain('Heading 1'))
    const options = Array.from(menu.querySelectorAll('[role="option"]'))
    expect(options[0].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    expect(options[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(editor, { key: 'ArrowUp' })
    fireEvent.keyDown(editor, { key: 'Enter' })
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toContain('```'))

    view.unmount()
    const escapeView = render(<MarkdownEditor documentKey="slash-escape" notePath="Note.md" markdown="" readOnly={false} onChange={vi.fn()} />)
    const escapeEditor = await waitFor(() => {
      const element = escapeView.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    escapeEditor.focus()
    await userEvent.type(escapeEditor, '/', { skipClick: true })
    await escapeView.findByRole('listbox', { name: 'Slash commands' })
    fireEvent.keyDown(escapeEditor, { key: 'Escape' })
    expect(escapeView.queryByRole('listbox', { name: 'Slash commands' })).toBeNull()
  })

  it('toggles blockquotes and creates a complete link at an empty cursor', async () => {
    const onChange = vi.fn()
    const prompts = vi.spyOn(window, 'prompt')
      .mockReturnValueOnce('RepoQuill')
      .mockReturnValueOnce('https://example.com')
    const view = render(<MarkdownEditor documentKey="toolbar-polish" notePath="Note.md" markdown="Quoted text\n\n" readOnly={false} onChange={onChange} />)
    await waitFor(() => expect(view.container.textContent).toContain('Quoted text'))

    fireEvent.click(view.getByRole('button', { name: 'Blockquote' }))
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toContain('> Quoted text'))
    expect(view.getByRole('button', { name: 'Blockquote' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(view.getByRole('button', { name: 'Blockquote' }))
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).not.toContain('> Quoted text'))

    const editor = view.container.querySelector('.ProseMirror') as HTMLElement
    editor.focus()
    fireEvent.click(view.getByRole('button', { name: 'Link' }))
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toContain('[RepoQuill](https://example.com)'))
    expect(prompts).toHaveBeenCalledTimes(2)
  })

  it('uses Enter for a paragraph and Shift+Enter for a hard line break', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="line-breaks" notePath="Note.md" markdown="" readOnly={false} onChange={onChange} />)
    const editor = await waitFor(() => {
      const element = view.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    editor.focus()
    await userEvent.type(editor, 'first{enter}second', { skipClick: true })
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}third')

    await waitFor(() => {
      const markdown = String(onChange.mock.calls.at(-1)?.[0] ?? '')
      expect(markdown).toContain('first\n\nsecond')
      expect(markdown).toMatch(/second(?:\\| {2})\nthird/)
    })
    expect(view.container.querySelectorAll('.ProseMirror p')).toHaveLength(2)
    expect(view.container.querySelector('.ProseMirror p:last-child br')).toBeTruthy()
  })

  it('keeps slash commands unavailable in Read only', async () => {
    const view = render(<MarkdownEditor documentKey="slash-read-only" notePath="Note.md" markdown="/code" readOnly onChange={vi.fn()} />)
    await waitFor(() => expect(view.container.textContent).toContain('/code'))
    expect(view.queryByRole('listbox', { name: 'Slash commands' })).toBeNull()
  })

  it('leaves a code block after three Enters while single Enters remain normal code lines', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="code-exit" notePath="Note.md" markdown="" readOnly={false} onChange={onChange} />)
    const editor = await waitFor(() => {
      const element = view.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    editor.focus()
    await userEvent.type(editor, '/code', { skipClick: true })
    const menu = await view.findByRole('listbox', { name: 'Slash commands' })
    await waitFor(() => expect(menu.textContent).not.toContain('Heading 1'))
    const codeBlock = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((option) => option.textContent?.includes('Code block'))
    expect(codeBlock).toBeTruthy()
    fireEvent.click(codeBlock!)

    await userEvent.type(editor, 'first{enter}second{enter}{enter}{enter}after', { skipClick: true })
    await waitFor(() => {
      const markdown = String(onChange.mock.calls.at(-1)?.[0] ?? '')
      expect(markdown).toContain('first\nsecond')
      expect(markdown).not.toContain('first\n\nsecond')
      expect(markdown).toMatch(/```[\s\S]*first\nsecond[\s\S]*```\n\nafter/)
    })
  })

  it('starts and stops inline-code typing at an empty cursor', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="inline-code" notePath="Note.md" markdown="" readOnly={false} onChange={onChange} />)
    const editor = await waitFor(() => {
      const element = view.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })

    fireEvent.click(view.getByRole('button', { name: 'Inline code' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Inline code' }).getAttribute('aria-pressed')).toBe('true'))
    await userEvent.type(editor, 'command', { skipClick: true })
    fireEvent.click(view.getByRole('button', { name: 'Inline code' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Inline code' }).getAttribute('aria-pressed')).toBe('false'))
    await userEvent.type(editor, ' continues', { skipClick: true })

    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '').trimEnd()).toBe('`command` continues'))
  })
})
