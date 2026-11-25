import { useEffect, useMemo, useRef, useState } from 'react'
import { ConvergenceChart, type Sample } from './components/ConvergenceChart'
import { Controls } from './components/Controls'
import { Engineering } from './components/Engineering'
import { LanguageContext, useTranslation } from './i18n'
import { dictionaries, languages, type Language } from './i18n/dictionaries'
import { Viewport, type ViewMode } from './components/Viewport'
import { LoadCases } from './components/LoadCases'
import { download, ExportDialog, type ContourSettings } from './components/ExportDialog'
import { extractContours } from './solver/contour'
import { initialPhysicalDensity } from './solver/density'
import { addLoadCase, hasFreeLoad, loadCaseIndex, supportError } from './solver/design'
import { defaultParams, makePreset, materials } from './solver/presets'
import { loadProject, projectGrid, ProjectError, saveProject, type Design, type Settings } from './solver/project'
import { ManufacturingDensity } from './solver/manufacturing'
import type { TimedSnapshot, WorkerCommand, WorkerEvent } from './workers/protocol'

interface History {
  past: Design[]
  present?: Design
  future: Design[]
}
const initialHistory: History = { past: [], future: [] }

type RunState = 'ready' | 'running' | 'pausing' | 'paused' | 'stepping' | 'complete' | 'error'

const initialSettings: Settings = {
  preset: 'mbb', resolution: '48 × 16', material: 'steel', widthMm: 120, thicknessMm: 10, params: defaultParams,
}
const languageKey = 'topostudio-language'

function display(value: number | undefined, digits: number) {
  return value === undefined ? '—' : value.toPrecision(digits)
}

export default function App() {
  const [language, setLanguage] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem(languageKey)
      return languages.find(value => value === saved) ?? 'en'
    } catch {
      return 'en'
    }
  })
  useEffect(() => {
    document.documentElement.lang = language
    document.title = `TopoStudio · ${dictionaries[language].app}`
    try { localStorage.setItem(languageKey, language) } catch { /* Storage may be disabled. */ }
  }, [language])
  return <LanguageContext.Provider value={language}>
    <Workbench language={language} setLanguage={setLanguage} />
  </LanguageContext.Provider>
}

