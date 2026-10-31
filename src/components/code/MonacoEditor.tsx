import { useEffect, useRef } from 'react'
import type { editor as MonacoEditorTypes } from 'monaco-editor'
import { editorTheme, monaco, monacoLanguage } from '@/lib/monaco-setup'
import { useAppStore } from '@/stores/app'

export interface EditorSelection {
  startLine: number
  endLine: number
  text: string
  /** 选区起点相对编辑器的坐标，用于锚定浮动工具条 */
  top: number
  left: number
}

export default function MonacoEditor({
  value,
  path,
  readOnly = false,
  onChange,
  onSelectionChange,
  onSave,
  onAsk,
  className,
}: {
  value: string
  path: string
  readOnly?: boolean
  onChange?: (value: string) => void
  onSelectionChange?: (selection: EditorSelection | null) => void
  onSave?: () => void
  onAsk?: (kind: 'explain' | 'modify') => void
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<MonacoEditorTypes.IStandaloneCodeEditor | null>(null)
  const suppressRef = useRef(false)
  const mode = useAppStore((s) => s.appearance.mode)
  const wrap = useAppStore((s) => s.appearance.codeWrap)
  const handlers = useRef({ onChange, onSelectionChange, onSave, onAsk })
  handlers.current = { onChange, onSelectionChange, onSave, onAsk }

  useEffect(() => {
    if (!hostRef.current) return
    const instance = monaco.editor.create(hostRef.current, {
      value,
      language: monacoLanguage(path),
      theme: editorTheme(mode),
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12.5,
      lineHeight: 20,
      fontFamily:
        "'JetBrains Mono', 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace",
      fontLigatures: true,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      padding: { top: 12, bottom: 24 },
      wordWrap: wrap ? 'on' : 'off',
      tabSize: 2,
      guides: { indentation: true, bracketPairs: false },
      scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
      contextmenu: true,
      quickSuggestions: { other: true, comments: false, strings: false },
      fixedOverflowWidgets: true,
      overviewRulerBorder: false,
    })
    editorRef.current = instance

    instance.onDidChangeModelContent(() => {
      if (suppressRef.current) return
      handlers.current.onChange?.(instance.getValue())
    })

    instance.onDidChangeCursorSelection(() => {
      const selection = instance.getSelection()
      if (!selection || selection.isEmpty()) {
        handlers.current.onSelectionChange?.(null)
        return
      }
      const anchor = instance.getScrolledVisiblePosition({
        lineNumber: selection.startLineNumber,
        column: selection.startColumn,
      })
      handlers.current.onSelectionChange?.({
        startLine: selection.startLineNumber,
        endLine: selection.endLineNumber,
        text: instance.getModel()?.getValueInRange(selection) ?? '',
        top: anchor?.top ?? 0,
        left: anchor?.left ?? 0,
      })
    })

    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handlers.current.onSave?.()
    })
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
      handlers.current.onAsk?.('modify')
    })
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => {
      handlers.current.onAsk?.('explain')
    })

    return () => {
      instance.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部内容变化（切换文件 / 应用 AI 修改）时同步进模型
  useEffect(() => {
    const instance = editorRef.current
    if (!instance) return
    if (instance.getValue() === value) return
    suppressRef.current = true
    instance.setValue(value)
    suppressRef.current = false
    instance.setPosition({ lineNumber: 1, column: 1 })
    instance.revealLine(1)
  }, [value])

  useEffect(() => {
    const instance = editorRef.current
    if (!instance) return
    const model = instance.getModel()
    if (model) monaco.editor.setModelLanguage(model, monacoLanguage(path))
  }, [path])

  useEffect(() => {
    monaco.editor.setTheme(editorTheme(mode))
  }, [mode])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly, wordWrap: wrap ? 'on' : 'off' })
  }, [readOnly, wrap])

  return <div ref={hostRef} className={className} />
}
