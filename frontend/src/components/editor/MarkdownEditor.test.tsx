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
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 })
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
    await userEvent.type(editor, '[[tar', { skipClick:true })
    const suggestions = await view.findByRole('listbox', { name:'Internal note suggestions' })
    expect(suggestions.textContent).toContain('Target')
    fireEvent.keyDown(editor, { key:'Enter' })
    await waitFor(() => expect(String(onChange.mock.calls.at(-1)?.[0] ?? '')).toContain('[Target](Target.md)'))
    expect(view.queryByRole('listbox', { name:'Internal note suggestions' })).toBeNull()
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
