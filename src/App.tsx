import { useEffect, useMemo, useRef, useState } from 'react'
import { ConvergenceChart, type Sample } from './components/ConvergenceChart'
import { Controls, resolutions, type Settings } from './components/Controls'
import { Viewport, type ViewMode } from './components/Viewport'
import { LoadCases } from './components/LoadCases'
import { ExportDialog, type ContourSettings } from './components/ExportDialog'
import { contourField, extractContours } from './solver/contour'
import { addLoadCase, hasFreeLoad, supportError } from './solver/design'
import type { SimpProblem } from './solver/types'
import { defaultParams, makePreset, materials, presets } from './solver/presets'
import type { TimedSnapshot, WorkerCommand, WorkerEvent } from './workers/protocol'

type Design = Pick<SimpProblem, 'supports' | 'loadCases' | 'passive'>
interface History {
  past: Design[]
  present?: Design
  future: Design[]
}
const initialHistory: History = { past: [], future: [] }

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
  const [history, setHistory] = useState(initialHistory)
  const [selectedCase, setSelectedCase] = useState(0)
  const [mode, setMode] = useState<ViewMode>('density')
  const [exportOpen, setExportOpen] = useState(false)
  const [contour, setContour] = useState<ContourSettings>({ threshold: 0.5, smoothing: 3, thickness: 10 })
  const workerRef = useRef<Worker | null>(null)
  const paintRequest = useRef<number | undefined>(undefined)
  const queued = useRef<TimedSnapshot | undefined>(undefined)
  const presetProblem = useMemo(() => makePreset(
    settings.preset, resolutions[settings.resolution], settings.params, materials[settings.material],
  ), [settings])
  const design = history.present
  const problem = useMemo(() => ({ ...presetProblem, ...design }), [presetProblem, design])
  const activeCase = Math.min(selectedCase, problem.loadCases.length - 1)
  const constraint = useMemo(() => supportError(problem.grid, problem.supports)
    ?? (hasFreeLoad(problem) ? undefined : 'Apply a force to at least one unrestrained degree of freedom.'), [problem])
  const showContours = mode === 'cad' || exportOpen
  const loops = useMemo(() => showContours
    ? extractContours(contourField(problem, frame?.density), problem.grid, contour.threshold, contour.smoothing) : [],
  [showContours, problem, frame, contour.threshold, contour.smoothing])

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
    if (value.preset !== settings.preset || value.resolution !== settings.resolution) {
      setHistory(initialHistory)
      setSelectedCase(0)
    }
    setSettings(value)
  }

  function edit({ supports, loadCases, passive }: Design) {
    reset()
    const { supports: oldSupports, loadCases: oldLoads, passive: oldMasks } = problem
    setHistory(current => ({
      past: [...current.past.slice(-79), { supports: oldSupports, loadCases: oldLoads, passive: oldMasks }],
      present: { supports, loadCases, passive },
      future: [],
    }))
  }

  function undo() {
    const previous = history.past.at(-1)
    if (!previous) return
    reset()
    setHistory({
      past: history.past.slice(0, -1),
      present: previous,
      future: [history.present ?? presetProblem, ...history.future],
    })
  }

  function redo() {
    const next = history.future[0]
    if (!next) return
    reset()
    setHistory({
      past: [...history.past, history.present ?? presetProblem],
      present: next,
      future: history.future.slice(1),
    })
  }

  function send(type: 'start' | 'pause' | 'step') {
    if (type !== 'pause' && constraint) return
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

  const canRun = !constraint && (runState === 'ready' || runState === 'paused')
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
        <Controls settings={settings} setSettings={changeSettings}>
          <LoadCases cases={problem.loadCases} active={activeCase} onSelect={setSelectedCase}
            onAdd={() => {
              edit({ ...problem, loadCases: addLoadCase(problem.loadCases) })
              setSelectedCase(problem.loadCases.length)
            }}
            onRemove={() => {
              if (problem.loadCases.length === 1) return
              edit({ ...problem, loadCases: problem.loadCases.filter((_, i) => i !== activeCase) })
              setSelectedCase(Math.min(activeCase, problem.loadCases.length - 2))
            }}
            onRename={name => edit({
              ...problem, loadCases: problem.loadCases.map((load, i) => i === activeCase ? { ...load, name } : load),
            })} />
        </Controls>
        <div className="results">
          <div className="result-header">
            <h2>{presets[settings.preset].name}</h2>
            <div className="action-row result-actions">
              <span className={`status status-${runState}`} role="status"><i />{stateLabels[runState]}</span>
              <button className="tool-button" type="button" disabled={!history.past.length} onClick={undo}>Undo</button>
              <button className="tool-button" type="button" disabled={!history.future.length} onClick={redo}>Redo</button>
              <button className="tool-button" type="button" onClick={() => {
                if (design) edit(presetProblem)
                else reset()
                setSelectedCase(0)
              }}>Reset to preset</button>
              <button className="tool-button export-trigger" type="button" onClick={() => {
                setMode('cad')
                setExportOpen(true)
              }}>Export</button>
            </div>
          </div>
          {error && <p role="alert" className="error">{error} Reset to run again.</p>}
          {constraint && <p className="constraint-warning" role="alert">{constraint}</p>}
          <Viewport key={`${settings.preset}/${settings.resolution}`} problem={problem} frame={frame} loops={loops}
            mode={mode} setMode={setMode} activeCase={activeCase} onChange={edit} />
          {exportOpen && <ExportDialog loops={loops} grid={problem.grid} settings={contour}
            setSettings={setContour} onClose={() => setExportOpen(false)} />}
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
