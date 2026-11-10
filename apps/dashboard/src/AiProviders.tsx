import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { AiClient } from './ai-client'
import { useRuntimeRecovery } from './useRuntimeRecovery'
import type { AiAction, AiSnapshot, AssignmentView, Capability, ManagedConnection, ModelSearch } from './ai-contract'
import type { CatalogEntry, CatalogQuery, ModelRoute } from '../server/ai/contracts.ts'
import { capabilityLabels, catalogErrorMessage, displayTime, eligibilityReason, verificationLabel } from './ai-display'
import { team } from './team'

type Perform = (action: AiAction, success: string, after?: () => void) => Promise<boolean>
type OperationResult = { ok?: boolean; code?: string | null; state?: string; errorCode?: string | null }
const message = (error: unknown) => error instanceof Error ? error.message : 'Provider request failed.'
const defaults: Record<string, { baseUrl: string; networkPolicy: 'public' | 'loopback' }> = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', networkPolicy: 'public' },
  openai: { baseUrl: 'https://api.openai.com/v1', networkPolicy: 'public' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', networkPolicy: 'public' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', networkPolicy: 'public' },
  xkiro: { baseUrl: 'https://api.xkiro.com/v1', networkPolicy: 'public' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', networkPolicy: 'public' },
  'openai-compatible': { baseUrl: '', networkPolicy: 'public' },
  ollama: { baseUrl: 'http://127.0.0.1:11434', networkPolicy: 'loopback' },
}

