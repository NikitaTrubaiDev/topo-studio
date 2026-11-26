import type { AdaptiveMesh3D } from './adaptiveMesh3d'
import { h8Corners } from './elementH8'
import { tetCorners, tetFaces, tetVolumeFraction } from './elementT4'
import { nodeCount, nodeIndex3D, nodePosition, type ElementType3D, type Grid3D } from './types3d'

/** Accumulate cell data at the mesh nodes using each incident element's volume. */
export function nodalField3D(grid: Grid3D, type: ElementType3D, values: ArrayLike<number>, density?: ArrayLike<number>) {
  const field = new Float64Array(nodeCount(grid)), weights = new Float64Array(field.length)
  const { nelx, nely, nelz } = grid
  const nodes = new Int32Array(8)
  let e = 0
  for (let z = 0; z < nelz; z++) for (let y = 0; y < nely; y++) for (let x = 0; x < nelx; x++) {
    for (let c = 0; c < 8; c++) {
      const [dx, dy, dz] = h8Corners[c]
      nodes[c] = nodeIndex3D(grid, x + dx, y + dy, z + dz)
    }
    const templates: readonly (readonly number[])[] = type === 'tet4' ? tetCorners[(x + y + z) & 1] : hex
    for (let t = 0; t < templates.length; t++, e++) {
      const value = values[e]
      const w = (density?.[e] ?? 1) * (type === 'tet4' ? tetVolumeFraction(t) : 1)
      if (!(w > 0) || !Number.isFinite(w) || !Number.isFinite(value)) continue
      for (const corner of templates[t]) {
        field[nodes[corner]] += w * value
        weights[nodes[corner]] += w
      }
    }
  }
  for (let i = 0; i < field.length; i++) if (weights[i] > 0) field[i] /= weights[i]
  return field
}

const hex = [[0, 1, 2, 3, 4, 5, 6, 7]]
const hexFaces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]
const hexNeighbors = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]]

function tetNeighbor(parity: number, tet: number, face: readonly number[]) {
  const corners = face.map(i => h8Corners[tetCorners[parity][tet][i]])
  const offset = [0, 1, 2].map(axis =>
    corners.every(c => c[axis] === 0) ? -1 : corners.every(c => c[axis] === 1) ? 1 : 0)
  const p = (parity + offset[0] + offset[1] + offset[2]) & 1
  const other = tetCorners[p].findIndex((c, t) => (p !== parity || t !== tet) && corners.every(point =>
    c.some(i => h8Corners[i].every((v, axis) => v + offset[axis] === point[axis]))))
  if (other < 0) throw new Error('Tet4 face has no matching neighbor')
  return { corners: face.map(i => tetCorners[parity][tet][i]), offset, other }
}

const tetBoundary = tetCorners.map((templates, p) => templates.map((_, t) => tetFaces.map(face => tetNeighbor(p, t, face))))
const hexBoundary = [hexFaces.map((corners, i) => ({ corners, offset: hexNeighbors[i], other: 0 }))]

type ElementFace = { corners: readonly number[]; offset: readonly number[]; other: number }

/** Visit active cells and their oriented boundary faces in solver element order. */
export function visitActiveCells3D(grid: Grid3D, type: ElementType3D, density: ArrayLike<number>, threshold: number,
  visit: (nodes: ArrayLike<number>, exposed: readonly ElementFace[], corners: readonly number[], element: number) => void,
  boundaryOnly = false, mesh?: AdaptiveMesh3D, removed = false) {
  const active = (e: number) => removed ? density[e] < threshold : density[e] >= threshold
  if (type === 'adaptiveTet4') {
    if (!mesh || mesh.stats.elements !== density.length) throw new RangeError('Invalid adaptive mesh field')
    const exposed: ElementFace[] = []
    for (let e = 0; e < density.length; e++) {
      if (!active(e)) continue
      exposed.length = 0
      tetFaces.forEach((corners, f) => {
        const other = mesh.neighbors[4 * e + f]
        if (other < 0 || !active(other)) exposed.push({ corners, other, offset: [] })
      })
      if (!boundaryOnly || exposed.length) visit(mesh.tetrahedra.subarray(4 * e, 4 * e + 4), exposed, [0, 1, 2, 3], e)
    }
    return
  }
  const { nelx, nely, nelz } = grid
  const nodes = new Int32Array(8)
  const exposed: ElementFace[] = []
  let e = 0
  for (let z = 0; z < nelz; z++) for (let y = 0; y < nely; y++) for (let x = 0; x < nelx; x++) {
    const parity = (x + y + z) & 1
    const templates = type === 'tet4' ? tetBoundary[parity] : hexBoundary
    const corners = type === 'tet4' ? tetCorners[parity] : hex
    let hasNodes = false
    for (let t = 0; t < templates.length; t++) {
      if (!active(e++)) continue
      exposed.length = 0
      for (const face of templates[t]) {
        const { offset, other } = face
        const i = x + offset[0], j = y + offset[1], k = z + offset[2]
        const inside = i >= 0 && i < nelx && j >= 0 && j < nely && k >= 0 && k < nelz
        if (inside && active(((k * nely + j) * nelx + i) * templates.length + other)) continue
        exposed.push(inside ? face : { ...face, other: -1 })
      }
      if (boundaryOnly && !exposed.length) continue
      if (!hasNodes) {
        for (let c = 0; c < 8; c++) {
          const [dx, dy, dz] = h8Corners[c]
          nodes[c] = nodeIndex3D(grid, x + dx, y + dy, z + dz)
        }
        hasNodes = true
      }
      visit(nodes, exposed, corners[t], e - 1)
    }
  }
}

/** Exposed oriented faces and true element edges, without triangulation diagonals on Hex8 faces. */
export function elementSurface3D(grid: Grid3D, type: ElementType3D, density: ArrayLike<number>, threshold: number, withEdges: boolean,
  mesh?: AdaptiveMesh3D, removed = false) {
  const count = mesh?.stats.nodes ?? nodeCount(grid)
  const triangles: number[] = [], edges: number[] = [], faceElements: number[] = []
  const seen = withEdges ? new Set<number>() : undefined
  const positions = new Float32Array(3 * count)
  if (mesh) positions.set(mesh.positions)
  else for (let i = 0; i < count; i++) positions.set(nodePosition(grid, i), 3 * i)
  visitActiveCells3D(grid, type, density, threshold, (nodes, exposed, _, element) => {
    for (const { corners, other } of exposed) {
      const a = nodes[corners[0]], b = nodes[corners[1]], c = nodes[corners[2]]
      triangles.push(a, b, c)
      faceElements.push(element)
      if (corners.length === 4) {
        triangles.push(a, c, nodes[corners[3]])
        faceElements.push(element)
      }
      if (seen && (!removed || other < 0)) for (let l = 0; l < corners.length; l++) {
        const m = nodes[corners[l]], n = nodes[corners[(l + 1) % corners.length]]
        const key = Math.min(m, n) * count + Math.max(m, n)
        if (seen.has(key)) continue
        seen.add(key)
        edges.push(m, n)
      }
    }
  }, true, mesh, removed)
  return { positions, triangles: Uint32Array.from(triangles), edges: Uint32Array.from(edges), faceElements: Uint32Array.from(faceElements) }
}
