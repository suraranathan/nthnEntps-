import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DESKS, FURNITURE, OFFICE, ROOMS, inside, overlaps, routeExists, walkable } from '../src/officeLayout.ts'
import type { Rect } from '../src/officeLayout.ts'

const centralWork = { x: 0, z: -3.8, width: 9.6, depth: 9.1 }
const welcome = { x: 0, z: 5.65, width: 9.6, depth: 5.1 }
const roomById = new Map<string, Rect>(ROOMS.map(room => [room.id, room]))
roomById.set('Work area', centralWork)
roomById.set('Reception', welcome)
roomById.set('Waiting area', welcome)

function fixtureRoom(name: string) {
  return name === '01' ? 'Private office' : name === '02' ? 'Security office' : name === '03' ? 'Product office' : name
}

test('measured office furniture fits in its assigned room without overlap', () => {
  const floor = { x: 0, z: 0, width: OFFICE.width, depth: OFFICE.depth }
  for (const room of ROOMS) assert.ok(inside(room, floor, .05), `${room.id} is within the office`)
  for (const item of FURNITURE) {
    const room = roomById.get(fixtureRoom(item.room))
    assert.ok(room, `${item.id} has an assigned room`)
    assert.ok(inside(item, room!, .12), `${item.id} has wall clearance`)
  }
  for (let i = 0; i < FURNITURE.length; i++) {
    for (let j = i + 1; j < FURNITURE.length; j++) {
      assert.equal(overlaps(FURNITURE[i], FURNITURE[j]), false, `${FURNITURE[i].id} intersects ${FURNITURE[j].id}`)
    }
  }
})

test('entrance reaches every room door and every seated workstation', () => {
  const entrance = [0, 8] as const
  assert.ok(walkable(...entrance))
  for (const room of ROOMS) {
    const insideDoor = [room.side === 'west' ? -5.7 : 5.7, room.door[1]] as const
    assert.ok(routeExists(entrance, insideDoor), `${room.id} door is accessible`)
  }
  for (const desk of DESKS) {
    const approach = [desk.x, desk.z + 2] as const
    assert.ok(routeExists(entrance, approach), `workstation ${desk.id} is accessible`)
  }
})