export function AiProviders() {
  const client = useRef(new AiClient()).current
  const mounted = useRef(true)
  const busy = useRef(false)
  const [snapshot, setSnapshot] = useState<AiSnapshot | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const [reload, setReload] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const recovery = useRuntimeRecovery(signal => client.snapshot(signal), data => { if (mounted.current) setSnapshot(data) }, { healthyInterval: 30000, offlineInterval: 30000 })
  const refresh = recovery.refresh
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const perform: Perform = async (action, success, after) => {
    if (busy.current) return false
    busy.current = true; setPending(true); setError(''); setNotice('')
    try {
      const result = await client.request<OperationResult>(action)
      if (!mounted.current) return true
      const code = result.errorCode || (result.code !== 'OK' ? result.code : null)
      if (result.ok === false || code || ['unavailable', 'incompatible', 'untested', 'partial', 'failed', 'unsupported'].includes(result.state ?? '')) setError(`${success.replace(/\.$/, '')}: ${code || result.state}. See the latest result below.`)
      else setNotice(success)
      after?.()
      return true
    } catch (e) {
      if (mounted.current) setError(`${message(e)} Reload current state before retrying if the request was interrupted.`)
      return false
    } finally {
      try { await refresh() } catch (e) { if (mounted.current) setError(message(e)) }
      if (mounted.current) { setReload(n => n + 1); setPending(false) }
      busy.current = false
    }
  }
  const editConnection = snapshot?.connections.find(c => c.id === editing)

  return <section className="providers-page" aria-labelledby="providers-title" aria-busy={pending}>
    <div className="providers-heading"><div><div className="eyebrow">WORKSPACE CONFIGURATION</div><h1 id="providers-title">AI Providers</h1><p>Connect providers, choose models, and assign agents.</p></div></div>
    <p className="providers-note">Alex uses his saved verified primary for live chat. Automatic switches consider only saved verified fallbacks after repeated slowness or a provider limit signal.</p>
    {recovery.state !== 'connected' && <p className="providers-error" role="status">{recovery.state === 'offline' ? 'Local dashboard backend is offline.' : 'Reconnecting to the local dashboard…'} {recovery.error}</p>}
    {error && <div className="providers-error" role="alert">{error}</div>}
    <div className="providers-notice" role="status" aria-live="polite">{pending ? 'Working… Provider tests and verification may take a moment.' : notice}</div>
    {!snapshot ? <p>{error ? 'The provider management API is unavailable. Reload state to retry.' : 'Loading provider system…'}</p> : <>
      <section className="panel providers-section" aria-labelledby="connections-title">
        <div className="panel-heading"><div><div className="eyebrow">ACCOUNTS &amp; ENDPOINTS</div><h2 id="connections-title">Connections <span className="count-chip">{snapshot.connections.length}</span></h2></div><button className="providers-primary" disabled={pending || editing !== null} onClick={() => setEditing('new')}>＋ Add connection</button></div>
        {!snapshot.connections.length && <p className="providers-empty">No connections yet. Add a provider account or a local model endpoint to begin.</p>}
        <div className="connection-grid">{snapshot.connections.map(c => {
          const status = snapshot.refreshes.find(s => s.connectionId === c.id)
          const test = snapshot.testResults[c.id]
          return <article className="connection-card" key={c.id}>
            <div className="panel-heading"><h3>{c.label}</h3><span className={`provider-badge ${c.enabled ? 'good' : ''}`}>{c.enabled ? 'Enabled' : 'Disabled'}</span></div>
            <p>{snapshot.providers.find(p => p.id === c.providerId)?.name ?? c.providerId}</p><code>{c.baseUrl}</code>
            <p className={test?.code && test.code !== 'OK' || status?.errorCode ? 'provider-failure' : 'providers-muted'} role="status">{!c.enabled ? 'Paused' : status?.errorCode ? catalogErrorMessage(status.errorCode) : c.health.authentication === 'rejected' ? 'Credential rejected' : status?.state === 'complete' ? `${status.modelsSeen} models available` : c.health.discovery === 'unsupported' ? 'Discovery unavailable · add a model manually' : c.health.checkedAt ? 'Connection checked · model sync pending' : 'Checking connection…'}</p>
            {c.scope.account && <p>Account: {c.scope.account}</p>}
            {test && test.code !== 'OK' && <p className="provider-failure">{test.message}</p>}
            <div className="providers-actions"><button disabled={pending || editing !== null} onClick={() => setEditing(c.id)}>Manage connection</button></div>
            <details className="providers-advanced"><summary>Advanced actions and diagnostics</summary>
              <dl><div><dt>Credentials</dt><dd>{c.credentials.state}</dd></div><div><dt>Authentication</dt><dd>{c.health.authentication}</dd></div><div><dt>Discovery / last inference probe</dt><dd>{c.health.discovery} / {c.health.inference}</dd></div><div><dt>Last check</dt><dd>{displayTime(c.health.checkedAt)}</dd></div></dl>
              {test && <p>Last connection test: {test.message} · {displayTime(test.at)}</p>}
              {status && <p>Catalog: {status.state} · {status.modelsSeen} models · {displayTime(status.completedAt || status.startedAt)}{status.connectionRevision !== c.revision ? ' · Previous connection revision' : ''}</p>}
              <div className="providers-actions">
              <button disabled={pending} onClick={() => void perform({ action: 'connection.test', id: c.id, revision: c.revision }, 'Connection test completed. A connection test does not verify model inference.')}>Test connection</button>
              <button disabled={pending} onClick={() => { if (c.enabled && !window.confirm(`Disable ${c.label}? Assigned models on this connection will become unavailable.`)) return; void perform({ action: 'connection.enable', id: c.id, revision: c.revision, enabled: !c.enabled }, `Connection ${c.enabled ? 'disabled' : 'enabled'}.`) }}>{c.enabled ? 'Disable' : 'Enable'}</button>
              <button disabled={pending || !c.enabled} onClick={() => void perform({ action: 'catalog.refresh', id: c.id }, 'Model discovery completed.')}>Discover models</button>
              <button className="providers-danger" disabled={pending} onClick={() => setRemoving(c.id)}>Remove</button>
              </div>
            {removing === c.id && <div className="providers-confirm"><p>Remove “{c.label}” and its stored credential? Historical model evidence will remain, with this route unavailable.</p><button className="providers-danger" disabled={pending} onClick={() => void perform({ action: 'connection.remove', id: c.id, revision: c.revision }, 'Connection removed.', () => { setRemoving(null); if (editing === c.id) setEditing(null) })}>Confirm removal</button> <button disabled={pending} onClick={() => setRemoving(null)}>Cancel</button></div>}
            </details>
          </article>
        })}</div>
        {editing && (editing === 'new' || editConnection) && <ConnectionEditor key={editConnection ? `${editConnection.id}:${editConnection.revision}` : 'new'} connection={editConnection} snapshot={snapshot} pending={pending} perform={perform} onClose={() => setEditing(null)} />}
      </section>
      <ModelWorkspace snapshot={snapshot} client={client} pending={pending} perform={perform} reload={reload} />
    </>}
  </section>
}

