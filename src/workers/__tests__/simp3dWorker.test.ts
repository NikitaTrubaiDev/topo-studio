import { afterEach, expect, it, vi } from 'vitest'
import { defaultParams3D, makePreset3D, presetGrid3D } from '../../solver3d/presets3d'
import type { WorkerCommand3D, WorkerEvent3D } from '../protocol3d'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('transfers frames and preserves warm state across step, pause, and resume until reset', async () => {
  vi.useFakeTimers()
  const events: WorkerEvent3D[] = []
  const scope = {
    onmessage: undefined as ((event: { data: WorkerCommand3D }) => void) | undefined,
    postMessage(event: WorkerEvent3D, transfer: ArrayBuffer[]) {
      if (event.type === 'frame') expect(transfer).toHaveLength(2 + event.snapshot.displacements.length)
      events.push(structuredClone(event, { transfer }))
    },
  }
  vi.stubGlobal('self', scope)
  await import('../simp3dWorker')
  const grid = presetGrid3D([6, 4, 4])
  const problem = makePreset3D('cantilever3d', grid, { ...defaultParams3D, maxIter: 3, changeTol: 0 })
  const send = (data: WorkerCommand3D) => scope.onmessage!({ data })
  send({ type: 'init', problem })
  send({ type: 'step' })
  expect(events[0]).toMatchObject({ type: 'frame', snapshot: { iteration: 1, done: false } })
  expect(events[1]).toEqual({ type: 'paused' })
  expect(vi.getTimerCount()).toBe(0)
  send({ type: 'start' })
  vi.advanceTimersToNextTimer()
  send({ type: 'pause' })
  expect(events[2]).toMatchObject({ type: 'frame', snapshot: { iteration: 2, done: false } })
  expect(vi.getTimerCount()).toBe(0)
  send({ type: 'start' })
  vi.runAllTimers()
  expect(events.at(-1)).toMatchObject({ type: 'frame', snapshot: { iteration: 3, done: true } })
  expect(vi.getTimerCount()).toBe(0)
  send({ type: 'step' })
  expect(events.at(-1)).toEqual({ type: 'done' })
  send({ type: 'init', problem })
  send({ type: 'start' })
  send({ type: 'reset' })
  vi.runAllTimers()
  expect(events.at(-1)).toEqual({ type: 'done' })
  send({ type: 'init', problem })
  send({ type: 'step' })
  expect(events.at(-2)).toMatchObject({ type: 'frame', snapshot: { iteration: 1 } })
})

it('reports the final true relative residual when PCG fails', async () => {
  const scope = {
    onmessage: undefined as ((event: { data: WorkerCommand3D }) => void) | undefined,
    postMessage: vi.fn<(event: WorkerEvent3D) => void>(),
  }
  vi.stubGlobal('self', scope)
  const { Pcg3D } = await import('../../solver3d/pcg3d')
  const solve = vi.spyOn(Pcg3D.prototype, 'solve').mockReturnValue({ converged: false, iterations: 4000, relativeResidual: 0.0125 })
  try {
    await import('../simp3dWorker')
    const problem = makePreset3D('cantilever3d', presetGrid3D([6, 4, 4]))
    scope.onmessage!({ data: { type: 'init', problem } })
    scope.onmessage!({ data: { type: 'step' } })
    expect(scope.postMessage.mock.calls[0][0]).toEqual({ type: 'error', issue: 'solve3dError', relativeResidual: 0.0125 })
  } finally {
    solve.mockRestore()
  }
})
