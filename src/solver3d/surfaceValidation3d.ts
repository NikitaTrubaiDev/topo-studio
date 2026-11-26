import { signedTriangleVolume6, triangleNormal, type Surface3D } from './surface3d'

export type SurfaceValidity3D = { obj: boolean; stl: boolean }

type Bounds = { min: number[]; max: number[] }
type Shell = Bounds & { faces: number[]; volume: number }
type BoundsTree<T> = Bounds & ({ items: T[] } | { left: BoundsTree<T>; right: BoundsTree<T> })

function emptyBounds(): Bounds {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
}

function boundsTree<T extends Bounds>(items: T[], start = 0, end = items.length): BoundsTree<T> {
  const box = emptyBounds(), centers = emptyBounds()
  for (let i = start; i < end; i++) for (let d = 0; d < 3; d++) {
    box.min[d] = Math.min(box.min[d], items[i].min[d])
    box.max[d] = Math.max(box.max[d], items[i].max[d])
    const center = items[i].min[d] + items[i].max[d]
    centers.min[d] = Math.min(centers.min[d], center)
    centers.max[d] = Math.max(centers.max[d], center)
  }
  if (end - start <= 8) return { ...box, items: items.slice(start, end) }
  const spread = centers.max.map((max, axis) => max - centers.min[axis])
  const axis = spread.indexOf(Math.max(...spread))
  const middle = (centers.min[axis] + centers.max[axis]) / 2
  let split = start
  for (let i = start; i < end; i++) {
    if (items[i].min[axis] + items[i].max[axis] >= middle) continue
    const item = items[split]
    items[split++] = items[i]
    items[i] = item
  }
  // Prevent deep trees when many bounds have identical or clustered centers.
  if (split - start < (end - start) / 8 || end - split < (end - start) / 8) split = (start + end) >>> 1
  return { ...box, left: boundsTree(items, start, split), right: boundsTree(items, split, end) }
}

function visitBounds<T extends Bounds>(tree: BoundsTree<T>, test: (box: Bounds) => boolean, visit: (item: T) => void) {
  if (!test(tree)) return
  if ('items' in tree) {
    for (const item of tree.items) if (test(item)) visit(item)
  } else {
    visitBounds(tree.left, test, visit)
    visitBounds(tree.right, test, visit)
  }
}

const ray = [1, 0.754877666, 0.569840291]

function faceBounds(vertices: ArrayLike<number>, triangles: Uint32Array, face: number) {
  const box = emptyBounds()
  for (let j = 0; j < 3; j++) for (let d = 0; d < 3; d++) {
    const value = vertices[3 * triangles[3 * face + j] + d]
    box.min[d] = Math.min(box.min[d], value)
    box.max[d] = Math.max(box.max[d], value)
  }
  return { ...box, face }
}

type Vector = [number, number, number]
const subtract = (a: Vector, b: Vector): Vector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vector, b: Vector): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function triangleGeometry(vertices: ArrayLike<number>, triangles: Uint32Array, face: number) {
  function point(corner: number): Vector {
    const i = 3 * triangles[3 * face + corner]
    return [vertices[i], vertices[i + 1], vertices[i + 2]]
  }
  const a = point(0), b = point(1), c = point(2)
  const ab = subtract(b, a), ac = subtract(c, a)
  const edges = [ab, subtract(c, b), subtract(a, c)]
  const normal = cross(ab, ac)
  const extent = Math.max(Math.abs(ab[0]), Math.abs(ab[1]), Math.abs(ab[2]),
    Math.abs(ac[0]), Math.abs(ac[1]), Math.abs(ac[2]))
  return { a, ab, ac, edges, normal, extent }
}

type TriangleGeometry = ReturnType<typeof triangleGeometry>