function Workbench({ language, setLanguage }: { language: Language; setLanguage: (value: Language) => void }) {
  const { t, diagnostic } = useTranslation()
  const [projectError, setProjectError] = useState<string>()
  const [projectRevision, setProjectRevision] = useState(0)
  const loadRequest = useRef(0)
  const projectFile = useRef<HTMLInputElement>(null)
  const [settings, setSettings] = useState(initialSettings)
  const [runState, setRunState] = useState<RunState>('ready')
  const [frame, setFrame] = useState<TimedSnapshot>()
  const [samples, setSamples] = useState<Sample[]>([])
  const [error, setError] = useState('')
  const [history, setHistory] = useState(initialHistory)
  // Preserve the requested case when it is absent from the current history entry.
  const [selectedCaseId, setSelectedCaseId] = useState<string>()
  const [mode, setMode] = useState<ViewMode>('density')
  const [exportOpen, setExportOpen] = useState(false)
  const [contour, setContour] = useState<ContourSettings>({ threshold: 0.5, smoothing: 3, thickness: 10 })
  const workerRef = useRef<Worker | null>(null)
  const paintRequest = useRef<number | undefined>(undefined)
  const queued = useRef<TimedSnapshot | undefined>(undefined)
  const presetProblem = useMemo(() => makePreset(
    settings.preset, projectGrid(settings), settings.params, materials[settings.material],
  ), [settings])
  const design = history.present
  const problem = useMemo(() => ({ ...presetProblem, ...design }), [presetProblem, design])
  const activeCase = problem.loadCases[Math.max(0, loadCaseIndex(problem.loadCases, selectedCaseId))]
  const supportIssue = useMemo(() => supportError(problem.grid, problem.supports), [problem])
  const loadIssue = useMemo(() => !hasFreeLoad(problem), [problem])
  const showContours = mode === 'cad' || exportOpen
  const { grid, params, passive } = problem
  const preview = useMemo(() => {
    try {
      const manufacturing = new ManufacturingDensity({ grid, params, passive })
      const output = new Float64Array(grid.nelx * grid.nely)
      const density = manufacturing.apply(manufacturing.setup.design, output, 1, false)
      return { density: Float32Array.from(density), passive: manufacturing.passive, anchors: manufacturing.addedAnchors }
    } catch (cause) {
      const conflict = cause instanceof Error ? cause.message : String(cause)
      return { density: initialPhysicalDensity({ grid, params, passive }), passive, conflict, anchors: 0 }
    }
  }, [grid, params, passive])
  const initialDensity = preview.density
  const constraint = preview.conflict ? diagnostic(preview.conflict)
    : supportIssue ? t('unsupportedSupports') : loadIssue ? t('freeLoad') : undefined
  const density = frame?.density ?? initialDensity
  const loops = useMemo(() => showContours
    ? extractContours(density, grid, contour.threshold, contour.smoothing) : [],
  [showContours, density, grid, contour.threshold, contour.smoothing])

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
      setSelectedCaseId(undefined)
    }
    if (value.thicknessMm !== settings.thicknessMm) setContour(current => ({ ...current, thickness: value.thicknessMm }))
    setSettings(value)
  }

  async function importProject(file: File) {
    const request = ++loadRequest.current
    try {
      const loaded = loadProject(await file.text())
      if (request !== loadRequest.current) return
      reset()
      setSettings(loaded.settings)
      setProjectRevision(current => current + 1)
      setHistory({ ...initialHistory, present: loaded.design })
      setSelectedCaseId(undefined)
      setMode('density')
      setContour(current => ({ ...current, thickness: loaded.settings.thicknessMm }))
      setProjectError(undefined)
    } catch (cause) {
      if (request === loadRequest.current) setProjectError(cause instanceof ProjectError ? cause.field : '')
    }
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
    { label: t('iteration'), value: frame?.iteration ?? '—', unit: '' },
    { label: t('compliance'), value: display(frame?.compliance, 4), unit: `${t('N')}·${t('mm')}` },
    { label: t('volume'), value: frame ? (frame.volFrac * 100).toFixed(1) : '—', unit: '%' },
    { label: t('change'), value: frame ? frame.change.toFixed(4) : '—', unit: '' },
    { label: t('time'), value: frame ? frame.iterMs.toFixed(1) : '—', unit: t('ms') },
    { label: t('peakStress'), value: display(frame?.maxVonMises, 4), unit: t('MPa') },
  ]
  if (params.heaviside) metrics.push({ label: 'β', value: frame?.beta ?? 1, unit: '' })

  return (
    <div className="min-h-screen antialiased">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">T</span>
          <div><h1>TopoStudio</h1><p>{t('app')}</p></div>
        </div>
        <div className="transport" role="group" aria-label={t('playback')}>
          <button type="button" onClick={() => send('start')} disabled={!canRun} className="play"><span aria-hidden="true">▶</span> {t('play')}</button>
          <button type="button" onClick={() => send('pause')} disabled={runState !== 'running'}><span aria-hidden="true">Ⅱ</span> {t('pause')}</button>
          <button type="button" onClick={() => send('step')} disabled={!canRun}><span aria-hidden="true">▸│</span> {t('step')}</button>
          <button type="button" onClick={reset} disabled={runState === 'ready'}><span aria-hidden="true">↺</span> {t('reset')}</button>
        </div>
        <div className="segmented language-switcher" role="group" aria-label={t('language')}>
          {languages.map(value => <button key={value} type="button" aria-pressed={language === value}
            onClick={() => setLanguage(value)}>{value.toUpperCase()}</button>)}
        </div>
      </header>
      <main className="workspace">
        <Controls settings={settings} setSettings={changeSettings}>
          <LoadCases cases={problem.loadCases} active={activeCase} onSelect={setSelectedCaseId}
            onAdd={() => {
              const loadCases = addLoadCase(problem.loadCases)
              edit({ ...problem, loadCases })
              setSelectedCaseId(loadCases.at(-1)!.id)
            }}
            onRemove={() => {
              if (problem.loadCases.length === 1) return
              edit({ ...problem, loadCases: problem.loadCases.filter(load => load.id !== activeCase.id) })
            }}
            onRename={name => edit({
              ...problem, loadCases: problem.loadCases.map(load => load.id === activeCase.id ? { ...load, name, presetName: undefined, generatedNumber: undefined } : load),
            })} />
        </Controls>
        <div className="results">
          <div className="result-header">
            <h2>{t(settings.preset)}</h2>
            <div className="action-row result-actions">
              <span className={`status status-${runState}`} role="status"><i />{t(runState)}</span>
              <button className="tool-button" type="button" disabled={!history.past.length} onClick={undo}>{t('undo')}</button>
              <button className="tool-button" type="button" disabled={!history.future.length} onClick={redo}>{t('redo')}</button>
              <button className="tool-button" type="button" onClick={() => {
                if (design) edit(presetProblem)
                else reset()
                setSelectedCaseId(undefined)
              }}>{t('presetReset')}</button>
              <button type="button" className="tool-button" onClick={() =>
                download(saveProject(settings, problem), 'json', 'application/json', 'topostudio-project')}>{t('save')}</button>
              <button type="button" className="tool-button" onClick={() => projectFile.current?.click()}>{t('load')}</button>
              <input ref={projectFile} type="file" accept=".json,application/json" hidden onChange={event => {
                const file = event.currentTarget.files?.[0]
                if (file) void importProject(file)
                event.currentTarget.value = ''
              }} />
              <button className="tool-button export-trigger" type="button" onClick={() => {
                setMode('cad')
                setExportOpen(true)
              }}>{t('export')}</button>
            </div>
          </div>
          {projectError !== undefined && <p role="alert" className="error">
            {t('projectError')}{projectError && <> ({projectError})</>}</p>}
          {error && <p role="alert" className="error" title={error}>{diagnostic(error)} {t('resetError')}</p>}
          {constraint && <p className="constraint-warning" role="alert">{constraint}</p>}
          {preview.anchors > 0 && <p className="anchor-status">{t('amAnchors')} · {preview.anchors}</p>}
          <Viewport effectivePassive={preview.passive} key={`${projectRevision}/${settings.preset}/${settings.resolution}`} problem={problem} frame={frame} initialDensity={initialDensity} loops={loops} threshold={contour.threshold}
            mode={mode} setMode={setMode} activeCase={activeCase} onChange={edit} />
          {exportOpen && <ExportDialog loops={loops} grid={problem.grid} settings={contour}
            setSettings={setContour} onClose={() => setExportOpen(false)} />}
          <section className="panel telemetry" aria-label={t('telemetry')}>
            <dl>{metrics.map(({ label, value, unit }) => (
              <div key={label}><dt>{label}</dt><dd>{value}{unit && <span>{unit}</span>}</dd></div>
            ))}</dl>
          </section>
          {!preview.conflict && <Engineering problem={problem} effectivePassive={preview.passive} density={density} frame={frame} />}
          <ConvergenceChart samples={samples} target={settings.params.volFrac} />
        </div>
      </main>
    </div>
  )
}
