import { useEffect, useMemo, useRef, useState } from 'react'
import { useAgentChat } from './useAgentChat'
import { Markdown } from './Markdown'
import type { AgentMessage, DecisionSummary, ToolCallRecord } from './types'

function timeOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function relative(iso: string): string {
  const value = Date.parse(iso)
  if (Number.isNaN(value)) return ''
  const seconds = Math.round((Date.now() - value) / 1000)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

function statusLabel(status: ToolCallRecord['status']): string {
  switch (status) {
    case 'proposed': return 'Queued'
    case 'awaiting-approval': return 'Needs approval'
    case 'running': return 'Running'
    case 'succeeded': return 'Succeeded'
    case 'failed': return 'Failed'
    case 'denied': return 'Denied'
    case 'cancelled': return 'Cancelled'
  }
}

function ToolCallCard({ call, approval, onApprove }: { call: ToolCallRecord; approval: boolean; onApprove: (approved: boolean) => void }) {
  return (
    <div className={`agent-tool agent-tool-${call.status}`}>
      <div className="agent-tool-head">
        <span className="agent-tool-icon" aria-hidden="true">{call.status === 'succeeded' ? '✓' : call.status === 'failed' || call.status === 'denied' ? '×' : call.status === 'running' ? '›' : '•'}</span>
        <code>{call.tool}</code>
        <span className="agent-tool-status">{statusLabel(call.status)}</span>
      </div>
      {call.summary && <p className="agent-tool-summary">{call.summary}</p>}
      {approval && call.status === 'awaiting-approval' && (
        <div className="agent-approval">
          <span>Alex wants to run this action. It will not run without your approval.</span>
          <div>
            <button type="button" className="agent-deny" onClick={() => onApprove(false)}>Deny</button>
            <button type="button" className="agent-approve" onClick={() => onApprove(true)}>Approve</button>
          </div>
        </div>
      )}
      {call.output && <details className="agent-tool-output"><summary>Output</summary><pre>{call.output}</pre></details>}
    </div>
  )
}

function DecisionCard({ decision }: { decision: DecisionSummary }) {
  const risk = decision.risk.result
  return (
    <details className="agent-decision">
      <summary>
        <span className="agent-decision-title">Plan</span>
        <span className="agent-chip">{decision.routing.result.workflow}</span>
        <span className={`agent-chip agent-risk-${risk.level}`}>{risk.level} risk</span>
        <span className="agent-decision-note">decision engine · advisory</span>
      </summary>
      <div className="agent-decision-body">
        <p>{decision.routing.result.rationale}</p>
        <ol>
          {decision.workflow.result.steps.map(step => <li key={step.order}>{step.action} <small>({step.tools.join(', ') || 'no tools'})</small></li>)}
        </ol>
        <p className="agent-decision-meta">
          Classification: <b>{decision.classification.result.label}</b>
          {' · '}Confidence: <b>{Math.round(decision.risk.confidence.value * 100)}%</b>
          {' · '}The decision engine is a local heuristic, not Jev and not a calibrated probability.
        </p>
        {decision.workflow.result.risks.length > 0 && <ul className="agent-decision-risks">{decision.workflow.result.risks.map(item => <li key={item}>{item}</li>)}</ul>}
      </div>
    </details>
  )
}

function MessageView({ message, approvalCallId, onApprove }: { message: AgentMessage; approvalCallId: string | null; onApprove: (approved: boolean) => void }) {
  if (message.role === 'tool' || message.role === 'system') return null
  if (message.role === 'user') {
    return (
      <div className="agent-message agent-message-user">
        <div className="agent-user-bubble">{message.content}</div>
        <time>{timeOf(message.createdAt)}</time>
      </div>
    )
  }
  const streaming = message.status === 'streaming'
  return (
    <div className="agent-message agent-message-assistant">
      <div className="agent-avatar" aria-hidden="true">A</div>
      <div className="agent-assistant-body">
        {message.decision && <DecisionCard decision={message.decision} />}
        {message.content
          ? <Markdown content={message.content} />
          : streaming ? <p className="agent-thinking">Thinking<span className="agent-dots">…</span></p> : null}
        {streaming && message.content && <span className="agent-caret" aria-hidden="true" />}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="agent-tools">
            {message.toolCalls.map(call => <ToolCallCard key={call.id} call={call} approval={approvalCallId === call.id} onApprove={onApprove} />)}
          </div>
        )}
        {message.status === 'error' && <p className="agent-message-error">This response failed. The error is shown above.</p>}
        {message.status === 'cancelled' && <p className="agent-message-cancelled">Stopped.</p>}
        <time className="agent-message-time">{timeOf(message.createdAt)}</time>
      </div>
    </div>
  )
}

