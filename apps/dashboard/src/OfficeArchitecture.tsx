import { useEffect, useMemo } from 'react'
import * as THREE from 'three'

type Vec3 = [number, number, number]
const cube = new THREE.BoxGeometry()
const palette = new Map<string, THREE.MeshStandardMaterial>()
export function Block({ at, size, color = '#e3ddd0', shadow = true }: { at: Vec3; size: Vec3; color?: string; shadow?: boolean }) {
  if (!palette.has(color)) palette.set(color, new THREE.MeshStandardMaterial({ color, roughness: .68 }))
  return <mesh position={at} scale={size} geometry={cube} material={palette.get(color)} castShadow={shadow} receiveShadow dispose={null} />
}

// One beveled unit solid reused for upholstery and finished furniture edges.
const outline = new THREE.Shape()
outline.moveTo(-.42, -.5); outline.lineTo(.42, -.5)
outline.quadraticCurveTo(.5, -.5, .5, -.42); outline.lineTo(.5, .42)
outline.quadraticCurveTo(.5, .5, .42, .5); outline.lineTo(-.42, .5)
outline.quadraticCurveTo(-.5, .5, -.5, .42); outline.lineTo(-.5, -.42)
outline.quadraticCurveTo(-.5, -.5, -.42, -.5)
const rounded = new THREE.ExtrudeGeometry(outline, { depth: .92, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: .025, bevelThickness: .04, curveSegments: 3 })
rounded.translate(0, 0, -.46)
export function SoftBlock({ at, size, color }: { at: Vec3; size: Vec3; color: string }) {
  if (!palette.has(color)) palette.set(color, new THREE.MeshStandardMaterial({ color, roughness: .64 }))
  return <mesh geometry={rounded} material={palette.get(color)} position={at} scale={size} castShadow receiveShadow dispose={null} />
}

export function Sign({ text, at, rotation = [0, 0, 0], width = 1.7 }: { text: string; at: Vec3; rotation?: Vec3; width?: number }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96
    const c = canvas.getContext('2d')!
    c.fillStyle = '#f0ece2'; c.fillRect(0, 0, 512, 96)
    c.fillStyle = '#484b43'; c.font = '500 32px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'
    c.fillText(text, 256, 48, 470)
    const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace; return map
  }, [text])
  useEffect(() => () => texture.dispose(), [texture])
  return <mesh position={at} rotation={rotation}><planeGeometry args={[width, width * .1875]} /><meshBasicMaterial map={texture} side={THREE.DoubleSide} /></mesh>
}

function Wall({ at, size }: { at: Vec3; size: Vec3 }) {
  return <group><Block at={at} size={size} /><Block at={[at[0], .07, at[2]]} size={[size[0] + .025, .14, size[2] + .025]} color="#a49782" /></group>
}
function GlassRun({ x, start, end }: { x: number; start: number; end: number }) {
  const length = end - start
  return <group>
    <Wall at={[x, .28, (start + end) / 2]} size={[.18, .56, length]} />
    <mesh position={[x, 1.59, (start + end) / 2]}><boxGeometry args={[.035, 2.02, length]} /><meshStandardMaterial color="#a9c7ca" transparent opacity={.16} roughness={.14} depthWrite={false} /></mesh>
    {[start, end].map(z => <Block key={z} at={[x, 1.32, z]} size={[.085, 2.64, .065]} color="#625f54" />)}
    <Block at={[x, 2.65, (start + end) / 2]} size={[.1, .1, length]} color="#625f54" />
  </group>
}
function Door({ x, z, inward = 1, onInspect }: { x: number; z: number; inward?: number; onInspect: () => void }) {
  return <group>
    <Block at={[x, 2.6, z - .6]} size={[.2, .2, 1.2]} />
    <group position={[x, 0, z]} rotation={[0, inward * 1.35, 0]} onClick={event => { event.stopPropagation(); onInspect() }}>
      <SoftBlock at={[0, 1.18, -.57]} size={[.06, 2.36, 1.14]} color="#bcab90" />
      <mesh position={[.035, 1.55, -.57]} rotation={[0, Math.PI / 2, 0]}><planeGeometry args={[.76, .84]} /><meshStandardMaterial color="#abc7c7" transparent opacity={.45} side={THREE.DoubleSide} /></mesh>
      <Block at={[.065, 1.05, -.94]} size={[.1, .045, .2]} color="#62675f" />
    </group>
    <Block at={[x, .012, z - .6]} size={[.22, .02, 1.2]} color="#bba98b" />
  </group>
}

