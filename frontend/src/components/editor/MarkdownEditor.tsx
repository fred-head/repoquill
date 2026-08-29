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
import { apiFetch } from '../../api'

type MarkdownEditorProps = {
  documentKey: string
  notePath: string
  markdown: string
  readOnly: boolean
  onChange: (markdown: string) => void
  notePaths?: string[]
  onOpenNoteLink?: (path: string, disposition: 'current' | 'new') => void
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
type NoteLinkTriggerState = { from:number; to:number; query:string; left:number; top:number }
type SlashCommandID = 'paragraph' | 'heading-1' | 'heading-2' | 'heading-3' | 'heading-4' | 'heading-5' | 'heading-6' | 'bullet-list' | 'numbered-list' | 'task-list' | 'blockquote' | 'code-block' | 'inline-code' | 'link' | 'image' | 'table' | 'horizontal-rule'
type SlashCommand = { id: SlashCommandID; label: string; description: string; keywords: string }
type LinkDraft = { from: number; to: number; selectedText: string; existingHref?: string }
type SelectedLink = { href: string; targetPath?: string; exists: boolean }
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

function filteredNotePaths(query:string, notePaths:string[], currentPath:string):string[] {
  const normalized = query.trim().toLowerCase()
  return notePaths.filter((path) => path !== currentPath && (!normalized || path.toLowerCase().includes(normalized))).slice(0,100)
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

function resolveInternalNotePath(notePath: string, href: string): string | undefined {
  if (!href || href.startsWith('#') || href.startsWith('/') || href.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined
  const withoutSuffix = href.split(/[?#]/, 1)[0]
  let decoded: string
  try { decoded = decodeURIComponent(withoutSuffix) } catch { return undefined }
  if (!decoded.toLowerCase().endsWith('.md')) return undefined
  const stack = notePath.split('/').slice(0, -1)
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!stack.length) return undefined
      stack.pop()
    } else stack.push(part)
  }
  return stack.join('/')
}

function portableRelativeNoteHref(notePath: string, targetPath: string): string {
  const source = notePath.split('/').slice(0, -1)
  const target = targetPath.split('/')
  let common = 0
  while (common < source.length && common < target.length && source[common] === target[common]) common += 1
  const parts = [...Array.from({ length: source.length - common }, () => '..'), ...target.slice(common).map((part) => encodeURIComponent(part))]
  return parts.join('/') || encodeURIComponent(target[target.length - 1])
}

function MilkdownEditor({ documentKey, notePath, markdown, readOnly, onChange, notePaths = [], onOpenNoteLink }: MarkdownEditorProps) {
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
  const [linkPicker, setLinkPicker] = useState<LinkDraft>()
  const [selectedLink, setSelectedLink] = useState<SelectedLink>()
  const [linkError, setLinkError] = useState<string>()
  const [noteLinkTrigger, setNoteLinkTrigger] = useState<NoteLinkTriggerState>()
  const [noteLinkTriggerIndex, setNoteLinkTriggerIndex] = useState(0)
  const slashStateRef = useRef<SlashState | undefined>(undefined)
  const slashIndexRef = useRef(0)
  const notePathsRef = useRef(notePaths)
  const openNoteLinkRef = useRef(onOpenNoteLink)
  const noteLinkTriggerRef = useRef<NoteLinkTriggerState | undefined>(undefined)
  const noteLinkTriggerIndexRef = useRef(0)
  notePathsRef.current = notePaths
  openNoteLinkRef.current = onOpenNoteLink


  async function uploadImage(file: File): Promise<string> {
    if (readOnly) throw new Error('Switch to Edit before inserting an image')
    setUploadState('uploading')
    setUploadError(undefined)
    try {
      const form = new FormData()
      form.append('file', file)
      const response = await apiFetch(`/api/repository/assets?note=${encodeURIComponent(notePath)}`, { method: 'POST', body: form })
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

  function updateSelectedLink(state: EditorState) {
    const mark = state.schema.marks.link?.isInSet(state.storedMarks ?? state.selection.$from.marks())
    if (!mark) {
      setSelectedLink(undefined)
      return
    }
    const href = String(mark.attrs.href ?? '')
    const targetPath = resolveInternalNotePath(notePath, href)
    setSelectedLink({ href, targetPath, exists: Boolean(targetPath && notePathsRef.current.includes(targetPath)) })
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
              const activeNoteLink = noteLinkTriggerRef.current
              if (activeNoteLink && event.key === 'Escape') {
                event.preventDefault()
                closeNoteLinkTrigger()
                return true
              }
              if (activeNoteLink && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault()
                const options = filteredNotePaths(activeNoteLink.query, notePathsRef.current, notePath)
                if (!options.length) return true
                const direction = event.key === 'ArrowDown' ? 1 : -1
                const next = (noteLinkTriggerIndexRef.current + direction + options.length) % options.length
                noteLinkTriggerIndexRef.current = next
                setNoteLinkTriggerIndex(next)
                return true
              }
              if (activeNoteLink && event.key === 'Enter') {
                const options = filteredNotePaths(activeNoteLink.query, notePathsRef.current, notePath)
                if (options.length) {
                  event.preventDefault()
                  insertTriggeredNoteLink(options[Math.min(noteLinkTriggerIndexRef.current, options.length - 1)])
                  return true
                }
              }
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
            handleDOMEvents: {
              ...previous.handleDOMEvents,
              click: (view, event) => {
                const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href]')
                if (!anchor) return previous.handleDOMEvents?.click?.(view, event) ?? false
                const href = anchor.getAttribute('href') ?? ''
                const targetPath = resolveInternalNotePath(notePath, href)
                if (!targetPath) return previous.handleDOMEvents?.click?.(view, event) ?? false
                event.preventDefault()
                if (!notePathsRef.current.includes(targetPath)) {
                  setLinkError(`Linked note not found: ${targetPath}`)
                  return true
                }
                setLinkError(undefined)
                openNoteLinkRef.current?.(targetPath, event.ctrlKey || event.metaKey ? 'new' : 'current')
                return true
              },
            },
          }))
          ctx.get(listenerCtx).markdownUpdated((_ctx, nextMarkdown, previousMarkdown) => {
            if (nextMarkdown !== previousMarkdown) onChange(nextMarkdown)
          })
          ctx.get(listenerCtx).selectionUpdated((_ctx, selection) => {
            const view = _ctx.get(editorViewCtx)
            if (view?.state) {
              setToolbarState(toolbarStateFromEditor(view.state))
              updateSelectedLink(view.state)
              updateSlashMenu(view)
              updateNoteLinkTrigger(view)
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
              updateSelectedLink(view.state)
              updateSlashMenu(view)
              updateNoteLinkTrigger(view)
            }
          })
          ctx.get(listenerCtx).mounted((ctx) => {
            const view = ctx.get(editorViewCtx)
            if (view?.state) {
              setToolbarState(toolbarStateFromEditor(view.state))
              updateSelectedLink(view.state)
              updateNoteLinkTrigger(view)
            }
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

  function closeNoteLinkTrigger() {
    noteLinkTriggerRef.current = undefined
    noteLinkTriggerIndexRef.current = 0
    setNoteLinkTrigger(undefined)
    setNoteLinkTriggerIndex(0)
  }

  function updateNoteLinkTrigger(view:EditorView) {
    if (readOnly || !view.state.selection.empty) {
      if (noteLinkTriggerRef.current) closeNoteLinkTrigger()
      return
    }
    const { $from } = view.state.selection
    if (!$from.parent.isTextblock || $from.parent.type.name === 'code_block') {
      if (noteLinkTriggerRef.current) closeNoteLinkTrigger()
      return
    }
    const beforeCursor = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
    // Milkdown's input rules can normalize the two typed opening brackets to
    // one before this listener observes the document. Supporting either form
    // keeps the note suggestion usable without persisting wiki-link syntax.
    const match = beforeCursor.match(/\[\[?([^\]\n]*)$/)
    if (!match) {
      if (noteLinkTriggerRef.current) closeNoteLinkTrigger()
      return
    }
    const query = match[1]
    const from = $from.pos - match[0].length
    const coordinates = view.coordsAtPos($from.pos)
    const next = { from, to:$from.pos, query, left:Math.max(8,Math.min(coordinates.left,window.innerWidth-320)), top:Math.max(8,Math.min(coordinates.bottom+6,window.innerHeight-320)) }
    noteLinkTriggerRef.current = next
    noteLinkTriggerIndexRef.current = 0
    setNoteLinkTrigger(next)
    setNoteLinkTriggerIndex(0)
  }

  function insertTriggeredNoteLink(targetPath:string) {
    const active = noteLinkTriggerRef.current
    if (!active || readOnly) return
    get()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const link = linkSchema.type(ctx)
      const label = targetPath.split('/').pop()?.replace(/\.md$/i,'') || 'Note'
      const href = portableRelativeNoteHref(notePath,targetPath)
      const end = active.from + label.length
      let transaction = view.state.tr.delete(active.from,active.to).insertText(label,active.from).addMark(active.from,end,link.create({ href })).removeStoredMark(link)
      transaction = transaction.setSelection(TextSelection.create(transaction.doc,end))
      view.dispatch(transaction)
      view.focus()
    })
    closeNoteLinkTrigger()
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
      setLinkPicker({ from, to, selectedText: empty ? '' : view.state.doc.textBetween(from, to, ' '), existingHref: existing ? String(existing.attrs.href ?? '') : undefined })
    })
  }

  function applyLink(href: string, label?: string) {
    const draft = linkPicker
    if (!draft || readOnly) return
    get()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const link = linkSchema.type(ctx)
      const normalizedHref = href.trim()
      if (draft.existingHref !== undefined) {
        if (normalizedHref) ctx.get(commandsCtx).call(updateLinkCommand.key, { href: normalizedHref })
        else ctx.get(commandsCtx).call(toggleLinkCommand.key)
      } else if (draft.from !== draft.to) {
        const transaction = normalizedHref
          ? view.state.tr.addMark(draft.from, draft.to, link.create({ href: normalizedHref }))
          : view.state.tr.removeMark(draft.from, draft.to, link)
        view.dispatch(transaction)
      } else if (normalizedHref) {
        const text = (label || 'Link').trim()
        const end = draft.from + text.length
        let transaction = view.state.tr.insertText(text, draft.from, draft.to).addMark(draft.from, end, link.create({ href: normalizedHref })).removeStoredMark(link)
        transaction = transaction.setSelection(TextSelection.create(transaction.doc, end))
        view.dispatch(transaction)
      }
      view.focus()
      setToolbarState(toolbarStateFromEditor(view.state))
      updateSelectedLink(view.state)
    })
    setLinkPicker(undefined)
  }

  function openSelectedInternalLink(disposition: 'current' | 'new') {
    if (!selectedLink?.targetPath) return
    if (!selectedLink.exists) {
      setLinkError(`Linked note not found: ${selectedLink.targetPath}`)
      return
    }
    setLinkError(undefined)
    openNoteLinkRef.current?.(selectedLink.targetPath, disposition)
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

      {selectedLink?.targetPath && (
        <div role="toolbar" aria-label="Internal note link" className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60 p-1.5">
          <span className="shrink-0 px-1 text-xs font-medium text-zinc-400">Note link</span>
          <span className={`shrink-0 px-1 text-xs ${selectedLink.exists ? 'text-zinc-500' : 'text-red-300'}`}>{selectedLink.exists ? selectedLink.targetPath : `Missing: ${selectedLink.targetPath}`}</span>
          <ToolbarDivider />
          <ToolbarButton label="Open linked note" disabled={!selectedLink.exists} onClick={() => openSelectedInternalLink('current')}>Open</ToolbarButton>
          <ToolbarButton label="Open linked note in new tab" disabled={!selectedLink.exists} onClick={() => openSelectedInternalLink('new')}>Open in new tab</ToolbarButton>
          {!readOnly && <ToolbarButton label="Edit link" disabled={false} onClick={editLink}>Edit link</ToolbarButton>}
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
      {linkError && <p role="alert" className="mb-4 rounded-lg border border-red-900/70 bg-red-950/30 p-3 text-sm text-red-200">{linkError}</p>}
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
      {noteLinkTrigger && !readOnly && <NoteLinkTriggerMenu paths={filteredNotePaths(noteLinkTrigger.query,notePaths,notePath)} selectedIndex={noteLinkTriggerIndex} left={noteLinkTrigger.left} top={noteLinkTrigger.top} onSelect={insertTriggeredNoteLink} />}

      {tablePickerOpen && !readOnly && <TablePicker size={tableSize} onPreview={setTableSize} onSelect={insertTable} onClose={() => setTablePickerOpen(false)} />}
      {linkPicker && !readOnly && <LinkPicker notePath={notePath} notePaths={notePaths} draft={linkPicker} onApply={applyLink} onClose={() => setLinkPicker(undefined)} />}
      {editingAlt !== undefined && !readOnly && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingAlt(undefined) }}><form onSubmit={(event) => { event.preventDefault(); saveImageMetadata() }} role="dialog" aria-modal="true" aria-labelledby="image-metadata-title" className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"><h2 id="image-metadata-title" className="text-lg font-semibold text-zinc-100">Edit image</h2><label className="mt-4 block text-sm text-zinc-300">Alt text<input autoFocus value={editingAlt} onChange={(event) => setEditingAlt(event.target.value)} className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-amber-500" placeholder="Leave empty for a decorative image" /></label><p className="mt-2 text-xs text-zinc-500">Describe meaningful content briefly, or leave this empty for a decorative image.</p><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setEditingAlt(undefined)} className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button><button type="submit" className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400">Save</button></div></form></div>}
    </div>
  )
}