function trianglesIntersect(p: TriangleGeometry, q: TriangleGeometry) {
  const delta = subtract(q.a, p.a)
  const relativeTolerance = 1e-12 * (p.extent + q.extent)
  function separates(axis: Vector) {
    const p1 = dot(p.ab, axis), p2 = dot(p.ac, axis)
    const q0 = dot(delta, axis), q1 = q0 + dot(q.ab, axis), q2 = q0 + dot(q.ac, axis)
    const tolerance = relativeTolerance * (Math.abs(axis[0]) + Math.abs(axis[1]) + Math.abs(axis[2]))
    return Math.min(q0, q1, q2) - Math.max(0, p1, p2) > tolerance ||
      Math.min(0, p1, p2) - Math.max(q0, q1, q2) > tolerance
  }
  if (separates(p.normal) || separates(q.normal)) return false
  for (const edgeP of p.edges) for (const edgeQ of q.edges) if (separates(cross(edgeP, edgeQ))) return false
  // Include the in-plane edge normals for coplanar triangles.
  for (const edge of p.edges) if (separates(cross(p.normal, edge))) return false
  for (const edge of q.edges) if (separates(cross(q.normal, edge))) return false
  return true
}

function overlaps(a: Bounds, b: Bounds) {
  return a.min[0] <= b.max[0] && b.min[0] <= a.max[0]
    && a.min[1] <= b.max[1] && b.min[1] <= a.max[1]
    && a.min[2] <= b.max[2] && b.min[2] <= a.max[2]
}

function hasNoIntersections(vertices: ArrayLike<number>, triangles: Uint32Array, rejected?: Uint8Array) {
  const faces = Array.from({ length: triangles.length / 3 }, (_, i) => faceBounds(vertices, triangles, i))
  const tree = boundsTree(faces)
  const geometry: (TriangleGeometry | undefined)[] = new Array(faces.length)
  const at = (face: number) => geometry[face] ??= triangleGeometry(vertices, triangles, face)
  let valid = true
  type FaceBounds = ReturnType<typeof faceBounds>
  function compare(a: FaceBounds, b: FaceBounds) {
    const i = 3 * a.face, j = 3 * b.face
    const u = triangles[i], v = triangles[i + 1], w = triangles[i + 2]
    for (let k = j; k < j + 3; k++) {
      const node = triangles[k]
      if (node === u || node === v || node === w) return
    }
    if (!overlaps(a, b) || !trianglesIntersect(at(a.face), at(b.face))) return
    valid = false
    if (rejected) {
      rejected[u] = rejected[v] = rejected[w] = 1
      for (let k = j; k < j + 3; k++) rejected[triangles[k]] = 1
    }
  }
  function visit(a: BoundsTree<FaceBounds>, b: BoundsTree<FaceBounds>) {
    if ((!valid && !rejected) || !overlaps(a, b)) return
    if (a === b) {
      if ('items' in a) {
        for (let i = 0; i < a.items.length; i++) for (let j = i + 1; j < a.items.length; j++) compare(a.items[i], a.items[j])
      } else {
        visit(a.left, a.left)
        visit(a.left, a.right)
        visit(a.right, a.right)
      }
    } else if ('items' in a && 'items' in b) {
      for (const left of a.items) for (const right of b.items) compare(left, right)
    } else if ('items' in a) {
      if (!('items' in b)) {
        visit(a, b.left)
        visit(a, b.right)
      }
    } else if ('items' in b) {
      visit(a.left, b)
      visit(a.right, b)
    } else {
      visit(a.left, b.left)
      visit(a.left, b.right)
      visit(a.right, b.left)
      visit(a.right, b.right)
    }
  }
  visit(tree, tree)
  return valid
}

function rayContains(vertices: ArrayLike<number>, triangles: Uint32Array, tree: BoundsTree<ReturnType<typeof faceBounds>>,
  point: number[]) {
  let intersections = 0, ambiguous = false
  visitBounds(tree, box => {
    let near = 0, far = Infinity
    for (let d = 0; d < 3; d++) {
      near = Math.max(near, (box.min[d] - point[d]) / ray[d])
      far = Math.min(far, (box.max[d] - point[d]) / ray[d])
    }
    return far >= near
  }, ({ face }) => {
    const a = 3 * triangles[3 * face], b = 3 * triangles[3 * face + 1], c = 3 * triangles[3 * face + 2]
    const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2]
    const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1], vz = vertices[c + 2] - vertices[a + 2]
    const px = ray[1] * vz - ray[2] * vy, py = ray[2] * vx - vz, pz = vy - ray[1] * vx
    const det = ux * px + uy * py + uz * pz
    const tx = point[0] - vertices[a], ty = point[1] - vertices[a + 1], tz = point[2] - vertices[a + 2]
    const qx = ty * uz - tz * uy, qy = tz * ux - tx * uz, qz = tx * uy - ty * ux
    const distanceNumerator = vx * qx + vy * qy + vz * qz
    if (det === 0) {
      if (distanceNumerator === 0) ambiguous = true
      return
    }
    const u = (tx * px + ty * py + tz * pz) / det
    const v = (qx + ray[1] * qy + ray[2] * qz) / det
    const w = 1 - u - v
    const tolerance = 1e-10
    if (distanceNumerator / det < 0 || Math.min(u, v, w) < -tolerance) return
    if (distanceNumerator === 0 || Math.min(u, v, w) <= tolerance) ambiguous = true
    intersections += Math.sign(det)
  })
  return ambiguous ? undefined : intersections !== 0
}

