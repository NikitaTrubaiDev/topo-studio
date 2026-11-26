import { signedTriangleVolume6, triangleNormal, type Surface3D } from './surface3d'

export type SurfaceValidity3D = { obj: boolean; stl: boolean }

type Shell = { faces: number[]; min: number[]; max: number[]; volume: number }

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
    const shell: Shell = { faces, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], volume: 0 }
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

  function contains(outer: Shell, inner: Shell) {
    if (!outer.min.every((min, axis) => min < inner.min[axis] && outer.max[axis] > inner.max[axis])) return false
    // The solid angle is ?4? inside a closed shell and zero outside, even for concave shells.
    const point = 3 * triangles[3 * inner.faces[0]]
    const x = vertices[point], y = vertices[point + 1], z = vertices[point + 2]
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
    for (const other of shells) {
      if (!other.min.every((min, axis) => min <= shell.max[axis] && shell.min[axis] <= other.max[axis])) continue
      for (const face of other.faces) for (let j = 0; j < 3; j++) rejected[triangles[3 * face + j]] = 1
    }
  }
  for (const shell of shells) {
    let depth = 0, outermost = shell
    for (const other of shells) {
      if (!contains(other, shell)) continue
      depth++
      if (outermost === shell || Math.abs(other.volume) > Math.abs(outermost.volume)) outermost = other
    }
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
    return hasOutwardShells(vertices, triangles, shells, rejected) && valid
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
