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

/** Preserve normalized placement within one reference cell of the old point. */
export function remapBoundary3D(design: Boundary3D, oldGrid: Grid3D, grid: Grid3D, voidMask: Uint8Array): Boundary3D {
  const counts = [grid.nelx, grid.nely, grid.nelz]
  const oldCounts = [oldGrid.nelx, oldGrid.nely, oldGrid.nelz]
  const physicalScale = cellSize(grid)
  const mapping = new Map<number, number>()
  function remap(node: number) {
    if (!Number.isInteger(node) || node < 0 || node >= nodeCount(oldGrid)) return -1
    const cached = mapping.get(node)
    if (cached !== undefined) return cached
    const nx = oldGrid.nelx + 1, ny = oldGrid.nely + 1
    const point = [node % nx, Math.floor(node / nx) % ny, Math.floor(node / (nx * ny))]
      .map((v, d) => v * counts[d] / oldCounts[d])
    const low = point.map(v => Math.ceil(v - 1 - 1e-9))
    const high = point.map((v, d) => Math.min(counts[d], Math.floor(v + 1 + 1e-9)))
    let best = -1, distance = Infinity
    for (let z = Math.max(0, low[2]); z <= high[2]; z++) for (let y = Math.max(0, low[1]); y <= high[1]; y++) {
      for (let x = Math.max(0, low[0]); x <= high[0]; x++) {
        const candidate = nodeIndex3D(grid, x, y, z)
        const square = [x, y, z].reduce((sum, v, d) => sum + ((v - point[d]) * physicalScale[d]) ** 2, 0)
        if (square >= distance || !nodeTouchesMaterial3D(grid, candidate, voidMask)) continue
        best = candidate
        distance = square
      }
    }
    mapping.set(node, best)
    return best
  }
  const supports = new Map<number, Support3D>()
  for (const support of design.supports) {
    const node = remap(support.node)
    if (node < 0) continue
    const merged = supports.get(node) ?? { node, fixX: false, fixY: false, fixZ: false }
    for (const axis of supportAxes) merged[axis] ||= support[axis]
    supports.set(node, merged)
  }
  const loadCases = design.loadCases.map(load => {
    const forces = new Map<number, Force3D>()
    for (const force of load.forces) {
      const node = remap(force.node)
      if (node < 0) continue
      const merged = forces.get(node) ?? { node, fx: 0, fy: 0, fz: 0 }
      merged.fx += force.fx
      merged.fy += force.fy
      merged.fz += force.fz
      forces.set(node, merged)
    }
    return { ...load, forces: [...forces.values()].filter(force => forceMagnitude3D(force) > 0) }
  })
  return { supports: [...supports.values()], loadCases }
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
    const rows = rigidModes(x, y, z)
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

function rigidModes(x: number, y: number, z: number) {
  return [[1, 0, 0, 0, z, -y], [0, 1, 0, -z, 0, x], [0, 0, 1, y, -x, 0]]
}

/** Label rigid bodies by face adjacency and record every shared nodal joint. */
export function rigidComponents3D(voidMask: Uint8Array, nodes: number,
  neighbors: (element: number) => Iterable<number>, vertices: (element: number) => Iterable<number>) {
  const components = new Int32Array(voidMask.length).fill(-1)
  const firstBody = new Int32Array(nodes).fill(-1)
  const joints = new Map<number, Set<number>>()
  const stack: number[] = []
  let count = 0
  for (let start = 0; start < components.length; start++) {
    if (voidMask[start] || components[start] >= 0) continue
    components[start] = count
    stack.push(start)
    while (stack.length) {
      const e = stack.pop()!
      for (const node of vertices(e)) {
        const first = firstBody[node]
        if (first < 0) firstBody[node] = count
        else if (first !== count) {
          let bodies = joints.get(node)
          if (!bodies) joints.set(node, bodies = new Set([first]))
          bodies.add(count)
        }
      }
      for (const next of neighbors(e)) {
        if (next < 0 || voidMask[next] || components[next] >= 0) continue
        components[next] = count
        stack.push(next)
      }
    }
    count++
  }
  return { count, firstBody, joints }
}

/** Sparse elimination of the support and shared-point displacement constraints.
 * Disconnected body groups have disjoint columns. When supplied, loaded marks
 * the groups whose full column rank is required. */
export function rigidComponentsStable3D({ count, firstBody, joints }: ReturnType<typeof rigidComponents3D>,
  supports: readonly Support3D[], scale: number, position: (node: number) => ArrayLike<number>, loaded?: Uint8Array) {
  const pivots = new Map<number, Map<number, number>>()
  function addRow(modes: number[], a: number, b = -1) {
    const row = new Map<number, number>()
    modes.forEach((value, i) => {
      if (!value) return
      row.set(6 * a + i, value)
      if (b >= 0) row.set(6 * b + i, -value)
    })
    while (row.size) {
      let column = Infinity
      for (const key of row.keys()) column = Math.min(column, key)
      const value = row.get(column)!
      row.delete(column)
      if (Math.abs(value) <= 1e-10) continue
      const pivot = pivots.get(column)
      if (!pivot) {
        for (const [key, coefficient] of row) row.set(key, coefficient / value)
        pivots.set(column, row)
        return
      }
      for (const [key, coefficient] of pivot) row.set(key, (row.get(key) ?? 0) - coefficient * value)
    }
  }
  const modesAt = (node: number) => {
    const [x, y, z] = Array.from(position(node), value => value / scale - 0.5)
    return rigidModes(x, y, z)
  }
  for (const support of supports) {
    const body = firstBody[support.node]
    if (!(body >= 0)) continue
    const modes = modesAt(support.node)
    supportAxes.forEach((axis, i) => { if (support[axis]) addRow(modes[i], body) })
    if (pivots.size === 6 * count) return true
  }
  for (const [node, bodies] of joints) {
    const first = firstBody[node]
    const modes = modesAt(node)
    for (const body of bodies) if (body !== first) for (const row of modes) addRow(row, first, body)
    if (pivots.size === 6 * count) return true
  }
  if (!loaded) return pivots.size === 6 * count

  const parents = Int32Array.from({ length: count }, (_, i) => i)
  function root(body: number) {
    while (body !== parents[body]) {
      parents[body] = parents[parents[body]]
      body = parents[body]
    }
    return body
  }
  for (const bodies of joints.values()) {
    const first = root(bodies.values().next().value!)
    for (const body of bodies) parents[root(body)] = first
  }
  const groups = new Set<number>()
  loaded.forEach((value, node) => { if (value && firstBody[node] >= 0) groups.add(root(firstBody[node])) })
  for (let body = 0; body < count; body++) {
    if (!groups.has(root(body))) continue
    for (let mode = 0; mode < 6; mode++) if (!pivots.has(6 * body + mode)) return false
  }
  return true
}

export function caseColor3D(index: number) {
  if (index <= 0) return '#fbb075'
  return `hsl(${(27 + index * 137.508) % 360}, 78%, 70%)`
}


export function caseNumber(id: string) {
  return id.startsWith('case-') ? Number(id.slice(5)) : 1
}
