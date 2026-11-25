import { expect, it } from 'vitest'
import { extractContours, signedArea } from '../contour'

const grid = { nelx: 40, nely: 36 }

function radial(field: (radius: number) => number) {
  return Float64Array.from({ length: grid.nelx * grid.nely }, (_, i) =>
    field(Math.hypot(i % grid.nelx + 0.5 - grid.nelx / 2, Math.floor(i / grid.nelx) + 0.5 - grid.nely / 2)))
}

it('closes a solid box exactly on the four domain edges and preserves those points during smoothing', () => {
  const field = new Float64Array(grid.nelx * grid.nely).fill(1)
  const [box] = extractContours(field, grid)
  expect(box.hole).toBe(false)
  expect(box.parent).toBe(-1)
  expect(signedArea(box.points)).toBe(grid.nelx * grid.nely)
  expect(box.points).toEqual(expect.arrayContaining([[0, 0], [0, grid.nely], [grid.nelx, 0], [grid.nelx, grid.nely]]))
  expect(box.points.at(-1)).not.toEqual(box.points[0])
  expect(extractContours(field, grid, 0.5, 12)).toEqual([box])
  expect(extractContours(field.fill(0), grid)).toEqual([])
})

it('interpolates the threshold and smooths a disk without appreciable area shrinkage', () => {
  const field = radial(radius => Math.max(0, Math.min(1, 0.5 + (10 - radius) / 3)))
  const [raw] = extractContours(field, grid)
  const smooth = extractContours(field, grid, 0.5, 8)
  expect(smooth).toHaveLength(1)
  expect(smooth[0].points).not.toEqual(raw.points)
  expect(signedArea(raw.points)).toBeCloseTo(Math.PI * 100, -1)
  expect(Math.abs(signedArea(smooth[0].points) / signedArea(raw.points) - 1)).toBeLessThan(0.01)
  const [small] = extractContours(field, grid, 0.8)
  expect(signedArea(small.points)).toBeLessThan(signedArea(raw.points))
})

it('classifies a ring and nested material island by containment, with opposite winding on holes', () => {
  const loops = extractContours(radial(radius => Number((radius < 12 && radius > 5) || radius < 2.5)), grid, 0.5, 6)
  expect(loops.map(loop => [loop.hole, loop.parent])).toEqual([[false, -1], [true, 0], [false, 1]])
  expect(loops.map(loop => Math.sign(signedArea(loop.points)))).toEqual([1, -1, 1])
  for (const loop of loops) {
    expect(loop.points.length).toBeGreaterThan(8)
    expect(loop.points.every(([x, y]) => x >= 0 && x <= grid.nelx && y >= 0 && y <= grid.nely)).toBe(true)
  }
})

it('pins the straight boundary of a smoothed contour where it meets the domain edge', () => {
  const field = Float64Array.from({ length: grid.nelx * grid.nely }, (_, i) =>
    Number(Math.hypot(i % grid.nelx + 0.5, Math.floor(i / grid.nelx) + 0.5 - 18) < 9))
  const [raw] = extractContours(field, grid)
  const [smooth] = extractContours(field, grid, 0.5, 6)
  const boundary = raw.points.filter(([x]) => x === 0)
  expect(boundary.length).toBeGreaterThan(10)
  expect(smooth.points.filter(([x]) => x === 0)).toEqual(boundary)
  expect(smooth.points).not.toEqual(raw.points)
})

it('switches the saddle pairing as the dominant diagonal changes', () => {
  const grid = { nelx: 2, nely: 2 }
  expect(extractContours([0.95, 0.45, 0.45, 0.95], grid)).toHaveLength(1)
  expect(extractContours([0.55, 0.05, 0.05, 0.55], grid)).toHaveLength(2)
  expect(extractContours([0.45, 0.95, 0.95, 0.45], grid)).toHaveLength(1)
  expect(extractContours([0.05, 0.55, 0.55, 0.05], grid)).toHaveLength(2)
})
