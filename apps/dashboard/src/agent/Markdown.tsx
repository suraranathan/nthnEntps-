import { Fragment, useMemo, useState, type ReactNode } from 'react'

const KEYWORDS: Record<string, Set<string>> = {
  ts: new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'extends', 'implements', 'interface', 'type', 'enum', 'import', 'from', 'export', 'default', 'async', 'await', 'new', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'this', 'super', 'public', 'private', 'protected', 'readonly', 'static', 'void', 'null', 'undefined', 'true', 'false', 'switch', 'case', 'break', 'continue', 'yield', 'as', 'satisfies', 'keyof', 'declare', 'namespace']),
  py: new Set(['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'lambda', 'yield', 'pass', 'break', 'continue', 'and', 'or', 'not', 'in', 'is', 'None', 'True', 'False', 'async', 'await', 'global', 'nonlocal']),
  sh: new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return', 'export', 'local', 'readonly', 'in', 'set', 'cd', 'echo', 'exit']),
  json: new Set(['true', 'false', 'null']),
}
KEYWORDS.js = KEYWORDS.ts
KEYWORDS.jsx = KEYWORDS.ts
KEYWORDS.tsx = KEYWORDS.ts
KEYWORDS.typescript = KEYWORDS.ts
KEYWORDS.javascript = KEYWORDS.ts
KEYWORDS.bash = KEYWORDS.sh
KEYWORDS.shell = KEYWORDS.sh
KEYWORDS.python = KEYWORDS.py
KEYWORDS.css = new Set(['color', 'background', 'margin', 'padding', 'display', 'position', 'border', 'font', 'flex', 'grid', 'gap', 'width', 'height'])

const TOKEN = /(\/\/[^\n]*|#[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g
const COMMENT_LANGUAGES = new Set(['ts', 'tsx', 'js', 'jsx', 'typescript', 'javascript', 'json', 'css', 'java', 'c', 'cpp', 'rs', 'go'])
const HASH_COMMENT_LANGUAGES = new Set(['py', 'python', 'sh', 'bash', 'shell', 'yaml', 'yml', 'toml', 'ruby', 'rb'])

function highlightLine(line: string, language: string, key: string): ReactNode[] {
  const normalized = language.toLowerCase()
  const keywords = KEYWORDS[normalized]
  const hashComment = HASH_COMMENT_LANGUAGES.has(normalized)
  const slashComment = COMMENT_LANGUAGES.has(normalized)
  const nodes: ReactNode[] = []
  let last = 0
  let index = 0
  for (const match of line.matchAll(TOKEN)) {
    const token = match[0]
    const start = match.index ?? 0
    if (start < last) continue
    if (start > last) nodes.push(<Fragment key={`${key}-t${index++}`}>{line.slice(last, start)}</Fragment>)
    let className = ''
    if ((slashComment && token.startsWith('//')) || (hashComment && token.startsWith('#'))) className = 'tok-comment'
    else if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) className = 'tok-string'
    else if (/^\d/.test(token)) className = 'tok-number'
    else if (keywords?.has(token)) className = 'tok-keyword'
    nodes.push(className
      ? <span key={`${key}-${index++}`} className={className}>{token}</span>
      : <Fragment key={`${key}-${index++}`}>{token}</Fragment>)
    last = start + token.length
  }
  if (last < line.length) nodes.push(<Fragment key={`${key}-end`}>{line.slice(last)}</Fragment>)
  return nodes
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
      else {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        area.remove()
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return <button type="button" className="agent-copy" onClick={copy} aria-label="Copy code">{copied ? 'Copied' : 'Copy'}</button>
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const lines = code.replace(/\n$/, '').split('\n')
  return (
    <div className="agent-code">
      <div className="agent-code-head"><span>{language || 'text'}</span><CopyButton text={code} /></div>
      <pre><code>{lines.map((line, index) => <Fragment key={index}>{highlightLine(line, language, `l${index}`)}{index < lines.length - 1 ? '\n' : null}</Fragment>)}</code></pre>
    </div>
  )
}

function inline(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g
  let last = 0
  let index = 0
  for (const match of text.matchAll(pattern)) {
    const token = match[0]
    const start = match.index ?? 0
    if (start > last) nodes.push(<Fragment key={`${key}-p${index++}`}>{text.slice(last, start)}</Fragment>)
    if (token.startsWith('`')) nodes.push(<code key={`${key}-c${index++}`} className="agent-inline-code">{token.slice(1, -1)}</code>)
    else if (token.startsWith('**') || token.startsWith('__')) nodes.push(<strong key={`${key}-b${index++}`}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('*') || token.startsWith('_')) nodes.push(<em key={`${key}-i${index++}`}>{token.slice(1, -1)}</em>)
    else {
      const url = /\((https?:\/\/[^)\s]+)\)/.exec(token)?.[1]
      const label = /^\[([^\]]+)\]/.exec(token)?.[1] ?? url ?? token
      nodes.push(<a key={`${key}-a${index++}`} href={url} target="_blank" rel="noreferrer noopener">{label}</a>)
    }
    last = start + token.length
  }
  if (last < text.length) nodes.push(<Fragment key={`${key}-end`}>{text.slice(last)}</Fragment>)
  return nodes
}

