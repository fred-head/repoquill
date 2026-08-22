export type DocumentStats = {
  words: number
  characters: number
  lines: number
}

export function documentStats(markdown: string): DocumentStats {
  const words = markdown.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length ?? 0
  return {
    words,
    characters: Array.from(markdown).length,
    lines: markdown.length === 0 ? 0 : markdown.split(/\r\n|\r|\n/).length,
  }
}
