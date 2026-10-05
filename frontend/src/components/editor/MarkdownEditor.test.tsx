// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { MarkdownEditor } from './MarkdownEditor'

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub)
vi.stubGlobal('ClipboardEvent', window.Event)

beforeEach(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
})

async function typeInternalNoteTrigger(editor: HTMLElement, query = '') {
  // user-event uses doubled opening brackets to represent one literal `[`
  await userEvent.type(editor, '[[', { skipClick: true })
  await userEvent.type(editor, `[[${query}`, { skipClick: true })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 })
})

// Milkdown's context timers remove global listeners 3 seconds after editor setup.
afterAll(async () => new Promise((resolve) => setTimeout(resolve, 3_100)))

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

  it('reports parsed visible-text statistics consistently in Edit and Read only', async () => {
    const markdown = [
      '# Heading **styled**',
      '',
      'Read [this label](https://example.test/path) and `inline code`.',
      '',
      '> quoted text',
      '',
      '- item text',
      '',
      '![Image alt hidden](<Note.assets/generated-image.png>)',
      '',
      '```ts',
      'const answer = 42',
      '```',
    ].join('\n')
    const onStatsEdit = vi.fn()
    const properties = { notePath: 'Note.md', markdown, onChange: vi.fn() }
    const view = render(<MarkdownEditor documentKey="stats-edit" readOnly={false} {...properties} onStats={onStatsEdit} />)

    await waitFor(() => expect(onStatsEdit).toHaveBeenCalled())
    expect(onStatsEdit.mock.calls.at(-1)?.[0]).toEqual({ words: 15, characters: 83, lines: 6 })

    const onStatsRead = vi.fn()
    view.rerender(<MarkdownEditor documentKey="stats-read" readOnly {...properties} onStats={onStatsRead} />)
    await waitFor(() => expect(onStatsRead).toHaveBeenCalled())
    expect(onStatsRead.mock.calls.at(-1)?.[0]).toEqual(onStatsEdit.mock.calls.at(-1)?.[0])
  })

  it('keeps primary and contextual controls in one opt-in sticky toolbar stack', async () => {
    const markdown = '| A | B |\n| --- | --- |\n| 1 | 2 |'
    const view = render(<MarkdownEditor documentKey="sticky-toolbar" notePath="Note.md" markdown={markdown} readOnly={false} onChange={vi.fn()} stickyToolbar />)

    const toolbars = view.container.querySelector<HTMLElement>('[aria-label="Editor toolbars"]')
    expect(toolbars?.dataset.sticky).toBe('true')
    expect(toolbars?.classList.contains('repoquill-editor-toolbars')).toBe(true)
    expect(toolbars?.contains(view.getByRole('toolbar', { name: 'Editor formatting' }))).toBe(true)
    expect(toolbars?.contains(await view.findByRole('toolbar', { name: 'Table editing' }))).toBe(true)

    view.unmount()
    const inline = render(<MarkdownEditor documentKey="inline-toolbar" notePath="Note.md" markdown="Text" readOnly={false} onChange={vi.fn()} />)
    expect(inline.container.querySelector<HTMLElement>('[aria-label="Editor toolbars"]')?.dataset.sticky).toBe('false')
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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.startsWith('/api/repository/image-presentations')) return Response.json({ presentations: {} })
      if (url === '/api/repository/assets' || url.startsWith('/api/repository/assets?')) return Response.json({ path: 'Note.assets/new-image.png' })
      if (url === '/api/repository/image-presentation' && init?.method === 'PUT') return Response.json({ image: 'Note.assets/new-image.png', size: 'full' })
      if (url.startsWith('/api/repository/image-presentation?') && init?.method === 'DELETE') return new Response(null, { status: 204 })
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })
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
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).startsWith('/api/repository/assets?') && init?.method === 'POST')).toBe(true)

    fireEvent.click(view.getByRole('button', { name: 'Remove image' }))
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0])).not.toContain('Note.assets/new-image.png'))
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).startsWith('/api/repository/asset?') && init?.method === 'DELETE')).toBe(false) // Removing the node never deletes either asset file.
    fetchMock.mockRestore()
  })

  it('persists all four portable presentation presets without changing Markdown or the original lightbox asset', async () => {
    const onChange = vi.fn()
    let storedSize = 'medium'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.startsWith('/api/repository/image-presentations')) return Response.json({ presentations: { 'Note.assets/diagram.png': storedSize, 'Note.assets/stale.png': 'small' } })
      if (url === '/api/repository/image-presentation' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { size: string }
        storedSize = body.size
        return Response.json({ image: 'Note.assets/diagram.png', size: storedSize })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })
    const markdown = '![Topology](<Note.assets/diagram.png>)'
    const view = render(<MarkdownEditor documentKey="sizes" notePath="Note.md" markdown={markdown} readOnly={false} onChange={onChange} />)
    const inlineImage = await waitFor(() => {
      const element = view.container.querySelector('.milkdown-image-inline img') as HTMLImageElement
      expect(element.closest<HTMLElement>('.milkdown-image-inline')?.dataset.presentationSize).toBe('medium')
      return element
    })
    fireEvent.pointerDown(inlineImage)
    expect((await view.findByRole('button', { name: 'Medium image size' })).getAttribute('aria-pressed')).toBe('true')

    for (const size of ['Small', 'Medium', 'Large', 'Full']) {
      const button = view.getByRole('button', { name: `${size} image size` })
      button.focus()
      await userEvent.keyboard('{Enter}')
      await waitFor(() => expect(inlineImage.closest<HTMLElement>('.milkdown-image-inline')?.dataset.presentationSize).toBe(size.toLowerCase()))
      expect(button.getAttribute('aria-pressed')).toBe('true')
      expect(onChange).not.toHaveBeenCalled()
      fireEvent.click(view.getByRole('button', { name: 'View image' }))
      const dialog = view.getByRole('dialog', { name: 'Topology' })
      expect((dialog.querySelector('img') as HTMLImageElement).src).toContain('path=Note.assets%2Fdiagram.png')
      fireEvent.click(view.getByRole('button', { name: 'Close image viewer' }))
      await waitFor(() => expect(document.activeElement).toBe(view.getByRole('button', { name: 'View image' })))
    }

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(4)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    expect(onChange).not.toHaveBeenCalled()

    view.rerender(<MarkdownEditor documentKey="sizes-read" notePath="Note.md" markdown={markdown} readOnly onChange={onChange} />)
    await waitFor(() => expect(view.container.querySelector('.milkdown-image-inline')?.getAttribute('data-presentation-size')).toBe('full'))
    expect(view.queryByRole('group', { name: 'Image presentation size' })).toBeNull()
    expect(onChange).not.toHaveBeenCalled()

    view.unmount()
    const reloaded = render(<MarkdownEditor documentKey="sizes-reload" notePath="Note.md" markdown={markdown} readOnly onChange={onChange} />)
    await waitFor(() => expect(reloaded.container.querySelector('.milkdown-image-inline')?.getAttribute('data-presentation-size')).toBe('full'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('falls back to the existing full presentation when metadata persistence fails', async () => {
    const onChange = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).startsWith('/api/repository/image-presentations')) return Response.json({ presentations: {} })
      if (init?.method === 'PUT') return Response.json({ error: 'Metadata volume is read only' }, { status: 503 })
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    })
    const view = render(<MarkdownEditor documentKey="size-failure" notePath="Note.md" markdown="![Diagram](<Note.assets/image.png>)" readOnly={false} onChange={onChange} />)
    const image = await waitFor(() => {
      const element = view.container.querySelector('.milkdown-image-inline img') as HTMLImageElement
      expect(element.closest<HTMLElement>('.milkdown-image-inline')?.dataset.presentationSize).toBe('full')
      return element
    })
    fireEvent.pointerDown(image)
    fireEvent.click(await view.findByRole('button', { name: 'Medium image size' }))
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('Metadata volume is read only'))
    expect(image.closest<HTMLElement>('.milkdown-image-inline')?.dataset.presentationSize).toBe('full')
    expect(image.getAttribute('src')).toContain('Note.assets%2Fimage.png')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('opens the selected edit-mode image without changing Markdown and restores toolbar focus', async () => {
    const onChange = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ presentations: {} }))
    const markdown = '![Network diagram](<Note.assets/diagram.png>)'
    const view = render(<MarkdownEditor documentKey="image-view-edit" notePath="Note.md" markdown={markdown} readOnly={false} onChange={onChange} />)
    const inlineImage = await waitFor(() => {
      const element = view.container.querySelector('.repoquill-editor img') as HTMLImageElement | null
      expect(element).toBeTruthy()
      return element!
    })

    fireEvent.pointerDown(inlineImage)
    const viewButton = await view.findByRole('button', { name: 'View image' })
    fireEvent.click(viewButton)

    const viewerDialog = view.getByRole('dialog', { name: 'Network diagram' })
    expect(viewerDialog).toBeTruthy()
    expect((viewerDialog.querySelector('img') as HTMLImageElement).src).toContain('/api/repository/asset?note=Note.md&path=Note.assets%2Fdiagram.png')
    expect(onChange).not.toHaveBeenCalled()
    const closeButton = view.getByRole('button', { name: 'Close image viewer' })
    const fitButton = view.getByRole('button', { name: 'Fit to screen' })
    await waitFor(() => expect(document.activeElement).toBe(closeButton))
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(fitButton)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(closeButton)
    fireEvent.click(view.getByRole('button', { name: 'Actual size' }))
    expect(view.container.querySelector('[data-size-mode="actual"]')).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)

    fireEvent.click(closeButton)
    await waitFor(() => expect(view.queryByRole('dialog', { name: 'Network diagram' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(viewButton))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('opens an empty-alt image directly in Read only and closes with Escape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ presentations: {} }))
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="image-view-read" notePath="Note.md" markdown="![](<Note.assets/photo.png>)" readOnly onChange={onChange} />)
    const inlineImage = await waitFor(() => {
      const element = view.getByRole('button', { name: 'View note image' }) as HTMLImageElement
      expect(element.tabIndex).toBe(0)
      return element
    })

    fireEvent.click(inlineImage)
    expect(view.getByRole('dialog', { name: 'Note image' })).toBeTruthy()
    expect(view.getByRole('img', { name: 'Note image' })).toBeTruthy()
    expect(view.container.querySelector('.ProseMirror')?.getAttribute('contenteditable')).toBe('false')
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(view.queryByRole('dialog', { name: 'Note image' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(inlineImage))
    expect(view.container.querySelector('.ProseMirror')?.getAttribute('contenteditable')).toBe('false')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps a failed image view closable and leaves the note untouched', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ presentations: {} }))
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="image-view-error" notePath="Note.md" markdown="![Missing](<Note.assets/missing.png>)" readOnly onChange={onChange} />)
    const inlineImage = await waitFor(() => view.getByRole('button', { name: 'View image: Missing' }))
    fireEvent.click(inlineImage)
    fireEvent.error(view.getByRole('img', { name: 'Missing' }))

    expect(view.getByRole('alert').textContent).toContain('could not be loaded')
    expect(view.getByRole('alert').textContent).toContain('Markdown were not changed')
    expect(view.getByRole('button', { name: 'Close image viewer' })).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('supports backdrop close, narrow viewports, rotation, and closes on note context changes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ presentations: {} }))
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
    const onChange = vi.fn()
    const properties = { notePath: 'Mobile.md', markdown: '![Mobile](<Mobile.assets/image.png>)', readOnly: true, onChange }
    const view = render(<MarkdownEditor documentKey="mobile-a" {...properties} />)
    const inlineImage = await waitFor(() => view.getByRole('button', { name: 'View image: Mobile' }))
    fireEvent.keyDown(inlineImage, { key: 'Enter' })
    const dialog = view.getByRole('dialog', { name: 'Mobile' })
    expect(view.getByRole('button', { name: 'Fit to screen' }).getAttribute('aria-pressed')).toBe('true')

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 844 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 390 })
    fireEvent(window, new Event('resize'))
    expect(view.getByRole('dialog', { name: 'Mobile' })).toBe(dialog)
    fireEvent.mouseDown(dialog.parentElement!)
    await waitFor(() => expect(view.queryByRole('dialog', { name: 'Mobile' })).toBeNull())

    fireEvent.click(inlineImage)
    expect(view.getByRole('dialog', { name: 'Mobile' })).toBeTruthy()
    view.rerender(<MarkdownEditor documentKey="mobile-b" notePath="Other.md" markdown="Other note" readOnly onChange={onChange} />)
    await waitFor(() => expect(view.queryByRole('dialog', { name: 'Mobile' })).toBeNull())
    await waitFor(() => expect(view.container.textContent).toContain('Other note'))
    expect(onChange).not.toHaveBeenCalled()
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
    expect(await view.findByRole('dialog', { name: 'Insert link' })).toBeTruthy()
    fireEvent.change(view.getByLabelText('Link text'), { target: { value: 'RepoQuill' } })
    fireEvent.change(view.getByLabelText('External URL or custom Markdown destination'), { target: { value: 'https://example.com' } })
    fireEvent.click(view.getByRole('button', { name: 'Apply URL' }))
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toContain('[RepoQuill](https://example.com)'))
  })

  it('inserts and opens portable relative internal note links', async () => {
    const onChange = vi.fn()
    const onOpenNoteLink = vi.fn()
    const view = render(<MarkdownEditor documentKey="internal-link" notePath="Folder/Current.md" markdown="See also: " readOnly={false} onChange={onChange} notePaths={['Folder/Current.md','Other Notes/Target Note.md']} onOpenNoteLink={onOpenNoteLink} />)
    await waitFor(() => expect(view.container.textContent).toContain('See also:'))
    const editor = view.container.querySelector('.ProseMirror') as HTMLElement
    editor.focus()
    fireEvent.click(view.getByRole('button', { name: 'Link' }))
    fireEvent.change(await view.findByLabelText('Find a note'), { target: { value: 'Target' } })
    fireEvent.click(view.getByRole('option', { name: /Target Note/ }))
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toContain('[Target Note](../Other%20Notes/Target%20Note.md)'))

		fireEvent.click(await view.findByRole('button', { name:'Open linked note in new tab' }))
		expect(onOpenNoteLink).toHaveBeenCalledWith('Other Notes/Target Note.md', 'new')
		onOpenNoteLink.mockClear()

    const anchor = view.container.querySelector('a') as HTMLAnchorElement
    fireEvent.click(anchor, { ctrlKey:true })
    expect(onOpenNoteLink).toHaveBeenCalledWith('Other Notes/Target Note.md', 'new')
  })

  it('shows a missing state for broken internal links without changing Markdown', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="broken-link" notePath="Current.md" markdown="[Missing](Missing.md)" readOnly={false} onChange={onChange} notePaths={['Current.md']} />)
    const anchor = await waitFor(() => {
      const element = view.container.querySelector('a') as HTMLAnchorElement | null
      expect(element).toBeTruthy()
      return element!
    })
    fireEvent.click(anchor)
    expect((await view.findByRole('alert')).textContent).toContain('Linked note not found: Missing.md')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('suggests notes for the internal-link trigger and still serializes standard Markdown', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="link-trigger" notePath="Folder/Current.md" markdown="" readOnly={false} onChange={onChange} notePaths={['Folder/Current.md','Folder/Target.md','Elsewhere/Other.md']} />)
    const editor = await waitFor(() => {
      const element = view.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    editor.focus()
    await userEvent.type(editor, '[[', { skipClick:true })
    expect(view.queryByRole('listbox', { name:'Internal note suggestions' })).toBeNull()
    await userEvent.type(editor, '[[tar', { skipClick:true })
    const suggestions = await view.findByRole('listbox', { name:'Internal note suggestions' })
    expect(suggestions.textContent).toContain('Target')
    fireEvent.keyDown(editor, { key:'Enter' })
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toContain('[Target](Target.md)'))
    expect(view.queryByRole('listbox', { name:'Internal note suggestions' })).toBeNull()
  })

  it('never treats ordinary brackets, Markdown links, or task syntax as note-link triggers', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="bracket-prose" notePath="Current.md" markdown="" readOnly={false} onChange={onChange} notePaths={['Current.md','Target.md']} />)
    const editor = await waitFor(() => {
      const element = view.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    editor.focus()

    await userEvent.type(editor, '[[ordinary text]', { skipClick: true })
    expect(view.queryByRole('listbox', { name: 'Internal note suggestions' })).toBeNull()
    await userEvent.type(editor, '{enter}[[label](https://example.com)', { skipClick: true })
    expect(view.queryByRole('listbox', { name: 'Internal note suggestions' })).toBeNull()
    await userEvent.type(editor, '{enter}- [[ ] Unchecked{enter}- [[x] Checked', { skipClick: true })
    expect(view.queryByRole('listbox', { name: 'Internal note suggestions' })).toBeNull()
    await waitFor(() => {
      const saved = String(onChange.mock.calls.at(-1)?.[0] ?? '')
      expect(saved).toContain('ordinary text')
      expect(saved).toContain('label')
      expect(saved).toContain('Unchecked')
      expect(saved).toContain('Checked')
    })
  })

  it('dismisses empty note suggestions when their trigger or selection context becomes invalid', async () => {
    const view = render(<MarkdownEditor documentKey="link-dismiss" notePath="Current.md" markdown="" readOnly={false} onChange={vi.fn()} notePaths={['Current.md']} />)
    const editor = await waitFor(() => {
      const element = view.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    editor.focus()

    await typeInternalNoteTrigger(editor, 'missing')
    expect((await view.findByRole('listbox', { name: 'Internal note suggestions' })).textContent).toContain('No matching notes')
    await userEvent.type(editor, ']', { skipClick: true })
    await waitFor(() => expect(view.queryByRole('listbox', { name: 'Internal note suggestions' })).toBeNull())

    await userEvent.type(editor, '{enter}', { skipClick: true })
    await typeInternalNoteTrigger(editor, 'again')
    await view.findByRole('listbox', { name: 'Internal note suggestions' })
    fireEvent.keyDown(editor, { key: 'ArrowLeft' })
    expect(view.queryByRole('listbox', { name: 'Internal note suggestions' })).toBeNull()

    await userEvent.type(editor, '{enter}', { skipClick: true })
    await typeInternalNoteTrigger(editor)
    await view.findByRole('listbox', { name: 'Internal note suggestions' })
    fireEvent.change(view.getByLabelText('Block type'), { target: { value: 'heading-2' } })
    await waitFor(() => expect(view.queryByRole('listbox', { name: 'Internal note suggestions' })).toBeNull())
  })

  it('dismisses note suggestions on Escape, outside interaction, focus loss, note change, and Read only', async () => {
    const properties = { notePath: 'Current.md', markdown: '', onChange: vi.fn(), notePaths: ['Current.md','Target.md'] }
    const view = render(<MarkdownEditor documentKey="link-boundaries" readOnly={false} {...properties} />)
    const editor = await waitFor(() => {
      const element = view.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    editor.focus()

    await typeInternalNoteTrigger(editor)
    await view.findByRole('listbox', { name: 'Internal note suggestions' })
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(view.queryByRole('listbox', { name: 'Internal note suggestions' })).toBeNull()

    await userEvent.type(editor, '{enter}', { skipClick: true })
    await typeInternalNoteTrigger(editor)
    await view.findByRole('listbox', { name: 'Internal note suggestions' })
    fireEvent.pointerDown(document.body)
    expect(view.queryByRole('listbox', { name: 'Internal note suggestions' })).toBeNull()

    editor.focus()
    await userEvent.type(editor, '{enter}', { skipClick: true })
    await typeInternalNoteTrigger(editor)
    await view.findByRole('listbox', { name: 'Internal note suggestions' })
    view.getByRole('button', { name: 'Bold' }).focus()
    await waitFor(() => expect(view.queryByRole('listbox', { name: 'Internal note suggestions' })).toBeNull())

    editor.focus()
    await userEvent.type(editor, '{enter}', { skipClick: true })
    await typeInternalNoteTrigger(editor)
    await view.findByRole('listbox', { name: 'Internal note suggestions' })
    view.rerender(<MarkdownEditor documentKey="other-note" readOnly={false} {...properties} notePath="Other.md" />)
    expect(view.queryByRole('listbox', { name: 'Internal note suggestions' })).toBeNull()

    view.unmount()
    const readOnlyView = render(<MarkdownEditor documentKey="read-only-transition" readOnly={false} {...properties} />)
    const readOnlyEditor = await waitFor(() => {
      const element = readOnlyView.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    readOnlyEditor.focus()
    await typeInternalNoteTrigger(readOnlyEditor)
    await readOnlyView.findByRole('listbox', { name: 'Internal note suggestions' })
    readOnlyView.rerender(<MarkdownEditor documentKey="read-only-transition" readOnly {...properties} />)
    expect(readOnlyView.queryByRole('listbox', { name: 'Internal note suggestions' })).toBeNull()
  })

  it('keeps touch selection portable and returns focus to the editor', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="link-touch" notePath="Folder/Current.md" markdown="" readOnly={false} onChange={onChange} notePaths={['Folder/Current.md','Folder/Target.md']} />)
    const editor = await waitFor(() => {
      const element = view.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    editor.focus()
    await typeInternalNoteTrigger(editor, 'tar')
    const option = await view.findByRole('option', { name: /Target/ })
    fireEvent.pointerDown(option, { pointerType: 'touch' })
    fireEvent.click(option)
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toContain('[Target](Target.md)'))
    expect(view.queryByRole('listbox', { name: 'Internal note suggestions' })).toBeNull()
    expect(document.activeElement).toBe(editor)
  })

  it('uses Enter for a paragraph and Shift+Enter for a hard line break', async () => {
    const onChange = vi.fn()
    const onStats = vi.fn()
    const view = render(<MarkdownEditor documentKey="line-breaks" notePath="Note.md" markdown="" readOnly={false} onChange={onChange} onStats={onStats} />)
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
    expect(onStats.mock.calls.at(-1)?.[0]).toEqual({ words: 3, characters: 16, lines: 3 })

    await userEvent.keyboard('{Enter}', { skipClick: true })
    await waitFor(() => expect(onStats.mock.calls.at(-1)?.[0]).toEqual({ words: 3, characters: 16, lines: 4 }))
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

  it('highlights only the explicitly registered languages and keeps unknown fence tags during edits', async () => {
    const markdown = [
      '```typescript',
      'const markup = "<img src=x onerror=alert(1) />"',
      'const greeting: string = "hello"',
      '```',
      '',
      '```future-language-v2',
      'render()',
      '```',
    ].join('\n')
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="code-highlight" notePath="Note.md" markdown={markdown} readOnly={false} onChange={onChange} />)

    const codeBlocks = await waitFor(() => {
      const elements = Array.from(view.container.querySelectorAll<HTMLElement>('.repoquill-code-block-content'))
      expect(elements).toHaveLength(2)
      expect(view.container.querySelector('.repoquill-code-block-content .hljs-keyword')).toBeTruthy()
      return elements
    })
    expect(view.container.querySelector('[data-language="future-language-v2"]')?.textContent).toContain('Unrecognized language')
    expect(codeBlocks[1].querySelector('.hljs-keyword')).toBeNull()
    expect(view.container.querySelector('img')).toBeNull()

    const unknownChange = vi.fn()
    const unknownView = render(<MarkdownEditor documentKey="unknown-code-edit" notePath="Note.md" markdown={'```future-language-v2\nrender()\n```'} readOnly={false} onChange={unknownChange} />)
    const unknownEditor = await waitFor(() => {
      const element = unknownView.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    unknownEditor.focus()
    await userEvent.type(unknownEditor, 'x', { skipClick: true })
    await waitFor(() => {
      const saved = String(unknownChange.mock.calls.at(-1)?.[0] ?? '')
      expect(saved).toContain('```future-language-v2')
      expect(saved).toContain('render()')
      expect(saved).toMatch(/(?:xrender|render\(\)x)/)
    })
  })

  it('offers a contextual language selector and serializes its portable fence tag', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="code-language" notePath="Note.md" markdown={'```\nconsole.log("hello")\n```'} readOnly={false} onChange={onChange} />)
    await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>('.repoquill-code-block-content')
      expect(element).toBeTruthy()
    })

    const selector = await view.findByRole('combobox', { name: 'Code block language' }) as HTMLSelectElement
    expect(view.getByRole('toolbar', { name: 'Code block options' })).toBeTruthy()
    fireEvent.change(selector, { target: { value: 'typescript' } })

    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toContain('```typescript'))
    expect((view.container.querySelector('.repoquill-code-block-language') as HTMLElement).textContent).toBe('TypeScript')
    fireEvent.change(view.getByRole('combobox', { name: 'Code block language' }), { target: { value: '' } })
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toMatch(/```\nconsole\.log\("hello"\)/))
  })

  it('copies literal fenced-code contents in Edit and Read only without changing the note', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    for (const readOnly of [false, true]) {
      writeText.mockClear()
      const onChange = vi.fn()
      const view = render(<MarkdownEditor documentKey={`copy-code-${readOnly}`} notePath="Note.md" markdown={'```bash\nprintf "hello"\n```'} readOnly={readOnly} onChange={onChange} />)
      const copy = await view.findByRole('button', { name: 'Copy code block' })
      const code = view.container.querySelector('.repoquill-code-block-content') as HTMLElement
      const expectedCode = code.textContent
      const changesBeforeCopy = onChange.mock.calls.length
      expect(expectedCode).toBe('printf "hello"')

      copy.focus()
      await userEvent.keyboard('{Enter}')
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(expectedCode))
      await waitFor(() => expect(view.container.querySelector('.repoquill-code-block-copy-status')?.textContent).toBe('Code copied.'))
      expect(onChange).toHaveBeenCalledTimes(changesBeforeCopy)
      view.unmount()
    }
  })

  it('shows readable copy failure feedback without opening a browser dialog', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const alert = vi.spyOn(window, 'alert')
    const view = render(<MarkdownEditor documentKey="copy-code-failure" notePath="Note.md" markdown={'```json\n{"ok":true}\n```'} readOnly onChange={vi.fn()} />)

    fireEvent.click(await view.findByRole('button', { name: 'Copy code block' }))
    await waitFor(() => expect(view.container.querySelector('.repoquill-code-block-copy-status')?.textContent).toBe('Copy failed. Select and copy the code manually.'))
    expect(alert).not.toHaveBeenCalled()
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

  it('pastes explicit CommonMark and GFM as one undoable editor operation', async () => {
    const markdown = [
      '# Pasted heading',
      '',
      '**Bold** and *italic* with [a link](Guide.md).',
      '',
      '- First item',
      '- [x] Finished task',
      '',
      '> Quoted text',
      '',
      '```sh',
      'echo hello',
      '```',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| A | B |',
      '',
      '---',
    ].join('\n')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: vi.fn().mockResolvedValue(markdown) } })
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="markdown-paste" notePath="Note.md" markdown="Replace me" readOnly={false} onChange={onChange} />)
    const editor = await waitFor(() => {
      const element = view.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    editor.focus()
    await userEvent.keyboard('{Control>}a{/Control}')

    fireEvent.click(view.getByRole('button', { name: 'Paste as Markdown' }))
    const dialog = await view.findByRole('dialog', { name: 'Paste as Markdown' })
    await waitFor(() => expect((view.getByRole('textbox', { name: 'Markdown' }) as HTMLTextAreaElement).value).toBe(markdown))
    fireEvent.click(view.getByRole('button', { name: 'Insert Markdown' }))

    await waitFor(() => expect(view.queryByRole('dialog', { name: 'Paste as Markdown' })).toBeNull())
    expect(dialog.isConnected).toBe(false)
    expect(view.container.querySelector('.ProseMirror h1')?.textContent).toBe('Pasted heading')
    expect(view.container.querySelector('.ProseMirror strong')?.textContent).toBe('Bold')
    expect(view.container.querySelector('.ProseMirror em')?.textContent).toBe('italic')
    expect(view.container.querySelector('.ProseMirror blockquote')?.textContent).toContain('Quoted text')
    expect(view.container.querySelector('.ProseMirror pre')?.textContent).toContain('echo hello')
    expect(view.container.querySelector('.ProseMirror table')).toBeTruthy()
    expect(view.container.querySelector('.ProseMirror hr')).toBeTruthy()
    expect(view.container.querySelector('.ProseMirror')?.textContent).not.toContain('Replace me')
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toContain('# Pasted heading'))

    fireEvent.click(view.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(view.container.querySelector('.ProseMirror')?.textContent).toContain('Replace me'))
    expect(view.container.querySelector('.ProseMirror h1')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Redo' }))
    await waitFor(() => expect(view.container.querySelector('.ProseMirror h1')?.textContent).toBe('Pasted heading'))
  })

  it('parses the unambiguous text/markdown clipboard media type directly', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="typed-markdown-paste" notePath="Note.md" markdown="" readOnly={false} onChange={onChange} />)
    const editor = await waitFor(() => {
      const element = view.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    editor.focus()
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        types: ['text/markdown', 'text/plain'],
        getData: (type: string) => type === 'text/markdown' ? '## Clipboard heading\n\n- One\n- Two' : 'plain fallback',
      },
    })

    await waitFor(() => expect(view.container.querySelector('.ProseMirror h2')?.textContent).toBe('Clipboard heading'))
    expect(view.container.querySelectorAll('.ProseMirror li')).toHaveLength(2)
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toContain('## Clipboard heading'))
  })

  it('leaves ordinary plain-text paste literal even when it resembles Markdown', async () => {
    const onChange = vi.fn()
    const source = '# Not a converted heading\n- still plain clipboard text'
    const view = render(<MarkdownEditor documentKey="plain-paste" notePath="Note.md" markdown="" readOnly={false} onChange={onChange} />)
    const editor = await waitFor(() => {
      const element = view.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    editor.focus()
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        types: ['text/plain'],
        getData: (type: string) => type === 'text/plain' ? source : '',
      },
    })

    await waitFor(() => expect(view.container.querySelector('.ProseMirror')?.textContent).toContain('# Not a converted heading'))
    expect(view.container.querySelector('.ProseMirror h1')).toBeNull()
    expect(view.container.querySelector('.ProseMirror li')).toBeNull()
  })

  it('keeps text/markdown literal while pasting inside a code block', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="code-markdown-paste" notePath="Note.md" markdown={'```sh\necho before\n```'} readOnly={false} onChange={onChange} />)
    const code = await waitFor(() => {
      const element = view.container.querySelector('.ProseMirror code') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    fireEvent.click(code)
    fireEvent.paste(code, {
      clipboardData: {
        files: [],
        types: ['text/markdown', 'text/plain'],
        getData: (type: string) => type === 'text/markdown' ? '# Must stay code' : '# Must stay code',
      },
    })

    await waitFor(() => expect(view.container.querySelector('.ProseMirror code')?.textContent).toContain('# Must stay code'))
    expect(view.container.querySelector('.ProseMirror h1')).toBeNull()
    expect(view.queryByRole('status')).toBeNull()
  })

  it('keeps relative Markdown image references portable without uploading them', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: vi.fn().mockResolvedValue('![Diagram](<Note.assets/diagram.png>)') } })
    const onChange = vi.fn()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const view = render(<MarkdownEditor documentKey="relative-image-paste" notePath="Note.md" markdown="" readOnly={false} onChange={onChange} />)

    fireEvent.click(view.getByRole('button', { name: 'Paste as Markdown' }))
    await waitFor(() => expect((view.getByRole('textbox', { name: 'Markdown' }) as HTMLTextAreaElement).value).toContain('diagram.png'))
    fireEvent.click(view.getByRole('button', { name: 'Insert Markdown' }))

    await waitFor(() => expect(view.container.querySelector('.ProseMirror img')).toBeTruthy())
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toContain('Note.assets/diagram.png'))
    expect(fetchSpy.mock.calls.some(([, options]) => options && (options as RequestInit).method === 'POST')).toBe(false)
  })

  it('keeps unsafe Markdown source available instead of activating HTML or external images', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: vi.fn().mockResolvedValue('<img src="https://example.test/tracker.png">') } })
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="unsafe-markdown-paste" notePath="Note.md" markdown="Safe note" readOnly={false} onChange={onChange} />)

    fireEvent.click(view.getByRole('button', { name: 'Paste as Markdown' }))
    await waitFor(() => expect((view.getByRole('textbox', { name: 'Markdown' }) as HTMLTextAreaElement).value).toContain('tracker.png'))
    fireEvent.click(view.getByRole('button', { name: 'Insert Markdown' }))

    expect((await view.findByRole('alert')).textContent).toContain('Raw HTML is not inserted')
    expect((view.getByRole('textbox', { name: 'Markdown' }) as HTMLTextAreaElement).value).toContain('tracker.png')
    expect(view.container.querySelector('.ProseMirror img')).toBeNull()
    expect(view.container.querySelector('.ProseMirror')?.textContent).toContain('Safe note')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('falls back to literal source for unsafe text/markdown image references', async () => {
    const onChange = vi.fn()
    const source = '![Tracker](https://example.test/tracker.png)'
    const view = render(<MarkdownEditor documentKey="external-image-paste" notePath="Note.md" markdown="" readOnly={false} onChange={onChange} />)
    const editor = await waitFor(() => {
      const element = view.container.querySelector('.ProseMirror') as HTMLElement | null
      expect(element).toBeTruthy()
      return element!
    })
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        types: ['text/markdown'],
        getData: () => source,
      },
    })

    expect((await view.findByRole('status')).textContent).toContain('original clipboard text was pasted unchanged')
    expect(view.container.querySelector('.ProseMirror img')).toBeNull()
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toContain('Tracker'))
  })

  it('keeps Paste as Markdown non-mutating in Read only mode', async () => {
    const view = render(<MarkdownEditor documentKey="markdown-paste-read-only" notePath="Note.md" markdown="# Existing" readOnly onChange={vi.fn()} />)
    await waitFor(() => expect(view.container.querySelector('.ProseMirror h1')?.textContent).toBe('Existing'))
    expect(view.getByRole('button', { name: 'Paste as Markdown' }).hasAttribute('disabled')).toBe(true)
    expect(view.queryByRole('dialog', { name: 'Paste as Markdown' })).toBeNull()
  })

  it('toggles GFM tasks with accessible controls and serializes portable Markdown', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="interactive-tasks" notePath="Tasks.md" markdown={'- [ ] First task\n- [x] Finished task\n- Ordinary item'} readOnly={false} onChange={onChange} />)
    const checkboxes = await view.findAllByRole('checkbox')

    expect(checkboxes).toHaveLength(2)
    expect(checkboxes[0].getAttribute('aria-checked')).toBe('false')
    expect(checkboxes[1].getAttribute('aria-checked')).toBe('true')
    expect(checkboxes[0].getAttribute('aria-label')).toContain('First task')
    expect(view.container.querySelectorAll('.repoquill-list-item')).toHaveLength(3)

    fireEvent.click(view.getByText('First task'))
    expect(checkboxes[0].getAttribute('aria-checked')).toBe('false')

    fireEvent.click(checkboxes[0])
    await waitFor(() => expect(checkboxes[0].getAttribute('aria-checked')).toBe('true'))
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toMatch(/[*+-] \[x\] First task/))

    fireEvent.click(checkboxes[1])
    await waitFor(() => expect(checkboxes[1].getAttribute('aria-checked')).toBe('false'))
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toMatch(/[*+-] \[ \] Finished task/))
  })

  it('operates a focused task with Enter and Space and supports Undo and Redo', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="keyboard-tasks" notePath="Tasks.md" markdown="- [ ] Keyboard task" readOnly={false} onChange={onChange} />)
    const checkbox = await view.findByRole('checkbox', { name: 'Task: Keyboard task' })

    checkbox.focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(checkbox.getAttribute('aria-checked')).toBe('true'))
    expect(document.activeElement).toBe(checkbox)

    await userEvent.keyboard(' ')
    await waitFor(() => expect(checkbox.getAttribute('aria-checked')).toBe('false'))
    expect(document.activeElement).toBe(checkbox)

    fireEvent.click(checkbox)
    await waitFor(() => expect(checkbox.getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(view.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(checkbox.getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(view.getByRole('button', { name: 'Redo' }))
    await waitFor(() => expect(checkbox.getAttribute('aria-checked')).toBe('true'))
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toMatch(/[*+-] \[x\] Keyboard task/))
  })

  it('keeps the checked state when serialized Markdown is loaded again', async () => {
    const onChange = vi.fn()
    const firstView = render(<MarkdownEditor documentKey="task-before-reload" notePath="Tasks.md" markdown="- [ ] Persistent task" readOnly={false} onChange={onChange} />)
    const checkbox = await firstView.findByRole('checkbox', { name: 'Task: Persistent task' })

    fireEvent.click(checkbox)
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toMatch(/[*+-] \[x\] Persistent task/))
    const savedMarkdown = String(onChange.mock.calls.at(-1)?.[0] ?? '')
    firstView.unmount()

    const reloadedView = render(<MarkdownEditor documentKey="task-after-reload" notePath="Tasks.md" markdown={savedMarkdown} readOnly={false} onChange={vi.fn()} />)
    expect((await reloadedView.findByRole('checkbox', { name: 'Task: Persistent task' })).getAttribute('aria-checked')).toBe('true')
  })

  it('keeps nested and ordinary lists intact while task controls remain independently operable', async () => {
    const onChange = vi.fn()
    const markdown = '- Ordinary\n  - [ ] Nested task\n  - Nested ordinary\n- [x] Top task\n\n1. Numbered'
    const view = render(<MarkdownEditor documentKey="mixed-tasks" notePath="Tasks.md" markdown={markdown} readOnly={false} onChange={onChange} />)
    const checkboxes = await view.findAllByRole('checkbox')

    expect(checkboxes).toHaveLength(2)
    expect(view.container.querySelectorAll('ul li')).toHaveLength(4)
    expect(view.container.querySelectorAll('ol li')).toHaveLength(1)
    fireEvent.click(checkboxes[0])
    await waitFor(() => {
      const saved = String(onChange.mock.calls.at(-1)?.[0] ?? '')
      expect(saved).toMatch(/[*+-] \[x\] Nested task/)
      expect(saved).toMatch(/[*+-] Ordinary/)
      expect(saved).toContain('1. Numbered')
    })
  })

  it('shows task state but cannot change it in Read only mode', async () => {
    const onChange = vi.fn()
    const view = render(<MarkdownEditor documentKey="read-only-tasks" notePath="Tasks.md" markdown={'- [ ] Open task\n- [x] Done task'} readOnly onChange={onChange} />)
    const checkboxes = await view.findAllByRole('checkbox')

    expect(checkboxes).toHaveLength(2)
    expect(checkboxes.every((checkbox) => checkbox.hasAttribute('disabled'))).toBe(true)
    expect(checkboxes[0].getAttribute('aria-checked')).toBe('false')
    expect(checkboxes[1].getAttribute('aria-checked')).toBe('true')
    fireEvent.click(checkboxes[0])
    expect(checkboxes[0].getAttribute('aria-checked')).toBe('false')
    expect(onChange).not.toHaveBeenCalled()
  })
})
