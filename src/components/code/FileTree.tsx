import { useMemo, useState } from 'react'
import { ChevronRight, File, Folder, FolderOpen, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TreeNode } from '../../../shared/types'
import { langOf, statusMeta } from '@/lib/language'
import { Spinner } from '@/components/ui'

interface FlatNode {
  node: TreeNode
  depth: number
}

export function FileTree({
  tree,
  loading,
  onSelect,
  selected,
  statuses,
  emptyLabel = '目录为空',
  className,
}: {
  tree: TreeNode | null
  loading?: boolean
  onSelect: (path: string) => void
  selected?: string
  statuses?: Record<string, { status: string; additions: number; deletions: number }>
  emptyLabel?: string
  className?: string
}) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const init = new Set<string>()
    if (tree?.children) {
      for (const child of tree.children) {
        if (child.type === 'dir') init.add(child.path)
      }
    }
    return init
  })

  const filteredTree = useMemo(() => {
    if (!query.trim()) return tree
    const q = query.toLowerCase()
    const filterNode = (node: TreeNode): TreeNode | null => {
      if (node.type === 'file') return node.path.toLowerCase().includes(q) ? node : null
      const children = (node.children ?? []).map(filterNode).filter(Boolean) as TreeNode[]
      if (children.length || node.name.toLowerCase().includes(q)) return { ...node, children }
      return null
    }
    return tree ? filterNode(tree) : null
  }, [tree, query])

  const rows = useMemo(() => {
    if (!filteredTree) return []
    const source = filterNodeExpanded(filteredTree, expanded, !!query.trim())
    return source
  }, [filteredTree, expanded, query])

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 pb-1.5">
        <Search className="h-3 w-3 text-muted-foreground/50" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索文件…"
          className="h-6 min-w-0 flex-1 bg-transparent text-[11.5px] outline-none placeholder:text-muted-foreground/50"
        />
        {loading ? <Spinner size={11} /> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 scroll-area-thin">
        {!tree ? (
          <p className="px-3 py-6 text-center text-[11.5px] text-muted-foreground/60">{loading ? '加载目录…' : emptyLabel}</p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11.5px] text-muted-foreground/60">没有匹配的文件</p>
        ) : (
          rows.map(({ node, depth }) => {
            if (node.path === '' || (node.type === 'dir' && depth === -1)) return null
            const isSelected = selected === node.path
            const change = statuses?.[node.path]
            const meta = change ? statusMeta(change.status) : null
            return (
              <button
                key={node.path}
                onClick={() => {
                  if (node.type === 'dir') toggle(node.path)
                  else onSelect(node.path)
                }}
                className={cn(
                  'group flex w-full items-center gap-1.5 py-[3px] pr-2 text-left transition-colors',
                  isSelected ? 'bg-primary/10 text-foreground' : 'text-foreground/75 hover:bg-accent/60',
                )}
                style={{ paddingLeft: 8 + depth * 12 }}
              >
                {node.type === 'dir' ? (
                  <>
                    <ChevronRight
                      className={cn(
                        'h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform',
                        expanded.has(node.path) && 'rotate-90',
                      )}
                    />
                    {expanded.has(node.path) ? (
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                    ) : (
                      <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                    )}
                  </>
                ) : (
                  <>
                    <span className="h-3 w-3 shrink-0" />
                    <span
                      className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] text-[7px] font-bold"
                      style={{ color: langOf(node.path).color }}
                    >
                      <File className="h-3 w-3 opacity-40" />
                    </span>
                  </>
                )}
                <span className={cn('truncate text-[11.5px]', node.type === 'dir' && 'font-medium')}>{node.name}</span>
                {meta ? (
                  <span className={cn('ml-auto shrink-0 rounded border px-1 text-[9px] font-bold', meta.cls)}>
                    {meta.label}
                  </span>
                ) : null}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

function filterNodeExpanded(node: TreeNode, expanded: Set<string>, forceOpen: boolean, depth = 0, out: FlatNode[] = []): FlatNode[] {
  out.push({ node, depth })
  const open = forceOpen || expanded.has(node.path)
  if (node.type === 'dir' && open && node.children) {
    for (const child of node.children) filterNodeExpanded(child, expanded, forceOpen, depth + 1, out)
  }
  return out
}
