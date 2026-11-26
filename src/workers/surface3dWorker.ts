/// <reference lib="webworker" />

import { creaseGeometry3D } from '../solver3d/surface3d'
import { CadTriangleBudgetError, prepareCadSurface3D, prepareSurface3D } from '../solver3d/marchingCubes'
import { elementSurface3D } from '../solver3d/mesh3d'
import type { FemGeometry3D, FemRequest3D, SurfaceEvent3D, SurfaceRequest3D } from './protocol3d'

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = ({ data }: MessageEvent<SurfaceRequest3D | FemRequest3D>) => {
  if ('type' in data) {
    const { grid, density, threshold, elementType, wireframe, mesh, ghostThreshold } = data
    const fem = elementSurface3D(grid, elementType, density, threshold, wireframe, mesh)
    const ghost = ghostThreshold === undefined ? undefined : elementSurface3D(grid, elementType, density, ghostThreshold, true, mesh, true)
    const transfers = (g: FemGeometry3D) => [g.positions.buffer, g.triangles.buffer, g.edges.buffer, g.faceElements.buffer]
    scope.postMessage({ ...fem, ...(ghost && { ghost }) }, [...transfers(fem), ...(ghost ? transfers(ghost) : [])])
    return
  }
  const { requestId, density, grid, threshold, smoothing, passive, elementType, cad, mesh } = data
  const send = (event: SurfaceEvent3D, transfer: Transferable[] = []) => scope.postMessage(event, transfer)
  try {
    const { surface, valid } = (cad ? prepareCadSurface3D : prepareSurface3D)(density, grid, threshold, smoothing, passive, elementType, mesh)
    const transfer = [surface.vertices.buffer, surface.triangles.buffer]
    if (surface.pinned) transfer.push(surface.pinned.buffer)
    const render = cad && valid.stl ? creaseGeometry3D(surface) : undefined
    if (render) transfer.push(render.positions.buffer, render.normals.buffer)
    send({ type: 'surface', requestId, surface, valid, render }, transfer)
  } catch (error) {
    send({ type: 'error', requestId, ...(error instanceof CadTriangleBudgetError && { reason: 'triangle-budget' }) })
  }
}
