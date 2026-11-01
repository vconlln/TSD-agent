import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { CodeBlock } from './CodeBlock'

export const MarkdownView = memo(function MarkdownView({
  content,
  className,
  compact = false,
}: {
  content: string
  className?: string
  compact?: boolean
}) {
  return (
    <div className={cn('prose-tsd', compact && 'prose-xs', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                if (href && /^https?:/i.test(href)) {
                  e.preventDefault()
                  if (window.tsd) void window.tsd.openExternal(href)
                  else window.open(href, '_blank', 'noreferrer')
                }
              }}
            >
              {children}
            </a>
          ),
          pre: ({ children }) => <>{children}</>,
          code: ({ className: cls, children, ...props }) => {
            const text = String(children ?? '')
            const isBlock = text.includes('\n') || /language-/.test(cls || '')
            if (!isBlock) {
              return (
                <code className={cls} {...props}>
                  {children}
                </code>
              )
            }
            const lang = /language-([\w-]+)/.exec(cls || '')?.[1] || 'text'
            return (
              <CodeBlock
                code={text.replace(/\n$/, '')}
                lang={lang}
                className="my-3"
                dense
                showHeader
                maxHeight={420}
              />
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
