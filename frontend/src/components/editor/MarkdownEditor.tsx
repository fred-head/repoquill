import { useRef, useState, type ReactNode } from 'react'
import { imageInlineComponent, inlineImageConfig } from '@milkdown/kit/component/image-inline'
import { commandsCtx, defaultValueCtx, Editor, editorViewCtx, editorViewOptionsCtx, rootCtx, schemaCtx } from '@milkdown/kit/core'
import { history, redoCommand, undoCommand } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { upload, uploadConfig, type Uploader } from '@milkdown/kit/plugin/upload'
import { createCodeBlockCommand, insertHrCommand, liftListItemCommand, linkSchema, toggleEmphasisCommand, toggleInlineCodeCommand, toggleLinkCommand, toggleStrongCommand, turnIntoTextCommand, updateLinkCommand, wrapInBlockquoteCommand, wrapInBulletListCommand, wrapInHeadingCommand, wrapInOrderedListCommand } from '@milkdown/kit/preset/commonmark'
import { addColAfterCommand, addColBeforeCommand, addRowAfterCommand, addRowBeforeCommand, gfm, insertTableCommand, toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import type { Node } from '@milkdown/kit/prose/model'
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import type { Command, EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { exitCode, lift, newlineInCode } from '@milkdown/kit/prose/commands'
import { deleteColumn, deleteRow, deleteTable } from '@milkdown/kit/prose/tables'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { isEditorEditable } from '../../app/autoLock'

type MarkdownEditorProps = {
  documentKey: string
  notePath: string
  markdown: string
  readOnly: boolean
  onChange: (markdown: string) => void
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  return (
    <MilkdownProvider>
      <MilkdownEditor {...props} />
    </MilkdownProvider>
  )
}

type UploadState = 'idle' | 'uploading' | 'error'
type SelectedImage = { position: number; alt: string }
type ToolbarState = { block: string; strong: boolean; emphasis: boolean; strike: boolean; code: boolean; link: boolean; bullet: boolean; ordered: boolean; task: boolean; quote: boolean; table: boolean }
type TableSize = { rows: number; columns: number }
type SlashState = { from: number; to: number; query: string; left: number; top: number }
type SlashCommandID = 'paragraph' | 'heading-1' | 'heading-2' | 'heading-3' | 'heading-4' | 'heading-5' | 'heading-6' | 'bullet-list' | 'numbered-list' | 'task-list' | 'blockquote' | 'code-block' | 'inline-code' | 'link' | 'image' | 'table' | 'horizontal-rule'
type SlashCommand = { id: SlashCommandID; label: string; description: string; keywords: string }
const emptyToolbarState: ToolbarState = { block: 'paragraph', strong: false, emphasis: false, strike: false, code: false, link: false, bullet: false, ordered: false, task: false, quote: false, table: false }

const slashCommands: SlashCommand[] = [
  { id: 'paragraph', label: 'Paragraph', description: 'Normal text block', keywords: 'text paragraph absatz' },
  { id: 'heading-1', label: 'Heading 1', description: 'Large section heading', keywords: 'h1 title heading überschrift' },
  { id: 'heading-2', label: 'Heading 2', description: 'Medium section heading', keywords: 'h2 heading überschrift' },
  { id: 'heading-3', label: 'Heading 3', description: 'Small section heading', keywords: 'h3 heading überschrift' },
  { id: 'heading-4', label: 'Heading 4', description: 'Fourth-level heading', keywords: 'h4 heading überschrift' },
  { id: 'heading-5', label: 'Heading 5', description: 'Fifth-level heading', keywords: 'h5 heading überschrift' },
  { id: 'heading-6', label: 'Heading 6', description: 'Sixth-level heading', keywords: 'h6 heading überschrift' },
  { id: 'bullet-list', label: 'Bullet list', description: 'Unordered list', keywords: 'list bullet aufzählung' },
  { id: 'numbered-list', label: 'Numbered list', description: 'Ordered list', keywords: 'list numbered ordered nummeriert' },
  { id: 'task-list', label: 'Task list', description: 'Checklist with checkboxes', keywords: 'task todo checklist aufgabe' },
  { id: 'blockquote', label: 'Blockquote', description: 'Quoted paragraph', keywords: 'quote citation zitat' },
  { id: 'code-block', label: 'Code block', description: 'Multiline code', keywords: 'code block preformatted' },
  { id: 'inline-code', label: 'Inline code', description: 'Code inside a paragraph', keywords: 'code inline' },
  { id: 'link', label: 'Link', description: 'Insert a Markdown link', keywords: 'url href link' },
  { id: 'image', label: 'Image', description: 'Upload and insert an image', keywords: 'image picture photo bild' },
  { id: 'table', label: 'Table', description: 'Choose rows and columns', keywords: 'table grid tabelle' },
  { id: 'horizontal-rule', label: 'Horizontal rule', description: 'Section divider', keywords: 'rule divider separator trennlinie' },
]

function filteredSlashCommands(query: string): SlashCommand[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return slashCommands
  return slashCommands.filter((command) => `${command.label} ${command.keywords}`.toLowerCase().includes(normalized))
}

function toolbarStateFromEditor(state: EditorState): ToolbarState {
  const { $from, from, to, empty } = state.selection
  const markActive = (name: string) => {
    const mark = state.schema.marks[name]
    if (!mark) return false
    return empty ? Boolean(mark.isInSet(state.storedMarks ?? $from.marks())) : state.doc.rangeHasMark(from, to, mark)
  }
  let block = 'paragraph'
  let bullet = false
  let ordered = false
  let task = false
  let quote = false
  let table = false
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth)
    if (node.type.name === 'heading') block = `heading-${node.attrs.level}`
    if (node.type.name === 'code_block') block = 'code-block'
    if (node.type.name === 'bullet_list') bullet = true
    if (node.type.name === 'ordered_list') ordered = true
    if (node.type.name === 'list_item' && node.attrs.checked !== null) task = true
    if (node.type.name === 'blockquote') quote = true
    if (node.type.name === 'table') table = true
  }
  return { block, strong: markActive('strong'), emphasis: markActive('emphasis'), strike: markActive('strike_through'), code: markActive('inlineCode'), link: markActive('link'), bullet, ordered, task, quote, table }
}

