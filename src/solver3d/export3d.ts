import { triangleNormal, vertexNormals, type Surface3D } from './marchingCubes'

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
  return true
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
