/// <reference lib="webworker" />

import { creaseGeometry3D } from '../solver3d/surface3d'
import { CadTriangleBudgetError, prepareCadSurface3D, prepareSurface3D } from '../solver3d/marchingCubes'
import { elementSurface3D } from '../solver3d/mesh3d'
import type { FemRequest3D, SurfaceEvent3D, SurfaceRequest3D } from './protocol3d'

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = ({ data }: MessageEvent<SurfaceRequest3D | FemRequest3D>) => {
  if ('type' in data) {
    const { grid, density, threshold, elementType, wireframe } = data
    const mesh = elementSurface3D(grid, elementType, density, threshold, wireframe)
    scope.postMessage(mesh, [mesh.positions.buffer, mesh.triangles.buffer, mesh.edges.buffer])
    return
  }
  const { requestId, density, grid, threshold, smoothing, passive, elementType, cad } = data
  const send = (event: SurfaceEvent3D, transfer: Transferable[] = []) => scope.postMessage(event, transfer)
  try {
    const { surface, valid } = (cad ? prepareCadSurface3D : prepareSurface3D)(density, grid, threshold, smoothing, passive, elementType)
    const transfer = [surface.vertices.buffer, surface.triangles.buffer]
    if (surface.pinned) transfer.push(surface.pinned.buffer)
    const render = cad && valid.stl ? creaseGeometry3D(surface) : undefined
    if (render) transfer.push(render.positions.buffer, render.normals.buffer)
    send({ type: 'surface', requestId, surface, valid, render }, transfer)
  } catch (error) {
    send({ type: 'error', requestId, ...(error instanceof CadTriangleBudgetError && { reason: 'triangle-budget' }) })
  }
}