function SlashCommandMenu({ commands, selectedIndex, left, top, onSelect }: { commands: SlashCommand[]; selectedIndex: number; left: number; top: number; onSelect: (id: SlashCommandID) => void }) {
  const selected = commands[Math.min(selectedIndex, Math.max(0, commands.length - 1))]
  return <div role="listbox" aria-label="Slash commands" className="fixed z-50 max-h-72 w-72 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-1.5 shadow-2xl" style={{ left, top }}><span className="sr-only" aria-live="polite">{selected ? `${selected.label}: ${selected.description}` : 'No matching commands'}</span>{commands.length ? commands.map((command, index) => <button key={command.id} type="button" role="option" aria-selected={index === selectedIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(command.id)} className={`block min-h-12 w-full rounded-lg px-3 py-2 text-left ${index === selectedIndex ? 'bg-amber-400/15 text-amber-100' : 'text-zinc-200 hover:bg-zinc-800'}`}><span className="block text-sm font-medium">{command.label}</span><span className="block text-xs text-zinc-500">{command.description}</span></button>) : <p className="px-3 py-4 text-sm text-zinc-500">No matching commands</p>}</div>
}

function NoteLinkTriggerMenu({ paths, selectedIndex, left, top, onSelect }: { paths:string[]; selectedIndex:number; left:number; top:number; onSelect:(path:string)=>void }) {
  return <div role="listbox" aria-label="Internal note suggestions" className="fixed z-50 max-h-72 w-80 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-1.5 shadow-2xl" style={{ left,top }}>{paths.length ? paths.map((path,index) => <button key={path} type="button" role="option" aria-selected={index===selectedIndex} onMouseDown={(event)=>event.preventDefault()} onClick={()=>onSelect(path)} className={`block min-h-12 w-full rounded-lg px-3 py-2 text-left ${index===selectedIndex?'bg-amber-400/15 text-amber-100':'text-zinc-200 hover:bg-zinc-800'}`}><span className="block truncate text-sm font-medium">{path.split('/').pop()?.replace(/\.md$/i,'')}</span><span className="block truncate text-xs text-zinc-500">{path}</span></button>) : <p className="px-3 py-4 text-sm text-zinc-500">No matching notes</p>}</div>
}

