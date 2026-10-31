import { Canvas } from '@react-three/fiber'
import { useMemo, useState } from 'react'
import { OfficeScene } from './OfficeScene'
import { team } from './team'
import { useAlex } from './useAlex'
import { AlexChat } from './AlexChat'
import { AiProviders } from './AiProviders'

type Inspection = { kind: 'profile' | 'workstation' | 'room'; title: string; subtitle: string; facts: string[] }

const activity = [
  { time: '09:42', title: 'Office initialized', detail: 'Dashboard preview is ready', color: '#8bd6bd' },
  { time: '09:41', title: 'Workspace created', detail: 'Seven desk positions added', color: '#e7bd79' },
  { time: '09:40', title: 'Waiting for setup', detail: 'No agent connections configured', color: '#9db2f4' },
]

function App() {
  const alex = useAlex()
  const [chatOpen, setChatOpen] = useState(false)
  const agents = useMemo(() => team.map(agent => agent.id === '01' ? { ...agent, state: alex.status } : agent), [alex.status])
  const [selected, setSelected] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState('Office')
  const [view, setView] = useState<'isometric' | 'top'>('isometric')
  const [zoom, setZoom] = useState(1)
  const [cameraReset, setCameraReset] = useState(0)
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const selectedAgent = agents.find((agent) => agent.id === selected)

  const selectAgent = (id: string) => {
    const agent = agents.find((item) => item.id === id)
    if (!agent) return
    setActiveTab('Office')
    setSelected(id)
    if (id === '01') setChatOpen(true)
    setInspection({ kind: 'profile', title: agent.name, subtitle: agent.role, facts: [`Status · ${agent.state}`, `Workstation · ${agent.id}`] })
  }
  const inspectWorkstation = (id: string) => {
    const agent = agents.find((item) => item.id === id)
    if (!agent) return
    setActiveTab('Office')
    setSelected(id)
    setInspection({ kind: 'workstation', title: `Workstation ${id}`, subtitle: `Assigned to ${agent.name}`, facts: ['Monitor · workstation display', 'Keyboard, mouse · desk equipment'] })
  }
  const inspectRoom = (title: string, subtitle: string, facts: string[]) => {
    setActiveTab('Office')
    setSelected(null)
    setInspection({ kind: 'room', title, subtitle, facts })
  }
  const clearInspection = () => {
    setSelected(null)
    setInspection(null)
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#office" aria-label="nthnEntps home">
          <span className="brand-mark">n<span>.</span></span>
          <span className="brand-name">nthn<span>Entps</span></span>
        </a>
        <div className="workspace-label"><span className="live-dot" /> Local workspace <span className="label-divider">/</span> <b>Office preview</b></div>
        <button className="avatar-button" aria-label="Workspace menu">N</button>
      </header>

      <nav className="mobile-nav dashboard-nav" aria-label="Dashboard navigation">
        {['Office', 'Agents', 'Activity', 'AI Providers'].map((tab) => <button key={tab} aria-current={activeTab === tab ? 'page' : undefined} className={activeTab === tab ? 'nav-active' : ''} onClick={() => setActiveTab(tab)}>{tab}</button>)}
      </nav>

      <section className={`dashboard ${activeTab === 'AI Providers' ? 'providers-active' : ''}`}>
        {activeTab === 'AI Providers' && <AiProviders />}
        <aside className={`panel agent-panel ${activeTab === 'Agents' ? 'panel-current' : ''}`}>
          <div className="panel-heading"><div><div className="eyebrow">WORKSPACE</div><h2>Team</h2></div><span className="count-chip">07</span></div>
          <p className="panel-subtitle">Agent positions · setup preview</p>
          <div className="agent-list">
            {agents.map((agent) => <button className={`agent-row ${selected === agent.id ? 'agent-selected' : ''}`} key={agent.id} onClick={() => selectAgent(agent.id)}>
              <span className="agent-avatar" style={{ '--agent-color': agent.color } as React.CSSProperties}>{agent.id}</span>
              <span className="agent-copy"><strong>{agent.name}</strong><small>{agent.role}</small></span>
              <span className={agent.id === '01' ? `alex-status-dot ${alex.status}` : 'status-dot'} title={agent.state} />
            </button>)}
          </div>
          <div className="panel-footnote"><span className="status-dot" /> Alex · {alex.status} <span className="footnote-spacer" /> 6 placeholders</div>
        </aside>

        <section className={`office-column ${activeTab === 'Office' ? 'panel-current' : ''}`} id="office">
          <div className="office-heading"><div><div className="eyebrow">WORKSPACE OVERVIEW <span className="heading-dot">·</span> LOCAL PREVIEW</div><h1>Good morning<span>,</span> team</h1><p>Your office is ready for its first day.</p></div><button className="add-button" onClick={() => setSelected(null)}><span>＋</span> <b>New task</b></button></div>
          <div className="scene-card">
            <div className="scene-topline"><span><i className="scene-indicator" /> OFFICE FLOOR <b>01</b></span><span className="scene-count">7 DESKS <i /> PREVIEW MODE</span></div>
            <div className="scene-canvas" aria-label="Interactive 3D office with Alex and six placeholder employees">
              <Canvas dpr={[1, 1.3]} shadows="soft" camera={{ position: [18.5, 18.3, 22.5], fov: 38 }} gl={{ antialias: true, alpha: false, powerPreference: 'low-power' }}>
                <OfficeScene agents={agents} selected={selected} hovered={hovered} onHover={setHovered} onSelectAgent={selectAgent} onInspectWorkstation={inspectWorkstation} onInspectRoom={inspectRoom} onClearSelection={clearInspection} view={view} onViewChange={setView} zoom={zoom} onZoomChange={setZoom} resetToken={cameraReset} />
              </Canvas>
              <div className="scene-legend"><span className="legend-dot" /> Tap people, desks &amp; rooms <span className="legend-separator">·</span> Drag / pinch camera</div>
              {inspection && <div className="selection-card inspection-card"><span className="selection-avatar">{selectedAgent?.id ?? '⌂'}</span><span><small className="inspection-type">{inspection.kind === 'profile' ? 'EMPLOYEE PROFILE' : inspection.kind === 'workstation' ? 'WORKSTATION' : 'OFFICE AREA'}</small><b>{inspection.title}</b><small>{inspection.subtitle}</small>{(selectedAgent?.id === '01' && inspection.kind === 'profile' ? [`Status · ${alex.status}`, `Model · ${alex.snapshot?.model || 'Unconfigured'}`, 'Open Alex chat using Talk to Alex'] : inspection.facts).map((fact) => <small className="inspection-fact" key={fact}>{fact}</small>)}</span><button onClick={clearInspection} aria-label="Close inspection">×</button></div>}
            </div>
            <div className="scene-controls"><div className="view-toggle"><button className={view === 'isometric' ? 'control-active' : ''} onClick={() => setView('isometric')}>Isometric</button><button className={view === 'top' ? 'control-active' : ''} onClick={() => setView('top')}>Top view</button></div><div className="zoom-controls"><button aria-label="Zoom out" onClick={() => setZoom(Math.max(.8, zoom - .1))}>−</button><span>{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" onClick={() => setZoom(Math.min(1.3, zoom + .1))}>＋</button><button className="reset-camera" aria-label="Reset camera" title="Reset camera" onClick={() => { clearInspection(); setZoom(1); setView('isometric'); setCameraReset((token) => token + 1) }}>Reset</button></div></div>
          </div>
          <div className="summary-row"><div className="summary-card"><span className="summary-icon mint">◇</span><div><small>TEAM CAPACITY</small><b>7 <span>positions</span></b></div><span className="summary-meta">SETUP</span></div><div className="summary-card"><span className="summary-icon gold">↗</span><div><small>OPEN TASKS</small><b>0 <span>in progress</span></b></div><span className="summary-meta">—</span></div></div>
        </section>

        <aside className={`panel activity-panel ${activeTab === 'Activity' ? 'panel-current' : ''}`}>
          <div className="panel-heading"><div><div className="eyebrow">WORKSPACE FEED</div><h2>Activity</h2></div><button className="more-button" aria-label="More activity options">···</button></div>
          <p className="panel-subtitle">A quiet start to the day.</p>
          <div className="activity-list">{activity.map((item) => <div className="activity-item" key={item.title}><span className="activity-dot" style={{ backgroundColor: item.color }} /><div><div className="activity-title">{item.title}<time>{item.time}</time></div><p>{item.detail}</p></div></div>)}</div>
          <div className="tasks-heading"><div><div className="eyebrow">UP NEXT</div><h2>Tasks</h2></div><span className="count-chip muted-chip">0</span></div>
          <div className="empty-state"><span className="empty-icon">☷</span><b>No tasks yet</b><p>Tasks added to your workspace will appear here.</p><button onClick={() => setActiveTab('Office')}>Explore the office <span>→</span></button></div>
          <div className="data-note"><span>i</span> Activity shown is sample data for this preview.</div>
        </aside>
      </section>

      <footer className="bottom-bar"><span>© 2024 NTHN ENTERPRISES</span><span className="footer-center"><i /> LOCAL WORKSPACE <b>·</b> ALEX {alex.status.toUpperCase()}</span><button onClick={() => setActiveTab('Office')}>Office controls <span>↗</span></button></footer>
      <AlexChat client={alex} open={chatOpen} onClose={() => setChatOpen(false)} onOpen={() => setChatOpen(true)} />
    </main>
  )
}

export default App
