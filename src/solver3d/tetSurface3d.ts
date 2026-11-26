import type { AdaptiveMesh3D } from './adaptiveMesh3d'
import { h8Corners } from './elementH8'
import { tetFaces } from './elementT4'
import { visitActiveCells3D } from './mesh3d'
import { cadTriangleBudget, CadTriangleBudgetError, type Surface3D } from './surface3d'
import { elementCount, nodeCount, nodeIndex3D, nodePosition, type Grid3D } from './types3d'
import type { PassiveMasks } from '../solver/types'

/** Find edges with multiple boundary fans, and vertices where distinct fans meet. */
function findContacts(triangles: number[], count: number, edgeKey: (a: number, b: number) => number) {
  const edges = new Map<number, number[]>()
  const next = (i: number) => i % 3 === 2 ? i - 2 : i + 1
  for (let i = 0; i < triangles.length; i++) {
    const key = edgeKey(triangles[i], triangles[next(i)])
    const sides = edges.get(key)
    if (sides) sides.push(i)
    else edges.set(key, [i])
  }

  const neighbors = new Int32Array(triangles.length).fill(-1)
  const singularEdges = new Set<number>()
  const singularNodes = new Uint8Array(count)
  for (const [key, sides] of edges) {
    if (sides.length === 2) {
      const [a, b] = sides
      neighbors[a] = next(b)
      neighbors[b] = next(a)
    } else {
      singularEdges.add(key)
      singularNodes[triangles[sides[0]]] = 1
      singularNodes[triangles[next(sides[0])]] = 1
    }
  }

  const seenCorners = new Uint8Array(triangles.length)
  const seenNodes = new Uint8Array(count)
  for (let i = 0; i < triangles.length; i++) {
    const node = triangles[i]
    if (seenCorners[i] || singularNodes[node]) continue
    if (seenNodes[node]) singularNodes[node] = 1
    seenNodes[node] = 1
    for (let side = i; !seenCorners[side]; side = neighbors[side]) seenCorners[side] = 1
  }
  return { singularEdges, singularNodes }
}

// A dyadic barycentric lattice gives shared faces exactly the same clipped vertices.
// Vertex cuts extend three times as far as edge cuts so two edge cuts never cross.
const barycentricUnit = 32
const simplex = tetFaces.map((_, i) => tetFaces.map((_, j) => i === j ? barycentricUnit : 0))
const tetEdges = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]] as const

type ClipFace = { points: number[][]; exposed: boolean }

function trimContact(faces: ClipFace[], distance: (point: number[]) => number): ClipFace[] {
  const result: ClipFace[] = []
  const cap = new Map<string, number[]>()
  for (const { points, exposed } of faces) {
    const retained: number[][] = []
    let entry: number[] | undefined, exit: number[] | undefined
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length]
      const da = distance(a), db = distance(b)
      if (da >= 0) retained.push(a)
      if ((da >= 0) === (db >= 0)) continue
      const t = da / (da - db)
      const cut = a.map((value, j) => Math.round(value + t * (b[j] - value)))
      retained.push(cut)
      if (da < 0) entry = cut
      else exit = cut
    }
    if (retained.length >= 3) result.push({ points: retained, exposed })
    if (entry && exit) cap.set(entry.join(), exit)
  }
  const first = cap.values().next().value
  if (first) {
    const points = [first]
    while (points.length < cap.size) {
      const next = cap.get(points.at(-1)!.join())
      if (!next || next === first) throw new Error('Incomplete Tet4 contact cut')
      points.push(next)
    }
    result.push({ points, exposed: true })
  }
  return result
}

/** Extract the solid Tet4 boundary. Face-connected material is preserved. At edge-
 * or vertex-only contacts, trim the singular feature locally to make a manifold. */