function LinkPicker({ notePath, notePaths, draft, onApply, onClose }: { notePath:string; notePaths:string[]; draft:LinkDraft; onApply:(href:string,label?:string)=>void; onClose:()=>void }) {
  const [query, setQuery] = useState('')
  const [externalURL, setExternalURL] = useState(draft.existingHref ?? '')
  const [label, setLabel] = useState(draft.selectedText)
  const normalized = query.trim().toLowerCase()
  const matches = notePaths.filter((path) => path !== notePath && (!normalized || path.toLowerCase().includes(normalized))).slice(0, 100)
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section role="dialog" aria-modal="true" aria-labelledby="link-picker-title" className="flex max-h-[92vh] w-full max-w-xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"><header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3"><div><h2 id="link-picker-title" className="text-lg font-semibold text-zinc-100">Insert link</h2><p className="mt-1 text-xs text-zinc-500">Choose a note or enter an external URL. Internal links remain ordinary relative Markdown links.</p></div><button type="button" aria-label="Close link picker" onClick={onClose} className="min-h-10 min-w-10 rounded text-xl text-zinc-500 hover:bg-zinc-800">×</button></header><div className="min-h-0 overflow-y-auto p-4">{draft.from === draft.to && draft.existingHref === undefined && <label className="mb-4 block text-sm text-zinc-300">Link text<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Descriptive link text" className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-amber-500" /></label>}<label className="block text-sm text-zinc-300">Find a note<input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notebook paths…" className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-amber-500" /></label><div role="listbox" aria-label="Notebook notes" className="mt-3 max-h-64 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 p-1">{matches.map((target) => <button key={target} type="button" role="option" aria-selected={false} onClick={() => onApply(portableRelativeNoteHref(notePath,target), label || draft.selectedText || target.split('/').pop()?.replace(/\.md$/i,'') || 'Note')} className="block min-h-11 w-full rounded px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800"><span className="block truncate">{target.split('/').pop()?.replace(/\.md$/i,'')}</span><span className="block truncate text-xs text-zinc-500">{target}</span></button>)}{matches.length === 0 && <p className="px-3 py-4 text-sm text-zinc-500">No matching notes.</p>}</div><form className="mt-5 border-t border-zinc-800 pt-4" onSubmit={(event) => { event.preventDefault(); if (externalURL.trim()) onApply(externalURL.trim(), label || draft.selectedText || 'Link') }}><label className="block text-sm text-zinc-300">External URL or custom Markdown destination<input value={externalURL} onChange={(event) => setExternalURL(event.target.value)} placeholder="https://example.com" className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-amber-500" /></label><div className="mt-4 flex flex-wrap justify-end gap-2">{draft.existingHref !== undefined && <button type="button" onClick={() => onApply('')} className="min-h-10 rounded-md border border-red-900 px-4 text-sm text-red-300 hover:bg-red-950/30">Remove link</button>}<button type="button" onClick={onClose} className="min-h-10 rounded-md border border-zinc-700 px-4 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button><button type="submit" disabled={!externalURL.trim()} className="min-h-10 rounded-md bg-amber-500 px-4 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40">Apply URL</button></div></form></div></section></div>
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
