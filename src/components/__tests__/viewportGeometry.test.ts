import { expect, it } from 'vitest'
import { MAX_NODAL_FORCE, isValidForce } from '../../solver/design'
import { makePreset } from '../../solver/presets'
import { nodeIndex } from '../../solver/types'
import { aimedForce, boundaryMarkers, canvasLayout, canvasPoint, gridPoint, hitBoundaryMarker, nearestNode } from '../viewportGeometry'

it.each([
  [240, 80, 1101.625, 603.25],
  [300, 100, 1353.5, 527.75],
  [300, 100, 1353.5, 284.75],
])('maps %i × %i nodes and elements accurately in the fitted canvas', (nelx, nely, width, height) => {
  const grid = { nelx, nely }
  const layout = canvasLayout(width, height, grid)
  for (const [x, y] of [[0, 0], [0, nely], [nelx, 0], [nelx, nely], [163, 37]]) {
    const world = gridPoint(layout, canvasPoint(layout, x, y))
    expect(world).toEqual([x, y])
    expect(nearestNode(grid, world)).toBe(nodeIndex(grid, x, y))
  }
  const [x, y] = gridPoint(layout, canvasPoint(layout, 162.499, 38.501))
  expect(nearestNode(grid, [x, y])).toBe(nodeIndex(grid, 162, 39))
  expect([Math.floor(x), Math.floor(y)]).toEqual([162, 38])
  expect(nearestNode(grid, gridPoint(layout, canvasPoint(layout, 162.5, 38.5)))).toBe(nodeIndex(grid, 163, 39))
})

it('aims a drag in engineering coordinates while preserving force magnitude', () => {
  const initial = { fx: 0, fy: -100 }
  expect(aimedForce([10, 10], [12, 10], initial)).toBeUndefined()
  expect(aimedForce([10, 10], [13, 6], initial)).toEqual({ fx: 60, fy: 80 })
  expect(aimedForce([10, 10], [7, 14], initial)).toEqual({ fx: -60, fy: -80 })
  const force = aimedForce([0, 0], [15, 16], { fx: MAX_NODAL_FORCE, fy: 0 })!
  expect(isValidForce(force.fx, force.fy)).toBe(true)
  expect(Math.hypot(force.fx, force.fy) / MAX_NODAL_FORCE).toBeCloseTo(1, 14)
})

it('picks the displayed arrow shaft, prefers the active case at shared nodes, and hits support symbols', () => {
  const grid = { nelx: 300, nely: 100 }
  const preset = makePreset('mbb', grid)
  const active = preset.loadCases[0]
  const force = active.forces[0]
  const second = { ...active, id: 'other', forces: [{ ...force, fx: 100, fy: 0 }] }
  const problem = { ...preset, loadCases: [active, second] }
  const layout = canvasLayout(1340, 522, grid)
  const markers = boundaryMarkers(problem, layout, undefined, { supports: true, forces: true }, -1)
  const load = markers.find(marker => marker.kind === 'load' && marker.caseIndex === 0)
  if (load?.kind !== 'load') throw new Error('Preset arrow is missing')
  expect(hitBoundaryMarker(markers, load.tail, layout.cell, 0, 'loads')).toBe(load)
  expect(hitBoundaryMarker(markers, load.anchor, layout.cell, 1, 'inspect')).toMatchObject({ caseIndex: 1 })
  const support = markers.find(marker => marker.kind === 'support')!
  expect(hitBoundaryMarker(markers, support.point, layout.cell, 0, 'supports')).toBe(support)
  expect(hitBoundaryMarker(markers, [0, 0], layout.cell, 0, 'inspect')).toBeUndefined()
})
