import { BufferAttribute, BufferGeometry, DoubleSide, FrontSide, Mesh, MeshBasicMaterial, type Object3D, type Plane, type Raycaster, type Vector3 } from 'three'
import { nodeTouchesMaterial3D, snapNode3D } from '../solver3d/design3d'
import { elementSurface3D } from '../solver3d/mesh3d'
import { nodePosition, type Grid3D } from '../solver3d/types3d'

export function pointVisible3D(point: Vector3, planes: readonly Plane[]) {
  return planes.every(plane => plane.distanceToPoint(point) >= 0)
}

export function firstVisibleMeshHit3D(ray: Raycaster, root: Object3D, planes: readonly Plane[], maxDistance = Infinity) {
  const meshes: Mesh[] = []
  root.traverseVisible(object => {
    if (object instanceof Mesh && !Array.isArray(object.material) && object.material.visible) meshes.push(object)
  })
  return ray.intersectObjects(meshes, false).find(hit => hit.distance <= maxDistance && pointVisible3D(hit.point, planes))
}

export function snapEditNode3D(grid: Grid3D, hit: Vector3, voidMask: Uint8Array, planes: readonly Plane[]) {
  const node = snapNode3D(grid, hit.toArray())
  const point = hit.clone().fromArray(nodePosition(grid, node))
  return { node, point, valid: nodeTouchesMaterial3D(grid, node, voidMask) && pointVisible3D(point, planes) }
}

export function designDomainMesh3D(grid: Grid3D, voidMask: Uint8Array, sectioned: boolean) {
  const designable = Uint8Array.from(voidMask, value => 1 - value)
  const { positions, triangles } = elementSurface3D(grid, 'hex8', designable, 0.5, false)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setIndex(new BufferAttribute(triangles, 1))
  return new Mesh(geometry, new MeshBasicMaterial({ side: sectioned ? DoubleSide : FrontSide }))
}
