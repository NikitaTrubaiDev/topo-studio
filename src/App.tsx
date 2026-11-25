import { useEffect, useMemo, useRef, useState } from 'react'
import { ConvergenceChart, type Sample } from './components/ConvergenceChart'
import { Controls, resolutions, type Settings } from './components/Controls'
import { Viewport } from './components/Viewport'
import { defaultParams, makePreset, materials, presets } from './solver/presets'
import type { TimedSnapshot, WorkerCommand, WorkerEvent } from './workers/protocol'

type RunState = 'ready' | 'running' | 'pausing' | 'paused' | 'stepping' | 'complete' | 'error'

const initialSettings: Settings = { preset: 'mbb', resolution: '48 × 16', material: 'steel', params: defaultParams }
const stateLabels: Record<RunState, string> = {
  ready: 'Ready',
  running: 'Running',
  pausing: 'Pausing',
  paused: 'Paused',
  stepping: 'Stepping',
  complete: 'Complete',
  error: 'Solver error',
}

function display(value: number | undefined, digits: number) {
  return value === undefined ? '—' : value.toPrecision(digits)
}

export default function App() {
  const [settings, setSettings] = useState(initialSettings)
  const [runState, setRunState] = useState<RunState>('ready')
  const [frame, setFrame] = useState<TimedSnapshot>()
  const [samples, setSamples] = useState<Sample[]>([])
  const [error, setError] = useState('')
  const workerRef = useRef<Worker | null>(null)
  const paintRequest = useRef<number | undefined>(undefined)
  const queued = useRef<TimedSnapshot | undefined>(undefined)
  const problem = useMemo(() => makePreset(
    settings.preset, resolutions[settings.resolution], settings.params, materials[settings.material],
  ), [settings])

  useEffect(() => () => {
    workerRef.current?.terminate()
    workerRef.current = null
    if (paintRequest.current !== undefined) cancelAnimationFrame(paintRequest.current)
    paintRequest.current = undefined
    queued.current = undefined
  }, [])

  function reset() {
    workerRef.current?.terminate()
    workerRef.current = null
    if (paintRequest.current !== undefined) cancelAnimationFrame(paintRequest.current)
    paintRequest.current = undefined
    queued.current = undefined
    setFrame(undefined)
    setSamples([])
    setError('')
    setRunState('ready')
  }

  function changeSettings(value: Settings) {
    reset()
    setSettings(value)
  }

  function send(type: 'start' | 'pause' | 'step') {
    try {
      let worker = workerRef.current
      if (!worker) {
        const instance = new Worker(new URL('./workers/simpWorker.ts', import.meta.url), { type: 'module' })
        workerRef.current = instance
        instance.onmessage = ({ data }: MessageEvent<WorkerEvent>) => {
          if (workerRef.current !== instance) return
          switch (data.type) {
            case 'frame': {
              const { snapshot } = data
              const { iteration, compliance, volFrac, done } = snapshot
              setSamples(current => [...current, { iteration, compliance, volFrac }])
              queued.current = snapshot
              if (paintRequest.current === undefined) {
                paintRequest.current = requestAnimationFrame(() => {
                  setFrame(queued.current)
                  paintRequest.current = undefined
                })
              }
              setRunState(state => done ? 'complete' : state === 'stepping' ? 'paused' : state)
              break
            }
            case 'paused':
              setRunState(state => state === 'complete' || state === 'error' ? state : 'paused')
              break
            case 'done':
              setRunState('complete')
              break
            case 'error':
              setError(data.message)
              setRunState('error')
              break
          }
        }
        instance.onerror = event => {
          if (workerRef.current !== instance) return
          setError(event.message || 'The optimization worker could not start.')
          setRunState('error')
        }
        instance.postMessage({ type: 'init', problem } satisfies WorkerCommand)
        worker = instance
      }
      setRunState(type === 'start' ? 'running' : type === 'pause' ? 'pausing' : 'stepping')
      worker.postMessage({ type } satisfies WorkerCommand)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setRunState('error')
    }
  }

  const canRun = runState === 'ready' || runState === 'paused'
  const metrics = [
    { label: 'Iteration', value: frame?.iteration ?? '—', unit: '' },
    { label: 'Compliance', value: display(frame?.compliance, 4), unit: 'N·mm' },
    { label: 'Volume', value: frame ? (frame.volFrac * 100).toFixed(1) : '—', unit: '%' },
    { label: 'Max change', value: frame ? frame.change.toFixed(4) : '—', unit: '' },
    { label: 'Time / iter', value: frame ? frame.iterMs.toFixed(1) : '—', unit: 'ms' },
    { label: 'Max von Mises', value: display(frame?.maxVonMises, 4), unit: 'MPa' },
  ]

  return (
    <div className="min-h-screen antialiased">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">T</span>
          <div><h1>TopoStudio</h1><p>2D topology optimization</p></div>
        </div>
        <div className="transport" role="group" aria-label="Solver playback">
          <button type="button" onClick={() => send('start')} disabled={!canRun} className="play"><span aria-hidden="true">▶</span> Play</button>
          <button type="button" onClick={() => send('pause')} disabled={runState !== 'running'}><span aria-hidden="true">Ⅱ</span> Pause</button>
          <button type="button" onClick={() => send('step')} disabled={!canRun}><span aria-hidden="true">▸│</span> Step</button>
          <button type="button" onClick={reset} disabled={runState === 'ready'}><span aria-hidden="true">↺</span> Reset</button>
        </div>
      </header>
      <main className="workspace">
        <Controls settings={settings} setSettings={changeSettings} />
        <div className="results">
          <div className="result-header">
            <h2>{presets[settings.preset].name}</h2>
            <span className={`status status-${runState}`} role="status"><i />{stateLabels[runState]}</span>
          </div>
          {error && <p role="alert" className="error">{error} Reset to run again.</p>}
          <Viewport problem={problem} frame={frame} />
          <section className="panel telemetry" aria-label="Iteration telemetry">
            <dl>{metrics.map(({ label, value, unit }) => (
              <div key={label}><dt>{label}</dt><dd>{value}{unit && <span>{unit}</span>}</dd></div>
            ))}</dl>
          </section>
          <ConvergenceChart samples={samples} target={settings.params.volFrac} />
        </div>
      </main>
    </div>
  )
}
