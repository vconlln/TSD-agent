import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { parsePatch, toSplitRows, type DiffRow } from '@/lib/diff'
import { tokenizeLines, type Tok } from '@/lib/highlight'
import { useAppStore } from '@/stores/app'
import { Button } from '@/components/ui'

type TokenMap = Map<DiffRow, Tok[]>

/** Tokenize runs of same-kind rows so diff lines still get syntax colors. */
function useRowTokens(rows: DiffRow[], lang: string | undefined, enabled: boolean, dark: boolean): TokenMap {
  const [map, setMap] = useState<TokenMap>(() => new Map())
  const key = useMemo(() => `${lang}|rows:${rows.length}|${rows.reduce((n, r) => n + r.text.length, 0)}`, [rows, lang])

  useEffect(() => {
    if (!enabled || !lang || lang === 'text') {
      setMap(new Map())
      return
    }
    const total = rows.reduce((n, r) => n + r.text.length, 0)
    if (total > 320_000) return
    let cancelled = false
    void (async () => {
      const result: TokenMap = new Map()
      let i = 0
      while (i < rows.length) {
        const kind = rows[i].kind
        const run: DiffRow[] = []
        while (i < rows.length && rows[i].kind === kind) run.push(rows[i++])
        const text = run.map((r) => r.text).join('\n')
        const tokens = await tokenizeLines(text, lang, dark)
        if (!tokens) continue
        run.forEach((row, idx) => {
          if (tokens[idx]) result.set(row, tokens[idx])
        })
      }
      if (!cancelled) setMap(result)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, dark])

  return map
}

function RowContent({ row, tokens }: { row: DiffRow; tokens?: Tok[] }) {
  if (row.word?.length) {
    return (
      <>
        {row.word.map((part, i) => {
          if (part.kind === 'add') return <span key={i} className="word-add">{part.text}</span>
          if (part.kind === 'del') return <span key={i} className="word-del">{part.text}</span>
          return <span key={i}>{part.text}</span>
        })}
        {row.text === '' ? '\u00A0' : null}
      </>
    )
  }
  if (tokens?.length) {
    return (
      <>
        {tokens.map((t, i) => (
          <span
            key={i}
            style={{
              color: t.color,
              fontStyle: t.fontStyle && t.fontStyle & 1 ? 'italic' : undefined,
              fontWeight: t.fontStyle && t.fontStyle & 2 ? 600 : undefined,
              textDecoration: t.fontStyle && t.fontStyle & 4 ? 'underline' : undefined,
            }}
          >
            {t.content}
          </span>
        ))}
      </>
    )
  }
  return <>{row.text === '' ? '\u00A0' : row.text}</>
}

function markerOf(row: DiffRow) {
  if (row.kind === 'add') return '+'
  if (row.kind === 'del') return '-'
  return ' '
}

function UnifiedRow({ row, tokens }: { row: DiffRow; tokens?: Tok[] }) {
  return (
    <div className={cn('diff-row', row.kind)}>
      <div className="gutter">{row.oldNo ?? ''}</div>
      <div className="gutter">{row.newNo ?? ''}</div>
      <div className="cell">
        <span className="diff-marker">{markerOf(row)}</span>
        <RowContent row={row} tokens={tokens} />
      </div>
    </div>
  )
}

function SplitHalf({ row, tokens }: { row: DiffRow | null; tokens?: Tok[] }) {
  if (!row) return <div className="diff-split-row empty"><div className="gutter" /><div className="cell"> </div></div>
  return (
    <div className={cn('diff-split-row', row.kind)}>
      <div className="gutter">{row.oldNo ?? row.newNo ?? ''}</div>
      <div className="cell">
        <span className="diff-marker">{markerOf(row)}</span>
        <RowContent row={row} tokens={tokens} />
      </div>
    </div>
  )
}

export function PatchView({
  patch,
  language,
  layout,
  highlight,
  maxRows = 1600,
  className,
}: {
  patch: string
  language?: string
  layout?: 'unified' | 'split'
  highlight?: boolean
  maxRows?: number
  className?: string
}) {
  const appearance = useAppStore((s) => s.appearance)
  const resolvedLayout = layout ?? appearance.diffLayout
  const resolvedHighlight = highlight ?? appearance.diffHighlight
  const dark = appearance.mode === 'dark'

  const parsed = useMemo(() => parsePatch(patch), [patch])
  const flatRows = useMemo(() => parsed.hunks.flatMap((h) => h.rows), [parsed])
  const [expanded, setExpanded] = useState(false)
  const limited = !expanded && flatRows.length > maxRows

  const visibleHunks = useMemo(() => {
    if (!limited) return parsed.hunks
    let budget = maxRows
    const out = []
    for (const hunk of parsed.hunks) {
      if (budget <= 0) break
      const rows = hunk.rows.slice(0, budget)
      budget -= rows.length
      out.push({ ...hunk, rows })
    }
    return out
  }, [parsed.hunks, limited, maxRows])

  const visibleRows = useMemo(() => visibleHunks.flatMap((h) => h.rows), [visibleHunks])
  const tokens = useRowTokens(visibleRows, language, resolvedHighlight, dark)

  if (!patch.trim()) {
    return <div className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">没有可显示的差异内容</div>
  }

  return (
    <div className={cn('relative overflow-x-auto', className)}>
      <div className="diff-grid min-w-full">
        {visibleHunks.map((hunk, hIdx) => (
          <div key={`${hunk.header}-${hIdx}`}>
            <div className="diff-row hunk">
              <div className="gutter" />
              <div className="gutter" />
              <div className="cell">
                <span className="opacity-80">{hunk.header}</span>
              </div>
            </div>
            {resolvedLayout === 'unified' ? (
              hunk.rows.map((row, idx) => (
                <UnifiedRow key={`${hIdx}-${idx}`} row={row} tokens={tokens.get(row)} />
              ))
            ) : (
              <div className="diff-split">
                {toSplitRows(hunk).map((pair, idx) => (
                  <SplitRow key={`${hIdx}-s-${idx}`} pair={pair} tokens={tokens} />
                ))}
              </div>
            )}
          </div>
        ))}
        {limited ? (
          <div className="flex items-center justify-center gap-2 border-t border-border/60 bg-muted/30 px-3 py-2">
            <span className="text-[12px] text-muted-foreground">
              差异较大，已折叠 {flatRows.length - maxRows} 行
            </span>
            <Button size="xs" variant="secondary" onClick={() => setExpanded(true)}>
              显示全部
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SplitRow({ pair, tokens }: { pair: { left: DiffRow | null; right: DiffRow | null }; tokens: TokenMap }) {
  return (
    <>
      <SplitHalf row={pair.left} tokens={pair.left ? tokens.get(pair.left) : undefined} />
      <SplitHalf row={pair.right} tokens={pair.right ? tokens.get(pair.right) : undefined} />
    </>
  )
}