export function OfficeArchitecture({ inspect }: { inspect: (name: string) => void }) {
  return <group>
    <Block at={[0, -.23, 0]} size={[18.25, .42, 14.25]} color="#665442" />
    {/* Rear wall: full-depth masonry piers, broad windows, sills and mullions. */}
    <Wall at={[0, .4, -7]} size={[18.2, .8, .22]} />
    <Wall at={[0, 2.78, -7]} size={[18.2, .24, .22]} />
    {[-9, -4, 1, 4, 9].map(x => <Wall key={x} at={[x, 1.7, -7]} size={[.22, 2.1, .24]} />)}
    {[[-6.5, 4.7], [-1.5, 4.7], [2.5, 2.7], [6.5, 4.7]].map(([x, width]) => <group key={x}>
      <mesh position={[x, 1.72, -7]}><boxGeometry args={[width, 1.84, .035]} /><meshStandardMaterial color="#b4d5df" transparent opacity={.25} roughness={.12} depthWrite={false} /></mesh>
      <Block at={[x, 1.72, -6.98]} size={[.045, 1.84, .07]} color="#77796e" />
      <Block at={[x, .83, -6.91]} size={[width, .07, .35]} color="#f0ebdf" />
    </group>)}
    <Wall at={[-9, 1.4, 0]} size={[.22, 2.8, 14]} />
    {/* Camera-facing perimeter is cut down, as in an architectural model. */}
    <Wall at={[9, .34, 0]} size={[.22, .68, 14]} />
    <Wall at={[-4, .34, 7]} size={[10, .68, .22]} />
    <Wall at={[6, .34, 7]} size={[6, .68, .22]} />
    <Wall at={[-6.5, 1.3, 0]} size={[5, 2.6, .2]} />
    <GlassRun x={-4} start={-7} end={-2.6} /><GlassRun x={-4} start={-1.4} end={0} />
    <GlassRun x={-4} start={0} end={.2} /><GlassRun x={-4} start={1.4} end={7} />
    <Door x={-4} z={-1.4} inward={1} onInspect={() => inspect('Private office')} />
    <Door x={-4} z={1.4} inward={1} onInspect={() => inspect('Meeting room')} />
    <GlassRun x={4} start={-7} end={-2} /><GlassRun x={4} start={-.8} end={0} />
    <Door x={4} z={-.8} inward={-1} onInspect={() => inspect('Product office')} />
    <Wall at={[6.5, .62, 0]} size={[5, 1.24, .18]} />
    <Wall at={[6.5, .62, 1.1]} size={[5, 1.24, .18]} />
    {/* Entry opening is two meters wide and feeds the continuous central aisle. */}
    <group position={[3, 0, 7]} rotation={[0, -1.25, 0]} onClick={e => { e.stopPropagation(); inspect('Main entrance') }}>
      <SoftBlock at={[-.95, .62, 0]} size={[1.9, 1.24, .06]} color="#9dada9" />
      <Block at={[-1.7, .95, -.06]} size={[.06, .3, .1]} color="#525c58" />
    </group>
    <Sign text="MAIN ENTRANCE" at={[2, .015, 6.3]} rotation={[-Math.PI / 2, 0, 0]} width={1.65} />
    <Sign text="01 / PRIVATE OFFICE" at={[-6.5, 2.15, .115]} width={2} />
    <Sign text="02 / CONFERENCE" at={[-6.5, .018, 5.9]} rotation={[-Math.PI / 2, 0, 0]} width={2} />
    <Sign text="03 / PRODUCT OFFICE" at={[6.5, 1.02, .11]} width={2.2} />
    <Sign text="04 / PLATFORM LAB" at={[6.5, 1.02, 1.205]} width={2} />
    {/* Thin suspended linear luminaires leave the roof open for inspection. */}
    {[[-6.5, -3.5], [-6.5, 3.5], [-1, -3], [6.4, -3.5], [6.4, 3.7], [-.5, 4]].map(([x, z]) => <group key={`${x}:${z}`}>
      <Block at={[x, 2.95, z]} size={[1.8, .065, .16]} color="#b9b7aa" shadow={false} />
      <mesh position={[x, 2.91, z]} rotation={[Math.PI / 2, 0, 0]}><planeGeometry args={[1.65, .12]} /><meshBasicMaterial color="#fff3ce" side={THREE.DoubleSide} /></mesh>
    </group>)}
  </group>
}
