import { useEffect, useRef, useState } from 'react'
import {
  ACESFilmicToneMapping, BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry,
  DirectionalLight, DoubleSide, EdgesGeometry, GridHelper, Group, HemisphereLight, InstancedMesh, LineBasicMaterial, LineSegments,
  MathUtils, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera, Plane, Scene, Vector3, WebGLRenderer,
} from 'three'
import { useTranslation } from '../i18n'
import { cellSize, nodePosition, type Grid3D, type SimpProblem3D } from '../solver3d/types3d'
import type { Surface3D } from '../solver3d/marchingCubes'
import { createCamera3D, isFitShortcut, type CameraMode3D, type QuickView3D } from './camera3d'
import { Tooltip } from './Tooltip'
import type { TimedSnapshot3D } from '../workers/protocol3d'

const views = [
  ['iso', 'iso3d', 'hint3dIso'], ['front', 'front3d', 'hint3dFront'], ['top', 'top3d', 'hint3dTop'],
  ['right', 'right3d', 'hint3dRight'], ['fit', 'fit3d', 'hint3dFit'],
] as const
const choices = [
  ['auto', 'auto3d', 'hint3dAuto'], ['cad', 'smoothCad3d', 'hint3dCAD'],
  ['stress', 'stress', 'hint3dStress'], ['voxels', 'voxels3d', 'hint3dVoxels'],
] as const
export type ViewMode3D = typeof choices[number][0]

const stressPalette = ['#182840', '#127ba8', '#3cc39c', '#f4d568', '#f86b60'].map(value => new Color(value))
const axes = ['X', 'Y', 'Z']

function disposeGroup(group: Group | Scene) {
  group.traverse(object => {
    if (object instanceof InstancedMesh) object.dispose()
    if (object instanceof Mesh || object instanceof LineSegments) {
      object.geometry.dispose()
      if (Array.isArray(object.material)) object.material.forEach(material => material.dispose())
      else object.material.dispose()
    }
  })
  group.clear()
}

function addBoundaryOverlays(problem: SimpProblem3D, supportLayer: Group, forceLayer: Group) {
  const { grid, supports, loadCases } = problem
  const size = Math.min(...cellSize(grid))
  const span = Math.max(grid.widthMm, grid.heightMm, grid.depthMm)
  const marker = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial({ color: '#54dac8' }), supports.length)
  const matrix = new Object3D()
  supports.forEach((support, i) => {
    matrix.position.fromArray(nodePosition(grid, support.node))
    matrix.scale.set(size * 0.32, size * (support.fixX || support.fixZ ? 0.32 : 0.7), size * 0.32)
    matrix.updateMatrix()
    marker.setMatrixAt(i, matrix.matrix)
  })
  supportLayer.add(marker)
  const forces = loadCases.flatMap(load => load.forces.filter(force => force.fx || force.fy || force.fz))
  const max = forces.reduce((peak, force) => Math.max(peak, Math.hypot(force.fx, force.fy, force.fz)), 0)
  if (!forces.length) return
  const shaft = new InstancedMesh(new CylinderGeometry(1, 1, 1, 6), new MeshBasicMaterial({ color: '#fbb075' }), forces.length)
  const head = new InstancedMesh(new ConeGeometry(1, 1, 8), new MeshBasicMaterial({ color: '#ffd3a8' }), forces.length)
  const point = new Vector3(), direction = new Vector3(), y = new Vector3(0, 1, 0)
  forces.forEach(({ node, fx, fy, fz }, i) => {
    point.fromArray(nodePosition(grid, node))
    direction.set(fx, fy, fz)
    const length = span * (0.045 + 0.13 * Math.sqrt(direction.length() / max))
    const tip = Math.min(length * 0.34, size * 1.4)
    const radius = Math.min(size * 0.22, tip * 0.28)
    direction.normalize()
    matrix.quaternion.setFromUnitVectors(y, direction)
    matrix.scale.set(radius * 0.37, length - tip, radius * 0.37)
    matrix.position.copy(point).addScaledVector(direction, -(length + tip) / 2)
    matrix.updateMatrix()
    shaft.setMatrixAt(i, matrix.matrix)
    matrix.scale.set(radius, tip, radius)
    matrix.position.copy(point).addScaledVector(direction, -tip / 2)
    matrix.updateMatrix()
    head.setMatrixAt(i, matrix.matrix)
  })
  forceLayer.add(shaft, head)
}