function MilkdownEditor({ documentKey, notePath, markdown, readOnly, onChange }: MarkdownEditorProps) {
  const input = useRef<HTMLInputElement>(null)
  const replacementInput = useRef<HTMLInputElement>(null)
  const [uploadState, setUploadState] = useState<UploadState>('idle')
  const [uploadError, setUploadError] = useState<string>()
  const [selectedImage, setSelectedImage] = useState<SelectedImage>()
  const [editingAlt, setEditingAlt] = useState<string>()
  const [toolbarState, setToolbarState] = useState<ToolbarState>(emptyToolbarState)
  const [tablePickerOpen, setTablePickerOpen] = useState(false)
  const [tableSize, setTableSize] = useState<TableSize>({ rows: 3, columns: 3 })
  const [slashState, setSlashState] = useState<SlashState>()
  const [slashIndex, setSlashIndex] = useState(0)
  const slashStateRef = useRef<SlashState | undefined>(undefined)
  const slashIndexRef = useRef(0)


  async function uploadImage(file: File): Promise<string> {
    if (readOnly) throw new Error('Switch to Edit before inserting an image')
    setUploadState('uploading')
    setUploadError(undefined)
    try {
      const form = new FormData()
      form.append('file', file)
      const response = await fetch(`/api/repository/assets?note=${encodeURIComponent(notePath)}`, { method: 'POST', body: form })
      const result = await response.json() as { path?: string; error?: string }
      if (!response.ok || !result.path) throw new Error(result.error ?? `Image upload failed (${response.status})`)
      setUploadState('idle')
      return result.path
    } catch (error) {
      setUploadState('error')
      setUploadError(error instanceof Error ? error.message : 'Image upload failed')
      throw error
    }
  }

  const uploader: Uploader = async (files, schema) => {
    if (readOnly) return []
    const images = Array.from(files).filter((file) => file.type.startsWith('image/'))
    const nodes = await Promise.all(images.map(async (file) => schema.nodes.image.createAndFill({ src: await uploadImage(file), alt: '' })))
    return nodes.filter((node): node is Node => node !== null)
  }

  function displayURL(source: string): string {
    if (/^(?:https?:|data:|blob:|\/)/i.test(source)) return source
    return `/api/repository/asset?note=${encodeURIComponent(notePath)}&path=${encodeURIComponent(source)}`
  }

  const { get } = useEditor(
    (root) =>
      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root)
          ctx.set(defaultValueCtx, markdown)
          ctx.update(editorViewOptionsCtx, (previous) => ({
            ...previous,
            editable: () => isEditorEditable(readOnly),
            attributes: {
              ...previous.attributes,
              class: 'repoquill-editor',
              'aria-label': 'Markdown editor',
            },
            handleKeyDown: (view, event) => {
              const { $from } = view.state.selection
              if (event.key === 'Enter' && view.state.selection.empty && $from.parent.type.name === 'code_block' && $from.parentOffset === $from.parent.content.size && $from.parent.textContent.endsWith('\n\n')) {
                event.preventDefault()
                view.dispatch(view.state.tr.delete($from.pos - 2, $from.pos))
                exitCode(view.state, view.dispatch)
                view.focus()
                return true
              }
              if (event.key === 'Enter' && $from.parent.type.name === 'code_block') {
                event.preventDefault()
                newlineInCode(view.state, view.dispatch)
                return true
              }
              const active = slashStateRef.current
              if (active && event.key === 'Escape') {
                event.preventDefault()
                closeSlashMenu()
                return true
              }
              const inlineCode = view.state.schema.marks.inlineCode
              const inlineCodeActive = inlineCode?.isInSet(view.state.storedMarks ?? $from.marks())
              if (event.key === 'Escape' && inlineCodeActive) {
                event.preventDefault()
                view.dispatch(view.state.tr.removeStoredMark(inlineCode))
                setToolbarState(toolbarStateFromEditor(view.state))
                return true
              }
              if (!active) return previous.handleKeyDown?.(view, event) ?? false
              const options = filteredSlashCommands(active.query)
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                if (!options.length) return true
                const direction = event.key === 'ArrowDown' ? 1 : -1
                const next = (slashIndexRef.current + direction + options.length) % options.length
                slashIndexRef.current = next
                setSlashIndex(next)
                return true
              }
              if (event.key === 'Enter' && options.length) {
                event.preventDefault()
                executeSlashCommand(options[Math.min(slashIndexRef.current, options.length - 1)].id)
                return true
              }
              return previous.handleKeyDown?.(view, event) ?? false
            },
          }))
          ctx.get(listenerCtx).markdownUpdated((_ctx, nextMarkdown, previousMarkdown) => {
            if (nextMarkdown !== previousMarkdown) onChange(nextMarkdown)
          })
          ctx.get(listenerCtx).selectionUpdated((_ctx, selection) => {
            const view = _ctx.get(editorViewCtx)
            if (view?.state) {
              setToolbarState(toolbarStateFromEditor(view.state))
              updateSlashMenu(view)
            }
            if (selection instanceof NodeSelection && selection.node.type.name === 'image') {
              setSelectedImage({ position: selection.from, alt: selection.node.attrs.alt ?? '' })
            } else {
              setSelectedImage(undefined)
            }
          })
          ctx.get(listenerCtx).updated((ctx) => {
            const view = ctx.get(editorViewCtx)
            if (view?.state) {
              setToolbarState(toolbarStateFromEditor(view.state))
              updateSlashMenu(view)
            }
          })
          ctx.get(listenerCtx).mounted((ctx) => {
            const view = ctx.get(editorViewCtx)
            if (view?.state) setToolbarState(toolbarStateFromEditor(view.state))
          })
          ctx.update(uploadConfig.key, (previous) => ({ ...previous, uploader, enableHtmlFileUploader: true }))
          ctx.update(inlineImageConfig.key, (previous) => ({ ...previous, onUpload: uploadImage, proxyDomURL: displayURL }))
        })
        .use(commonmark)
        .use(gfm)
        .use(history)
        .use(listener)
        .use(upload)
        .use(imageInlineComponent),
    [documentKey],
  )

  function callCommand<T>(command: { key: unknown }, payload?: T) {
    if (readOnly) return
    get()?.action((ctx) => {
      ctx.get(commandsCtx).call(command.key as never, payload as never)
      setToolbarState(toolbarStateFromEditor(ctx.get(editorViewCtx).state))
    })
  }

  function closeSlashMenu() {
    slashStateRef.current = undefined
    slashIndexRef.current = 0
    setSlashState(undefined)
    setSlashIndex(0)
  }

  function updateSlashMenu(view: EditorView) {
    if (readOnly || !view.state.selection.empty) {
      if (slashStateRef.current) closeSlashMenu()
      return
    }
    const { $from } = view.state.selection
    if (!$from.parent.isTextblock || $from.parent.type.name === 'code_block') {
      if (slashStateRef.current) closeSlashMenu()
      return
    }
    const beforeCursor = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
    const match = beforeCursor.match(/(^|\s)\/([a-z0-9-]*)$/i)
    if (!match) {
      if (slashStateRef.current) closeSlashMenu()
      return
    }
    const query = match[2]
    const from = $from.pos - query.length - 1
    const coordinates = view.coordsAtPos($from.pos)
    const next = { from, to: $from.pos, query, left: Math.max(8, Math.min(coordinates.left, window.innerWidth - 288)), top: Math.max(8, Math.min(coordinates.bottom + 6, window.innerHeight - 320)) }
    slashStateRef.current = next
    slashIndexRef.current = 0
    setSlashState(next)
    setSlashIndex(0)
  }

  function executeSlashCommand(id: SlashCommandID) {
    const active = slashStateRef.current
    if (!active || readOnly) return
    get()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      view.dispatch(view.state.tr.delete(active.from, active.to))
      view.focus()
    })
    closeSlashMenu()
    if (id === 'paragraph') setBlock('paragraph')
    else if (id.startsWith('heading-')) setBlock(id)
    else if (id === 'bullet-list') callCommand(wrapInBulletListCommand)
    else if (id === 'numbered-list') callCommand(wrapInOrderedListCommand)
    else if (id === 'task-list') toggleTaskList()
    else if (id === 'blockquote') callCommand(wrapInBlockquoteCommand)
    else if (id === 'code-block') callCommand(createCodeBlockCommand)
    else if (id === 'inline-code') toggleInlineCode()
    else if (id === 'link') editLink()
    else if (id === 'image') input.current?.click()
    else if (id === 'table') setTablePickerOpen(true)
    else if (id === 'horizontal-rule') callCommand(insertHrCommand)
  }

  function callProseCommand(command: Command) {
    if (readOnly) return
    get()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      command(view.state, view.dispatch, view)
      view.focus()
      setToolbarState(toolbarStateFromEditor(view.state))
    })
  }

  function toggleInlineCode() {
    if (readOnly) return
    get()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const mark = view.state.schema.marks.inlineCode
      if (!mark) return
      if (!view.state.selection.empty) {
        ctx.get(commandsCtx).call(toggleInlineCodeCommand.key)
      } else {
        const active = mark.isInSet(view.state.storedMarks ?? view.state.selection.$from.marks())
        const transaction = active ? view.state.tr.removeStoredMark(mark) : view.state.tr.addStoredMark(mark.create())
        view.dispatch(transaction)
      }
      view.focus()
      setToolbarState(toolbarStateFromEditor(view.state))
    })
  }

  function insertTable(size: TableSize) {
    callCommand(insertTableCommand, { row: size.rows, col: size.columns })
    setTablePickerOpen(false)
  }

  function syncToolbarAfterPointer() {
    globalThis.setTimeout(() => {
      get()?.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        if (view?.state) setToolbarState(toolbarStateFromEditor(view.state))
      })
    }, 0)
  }

  function selectImageFromPointer(target: HTMLElement) {
    const imageView = target.closest<HTMLElement>('.milkdown-image-inline')
    if (!imageView) return false
    get()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const position = view.posAtDOM(imageView, 0)
      const node = view.state.doc.nodeAt(position)
      if (!node || node.type.name !== 'image') return
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, position)))
      if (!readOnly) view.focus()
    })
    return true
  }

  function setBlock(block: string) {
    if (block === 'paragraph') callCommand(turnIntoTextCommand)
    else if (block === 'code-block') callCommand(createCodeBlockCommand)
    else callCommand(wrapInHeadingCommand, Number(block.replace('heading-', '')))
  }

  function editLink() {
    if (readOnly) return
    get()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const { from, to, empty, $from } = view.state.selection
      const link = linkSchema.type(ctx)
      const existing = link.isInSet(view.state.storedMarks ?? $from.marks())

      if (existing) {
        const href = window.prompt('Link URL (leave empty to remove the link)', existing.attrs.href ?? '')
        if (href === null) return
        const normalized = href.trim()
        if (normalized) ctx.get(commandsCtx).call(updateLinkCommand.key, { href: normalized })
        else ctx.get(commandsCtx).call(toggleLinkCommand.key)
      } else if (!empty) {
        const href = window.prompt('Link URL (leave empty to remove links)', 'https://')
        if (href === null) return
        const normalized = href.trim()
        const transaction = normalized
          ? view.state.tr.addMark(from, to, link.create({ href: normalized }))
          : view.state.tr.removeMark(from, to, link)
        view.dispatch(transaction)
      } else {
        const text = window.prompt('Link text', '')
        if (text === null || !text.trim()) return
        const href = window.prompt('Link URL', 'https://')
        if (href === null || !href.trim()) return
        const normalizedText = text.trim()
        const end = from + normalizedText.length
        let transaction = view.state.tr
          .insertText(normalizedText, from, to)
          .addMark(from, end, link.create({ href: href.trim() }))
          .removeStoredMark(link)
        transaction = transaction.setSelection(TextSelection.create(transaction.doc, end))
        view.dispatch(transaction)
      }
      view.focus()
      setToolbarState(toolbarStateFromEditor(view.state))
    })
  }

  function toggleTaskList() {
    if (readOnly) return
    get()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      let state = view.state
      let itemDepth = -1
      for (let depth = state.selection.$from.depth; depth > 0; depth -= 1) {
        if (state.selection.$from.node(depth).type.name === 'list_item') { itemDepth = depth; break }
      }
      if (itemDepth < 0) {
        ctx.get(commandsCtx).call(wrapInBulletListCommand.key)
        state = view.state
        for (let depth = state.selection.$from.depth; depth > 0; depth -= 1) {
          if (state.selection.$from.node(depth).type.name === 'list_item') { itemDepth = depth; break }
        }
      }
      if (itemDepth < 0) return
      const item = state.selection.$from.node(itemDepth)
      const position = state.selection.$from.before(itemDepth)
      view.dispatch(state.tr.setNodeMarkup(position, undefined, { ...item.attrs, checked: item.attrs.checked === null ? false : null }))
    })
  }

  async function insertSelectedImages(files: FileList | null) {
    if (!files?.length) return
    try {
      const uploadedImages = await Promise.all(Array.from(files).filter((file) => file.type.startsWith('image/')).map(uploadImage))
      if (uploadedImages.length) {
        get()?.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const schema = ctx.get(schemaCtx)
          let transaction = view.state.tr
          for (const [index, path] of uploadedImages.entries()) {
            const node = schema.nodes.image.create({ src: path, alt: '' })
            transaction = transaction.replaceSelectionWith(node)
            if (index < uploadedImages.length - 1) transaction = transaction.insertText(' ')
          }
          view.dispatch(transaction.scrollIntoView())
        })
      }
    } catch {
      // uploadImage already exposes the actionable error in the editor UI.
    } finally {
      if (input.current) input.current.value = ''
    }
  }

  async function replaceSelectedImage(files: FileList | null) {
    const file = Array.from(files ?? []).find((candidate) => candidate.type.startsWith('image/'))
    if (!file || readOnly || !selectedImage) return
    const selectedPosition = selectedImage.position
    try {
      const path = await uploadImage(file)
      get()?.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const node = view.state.doc.nodeAt(selectedPosition)
        if (!node || node.type.name !== 'image') {
          setUploadError('The selected image changed before replacement finished')
          return
        }
        view.dispatch(view.state.tr.setNodeMarkup(selectedPosition, undefined, { ...node.attrs, src: path }).scrollIntoView())
        setSelectedImage({ position: selectedPosition, alt: node.attrs.alt ?? '' })
      })
    } catch {
      // uploadImage already exposes the actionable error in the editor UI.
    } finally {
      if (replacementInput.current) replacementInput.current.value = ''
    }
  }

  function removeSelectedImage() {
    if (readOnly || !selectedImage) return
    get()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const node = view.state.doc.nodeAt(selectedImage.position)
      if (!node || node.type.name !== 'image') return
      view.dispatch(view.state.tr.delete(selectedImage.position, selectedImage.position + node.nodeSize))
      setSelectedImage(undefined)
    })
  }

  function saveImageMetadata() {
    if (readOnly || !selectedImage || editingAlt === undefined) return
    get()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const node = view.state.doc.nodeAt(selectedImage.position)
      if (!node || node.type.name !== 'image') return
      view.dispatch(view.state.tr.setNodeAttribute(selectedImage.position, 'alt', editingAlt).scrollIntoView())
      setSelectedImage({ position: selectedImage.position, alt: editingAlt })
      setEditingAlt(undefined)
    })
  }

  return (
    <div>
      <div aria-label="Editor toolbars" className="mb-3 space-y-1.5">
      <div role="toolbar" aria-label="Editor formatting" className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60 p-1.5">
        <ToolbarButton label="Undo" disabled={readOnly} onClick={() => callCommand(undoCommand)}>↶</ToolbarButton>
        <ToolbarButton label="Redo" disabled={readOnly} onClick={() => callCommand(redoCommand)}>↷</ToolbarButton>
        <ToolbarDivider />
        <select aria-label="Block type" disabled={readOnly} value={toolbarState.block} onChange={(event) => setBlock(event.target.value)} className="h-8 shrink-0 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200">
          <option value="paragraph">Paragraph</option>
          {[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={`heading-${level}`}>Heading {level}</option>)}
          <option value="code-block">Code block</option>
        </select>
        <ToolbarDivider />
        <ToolbarButton label="Bold" active={toolbarState.strong} disabled={readOnly} onClick={() => callCommand(toggleStrongCommand)}><strong>B</strong></ToolbarButton>
        <ToolbarButton label="Italic" active={toolbarState.emphasis} disabled={readOnly} onClick={() => callCommand(toggleEmphasisCommand)}><em>I</em></ToolbarButton>
        <ToolbarButton label="Strikethrough" active={toolbarState.strike} disabled={readOnly} onClick={() => callCommand(toggleStrikethroughCommand)}><span className="line-through">S</span></ToolbarButton>
        <ToolbarButton label="Inline code" active={toolbarState.code} disabled={readOnly} onClick={toggleInlineCode}>&lt;/&gt;</ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton label="Bullet list" active={toolbarState.bullet && !toolbarState.task} disabled={readOnly} onClick={() => callCommand(toolbarState.bullet ? liftListItemCommand : wrapInBulletListCommand)}>• List</ToolbarButton>
        <ToolbarButton label="Numbered list" active={toolbarState.ordered} disabled={readOnly} onClick={() => callCommand(toolbarState.ordered ? liftListItemCommand : wrapInOrderedListCommand)}>1. List</ToolbarButton>
        <ToolbarButton label="Task list" active={toolbarState.task} disabled={readOnly} onClick={toggleTaskList}>☐ Task</ToolbarButton>
        <ToolbarButton label="Blockquote" active={toolbarState.quote} disabled={readOnly} onClick={() => toolbarState.quote ? callProseCommand(lift) : callCommand(wrapInBlockquoteCommand)}>❯ Quote</ToolbarButton>
        <ToolbarButton label="Code block" active={toolbarState.block === 'code-block'} disabled={readOnly} onClick={() => callCommand(toolbarState.block === 'code-block' ? turnIntoTextCommand : createCodeBlockCommand)}>{'{ }'}</ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton label="Link" active={toolbarState.link} disabled={readOnly} onClick={editLink}>🔗</ToolbarButton>
        <ToolbarButton label="Insert image" disabled={readOnly || uploadState === 'uploading'} onClick={() => input.current?.click()}>{uploadState === 'uploading' ? '…' : 'Image'}</ToolbarButton>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple className="sr-only" onChange={(event) => { void insertSelectedImages(event.target.files) }} />
        <ToolbarButton label="Insert table" disabled={readOnly} onClick={() => setTablePickerOpen(true)}>Table</ToolbarButton>
        <ToolbarButton label="Horizontal rule" disabled={readOnly} onClick={() => callCommand(insertHrCommand)}>―</ToolbarButton>
      </div>

      {toolbarState.table && !readOnly && (
        <div role="toolbar" aria-label="Table editing" className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60 p-1.5">
          <span className="shrink-0 px-1 text-xs font-medium text-zinc-400">Table</span>
          <ToolbarDivider />
          <ToolbarButton label="Add row above" disabled={false} onClick={() => callCommand(addRowBeforeCommand)}>↑ Row</ToolbarButton>
          <ToolbarButton label="Add row below" disabled={false} onClick={() => callCommand(addRowAfterCommand)}>↓ Row</ToolbarButton>
          <ToolbarButton label="Delete current row" disabled={false} onClick={() => callProseCommand(deleteRow)}>Delete row</ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton label="Add column left" disabled={false} onClick={() => callCommand(addColBeforeCommand)}>← Column</ToolbarButton>
          <ToolbarButton label="Add column right" disabled={false} onClick={() => callCommand(addColAfterCommand)}>→ Column</ToolbarButton>
          <ToolbarButton label="Delete current column" disabled={false} onClick={() => callProseCommand(deleteColumn)}>Delete column</ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton label="Delete table" disabled={false} onClick={() => callProseCommand(deleteTable)}>Delete table</ToolbarButton>
        </div>
      )}

      {selectedImage && !readOnly && (
        <div role="toolbar" aria-label="Image editing" className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60 p-1.5">
          <span className="shrink-0 px-1 text-xs font-medium text-zinc-400">Image</span>
          <ToolbarDivider />
          <ToolbarButton label="Alt text" disabled={false} onClick={() => setEditingAlt(selectedImage.alt)}>Alt text</ToolbarButton>
          <ToolbarButton label="Replace image" disabled={uploadState === 'uploading'} onClick={() => replacementInput.current?.click()}>{uploadState === 'uploading' ? 'Replacing…' : 'Replace image'}</ToolbarButton>
          <ToolbarButton label="Remove image" disabled={false} onClick={removeSelectedImage}>Remove image</ToolbarButton>
          <input ref={replacementInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" onChange={(event) => { void replaceSelectedImage(event.target.files) }} />
        </div>
      )}
      </div>

      {readOnly && <p className="mb-3 text-xs text-zinc-500">Read only: select and copy without changing the note.</p>}
      {uploadError && <p className="mb-4 rounded-lg border border-red-900/70 bg-red-950/30 p-3 text-sm text-red-200">{uploadError}</p>}
      <div
        onPointerDownCapture={(event) => {
          const target = event.target as HTMLElement
          if (selectImageFromPointer(target)) return
          if (target.closest('table')) {
            setToolbarState((previous) => ({ ...previous, table: true }))
          }
        }}
        onPointerUp={syncToolbarAfterPointer}
      >
        <Milkdown />
      </div>

      {slashState && !readOnly && <SlashCommandMenu commands={filteredSlashCommands(slashState.query)} selectedIndex={slashIndex} left={slashState.left} top={slashState.top} onSelect={executeSlashCommand} />}

      {tablePickerOpen && !readOnly && <TablePicker size={tableSize} onPreview={setTableSize} onSelect={insertTable} onClose={() => setTablePickerOpen(false)} />}
      {editingAlt !== undefined && !readOnly && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingAlt(undefined) }}><form onSubmit={(event) => { event.preventDefault(); saveImageMetadata() }} role="dialog" aria-modal="true" aria-labelledby="image-metadata-title" className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"><h2 id="image-metadata-title" className="text-lg font-semibold text-zinc-100">Edit image</h2><label className="mt-4 block text-sm text-zinc-300">Alt text<input autoFocus value={editingAlt} onChange={(event) => setEditingAlt(event.target.value)} className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-amber-500" placeholder="Leave empty for a decorative image" /></label><p className="mt-2 text-xs text-zinc-500">Describe meaningful content briefly, or leave this empty for a decorative image.</p><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setEditingAlt(undefined)} className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button><button type="submit" className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400">Save</button></div></form></div>}
    </div>
  )
}

