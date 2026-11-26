import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from '../i18n'
import { materials } from '../solver/presets'
import type { MaterialId } from '../solver/project'
import { exportObj3D, exportStl3D } from '../solver3d/export3d'
import { maxSmoothingPasses3D } from '../solver3d/marchingCubes'
import { defaultParams3D, makePreset3D, presetGrid3D, presets3D, resolutions3D, type Preset3D } from '../solver3d/presets3d'
import { cellSize, elementCount, maxCellAspectRatio3D, type ElementType3D, type Grid3D, type SimpProblem3D, type ProblemIssue3D, type SimpParams3D, type Symmetry3D } from '../solver3d/types3d'
import type { Preview3D, SurfaceEvent3D, SurfaceInput3D, SurfaceRequest3D, TimedSnapshot3D, WorkerCommand3D, WorkerEvent3D } from '../workers/protocol3d'
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
  ['rmin', 'radius', 'hint3dRadius', 1, 4, 0.1],
  ['penal', 'simpPenalty', 'tipSimpPenalty', 1, 5, 0.1],
  ['moveLimit', 'moveLimit3d', 'hint3dMoveLimit', 0.01, 0.35, 0.01],
  ['maxIter', 'maxIter3d', 'hint3dMaxIter', 1, 250, 1],
  ['changeTol', 'changeTol3d', 'hint3dChangeTol', 0, 0.05, 0.001],
] as const

const incompatibleSymmetry = (preset: Preset3D, value?: Symmetry3D) =>
  preset === 'lBracket3d' && (value === 'y' || value === 'yz')

function LabeledControl({ id, name, tip, children }: { id: string; name: string; tip: TooltipMessage; children: ReactNode }) {
  return <div className="field-3d">
    <Tooltip message={tip} info={name}><label htmlFor={id}>{name}</label></Tooltip>
    {children}
  </div>
}

