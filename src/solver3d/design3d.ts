import { cellSize, elementCount, elementIndex, nodeCount, nodeIndex3D, nodePosition, type Force3D, type Grid3D, type SimpProblem3D, type Support3D } from './types3d'

export type ForceVector3D = Omit<Force3D, 'node'>
export type Boundary3D = Pick<SimpProblem3D, 'supports' | 'loadCases'>
export type EditTool3D = 'orbit' | 'load' | 'support'
const supportAxes = ['fixX', 'fixY', 'fixZ'] as const
export type SupportKind3D = 'fixed' | 'pin' | typeof supportAxes[number]

export const directions3D = [
  ['↓ −Y', 'forceDown', 'fy', -1], ['↑ +Y', 'forceUp', 'fy', 1],
  ['→ +X', 'forceRight', 'fx', 1], ['← −X', 'forceLeft', 'fx', -1],
  ['↗ +Z', 'forcePositiveZ3d', 'fz', 1], ['↙ −Z', 'forceNegativeZ3d', 'fz', -1],
] as const

export function directionalForce3D(axis: keyof ForceVector3D, sign: number, magnitude: number): ForceVector3D {
  return { fx: 0, fy: 0, fz: 0, [axis]: sign * magnitude }
}

export function forceMagnitude3D({ fx, fy, fz }: ForceVector3D) {
  return Math.hypot(fx, fy, fz)
}

export const minForceMagnitude3D = 1e-6
export const maxForceMagnitude3D = 1e9

export function validForceMagnitude3D(magnitude: number) {
  return magnitude >= minForceMagnitude3D && magnitude <= maxForceMagnitude3D
}

export function snapNode3D(grid: Grid3D, point: readonly number[]) {
  const [x, y, z] = cellSize(grid).map((size, i) =>
    Math.max(0, Math.min([grid.nelx, grid.nely, grid.nelz][i], Math.round(point[i] / size))))
  return nodeIndex3D(grid, x, y, z)
}

/** Brick masks are mirrored across the same representatives used by the optimizer. */
export function brickMasks3D({ grid, params, passive }: Pick<SimpProblem3D, 'grid' | 'params' | 'passive'>) {
  const { nelx, nely, nelz } = grid
  const count = elementCount(grid)
  const representatives = new Int32Array(count)
  const solid = new Uint8Array(count), voidMask = new Uint8Array(count)
  const mirrorY = params.symmetry?.includes('y'), mirrorZ = params.symmetry?.includes('z')
  for (let z = 0, e = 0; z < nelz; z++) for (let y = 0; y < nely; y++) for (let x = 0; x < nelx; x++, e++) {
    const rep = elementIndex(grid, x, mirrorY ? Math.min(y, nely - 1 - y) : y, mirrorZ ? Math.min(z, nelz - 1 - z) : z)
    representatives[e] = rep
    if (passive?.solid?.[e]) solid[rep] = 1
    if (passive?.void?.[e]) voidMask[rep] = 1
  }
  for (let e = 0; e < count; e++) {
    solid[e] = solid[representatives[e]]
    voidMask[e] = voidMask[representatives[e]]
  }
  return { representatives, solid, voidMask }
}

export function nodeTouchesMaterial3D(grid: Grid3D, node: number, voidMask: Uint8Array) {
  const nx = grid.nelx + 1, ny = grid.nely + 1
  const x = node % nx, y = Math.floor(node / nx) % ny, z = Math.floor(node / (nx * ny))
  for (let k = Math.max(0, z - 1); k < Math.min(z + 1, grid.nelz); k++) {
    for (let j = Math.max(0, y - 1); j < Math.min(y + 1, grid.nely); j++) {
      for (let i = Math.max(0, x - 1); i < Math.min(x + 1, grid.nelx); i++) {
        if (!voidMask[elementIndex(grid, i, j, k)]) return true
      }
    }
  }
  return false
}

export function editCase3D(design: Boundary3D, id: string, edit: (forces: readonly Force3D[]) => readonly Force3D[]) {
  return { ...design, loadCases: design.loadCases.map(load => load.id === id ? { ...load, forces: edit(load.forces) } : load) }
}