export function marchingTetrahedra(density: ArrayLike<number>, grid: Grid3D, threshold = 0.5, passive?: PassiveMasks, mesh?: AdaptiveMesh3D,
  triangleBudget = cadTriangleBudget): Surface3D {
  if (density.length !== (mesh?.stats.elements ?? elementCount(grid, 'tet4')) || !(threshold > 0 && threshold < 1)) {
    throw new RangeError('Invalid Tet4 isosurface input')
  }
  for (let e = 0; e < density.length; e++) if (!Number.isFinite(density[e])) throw new RangeError('Non-finite density')

  // Prescribed voids cannot emit material faces, even if the input is stale.
  if (mesh && passive?.void?.some(Boolean)) density = Float64Array.from(density, (value, e) => passive.void![mesh.bricks[e]] ? 0 : value)
  const count = mesh?.stats.nodes ?? nodeCount(grid)
  const elementType = mesh ? 'adaptiveTet4' : 'tet4'
  const edgeKey = (a: number, b: number) => Math.min(a, b) * count + Math.max(a, b)
  const exposedTriangles: number[] = [], exposedElements = mesh ? [] as number[] : undefined
  function checkBudget(count: number) {
    if (count > triangleBudget) throw new CadTriangleBudgetError('CAD surface exceeds the triangle budget')
  }
  visitActiveCells3D(grid, elementType, density, threshold, (nodes, exposed, _, element) => {
    checkBudget(exposedTriangles.length / 3 + exposed.length)
    for (const { corners: [a, b, c] } of exposed) {
      exposedTriangles.push(nodes[a], nodes[b], nodes[c])
      exposedElements?.push(element)
    }
  }, true, mesh)
  const { singularEdges, singularNodes } = findContacts(exposedTriangles, count, edgeKey)
  const { nelx, nely, nelz } = grid
  const prescribed = passive && new Uint8Array(count)
  if (prescribed && mesh) {
    mesh.bricks.forEach((brick, e) => {
      if (passive.solid?.[brick] || passive.void?.[brick]) {
        for (let j = 0; j < 4; j++) prescribed[mesh.tetrahedra[4 * e + j]] = 1
      }
    })
  } else if (prescribed) for (let z = 0, e = 0; z < nelz; z++) for (let y = 0; y < nely; y++) for (let x = 0; x < nelx; x++, e++) {
    if (passive.solid?.[e] || passive.void?.[e]) {
      for (const [dx, dy, dz] of h8Corners) prescribed[nodeIndex3D(grid, x + dx, y + dy, z + dz)] = 1
    }
  }

  const vertices: number[] = [], triangles: number[] = [], pins: number[] = []
  const nodesToVertices = new Int32Array(count).fill(-1)
  function position(node: number) {
    if (mesh) return Array.from(mesh.positions.subarray(3 * node, 3 * node + 3))
    const result = nodePosition(grid, node)
    if (node % (nelx + 1) === nelx) result[0] = grid.widthMm
    if (Math.floor(node / (nelx + 1)) % (nely + 1) === nely) result[1] = grid.heightMm
    if (Math.floor(node / ((nelx + 1) * (nely + 1))) === nelz) result[2] = grid.depthMm
    return result
  }
  function vertex(point: number[], pinned: boolean) {
    const index = vertices.length / 3
    vertices.push(...point)
    if (prescribed) pins.push(Number(pinned))
    return index
  }
  function atNode(node: number) {
    if (nodesToVertices[node] < 0) nodesToVertices[node] = vertex(position(node), !!prescribed?.[node])
    return nodesToVertices[node]
  }

  let faceElements = exposedElements
  function emit(a: number, b: number, c: number, element: number) {
    triangles.push(a, b, c)
    faceElements?.push(element)
  }
  if (!singularNodes.some(Boolean)) {
    for (const node of exposedTriangles) triangles.push(atNode(node))
  } else {
    faceElements = mesh ? [] : undefined
    const cutVertices = new Map<string, number>()
    visitActiveCells3D(grid, elementType, density, threshold, (nodes, exposed, brickCorners, element) => {
      const ids = brickCorners.map(corner => nodes[corner])
      if (!ids.some(id => singularNodes[id])) {
        checkBudget(triangles.length / 3 + exposed.length)
        for (const { corners: [a, b, c] } of exposed) emit(atNode(nodes[a]), atNode(nodes[b]), atNode(nodes[c]), element)
        return
      }
      // Faces are stored in opposite-vertex order, including interior faces needed to close the cut polygons.
      let faces: ClipFace[] = tetFaces.map(face => ({
        points: face.map(j => simplex[j]), exposed: exposed.some(({ corners }) => face.every(j => corners.includes(brickCorners[j]))),
      }))
      for (let i = 0; i < ids.length; i++) {
        if (singularNodes[ids[i]]) faces = trimContact(faces, point => barycentricUnit - 3 - point[i])
      }
      for (const [a, b] of tetEdges) {
        if (singularEdges.has(edgeKey(ids[a], ids[b]))) {
          faces = trimContact(faces, point => barycentricUnit - 1 - point[a] - point[b])
        }
      }
      for (const { points, exposed } of faces) {
        if (!exposed) continue
        checkBudget(triangles.length / 3 + points.length - 2)
        const polygon = points.map(weights => {
          const support = weights.flatMap((weight, i) => weight ? [{ id: ids[i], weight }] : []).sort((a, b) => a.id - b.id)
          if (support.length === 1) return atNode(support[0].id)
          const key = support.map(({ id, weight }) => id + ':' + weight).join()
          let index = cutVertices.get(key)
          if (index === undefined) {
            const positions = support.map(({ id }) => position(id))
            const origin = positions[0]
            const point = origin.map((value, d) => value + positions.reduce((delta, p, i) =>
              delta + (p[d] - value) * support[i].weight / barycentricUnit, 0))
            index = vertex(point, support.some(({ id }) => !!prescribed?.[id]))
            cutVertices.set(key, index)
          }
          return index
        })
        for (let i = 1; i + 1 < polygon.length; i++) emit(polygon[0], polygon[i], polygon[i + 1], element)
      }
    }, false, mesh)
  }
  return { vertices: Float64Array.from(vertices), triangles: Uint32Array.from(triangles),
    ...(faceElements && { faceElements: Uint32Array.from(faceElements) }),
    ...(prescribed && { pinned: Uint8Array.from(pins) }) }
}
