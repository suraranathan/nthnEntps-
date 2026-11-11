import { useEffect, useRef, useState } from 'react'
import type { JefClient } from './useJef'
import type { FollowUp, MemoryCategory, Preferences } from './jef-contract'

type Props = { client: JefClient; open: boolean; onClose: () => void; onOpen: () => void; showLauncher?: boolean }
const categories: { id: MemoryCategory; label: string }[] = [{ id: 'project', label: 'Project context' }, { id: 'relationships', label: 'Team relationships' }, { id: 'insideJokes', label: 'Shared inside jokes' }, { id: 'temporary', label: 'Temporary task context' }]
function Settings({ client }: { client: JefClient }) {
  const snapshot = client.snapshot!
  const [draft, setDraft] = useState<Preferences>({ ...snapshot.preferences })
  const [saved, setSaved] = useState(false)
  const patch = (value: Partial<Preferences>) => { setDraft(p => ({ ...p, ...value })); setSaved(false) }
  return <form className="jef-settings" onSubmit={async e => { e.preventDefault(); setSaved(await client.send({ action: 'preferences', value: draft })) }}>
    <h3>Communication &amp; quiet hours</h3>
    <label>Humor<select value={draft.humor} onChange={e => patch({ humor: e.target.value as Preferences['humor'] })}><option value="balanced">Balanced</option><option value="playful">Playful</option><option value="serious">Serious</option></select></label>
    <label className="jef-check"><input type="checkbox" checked={draft.philosophy} onChange={e => patch({ philosophy: e.target.checked })} /> Allow relevant philosophical perspectives</label>
    <label>Communication preferences<textarea maxLength={1000} value={draft.communication} onChange={e => patch({ communication: e.target.value })} placeholder="For example: short answers; no jokes during work incidents" /></label>
    <label className="jef-check"><input type="checkbox" checked={draft.proactive} onChange={e => patch({ proactive: e.target.checked })} /> Allow proactive in-app updates</label>
    <label>Conversation initiative<select value={draft.conversationInitiation} onChange={e => patch({ conversationInitiation: e.target.value as Preferences['conversationInitiation'] })}><option value="relevant">When a relevant event occurs</option><option value="off">Off</option></select></label>
    <label className="jef-check"><input type="checkbox" checked={draft.followUps} onChange={e => patch({ followUps: e.target.checked })} /> Include saved follow-ups in proactive updates</label>
    <label className="jef-check"><input type="checkbox" checked={draft.reminders} onChange={e => patch({ reminders: e.target.checked })} /> Remind me at saved reminder times</label>
    <label>Flag open follow-ups after days<input type="number" min={1} max={90} required value={draft.stalledAfterDays} onChange={e => patch({ stalledAfterDays: Number(e.target.value) })} /></label>
    <label>Minimum interval (minutes)<input type="number" min={15} max={1440} required value={draft.intervalMinutes} onChange={e => patch({ intervalMinutes: Number(e.target.value) })} /></label>
    <div className="jef-form-row"><label>Quiet from<input type="time" required value={draft.quietStart} onChange={e => patch({ quietStart: e.target.value })} /></label><label>Quiet until<input type="time" required value={draft.quietEnd} onChange={e => patch({ quietEnd: e.target.value })} /></label></div>
    <label>Timezone<input required maxLength={100} value={draft.timezone} onChange={e => patch({ timezone: e.target.value })} placeholder="Asia/Manila" /></label>
    <label className="jef-check"><input type="checkbox" checked={draft.dailyBriefing} onChange={e => patch({ dailyBriefing: e.target.checked })} /> Daily briefing when proactive updates are enabled</label>
    <label>Briefing after<input type="time" required value={draft.briefingTime} onChange={e => patch({ briefingTime: e.target.value })} /></label>
    <p>Quiet hours use this timezone; equal start/end disables them. Updates run only while the agent server is running. No phone push notifications. Enabling these settings permits model requests and any provider charges.</p>
    <button disabled={client.pending}>Save preferences</button>{saved && <span role="status">Preferences saved</span>}
    <h3>Model connection</h3>
    <label>Configured provider/model<select value={snapshot.provider ?? ''} disabled={client.pending} onChange={e => { void client.send({ action: 'provider', id: e.target.value }) }}>
      {!snapshot.provider && <option value="">No configured provider</option>}
      {snapshot.providers.map(p => <option key={p.id} value={p.id} disabled={!p.configured}>{p.id} / {p.model || 'model missing'}{!p.configured ? ' (unconfigured)' : ''}</option>)}
    </select></label>
    <p>Credentials and model names are configured only in the server’s <code>.env.server</code>. Text chat is enabled; execution, image input and tools are unavailable. Provider switches retain local memory.</p>
    <button type="button" disabled={!snapshot.provider || client.pending} onClick={() => { void client.send({ action: 'probe' }) }}>Test real connection (model request)</button>
  </form>
}
function FollowUps({ client }: { client: JefClient }) {
  const [text, setText] = useState('')
  const [due, setDue] = useState('')
  const [remind, setRemind] = useState('')
  return <div className="jef-settings"><h3>Follow-ups and reminders</h3><p>Save a task to follow up on. These are user-supplied notes; Jef does not claim their progress is verified. Enter dates in this device’s local time. Automatic in-app reminders require proactive updates and follow-ups to be enabled.</p>
    <form onSubmit={async e => { e.preventDefault(); if (await client.send({ action: 'followup.create', text, dueAt: due ? new Date(due).toISOString() : null, remindAt: remind ? new Date(remind).toISOString() : null })) { setText(''); setDue(''); setRemind('') } }}>
      <label>Task or question<textarea required maxLength={1000} value={text} onChange={e => setText(e.target.value)} /></label>
      <label>Due date (optional)<input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></label>
      <label>Remind me (optional)<input type="datetime-local" value={remind} onChange={e => setRemind(e.target.value)} /></label>
      <button disabled={client.pending || !text.trim()}>Save follow-up</button>
    </form>
    {client.snapshot!.followUps.slice().reverse().map(item => <FollowUpItem key={item.id} item={item} client={client} />)}
  </div>
}
function localInput(iso: string | null) {
  if (!iso) return ''
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
function FollowUpItem({ item, client }: { item: FollowUp; client: JefClient }) {
  const [due, setDue] = useState(() => localInput(item.dueAt))
  const [remind, setRemind] = useState(() => localInput(item.remindAt))
  const active = item.state !== 'completed' && item.state !== 'dismissed'
  return <article className="jef-note"><small>{item.state}{item.dueAt ? ` · due ${new Date(item.dueAt).toLocaleString()}` : ''}</small><p>{item.text}</p>
    {active ? <><form onSubmit={e => { e.preventDefault(); void client.send({ action: 'followup.update', id: item.id, state: 'pending', dueAt: due ? new Date(due).toISOString() : null, remindAt: remind ? new Date(remind).toISOString() : null }) }}><label>Due<input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></label><label>Remind<input type="datetime-local" value={remind} onChange={e => setRemind(e.target.value)} /></label><button disabled={client.pending}>Update dates</button></form><div><button disabled={client.pending} onClick={() => { void client.send({ action: 'followup.update', id: item.id, state: 'completed' }) }}>Complete</button><button disabled={client.pending} onClick={() => { void client.send({ action: 'followup.update', id: item.id, state: 'dismissed' }) }}>Dismiss</button></div></> : <button disabled={client.pending} onClick={() => { void client.send({ action: 'followup.update', id: item.id, state: 'pending' }) }}>Reopen</button>}
  </article>
}
function Memory({ client }: { client: JefClient }) {
  const [category, setCategory] = useState<MemoryCategory>('project')
  const [text, setText] = useState('')
  return <div className="jef-settings">
    <h3>Persistent memory</h3><p>These notes are saved on the local server and survive restarts and model changes. History is saved separately. Notes are user reports, not verified task progress.</p>
    <form onSubmit={async e => { e.preventDefault(); if (await client.send({ action: 'remember', category, text })) setText('') }}>
      <label>Category<select value={category} onChange={e => setCategory(e.target.value as MemoryCategory)}>{categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
      <label>Note<textarea required maxLength={1000} value={text} onChange={e => setText(e.target.value)} placeholder="Save a real preference, project fact, shared joke or task context" /></label>
      <button disabled={client.pending || !text.trim()}>Save memory</button>
    </form>
    {categories.map(c => <div key={c.id}><h3>{c.label}</h3>{!client.snapshot!.memory[c.id].length && <p>No saved notes.</p>}{client.snapshot!.memory[c.id].map(note => <article className="jef-note" key={note.id}><p>{note.text}</p><small>User-saved · {new Date(note.createdAt).toLocaleDateString()}</small><button disabled={client.pending} onClick={() => { void client.send({ action: 'forget', category: c.id, id: note.id }) }}>Remove note</button></article>)}</div>)}
  </div>
}
function TeamQueue({ client }: { client: JefClient }) {
  const [text, setText] = useState('')
  const [type, setType] = useState<'request' | 'clarification'>('request')
  const [approved, setApproved] = useState(false)
  return <div className="jef-settings"><h3>Sophia integration queue</h3><p>Sophia is not implemented. Queuing stores your exact request locally for a future adapter. It does not send, execute or approve the underlying work.</p>
    <form onSubmit={async e => { e.preventDefault(); if (await client.send({ action: 'handoff', text, type, approved })) { setText(''); setApproved(false) } }}>
      <label>Message type<select value={type} onChange={e => { setType(e.target.value as typeof type); setApproved(false) }}><option value="request">Task request</option><option value="clarification">Clarification question</option></select></label>
      <label>Exact request<textarea required maxLength={8000} value={text} onChange={e => { setText(e.target.value); setApproved(false) }} /></label>
      <label className="jef-check"><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} /> I approve storing this exact request in Sophia’s queue</label>
      <button disabled={!approved || !text.trim() || client.pending}>Queue approved request</button>
    </form>
    {client.snapshot!.requests.slice().reverse().map(request => <article className="jef-note" key={request.id}><small>{request.type} · {request.state.replaceAll('_', ' ')}</small><p>{request.text}</p><small>{request.id}</small>{request.updates.map((update, i) => <p key={i}>{update.text}</p>)}</article>)}
  </div>
}
export function JefChat({ client, open, onClose, onOpen, showLauncher = true }: Props) {
  const [tab, setTab] = useState('Chat')
  const [lastRead, setLastRead] = useState(() => { try { return Number(localStorage.getItem('nthn-jef-last-read') ?? localStorage.getItem('nthn-alex-last-read')) || 0 } catch { return 0 } })
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const s = client.snapshot
  const unread = s?.messages.filter(m => m.role === 'assistant' && m.kind !== 'chat' && new Date(m.createdAt).getTime() > lastRead).length ?? 0
  useEffect(() => {
    if (!open || tab !== 'Chat') return
    const time = Date.now(); setLastRead(time)
    try { localStorage.setItem('nthn-jef-last-read', String(time)) } catch { /* Read marker is optional. */ }
  }, [open, tab, s?.messages.length])
  const busy = client.pending || client.status === 'thinking'
  useEffect(() => { if (open) heading.current?.focus() }, [open])
  useEffect(() => { if (open && tab === 'Chat') end.current?.scrollIntoView({ block: 'nearest' }) }, [s?.messages.length, open, tab])
  useEffect(() => {
    if (!open) return
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close)
  }, [open, onClose])
  return <>
    {!open && showLauncher && <button className="jef-launch" onClick={onOpen}><span className={`jef-status-dot ${client.status}`} /> Talk to Jef <small>{unread ? `${unread} new update${unread === 1 ? '' : 's'}` : client.status}</small></button>}
    {open && <section className="jef-drawer" role="dialog" aria-modal="false" aria-labelledby="jef-title">
      <header className="jef-header"><div><h2 id="jef-title" tabIndex={-1} ref={heading}>01 · Jef</h2><p>Personal Communicator</p></div><button onClick={onClose} aria-label="Close Jef chat">×</button></header>
      <div className="jef-connection" aria-live="polite"><span className={`jef-status-dot ${client.status}`} /><b>{client.status}</b><span>{s?.provider ? `${s.provider} / ${s.model}` : 'No model connected'}</span></div>
      <p className="jef-detail">{s?.detail || 'Start the local agent server to connect Jef.'}</p>
      <nav className="jef-tabs" aria-label="Jef panels">{['Chat', 'Memory', 'Follow-ups', 'Settings', 'Sophia', 'Log'].map(name => <button key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}</nav>
      {client.error && <div className="jef-error" role="alert">{client.error}<button onClick={() => { void client.refresh() }}>Reconnect</button></div>}
      <div className="jef-body">
        {!s && <p className="jef-empty">Jef is offline. The office still works. Start <code>npm run dev</code> to run the dashboard and local agent server together.</p>}
        {s && tab === 'Chat' && <>
          {!s.messages.length && <div className="jef-empty"><h3>Meet Jef</h3><p>Your AI communicator: curious, quick-witted and serious when it matters. Connect a real model to begin; no scripted replies are substituted.</p><p>Conversation, saved notes and the project status document are sent to your configured provider. Local memory stays on this server.</p></div>}
          {s.events.filter(event => event.type === 'jef_model_switched').slice(-1).map(event => <div className="jef-note" role="status" key={event.id}><strong>Model switched</strong><p>{event.text}</p></div>)}
          {s.messages.map(message => <article className={`jef-message ${message.role}`} key={message.id}><small>{message.role === 'user' ? 'You' : 'Jef'} · {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{message.kind !== 'chat' ? ` · ${message.kind}` : ''}</small><p>{message.content}</p>{message.provider && <small>{message.provider} / {message.model}</small>}</article>)}
          {client.status === 'thinking' && <p role="status" className="jef-empty">Jef is thinking…</p>}<div ref={end} />
        </>}
        {s && tab === 'Memory' && <Memory client={client} />}
        {s && tab === 'Follow-ups' && <FollowUps client={client} />}
        {s && tab === 'Settings' && <Settings client={client} />}
        {s && tab === 'Sophia' && <TeamQueue client={client} />}
        {s && tab === 'Log' && <div className="jef-settings"><h3>Real local events</h3>{s.events.slice().reverse().map(event => <article className="jef-note" key={event.id}><small>{new Date(event.at).toLocaleString()} · {event.type}</small><p>{event.text}</p></article>)}<h3>Action audit</h3>{s.audit.slice().reverse().map((entry, i) => <p key={i}><small>{new Date(entry.at).toLocaleTimeString()} · {entry.action} · {entry.outcome}</small></p>)}</div>}
      </div>
      {tab === 'Chat' && <form className="jef-composer" onSubmit={async e => { e.preventDefault(); if (await client.send({ action: 'chat', text })) setText('') }}>
        <label className="sr-only" htmlFor="jef-message">Message Jef</label><textarea id="jef-message" value={text} onChange={e => setText(e.target.value)} maxLength={8000} required placeholder="Message Jef…" disabled={busy || !s?.provider} />
        <div><button disabled={busy || !s?.provider || !text.trim()}>Send</button><button type="button" disabled={busy || !s?.provider} onClick={() => { void client.send({ action: 'briefing' }) }}>Brief me now</button></div>
        <small>No command execution. Other employees are placeholders.</small>
      </form>}
    </section>}
  </>
}