function ConnectionEditor({ connection: c, snapshot, pending, perform, onClose }: { connection?: ManagedConnection; snapshot: AiSnapshot; pending: boolean; perform: Perform; onClose: () => void }) {
  const [providerId, setProvider] = useState(c?.providerId ?? snapshot.providers[0]?.id ?? '')
  const [label, setLabel] = useState(c?.label ?? '')
  const [baseUrl, setBase] = useState(c?.baseUrl ?? defaults[providerId]?.baseUrl ?? '')
  const [networkPolicy, setNetwork] = useState<'public' | 'loopback'>(c?.networkPolicy ?? defaults[providerId]?.networkPolicy ?? 'public')
  const [authStyle, setAuthStyle] = useState<'bearer' | 'x-api-key'>(c?.authStyle ?? 'bearer')
  const [scope, setScope] = useState(c?.scope ?? { account: null, project: null, region: null })
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const secret = key; setKey('')
    const metadata = { label, baseUrl, networkPolicy, scope, ...(providerId === 'openai-compatible' ? { authStyle } : {}) }
    await perform(c ? { action: 'connection.edit', id: c.id, revision: c.revision, patch: metadata } : { action: 'connection.add', connection: { ...metadata, providerId, enabled: false }, ...(secret ? { apiKey: secret } : {}) }, c ? 'Connection updated. Connection test runs automatically after endpoint changes.' : 'Connection saved as disabled. Connection test runs automatically; enable it to sync models.', onClose)
  }
  return <div className="connection-editor">
    <h3>{c ? `Edit ${c.label}` : 'Add a connection'}</h3>
    <form onSubmit={event => void submit(event)}>
      <fieldset disabled={pending}><legend className="sr-only">Connection details</legend>
        <div className="providers-fields"><label>Provider<select value={providerId} disabled={Boolean(c)} onChange={e => { const id = e.target.value; setProvider(id); setBase(defaults[id]?.baseUrl ?? ''); setNetwork(defaults[id]?.networkPolicy ?? 'public'); setAuthStyle('bearer'); setKey('') }}>{snapshot.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>Connection name<input required maxLength={200} value={label} onChange={e => setLabel(e.target.value)} placeholder="Personal account / local workstation" /></label>
          <label>Base URL<input required type="url" maxLength={2048} value={baseUrl} onChange={e => setBase(e.target.value)} placeholder="https://provider.example/v1" /></label>
          <label>Network policy<select value={networkPolicy} disabled={!['openai-compatible', 'ollama'].includes(providerId)} onChange={e => setNetwork(e.target.value as 'public' | 'loopback')}><option value="public">Public HTTPS</option><option value="loopback">Local loopback</option></select></label>
          {providerId === 'openai-compatible' && <label>API key header<select value={authStyle} onChange={e => setAuthStyle(e.target.value as 'bearer' | 'x-api-key')}><option value="bearer">Authorization: Bearer</option><option value="x-api-key">x-api-key</option></select></label>}
          <details className="providers-advanced"><summary>Account details (optional)</summary>{(['account', 'project', 'region'] as const).map(field => <label key={field}>{field}<input maxLength={200} value={scope[field] ?? ''} onChange={e => setScope(s => ({ ...s, [field]: e.target.value || null }))} /></label>)}</details>
          {!c && <label>API key (write only)<input type="password" autoComplete="new-password" maxLength={8192} value={key} onChange={e => setKey(e.target.value)} placeholder={providerId === 'openrouter' ? 'Required for OpenRouter access' : 'Optional for local services'} /></label>}
        </div>
        <p>Local ports allowed by the backend: {snapshot.localPorts.join(', ')}. Public endpoints require HTTPS. Credentials are encrypted on the server and never returned.</p>
        {c && <p>Changing the endpoint or network policy clears the saved credential. Save those changes first, then replace the key. Metadata changes require fresh discovery and verification.</p>}
        <div className="providers-actions"><button className="providers-primary" type="submit">{c ? 'Save connection details' : 'Save disabled connection'}</button><button type="button" onClick={onClose}>Cancel</button></div>
      </fieldset>
    </form>
    {c && <form onSubmit={e => { e.preventDefault(); const secret = key; setKey(''); setClearKey(false); void perform({ action: 'connection.credential', id: c.id, revision: c.revision, apiKey: clearKey ? null : secret }, clearKey ? 'Stored credential cleared.' : 'Credential replaced. Refresh discovery and verify models again.') }}>
      <fieldset disabled={pending}><legend>Stored credential · {c.credentials.state}</legend>
        <label>Replacement API key<input type="password" autoComplete="new-password" value={key} maxLength={8192} disabled={clearKey} required={!clearKey} onChange={e => setKey(e.target.value)} placeholder="Enter a new key; saved keys cannot be viewed" /></label>
        <label className="providers-check"><input type="checkbox" checked={clearKey} onChange={e => { setClearKey(e.target.checked); setKey('') }} /> Clear the stored credential</label>
        <button type="submit">{clearKey ? 'Clear credential' : 'Replace credential'}</button>
      </fieldset>
    </form>}
  </div>
}

