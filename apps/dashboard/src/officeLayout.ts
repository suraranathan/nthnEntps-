// Scene units are metres. All plan geometry and furniture origins use this plan.
export type Point = readonly [number, number]
export type Rect = { x: number; z: number; width: number; depth: number }
export type Room = Rect & { id: string; label: string; door: Point; side: 'west' | 'east' }
export type Footprint = Rect & { id: string; room: string }

export const OFFICE = { width: 22, depth: 17, wall: .2, wallHeight: 2.8, doorWidth: 1.25 } as const

export const ROOMS: readonly Room[] = [
  { id: 'Meeting room', label: 'MEETING', x: -8, z: -5.15, width: 5.8, depth: 6.4, door: [-5, -4.55], side: 'west' },
  { id: 'Consultation', label: 'CONSULTATION', x: -8, z: .55, width: 5.8, depth: 4.65, door: [-5, .15], side: 'west' },
  { id: 'Private office', label: 'JEF / PRIVATE', x: 8, z: -5.65, width: 5.8, depth: 5.4, door: [5, -5], side: 'east' },
  { id: 'Product office', label: 'SOPHIA / PRODUCT', x: 8, z: -.45, width: 5.8, depth: 4.7, door: [5, -.45], side: 'east' },
  { id: 'Security office', label: 'VICTOR / SECURITY', x: 8, z: 5.2, width: 5.8, depth: 6.1, door: [5, 4.35], side: 'east' },
] as const

export const DESKS: readonly { id: string; x: number; z: number; rotation: number }[] = [
  { id: '01', x: 8, z: -5.9, rotation: 0 },
  { id: '02', x: 7.9, z: 4.45, rotation: 0 },
  { id: '03', x: 8, z: -.9, rotation: 0 },
  { id: '04', x: -2.35, z: -5.95, rotation: 0 },
  { id: '05', x: 2.35, z: -5.95, rotation: 0 },
  { id: '06', x: -2.35, z: -2.55, rotation: 0 },
  { id: '07', x: 2.35, z: -2.55, rotation: 0 },
] as const

// Fixed collision footprints include the space occupied by a seated person and chair.
export const FURNITURE: readonly Footprint[] = [
  ...DESKS.map(d => ({ id: `desk-${d.id}`, room: ['01', '02', '03'].includes(d.id) ? d.id : 'Work area', x: d.x, z: d.z + 0.45, width: 1.58, depth: 1.9 })),
  { id: 'meeting-table', room: 'Meeting room', x: -8, z: -5.15, width: 1.9, depth: 3.3 },
  { id: 'meeting-seats-west', room: 'Meeting room', x: -9.35, z: -5.15, width: .65, depth: 3.6 },
  { id: 'meeting-seats-east', room: 'Meeting room', x: -6.65, z: -5.15, width: .65, depth: 3.6 },
  { id: 'meeting-seat-north', room: 'Meeting room', x: -8, z: -7.35, width: .65, depth: .65 },
  { id: 'meeting-seat-south', room: 'Meeting room', x: -8, z: -2.95, width: .65, depth: .65 },
  { id: 'consult-table', room: 'Consultation', x: -8, z: .55, width: .8, depth: .75 },
  { id: 'consult-seat-west', room: 'Consultation', x: -9.2, z: .55, width: .75, depth: .75 },
  { id: 'consult-seat-east', room: 'Consultation', x: -6.8, z: .55, width: .75, depth: .75 },
  { id: 'reception', room: 'Reception', x: 2.45, z: 5.9, width: 2.5, depth: .8 },
  { id: 'reception-chair', room: 'Reception', x: 2.45, z: 5.1, width: .7, depth: .7 },
  { id: 'waiting-sofa', room: 'Waiting area', x: -3.3, z: 5, width: 1.9, depth: .75 },
  { id: 'waiting-table', room: 'Waiting area', x: -3.3, z: 6.15, width: 1.1, depth: .55 },
  { id: 'jef-storage', room: 'Private office', x: 8, z: -7.84, width: 2.8, depth: .55 },
  { id: 'product-storage', room: 'Product office', x: 8, z: -2.34, width: 2.65, depth: .55 },
  { id: 'security-storage', room: 'Security office', x: 8.1, z: 2.66, width: 2.8, depth: .55 },
  { id: 'work-storage', room: 'Work area', x: 0, z: -7.9, width: 2.8, depth: .55 },
  { id: 'consult-storage', room: 'Consultation', x: -8, z: -1.25, width: 2.2, depth: .55 },
  { id: 'consult-shelves', room: 'Consultation', x: -9.65, z: 2.45, width: 2.05, depth: .5 },
  { id: 'security-shelves', room: 'Security office', x: 10.45, z: 6.55, width: .5, depth: 2.05 },
  { id: 'security-equipment', room: 'Security office', x: 9.35, z: 7.75, width: .85, depth: .55 },
] as const

export function overlaps(a: Rect, b: Rect, gap = 0) {
  return Math.abs(a.x - b.x) * 2 < a.width + b.width + gap * 2 && Math.abs(a.z - b.z) * 2 < a.depth + b.depth + gap * 2
}

export function inside(inner: Rect, outer: Rect, clearance = 0) {
  return Math.abs(inner.x - outer.x) + inner.width / 2 + clearance <= outer.width / 2 &&
    Math.abs(inner.z - outer.z) + inner.depth / 2 + clearance <= outer.depth / 2
}

// Small deterministic grid for doorway and circulation checks; no runtime physics engine.
export function walkable(x: number, z: number, radius = .27) {
  if (Math.abs(x) > OFFICE.width / 2 - radius || Math.abs(z) > OFFICE.depth / 2 - radius) return false
  if (FURNITURE.some(f => overlaps({ x, z, width: radius * 2, depth: radius * 2 }, f))) return false
  for (const side of [-5, 5]) {
    if (Math.abs(x - side) < OFFICE.wall / 2 + radius && z < (side < 0 ? 2.95 : 8.3)) {
      const opening = ROOMS.find(r => r.side === (side < 0 ? 'west' : 'east') && Math.abs(z - r.door[1]) < OFFICE.doorWidth / 2 - radius)
      if (!opening) return false
    }
  }
  for (const [x0, x1, wallZ] of [[-11, -5, -1.85], [5, 11, -2.85], [5, 11, 2.05]]) {
    if (x > x0 - radius && x < x1 + radius && Math.abs(z - wallZ) < OFFICE.wall / 2 + radius) return false
  }
  return true
}

export function routeExists(start: Point, end: Point, step = .25) {
  const key = (ix: number, iz: number) => `${ix}:${iz}`
  const index = ([x, z]: Point) => [Math.round(x / step), Math.round(z / step)] as const
  const [sx, sz] = index(start)
  const [ex, ez] = index(end)
  const queue: [number, number][] = [[sx, sz]]
  const visited = new Set([key(sx, sz)])
  for (let head = 0; head < queue.length; head++) {
    const [ix, iz] = queue[head]
    if (ix === ex && iz === ez) return true
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = ix + dx, nz = iz + dz, id = key(nx, nz)
      if (!visited.has(id) && walkable(nx * step, nz * step)) { visited.add(id); queue.push([nx, nz]) }
    }
  }
  return false
}