function setupScene(canvas: HTMLCanvasElement, grid: Grid3D) {
  const { widthMm: x, heightMm: y, depthMm: z } = grid
  const span = Math.hypot(x, y, z)
  const center = new Vector3(x / 2, y / 2, z / 2)
  const scene = new Scene()
  scene.background = new Color('#141d27')
  const renderer = new WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.localClippingEnabled = true
  scene.add(new HemisphereLight('#d2e6ff', '#586c74', 2.15))
  const key = new DirectionalLight('#e7efff', 4.1)
  key.position.set(x * 0.75, y * 2, z * 3)
  const rim = new DirectionalLight('#8ce0f4', 3.3)
  rim.position.set(-x, y, -z * 2)
  scene.add(key, rim)
  const ground = new GridHelper(span * 2, 28, '#394955', '#263541')
  ground.position.set(center.x, -0.035 * span, center.z)
  scene.add(ground)
  const box = new BoxGeometry(x, y, z)
  const domain = new LineSegments(new EdgesGeometry(box), new LineBasicMaterial({ color: '#7899ab', transparent: true, opacity: 0.48 }))
  box.dispose()
  domain.position.copy(center)
  scene.add(domain)
  const model = new Group(), supports = new Group(), loads = new Group()
  scene.add(model, supports, loads)
  const camera = new PerspectiveCamera(37, 1, span / 1500, span * 40)
  const render = () => renderer.render(scene, camera)
  const controls = createCamera3D(canvas, camera, center, span, render)
  const planes = [new Plane(new Vector3(-1, 0, 0), x), new Plane(new Vector3(0, -1, 0), y),
    new Plane(new Vector3(0, 0, -1), z)]
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas
    if (!w || !h) return
    renderer.setSize(w, h, false)
    controls.resize(w / h)
  }
  resize()
  controls.fit('iso')
  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  return { model, supports, loads, controls, planes, render, dispose() {
    observer.disconnect()
    controls.dispose()
    disposeGroup(scene)
    renderer.dispose()
  } }
}

function voxelMesh(problem: SimpProblem3D, density: Float64Array, planes: Plane[]) {
  const { grid } = problem
  const { nelx, nely } = grid
  const [hx, hy, hz] = cellSize(grid)
  const mesh = new InstancedMesh(new BoxGeometry(hx, hy, hz), new MeshStandardMaterial({
    metalness: 0.28, roughness: 0.56, clippingPlanes: planes,
  }), density.length)
  const transform = new Object3D()
  const low = new Color('#31485d'), high = new Color('#b6f4ec'), color = new Color()
  let index = 0
  for (let e = 0; e < density.length; e++) {
    const value = density[e]
    if (value < 0.12) continue
    transform.position.set((e % nelx + 0.5) * hx, (Math.floor(e / nelx) % nely + 0.5) * hy, (Math.floor(e / (nelx * nely)) + 0.5) * hz)
    transform.scale.setScalar(0.34 + 0.63 * Math.sqrt(value))
    transform.updateMatrix()
    mesh.setMatrixAt(index, transform.matrix)
    mesh.setColorAt(index++, color.copy(low).lerp(high, value))
  }
  mesh.count = index
  return mesh
}

