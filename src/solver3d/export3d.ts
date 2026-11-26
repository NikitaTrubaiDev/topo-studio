import { vertexNormals } from './marchingCubes'
import { triangleNormal, type Surface3D } from './surface3d'
import { isWatertight } from './surfaceValidation3d'

export { isWatertight } from './surfaceValidation3d'

/** Skip validation only for a mesh already checked at binary STL precision. */
export function exportStl3D(mesh: Surface3D, skipValidation = false) {
  if (!skipValidation && !isWatertight(mesh, true)) throw new RangeError('STL requires a watertight surface')
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

/** Skip validation only for a mesh already checked at OBJ precision. */
export function exportObj3D(mesh: Surface3D, skipValidation = false) {
  if (!skipValidation && !isWatertight(mesh)) throw new RangeError('OBJ requires a watertight surface')
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
