import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'

// Baked soft occlusion supports the single mobile shadow map, with one draw call.
export function ContactShadows({ stations }: { stations: [number, number, number][] }) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64
    const c = canvas.getContext('2d')!
    const fade = c.createRadialGradient(32, 32, 4, 32, 32, 32)
    fade.addColorStop(0, 'rgba(35,24,15,.36)'); fade.addColorStop(.5, 'rgba(35,24,15,.18)'); fade.addColorStop(1, 'rgba(35,24,15,0)')
    c.fillStyle = fade; c.fillRect(0, 0, 64, 64)
    return new THREE.CanvasTexture(canvas)
  }, [])
  const patches = useMemo(() => [
    ...stations.map(([x, , z]) => [x, z, 2.25, 2.5]),
    [-6.55, 3.4, 3.3, 5.4], [-1.7, 4.8, 2.7, 1.3], [-1.9, 1.6, 3, 1.5],
    [-6.3, -6.5, 3.3, 1.1], [-1.2, -6.5, 4.2, 1.1], [6.4, -6.5, 3.6, 1.1], [6.5, 6.4, 4.2, 1.1],
  ], [stations])
  useLayoutEffect(() => {
    const object = new THREE.Object3D()
    patches.forEach(([x, z, width, depth], index) => {
      object.position.set(x, -.008, z); object.rotation.set(-Math.PI / 2, 0, 0); object.scale.set(width, depth, 1); object.updateMatrix()
      mesh.current?.setMatrixAt(index, object.matrix)
    })
    if (mesh.current) { mesh.current.instanceMatrix.needsUpdate = true; mesh.current.computeBoundingSphere() }
  }, [patches])
  useEffect(() => () => texture.dispose(), [texture])
  return <instancedMesh ref={mesh} args={[undefined, undefined, patches.length]}>
    <planeGeometry /><meshBasicMaterial map={texture} transparent depthWrite={false} polygonOffset polygonOffsetFactor={-1} />
  </instancedMesh>
}