export function surfaceMesh(problem: SimpProblem3D, surface: Surface3D, planes: Plane[], frame?: TimedSnapshot3D) {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(surface.vertices), 3))
  geometry.setIndex(new BufferAttribute(surface.triangles, 1))
  geometry.computeVertexNormals()
  if (frame) {
    const { grid } = problem
    const { nelx, nely, nelz } = grid
    const size = cellSize(grid)
    const { vertices } = surface
    const colors = new Float32Array(vertices.length)
    const peak = [frame.p95VonMises, frame.maxVonMises].find(value => Number.isFinite(value) && value > 0) ?? 1
    const color = new Color()
    for (let j = 0; j < vertices.length; j += 3) {
      const cx = MathUtils.clamp(vertices[j] / size[0] - 0.5, 0, nelx - 1)
      const cy = MathUtils.clamp(vertices[j + 1] / size[1] - 0.5, 0, nely - 1)
      const cz = MathUtils.clamp(vertices[j + 2] / size[2] - 0.5, 0, nelz - 1)
      const x = Math.floor(cx), y = Math.floor(cy), z = Math.floor(cz)
      let value = 0, weightSum = 0
      for (let k = 0; k <= 1; k++) for (let l = 0; l <= 1; l++) for (let m = 0; m <= 1; m++) {
        const e = ((Math.min(z + k, nelz - 1) * nely + Math.min(y + l, nely - 1)) * nelx + Math.min(x + m, nelx - 1))
        const w = (k ? cz - z : 1 - cz + z) * (l ? cy - y : 1 - cy + y) * (m ? cx - x : 1 - cx + x)
        const weighted = w * frame.density[e]
        const stress = frame.vonMises[e]
        if (!(weighted > 0 && Number.isFinite(weighted) && Number.isFinite(stress))) continue
        value += weighted * stress
        weightSum += weighted
      }
      const ratio = value / (weightSum || 1) / peak
      const scaled = MathUtils.clamp(Number.isNaN(ratio) ? 0 : ratio, 0, 1) * (stressPalette.length - 1)
      const index = Math.min(stressPalette.length - 2, Math.floor(scaled))
      color.copy(stressPalette[index]).lerp(stressPalette[index + 1], scaled - index).toArray(colors, j)
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
    return new Mesh(geometry, new MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: DoubleSide, clippingPlanes: planes }))
  }
  return new Mesh(geometry, new MeshStandardMaterial({
    color: '#afc3d7', metalness: 0.48, roughness: 0.39, side: DoubleSide, clippingPlanes: planes,
  }))
}