function ModelWorkspace({ snapshot, client, pending, perform, reload }: { snapshot: AiSnapshot; client: AiClient; pending: boolean; perform: Perform; reload: number }) {
  const [agentId, setAgent] = useState('01')
  const [assignment, setAssignment] = useState<AssignmentView | null>(null)
  const [assignmentError, setAssignmentError] = useState('')
  const [assignmentLoading, setAssignmentLoading] = useState(true)
  const [assignmentReload, setAssignmentReload] = useState(0)
  const [requirements, setRequirements] = useState<Capability[]>(['text', 'systemInstructions'])
  const [candidateIds, setCandidates] = useState<string[]>([])
  const [knownRoutes, setKnownRoutes] = useState<Record<string, ModelRoute>>({})
  const [dirty, setDirty] = useState(false)
  const [search, setSearch] = useState('')
  const [provider, setProvider] = useState('')
  const [connection, setConnection] = useState('')
  const [output, setOutput] = useState('')
  const [result, setResult] = useState<ModelSearch | null>(null)
  const [searchError, setSearchError] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchReload, setSearchReload] = useState(0)
  const [manualConnection, setManualConnection] = useState('')
  const [manualId, setManualId] = useState('')
  const [manualName, setManualName] = useState('')
  const controller = useRef<AbortController | null>(null)
  const query: CatalogQuery = { search, ...(provider ? { providerIds: [provider] } : {}), ...(connection ? { connectionIds: [connection] } : {}), ...(output ? { outputModality: output } : {}), pageSize: 30 }
  const queryKey = JSON.stringify(query), requirementsKey = JSON.stringify(requirements)
  const ready = !assignmentLoading && !assignmentError && Boolean(assignment)

  useEffect(() => {
    const abort = new AbortController()
    setAssignmentLoading(true); setAssignmentError(''); setAssignment(null); setDirty(false); setCandidates([]); setKnownRoutes({})
    setRequirements(agentId === '01' ? ['text', 'systemInstructions'] : ['text'])
    void client.request<AssignmentView>({ action: 'assignment.get', agentId }, abort.signal).then(data => {
      if (abort.signal.aborted) return
      setAssignment(data); setCandidates(data.assignment?.candidateRouteIds ?? [])
      setRequirements(data.assignment?.requiredCapabilities ?? (agentId === '01' ? ['text', 'systemInstructions'] : ['text']))
      setKnownRoutes(Object.fromEntries(data.candidates.flatMap(c => c.route ? [[c.routeId, c.route]] : [])))
    }).catch(e => { if (!abort.signal.aborted) setAssignmentError(message(e)) }).finally(() => { if (!abort.signal.aborted) setAssignmentLoading(false) })
    return () => abort.abort()
  }, [client, agentId, assignmentReload])

  useEffect(() => {
    const abort = new AbortController(); controller.current = abort
    setResult(null); setSearchError(''); setSearching(true)
    const timer = window.setTimeout(() => {
      void client.request<ModelSearch>({ action: 'catalog.search', query: JSON.parse(queryKey), agentId, requiredCapabilities: JSON.parse(requirementsKey) }, abort.signal).then(data => {
        if (!abort.signal.aborted) setResult(data)
      }).catch(e => { if (!abort.signal.aborted) setSearchError(message(e)) }).finally(() => { if (!abort.signal.aborted) setSearching(false) })
    }, 250)
    return () => { abort.abort(); window.clearTimeout(timer) }
  }, [client, queryKey, agentId, requirementsKey, reload, searchReload])

  const more = async () => {
    const abort = controller.current
    if (!result?.page.nextCursor || !abort || searching) return
    setSearching(true); setSearchError('')
    try {
      const next = await client.request<ModelSearch>({ action: 'catalog.search', query: { ...query, cursor: result.page.nextCursor }, agentId, requiredCapabilities: requirements }, abort.signal)
      if (!abort.signal.aborted) setResult({ page: { ...next.page, entries: [...result.page.entries, ...next.page.entries] }, eligibility: { ...result.eligibility, ...next.eligibility } })
    } catch (e) { if (!abort.signal.aborted) setSearchError(`${message(e)} Restart results to use the latest catalog.`) }
    finally { if (!abort.signal.aborted) setSearching(false) }
  }
  const add = (route: ModelRoute) => {
    setCandidates(ids => ids.includes(route.id) ? ids : [...ids, route.id]); setKnownRoutes(routes => ({ ...routes, [route.id]: route })); setDirty(true)
  }
  const move = (index: number, delta: number) => {
    setCandidates(ids => { const next = [...ids]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; return next }); setDirty(true)
  }

  return <div className="model-workspace">
    <section className="panel providers-section assignment-section" aria-labelledby="assignments-title">
      <div className="panel-heading"><div><div className="eyebrow">EXPLICIT MODEL CHOICES</div><h2 id="assignments-title">Agent assignments</h2></div><span className="provider-badge">{dirty ? 'Unsaved changes' : 'Saved configuration'}</span></div>
      <p>Select an agent, choose required capabilities, then add compatible models from the catalog. The first candidate is primary; the rest are ordered fallbacks. Verification expires after 24 hours.</p>
      <label>Agent<select disabled={pending} value={agentId} onChange={e => setAgent(e.target.value)}>{team.map(a => <option value={a.id} key={a.id}>{a.id} · {a.name} — {a.role}</option>)}</select></label>
      {assignmentError && <p className="provider-failure" role="alert">{assignmentError}</p>}
      {assignmentLoading ? <p role="status">Loading assignment…</p> : <>
        <details className="providers-advanced"><summary>Advanced capability requirements</summary><fieldset disabled={pending || !ready} className="capability-options"><legend>Required observed capabilities</legend>{snapshot.capabilities.map(cap => <label className="providers-check" key={cap}><input type="checkbox" checked={requirements.includes(cap)} disabled={cap === 'text' || (agentId === '01' && cap === 'systemInstructions')} onChange={e => { setRequirements(caps => e.target.checked ? [...caps, cap] : caps.filter(c => c !== cap)); setDirty(true) }} />{capabilityLabels[cap]}</label>)}</fieldset></details>
        {agentId === '01' && <p>Alex always requires verified text and system instructions.</p>}
        <ol className="candidate-list">{candidateIds.map((id, index) => {
          const route = knownRoutes[id], eligibility = result?.eligibility[id]
          const saved = assignment?.candidates.find(c => c.routeId === id)
          return <li key={id}><div><b>{index === 0 ? 'Primary' : `Fallback ${index}`}</b><strong>{route?.model.displayName ?? id}</strong><small>{route?.providerId} · {route?.ref.nativeModelId}<br />{snapshot.connections.find(c => c.id === route?.ref.connectionId)?.label ?? 'Connection unavailable'}</small><small>{eligibility ? eligibilityReason(eligibility.code) : saved && !dirty && reload === 0 ? eligibilityReason(saved.code) : 'Eligibility is checked again when saving'}</small></div><div className="providers-actions"><button disabled={pending || index === 0} aria-label={`Move candidate ${index + 1} up`} onClick={() => move(index, -1)}>↑</button><button disabled={pending || index === candidateIds.length - 1} aria-label={`Move candidate ${index + 1} down`} onClick={() => move(index, 1)}>↓</button><button disabled={pending} aria-label={`Remove candidate ${index + 1}`} onClick={() => { setCandidates(ids => ids.filter(item => item !== id)); setDirty(true) }}>Remove</button></div></li>
        })}</ol>
        {!candidateIds.length && <p className="providers-empty">No model candidates selected. Use “Add candidate” on a compatible catalog entry.</p>}
      </>}
      <div className="providers-actions"><button className="providers-primary" disabled={pending || !ready || !candidateIds.length || !dirty} onClick={() => { if (!window.confirm(`Save ${candidateIds.length} model choice${candidateIds.length === 1 ? '' : 's'} for ${agentId === '01' ? 'Alex' : `agent ${agentId}`}? This changes the model used on future requests.`)) return; void perform({ action: 'assignment.set', revision: assignment?.assignment?.revision ?? 0, assignment: { agentId, candidateRouteIds: candidateIds, requiredCapabilities: requirements } }, 'Assignment and ordered fallbacks saved. Alex checks the selected route before his next request.', () => setAssignmentReload(n => n + 1)) }}>Save assignment</button>{dirty && <button disabled={pending || assignmentLoading} onClick={() => setAssignmentReload(n => n + 1)}>Discard changes</button>}</div>
      {dirty && <p className="providers-note">Changing the agent discards this draft. Every candidate must pass the backend’s current compatibility checks before saving.</p>}
    </section>

    <section className="panel providers-section catalog-section" aria-labelledby="catalog-title">
      <div className="panel-heading"><div><div className="eyebrow">AVAILABLE MODELS</div><h2 id="catalog-title">Model catalog</h2></div></div>
      <p>Discovery lists models; it does not verify access. Verify explicitly to test inference and capabilities. Verification tests the selected agent’s required capabilities, always including text, and may incur provider charges. Select additional requirements to test them. Each run replaces the latest evidence; unrequested capabilities remain untested.</p>
      <label>Search models<input type="search" maxLength={2000} placeholder="Name or exact model ID" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <details className="providers-advanced"><summary>Filters and manual model entry</summary><div className="providers-filters"><label>Provider<select value={provider} onChange={e => { setProvider(e.target.value); setConnection('') }}><option value="">All providers</option>{snapshot.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Connection<select value={connection} onChange={e => setConnection(e.target.value)}><option value="">All connections</option>{snapshot.connections.filter(c => !provider || c.providerId === provider).map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label><label>Output modality<select value={output} onChange={e => setOutput(e.target.value)}><option value="">All / unknown</option>{['text', 'image', 'audio', 'video', 'embedding'].map(m => <option key={m} value={m}>{m}</option>)}</select></label></div>
        <form className="providers-manual" onSubmit={e => { e.preventDefault(); void perform({ action: 'model.manual.add', connectionId: manualConnection, nativeModelId: manualId, displayName: manualName || manualId }, 'Manual model saved. Verify it before assignment.', () => { setManualId(''); setManualName(''); setSearchReload(n => n + 1) }) }}><h3>Add a model manually</h3><p>Use this when discovery is unavailable. Enter the exact provider model ID; model access and capabilities remain unverified until you run a probe.</p><div className="providers-fields"><label>Connection<select required value={manualConnection} onChange={e => setManualConnection(e.target.value)}><option value="">Choose connection</option>{snapshot.connections.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label><label>Exact model ID<input required maxLength={500} value={manualId} onChange={e => setManualId(e.target.value)} /></label><label>Display name (optional)<input maxLength={200} value={manualName} onChange={e => setManualName(e.target.value)} /></label></div><button disabled={pending || !manualConnection || !manualId.trim()} type="submit">Save manual model</button></form>
        <button disabled={pending || searching} onClick={() => setSearchReload(n => n + 1)}>Restart results</button>
      </details>
      {searchError && <div className="providers-error" role="alert">{searchError}</div>}
      <p role="status" aria-live="polite">{searching ? 'Searching catalog…' : result ? `${result.page.entries.length} of ${result.page.total ?? '?'} matching model routes` : 'Catalog results unavailable'}</p>
      {result?.page.entries.length === 0 && <p className="providers-empty">No matching models yet. Enabled connections sync automatically. Use manual model entry above if a provider has no catalog endpoint.</p>}
      <div className="model-list">{result?.page.entries.map(entry => <ModelCard key={entry.route.id} entry={entry} requirements={requirements} snapshot={snapshot} pending={pending} perform={perform} eligibility={result.eligibility[entry.route.id]} canAdd={ready && !candidateIds.includes(entry.route.id)} onAdd={() => add(entry.route)} />)}</div>
      {result?.page.nextCursor && <button disabled={searching || pending || Boolean(searchError)} onClick={() => void more()}>Load more models</button>}
    </section>
  </div>
}

function ModelCard({ entry, requirements, snapshot, pending, perform, eligibility, canAdd, onAdd }: { entry: CatalogEntry; requirements: Capability[]; snapshot: AiSnapshot; pending: boolean; perform: Perform; eligibility?: { compatible: boolean; code: string }; canAdd: boolean; onAdd: () => void }) {
  const route = entry.route, v = entry.verification, c = snapshot.connections.find(item => item.id === route.ref.connectionId)
  const label = verificationLabel(entry)
  return <article className="model-card">
    <div className="panel-heading"><h3>{route.model.displayName}</h3><span className={`provider-badge ${label === 'Verified' ? 'good' : ''}`}>{label}</span></div>
    <code>{route.ref.nativeModelId}</code><p>{snapshot.providers.find(p => p.id === route.providerId)?.name ?? route.providerId} · {c?.label ?? 'Removed connection'} · {entry.pricing.freeAccess.kind === 'verified-zero-price' ? 'listed $0' : entry.pricing.freeAccess.kind === 'paid' ? 'paid' : 'price unknown'}</p>
    <p>Access: {route.access.state} · {route.lifecycle} · Output: {route.model.capabilities.output?.join(', ') || 'unknown'}</p>
    <details><summary>Capabilities &amp; verification details</summary><p>Input: {route.model.capabilities.input?.join(', ') || 'unknown'} · Context: {route.model.contextTokens?.toLocaleString() ?? 'unknown'}</p>
      <dl>{snapshot.capabilities.map(cap => <div key={cap}><dt>{capabilityLabels[cap]}</dt><dd>Listed: {cap === 'text' ? route.model.capabilities.output === null ? 'unknown' : route.model.capabilities.output.includes('text') ? 'supported' : 'unsupported' : route.model.capabilities[cap]} · Last probe: {v?.capabilities[cap].state ?? 'untested'}{v?.capabilities[cap].code ? ` (${v.capabilities[cap].code})` : ''}</dd></div>)}</dl>
      <p>Last verification: {displayTime(v?.checkedAt)}{v ? ` · ${v.state} · ${v.code ?? 'OK'} · connection revision ${v.connectionRevision}` : ''}</p><p>Current connection revision: {c?.revision ?? 'removed'} · Catalog revision: {route.connectionRevision}</p><code>Route: {route.id}</code>
    </details>
    {v?.code && <p className="provider-failure">Verification result: {v.code}</p>}
    <p className={eligibility?.compatible ? 'provider-success' : 'providers-muted'}>{eligibility ? eligibilityReason(eligibility.code) : 'Compatibility unavailable'}</p>
    <div className="providers-actions"><button disabled={pending || !c?.enabled || c.revision !== route.connectionRevision || route.lifecycle === 'removed'} onClick={() => { if (window.confirm('Verify this model with live requests? This may use provider credits.')) void perform({ action: 'model.verify', routeId: route.id, capabilities: requirements }, 'Model verification completed. Inspect the tested capability results below.') }}>Verify required capabilities</button><button disabled={pending || !canAdd || !eligibility?.compatible} onClick={onAdd}>Add candidate</button></div>
  </article>
}
