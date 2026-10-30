import { useLayoutEffect, useRef } from 'react'
import * as THREE from 'three'

import { Block, SoftBlock } from './OfficeArchitecture'

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
export function InteriorDetails({ brand }: { brand: THREE.CanvasTexture }) {
  return <group>
    <SoftBlock at={[-6.55, .78, 3.4]} size={[1.8, .11, 3.55]} color="#e6e3da" />
    {[-1, 1].map(side => <Block key={side} at={[-6.55, .38, 3.4 + side * 1.1]} size={[1.3, .72, .12]} color="#656a63" />)}
    {[2.3, 3.5, 4.7].flatMap(z => [-1, 1].map(side => <ConferenceChair key={`${z}:${side}`} x={-6.55 + side * 1.35} z={z} angle={side * Math.PI / 2} />))}
    <ConferenceChair x={-6.55} z={1.12} angle={Math.PI} /><ConferenceChair x={-6.55} z={5.68} angle={0} />
    {[2.3, 4.5].map(z => <group key={z}><Block at={[-6.3, .855, z]} size={[.35, .015, .47]} color="#b0b8af" /><Block at={[-6.8, .855, z]} size={[.27, .018, .36]} color="#f7f4ea" /></group>)}
    <Block at={[-6.5, 1.8, .15]} size={[2.2, 1.05, .1]} color="#252e2d" />
    <mesh position={[-6.5, 1.8, .21]}><planeGeometry args={[1.9, .65]} /><meshBasicMaterial map={brand} transparent /></mesh>
    <group position={[-8.55, 0, -4.5]} rotation={[0, Math.PI / 2, 0]}><Bookcase position={[0, 0, 0]} /></group>
    <Cabinet x={-6.3} z={-6.5} width={2.8} /><Cabinet x={-1.2} z={-6.5} width={3.6} /><Cabinet x={6.4} z={-6.5} width={3} /><Cabinet x={6.5} z={6.4} width={3.6} />
    <group position={[8.55, 0, 3.9]} rotation={[0, -Math.PI / 2, 0]}><Bookcase position={[0, 0, 0]} /></group>
    <Block at={[-.94, 1.05, -2.91]} size={[3.04, .46, .045]} color="#9da99c" />
    <Block at={[-.94, .55, -2.91]} size={[2.9, .1, .18]} color="#747a70" />
    <SoftBlock at={[-1.7, .47, 4.8]} size={[1.9, .91, .7]} color="#b29b7e" />
    <SoftBlock at={[-1.7, .96, 4.8]} size={[2.02, .08, .8]} color="#eee9df" />
    <mesh position={[-1.7, .55, 5.16]}><planeGeometry args={[1.6, .46]} /><meshBasicMaterial map={brand} transparent /></mesh>
    <Block at={[-1.7, 1.18, 4.73]} size={[.53, .32, .055]} color="#343b3a" /><Block at={[-1.7, 1.02, 4.9]} size={[.48, .025, .17]} color="#555f5a" />
    <SoftBlock at={[-1.9, .35, 1.6]} size={[2.2, .45, .8]} color="#737e73" /><SoftBlock at={[-1.9, .73, 1.27]} size={[2.2, .65, .16]} color="#637063" />
    {[-2.85, -.95].map(x => <SoftBlock key={x} at={[x, .58, 1.6]} size={[.16, .5, .83]} color="#637063" />)}
    <SoftBlock at={[-1.9, .44, 2.8]} size={[1.2, .08, .62]} color="#c4b69e" /><Block at={[-1.9, .22, 2.8]} size={[.65, .4, .32]} color="#5c655c" /><Block at={[-1.9, .5, 2.8]} size={[.35, .025, .4]} color="#e8e2d4" />
    <SoftBlock at={[5.9, 1.17, 6.4]} size={[.65, .32, .46]} color="#deded5" /><Block at={[5.9, 1.35, 6.4]} size={[.5, .025, .35]} color="#8c9890" />
    <Block at={[7.5, 1.25, 6.4]} size={[.4, .54, .4]} color="#343d38" /><Block at={[7.5, 1.28, 6.61]} size={[.24, .28, .025]} color="#85867b" />
    {[[-8.3, -6.3], [-8.3, 6.2], [8.3, -6.2], [3.1, -6.3], [3.1, 5.7], [8.25, 1.9]].map(([x, z]) => <Plant key={`${x}:${z}`} x={x} z={z} />)}
  </group>
}
