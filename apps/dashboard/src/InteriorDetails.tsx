import { useLayoutEffect, useRef } from 'react'
import * as THREE from 'three'

import { Block, SoftBlock } from './OfficeArchitecture'
import { FURNITURE } from './officeLayout'

function Bookcase({ position }: { position: [number, number, number] }) {
  const books = useRef<THREE.InstancedMesh>(null)
  useLayoutEffect(() => {
    const matrix = new THREE.Object3D()
    for (let i = 0; i < 32; i++) {
      const row = Math.floor(i / 8)
      matrix.position.set(-.77 + (i % 8) * .21, .42 + row * .47, .03)
      matrix.scale.set(.12 + (i % 3) * .02, .22 + (i % 4) * .035, .26)
      matrix.rotation.z = i % 7 === 0 ? .12 : 0
      matrix.updateMatrix()
      books.current?.setMatrixAt(i, matrix.matrix)
      books.current?.setColorAt(i, new THREE.Color(['#c6ba9f', '#617c76', '#a47759', '#7f8b99'][i % 4]))
    }
    if (books.current) {
      books.current.instanceMatrix.needsUpdate = true
      if (books.current.instanceColor) books.current.instanceColor.needsUpdate = true
    }
  }, [])
  return <group position={position}>
    <Block at={[0, 1.15, -.19]} size={[2.05, 2.3, .07]} color="#454e46" />
    {[-1, 1].map((x) => <Block key={x} at={[x, 1.15, 0]} size={[.07, 2.3, .48]} color="#ad9373" />)}
    {[.12, .59, 1.06, 1.53, 2.22].map((y) => <Block key={y} at={[0, y, 0]} size={[2.05, .07, .5]} color="#ad9373" />)}
    <instancedMesh ref={books} args={[undefined, undefined, 32]}><boxGeometry /><meshStandardMaterial roughness={.85} /></instancedMesh>
  </group>
}