export function Viewport3D({ active, problem, density, mode, setMode, view, surface, frame }: {
  active: boolean
  problem: SimpProblem3D
  density: Float64Array
  mode: ViewMode3D
  setMode: (mode: ViewMode3D) => void
  view: 'cad' | 'voxels' | 'stress'
  surface?: Surface3D
  frame?: TimedSnapshot3D
}) {
  const { t, significant, fixed } = useTranslation()
  const canvas = useRef<HTMLCanvasElement>(null)
  const scene = useRef<ReturnType<typeof setupScene> | null>(null)
  const [failed, setFailed] = useState(false)
  const [cameraMode, setCameraMode] = useState<CameraMode3D>('nx')
  const [showSupports, setShowSupports] = useState(true)
  const [showLoads, setShowLoads] = useState(true)
  const [sections, setSections] = useState([1, 1, 1])
  const { grid } = problem
  const limits = [grid.widthMm, grid.heightMm, grid.depthMm]

  useEffect(() => {
    if (!active || !canvas.current) return
    let current: ReturnType<typeof setupScene>
    try {
      current = setupScene(canvas.current, grid)
      scene.current = current
      setFailed(false)
    } catch {
      setFailed(true)
      return
    }
    function shortcut(event: KeyboardEvent) {
      if (isFitShortcut(event)) current.controls.fit()
    }
    window.addEventListener('keydown', shortcut)
    return () => {
      window.removeEventListener('keydown', shortcut)
      current.dispose()
      scene.current = null
    }
  }, [active, grid])

  useEffect(() => { scene.current?.controls.setMode(cameraMode) }, [active, grid, cameraMode])

  useEffect(() => {
    if (!scene.current) return
    const { supports, loads, render } = scene.current
    disposeGroup(supports)
    disposeGroup(loads)
    addBoundaryOverlays(problem, supports, loads)
    render()
  }, [active, problem])

  useEffect(() => {
    const current = scene.current
    if (!current) return
    const { model, planes, render } = current
    disposeGroup(model)
    if (view === 'voxels') model.add(voxelMesh(problem, density, planes))
    else if (surface?.triangles.length) model.add(surfaceMesh(problem, surface, planes, view === 'stress' ? frame : undefined))
    render()
  }, [active, problem, density, view, surface, frame])

  useEffect(() => {
    if (!scene.current) return
    const { supports, loads, render } = scene.current
    supports.visible = showSupports
    loads.visible = showLoads
    render()
  }, [active, grid, showSupports, showLoads])

  useEffect(() => {
    if (!scene.current) return
    const dimensions = [grid.widthMm, grid.heightMm, grid.depthMm]
    scene.current.planes.forEach((plane, i) => { plane.constant = sections[i] * dimensions[i] })
    scene.current.render()
  }, [active, grid, sections])

  function orient(value: QuickView3D) { scene.current?.controls.fit(value) }

  return (
    <section className="panel viewport viewport-3d" aria-label={t('viewport')}>
      <div className="viewport-tools">
        <div className="segmented" role="group" aria-label={t('resultView')}>
          {choices.map(([value, label, tip]) => <Tooltip key={value} message={tip}>
            <button type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>{t(label)}</button>
          </Tooltip>)}
        </div>
        <div className="segmented" role="group" aria-label={t('camera3d')}>
          <Tooltip message="hint3dCameraNX"><button type="button" aria-pressed={cameraMode === 'nx'} onClick={() => setCameraMode('nx')}>Siemens NX</button></Tooltip>
          <Tooltip message="hint3dCameraStandard"><button type="button" aria-pressed={cameraMode === 'standard'} onClick={() => setCameraMode('standard')}>{t('standard3d')}</button></Tooltip>
        </div>
      </div>
      <div className="viewport-field-3d">
        <canvas ref={canvas} tabIndex={0} aria-label={t('viewport')} aria-describedby="camera-hint-3d" />
        <div className="view-presets-3d segmented" role="group" aria-label={t('quickViews3d')}>
          {views.map(([value, label, tip]) => <Tooltip message={tip} key={value}>
            <button type="button" disabled={failed} onClick={() => orient(value)}>{t(label)}{value === 'fit' && ' / F'}</button>
          </Tooltip>)}
        </div>
        <p id="camera-hint-3d" className="camera-hint-3d">{t(cameraMode === 'nx' ? 'nxHint3d' : 'standardHint3d')}</p>
        {failed && <p role="alert" className="viewport-notice-3d">{t('webglError3d')}</p>}
        {!failed && view !== 'voxels' && !surface?.triangles.length &&
          <p className="viewport-notice-3d">{t('noMaterial')} {t('helpThreshold')}</p>}
        {view === 'stress' && frame && <div className="scale stress-legend-3d">
          <div>{t('stress')} · {t('MPa')}</div>
          <div className="scale-ramp stress-ramp" />
          <div className="scale-labels"><span>0</span><span>{significant(frame.p95VonMises || frame.maxVonMises)}</span></div>
          <div className="scale-peak">{t('peakStress')} {significant(frame.maxVonMises)}</div>
        </div>}
      </div>
      <div className="viewport-tools inspection-3d">
        <div className="section-planes-3d" role="group" aria-label={t('sections3d')}>
          {sections.map((value, i) => <div key={axes[i]} className="section-axis-3d">
            <Tooltip message="hint3dSection"><label htmlFor={`section-3d-${i}`}>{axes[i]}</label></Tooltip>
            <input id={`section-3d-${i}`} type="range" min="0" max="1" step="0.01" value={value}
              aria-valuetext={`${fixed(value * limits[i], 1)} ${t('mm')}`}
              onChange={event => setSections(sections.map((prior, axis) => axis === i ? event.target.valueAsNumber : prior))} />
            <output>{fixed(value * limits[i], 1)} {t('mm')}</output>
          </div>)}
        </div>
        <div className="overlay-controls" role="group" aria-label={t('overlays')}>
          <Tooltip message="hint3dSupports"><label><input type="checkbox" checked={showSupports} onChange={event => setShowSupports(event.target.checked)} />{t('supports')}</label></Tooltip>
          <Tooltip message="hint3dForces"><label><input type="checkbox" checked={showLoads} onChange={event => setShowLoads(event.target.checked)} />{t('forces')}</label></Tooltip>
        </div>
      </div>
    </section>
  )
}