function ExportDialog3D({ result, pending, elementType, settings, change, close }: {
  result: SurfaceEvent3D | undefined
  pending: boolean
  elementType: ElementType3D
  settings: SurfaceSettings
  change: (next: SurfaceSettings) => void
  close: () => void
}) {
  const { t, number, fixed } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const [exportError, setExportError] = useState(false)
  const surface = result?.type === 'surface' ? result.surface : undefined
  const valid = result?.type === 'surface' ? result.valid : undefined
  useLayoutEffect(() => { dialog.current?.showModal() }, [])
  const triangles = (surface?.triangles.length ?? 0) / 3
  function save(format: 'stl' | 'obj') {
    if (!surface || !valid?.[format]) return
    try {
      const data = format === 'stl' ? exportStl3D(surface, true) : exportObj3D(surface, true)
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
      <h2 id="export-title-3d">{t('exportTitle3d')} · {t(elementType === 'tet4' ? 'tet4Elements3d' : 'hex8Elements3d')}</h2>
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
    <input id="taubin-3d" type="range" min={0} max={maxSmoothingPasses3D} value={settings.smoothing}
      onChange={event => adjust({ ...settings, smoothing: event.target.valueAsNumber })} />
    <p className="contour-summary" aria-live="polite">{pending ? t('computingSurface3d') : surface && t('meshSummary3d')
      .replace('{vertices}', number((surface?.vertices.length ?? 0) / 3)).replace('{triangles}', number(triangles))}</p>
    {surface && !triangles && <p className="hint">{t('noMaterial')} {t('helpThreshold')}</p>}
    {(exportError || result?.type === 'error' || (triangles > 0 && (!valid?.obj || !valid?.stl))) && <p className="error" role="alert">{t('meshError3d')}</p>}
    <div className="action-row export-actions">
      <Tooltip message="hint3dStl"><button type="button" className="tool-button" disabled={!valid?.stl} onClick={() => save('stl')}>{t('download').replace('{format}', '.STL')}</button></Tooltip>
      <Tooltip message="hint3dObj"><button type="button" className="tool-button" disabled={!valid?.obj} onClick={() => save('obj')}>{t('download').replace('{format}', '.OBJ')}</button></Tooltip>
    </div>
  </dialog>
}

export default function Workbench3D({ active, header }: { active: boolean; header: (transport: ReactNode) => ReactNode }) {
  const { t, number, fixed, significant } = useTranslation()
  const [preset, setPreset] = useState<Preset3D>('cantilever3d')
  const [elementType, setElementType] = useState<ElementType3D>('hex8')
  const [resolution, setResolution] = useState(0)
  const [size, setSize] = useState<Pick<Grid3D, Dimension>>({ widthMm: 120, heightMm: 60, depthMm: 40 })
  const [material, setMaterial] = useState<MaterialId>('steel')
  const [params, setParams] = useState(defaultParams3D)
  const [state, setState] = useState<RunState>('ready')
  const [frame, setFrame] = useState<TimedSnapshot3D>()
  const [samples, setSamples] = useState<Sample[]>([])
  const [error, setError] = useState<{ issue: ProblemIssue3D | 'workerError'; relativeResidual?: number }>()
  const [mode, setMode] = useState<ViewMode3D>('auto')
  const [exportOpen, setExportOpen] = useState(false)
  const [settings, setSettings] = useState<SurfaceSettings>({ threshold: 0.5, smoothing: 4 })
  const worker = useRef<Worker | null>(null)
  const previewRequest = useRef(0)
  const surfaceRequest = useRef(0)
  const [restart, setRestart] = useState(0)
  const [previewResult, setPreviewResult] = useState<{
    problem: SimpProblem3D; restart: number; preview?: Preview3D; failed?: boolean
  }>()
  const [surfaceResult, setSurfaceResult] = useState<{ input: SurfaceInput3D; result: SurfaceEvent3D }>()
  const grid = useMemo(() => ({ ...presetGrid3D(resolutions3D[resolution]), ...size }), [resolution, size])
  const problem = useMemo(() => makePreset3D(preset, grid, params, materials[material], elementType), [preset, grid, params, material, elementType])
  const currentPreview = previewResult?.problem === problem && previewResult.restart === restart ? previewResult : undefined
  const preview = currentPreview?.preview
  const pendingPreview = !currentPreview
  const density = frame?.density ?? preview?.density
  const view = mode === 'auto' ? frame && (state === 'paused' || state === 'complete') ? 'cad' : 'voxels' : mode
  const buildSurface = active && (view !== 'voxels' || exportOpen)
  const passive = preview?.passive
  const surfaceInput = useMemo<SurfaceInput3D | undefined>(() => density &&
    { density, grid, ...settings, passive, elementType }, [density, grid, settings, passive, elementType])
  const exported = surfaceResult && surfaceResult.input === surfaceInput ? surfaceResult.result : undefined
  const surface = exported?.type === 'surface' ? exported.surface : undefined

  useEffect(() => {
    const requestId = ++previewRequest.current
    let instance: Worker | undefined
    try {
      instance = new Worker(new URL('../workers/simp3dWorker.ts', import.meta.url), { type: 'module' })
      worker.current = instance
      instance.onmessage = ({ data }: MessageEvent<WorkerEvent3D>) => {
        if (instance !== worker.current || requestId !== previewRequest.current) return
        if (data.type === 'preview') {
          if (data.requestId === requestId) setPreviewResult({ problem, restart, preview: data })
        } else if (data.type === 'frame') {
          const { snapshot } = data
          setFrame(snapshot)
          setSamples(values => [...values, { iteration: snapshot.iteration, compliance: snapshot.compliance, volFrac: snapshot.volFrac }])
          if (snapshot.done) {
            setState('complete')
            instance?.terminate()
            worker.current = null
          }
        } else if (data.type === 'paused') setState('paused')
        else if (data.type === 'done') setState('complete')
        else {
          setError(data)
          setState('error')
        }
      }
      instance.onerror = () => {
        if (instance !== worker.current || requestId !== previewRequest.current) return
        setPreviewResult(previous => previous?.problem === problem && previous.restart === restart
          ? previous : { problem, restart, failed: true })
        setError({ issue: 'workerError' })
        setState('error')
      }
      instance.postMessage({ type: 'preview', requestId, problem } satisfies WorkerCommand3D)
    } catch {
      setPreviewResult({ problem, restart, failed: true })
      setState('error')
    }
    return () => {
      if (worker.current === instance) worker.current = null
      instance?.terminate()
    }
  }, [problem, restart])

  useEffect(() => {
    if (!buildSurface || !surfaceInput || exported) return
    const input = surfaceInput
    const requestId = ++surfaceRequest.current
    let instance: Worker | undefined
    function receive(result: SurfaceEvent3D) {
      if (requestId === surfaceRequest.current && result.requestId === requestId) {
        setSurfaceResult({ input, result })
      }
    }
    try {
      instance = new Worker(new URL('../workers/surface3dWorker.ts', import.meta.url), { type: 'module' })
      instance.onmessage = ({ data }: MessageEvent<SurfaceEvent3D>) => receive(data)
      instance.onerror = () => receive({ type: 'error', requestId })
      instance.postMessage({ ...input, requestId } satisfies SurfaceRequest3D)
    } catch {
      receive({ type: 'error', requestId })
    }
    return () => {
      surfaceRequest.current++
      instance?.terminate()
    }
  }, [buildSurface, surfaceInput, exported])

  useEffect(() => {
    if (!active && state === 'running') {
      worker.current?.postMessage({ type: 'pause' } satisfies WorkerCommand3D)
      setState('pausing')
    }
  }, [active, state])

  function clearRun() {
    setFrame(undefined)
    setSamples([])
    setError(undefined)
    setState('ready')
  }

  function reset() {
    clearRun()
    setRestart(current => current + 1)
  }

  function setParam(key: keyof SimpParams3D, value: SimpParams3D[keyof SimpParams3D]) {
    clearRun()
    setParams(current => ({ ...current, [key]: value }))
  }

  function selectPreset(next: Preset3D) {
    clearRun()
    setPreset(next)
    setParams(current => incompatibleSymmetry(next, current.symmetry) ? { ...current, symmetry: 'none' } : current)
  }

  function send(type: 'start' | 'pause' | 'step') {
    if (!worker.current) return
    try {
      setState(type === 'start' ? 'running' : type === 'pause' ? 'pausing' : 'stepping')
      worker.current.postMessage({ type } satisfies WorkerCommand3D)
    } catch {
      setError({ issue: 'workerError' })
      setState('error')
    }
  }

  const issue = preview?.issue ?? error?.issue ?? (currentPreview?.failed ? 'workerError' : undefined)
  const canRun = !pendingPreview && !issue && (state === 'ready' || state === 'paused')
  const issueText = issue && t(issue).replace('{limit}', number(maxCellAspectRatio3D))
  const filterRadiusMm = params.rmin * Math.min(...cellSize(grid))
  const metrics = [
    ['elementCount3d', 'hint3dElementCount', number(elementCount(grid, elementType)), ''],
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
            <select id="preset-3d" value={preset} onChange={event => selectPreset(event.target.value as Preset3D)}>
              {presets3D.map(value => <option key={value} value={value}>{t(value)}</option>)}
            </select>
          </LabeledControl>
          <p className="hint">{t(`${preset}Detail`)}</p>
          <LabeledControl id="element-type-3d" name={t('elementType3d')} tip="hint3dElementType">
            <select id="element-type-3d" value={elementType} onChange={event => { clearRun(); setElementType(event.target.value as ElementType3D) }}>
              <option value="hex8">{t('hex8Elements3d')}</option>
              <option value="tet4">{t('tet4Elements3d')}</option>
            </select>
          </LabeledControl>
          <LabeledControl id="resolution-3d" name={t('resolution')} tip="hint3dResolution">
            <select id="resolution-3d" value={resolution} onChange={event => { clearRun(); setResolution(Number(event.target.value)) }}>
              {resolutions3D.map((value, i) => <option key={i} value={i}>{value.join(' × ')}</option>)}
            </select>
          </LabeledControl>
        </section>
        <section>
          <LabeledControl id="material-3d" name={t('material')} tip="tipMaterial">
            <select id="material-3d" value={material} onChange={event => { clearRun(); setMaterial(event.target.value as MaterialId) }}>
              {materialIds.map(value => <option key={value} value={value}>{t(value)}</option>)}
            </select>
          </LabeledControl>
        </section>
        <section>
          <h3>{t('optimization')}</h3>
          {sliders.map(([key, label, tip, min, max, step]) => <div key={key}>
            <div className="parameter-label">
              <Tooltip message={tip} info={t(label)}><label htmlFor={`${key}-3d`}>{t(label)}</label></Tooltip>
              <output>{key === 'volFrac' ? `${number(Math.round(params[key] * 100))}%`
                : key === 'rmin' ? `${significant(filterRadiusMm)} ${t('mm')}` : number(params[key])}</output>
            </div>
            <input id={`${key}-3d`} type="range" min={min} max={max} step={step} value={params[key]}
              aria-valuetext={key === 'rmin' ? `${significant(filterRadiusMm)} ${t('mm')}` : undefined}
              onChange={event => setParam(key, event.target.valueAsNumber)} />
          </div>)}
          <Tooltip message="tipHeaviside" info={t('heaviside')}><label className="check-field">
            <input type="checkbox" checked={!!params.heaviside} onChange={event => setParam('heaviside', event.target.checked)} />
            {t('heaviside')}
          </label></Tooltip>
          <LabeledControl id="symmetry-3d" name={t('symmetry')} tip="hint3dSymmetry">
            <select id="symmetry-3d" value={params.symmetry} aria-describedby={preset === 'lBracket3d' ? 'symmetry-note-3d' : undefined}
              onChange={event => setParam('symmetry', event.target.value as Symmetry3D)}>
              {(Object.keys(symmetry) as Symmetry3D[]).map(value => <option key={value} value={value}
                disabled={incompatibleSymmetry(preset, value)}>{t(symmetry[value])}</option>)}
            </select>
          </LabeledControl>
          {preset === 'lBracket3d' && <p id="symmetry-note-3d" className="hint">{t('lBracketSymmetry3d')}</p>}
        </section>
        <section>
          <h3>{t('geometry')}</h3>
          {dimensions.map(([key, label]) => <LabeledControl key={key} id={`${key}-3d`} name={`${t(label)} (${t('mm')})`} tip="hint3dDimensions">
            <input id={`${key}-3d`} className="field-input" type="number" min={1} max={10000} step="any" defaultValue={size[key]}
              aria-describedby="aspect-ratio-3d" aria-invalid={preview?.issue === 'aspectRatio3dError' || undefined}
              onBlur={event => {
                const value = event.currentTarget.valueAsNumber
                if (value >= 1 && value <= 10000 && value !== size[key]) { clearRun(); setSize(current => ({ ...current, [key]: value })) }
                else event.currentTarget.value = String(size[key])
              }}
              onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
          </LabeledControl>)}
          <p id="aspect-ratio-3d" className="hint">{t('aspectRatioHint3d').replace('{limit}', number(maxCellAspectRatio3D))}</p>
        </section>
      </aside>
      <div className="results">
        <div className="result-header">
          <h2>{t(preset)}</h2>
          <div className="action-row result-actions">
            <span className={`status status-${state}`} role="status"><i />{pendingPreview ? t('computingPreview3d') : t(state)}</span>
            <Tooltip message="hint3dExport"><button type="button" className="tool-button export-trigger" onClick={() => {
              if (state === 'running') send('pause')
              setExportOpen(true)
            }}>{t('export')}</button></Tooltip>
          </div>
        </div>
        {issueText && <p className="error" role="alert">{issueText}{error?.relativeResidual !== undefined &&
          ` ${t('solveResidual3d').replace('{residual}', significant(error.relativeResidual))}`} {error && t('resetError')}</p>}
        <Viewport3D active={active} problem={problem} density={density} mode={mode} setMode={setMode}
          view={mode === 'auto' && !surface?.triangles.length ? 'voxels' : view} surface={surface} frame={frame}
          threshold={settings.threshold} setThreshold={threshold => setSettings(current => ({ ...current, threshold }))} />
        {exportOpen && <ExportDialog3D result={exported}
          pending={pendingPreview || (!!density && !exported)} elementType={elementType}
          settings={settings} change={setSettings} close={() => setExportOpen(false)} />}
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
            <div><dt><Tooltip message="hint3dDeflection" info={t('deflection')}>{t('deflection')}</Tooltip></dt>
              <dd>{significant(kpi?.maxDeflection)} {t('mm')}</dd></div>
            <div><dt><Tooltip message="hint3dSafety" info={t('safety')}>{t('safety')}</Tooltip></dt>
              <dd className={kpi?.safetyFactor === undefined ? undefined : kpi.safetyFactor < 1 ? 'fail' : kpi.safetyFactor < 1.5 ? 'caution' : 'safe'}>{significant(kpi?.safetyFactor)}</dd>
              <small><Tooltip message="hint3dP95Safety" info={t('p95Safety')}>{t('p95Safety')} · {significant(kpi?.p95SafetyFactor)}</Tooltip></small>
              <small>{t('simpSafetyEstimate3d')}</small></div>
          </dl>
        </section>
        <ConvergenceChart samples={samples} target={params.volFrac} />
      </div>
    </main>
  </div>
}