function findShells(opposite: Int32Array) {
  const seen = new Uint8Array(opposite.length / 3)
  const shells: number[][] = []
  for (let start = 0; start < seen.length; start++) {
    if (seen[start]) continue
    const faces = [start]
    seen[start] = 1
    for (let i = 0; i < faces.length; i++) {
      const f = 3 * faces[i]
      for (let j = f; j < f + 3; j++) {
        const neighbor = Math.floor(opposite[j] / 3)
        if (!seen[neighbor]) {
          seen[neighbor] = 1
          faces.push(neighbor)
        }
      }
    }
    shells.push(faces)
  }
  return shells
}

function hasOutwardShells(vertices: ArrayLike<number>, triangles: Uint32Array, components: number[][], rejected?: Uint8Array) {
  const shells: Shell[] = []
  for (const faces of components) {
    const shell: Shell = { faces, volume: 0, ...emptyBounds() }
    const origin = triangles[3 * faces[0]]
    for (const face of faces) {
      const f = 3 * face
      shell.volume += signedTriangleVolume6(vertices, triangles[f], triangles[f + 1], triangles[f + 2], origin)
      for (let j = f; j < f + 3; j++) for (let d = 0; d < 3; d++) {
        const value = vertices[3 * triangles[j] + d]
        shell.min[d] = Math.min(shell.min[d], value)
        shell.max[d] = Math.max(shell.max[d], value)
      }
    }
    shells.push(shell)
  }

  const search = boundsTree(shells.slice())
  const triangleTrees = new Map<Shell, BoundsTree<ReturnType<typeof faceBounds>>>()
  function contains(outer: Shell, inner: Shell) {
    // The solid angle is ?4? inside a closed shell and zero outside, even for concave shells.
    const point = 3 * triangles[3 * inner.faces[0]]
    const x = vertices[point], y = vertices[point + 1], z = vertices[point + 2]
    if (outer.faces.length > 64) {
      let tree = triangleTrees.get(outer)
      if (!tree) {
        tree = boundsTree(outer.faces.map(face => faceBounds(vertices, triangles, face)))
        triangleTrees.set(outer, tree)
      }
      const inside = rayContains(vertices, triangles, tree, [x, y, z])
      if (inside !== undefined) return inside
    }
    let winding = 0
    for (const f of outer.faces) {
      const a = 3 * triangles[3 * f], b = 3 * triangles[3 * f + 1], c = 3 * triangles[3 * f + 2]
      const ax = vertices[a] - x, ay = vertices[a + 1] - y, az = vertices[a + 2] - z
      const bx = vertices[b] - x, by = vertices[b + 1] - y, bz = vertices[b + 2] - z
      const cx = vertices[c] - x, cy = vertices[c + 1] - y, cz = vertices[c + 2] - z
      const la = Math.sqrt(ax * ax + ay * ay + az * az)
      const lb = Math.sqrt(bx * bx + by * by + bz * bz)
      const lc = Math.sqrt(cx * cx + cy * cy + cz * cz)
      const ab = ax * bx + ay * by + az * bz, bc = bx * cx + by * cy + bz * cz, ca = cx * ax + cy * ay + cz * az
      const triple = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)
      winding += 2 * Math.atan2(triple, la * lb * lc + ab * lc + bc * la + ca * lb)
    }
    return Math.abs(winding) > 2 * Math.PI
  }

  const netVolumes = new Map<Shell, number>()
  let valid = true
  function reject(shell: Shell) {
    valid = false
    if (!rejected) return
    // A nesting change can come from either wall. Localize it to shells
    // sharing the affected region, leaving independent components untouched.
    visitBounds(search, box => box.min.every((min, axis) => min <= shell.max[axis] && shell.min[axis] <= box.max[axis]), other => {
      for (const face of other.faces) for (let j = 0; j < 3; j++) rejected[triangles[3 * face + j]] = 1
    })
  }
  for (const shell of shells) {
    let depth = 0, outermost = shell
    visitBounds(search, box => box.min.every((min, axis) => min < shell.min[axis] && box.max[axis] > shell.max[axis]), other => {
      if (!contains(other, shell)) return
      depth++
      if (outermost === shell || Math.abs(other.volume) > Math.abs(outermost.volume)) outermost = other
    })
    // Material boundaries point outward at even depth, cavity walls inward at odd depth.
    if (!Number.isFinite(shell.volume) || shell.volume === 0 || (shell.volume > 0) !== (depth % 2 === 0)) reject(shell)
    netVolumes.set(outermost, (netVolumes.get(outermost) ?? 0) + shell.volume)
  }
  for (const [shell, volume] of netVolumes) if (!(Number.isFinite(volume) && volume > 0)) reject(shell)
  return valid
}