function SlashCommandMenu({ commands, selectedIndex, left, top, onSelect }: { commands: SlashCommand[]; selectedIndex: number; left: number; top: number; onSelect: (id: SlashCommandID) => void }) {
  const selected = commands[Math.min(selectedIndex, Math.max(0, commands.length - 1))]
  return <div role="listbox" aria-label="Slash commands" className="fixed z-50 max-h-72 w-72 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-1.5 shadow-2xl" style={{ left, top }}><span className="sr-only" aria-live="polite">{selected ? `${selected.label}: ${selected.description}` : 'No matching commands'}</span>{commands.length ? commands.map((command, index) => <button key={command.id} type="button" role="option" aria-selected={index === selectedIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(command.id)} className={`block min-h-12 w-full rounded-lg px-3 py-2 text-left ${index === selectedIndex ? 'bg-amber-400/15 text-amber-100' : 'text-zinc-200 hover:bg-zinc-800'}`}><span className="block text-sm font-medium">{command.label}</span><span className="block text-xs text-zinc-500">{command.description}</span></button>) : <p className="px-3 py-4 text-sm text-zinc-500">No matching commands</p>}</div>
}

function TablePicker({ size, onPreview, onSelect, onClose }: { size: TableSize; onPreview: (size: TableSize) => void; onSelect: (size: TableSize) => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 p-4 pt-24" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby="table-picker-title" className="w-fit max-w-full rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl">
        <div className="flex items-center justify-between gap-6">
          <h2 id="table-picker-title" className="text-sm font-semibold text-zinc-100">Insert table</h2>
          <button type="button" aria-label="Close table picker" onClick={onClose} className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-white">×</button>
        </div>
        <div className="mt-3 grid grid-cols-10 gap-1" role="grid" aria-label="Table dimensions">
          {Array.from({ length: 100 }, (_, index) => {
            const rows = Math.floor(index / 10) + 1
            const columns = (index % 10) + 1
            const active = rows <= size.rows && columns <= size.columns
            return <button key={`${rows}-${columns}`} type="button" role="gridcell" aria-label={`Insert ${columns} columns by ${rows} rows`} onPointerEnter={() => onPreview({ rows, columns })} onFocus={() => onPreview({ rows, columns })} onClick={() => onSelect({ rows, columns })} className={`h-6 w-6 rounded-sm border sm:h-7 sm:w-7 ${active ? 'border-amber-400 bg-amber-400/25' : 'border-zinc-600 bg-zinc-950 hover:border-zinc-400'}`} />
          })}
        </div>
        <p aria-live="polite" className="mt-3 text-center text-xs text-zinc-300">{size.columns} × {size.rows} <span className="text-zinc-500">(1 header + {Math.max(0, size.rows - 1)} body {size.rows === 2 ? 'row' : 'rows'})</span></p>
      </div>
    </div>
  )
}

function ToolbarButton({ label, active = false, disabled, onClick, children }: { label: string; active?: boolean; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={onClick} className={`h-8 shrink-0 rounded px-2 text-xs font-medium disabled:cursor-default disabled:opacity-35 ${active ? 'border border-amber-500 bg-amber-400/15 text-amber-200 shadow-inner' : 'border border-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white'}`}>{children}<span className="sr-only">{active ? ' active' : ''}</span></button>
}

function ToolbarDivider() { return <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-zinc-700" /> }
