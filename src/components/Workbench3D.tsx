import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from '../i18n'
import { materials } from '../solver/presets'
import type { MaterialId } from '../solver/project'
import { exportObj3D, exportStl3D, isWatertight } from '../solver3d/export3d'
import { marchingCubes, taubinSmooth, type Surface3D } from '../solver3d/marchingCubes'
import { defaultParams3D, makePreset3D, presetGrid3D, presets3D, resolutions3D, type Preset3D } from '../solver3d/presets3d'
import { Simp3D } from '../solver3d/simp3d'
import { ProblemError3D, elementCount, type Grid3D, type ProblemIssue3D, type SimpParams3D, type Symmetry3D } from '../solver3d/types3d'
import type { TimedSnapshot3D, WorkerCommand3D, WorkerEvent3D } from '../workers/protocol3d'
import { ConvergenceChart, type Sample } from './ConvergenceChart'
import { download } from './ExportDialog'
import { Tooltip, type TooltipMessage } from './Tooltip'
import { Viewport3D, type ViewMode3D } from './Viewport3D'

type RunState = 'ready' | 'running' | 'pausing' | 'paused' | 'stepping' | 'complete' | 'error'
type SurfaceSettings = { threshold: number; smoothing: number }
type Dimension = 'widthMm' | 'heightMm' | 'depthMm'
const dimensions = [['widthMm', 'width'], ['heightMm', 'height'], ['depthMm', 'depth3d']] as const
const symmetry = { none: 'none', y: 'mirrorY', z: 'mirrorZ3d', yz: 'mirrorYZ3d' } as const
const materialIds = Object.keys(materials) as MaterialId[]
const sliders = [
  ['volFrac', 'volumeFraction', 'tipVolumeFraction', 0.02, 1, 0.01],
  ['rmin', 'radius', 'tipRadius', 1, 4, 0.1],
  ['penal', 'simpPenalty', 'tipSimpPenalty', 1, 5, 0.1],
  ['moveLimit', 'moveLimit3d', 'hint3dMoveLimit', 0.01, 0.35, 0.01],
  ['maxIter', 'maxIter3d', 'hint3dMaxIter', 1, 250, 1],
  ['changeTol', 'changeTol3d', 'hint3dChangeTol', 0, 0.05, 0.001],
] as const

function LabeledControl({ id, name, tip, children }: { id: string; name: string; tip: TooltipMessage; children: ReactNode }) {
  return <div className="field-3d">
    <Tooltip message={tip} info={name}><label htmlFor={id}>{name}</label></Tooltip>
    {children}
  </div>
}

function SurfaceDialog({ surface, settings, change, close }: {
  surface: Surface3D | undefined
  settings: SurfaceSettings
  change: (next: SurfaceSettings) => void
  close: () => void
}) {
  const { t, number, fixed } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const [exportError, setExportError] = useState(false)
  const valid = useMemo(() => ({ obj: !!surface && isWatertight(surface), stl: !!surface && isWatertight(surface, true) }), [surface])
  useLayoutEffect(() => { dialog.current?.showModal() }, [])
  const triangles = (surface?.triangles.length ?? 0) / 3
  function save(format: 'stl' | 'obj') {
    if (!surface || !valid[format]) return
    try {
      const data = format === 'stl' ? exportStl3D(surface) : exportObj3D(surface)
      download(data, format, format === 'stl' ? 'model/stl' : 'model/obj', 'topostudio-3d')
    } catch {
      setExportError(true)
    }
  }
  function adjust(next: SurfaceSettings) {
    setExportError(false)
    change(next)
  }
  return <dialog ref={dialog} className="export-dialog panel" onClose={close} aria-labelledby="export-title-3d">
    <form method="dialog" className="export-header">
      <h2 id="export-title-3d">{t('exportTitle3d')}</h2>
      <Tooltip message="hint3dClose"><button className="tool-button" autoFocus>{t('close')}</button></Tooltip>
    </form>
    <div className="parameter-label">
      <Tooltip message="hint3dThreshold" info={t('threshold')}><label htmlFor="threshold-3d">{t('threshold')}</label></Tooltip>
      <output>{fixed(settings.threshold, 2)}</output>
    </div>
    <input id="threshold-3d" type="range" min={0.01} max={0.99} step={0.01} value={settings.threshold}
      onChange={event => adjust({ ...settings, threshold: event.target.valueAsNumber })} />
    <div className="parameter-label">
      <Tooltip message="hint3dTaubin" info={t('smoothing')}><label htmlFor="taubin-3d">{t('smoothing')}</label></Tooltip>
      <output>{number(settings.smoothing)}</output>
    </div>
    <input id="taubin-3d" type="range" min={0} max={12} value={settings.smoothing}
      onChange={event => adjust({ ...settings, smoothing: event.target.valueAsNumber })} />
    <p className="contour-summary" aria-live="polite">{t('meshSummary3d')
      .replace('{vertices}', number((surface?.vertices.length ?? 0) / 3)).replace('{triangles}', number(triangles))}</p>
    {!triangles && <p className="hint">{t('noMaterial')} {t('helpThreshold')}</p>}
    {(exportError || (triangles > 0 && (!valid.obj || !valid.stl))) && <p className="error" role="alert">{t('meshError3d')}</p>}
    <div className="action-row export-actions">
      <Tooltip message="hint3dStl"><button type="button" className="tool-button" disabled={!valid.stl} onClick={() => save('stl')}>{t('download').replace('{format}', '.STL')}</button></Tooltip>
      <Tooltip message="hint3dObj"><button type="button" className="tool-button" disabled={!valid.obj} onClick={() => save('obj')}>{t('download').replace('{format}', '.OBJ')}</button></Tooltip>
    </div>
  </dialog>
}