/** Prepare the common topology once and check geometry at each format's precision. */
export function surfaceValidator3D(triangles: Uint32Array, count: number) {
  if (!triangles.length || triangles.length % 3 || !Number.isInteger(count)) return undefined
  const edges = new Map<number, number>()
  const outgoing = new Int32Array(count).fill(-1)
  const opposite = new Int32Array(triangles.length)
  const incident = new Uint32Array(count)
  const next = (i: number) => i % 3 === 2 ? i - 2 : i + 1
  for (let i = 0; i < triangles.length; i++) {
    const a = triangles[i], b = triangles[next(i)]
    if (a >= count || b >= count || a === b) return undefined
    const key = a * count + b
    if (edges.has(key)) return undefined
    edges.set(key, i)
    outgoing[a] = i
    incident[a]++
  }
  for (let i = 0; i < triangles.length; i++) {
    const reverse = edges.get(triangles[next(i)] * count + triangles[i])
    if (reverse === undefined) return undefined
    opposite[i] = reverse
  }
  // Also check each vertex link. Opposite half-edges alone permit a pinched vertex.
  for (let v = 0; v < count; v++) {
    const start = outgoing[v]
    if (start < 0) return undefined
    let i = start, degree = 0
    do {
      i = next(opposite[i])
      degree++
    } while (i !== start)
    if (degree !== incident[v]) return undefined
  }
  const shells = findShells(opposite)
  return (vertices: ArrayLike<number>, rejected?: Uint8Array) => {
    let valid = true
    const vertexKeys = new Map<string, number>()
    for (let i = 0; i < vertices.length; i += 3) {
      const a = vertices[i], b = vertices[i + 1], c = vertices[i + 2]
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return false
      const key = a + ',' + b + ',' + c
      const prior = vertexKeys.get(key)
      if (prior !== undefined) {
        if (!rejected) return false
        valid = false
        rejected[prior] = rejected[i / 3] = 1
      }
      vertexKeys.set(key, i / 3)
    }
    for (let i = 0; i < triangles.length; i += 3) {
      if (triangleNormal(vertices, triangles[i], triangles[i + 1], triangles[i + 2]).some(Boolean)) continue
      if (!rejected) return false
      valid = false
      for (let j = 0; j < 3; j++) rejected[triangles[i + j]] = 1
    }
    const outward = hasOutwardShells(vertices, triangles, shells, rejected)
    return hasNoIntersections(vertices, triangles, rejected) && outward && valid
  }
}

export function validateSurface3D(mesh: Surface3D): SurfaceValidity3D {
  const validate = surfaceValidator3D(mesh.triangles, mesh.vertices.length / 3)
  return validate
    ? { obj: validate(mesh.vertices), stl: validate(Float32Array.from(mesh.vertices)) }
    : { obj: false, stl: false }
}

/** Check geometry and oriented manifold connectivity, optionally at binary STL precision. */
export function isWatertight(mesh: Surface3D, stlPrecision = false) {
  const validate = surfaceValidator3D(mesh.triangles, mesh.vertices.length / 3)
  return !!validate?.(stlPrecision ? Float32Array.from(mesh.vertices) : mesh.vertices)
}
