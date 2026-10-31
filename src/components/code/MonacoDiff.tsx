import { useEffect, useRef } from 'react'
import { editorTheme, monaco, monacoLanguage } from '@/lib/monaco-setup'
import { useAppStore } from '@/stores/app'

export default function MonacoDiff({
  original,
  modified,
  path,
  className,
}: {
  original: string
  modified: string
  path: string
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const mode = useAppStore((s) => s.appearance.mode)

  useEffect(() => {
    if (!hostRef.current) return
    const language = monacoLanguage(path)
    const originalModel = monaco.editor.createModel(original, language)
    const modifiedModel = monaco.editor.createModel(modified, language)
    const diff = monaco.editor.createDiffEditor(hostRef.current, {
      theme: editorTheme(mode),
      readOnly: true,
      renderSideBySide: true,
      automaticLayout: true,
      fontSize: 12,
      lineHeight: 19,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      ignoreTrimWhitespace: false,
      padding: { top: 10, bottom: 10 },
      scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
    })
    diff.setModel({ original: originalModel, modified: modifiedModel })
    return () => {
      diff.dispose()
      originalModel.dispose()
      modifiedModel.dispose()
    }
  }, [original, modified, path, mode])

  return <div ref={hostRef} className={className} />
}
