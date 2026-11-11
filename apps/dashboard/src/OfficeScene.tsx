import { useEffect, useMemo, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { ContactShadows } from './ContactShadows'
import { InteriorDetails } from './InteriorDetails'
import { OfficeArchitecture, SoftBlock } from './OfficeArchitecture'
import { DESKS, OFFICE, ROOMS } from './officeLayout'

type Agent = { id: string; name: string; role: string; color: string; state: string }
type Props = {
  agents: Agent[]
  selected: string | null
  hovered: string | null
  onHover: (id: string | null) => void
  onSelectAgent: (id: string) => void
  onInspectWorkstation: (id: string) => void
  onInspectRoom: (title: string, subtitle: string, facts: string[]) => void
  onClearSelection: () => void
  view: 'isometric' | 'top'
  onViewChange: (view: 'isometric' | 'top') => void
  zoom: number
  onZoomChange: (zoom: number) => void
  resetToken: number
}
type DeskProps = {
  agent: Agent
  position: [number, number, number]
  rotation: number
  selected: boolean
  hovered: boolean
  onHover: (id: string | null) => void
  onSelectAgent: (id: string) => void
  onInspectWorkstation: (id: string) => void
  keyboard: THREE.CanvasTexture
  suppressClick: MutableRefObject<boolean>
}

const skinTones = ['#d9a77f', '#ad7657', '#e2b894', '#c78f6c', '#8c5d48', '#e5bd9a', '#b77d5d']
const hairColors = ['#25201d', '#272329', '#4a3023', '#20252a', '#593a2d', '#49372d', '#32271f']
const roleShort = ['COMMS', 'SECURITY', 'PRODUCT', 'ARCH', 'BUILD', 'QUALITY', 'PLATFORM']

function makeFloorTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const context = canvas.getContext('2d')!
  context.fillStyle = '#30201b'
  context.fillRect(0, 0, 512, 512)
  const colors = ['#53382b', '#483025', '#61432f', '#503528', '#5b3d2d', '#432d23']
  for (let row = 0; row < 8; row++) {
    const offset = row % 2 ? -64 : 0
    for (let col = -1; col < 5; col++) {
      const x = col * 128 + offset
      const y = row * 64
      context.fillStyle = colors[(row * 3 + col + 11) % colors.length]
      context.fillRect(x + 1, y + 1, 126, 62)
      context.strokeStyle = 'rgba(36,34,30,.3)'
      context.lineWidth = 2
      context.strokeRect(x + 1, y + 1, 126, 62)
      context.strokeStyle = 'rgba(239,225,204,.065)'
      context.lineWidth = 1
      for (let grain = 0; grain < 26; grain++) {
        const gy = y + 3 + grain * 2.2
        context.beginPath()
        context.moveTo(x + 10, gy)
        context.bezierCurveTo(x + 44, gy - 4, x + 81, gy + 5, x + 116, gy - 1)
        context.stroke()
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(5.5, 4.25)
  texture.anisotropy = 4
  return texture
}

function makeKeyboardTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 96
  const context = canvas.getContext('2d')!
  context.fillStyle = '#252b2b'
  context.fillRect(0, 0, 256, 96)
  context.fillStyle = '#6f7773'
  for (let row = 0; row < 4; row++) {
    const count = row === 3 ? 8 : 14
    for (let col = 0; col < count; col++) {
      const width = row === 3 && col === 3 ? 54 : 13
      context.fillRect(8 + col * 17, 8 + row * 20, width, 12)
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function makeScreenTexture(agent: Agent) {
  const canvas = document.createElement('canvas')
  canvas.width = 384
  canvas.height = 256
  const context = canvas.getContext('2d')!
  const color = agent.color
  context.fillStyle = '#101b1a'
  context.fillRect(0, 0, 384, 256)
  context.fillStyle = '#1b2927'
  context.fillRect(0, 0, 384, 38)
  context.fillStyle = color
  context.fillRect(16, 16, 7, 7)
  context.font = '600 15px sans-serif'
  context.fillStyle = '#e4ebe5'
  context.fillText(agent.name.toUpperCase(), 34, 25)
  context.font = '11px sans-serif'
  context.fillStyle = '#87988d'
  context.fillText(roleShort[Number(agent.id) - 1] ?? 'WORKSPACE', 16, 61)
  context.fillStyle = '#243431'
  context.fillRect(16, 75, 207, 118)
  context.strokeStyle = `${color}80`
  context.lineWidth = 2
  context.beginPath()
  context.moveTo(28, 168)
  context.lineTo(69, 143)
  context.lineTo(106, 153)
  context.lineTo(151, 111)
  context.lineTo(207, 128)
  context.stroke()
  context.fillStyle = color
  context.globalAlpha = .18
  context.fillRect(16, 204, 88, 6)
  context.globalAlpha = 1
  for (let row = 0; row < 4; row++) {
    context.fillStyle = row === 0 ? color : '#40504a'
    context.globalAlpha = row === 0 ? .7 : .9
    context.fillRect(246, 82 + row * 30, 116 - (row % 2) * 22, 5)
  }
  context.globalAlpha = 1
  context.fillStyle = '#74867a'
  context.fillRect(16, 229, 42, 5)
  context.fillRect(64, 229, 63, 5)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function makeNameplateTexture(agent: Agent) {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 144
  const context = canvas.getContext('2d')!
  context.clearRect(0, 0, 512, 144)
  context.fillStyle = 'rgba(20,32,29,.95)'
  context.beginPath()
  context.roundRect(4, 4, 504, 136, 24)
  context.fill()
  context.strokeStyle = `${agent.color}b0`
  context.lineWidth = 5
  context.stroke()
  context.fillStyle = agent.color
  context.beginPath()
  context.arc(62, 72, 31, 0, Math.PI * 2)
  context.fill()
  context.font = '700 24px sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillStyle = '#17211d'
  context.fillText(agent.id, 62, 72)
  context.textAlign = 'left'
  context.fillStyle = '#f0f4ee'
  context.font = '700 37px sans-serif'
  context.fillText(agent.name, 112, 67)
  context.fillStyle = agent.color
  context.font = '600 18px sans-serif'
  context.font = '600 17px sans-serif'
  context.fillText(agent.role, 114, 101, 380)
  context.fillStyle = '#b6c5ba'
  context.font = '14px sans-serif'
  context.fillText(agent.state.toUpperCase(), 114, 124)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function Nameplate({ agent, onSelectAgent, suppressClick }: { agent: Agent; onSelectAgent: (id: string) => void; suppressClick: MutableRefObject<boolean> }) {
  const texture = useMemo(() => makeNameplateTexture(agent), [agent])
  useEffect(() => () => texture.dispose(), [texture])
  return <sprite position={[0, 2.23, .75]} scale={[1.45, .41, 1]} renderOrder={3} onClick={(event) => { event.stopPropagation(); if (!suppressClick.current) onSelectAgent(agent.id) }}>
    <spriteMaterial map={texture} transparent depthWrite={false} />
  </sprite>
}

function Employee({ agent, onSelectAgent, selected, suppressClick }: { agent: Agent; onSelectAgent: (id: string) => void; selected: boolean; suppressClick: MutableRefObject<boolean> }) {
  const head = useRef<THREE.Group>(null)
  const hands = useRef<THREE.Group>(null)
  const beacon = useRef<THREE.Mesh>(null)
  const index = Number(agent.id) - 1
  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime
    if (head.current) {
      head.current.rotation.y = Math.sin(t * .45 + index) * .08
      head.current.rotation.x = -.05 + Math.sin(t * .7 + index) * .035
    }
    if (hands.current) hands.current.position.y = Math.sin(t * (1.5 + index * .12) + index) * .008
    if (beacon.current) {
      const scale = selected ? 1 + Math.sin(t * 2) * .09 : 0
      beacon.current.scale.setScalar(THREE.MathUtils.damp(beacon.current.scale.x, scale, 8, delta))
    }
  })
  return <group onClick={(event) => { event.stopPropagation(); if (!suppressClick.current) onSelectAgent(agent.id) }}>
    {/* Chair stays still while the seated placeholder looks around and shifts its hands. */}
    <SoftBlock at={[0, .48, .94]} size={[.62, .12, .55]} color="#303638" />
    <group rotation={[-.06, 0, 0]}><SoftBlock at={[0, .9, 1.19]} size={[.56, .7, .1]} color="#42484a" /></group>
    <mesh position={[0, 1.29, 1.22]}><boxGeometry args={[.3, .17, .1]} /><meshStandardMaterial color="#34403e" /></mesh>
    <mesh position={[0, .25, .94]}><cylinderGeometry args={[.04, .06, .4, 8]} /><meshStandardMaterial color="#7e8883" metalness={.6} roughness={.3} /></mesh>
    {Array.from({ length: 5 }, (_, i) => <group key={i} position={[0, .09, .94]} rotation={[0, i * Math.PI * .4, 0]}>
      <mesh position={[0, 0, .17]}><boxGeometry args={[.045, .04, .34]} /><meshStandardMaterial color="#747a77" metalness={.65} roughness={.3} /></mesh>
      <mesh position={[0, -.025, .32]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[.045, .045, .065, 8]} /><meshStandardMaterial color="#292d2e" /></mesh>
    </group>)}
    {[-1, 1].map((side) => <group key={side}>
      <mesh position={[side * .3, .73, .95]}><boxGeometry args={[.07, .06, .38]} /><meshStandardMaterial color="#333f3b" /></mesh>
      <mesh position={[side * .16, .06, .94]} rotation={[0, side * .7, 0]}><boxGeometry args={[.055, .055, .64]} /><meshStandardMaterial color="#68736d" metalness={.5} /></mesh>
      <mesh position={[side * .12, .47, .65]} rotation={[Math.PI / 2, 0, 0]}><capsuleGeometry args={[.085, .32, 3, 8]} /><meshStandardMaterial color="#34434c" /></mesh>
      <mesh position={[side * .12, .27, .44]}><capsuleGeometry args={[.075, .28, 3, 8]} /><meshStandardMaterial color="#34434c" /></mesh>
      <mesh position={[side * .12, .1, .36]}><boxGeometry args={[.17, .12, .28]} /><meshStandardMaterial color={index % 2 ? '#e2dfd4' : '#27302f'} roughness={.75} /></mesh>
    </group>)}
    <mesh position={[0, .98, .79]} castShadow><capsuleGeometry args={[.205, .25, 4, 10]} /><meshStandardMaterial color={['#788d81', '#596574', '#a29480', '#75818e', '#8c766e', '#87969a', '#7a8269'][index]} roughness={.85} /></mesh>
    <mesh position={[0, 1.2, .74]}><cylinderGeometry args={[.07, .08, .13, 8]} /><meshStandardMaterial color={skinTones[index]} /></mesh>
    <group ref={head} position={[0, 1.4, .7]}>
      <mesh castShadow><sphereGeometry args={[.19, 14, 12]} /><meshStandardMaterial color={skinTones[index]} roughness={.82} /></mesh>
      <mesh position={[0, .035, .015]}><sphereGeometry args={[.195, 12, 8, 0, Math.PI * 2, 0, Math.PI * .51]} /><meshStandardMaterial color={hairColors[index]} roughness={.9} /></mesh>
      {[-1, 1].map(side => <mesh key={side} position={[side * .18, -.005, 0]} scale={[.65, 1, .65]}><sphereGeometry args={[.055, 8, 6]} /><meshStandardMaterial color={skinTones[index]} roughness={.85} /></mesh>)}
      <mesh position={[0, -.085, -.17]} scale={[1, .22, .4]}><sphereGeometry args={[.045, 8, 6]} /><meshStandardMaterial color="#9b6252" /></mesh>
      <mesh position={[0, -.025, -.187]}><sphereGeometry args={[.035, 8, 6]} /><meshStandardMaterial color={skinTones[index]} /></mesh>
      {[-1, 1].map((side) => <mesh key={side} position={[side * .065, .025, -.173]}><sphereGeometry args={[.02, 7, 6]} /><meshStandardMaterial color="#242e30" /></mesh>)}
      {(index === 2 || index === 5) && <mesh position={[0, -.04, .12]}><capsuleGeometry args={[.13, .19, 3, 8]} /><meshStandardMaterial color={hairColors[index]} /></mesh>}
      {index === 2 && <mesh position={[.12, .17, .07]}><sphereGeometry args={[.08, 8, 6]} /><meshStandardMaterial color={hairColors[index]} /></mesh>}
      {(index === 1 || index === 3) && [-1, 1].map((side) => <mesh key={side} position={[side * .065, .03, -.183]}><torusGeometry args={[.05, .009, 5, 12]} /><meshStandardMaterial color="#293435" metalness={.6} /></mesh>)}
      {index === 0 && <group><mesh rotation={[0, Math.PI / 2, 0]}><torusGeometry args={[.205, .018, 5, 16, Math.PI]} /><meshStandardMaterial color="#334b4d" /></mesh><mesh position={[-.19, 0, 0]}><boxGeometry args={[.06, .12, .1]} /><meshStandardMaterial color="#334b4d" /></mesh></group>}
      {index === 6 && <mesh position={[0, .14, -.06]}><boxGeometry args={[.34, .04, .28]} /><meshStandardMaterial color="#67774e" /></mesh>}
      {index === 4 && <mesh position={[0, .13, .03]}><sphereGeometry args={[.15, 8, 6]} /><meshStandardMaterial color={hairColors[index]} /></mesh>}
    </group>
    <group ref={hands}>
      {[-1, 1].map((side) => <group key={side}>
        <mesh position={[side * .23, 1, .65]} rotation={[.85, 0, side * .15]}><capsuleGeometry args={[.065, .3, 3, 7]} /><meshStandardMaterial color={agent.color} roughness={.8} /></mesh>
        <mesh position={[side * .22, .87, .41]} rotation={[Math.PI / 2, 0, 0]}><capsuleGeometry args={[.053, .16, 3, 6]} /><meshStandardMaterial color={skinTones[index]} /></mesh>
      </group>)}
    </group>
    <mesh position={[0, 1.03, .568]}><boxGeometry args={[.13, .25, .008]} /><meshStandardMaterial color="#64736b" roughness={.9} /></mesh>
    <mesh position={[.1, 1.09, .575]}><boxGeometry args={[.07, .035, .012]} /><meshStandardMaterial color="#e6e0d0" /></mesh>
    <mesh position={[0, 1.03, .578]}><boxGeometry args={[.04, .25, .02]} /><meshStandardMaterial color="#e2ece5" /></mesh>
    <mesh ref={beacon} position={[0, 1.9, .7]} rotation={[0, 0, Math.PI / 4]} scale={0}><octahedronGeometry args={[.1, 0]} /><meshBasicMaterial color={agent.color} /></mesh>
    <Nameplate agent={agent} onSelectAgent={onSelectAgent} suppressClick={suppressClick} />
  </group>
}

function Desk({ agent, position, rotation, selected, hovered, onHover, onSelectAgent, onInspectWorkstation, keyboard, suppressClick }: DeskProps) {
  const screenTexture = useMemo(() => makeScreenTexture(agent), [agent])
  const selectionRing = useRef<THREE.Mesh>(null)
  const selectedColor = useMemo(() => new THREE.Color(agent.color), [agent.color])
  const restingColor = useMemo(() => new THREE.Color('#7a9a87'), [])
  useEffect(() => () => screenTexture.dispose(), [screenTexture])
  useFrame((_, delta) => {
    const material = selectionRing.current?.material as THREE.MeshBasicMaterial | undefined
    if (!material) return
    material.opacity = THREE.MathUtils.damp(material.opacity, selected ? .72 : hovered ? .42 : .12, 10, delta)
    material.color.lerp(selected || hovered ? selectedColor : restingColor, 1 - Math.exp(-10 * delta))
  })
  return <group position={position} rotation={[0, rotation, 0]}
    onClick={(event) => { event.stopPropagation(); if (!suppressClick.current) onInspectWorkstation(agent.id) }}
    onPointerOver={() => { onHover(agent.id); document.body.style.cursor = 'pointer' }}
    onPointerOut={() => { onHover(null); document.body.style.cursor = '' }}>
    <mesh ref={selectionRing} rotation={[-Math.PI / 2, 0, 0]} position={[0, .025, 0]} receiveShadow>
      <ringGeometry args={[.72, .76, 32]} />
      <meshBasicMaterial color="#7a9a87" transparent opacity={.12} side={THREE.DoubleSide} />
    </mesh>
    <SoftBlock at={[0, .76, 0]} size={[1.52, .1, .82]} color="#e3e2dc" />
    <mesh position={[0, .817, 0]}><boxGeometry args={[1.49, .014, .79]} /><meshStandardMaterial color="#f2f1eb" roughness={.42} /></mesh>
    {[[-.65, -.31], [.65, -.31], [-.65, .31], [.65, .31]].map(([x, z], idx) => <mesh key={idx} position={[x, .38, z]} castShadow><boxGeometry args={[.07, .74, .07]} /><meshStandardMaterial color="#4c5a56" metalness={.48} roughness={.38} /></mesh>)}
    <mesh position={[0, .97, -.29]}><cylinderGeometry args={[.025, .025, .26, 8]} /><meshStandardMaterial color="#717a74" metalness={.6} /></mesh>
    <mesh position={[0, 1.09, -.29]} castShadow><boxGeometry args={[.61, .43, .075]} /><meshStandardMaterial color="#202a29" metalness={.42} roughness={.3} /></mesh>
    <mesh position={[0, 1.09, -.247]}><planeGeometry args={[.53, .35]} /><meshBasicMaterial map={screenTexture} toneMapped={false} /></mesh>
    <mesh position={[0, .85, -.28]}><boxGeometry args={[.18, .035, .12]} /><meshStandardMaterial color="#59635e" metalness={.6} roughness={.36} /></mesh>
    <mesh position={[0, .839, .12]}><boxGeometry args={[.58, .025, .22]} /><meshStandardMaterial map={keyboard} roughness={.76} /></mesh>
    <mesh position={[.45, .85, .1]} castShadow><boxGeometry args={[.12, .045, .16]} /><meshStandardMaterial color="#66716b" roughness={.55} /></mesh>
    <mesh position={[-.55, .86, -.11]}><cylinderGeometry args={[.09, .09, .07, 12]} /><meshStandardMaterial color="#455c56" roughness={.7} /></mesh>
    <mesh position={[-.55, .91, -.11]}><sphereGeometry args={[.12, 8, 6]} /><meshStandardMaterial color="#76937e" roughness={.9} /></mesh>
    <mesh position={[.57, .855, -.2]}><boxGeometry args={[.17, .035, .16]} /><meshStandardMaterial color="#c5c6bd" roughness={.8} /></mesh>
    <mesh position={[.57, .878, -.2]}><boxGeometry args={[.09, .012, .08]} /><meshStandardMaterial color={agent.color} emissive={agent.color} emissiveIntensity={.25} /></mesh>
    <mesh position={[.53, .35, -.07]}><boxGeometry args={[.25, .58, .4]} /><meshStandardMaterial color="#3c4c47" roughness={.7} /></mesh>
    <mesh position={[.53, .48, .14]}><boxGeometry args={[.12, .025, .01]} /><meshBasicMaterial color={agent.color} /></mesh>
    <Employee agent={agent} onSelectAgent={onSelectAgent} selected={selected} suppressClick={suppressClick} />
  </group>
}

type RoomTriggerProps = {
  name: string
  position: [number, number, number]
  size: [number, number]
  hovered: boolean
  onHover: (id: string | null) => void
  onInspect: () => void
  suppressClick: MutableRefObject<boolean>
}

function RoomTrigger({ name, position, size, hovered, onHover, onInspect, suppressClick }: RoomTriggerProps) {
  return <mesh position={position}
    onClick={(event) => { event.stopPropagation(); if (!suppressClick.current) onInspect() }}
    onPointerOver={() => { onHover(`room:${name}`); document.body.style.cursor = 'pointer' }}
    onPointerOut={() => { onHover(null); document.body.style.cursor = '' }}>
    <boxGeometry args={[size[0], .012, size[1]]} />
    <meshBasicMaterial color="#c5e0cd" transparent opacity={hovered ? .22 : .001} depthWrite={false} />
  </mesh>
}

const BASE_RADIUS = 35
function useOfficeCamera(gl: THREE.WebGLRenderer, view: Props['view'], onViewChange: Props['onViewChange'], zoom: number, onZoomChange: Props['onZoomChange'], resetToken: number, suppressClick: MutableRefObject<boolean>) {
  const orbit = useRef({ theta: .42, phi: .72, radius: BASE_RADIUS })
  const spherical = useMemo(() => new THREE.Spherical(), [])
  const focus = useMemo(() => new THREE.Vector3(0, .68, -.05), [])
  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    orbit.current.theta = .42
    orbit.current.phi = .72
    orbit.current.radius = BASE_RADIUS
  }, [resetToken])
  useEffect(() => {
    orbit.current.radius = BASE_RADIUS / zoom
  }, [zoom])

  useEffect(() => {
    const element = gl.domElement
    const pointers = new Map<number, { x: number; y: number }>()
    const last = { x: 0, y: 0, distance: 0 }
    const start = { x: 0, y: 0 }
    const priorTouchAction = element.style.touchAction
    const priorCursor = element.style.cursor
    let moved = false
    element.style.touchAction = 'none'
    element.style.cursor = 'grab'

    const distanceBetweenFirstTwo = () => {
      const pair = Array.from(pointers.values()).slice(0, 2)
      if (pair.length < 2) return 0
      return Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y)
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      try { element.setPointerCapture(event.pointerId) } catch { /* The pointer may already be captured by the browser. */ }
      if (pointers.size === 1) {
        start.x = last.x = event.clientX
        start.y = last.y = event.clientY
        moved = false
        suppressClick.current = false
        element.style.cursor = 'grabbing'
      } else {
        last.distance = distanceBetweenFirstTwo()
        moved = true
        suppressClick.current = true
      }
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size > 1) {
        event.preventDefault()
        const distance = distanceBetweenFirstTwo()
        if (last.distance > 0 && distance > 0) {
          orbit.current.radius = THREE.MathUtils.clamp(orbit.current.radius * (last.distance / distance), 18.42, 46.67)
          onZoomChange(Math.round(THREE.MathUtils.clamp(BASE_RADIUS / orbit.current.radius, .75, 1.9) * 100) / 100)
        }
        last.distance = distance
        moved = true
        suppressClick.current = true
        if (viewRef.current === 'top') onViewChange('isometric')
        return
      }

      const dx = event.clientX - last.x
      const dy = event.clientY - last.y
      if (!moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) {
        moved = true
        suppressClick.current = true
        if (viewRef.current === 'top') onViewChange('isometric')
      }
      if (moved) {
        orbit.current.theta -= dx * .006
        orbit.current.phi = THREE.MathUtils.clamp(orbit.current.phi - dy * .005, .3, 1.35)
      }
      last.x = event.clientX
      last.y = event.clientY
    }

    const finishPointer = (event: PointerEvent) => {
      pointers.delete(event.pointerId)
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
      if (pointers.size === 1) {
        const remaining = Array.from(pointers.values())[0]
        last.x = remaining.x
        last.y = remaining.y
        last.distance = 0
      } else if (pointers.size === 0) {
        element.style.cursor = 'grab'
        window.setTimeout(() => { suppressClick.current = false }, 80)
      }
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      orbit.current.radius = THREE.MathUtils.clamp(orbit.current.radius * Math.exp(event.deltaY * .001), 18.42, 46.67)
      onZoomChange(Math.round(THREE.MathUtils.clamp(BASE_RADIUS / orbit.current.radius, .75, 1.9) * 100) / 100)
    }
    const onContextMenu = (event: MouseEvent) => event.preventDefault()

    element.addEventListener('pointerdown', onPointerDown)
    element.addEventListener('pointermove', onPointerMove)
    element.addEventListener('pointerup', finishPointer)
    element.addEventListener('pointercancel', finishPointer)
    element.addEventListener('wheel', onWheel, { passive: false })
    element.addEventListener('contextmenu', onContextMenu)
    return () => {
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('pointerup', finishPointer)
      element.removeEventListener('pointercancel', finishPointer)
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('contextmenu', onContextMenu)
      element.style.touchAction = priorTouchAction
      element.style.cursor = priorCursor
    }
  }, [gl, onViewChange, onZoomChange, suppressClick])

  return { orbit, spherical, focus }
}

export function OfficeScene({ agents, selected, hovered, onHover, onSelectAgent, onInspectWorkstation, onInspectRoom, onClearSelection, view, onViewChange, zoom, onZoomChange, resetToken }: Props) {
  const { camera, gl, size } = useThree()
  const suppressClick = useRef(false)
  const { orbit, spherical, focus } = useOfficeCamera(gl, view, onViewChange, zoom, onZoomChange, resetToken, suppressClick)
  const floor = useMemo(() => makeFloorTexture(), [])
  const keyboard = useMemo(() => makeKeyboardTexture(), [])
  const brand = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 160
    const context = canvas.getContext('2d')!
    context.clearRect(0, 0, 512, 160)
    context.fillStyle = '#a8c7ac'
    context.font = '800 75px sans-serif'
    context.textBaseline = 'middle'
    context.fillText('nthn', 12, 72)
    context.fillStyle = '#e8eee6'
    context.font = '500 70px sans-serif'
    context.fillText('Entps', 180, 72)
    context.fillStyle = '#b6c8b7'
    context.font = '600 18px sans-serif'
    context.fillText('INTELLIGENT WORKSPACE  /  LOCAL PREVIEW', 16, 132)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }, [])
  useEffect(() => () => { floor.dispose(); keyboard.dispose(); brand.dispose() }, [floor, keyboard, brand])
  useEffect(() => { gl.shadowMap.type = THREE.PCFSoftShadowMap }, [gl])
  const positions = useMemo(() => agents.map(agent => {
    const station = DESKS.find(desk => desk.id === agent.id)
    if (!station) throw new Error(`Missing station for agent ${agent.id}`)
    return [station.x, 0, station.z] as [number, number, number]
  }), [agents])
  const roomFacts: Record<string, [string, string[]]> = {
    'Meeting room': ['North-west · eight seats', ['Shared conference table and presentation screen', 'Glazed door from the central walkway']],
    'Consultation': ['West · two-person conversation', ['Facing chairs and a small discussion table', 'Enclosed room with storage and a separate door']],
    'Private office': ['North-east · Jef', ['Dedicated desk, computer and ergonomic chair', 'Glazed room with storage and inward-open door']],
    'Product office': ['East · Sophia', ['Private workstation and storage', 'Door opens from the central circulation area']],
    'Security office': ['South-east · Victor', ['Dedicated security workstation', 'Perimeter shelving and cabinet storage']],
    'Work area': ['Central · four workstations', ['Daniel, Marcus, Emma and Oliver', 'Wide side aisles connect every room']],
    'Reception': ['South · entrance welcome area', ['Working reception counter, visitor sofa and coffee table', 'Direct path from the main entrance']],
    'Main entrance': ['South · 2.3 metre opening', ['Level threshold and an unobstructed central walkway', 'Reception and waiting area inside']],
  }
  const inspectRoom = (name: string) => {
    if (suppressClick.current) return
    const [subtitle, facts] = roomFacts[name] ?? ['Office area', []]
    onInspectRoom(name, subtitle, facts)
  }

  const cameraTarget = useMemo(() => new THREE.Vector3(), [])
  const focusTarget = useMemo(() => new THREE.Vector3(), [])
  useFrame((_, delta) => {
    const employeeIndex = agents.findIndex((agent) => agent.id === selected)
    if (employeeIndex >= 0) {
      const position = positions[employeeIndex]
      focusTarget.set(position[0], 1, position[2])
    } else focusTarget.set(0, .68, -.05)
    focus.lerp(focusTarget, 1 - Math.exp(-5 * delta))
    const phi = view === 'top' ? .035 : orbit.current.phi
    const fit = Math.max(1, 1.15 / (size.width / size.height))
    cameraTarget.setFromSpherical(spherical.set(orbit.current.radius * fit * (selected ? .48 : 1), phi, orbit.current.theta)).add(focus)
    camera.position.lerp(cameraTarget, 1 - Math.exp(-6 * delta))
    camera.lookAt(focus)
  })

  return <>
    <color attach="background" args={['#e4e0d8']} />
    <hemisphereLight args={['#fff7e7', '#796b58', 1.5]} />
    <directionalLight position={[3, 7, -9]} intensity={2.6} color="#fff3d9" castShadow shadow-mapSize={[1024, 1024]} shadow-camera-left={-12} shadow-camera-right={12} shadow-camera-top={11} shadow-camera-bottom={-11} shadow-camera-near={.5} shadow-camera-far={35} shadow-normalBias={.025} shadow-bias={-.0002} />
    <directionalLight position={[-5, 9, 7]} intensity={.65} color="#e4edf8" />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -.015, 0]} receiveShadow>
      <planeGeometry args={[OFFICE.width, OFFICE.depth]} />
      <meshStandardMaterial map={floor} bumpMap={floor} bumpScale={.018} roughness={.63} metalness={.02} />
    </mesh>
    <ContactShadows stations={positions} />
    <OfficeArchitecture inspect={inspectRoom} />
    <InteriorDetails brand={brand} />
    {[...ROOMS, { id: 'Work area', x: 0, z: -3.8, width: 9.6, depth: 9.1 }, { id: 'Reception', x: 0, z: 5.65, width: 9.6, depth: 5.1 }].map(room =>
      <RoomTrigger key={room.id} name={room.id} position={[room.x, -.005, room.z]} size={[room.width, room.depth]} hovered={hovered === 'room:' + room.id} onHover={onHover} onInspect={() => inspectRoom(room.id)} suppressClick={suppressClick} />
    )}
    {agents.map((agent, index) => <Desk key={agent.id} agent={agent} position={positions[index]} rotation={DESKS.find(desk => desk.id === agent.id)?.rotation ?? 0} selected={selected === agent.id} hovered={hovered === agent.id} onHover={onHover} onSelectAgent={onSelectAgent} onInspectWorkstation={onInspectWorkstation} keyboard={keyboard} suppressClick={suppressClick} />)}
    <mesh position={[0, -.025, 0]} onClick={(event) => { event.stopPropagation(); if (!suppressClick.current) onClearSelection() }}><boxGeometry args={[OFFICE.width - .2, .012, OFFICE.depth - .2]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>
  </>
}
