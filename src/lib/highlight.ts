/**
 * Lazily-loaded Shiki highlighter with only the grammars we actually use.
 * Keeping the language set explicit rather than pulling the 9 MB full bundle
 * keeps the desktop app's first code render fast (~1 MB chunk instead).
 */
import type { HighlighterCore, ThemedToken } from 'shiki/core'

export interface Tok {
  content: string
  color?: string
  fontStyle?: number
}

export const THEME_DARK = 'github-dark-default'
export const THEME_LIGHT = 'github-light-default'

let pending: Promise<HighlighterCore | null> | null = null

export function loadHighlighter(): Promise<HighlighterCore | null> {
  if (!pending) {
    pending = (async () => {
      try {
        const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
          import('shiki/core'),
          import('shiki/engine/javascript'),
        ])
        const mods = await Promise.all([
          import('shiki/themes/github-dark-default.mjs'),
          import('shiki/themes/github-light-default.mjs'),
          import('shiki/langs/typescript.mjs'),
          import('shiki/langs/tsx.mjs'),
          import('shiki/langs/javascript.mjs'),
          import('shiki/langs/jsx.mjs'),
          import('shiki/langs/json.mjs'),
          import('shiki/langs/python.mjs'),
          import('shiki/langs/markdown.mjs'),
          import('shiki/langs/yaml.mjs'),
          import('shiki/langs/toml.mjs'),
          import('shiki/langs/ini.mjs'),
          import('shiki/langs/css.mjs'),
          import('shiki/langs/scss.mjs'),
          import('shiki/langs/html.mjs'),
          import('shiki/langs/xml.mjs'),
          import('shiki/langs/bash.mjs'),
          import('shiki/langs/powershell.mjs'),
          import('shiki/langs/java.mjs'),
          import('shiki/langs/go.mjs'),
          import('shiki/langs/rust.mjs'),
          import('shiki/langs/c.mjs'),
          import('shiki/langs/cpp.mjs'),
          import('shiki/langs/csharp.mjs'),
          import('shiki/langs/sql.mjs'),
          import('shiki/langs/docker.mjs'),
          import('shiki/langs/make.mjs'),
          import('shiki/langs/diff.mjs'),
          import('shiki/langs/vue.mjs'),
        ])
        const [dark, light, ...langs] = mods
        const highlighter = await createHighlighterCore({
          themes: [dark.default, light.default] as never[],
          langs: langs.map((m) => m.default) as never[],
          engine: createJavaScriptRegexEngine({ forgiving: true }),
        })
        return highlighter
      } catch (err) {
        console.warn('[highlight] Shiki 加载失败，降级为纯文本', (err as Error)?.stack || String(err))
        return null
      }
    })()
  }
  return pending
}

const htmlCache = new Map<string, string>()

export async function highlightToHtml(code: string, lang: string, dark: boolean): Promise<string | null> {
  const key = `${dark ? 'd' : 'l'}|${lang}|${code.length}|${code.slice(0, 64)}`
  const cached = htmlCache.get(key)
  if (cached !== undefined) return cached
  const hl = await loadHighlighter()
  if (!hl) return null
  try {
    const loaded = hl.getLoadedLanguages()
    const useLang = loaded.includes(lang) ? lang : 'text'
    const html = hl.codeToHtml(code, { lang: useLang, theme: dark ? THEME_DARK : THEME_LIGHT })
    if (htmlCache.size > 60) htmlCache.clear()
    htmlCache.set(key, html)
    return html
  } catch {
    return null
  }
}

const tokenCache = new Map<string, Tok[][] | null>()

/** Tokenize a block of code into per-line token arrays (single pass). */
export async function tokenizeLines(code: string, lang: string, dark: boolean): Promise<Tok[][] | null> {
  const key = `${dark ? 'd' : 'l'}|${lang}|${code.length}|${code.slice(0, 48)}`
  if (tokenCache.has(key)) return tokenCache.get(key) ?? null
  const hl = await loadHighlighter()
  if (!hl) return null
  try {
    const loaded = hl.getLoadedLanguages()
    const useLang = loaded.includes(lang) ? lang : 'text'
    const raw = hl.codeToTokensBase(code, {
      lang: useLang,
      theme: dark ? THEME_DARK : THEME_LIGHT,
    }) as ThemedToken[][]
    const normalized: Tok[][] = raw.map((line) =>
      line.map((t) => ({ content: t.content, color: t.color, fontStyle: t.fontStyle })),
    )
    if (tokenCache.size > 40) tokenCache.clear()
    tokenCache.set(key, normalized)
    return normalized
  } catch {
    tokenCache.set(key, null)
    return null
  }
}
