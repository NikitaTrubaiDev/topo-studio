import { nodeIndex, type Grid } from '../solver/types'

export const DEFORMED_DENSITY_THRESHOLD = 0.05

export function deformedNodes(grid: Grid, displacement: Float64Array, magnification: number): Float64Array {
  const { nelx, nely, cellSizeMm = 1 } = grid
  const positions = new Float64Array(displacement.length)
  for (let y = 0; y <= nely; y++) {
    for (let x = 0; x <= nelx; x++) {
      const offset = 2 * nodeIndex(grid, x, y)
      positions[offset] = x + displacement[offset] * magnification / cellSizeMm
      positions[offset + 1] = y + displacement[offset + 1] * magnification / cellSizeMm
    }
  }
  return positions
}

export function quadNodes(grid: Grid, x: number, y: number): [number, number, number, number] {
  const bottom = nodeIndex(grid, x, y)
  const top = nodeIndex(grid, x, y + 1)
  return [bottom, bottom + 1, top + 1, top]
}

export function hitTestDeformedMesh(
  grid: Grid, positions: Float64Array, density: Float32Array, [x, y]: [number, number],
): number | null {
  const { nelx, nely } = grid
  // Inspect in reverse paint order so an overlap reports the topmost visible element.
  for (let e = nelx * nely - 1; e >= 0; e--) {
    if (density[e] < DEFORMED_DENSITY_THRESHOLD) continue
    const nodes = quadNodes(grid, e % nelx, Math.floor(e / nelx))
    let winding = 0
    for (let i = 0; i < nodes.length; i++) {
      const from = 2 * nodes[i], to = 2 * nodes[(i + 1) % nodes.length]
      const ax = positions[from], ay = positions[from + 1]
      const bx = positions[to], by = positions[to + 1]
      const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
      if (cross === 0 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx)
        && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return e
      // Match the canvas nonzero winding rule for concave and folded quads.
      if (ay <= y && by > y && cross > 0) winding++
      if (ay > y && by <= y && cross < 0) winding--
    }
    if (winding !== 0) return e
  }
  return null
}