export function addCase3D(design: Boundary3D, id: string) {
  return { ...design, loadCases: [...design.loadCases, { id, forces: [] }] }
}

export function deleteCase3D(design: Boundary3D, id: string) {
  return design.loadCases.length <= 1 ? design : { ...design, loadCases: design.loadCases.filter(load => load.id !== id) }
}

export function setForce3D(design: Boundary3D, id: string, node: number, force?: ForceVector3D) {
  return editCase3D(design, id, forces => {
    const magnitude = force ? forceMagnitude3D(force) : 0
    if (!force || magnitude === 0) return forces.filter(prior => prior.node !== node)
    if (!validForceMagnitude3D(magnitude)) return forces
    const replacement = { ...force, node }
    return forces.some(prior => prior.node === node)
      ? forces.map(prior => prior.node === node ? replacement : prior)
      : [...forces, replacement]
  })
}

export function deleteForce3D(design: Boundary3D, id: string, index: number) {
  return editCase3D(design, id, forces => forces.filter((_, i) => i !== index))
}

export function setSupport3D(design: Boundary3D, node: number, kind?: SupportKind3D) {
  const prior = design.supports.find(support => support.node === node)
  const remaining = design.supports.filter(support => support.node !== node)
  if (!kind) return { ...design, supports: remaining }
  // A 3D pin constrains translations just like a clamp for solid elements,
  // whose nodes have no rotational degrees of freedom.
  const support = { node, fixX: false, fixY: false, fixZ: false }
  for (const axis of supportAxes) support[axis] = kind === 'fixed' || kind === 'pin' || kind === axis
  return { ...design, supports: prior && supportAxes.every(axis => support[axis] === prior[axis]) ? remaining : [...remaining, support] }
}

export type BoundaryHistory3D = { past: readonly Boundary3D[]; present: Boundary3D; future: readonly Boundary3D[] }

export function boundaryHistory3D(present: Boundary3D): BoundaryHistory3D {
  return { past: [], present, future: [] }
}

export function changeBoundary3D(history: BoundaryHistory3D, next: Boundary3D | 'undo' | 'redo'): BoundaryHistory3D {
  const { past, present, future } = history
  if (next === 'undo') return past.length ? { past: past.slice(0, -1), present: past.at(-1)!, future: [present, ...future] } : history
  if (next === 'redo') return future.length ? { past: [...past, present], present: future[0], future: future.slice(1) } : history
  return next === present ? history : { past: [...past.slice(-99), present], present: next, future: [] }
}

/** Independent displacement constraints on Tx, Ty, Tz, Rx, Ry and Rz. */
export function rigidRank3D(grid: Grid3D, supports: readonly Support3D[]) {
  return rigidRankAt3D(supports, nodeCount(grid), Math.max(grid.widthMm, grid.heightMm, grid.depthMm),
    node => nodePosition(grid, node))
}

export function rigidRankAt3D(supports: readonly Support3D[], count: number, scale: number, position: (node: number) => ArrayLike<number>) {
  const basis: number[][] = []
  for (const support of supports) {
    if (!Number.isInteger(support.node) || support.node < 0 || support.node >= count) continue
    const [x, y, z] = Array.from(position(support.node), value => value / scale - 0.5)
    const rows = [[1, 0, 0, 0, z, -y], [0, 1, 0, -z, 0, x], [0, 0, 1, y, -x, 0]]
    for (let axis = 0; axis < 3; axis++) {
      if (!support[supportAxes[axis]]) continue
      const row = rows[axis]
      for (const direction of basis) {
        const projection = row.reduce((total, value, i) => total + value * direction[i], 0)
        for (let i = 0; i < 6; i++) row[i] -= projection * direction[i]
      }
      const length = Math.hypot(...row)
      if (length > 1e-10) basis.push(row.map(value => value / length))
      if (basis.length === 6) return 6
    }
  }
  return basis.length
}

export function caseColor3D(index: number) {
  if (index <= 0) return '#fbb075'
  return `hsl(${(27 + index * 137.508) % 360}, 78%, 70%)`
}


export function caseNumber(id: string) {
  return id.startsWith('case-') ? Number(id.slice(5)) : 1
}
