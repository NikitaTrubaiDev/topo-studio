// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Preview3D, SurfaceEvent3D, SurfaceRequest3D, WorkerCommand3D, WorkerEvent3D } from '../../workers/protocol3d'
import * as exports3D from '../../solver3d/export3d'
import * as downloads from '../ExportDialog'
import { nodePosition } from '../../solver3d/types3d'
import Workbench3D from '../Workbench3D'

vi.mock('../Viewport3D', () => ({ Viewport3D: () => null }))

class ManualWorker {
  static instances: ManualWorker[] = []
  onmessage?: (event: { data: WorkerEvent3D | SurfaceEvent3D }) => void
  postMessage = vi.fn<(command: WorkerCommand3D | SurfaceRequest3D) => void>()
  terminate = vi.fn()
  constructor() { ManualWorker.instances.push(this) }
}

let mount: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  ManualWorker.instances = []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('Worker', ManualWorker)
  mount = document.body.appendChild(document.createElement('div'))
  root = createRoot(mount)
  act(() => root.render(<Workbench3D active header={transport => transport} />))
})

afterEach(() => {
  act(() => root.unmount())
  mount.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function select(id: string, value: string) {
  const select = mount.querySelector<HTMLSelectElement>(id)!
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function slide(id: string, value: string) {
  const slider = mount.querySelector<HTMLInputElement>(id)!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, value)
    slider.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function preview(worker: ManualWorker, extra: Partial<Preview3D> = {}) {
  const command = worker.postMessage.mock.calls[0][0]
  if (!('type' in command) || command.type !== 'preview') throw new Error('Expected preview command')
  const density = Float64Array.of(1)
  act(() => worker.onmessage?.({ data: { type: 'preview', requestId: command.requestId, density, ...extra } }))
  return command
}

function button(label: string) {
  return Array.from(mount.querySelectorAll('button')).find(button => button.textContent?.includes(label))!
}

it.each(['1e155', '1e-200'])('rejects %s N in both the magnitude editor and an existing nodal load', value => {
  const magnitude = mount.querySelector<HTMLInputElement>('label.force-input-3d input')!
  const loadY = mount.querySelectorAll<HTMLInputElement>('.load-list-3d input')[1]
  for (const field of [magnitude, loadY]) {
    const original = field.value
    act(() => {
      field.focus()
      field.value = value
      field.blur()
    })
    expect(field.value).toBe(original)
    expect(mount.querySelector('[role="alert"]')?.textContent).toContain('Enter a finite force magnitude')
  }
  expect(ManualWorker.instances).toHaveLength(1)
})

it('keeps controls responsive during high-resolution nonlinear Tet4 preview and rejects stale replies', () => {
  const first = ManualWorker.instances[0]
  expect(button('Play').disabled).toBe(true)
  expect(mount.textContent).toContain('Preparing 3D preview')
  select('#preset-3d', 'archBridge3d')
  select('#element-type-3d', 'tet4')
  select('#resolution-3d', '3')
  act(() => mount.querySelector<HTMLInputElement>('aside input[type="checkbox"]')!.click())
  slide('#rmin-3d', '4')
  const latest = ManualWorker.instances.at(-1)!
  const request = latest.postMessage.mock.calls[0][0]
  expect(request).toMatchObject({ type: 'preview', problem: {
    elementType: 'tet4', grid: { nelx: 64, nely: 32, nelz: 20 }, params: { heaviside: true, rmin: 4 },
  } })
  expect(ManualWorker.instances.slice(0, -1).every(worker => worker.terminate.mock.calls.length > 0)).toBe(true)
  preview(first, { issue: 'aspectRatio3dError' })
  expect(button('Play').disabled).toBe(true)
  expect(mount.querySelector('[role="alert"]')).toBeNull()
  const current = preview(latest)
  expect(current.requestId).toBeGreaterThan(1)
  expect(button('Play').disabled).toBe(false)
  expect(mount.textContent).not.toContain('Preparing 3D preview')
  act(() => button('Play').click())
  expect(latest.postMessage).toHaveBeenLastCalledWith({ type: 'start' })
})

it.each(['hex8', 'tet4'])('keeps the solver engine control active after completing %s', elementType => {
  if (elementType === 'tet4') select('#element-type-3d', elementType)
  const worker = ManualWorker.instances.at(-1)!
  preview(worker)
  const receive = (data: WorkerEvent3D) => act(() => worker.onmessage?.({ data }))
  receive({ type: 'engine', engine: 'wasm' })
  act(() => button('Play').click())
  receive({ type: 'frame', snapshot: {
    iteration: 1, density: Float64Array.of(0.4), vonMises: Float64Array.of(1), displacements: [],
    compliance: 12, volFrac: 0.4, change: 0.01, maxVonMises: 1, p95VonMises: 1, done: true, iterMs: 5,
    metrics: { mass: 4, initialMass: 10, saved: 60, maxDeflection: 1 },
  } })
  expect(worker.terminate).not.toHaveBeenCalled()
  const engine = mount.querySelector<HTMLButtonElement>('#solver-engine-3d')!
  expect(engine.disabled).toBe(false)
  act(() => engine.click())
  expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'engine', engine: 'js' })
  receive({ type: 'engine', engine: 'js' })
  expect(engine.dataset.engine).toBe('js')
  act(() => engine.click())
  expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'engine', engine: 'wasm' })
  receive({ type: 'engine', engine: 'wasm' })
  expect(engine.dataset.engine).toBe('wasm')
})

