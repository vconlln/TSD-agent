import { createTwoFilesPatch, diffWordsWithSpace } from 'diff'
import type { DiffFile, PlanSectionDiff } from '../../shared/types'

export type RowKind = 'context' | 'add' | 'del' | 'hunk'

export interface WordPart {
  kind: 'same' | 'add' | 'del'
  text: string
}

export interface DiffRow {
  kind: RowKind
  oldNo?: number
  newNo?: number
  text: string
  word?: WordPart[]
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  rows: DiffRow[]
}

export interface ParsedPatch {
  meta: string[]
  hunks: DiffHunk[]
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

export function parsePatch(patch: string): ParsedPatch {
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  const meta: string[] = []
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const line of lines) {
    const m = line.match(HUNK_RE)
    if (m) {
      current = {
        header: line,
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        rows: [],
      }
      oldNo = current.oldStart
      newNo = current.newStart
      hunks.push(current)
      continue
    }
    if (!current) {
      if (line.trim()) meta.push(line)
      continue
    }
    if (line.startsWith('\\')) continue // \ No newline at end of file
    const marker = line[0] ?? ' '
    const text = line.slice(1)
    if (marker === '+') {
      current.rows.push({ kind: 'add', newNo: newNo++, text })
    } else if (marker === '-') {
      current.rows.push({ kind: 'del', oldNo: oldNo++, text })
    } else if (marker === ' ') {
      current.rows.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text })
    }
  }

  // mark the hunk header as a row for rendering
  for (const hunk of hunks) {
    if (hunk.rows.length === 0) hunk.rows.push({ kind: 'context', text: '' })
  }
  attachWordDiff(hunks)
  return { meta, hunks }
}

/** Pair a run of deletions with the following run of additions to compute intra-line diff. */
function attachWordDiff(hunks: DiffHunk[]) {
  for (const hunk of hunks) {
    let i = 0
    const rows = hunk.rows
    while (i < rows.length) {
      if (rows[i].kind !== 'del') {
        i++
        continue
      }
      const delStart = i
      while (i < rows.length && rows[i].kind === 'del') i++
      const delEnd = i
      const addStart = i
      while (i < rows.length && rows[i].kind === 'add') i++
      const addEnd = i
      const delCount = delEnd - delStart
      const addCount = addEnd - addStart
      if (delCount === 0 || addCount === 0) continue
      const pairs = Math.min(delCount, addCount)
      for (let k = 0; k < pairs; k++) {
        const delRow = rows[delStart + k]
        const addRow = rows[addStart + k]
        const parts = diffWordsWithSpace(delRow.text, addRow.text)
        const delParts: WordPart[] = []
        const addParts: WordPart[] = []
        for (const p of parts) {
          if (p.added) addParts.push({ kind: 'add', text: p.value })
          else if (p.removed) delParts.push({ kind: 'del', text: p.value })
          else {
            delParts.push({ kind: 'same', text: p.value })
            addParts.push({ kind: 'same', text: p.value })
          }
        }
        delRow.word = delParts
        addRow.word = addParts
      }
    }
  }
}

export interface SplitRow {
  left: DiffRow | null
  right: DiffRow | null
}

/** Transform unified rows into side-by-side pairs (GitHub-like). */
export function toSplitRows(hunk: DiffHunk): SplitRow[] {
  const out: SplitRow[] = []
  const rows = hunk.rows
  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (row.kind === 'context') {
      out.push({ left: row, right: row })
      i++
      continue
    }
    if (row.kind === 'del') {
      const dels: DiffRow[] = []
      while (i < rows.length && rows[i].kind === 'del') dels.push(rows[i++])
      const adds: DiffRow[] = []
      while (i < rows.length && rows[i].kind === 'add') adds.push(rows[i++])
      const max = Math.max(dels.length, adds.length)
      for (let k = 0; k < max; k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null })
      continue
    }
    if (row.kind === 'add') {
      out.push({ left: null, right: row })
      i++
      continue
    }
    i++
  }
  return out
}

export interface DiffSummary {
  added: number
  removed: number
  changed: number
  addedFiles: number
  deletedFiles: number
  modifiedFiles: number
  renamedFiles: number
}

export function summarizeDiff(files: DiffFile[]): DiffSummary {
  const summary: DiffSummary = {
    added: 0,
    removed: 0,
    changed: files.length,
    addedFiles: 0,
    deletedFiles: 0,
    modifiedFiles: 0,
    renamedFiles: 0,
  }
  for (const f of files) {
    summary.added += f.additions || 0
    summary.removed += f.deletions || 0
    if (f.status === 'added') summary.addedFiles++
    else if (f.status === 'deleted') summary.deletedFiles++
    else if (f.status === 'renamed') summary.renamedFiles++
    else summary.modifiedFiles++
  }
  return summary
}

/** Build a unified patch between two texts (used for plan sections). */
export function makePatch(
  oldText: string,
  newText: string,
  oldName = 'a/PLAN.md',
  newName = 'b/PLAN.md',
  context = 3,
): string {
  return createTwoFilesPatch(oldName, newName, oldText ?? '', newText ?? '', '', '', { context })
}

/* --------------------------- markdown plan --------------------------- */

export interface MdSection {
  key: string
  heading: string
  level: number
  text: string
}

export function splitMarkdownSections(md: string): MdSection[] {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n')
  const sections: MdSection[] = []
  let heading = '前言'
  let level = 0
  let buf: string[] = []
  let inFence = false
  const push = () => {
    const text = buf.join('\n').trim()
    if (text || level > 0) {
      sections.push({ key: `${level}::${heading.trim()}`, heading: heading.trim(), level, text })
    }
    buf = []
  }
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence
    const m = !inFence ? line.match(/^(#{1,6})\s+(.*)$/) : null
    if (m) {
      push()
      level = m[1].length
      heading = m[2]
    } else {
      buf.push(line)
    }
  }
  push()
  return sections.filter((s) => s.heading !== '前言' || s.text)
}

/** Local fallback when the backend does not supply section-level plan diffs. */
export function diffMarkdownSections(oldMd: string, newMd: string): PlanSectionDiff[] {
  const oldSections = splitMarkdownSections(oldMd)
  const newSections = splitMarkdownSections(newMd)
  const oldMap = new Map(oldSections.map((s) => [s.key, s]))
  const newMap = new Map(newSections.map((s) => [s.key, s]))
  const result: PlanSectionDiff[] = []

  for (const section of newSections) {
    const before = oldMap.get(section.key)
    if (!before) {
      result.push({
        key: section.key,
        heading: section.heading || '（无标题）',
        level: section.level,
        status: 'added',
        newText: section.text,
      })
    } else if (before.text.trim() !== section.text.trim()) {
      result.push({
        key: section.key,
        heading: section.heading || '（无标题）',
        level: section.level,
        status: 'modified',
        oldText: before.text,
        newText: section.text,
      })
    } else {
      result.push({
        key: section.key,
        heading: section.heading || '（无标题）',
        level: section.level,
        status: 'unchanged',
        oldText: before.text,
        newText: section.text,
      })
    }
  }
  for (const section of oldSections) {
    if (!newMap.has(section.key)) {
      result.push({
        key: section.key,
        heading: section.heading || '（无标题）',
        level: section.level,
        status: 'removed',
        oldText: section.text,
      })
    }
  }
  return result.sort((a, b) => a.level - b.level)
}
