export const cadTriangleBudget = 250_000
export class CadTriangleBudgetError extends RangeError {}

﻿export interface Surface3D {
  /** Interleaved XYZ coordinates in mm. */
  vertices: Float64Array
  /** Counterclockwise triangle indices as seen from outside. */
  triangles: Uint32Array
  /** Vertices on the boundary of a prescribed material or void cell. */
  pinned?: Uint8Array
  /** Adaptive material element that emitted each triangle. */
  faceElements?: Uint32Array
}

export function triangleNormal(vertices: ArrayLike<number>, a: number, b: number, c: number): [number, number, number] {
  a *= 3; b *= 3; c *= 3
  const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2]
  const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1], vz = vertices[c + 2] - vertices[a + 2]
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
}

/** Six times the oriented tetrahedron volume relative to a reference vertex. */
export function signedTriangleVolume6(vertices: ArrayLike<number>, a: number, b: number, c: number, origin: number) {
  const [nx, ny, nz] = triangleNormal(vertices, a, b, c)
  a *= 3; origin *= 3
  return nx * (vertices[a] - vertices[origin]) + ny * (vertices[a + 1] - vertices[origin + 1])
    + nz * (vertices[a + 2] - vertices[origin + 2])
}

/** Expand render corners so a shared position can carry separate crease normals. */
export function creaseGeometry3D({ vertices, triangles }: Surface3D, creaseDegrees = 50) {
  const count = vertices.length / 3
  const first = new Int32Array(count).fill(-1)
  const next = new Int32Array(triangles.length)
  const facets = new Float64Array(triangles.length)
  const positions = new Float32Array(3 * triangles.length)
  const normals = new Float32Array(positions.length)
  const cosine = Math.cos(creaseDegrees * Math.PI / 180)
  for (let i = 0; i < triangles.length; i += 3) {
    const [x, y, z] = triangleNormal(vertices, triangles[i], triangles[i + 1], triangles[i + 2])
    const length = Math.hypot(x, y, z)
    facets.set(length ? [x / length, y / length, z / length] : [0, 0, 1], i)
    for (let j = i; j < i + 3; j++) {
      const node = triangles[j]
      next[j] = first[node]
      first[node] = j
    }
  }
  for (let i = 0; i < triangles.length; i++) {
    const node = triangles[i], face = i - i % 3
    const a = facets[face], b = facets[face + 1], c = facets[face + 2]
    let x = 0, y = 0, z = 0
    for (let j = first[node]; j !== -1; j = next[j]) {
      const other = j - j % 3
      const nx = facets[other], ny = facets[other + 1], nz = facets[other + 2]
      if (a * nx + b * ny + c * nz <= cosine) continue
      // Weight by corner angle so subdividing a planar face does not bias a normal.
      const from = 3 * triangles[j], left = 3 * triangles[other + (j % 3 + 1) % 3], right = 3 * triangles[other + (j % 3 + 2) % 3]
      const ux = vertices[left] - vertices[from], uy = vertices[left + 1] - vertices[from + 1], uz = vertices[left + 2] - vertices[from + 2]
      const vx = vertices[right] - vertices[from], vy = vertices[right + 1] - vertices[from + 1], vz = vertices[right + 2] - vertices[from + 2]
      const dot = ux * vx + uy * vy + uz * vz
      const cross = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
      const angle = Math.atan2(cross, dot)
      x += nx * angle; y += ny * angle; z += nz * angle
    }
    const length = Math.hypot(x, y, z)
    const offset = 3 * i
    positions[offset] = vertices[3 * node]
    positions[offset + 1] = vertices[3 * node + 1]
    positions[offset + 2] = vertices[3 * node + 2]
    normals[offset] = length ? x / length : a
    normals[offset + 1] = length ? y / length : b
    normals[offset + 2] = length ? z / length : c
  }
  return { positions, normals }
}