it('cancels superseded surface jobs and downloads both formats using the cached validation', () => {
  const serializeStl = vi.spyOn(exports3D, 'exportStl3D')
  const serializeObj = vi.spyOn(exports3D, 'exportObj3D')
  const download = vi.spyOn(downloads, 'download').mockImplementation(() => {})
  preview(ManualWorker.instances[0])
  act(() => mount.querySelector<HTMLButtonElement>('.export-trigger')!.click())
  const first = ManualWorker.instances.at(-1)!
  const firstRequest = first.postMessage.mock.calls[0][0] as SurfaceRequest3D
  expect(firstRequest).toMatchObject({ threshold: 0.5, smoothing: 4 })
  expect(button('.STL').disabled).toBe(true)
  expect(mount.textContent).toContain('Preparing CAD surface')
  slide('#threshold-3d', '0.6')
  const latest = ManualWorker.instances.at(-1)!
  const latestRequest = latest.postMessage.mock.calls[0][0] as SurfaceRequest3D
  expect(latestRequest.threshold).toBe(0.6)
  expect(latestRequest.requestId).toBeGreaterThan(firstRequest.requestId)
  expect(first.terminate).toHaveBeenCalled()

  const surface = {
    vertices: Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1),
    triangles: Uint32Array.of(1, 2, 3, 0, 3, 2, 0, 1, 3, 0, 2, 1),
  }
  const event = { type: 'surface', surface, valid: { obj: true, stl: true } } as const
  act(() => first.onmessage?.({ data: { ...event, requestId: firstRequest.requestId } }))
  expect(button('.STL').disabled).toBe(true)
  act(() => latest.onmessage?.({ data: { ...event, requestId: latestRequest.requestId } }))
  expect(button('.STL').disabled || button('.OBJ').disabled).toBe(false)
  act(() => { button('.STL').click(); button('.OBJ').click() })
  expect(serializeStl).toHaveBeenCalledExactlyOnceWith(surface, true)
  expect(serializeObj).toHaveBeenCalledExactlyOnceWith(surface, true)
  expect(download).toHaveBeenCalledTimes(2)
  expect(latest.postMessage).toHaveBeenCalledTimes(1)
})

it('keeps edited adaptive loads at the same normalized position when height changes from 60 to 80 mm', () => {
  select('#element-type-3d', 'adaptiveTet4')
  const loadY = mount.querySelectorAll<HTMLInputElement>('.load-list-3d input')[1]
  act(() => {
    loadY.focus()
    loadY.value = '-123'
    loadY.blur()
  })
  const prior = preview(ManualWorker.instances.at(-1)!).problem
  expect(prior.loadCases[0].forces[0].fy).toBe(-123)
  expect(button('Undo').disabled).toBe(false)
  const height = mount.querySelector<HTMLInputElement>('#heightMm-3d')!
  act(() => {
    height.focus()
    height.value = '80'
    height.blur()
  })
  const next = preview(ManualWorker.instances.at(-1)!).problem
  expect([prior.grid.nely, next.grid.nely]).toEqual([12, 16])
  const oldLoad = prior.loadCases[0].forces[0], newLoad = next.loadCases[0].forces[0]
  expect(newLoad.node).not.toBe(oldLoad.node)
  expect(newLoad.fy).toBe(-123)
  expect(nodePosition(prior.grid, oldLoad.node)).toEqual([120, 30, 20])
  expect(nodePosition(next.grid, newLoad.node)).toEqual([120, 40, 20])
  expect(button('Undo').disabled).toBe(true)
})