function Plant({ x, z }: { x: number; z: number }) {
  return <group position={[x, 0, z]}>
    <mesh position={[0, .3, 0]} castShadow><cylinderGeometry args={[.26, .2, .6, 12]} /><meshStandardMaterial color="#c3b9a4" roughness={.88} /></mesh>
    <mesh position={[0, .61, 0]}><cylinderGeometry args={[.24, .24, .025, 12]} /><meshStandardMaterial color="#403628" /></mesh>
    {Array.from({ length: 7 }, (_, i) => <group key={i} rotation={[0, i * 2.4, 0]}>
      <mesh position={[.13, .91, 0]} rotation={[0, 0, -.22]}><cylinderGeometry args={[.012, .018, .8, 5]} /><meshStandardMaterial color="#54674a" /></mesh>
      <mesh position={[.2, 1.16 + (i % 3) * .13, 0]} rotation={[0, 0, -.65]} scale={[.16, .4, .065]}><sphereGeometry args={[1, 8, 6]} /><meshStandardMaterial color={i % 2 ? '#667c4c' : '#435e3e'} roughness={.9} /></mesh>
    </group>)}
  </group>
}
function Cabinet({ x, z, width = 2 }: { x: number; z: number; width?: number }) {
  return <group position={[x, 0, z]}>
    <Block at={[0, .47, 0]} size={[width, .9, .55]} color="#d8d5ca" />
    <SoftBlock at={[0, .96, 0]} size={[width + .06, .06, .6]} color="#a28b6d" />
    {[-1, 1].map(side => <group key={side}>
      <Block at={[side * width / 4, .49, .286]} size={[width / 2 - .025, .83, .025]} color="#eeebe2" />
      <Block at={[side * .12, .6, .31]} size={[.025, .18, .035]} color="#60675f" />
    </group>)}
  </group>
}
function ConferenceChair({ x, z, angle }: { x: number; z: number; angle: number }) {
  return <group position={[x, 0, z]} rotation={[0, angle, 0]}>
    <SoftBlock at={[0, .48, 0]} size={[.53, .12, .52]} color="#42494a" />
    <SoftBlock at={[0, .85, .24]} size={[.53, .65, .09]} color="#505657" />
    {[-1, 1].map(side => <group key={side}>
      <Block at={[side * .3, .7, .02]} size={[.055, .06, .4]} color="#555a57" />
      {[-.17, .17].map(z => <Block key={z} at={[side * .22, .24, z]} size={[.035, .44, .035]} color="#8f938b" />)}
    </group>)}
  </group>
}
function Rug({ x, z, width, depth, color }: { x: number; z: number; width: number; depth: number; color: string }) {
  return <group>
    <mesh position={[x, -.012, z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow><planeGeometry args={[width, depth]} /><meshStandardMaterial color="#b6ac99" roughness={1} /></mesh>
    <mesh position={[x, -.01, z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow><planeGeometry args={[width - .08, depth - .08]} /><meshStandardMaterial color={color} roughness={1} /></mesh>
  </group>
}
const fixture = (id: string) => {
  const item = FURNITURE.find(part => part.id === id)
  if (!item) throw new Error(`Missing office fixture: ${id}`)
  return item
}

export function InteriorDetails({ brand }: { brand: THREE.CanvasTexture }) {
  const meeting = fixture('meeting-table')
  const consult = fixture('consult-table')
  const reception = fixture('reception')
  const sofa = fixture('waiting-sofa')
  const coffee = fixture('waiting-table')
  return <group>
    <Rug x={-8} z={-5.15} width={4.5} depth={5.2} color="#6a8179" />
    <Rug x={-8} z={.55} width={3.5} depth={2.4} color="#a99c84" />
    <Rug x={-3.3} z={5.55} width={3.1} depth={2.4} color="#819488" />
    <SoftBlock at={[meeting.x, .76, meeting.z]} size={[meeting.width, .12, meeting.depth]} color="#d9d0bd" />
    <Block at={[meeting.x, .39, meeting.z - 1.1]} size={[1.25, .72, .12]} color="#6f766b" />
    <Block at={[meeting.x, .39, meeting.z + 1.1]} size={[1.25, .72, .12]} color="#6f766b" />
    {[-6.25, -5.15, -4.05].flatMap(z => [-9.35, -6.65].map(x => <ConferenceChair key={`${x}:${z}`} x={x} z={z} angle={x < -8 ? -Math.PI / 2 : Math.PI / 2} />))}
    <ConferenceChair x={-8} z={-7.35} angle={Math.PI} />
    <ConferenceChair x={-8} z={-2.95} angle={0} />
    {[[-8.35, -5.7], [-7.65, -4.55]].map(([x, z]) => <group key={z}>
      <Block at={[x, .835, z]} size={[.42, .02, .29]} color="#f4f0e7" />
      <Block at={[x, .85, z]} size={[.15, .015, .1]} color="#a5b5aa" />
    </group>)}
    <Block at={[-8, 1.87, -8.18]} size={[2.2, 1.12, .1]} color="#293e38" />
    <mesh position={[-8, 1.87, -8.12]}><planeGeometry args={[1.96, .68]} /><meshBasicMaterial map={brand} transparent /></mesh>

    <SoftBlock at={[consult.x, .49, consult.z]} size={[consult.width, .06, consult.depth]} color="#ae9275" />
    <Block at={[consult.x, .24, consult.z]} size={[.2, .46, .2]} color="#525e55" />
    <ConferenceChair x={-9.2} z={.55} angle={-Math.PI / 2} />
    <ConferenceChair x={-6.8} z={.55} angle={Math.PI / 2} />
    <group position={[-9.65, 0, 2.45]} rotation={[0, Math.PI, 0]}><Bookcase position={[0, 0, 0]} /></group>
    <Block at={[-8, 1.75, -1.69]} size={[2.4, .92, .065]} color="#e9e4d7" />
    <Block at={[-8, 2.23, -1.68]} size={[2.55, .065, .09]} color="#a79778" />
    <Block at={[-7.55, .56, .55]} size={[.14, .08, .14]} color="#d9ded6" />

    <SoftBlock at={[reception.x, .48, reception.z]} size={[reception.width, .96, reception.depth]} color="#a89170" />
    <SoftBlock at={[reception.x, 1.0, reception.z]} size={[reception.width + .07, .085, reception.depth + .08]} color="#e5dfd0" />
    <Block at={[reception.x, .62, reception.z + reception.depth / 2 + .015]} size={[2.15, .49, .035]} color="#d2c3a7" />
    <mesh position={[reception.x, .61, reception.z + reception.depth / 2 + .039]}><planeGeometry args={[1.8, .48]} /><meshBasicMaterial map={brand} transparent /></mesh>
    <Block at={[reception.x, 1.24, reception.z - .13]} size={[.53, .35, .05]} color="#293b38" />
    <Block at={[reception.x, 1.05, reception.z - .04]} size={[.5, .025, .18]} color="#66746b" />
    <ConferenceChair x={2.45} z={5.1} angle={Math.PI} />
    <SoftBlock at={[sofa.x, .34, sofa.z]} size={[sofa.width, .45, sofa.depth]} color="#657c70" />
    <SoftBlock at={[sofa.x, .72, sofa.z - .31]} size={[sofa.width, .66, .15]} color="#5a7066" />
    {[-4.18, -2.42].map(x => <SoftBlock key={x} at={[x, .55, sofa.z]} size={[.16, .48, .77]} color="#566a60" />)}
    <SoftBlock at={[coffee.x, .42, coffee.z]} size={[coffee.width, .075, coffee.depth]} color="#d5c3a2" />
    <Block at={[coffee.x, .2, coffee.z]} size={[.38, .4, .28]} color="#6a776c" />
    <Block at={[coffee.x - .2, .47, coffee.z]} size={[.25, .015, .34]} color="#f1ede3" />

    <Cabinet x={8} z={-7.84} width={2.8} />
    <Cabinet x={8} z={-2.34} width={2.65} />
    <Cabinet x={8.1} z={2.66} width={2.8} />
    <Cabinet x={0} z={-7.9} width={2.8} />
    <Cabinet x={-8} z={-1.25} width={2.2} />
    <group position={[10.45, 0, 6.55]} rotation={[0, -Math.PI / 2, 0]}><Bookcase position={[0, 0, 0]} /></group>
    <Block at={[9.35, .78, 7.75]} size={[.85, 1.5, .55]} color="#53645b" />
    <Block at={[9.35, 1.53, 7.75]} size={[.84, .035, .55]} color="#a6ae9e" />
    <Block at={[9.35, .75, 7.45]} size={[.56, .35, .02]} color="#364b45" />
    <Block at={[0, .96, -4.25]} size={[.08, .52, 2.1]} color="#8ba79a" />
    <Block at={[0, .52, -4.25]} size={[.07, .08, 2.1]} color="#6b7c70" />
    {[[-10.15, -7.75], [-4.15, 7.45], [4.05, 7.4], [10.25, -7.65], [10.2, 1.35]].map(([x, z]) => <Plant key={`${x}:${z}`} x={x} z={z} />)}
  </group>
}
