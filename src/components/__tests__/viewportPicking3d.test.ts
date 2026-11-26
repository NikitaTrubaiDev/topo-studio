import { BoxGeometry, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Plane, Raycaster, Vector3 } from 'three'
import { expect, it } from 'vitest'
import { brickMasks3D } from '../../solver3d/design3d'
import { makePreset3D, presetGrid3D, resolutions3D } from '../../solver3d/presets3d'
import { arrowLength } from '../Viewport3D'
import { designDomainMesh3D, firstVisibleMeshHit3D, snapEditNode3D } from '../viewportPicking3d'

it('picks non-void faces and rejects clipped or detached snap nodes', () => {
  const grid = presetGrid3D(resolutions3D[0])
  const { voidMask } = brickMasks3D(makePreset3D('lBracket3d', grid))
  const mesh = designDomainMesh3D(grid, voidMask, true)
  const throughCutout = new Raycaster(new Vector3(110, 50, 80), new Vector3(0, 0, -1))
  expect(firstVisibleMeshHit3D(throughCutout, mesh, [])).toBeUndefined()
  const ray = new Raycaster(new Vector3(110, 10, 80), new Vector3(0, 0, -1))
  const surface = firstVisibleMeshHit3D(ray, mesh, [])!
  expect(surface.point.z).toBe(40)
  const section = [new Plane(new Vector3(0, 0, -1), 21)]
  expect(firstVisibleMeshHit3D(ray, mesh, section)?.point.z).toBe(0)
  expect(snapEditNode3D(grid, surface.point, voidMask, []).valid).toBe(true)
  expect(snapEditNode3D(grid, new Vector3(110, 50, 40), voidMask, []).valid).toBe(false)
  expect(snapEditNode3D(grid, new Vector3(110, 10, 22.2), voidMask, [new Plane(new Vector3(0, 0, -1), 24)]).valid).toBe(true)
  expect(snapEditNode3D(grid, new Vector3(110, 10, 23.2), voidMask, [new Plane(new Vector3(0, 0, -1), 24)]).valid).toBe(false)
})

it('hits only visible boundary marker instances within the section and in front of occluding geometry', () => {
  const overlay = new Group()
  const markers = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 1)
  markers.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, 2))
  overlay.add(markers)
  const ray = new Raycaster(new Vector3(0, 0, 5), new Vector3(0, 0, -1))
  expect(firstVisibleMeshHit3D(ray, overlay, [])?.instanceId).toBe(0)
  expect(firstVisibleMeshHit3D(ray, overlay, [], 2)).toBeUndefined()
  expect(firstVisibleMeshHit3D(ray, overlay, [new Plane(new Vector3(0, 0, -1), 1)])).toBeUndefined()
  overlay.visible = false
  expect(firstVisibleMeshHit3D(ray, overlay, [])).toBeUndefined()
})

it.each([1e155, 1e-200, Infinity, NaN])('does not render an out-of-range %s N force arrow', magnitude => {
  expect(arrowLength(100, magnitude, 100)).toBe(0)
  expect(arrowLength(100, 100, magnitude)).toBeCloseTo(17.5)
})
