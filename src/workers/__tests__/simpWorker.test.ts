import { afterEach, expect, it, vi } from 'vitest'
import { makePreset } from '../../solver/presets'
import type { WorkerCommand, WorkerEvent } from '../protocol'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('reports completion when asked to step after the final frame', async () => {
  const postMessage = vi.fn<(event: WorkerEvent) => void>()
  const scope = {
    onmessage: undefined as ((event: { data: WorkerCommand }) => void) | undefined,
    postMessage,
  }
  vi.stubGlobal('self', scope)
  await import('../simpWorker')
  const problem = makePreset('mbb', { nelx: 12, nely: 4 })
  problem.params = { ...problem.params, maxIter: 1 }

  scope.onmessage!({ data: { type: 'init', problem } })
  scope.onmessage!({ data: { type: 'step' } })
  expect(postMessage.mock.calls[0][0]).toMatchObject({ type: 'frame', snapshot: { done: true } })
  scope.onmessage!({ data: { type: 'step' } })
  expect(postMessage.mock.calls.map(([event]) => event.type)).toEqual(['frame', 'done'])
})

it('steps once, streams transferable frames, pauses, resumes, and clears queued work on init', async () => {
  vi.useFakeTimers()
  const events: WorkerEvent[] = []
  const scope = {
    onmessage: undefined as ((event: { data: WorkerCommand }) => void) | undefined,
    postMessage(event: WorkerEvent, transfer: ArrayBuffer[]) {
      events.push(structuredClone(event, { transfer }))
    },
  }
  vi.stubGlobal('self', scope)
  await import('../simpWorker')
  const problem = makePreset('mbb', { nelx: 12, nely: 4 })
  const send = (data: WorkerCommand) => scope.onmessage!({ data })
  const iterations = () => events.flatMap(event => event.type === 'frame' ? [event.snapshot.iteration] : [])

  send({ type: 'init', problem })
  send({ type: 'step' })
  expect(iterations()).toEqual([1])
  expect(vi.getTimerCount()).toBe(0)
  send({ type: 'start' })
  vi.advanceTimersToNextTimer()
  send({ type: 'pause' })
  vi.runAllTimers()
  expect(events.at(-1)?.type).toBe('paused')
  expect(iterations()).toEqual([1, 2])
  send({ type: 'start' })
  vi.advanceTimersToNextTimer()
  expect(iterations()).toEqual([1, 2, 3])
  send({ type: 'init', problem })
  vi.runAllTimers()
  expect(iterations()).toEqual([1, 2, 3])
  send({ type: 'step' })
  expect(iterations()).toEqual([1, 2, 3, 1])
})
