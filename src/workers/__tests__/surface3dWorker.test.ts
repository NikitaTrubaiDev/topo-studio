import { afterEach, expect, it, vi } from 'vitest'
import { exportObj3D, exportStl3D } from '../../solver3d/export3d'
import type { SurfaceEvent3D, SurfaceRequest3D } from '../protocol3d'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('transfers a tagged surface with cached STL and OBJ validation, and tags failures', async () => {
  const events: SurfaceEvent3D[] = []
  const scope = {
    onmessage: undefined as ((event: { data: SurfaceRequest3D }) => void) | undefined,
    postMessage(event: SurfaceEvent3D, transfer: ArrayBuffer[]) {
      if (event.type === 'surface') expect(transfer).toEqual([event.surface.vertices.buffer, event.surface.triangles.buffer])
      events.push(structuredClone(event, { transfer }))
    },
  }
  vi.stubGlobal('self', scope)
  await import('../surface3dWorker')
  const request: SurfaceRequest3D = {
    requestId: 7, density: Float64Array.of(1, 0, 0, 0, 0), threshold: 0.5, smoothing: 4, elementType: 'tet4',
    grid: { nelx: 1, nely: 1, nelz: 1, widthMm: 2, heightMm: 3, depthMm: 4 },
  }
  scope.onmessage!({ data: request })
  const [result] = events
  expect(result).toMatchObject({ type: 'surface', requestId: 7, valid: { obj: true, stl: true } })
  if (result.type !== 'surface') throw new Error('Expected surface result')
  const { surface } = result
  expect(exportStl3D(surface, true)).toEqual(exportStl3D(surface))
  expect(exportObj3D(surface, true)).toBe(exportObj3D(surface))
  scope.onmessage!({ data: { ...request, requestId: 8, density: Float64Array.of(1) } })
  expect(events[1]).toEqual({ type: 'error', requestId: 8 })
})
