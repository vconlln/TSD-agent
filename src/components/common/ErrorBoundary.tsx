import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  info?: string
}

/**
 * 页面级错误边界：任何一个页面组件抛错，都不应该让整个应用变成白屏。
 * 出现异常时展示可恢复的提示（重试 / 回到工作台），并把错误留在控制台方便排查。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[TSD] 页面渲染失败：', error, info.componentStack)
    this.setState({ info: info.componentStack?.slice(0, 600) })
  }

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="w-[min(92vw,520px)] rounded-2xl border border-border bg-card/85 p-6 text-center shadow-float">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-[hsl(var(--warning)/0.14)] text-[hsl(var(--warning))]">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <h2 className="text-[15px] font-semibold tracking-tight">这个页面加载失败了</h2>
          <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
            {error.message || '页面渲染时发生未知错误'}。可以重试，或者回到工作台继续其他操作。
          </p>
          {info ? (
            <pre className="mt-3 max-h-28 overflow-auto rounded-lg border border-border/70 bg-muted/40 p-2 text-left font-mono text-[11.5px] leading-relaxed text-muted-foreground scroll-area-thin">
              {info}
            </pre>
          ) : null}
          <div className="mt-5 flex items-center justify-center gap-2">
            <Button
              size="sm"
              variant="primary"
              className="gap-1.5"
              onClick={() => {
                this.setState({ error: null, info: undefined })
                window.location.reload()
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" /> 重新加载
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                this.setState({ error: null, info: undefined })
                window.location.hash = '#/'
              }}
            >
              回到工作台
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