export default function Workbench3D({ active, header }: { active: boolean; header: (transport: ReactNode) => ReactNode }) {
  const { t, number, fixed, significant } = useTranslation()
  const [preset, setPreset] = useState<Preset3D>('cantilever3d')
  const [resolution, setResolution] = useState(0)
  const [size, setSize] = useState<Pick<Grid3D, Dimension>>({ widthMm: 120, heightMm: 60, depthMm: 40 })
  const [material, setMaterial] = useState<MaterialId>('steel')
  const [params, setParams] = useState(defaultParams3D)
  const [state, setState] = useState<RunState>('ready')
  const [frame, setFrame] = useState<TimedSnapshot3D>()
  const [samples, setSamples] = useState<Sample[]>([])
  const [error, setError] = useState<ProblemIssue3D | 'workerError'>()
  const [mode, setMode] = useState<ViewMode3D>('auto')
  const [exportOpen, setExportOpen] = useState(false)
  const [settings, setSettings] = useState<SurfaceSettings>({ threshold: 0.5, smoothing: 4 })
  const worker = useRef<Worker | null>(null)
  const grid = useMemo(() => ({ ...presetGrid3D(resolutions3D[resolution]), ...size }), [resolution, size])
  const problem = useMemo(() => makePreset3D(preset, grid, params, materials[material]), [preset, grid, params, material])
  const preview = useMemo(() => {
    try {
      return { density: new Simp3D(problem).initialDensity() }
    } catch (cause) {
      return { density: Float64Array.from({ length: elementCount(problem.grid) }, (_, e) =>
        problem.passive?.void?.[e] ? 0 : problem.passive?.solid?.[e] ? 1 : problem.params.volFrac),
      issue: cause instanceof ProblemError3D ? cause.code : 'workerError' as const }
    }
  }, [problem])
  const density = frame?.density ?? preview.density
  const view = mode === 'auto' ? frame && (state === 'paused' || state === 'complete') ? 'cad' : 'voxels' : mode
  const buildSurface = active && (view !== 'voxels' || exportOpen)
  const surface = useMemo(() => buildSurface
    ? taubinSmooth(marchingCubes(density, problem.grid, settings.threshold), problem.grid, settings.smoothing)
    : undefined, [density, problem.grid, settings, buildSurface])

  useEffect(() => () => {
    worker.current?.terminate()
    worker.current = null
  }, [])

  useEffect(() => {
    if (!active && state === 'running') {
      worker.current?.postMessage({ type: 'pause' } satisfies WorkerCommand3D)
      setState('pausing')
    }
  }, [active, state])

  function stopWorker() {
    worker.current?.terminate()
    worker.current = null
  }

  function reset() {
    stopWorker()
    setFrame(undefined)
    setSamples([])
    setError(undefined)
    setState('ready')
  }

  function setParam(key: keyof SimpParams3D, value: SimpParams3D[keyof SimpParams3D]) {
    reset()
    setParams(current => ({ ...current, [key]: value }))
  }

  function send(type: 'start' | 'pause' | 'step') {
    try {
      if (!worker.current) {
        const instance = new Worker(new URL('../workers/simp3dWorker.ts', import.meta.url), { type: 'module' })
        worker.current = instance
        instance.onmessage = ({ data }: MessageEvent<WorkerEvent3D>) => {
          if (instance !== worker.current) return
          if (data.type === 'frame') {
            const { snapshot } = data
            setFrame(snapshot)
            setSamples(values => [...values, { iteration: snapshot.iteration, compliance: snapshot.compliance, volFrac: snapshot.volFrac }])
            if (snapshot.done) {
              setState('complete')
              stopWorker()
            }
          } else if (data.type === 'paused') setState('paused')
          else if (data.type === 'done') {
            setState('complete')
            stopWorker()
          } else {
            setError(data.issue)
            setState('error')
            stopWorker()
          }
        }
        instance.onerror = () => {
          if (instance !== worker.current) return
          setError('workerError')
          setState('error')
          stopWorker()
        }
        instance.postMessage({ type: 'init', problem } satisfies WorkerCommand3D)
      }
      setState(type === 'start' ? 'running' : type === 'pause' ? 'pausing' : 'stepping')
      worker.current.postMessage({ type } satisfies WorkerCommand3D)
    } catch {
      setError('workerError')
      setState('error')
      stopWorker()
    }
  }

  const canRun = !preview.issue && (state === 'ready' || state === 'paused')
  const metrics = [
    ['iteration', 'tipIteration', number(frame?.iteration), ''],
    ['compliance', 'tipCompliance', significant(frame?.compliance), `${t('N')}·${t('mm')}`],
    ['volume', 'tipVolume', fixed(frame && frame.volFrac * 100, 1), '%'],
    ['change', 'tipChange', fixed(frame?.change, 4), ''],
    ['time', 'tipTime', fixed(frame?.iterMs, 1), t('ms')],
    ['peakStress', 'hint3dStress', significant(frame?.maxVonMises), t('MPa')],
  ] as const
  const kpi = frame?.metrics

  return <div className="min-h-screen antialiased">
    {header(<div className="transport" role="group" aria-label={t('playback')}>
      <Tooltip message="hint3dPlay"><button type="button" onClick={() => send('start')} disabled={!canRun} className="play"><span aria-hidden="true">▶</span> {t('play')}</button></Tooltip>
      <Tooltip message="hint3dPause"><button type="button" onClick={() => send('pause')} disabled={state !== 'running'}><span aria-hidden="true">Ⅱ</span> {t('pause')}</button></Tooltip>
      <Tooltip message="hint3dStep"><button type="button" onClick={() => send('step')} disabled={!canRun}><span aria-hidden="true">▸│</span> {t('step')}</button></Tooltip>
      <Tooltip message="hint3dReset"><button type="button" onClick={reset} disabled={state === 'ready'}><span aria-hidden="true">↺</span> {t('reset')}</button></Tooltip>
    </div>)}
    <main className="workspace workspace-3d">
      <aside className="controls panel" aria-label={t('setup')}>
        <h2>{t('setup')}</h2>
        <section>
          <LabeledControl id="preset-3d" name={t('preset')} tip="hint3dPreset">
            <select id="preset-3d" value={preset} onChange={event => { reset(); setPreset(event.target.value as Preset3D) }}>
              {presets3D.map(value => <option key={value} value={value}>{t(value)}</option>)}
            </select>
          </LabeledControl>
          <p className="hint">{t(`${preset}Detail`)}</p>
          <LabeledControl id="resolution-3d" name={t('resolution')} tip="hint3dResolution">
            <select id="resolution-3d" value={resolution} onChange={event => { reset(); setResolution(Number(event.target.value)) }}>
              {resolutions3D.map((value, i) => <option key={i} value={i}>{value.join(' × ')}</option>)}
            </select>
          </LabeledControl>
        </section>
        <section>
          <LabeledControl id="material-3d" name={t('material')} tip="tipMaterial">
            <select id="material-3d" value={material} onChange={event => { reset(); setMaterial(event.target.value as MaterialId) }}>
              {materialIds.map(value => <option key={value} value={value}>{t(value)}</option>)}
            </select>
          </LabeledControl>
        </section>
        <section>
          <h3>{t('optimization')}</h3>
          {sliders.map(([key, label, tip, min, max, step]) => <div key={key}>
            <div className="parameter-label">
              <Tooltip message={tip} info={t(label)}><label htmlFor={`${key}-3d`}>{t(label)}</label></Tooltip>
              <output>{key === 'volFrac' ? `${number(Math.round(params[key] * 100))}%` : number(params[key])}{key === 'rmin' && ` ${t('elementShort')}`}</output>
            </div>
            <input id={`${key}-3d`} type="range" min={min} max={max} step={step} value={params[key]}
              onChange={event => setParam(key, event.target.valueAsNumber)} />
          </div>)}
          <Tooltip message="tipHeaviside" info={t('heaviside')}><label className="check-field">
            <input type="checkbox" checked={!!params.heaviside} onChange={event => setParam('heaviside', event.target.checked)} />
            {t('heaviside')}
          </label></Tooltip>
          <LabeledControl id="symmetry-3d" name={t('symmetry')} tip="hint3dSymmetry">
            <select id="symmetry-3d" value={params.symmetry} onChange={event => setParam('symmetry', event.target.value as Symmetry3D)}>
              {(Object.keys(symmetry) as Symmetry3D[]).map(value => <option key={value} value={value}>{t(symmetry[value])}</option>)}
            </select>
          </LabeledControl>
        </section>
        <section>
          <h3>{t('geometry')}</h3>
          {dimensions.map(([key, label]) => <LabeledControl key={key} id={`${key}-3d`} name={`${t(label)} (${t('mm')})`} tip="hint3dDimensions">
            <input id={`${key}-3d`} className="field-input" type="number" min={1} max={10000} step="any" defaultValue={size[key]}
              onBlur={event => {
                const value = event.currentTarget.valueAsNumber
                if (value >= 1 && value <= 10000 && value !== size[key]) { reset(); setSize(current => ({ ...current, [key]: value })) }
                else event.currentTarget.value = String(size[key])
              }}
              onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
          </LabeledControl>)}
        </section>
      </aside>
      <div className="results">
        <div className="result-header">
          <h2>{t(preset)}</h2>
          <div className="action-row result-actions">
            <span className={`status status-${state}`} role="status"><i />{t(state)}</span>
            <Tooltip message="hint3dExport"><button type="button" className="tool-button export-trigger" onClick={() => {
              if (state === 'running') send('pause')
              setExportOpen(true)
            }}>{t('export')}</button></Tooltip>
          </div>
        </div>
        {(preview.issue || error) && <p className="error" role="alert">{t((preview.issue ?? error)!)} {error && t('resetError')}</p>}
        <Viewport3D active={active} problem={problem} density={density} mode={mode} setMode={setMode}
          view={mode === 'auto' && !surface?.triangles.length ? 'voxels' : view} surface={surface} frame={frame} />
        {exportOpen && <SurfaceDialog surface={surface} settings={settings} change={setSettings} close={() => setExportOpen(false)} />}
        <section className="panel telemetry" aria-label={t('telemetry')}>
          <dl>{metrics.map(([label, tip, value, unit]) => (
            <div key={label}><dt><Tooltip message={tip} info={t(label)}>{t(label)}</Tooltip></dt><dd>{value}{unit && <span>{unit}</span>}</dd></div>
          ))}</dl>
        </section>
        <section className="panel engineering" aria-label={t('engineering')}>
          <h2>{t('engineering')}</h2>
          <dl>
            <div><dt><Tooltip message="tipMass" info={t('mass')}>{t('mass')}</Tooltip></dt>
              <dd>{significant(kpi?.initialMass)} → {significant(kpi?.mass)} {t('g')}</dd>
              {kpi && <small>{significant(kpi.saved)}% {t('saved')}</small>}</div>
            <div><dt><Tooltip message="tipDeflection" info={t('deflection')}>{t('deflection')}</Tooltip></dt>
              <dd>{significant(kpi?.maxDeflection)} {t('mm')}</dd></div>
            <div><dt><Tooltip message="tipSafety" info={t('safety')}>{t('safety')}</Tooltip></dt>
              <dd className={kpi?.safetyFactor === undefined ? undefined : kpi.safetyFactor < 1 ? 'fail' : kpi.safetyFactor < 1.5 ? 'caution' : 'safe'}>{significant(kpi?.safetyFactor)}</dd>
              <small><Tooltip message="tipP95Safety" info={t('p95Safety')}>{t('p95Safety')} · {significant(kpi?.p95SafetyFactor)}</Tooltip></small></div>
          </dl>
        </section>
        <ConvergenceChart samples={samples} target={params.volFrac} />
      </div>
    </main>
  </div>
}
