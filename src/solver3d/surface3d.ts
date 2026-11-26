export interface Surface3D {
  /** Interleaved XYZ coordinates in mm. */
  vertices: Float64Array
  /** Counterclockwise triangle indices as seen from outside. */
  triangles: Uint32Array
  /** Vertices on the boundary of a prescribed material or void cell. */
  pinned?: Uint8Array
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
