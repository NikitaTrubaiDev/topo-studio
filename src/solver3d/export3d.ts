import { signedTriangleVolume6, triangleNormal, vertexNormals, type Surface3D } from './marchingCubes'

type Shell = { faces: number[]; min: number[]; max: number[]; volume: number }

function hasOutwardShells(vertices: ArrayLike<number>, triangles: Uint32Array, opposite: Int32Array) {
  const seen = new Uint8Array(triangles.length / 3)
  const shells: Shell[] = []
  for (let start = 0; start < seen.length; start++) {
    if (seen[start]) continue
    const shell: Shell = { faces: [start], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], volume: 0 }
    const origin = triangles[3 * start]
    seen[start] = 1
    for (let i = 0; i < shell.faces.length; i++) {
      const f = 3 * shell.faces[i]
      shell.volume += signedTriangleVolume6(vertices, triangles[f], triangles[f + 1], triangles[f + 2], origin)
      for (let j = f; j < f + 3; j++) {
        const neighbor = Math.floor(opposite[j] / 3)
        if (!seen[neighbor]) {
          seen[neighbor] = 1
          shell.faces.push(neighbor)
        }
        for (let d = 0; d < 3; d++) {
          const value = vertices[3 * triangles[j] + d]
          shell.min[d] = Math.min(shell.min[d], value)
          shell.max[d] = Math.max(shell.max[d], value)
        }
      }
    }
    if (!Number.isFinite(shell.volume) || shell.volume === 0) return false
    shells.push(shell)
  }

  function contains(outer: Shell, inner: Shell) {
    if (!outer.min.every((min, axis) => min < inner.min[axis] && outer.max[axis] > inner.max[axis])) return false
    // The solid angle is ±4π inside a closed shell and zero outside, even for concave shells.
    const point = 3 * triangles[3 * inner.faces[0]]
    const vector = (vertex: number) => [0, 1, 2].map(d => vertices[3 * vertex + d] - vertices[point + d])
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    let winding = 0
    for (const f of outer.faces) {
      const a = vector(triangles[3 * f]), b = vector(triangles[3 * f + 1]), c = vector(triangles[3 * f + 2])
      const [nx, ny, nz] = triangleNormal(vertices, triangles[3 * f], triangles[3 * f + 1], triangles[3 * f + 2])
      const [la, lb, lc] = [Math.hypot(...a), Math.hypot(...b), Math.hypot(...c)]
      winding += 2 * Math.atan2(nx * a[0] + ny * a[1] + nz * a[2], la * lb * lc + dot(a, b) * lc + dot(b, c) * la + dot(c, a) * lb)
    }
    return Math.abs(winding) > 2 * Math.PI
  }

  const netVolumes = new Map<Shell, number>()
  for (const shell of shells) {
    let depth = 0, outermost = shell
    for (const other of shells) {
      if (!contains(other, shell)) continue
      depth++
      if (outermost === shell || Math.abs(other.volume) > Math.abs(outermost.volume)) outermost = other
    }
    // Material boundaries point outward at even depth, cavity walls inward at odd depth.
    if ((shell.volume > 0) !== (depth % 2 === 0)) return false
    netVolumes.set(outermost, (netVolumes.get(outermost) ?? 0) + shell.volume)
  }
  return [...netVolumes.values()].every(volume => Number.isFinite(volume) && volume > 0)
}

/** Check geometry and oriented manifold connectivity, optionally at binary STL precision. */
export function isWatertight(mesh: Surface3D, stlPrecision = false) {
  const { triangles } = mesh
  const vertices = stlPrecision ? Float32Array.from(mesh.vertices) : mesh.vertices
  if (!triangles.length || triangles.length % 3 || vertices.length % 3 || vertices.some(value => !Number.isFinite(value))) return false
  const vertexKeys = new Set<string>()
  for (let i = 0; i < vertices.length; i += 3) {
    const key = `${vertices[i]},${vertices[i + 1]},${vertices[i + 2]}`
    if (vertexKeys.has(key)) return false
    vertexKeys.add(key)
  }
  const count = vertices.length / 3
  const edges = new Map<number, number>()
  const outgoing = new Int32Array(count).fill(-1)
  const opposite = new Int32Array(triangles.length)
  const incident = new Uint32Array(count)
  const next = (i: number) => i % 3 === 2 ? i - 2 : i + 1
  for (let i = 0; i < triangles.length; i++) {
    const a = triangles[i], b = triangles[next(i)]
    if (a >= count || b >= count || a === b) return false
    const key = a * count + b
    if (edges.has(key)) return false
    edges.set(key, i)
    outgoing[a] = i
    incident[a]++
    if (i % 3 === 2 && !triangleNormal(vertices, triangles[i - 2], triangles[i - 1], a).some(Boolean)) return false
  }
  for (let i = 0; i < triangles.length; i++) {
    const reverse = edges.get(triangles[next(i)] * count + triangles[i])
    if (reverse === undefined) return false
    opposite[i] = reverse
  }
  // Also check each vertex link. Opposite half-edges alone permit a pinched vertex.
  for (let v = 0; v < count; v++) {
    const start = outgoing[v]
    if (start < 0) return false
    let i = start, degree = 0
    do {
      i = next(opposite[i])
      degree++
    } while (i !== start)
    if (degree !== incident[v]) return false
  }
  return hasOutwardShells(vertices, triangles, opposite)
}

export function exportStl3D(mesh: Surface3D) {
  if (!isWatertight(mesh, true)) throw new RangeError('STL requires a watertight surface')
  const vertices = Float32Array.from(mesh.vertices)
  const { triangles } = mesh
  const triangleCount = triangles.length / 3
  const data = new ArrayBuffer(84 + 50 * triangleCount)
  const view = new DataView(data)
  const label = 'TopoStudio 3D | millimetres'
  for (let i = 0; i < label.length; i++) view.setUint8(i, label.charCodeAt(i))
  view.setUint32(80, triangleCount, true)
  for (let i = 0, offset = 84; i < triangles.length; i += 3, offset += 50) {
    const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2]
    const normal = triangleNormal(vertices, a, b, c)
    const length = Math.hypot(...normal)
    for (let d = 0; d < 3; d++) {
      view.setFloat32(offset + d * 4, normal[d] / length, true)
      view.setFloat32(offset + 12 + d * 4, vertices[3 * a + d], true)
      view.setFloat32(offset + 24 + d * 4, vertices[3 * b + d], true)
      view.setFloat32(offset + 36 + d * 4, vertices[3 * c + d], true)
    }
  }
  return data
}

export function exportObj3D(mesh: Surface3D) {
  if (!isWatertight(mesh)) throw new RangeError('OBJ requires a watertight surface')
  const { vertices, triangles } = mesh
  const normals = vertexNormals(mesh)
  const lines = ['# TopoStudio 3D | millimetres', 'o TopoStudio']
  for (let i = 0; i < vertices.length; i += 3) lines.push(`v ${vertices[i]} ${vertices[i + 1]} ${vertices[i + 2]}`)
  for (let i = 0; i < normals.length; i += 3) lines.push(`vn ${normals[i]} ${normals[i + 1]} ${normals[i + 2]}`)
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i] + 1, b = triangles[i + 1] + 1, c = triangles[i + 2] + 1
    lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`)
  }
  return lines.join('\n') + '\n'
}