function renderBlocks(source: string): ReactNode[] {
  const lines = source.split('\n')
  const blocks: ReactNode[] = []
  let paragraph: string[] = []
  let key = 0
  const flush = () => {
    if (paragraph.length === 0) return
    blocks.push(<p key={`p${key++}`}>{inline(paragraph.join('\n'), `p${key}`)}</p>)
    paragraph = []
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*$/.test(line)) { flush(); continue }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const level = Math.min(4, heading[1].length)
      const Tag = (`h${level + 2}`) as 'h3' | 'h4' | 'h5' | 'h6'
      blocks.push(<Tag key={`h${key++}`}>{inline(heading[2], `h${key}`)}</Tag>)
      continue
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flush(); blocks.push(<hr key={`hr${key++}`} />); continue }
    if (/^\s*>\s?/.test(line)) {
      flush()
      const quote: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) { quote.push(lines[index].replace(/^\s*>\s?/, '')); index += 1 }
      index -= 1
      blocks.push(<blockquote key={`q${key++}`}>{inline(quote.join('\n'), `q${key}`)}</blockquote>)
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flush()
      const items: string[] = []
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) { items.push(lines[index].replace(/^\s*[-*+]\s+/, '')); index += 1 }
      index -= 1
      blocks.push(<ul key={`u${key++}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `u${key}-${itemIndex}`)}</li>)}</ul>)
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flush()
      const items: string[] = []
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) { items.push(lines[index].replace(/^\s*\d+[.)]\s+/, '')); index += 1 }
      index -= 1
      blocks.push(<ol key={`o${key++}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `o${key}-${itemIndex}`)}</li>)}</ol>)
      continue
    }
    paragraph.push(line)
  }
  flush()
  return blocks
}

export function Markdown({ content }: { content: string }) {
  const parts = useMemo(() => {
    const result: ReactNode[] = []
    const fence = /```([\w+-]*)\n([\s\S]*?)```/g
    let last = 0
    let index = 0
    for (const match of content.matchAll(fence)) {
      const start = match.index ?? 0
      if (start > last) result.push(<Fragment key={`text${index++}`}>{renderBlocks(content.slice(last, start))}</Fragment>)
      result.push(<CodeBlock key={`code${index++}`} language={match[1] ?? ''} code={match[2]} />)
      last = start + match[0].length
    }
    if (last < content.length) result.push(<Fragment key={`text${index++}`}>{renderBlocks(content.slice(last))}</Fragment>)
    return result
  }, [content])
  if (!content) return null
  return <div className="agent-markdown">{parts}</div>
}
