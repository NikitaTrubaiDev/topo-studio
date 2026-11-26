/// <reference lib="webworker" />

import { prepareSurface3D } from '../solver3d/marchingCubes'
import type { SurfaceEvent3D, SurfaceRequest3D } from './protocol3d'

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = ({ data }: MessageEvent<SurfaceRequest3D>) => {
  const { requestId, density, grid, threshold, smoothing, passive, elementType } = data
  const send = (event: SurfaceEvent3D, transfer: Transferable[] = []) => scope.postMessage(event, transfer)
  try {
    const { surface, valid } = prepareSurface3D(density, grid, threshold, smoothing, passive, elementType)
    const transfer = [surface.vertices.buffer, surface.triangles.buffer]
    if (surface.pinned) transfer.push(surface.pinned.buffer)
    send({ type: 'surface', requestId, surface, valid }, transfer)
  } catch {
    send({ type: 'error', requestId })
  }
}
