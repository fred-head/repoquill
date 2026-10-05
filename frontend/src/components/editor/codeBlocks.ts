import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import highlight from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { $prose, $view } from '@milkdown/kit/utils'
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type ViewMutationRecord } from '@milkdown/kit/prose/view'

export const codeBlockLanguages = [
  { label: 'Plain text', value: '' },
  { label: 'Shell / Bash', value: 'bash' },
  { label: 'PowerShell', value: 'powershell' },
  { label: 'Python', value: 'python' },
  { label: 'JavaScript', value: 'javascript' },
  { label: 'TypeScript', value: 'typescript' },
  { label: 'JSON', value: 'json' },
  { label: 'YAML', value: 'yaml' },
  { label: 'Markdown', value: 'markdown' },
  { label: 'HTML', value: 'html' },
  { label: 'CSS', value: 'css' },
  { label: 'SQL', value: 'sql' },
  { label: 'Go', value: 'go' },
  { label: 'Dockerfile', value: 'dockerfile' },
] as const

highlight.registerLanguage('bash', bash)
highlight.registerLanguage('css', css)
highlight.registerLanguage('dockerfile', dockerfile)
highlight.registerLanguage('go', go)
highlight.registerLanguage('javascript', javascript)
highlight.registerLanguage('json', json)
highlight.registerLanguage('markdown', markdown)
highlight.registerLanguage('powershell', powershell)
highlight.registerLanguage('python', python)
highlight.registerLanguage('sql', sql)
highlight.registerLanguage('typescript', typescript)
highlight.registerLanguage('xml', xml)
highlight.registerLanguage('yaml', yaml)

const highlightedLanguageAliases: Record<string, string> = {
  bash: 'bash',
  shell: 'bash',
  sh: 'bash',
  powershell: 'powershell',
  ps1: 'powershell',
  python: 'python',
  py: 'python',
  javascript: 'javascript',
  js: 'javascript',
  typescript: 'typescript',
  ts: 'typescript',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  markdown: 'markdown',
  md: 'markdown',
  html: 'xml',
  xml: 'xml',
  css: 'css',
  sql: 'sql',
  go: 'go',
  dockerfile: 'dockerfile',
}

function normalizedLanguage(language: unknown): string {
  return typeof language === 'string' ? language.toLowerCase() : ''
}

export function codeBlockLanguageLabel(language: unknown): string {
  const value = typeof language === 'string' ? language : ''
  const normalized = normalizedLanguage(value)
  const canonical = highlightedLanguageAliases[normalized]
  const languageOption = canonical === 'xml' ? 'html' : canonical
  const selected = codeBlockLanguages.find((option) => option.value === normalized)
    ?? codeBlockLanguages.find((option) => option.value === languageOption)
  return selected?.label ?? (value ? `Unrecognized language: ${value}` : 'Plain text')
}

function addBlockHighlights(node: ProseMirrorNode, position: number): Decoration[] {
  const language = highlightedLanguageAliases[normalizedLanguage(node.attrs.language)]
  if (!language || !highlight.getLanguage(language) || node.textContent.length > 100_000) return []

  try {
    const result = highlight.highlight(node.textContent, { language, ignoreIllegals: true })
    const template = document.createElement('template')
    template.innerHTML = result.value
    if (template.content.textContent !== node.textContent) return []

    const ranges: Decoration[] = []
    let offset = 0
    const visit = (current: globalThis.Node, inherited: string[]) => {
      if (current.nodeType === globalThis.Node.TEXT_NODE) {
        const text = current.textContent ?? ''
        const from = offset
        offset += text.length
        const classes = [...new Set(inherited)]
        if (text.length && classes.length) {
          ranges.push(Decoration.inline(position + 1 + from, position + 1 + offset, { class: classes.join(' ') }))
        }
        return
      }

      const tokenClasses = current instanceof HTMLElement
        ? Array.from(current.classList).filter((name) => /^hljs-[a-z0-9_-]+$/.test(name))
        : []
      for (const child of Array.from(current.childNodes)) visit(child, [...inherited, ...tokenClasses])
    }
    visit(template.content, [])
    return ranges
  } catch {
    // A malformed or unsupported code sample stays readable as plain text.
    return []
  }
}

function codeBlockDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, position) => {
    if (node.type.name === 'code_block') decorations.push(...addBlockHighlights(node, position))
  })
  return DecorationSet.create(doc, decorations)
}

const codeHighlightKey = new PluginKey<DecorationSet>('repoquillCodeHighlight')

export const codeHighlightPlugin = $prose(() => new Plugin<DecorationSet>({
  key: codeHighlightKey,
  state: {
    init: (_config, state) => codeBlockDecorations(state.doc),
    apply: (transaction, previous, _oldState, nextState) => transaction.docChanged
      ? codeBlockDecorations(nextState.doc)
      : previous.map(transaction.mapping, transaction.doc),
  },
  props: {
    decorations: (state) => codeHighlightKey.getState(state),
  },
}))

export const codeBlockView = $view(codeBlockSchema.node, () => (initialNode) => {
  const dom = document.createElement('div')
  dom.className = 'repoquill-code-block'

  const header = document.createElement('div')
  header.className = 'repoquill-code-block-header'

  const language = document.createElement('span')
  language.className = 'repoquill-code-block-language'
  language.setAttribute('aria-label', 'Code block language')

  const copyButton = document.createElement('button')
  copyButton.type = 'button'
  copyButton.className = 'repoquill-code-block-copy'
  copyButton.setAttribute('aria-label', 'Copy code block')
  copyButton.setAttribute('contenteditable', 'false')
  copyButton.textContent = 'Copy'

  const status = document.createElement('span')
  status.className = 'repoquill-code-block-copy-status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  status.hidden = true

  header.append(language, copyButton, status)

  const pre = document.createElement('pre')
  pre.className = 'repoquill-code-block-pre'
  const contentDOM = document.createElement('code')
  contentDOM.className = 'repoquill-code-block-content'
  pre.append(contentDOM)
  dom.append(header, pre)

  let currentNode = initialNode
  const render = (node: ProseMirrorNode) => {
    language.textContent = codeBlockLanguageLabel(node.attrs.language)
    language.dataset.language = typeof node.attrs.language === 'string' ? node.attrs.language : ''
  }

  const copy = async () => {
    try {
      const clipboard = navigator.clipboard
      if (!clipboard?.writeText) throw new Error('Clipboard access is unavailable')
      await clipboard.writeText(currentNode.textContent)
      status.hidden = false
      status.textContent = 'Code copied.'
    } catch {
      status.hidden = false
      status.textContent = 'Copy failed. Select and copy the code manually.'
    }
  }
  const preserveEditorSelection = (event: MouseEvent) => event.preventDefault()
  copyButton.addEventListener('click', copy)
  copyButton.addEventListener('mousedown', preserveEditorSelection)
  render(initialNode)

  return {
    dom,
    contentDOM,
    update: (node: ProseMirrorNode) => {
      if (node.type !== initialNode.type) return false
      currentNode = node
      render(node)
      return true
    },
    stopEvent: (event: Event) => event.target instanceof HTMLElement && copyButton.contains(event.target),
    ignoreMutation: (mutation: ViewMutationRecord) => mutation.type !== 'selection' && !contentDOM.contains(mutation.target),
    selectNode: () => dom.classList.add('ProseMirror-selectednode'),
    deselectNode: () => dom.classList.remove('ProseMirror-selectednode'),
    destroy: () => {
      copyButton.removeEventListener('click', copy)
      copyButton.removeEventListener('mousedown', preserveEditorSelection)
    },
  }
})
