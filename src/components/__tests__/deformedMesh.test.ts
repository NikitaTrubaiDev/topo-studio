import { expect, it } from 'vitest'
import { deformedNodes, hitTestDeformedMesh } from '../deformedMesh'

it('inspects displaced elements at the rendered scale, including outside the original grid', () => {
  const grid = { nelx: 2, nely: 1, cellSizeMm: 2 }
  const u = Float64Array.from({ length: 12 }, (_, i) => i % 2 === 0 ? 1 : -0.5)
  const positions = deformedNodes(grid, u, 2)
  const density = Float32Array.of(0.7, 0.9)

  expect(hitTestDeformedMesh(grid, positions, density, [1.5, 0.25])).toBe(0)
  expect(hitTestDeformedMesh(grid, positions, density, [2.5, -0.25])).toBe(1)
  expect(hitTestDeformedMesh(grid, positions, density, [0.5, 0.25])).toBeNull()
  expect(hitTestDeformedMesh(grid, positions, density, [1.5, 0.75])).toBeNull()
  expect(hitTestDeformedMesh(grid, positions, Float32Array.of(0.04, 0.9), [1.5, 0.25])).toBeNull()
})

it('tests the quadrilateral rather than its bounding box and resolves overlap in paint order', () => {
  const grid = { nelx: 2, nely: 1 }
  // The second element folds back over the first, and the top edge is sheared to the right.
  const u = Float64Array.of(0, 0, 0, 0, -2, 0, 1, 0, 1, 0, -1, 0)
  const positions = deformedNodes(grid, u, 1)
  expect(hitTestDeformedMesh(grid, positions, Float32Array.of(1, 1), [1, 0.5])).toBe(1)
  expect(hitTestDeformedMesh(grid, positions, Float32Array.of(1, 0), [1, 0.5])).toBe(0)
  expect(hitTestDeformedMesh(grid, positions, Float32Array.of(1, 1), [0.25, 0.75])).toBeNull()
})