export function AlexAgentChat() {
  const chat = useAgentChat()
  const [draft, setDraft] = useState('')
  const [listOpen, setListOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messages = chat.state?.active?.messages ?? []
  const activeId = chat.state?.active?.id ?? null
  const gateway = chat.state?.gateway


  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, chat.busy, chat.pendingApproval?.approvalId])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(220, textarea.scrollHeight)}px`
  }, [draft])

  useEffect(() => {
    if (!listOpen) return
    const close = (event: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(event.target as Node)) setListOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [listOpen])

  const conversationItems = useMemo(() => chat.state?.conversations ?? [], [chat.state?.conversations])

  const submit = () => {
    if (chat.busy || !draft.trim()) return
    const text = draft
    setDraft('')
    void chat.send(text)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const status = gateway ? `${gateway.provider}${gateway.model ? ` · ${gateway.model}` : ''}` : 'No model assigned'
  const transport = gateway?.transport === 'buffered' ? 'buffered fallback' : gateway ? 'streaming' : 'not ready'

  return (
    <section className={`agent-shell panel-current ${listOpen ? 'agent-shell-list-open' : ''}`} aria-label="Alex coding agent">
      <aside className="agent-conversations" ref={listRef}>
        <div className="agent-conversations-head">
          <div>
            <span className="eyebrow">ALEX</span>
            <h2>Conversations</h2>
          </div>
          <button type="button" className="agent-icon-button" aria-label="New conversation" title="New conversation" onClick={() => { setListOpen(false); void chat.newConversation() }}>＋</button>
        </div>
        <div className="agent-conversation-list">
          {conversationItems.length === 0 && <p className="agent-conversation-empty">No conversations yet.</p>}
          {conversationItems.map(item => (
            <div key={item.id} className={`agent-conversation ${item.id === activeId ? 'agent-conversation-active' : ''}`}>
              <button type="button" onClick={() => { setListOpen(false); void chat.selectConversation(item.id) }}>
                <span className="agent-conversation-title">{item.title}</span>
                <span className="agent-conversation-meta">{item.messageCount} messages · {relative(item.updatedAt)}</span>
              </button>
              <button type="button" className="agent-conversation-remove" aria-label={`Remove ${item.title}`} title="Remove conversation" onClick={() => void chat.removeConversation(item.id)}>×</button>
            </div>
          ))}
        </div>
        <div className="agent-conversations-foot">
          <span className={`alex-status-dot ${chat.busy ? 'thinking' : 'online'}`} />
          <span>{chat.busy ? 'Working' : 'Ready'}</span>
          <span className="agent-transport">{transport}</span>
        </div>
      </aside>

      <div className="agent-main">
        <header className="agent-header">
          <button type="button" className="agent-list-toggle" aria-label="Show conversations" aria-expanded={listOpen} onClick={() => setListOpen(value => !value)}>☰</button>
          <div className="agent-heading">
            <div className="agent-heading-title"><h1>Alex</h1><span className="agent-role">Coding agent</span></div>
            <p>{status}</p>
          </div>
          <div className="agent-header-actions">
            <span className={`agent-state ${chat.busy ? 'agent-state-busy' : ''}`}>{chat.busy ? 'Working' : 'Idle'}</span>
            <button type="button" className="agent-new" onClick={() => void chat.newConversation()} disabled={chat.busy}>New</button>
          </div>
        </header>

        {chat.error && (
          <div className="agent-error" role="alert">
            <span>{chat.error}</span>
            <button type="button" onClick={() => { chat.dismissError(); void chat.reload().catch(() => undefined) }}>Retry</button>
          </div>
        )}

        <div className="agent-messages">
          {messages.length === 0 && (
            <div className="agent-empty">
              <div className="agent-empty-mark">A</div>
              <h2>What should we build?</h2>
              <p>Alex can inspect this repository, make scoped changes, run the test suite and build, and explain what changed. Changes that need permission pause for your approval.</p>
              <ul>
                <li>“Find where the dashboard streams provider responses and explain it.”</li>
                <li>“Add a regression test for the agent decision engine.”</li>
                <li>“Fix the failing test, then run the tests and typecheck.”</li>
              </ul>
              <p className="agent-empty-note">Workspace: <code>{chat.state?.workspace ?? 'loading…'}</code></p>
            </div>
          )}
          {messages.map(message => (
            <MessageView
              key={message.id}
              message={message}
              approvalCallId={chat.pendingApproval?.call.id ?? null}
              onApprove={approved => void chat.approve(approved)}
            />
          ))}
          <div ref={endRef} />
        </div>

        <footer className="agent-composer">
          <div className="agent-composer-inner">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Ask Alex to inspect, change, test, or explain the codebase…"
              aria-label="Message Alex"
              disabled={chat.busy}
            />
            {chat.busy
              ? <button type="button" className="agent-stop" onClick={() => void chat.stop()}>Stop</button>
              : <button type="button" className="agent-send" onClick={submit} disabled={!draft.trim()}>Send</button>}
          </div>
          <div className="agent-composer-meta">
            <span>Enter to send · Shift+Enter for a new line</span>
            <span>{chat.state?.workspace ? 'Local workspace' : 'Connecting…'}</span>
          </div>
        </footer>
      </div>

      {listOpen && <div className="agent-conversations-backdrop" onClick={() => setListOpen(false)} aria-hidden="true" />}
    </section>
  )
}
