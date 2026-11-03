import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { OFFICE, ROOMS } from './officeLayout'

type Vec3 = [number, number, number]
const cube = new THREE.BoxGeometry()
const palette = new Map<string, THREE.MeshStandardMaterial>()
function material(color: string) {
  if (!palette.has(color)) palette.set(color, new THREE.MeshStandardMaterial({ color, roughness: .67 }))
  return palette.get(color)!
}
export function Block({ at, size, color = '#e9e5db', shadow = true }: { at: Vec3; size: Vec3; color?: string; shadow?: boolean }) {
  return <mesh position={at} scale={size} geometry={cube} material={material(color)} castShadow={shadow} receiveShadow dispose={null} />
}
const outline = new THREE.Shape()
outline.moveTo(-.44, -.5); outline.lineTo(.44, -.5)
outline.quadraticCurveTo(.5, -.5, .5, -.44); outline.lineTo(.5, .44)
outline.quadraticCurveTo(.5, .5, .44, .5); outline.lineTo(-.44, .5)
outline.quadraticCurveTo(-.5, .5, -.5, .44); outline.lineTo(-.5, -.44)
outline.quadraticCurveTo(-.5, -.5, -.44, -.5)
const rounded = new THREE.ExtrudeGeometry(outline, { depth: .92, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: .025, bevelThickness: .035, curveSegments: 3 })
rounded.translate(0, 0, -.46)
export function SoftBlock({ at, size, color }: { at: Vec3; size: Vec3; color: string }) {
  return <mesh geometry={rounded} material={material(color)} position={at} scale={size} castShadow receiveShadow dispose={null} />
}
export function Sign({ text, at, rotation = [0, 0, 0], width = 1.7, dark = false }: { text: string; at: Vec3; rotation?: Vec3; width?: number; dark?: boolean }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96
    const c = canvas.getContext('2d')!
    c.fillStyle = dark ? '#273b34' : '#eee9df'; c.fillRect(0, 0, 512, 96)
    c.fillStyle = dark ? '#e4e9df' : '#4f6157'; c.font = '600 30px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'
    c.fillText(text, 256, 48, 470)
    const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace; return map
  }, [text, dark])
  useEffect(() => () => texture.dispose(), [texture])
  return <mesh position={at} rotation={rotation}><planeGeometry args={[width, width * .1875]} /><meshBasicMaterial map={texture} side={THREE.DoubleSide} /></mesh>
}
function Wall({ at, size, low = false }: { at: Vec3; size: Vec3; low?: boolean }) {
  return <group>
    <Block at={at} size={size} color={low ? '#d5d3c9' : '#e9e5db'} />
    <Block at={[at[0], .09, at[2]]} size={[size[0] + .02, .18, size[2] + .02]} color="#9c9e8c" />
    {low && <Block at={[at[0], at[1] + size[1] / 2, at[2]]} size={[size[0] + .015, .055, size[2] + .015]} color="#b5ad99" />}
  </group>
}
function GlassRun({ x, start, end }: { x: number; start: number; end: number }) {
  const length = end - start
  if (length < .08) return null
  return <group>
    <Wall at={[x, .32, (start + end) / 2]} size={[.18, .64, length]} low />
    <mesh position={[x, 1.63, (start + end) / 2]}><boxGeometry args={[.035, 1.98, length]} /><meshStandardMaterial color="#b8d7d5" transparent opacity={.22} roughness={.14} metalness={.06} depthWrite={false} /></mesh>
    {[start, end].map(z => <Block key={z} at={[x, 1.63, z]} size={[.07, 2.62, .06]} color="#6a827b" shadow={false} />)}
    <Block at={[x, 2.64, (start + end) / 2]} size={[.09, .09, length]} color="#6a827b" shadow={false} />
  </group>
}
function Divider({ x, z }: { x: number; z: number }) {
  return <group>
    <Wall at={[x, .7, z]} size={[6, 1.4, .2]} low />
    <mesh position={[x, 2.01, z]}><boxGeometry args={[5.85, 1.18, .045]} /><meshStandardMaterial color="#b6cbc4" transparent opacity={.35} roughness={.23} depthWrite={false} /></mesh>
    {[-3, 0, 3].map(offset => <Block key={offset} at={[x + offset, 2.01, z]} size={[.07, 1.2, .07]} color="#6a827b" shadow={false} />)}
    <Block at={[x, 2.61, z]} size={[6, .08, .1]} color="#6a827b" shadow={false} />
  </group>
}
function Door({ x, z, side, onInspect }: { x: number; z: number; side: 'west' | 'east'; onInspect: () => void }) {
  const hingeZ = z - OFFICE.doorWidth / 2
  const angle = side === 'east' ? 1.45 : -1.45
  return <group>
    {[hingeZ, z + OFFICE.doorWidth / 2].map(p => <Block key={p} at={[x, 1.32, p]} size={[.14, 2.64, .09]} color="#637b74" />)}
    <Block at={[x, 2.66, z]} size={[.16, .1, OFFICE.doorWidth + .1]} color="#637b74" />
    <group position={[x, 0, hingeZ]} rotation={[0, angle, 0]} onClick={e => { e.stopPropagation(); onInspect() }}>
      <SoftBlock at={[0, 1.16, .56]} size={[.055, 2.32, 1.12]} color="#8aa29a" />
      <mesh position={[side === 'east' ? .037 : -.037, 1.65, .56]} rotation={[0, Math.PI / 2, 0]}><planeGeometry args={[.82, .82]} /><meshStandardMaterial color="#bcd5d0" transparent opacity={.6} side={THREE.DoubleSide} /></mesh>
      <Block at={[side === 'east' ? -.07 : .07, 1.02, .87]} size={[.12, .045, .18]} color="#d8d2be" />
    </group>
    <Block at={[x, .012, z]} size={[.22, .024, OFFICE.doorWidth]} color="#b5ad99" shadow={false} />
  </group>
}
function Partition({ x, start, end, doorZ, side, label, inspect }: { x: number; start: number; end: number; doorZ: number; side: 'west' | 'east'; label: string; inspect: (name: string) => void }) {
  return <group>
    <GlassRun x={x} start={start} end={doorZ - OFFICE.doorWidth / 2} />
    <GlassRun x={x} start={doorZ + OFFICE.doorWidth / 2} end={end} />
    <Door x={x} z={doorZ} side={side} onInspect={() => inspect(label)} />
  </group>
}
export function OfficeArchitecture({ inspect }: { inspect: (name: string) => void }) {
  return <group>
    <Block at={[0, -.24, 0]} size={[OFFICE.width + .25, .46, OFFICE.depth + .25]} color="#5b5348" />
    {/* Rear glazing is divided into bays with a continuous sill and structural piers. */}
    <Wall at={[0, .36, -8.5]} size={[22, .72, .22]} />
    <Wall at={[0, 2.72, -8.5]} size={[22, .26, .22]} />
    {[-11, -5, 0, 5, 11].map(x => <Wall key={x} at={[x, 1.7, -8.5]} size={[.22, 2.12, .24]} />)}
    {[[-8, 5.8], [-2.5, 4.8], [2.5, 4.8], [8, 5.8]].map(([x, width]) => <group key={x}>
      <mesh position={[x, 1.68, -8.5]}><boxGeometry args={[width, 1.9, .035]} /><meshStandardMaterial color="#c7dfe0" transparent opacity={.25} roughness={.13} depthWrite={false} /></mesh>
      <Block at={[x, .76, -8.37]} size={[width, .06, .35]} color="#f1ede4" shadow={false} />
      <Block at={[x, 1.7, -8.48]} size={[.05, 1.9, .065]} color="#6a827b" shadow={false} />
    </group>)}
    <Wall at={[-11, 1.4, 0]} size={[.22, 2.8, 17]} />
    <Wall at={[11, .36, 0]} size={[.22, .72, 17]} low />
    <Wall at={[-6.15, .36, 8.5]} size={[9.7, .72, .22]} low />
    <Wall at={[6.15, .36, 8.5]} size={[9.7, .72, .22]} low />
    {/* A genuine 2.3 m entrance, aligned with the central circulation route. */}
    <group onClick={e => { e.stopPropagation(); inspect('Main entrance') }}>
      {[-1.25, 1.25].map(x => <Block key={x} at={[x, 1.35, 8.5]} size={[.14, 2.7, .16]} color="#607a70" />)}
      <Block at={[0, 2.7, 8.5]} size={[2.6, .12, .18]} color="#607a70" />
      <Block at={[0, .015, 8.5]} size={[2.3, .03, .32]} color="#c5b69a" shadow={false} />
      <Sign text="WELCOME TO NTHN ENTERPRISES" at={[0, 2.72, 8.37]} width={2.35} dark />
    </group>
    {/* Glazed fronts let the whole plan remain legible from an isometric camera. */}
    {ROOMS.map(room => <Partition key={room.id} x={room.door[0]} start={room.z - room.depth / 2} end={room.z + room.depth / 2} doorZ={room.door[1]} side={room.side} label={room.id} inspect={inspect} />)}
    <Divider x={-8} z={-1.85} />
    <Divider x={8} z={-2.85} />
    <Divider x={8} z={2.05} />
    <Sign text="01  /  MEETING" at={[-8, .02, -2.25]} rotation={[-Math.PI / 2, 0, 0]} width={2.15} />
    <Sign text="02  /  CONSULTATION" at={[-8, .02, 2.45]} rotation={[-Math.PI / 2, 0, 0]} width={2.35} />
    <Sign text="03  /  WORKSTATIONS" at={[0, .02, -7.7]} rotation={[-Math.PI / 2, 0, 0]} width={2.5} />
    <Sign text="04  /  RECEPTION" at={[2.5, .02, 7.9]} rotation={[-Math.PI / 2, 0, 0]} width={2.2} />
    {ROOMS.slice(2).map(room => <Sign key={room.id} text={room.label} at={[8, .02, room.z + room.depth / 2 - .45]} rotation={[-Math.PI / 2, 0, 0]} width={2.3} />)}
    {[[0, -5.6], [0, -1.8], [-8, -5.2], [-8, .5], [8, -5.6], [8, -.45], [8, 5.2], [0, 5.2]].map(([x, z]) => <group key={`${x}:${z}`}>
      <Block at={[x, 2.92, z]} size={[1.8, .055, .16]} color="#aaa99d" shadow={false} />
      <mesh position={[x, 2.885, z]} rotation={[Math.PI / 2, 0, 0]}><planeGeometry args={[1.68, .12]} /><meshBasicMaterial color="#fff2d6" side={THREE.DoubleSide} /></mesh>
    </group>)}
  </group>
}
