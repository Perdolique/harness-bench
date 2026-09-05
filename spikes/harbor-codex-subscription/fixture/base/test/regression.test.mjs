import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeRoomLabel } from '../src/normalize-room-label.mjs'

test('normalizes existing room labels', () => {
  assert.equal(normalizeRoomLabel('  ROOM-42  '), 'room-42')
  assert.equal(normalizeRoomLabel('   '), '')
})
