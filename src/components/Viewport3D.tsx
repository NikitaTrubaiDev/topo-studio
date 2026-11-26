import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ACESFilmicToneMapping, ArrowHelper, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry,
  DirectionalLight, EdgesGeometry, FrontSide, GridHelper, Group, HemisphereLight, InstancedMesh, Line, LineBasicMaterial, LineSegments,
  MathUtils, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera, Plane, Raycaster, Scene, SphereGeometry, Vector2, Vector3, WebGLRenderer,
} from 'three'
import { useTranslation } from '../i18n'
import { brickMasks3D, caseColor3D, caseNumber, forceMagnitude3D, validForceMagnitude3D, type EditTool3D, type ForceVector3D } from '../solver3d/design3d'
import { nodalField3D } from '../solver3d/mesh3d'
import { cellSize, nodeIndex3D, nodePosition, type Grid3D, type SimpProblem3D } from '../solver3d/types3d'
import type { Surface3D, creaseGeometry3D } from '../solver3d/surface3d'
import { createCamera3D, isFitShortcut, type CameraMode3D, type QuickView3D } from './camera3d'
import { designDomainMesh3D, firstVisibleMeshHit3D, snapEditNode3D } from './viewportPicking3d'
import { Tooltip } from './Tooltip'
import type { FemEvent3D, FemGeometry3D, FemRequest3D, TimedSnapshot3D } from '../workers/protocol3d'

const views = [
  ['iso', 'iso3d', 'hint3dIso'], ['front', 'front3d', 'hint3dFront'], ['top', 'top3d', 'hint3dTop'],
  ['right', 'right3d', 'hint3dRight'], ['fit', 'fit3d', 'hint3dFit'],
] as const
const choices = [
  ['auto', 'auto3d', 'hint3dAuto'], ['cad', 'smoothCad3d', 'hint3dCAD'],
  ['stress', 'stress', 'hint3dStress'], ['voxels', 'femMesh3d', 'hint3dFemMesh'],
  ['density', 'meshDensity3d', 'hint3dMeshDensity'],
] as const
export type ViewMode3D = typeof choices[number][0]

const stressPalette = ['#182840', '#127ba8', '#3cc39c', '#f4d568', '#f86b60'].map(value => new Color(value))
const refinementPalette = ['#607fa5', '#34c5dd', '#f1ab49']
const axes = ['X', 'Y', 'Z']

function stressColor(color: Color, ratio: number) {
  const scaled = MathUtils.clamp(Number.isNaN(ratio) ? 0 : ratio, 0, 1) * (stressPalette.length - 1)
  const index = Math.min(stressPalette.length - 2, Math.floor(scaled))
  return color.copy(stressPalette[index]).lerp(stressPalette[index + 1], scaled - index)
}

function disposeGroup(group: Group | Scene) {
  const geometries = new Set<BufferGeometry>()
  group.traverse(object => {
    if (object instanceof InstancedMesh) object.dispose()
    if (object instanceof Mesh || object instanceof Line) {
      geometries.add(object.geometry)
      if (Array.isArray(object.material)) object.material.forEach(material => material.dispose())
      else object.material.dispose()
    }
  })
  for (const geometry of geometries) geometry.dispose()
  group.clear()
}

function layoutForces(problem: SimpProblem3D) {
  const { grid, loadCases } = problem
  const forces = loadCases.flatMap(load => load.forces.map(force => ({ ...force, caseId: load.id, magnitude: forceMagnitude3D(force) }))
    .filter(force => validForceMagnitude3D(force.magnitude)))
  const max = forces.reduce((peak, force) => Math.max(peak, force.magnitude), 0)
  const span = Math.max(grid.widthMm, grid.heightMm, grid.depthMm)
  const size = Math.min(...cellSize(grid))
  const counts = new Map<number, number>(), next = new Map<number, number>()
  for (const { node } of forces) counts.set(node, (counts.get(node) ?? 0) + 1)
  return forces.map(force => {
    const direction = new Vector3(force.fx, force.fy, force.fz)
    const length = arrowLength(span, force.magnitude, max)
    direction.divideScalar(force.magnitude)
    const point = new Vector3(...nodePosition(grid, force.node))
    const order = next.get(force.node) ?? 0
    next.set(force.node, order + 1)
    // Fan arrows out at shared nodes so matching vectors from different cases
    // remain visible as separate arrows and never occupy the same depth.
    const shift = order - ((counts.get(force.node) ?? 1) - 1) / 2
    if (shift) {
      const sideways = new Vector3(0, Math.abs(direction.y) < 0.9 ? 1 : 0, Math.abs(direction.y) < 0.9 ? 0 : 1)
      point.addScaledVector(sideways.cross(direction).normalize(), shift * size * 0.48)
    }
    return { ...force, direction, point, length }
  })
}

function addBoundaryOverlays(problem: SimpProblem3D, supportLayer: Group, forceLayer: Group, caseId: string, editing: boolean, clippingPlanes: Plane[]) {
  const { grid, supports } = problem
  const size = Math.min(...cellSize(grid))
  const marker = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial({ color: '#54dac8', clippingPlanes }), supports.length)
  const matrix = new Object3D()
  supports.forEach((support, i) => {
    matrix.position.fromArray(nodePosition(grid, support.node))
    matrix.scale.set(size * 0.32, size * (support.fixX || support.fixZ ? 0.32 : 0.7), size * 0.32)
    matrix.updateMatrix()
    marker.setMatrixAt(i, matrix.matrix)
  })
  supportLayer.add(marker)
  const forces = layoutForces(problem)
  if (!forces.length) return
  const shaft = new InstancedMesh(new CylinderGeometry(1, 1, 1, 6),
    new MeshBasicMaterial({ toneMapped: false, depthTest: !editing, depthWrite: !editing, clippingPlanes }), forces.length)
  const head = new InstancedMesh(new ConeGeometry(1, 1, 8),
    new MeshBasicMaterial({ toneMapped: false, depthTest: !editing, depthWrite: !editing, clippingPlanes }), forces.length)
  shaft.renderOrder = head.renderOrder = editing ? 2 : 0
  const y = new Vector3(0, 1, 0)
  forces.forEach(({ point, direction, length, caseId: id }, i) => {
    const tip = Math.min(length * 0.34, size * 1.4)
    const radius = Math.min(size * 0.22, tip * 0.28)
    matrix.quaternion.setFromUnitVectors(y, direction)
    matrix.scale.set(radius * 0.37, length - tip, radius * 0.37)
    matrix.position.copy(point).addScaledVector(direction, -(length + tip) / 2)
    matrix.updateMatrix()
    shaft.setMatrixAt(i, matrix.matrix)
    const shade = new Color(caseColor3D(caseNumber(id) - 1))
    if (caseId !== id) shade.multiplyScalar(0.66)
    shaft.setColorAt(i, shade)
    head.setColorAt(i, shade)
    matrix.scale.set(radius, tip, radius)
    matrix.position.copy(point).addScaledVector(direction, -tip / 2)
    matrix.updateMatrix()
    head.setMatrixAt(i, matrix.matrix)
  })
  forceLayer.add(shaft, head)
}

export function arrowLength(span: number, magnitude: number, max: number) {
  if (!validForceMagnitude3D(magnitude)) return 0
  const scale = validForceMagnitude3D(max) ? Math.max(magnitude, max) : magnitude
  return span * (0.045 + 0.13 * Math.sqrt(magnitude / scale))
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
  const box = new BoxGeometry(x * 1.004, y * 1.004, z * 1.004)
  const domain = new LineSegments(new EdgesGeometry(box), new LineBasicMaterial({ color: '#7899ab', transparent: true, opacity: 0.48 }))
  box.dispose()
  domain.position.copy(center)
  scene.add(domain)
  const model = new Group(), ghost = new Group(), supports = new Group(), loads = new Group()
  const marker = new Mesh(new SphereGeometry(Math.min(...cellSize(grid)) * 0.28, 12, 8),
    new MeshBasicMaterial({ color: '#e9feff', depthTest: false, depthWrite: false }))
  const arrow = new ArrowHelper(new Vector3(0, 1, 0), new Vector3(), 1, '#fbb075')
  for (const mesh of [arrow.line, arrow.cone]) {
    if (!Array.isArray(mesh.material)) {
      mesh.material.depthTest = false
      mesh.material.depthWrite = false
    }
    mesh.renderOrder = 3
  }
  marker.renderOrder = 3
  marker.visible = arrow.visible = false
  scene.add(model, ghost, supports, loads, marker, arrow)
  const camera = new PerspectiveCamera(37, 1, span * 0.01, span * 25)
  const render = () => renderer.render(scene, camera)
  const controls = createCamera3D(canvas, camera, center, span, render)
  const planes: Plane[] = []
  const sectionPlanes = [new Plane(new Vector3(-1, 0, 0), x), new Plane(new Vector3(0, -1, 0), y),
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
  return { model, ghost, supports, loads, controls, planes, sectionPlanes, render, camera, marker, arrow, dispose() {
    observer.disconnect()
    controls.dispose()
    disposeGroup(scene)
    renderer.dispose()
  } }
}

function femMesh(data: FemGeometry3D, wireframe: boolean, planes: Plane[], levels?: Uint8Array, opacity?: number) {
  const position = new BufferAttribute(data.positions, 3)
  let geometry = new BufferGeometry()
  geometry.setAttribute('position', position)
  geometry.setIndex(new BufferAttribute(data.triangles, 1))
  if (levels) {
    const expanded = geometry.toNonIndexed()
    geometry.dispose()
    geometry = expanded
    const palette = refinementPalette.map(value => new Color(value))
    const colors = new Float32Array(3 * data.triangles.length)
    data.faceElements.forEach((e, face) => {
      const color = palette[levels[e]]
      for (let j = 0; j < 3; j++) color.toArray(colors, 9 * face + 3 * j)
    })
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
  }
  const group = new Group()
  const surface = opacity === undefined ? new MeshStandardMaterial({
    color: levels ? '#ffffff' : '#afc3d7', vertexColors: !!levels, metalness: levels ? 0.02 : 0.28,
    roughness: 0.54, flatShading: true, side: FrontSide, clippingPlanes: planes,
    polygonOffset: wireframe, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  }) : new MeshBasicMaterial({ color: '#84b4cc', transparent: true, opacity, depthWrite: false,
    side: FrontSide, clippingPlanes: planes, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 })
  group.add(new Mesh(geometry, surface))
  if (wireframe) {
    const edges = new BufferGeometry()
    edges.setAttribute('position', new BufferAttribute(data.positions, 3))
    edges.setIndex(new BufferAttribute(data.edges, 1))
    group.add(new LineSegments(edges, new LineBasicMaterial({ color: opacity === undefined ? '#233447' : '#8babbe',
      clippingPlanes: planes, ...(opacity !== undefined && { transparent: true, opacity: opacity * 1.5, depthWrite: false }) })))
  }
  return group
}

export function surfaceMesh(problem: SimpProblem3D, surface: Surface3D, planes: Plane[], frame?: TimedSnapshot3D,
  render?: ReturnType<typeof creaseGeometry3D>) {
  const { faceElements, triangles, vertices } = surface
  const geometry = new BufferGeometry()
  const stressMaterial = () => new MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: FrontSide, clippingPlanes: planes })
  if (frame && faceElements) {
    const positions = render?.positions ?? Float32Array.from({ length: 3 * triangles.length }, (_, i) =>
      vertices[3 * triangles[Math.floor(i / 3)] + i % 3])
    const colors = new Float32Array(positions.length)
    const peak = [frame.p95VonMises, frame.maxVonMises].find(value => Number.isFinite(value) && value > 0) ?? 1
    const color = new Color()
    faceElements.forEach((element, face) => {
      stressColor(color, frame.vonMises[element] / peak)
      for (let corner = 0; corner < 3; corner++) color.toArray(colors, 9 * face + 3 * corner)
    })
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
    return new Mesh(geometry, stressMaterial())
  }
  if (!frame && render) {
    geometry.setAttribute('position', new BufferAttribute(render.positions, 3))
    geometry.setAttribute('normal', new BufferAttribute(render.normals, 3))
  } else {
    geometry.setAttribute('position', new BufferAttribute(Float32Array.from(vertices), 3))
    geometry.setIndex(new BufferAttribute(triangles, 1))
    if (!frame) geometry.computeVertexNormals()
  }
  if (frame) {
    const { grid } = problem
    const { nelx, nely, nelz } = grid
    const size = cellSize(grid)
    const nodal = problem.elementType === 'tet4' ? nodalField3D(grid, 'tet4', frame.vonMises, frame.density) : undefined
    const offset = nodal ? 0 : 0.5
    const maxX = nelx - 2 * offset, maxY = nely - 2 * offset, maxZ = nelz - 2 * offset
    const colors = new Float32Array(vertices.length)
    const peak = [frame.p95VonMises, frame.maxVonMises].find(value => Number.isFinite(value) && value > 0) ?? 1
    const color = new Color()
    for (let j = 0; j < vertices.length; j += 3) {
      const cx = MathUtils.clamp(vertices[j] / size[0] - offset, 0, maxX)
      const cy = MathUtils.clamp(vertices[j + 1] / size[1] - offset, 0, maxY)
      const cz = MathUtils.clamp(vertices[j + 2] / size[2] - offset, 0, maxZ)
      const x = Math.floor(cx), y = Math.floor(cy), z = Math.floor(cz)
      let value = 0, weightSum = 0
      for (let k = 0; k <= 1; k++) for (let l = 0; l <= 1; l++) for (let m = 0; m <= 1; m++) {
        const e = ((Math.min(z + k, nelz - 1) * nely + Math.min(y + l, nely - 1)) * nelx + Math.min(x + m, nelx - 1))
        const w = (k ? cz - z : 1 - cz + z) * (l ? cy - y : 1 - cy + y) * (m ? cx - x : 1 - cx + x)
        const weighted = nodal ? w : w * frame.density[e]
        const stress = nodal ? nodal[nodeIndex3D(grid, Math.min(x + m, nelx), Math.min(y + l, nely), Math.min(z + k, nelz))]
          : frame.vonMises[e]
        if (!(weighted > 0 && Number.isFinite(weighted) && Number.isFinite(stress))) continue
        value += weighted * stress
        weightSum += weighted
      }
      stressColor(color, value / (weightSum || 1) / peak).toArray(colors, j)
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
    return new Mesh(geometry, stressMaterial())
  }
  return new Mesh(geometry, new MeshStandardMaterial({
    color: '#afc3d7', metalness: 0.37, roughness: 0.42, side: FrontSide, clippingPlanes: planes,
  }))
}

type Editor3D = {
  tool: EditTool3D
  setTool: (tool: EditTool3D) => void
  force: ForceVector3D
  caseId: string
  place: (node: number) => void
  remove: (node: number) => void
}

const editTools = [
  ['orbit', 'orbitInspect3d', 'hint3dOrbitInspect'],
  ['load', 'placeLoad3d', 'hint3dPlaceLoad'],
  ['support', 'placeSupport3d', 'hint3dPlaceSupport'],
] as const

export function Viewport3D({ active, problem, density, mode, setMode, view, surface, frame, threshold, setThreshold, renderData, editor }: {
  active: boolean
  problem: SimpProblem3D
  density: Float64Array | undefined
  mode: ViewMode3D
  setMode: (mode: ViewMode3D) => void
  view: Exclude<ViewMode3D, 'auto'>
  surface?: Surface3D
  frame?: TimedSnapshot3D
  threshold: number
  setThreshold: (value: number) => void
  renderData?: ReturnType<typeof creaseGeometry3D>
  editor: Editor3D
}) {
  const { t, significant, fixed } = useTranslation()
  const canvas = useRef<HTMLCanvasElement>(null)
  const scene = useRef<ReturnType<typeof setupScene> | null>(null)
  const [failed, setFailed] = useState(false)
  const [cameraMode, setCameraMode] = useState<CameraMode3D>('nx')
  const [showSupports, setShowSupports] = useState(true)
  const [wireframe, setWireframe] = useState(false)
  const [showGhost, setShowGhost] = useState(false)
  const [ghostOpacity, setGhostOpacity] = useState(0.15)
  const femView = view === 'voxels' || view === 'density'
  const refinementView = view === 'density'
  const showEdges = wireframe || refinementView
  const [showLoads, setShowLoads] = useState(true)
  const [sections, setSections] = useState([1, 1, 1])
  const sectioned = sections.some(value => value < 1)
  const [fem, setFem] = useState<{ request: FemRequest3D; geometry: FemEvent3D }>()
  const femThreshold = problem.mesh && !frame && !showGhost ? Number.MIN_VALUE
    : mode === 'auto' && !showGhost ? Math.min(0.12, threshold) : threshold
  const femType = problem.elementType ?? 'hex8'
  const hasDensity = !!density
  const { grid, params, passive } = problem
  const { voidMask } = useMemo(() => brickMasks3D({ grid, params, passive }), [grid, params, passive])
  const tool = editor.tool
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
    const { supports, loads, planes, render } = scene.current
    disposeGroup(supports)
    disposeGroup(loads)
    addBoundaryOverlays(problem, supports, loads, editor.caseId, tool === 'load', planes)
    render()
  }, [active, problem, editor.caseId, tool])

  useEffect(() => {
    if (!active || (!femView && !showGhost) || !density) return
    const request: FemRequest3D = { type: 'fem', density, grid, threshold: femThreshold, elementType: femType,
      wireframe: femView && showEdges, mesh: problem.mesh, ...(showGhost && { ghostThreshold: threshold }) }
    let live = true
    const worker = new Worker(new URL('../workers/surface3dWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }: MessageEvent<FemEvent3D>) => {
      if (live) setFem({ request, geometry: data })
      worker.terminate()
    }
    worker.postMessage(request)
    return () => { live = false; worker.terminate() }
  }, [active, femView, density, grid, femThreshold, femType, showEdges, problem.mesh, showGhost, threshold])

  useEffect(() => {
    const current = scene.current
    if (!current) return
    const { model, ghost, planes, render } = current
    disposeGroup(model)
    disposeGroup(ghost)
    const clipping = sectioned ? planes : []
    const geometry = hasDensity && fem?.request.grid === grid && fem.request.elementType === femType && fem.request.wireframe === (femView && showEdges) && fem.request.mesh === problem.mesh
      ? fem.geometry : undefined
    const solid = femView
      ? geometry?.triangles.length && femMesh(geometry, showEdges, clipping, refinementView ? problem.mesh?.levels : undefined)
      : surface?.triangles.length ? surfaceMesh(problem, surface, clipping, view === 'stress' ? frame : undefined, renderData) : undefined
    if (solid) {
      model.add(solid)
      const skin = solid instanceof Mesh ? solid : solid.children.find(object => object instanceof Mesh)
      if (clipping.length && skin instanceof Mesh) model.add(new Mesh(skin.geometry,
        new MeshBasicMaterial({ color: '#293a4d', side: BackSide, clippingPlanes: clipping,
          polygonOffset: showEdges && femView, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })))
    }
    if (showGhost && geometry?.ghost?.triangles.length) ghost.add(femMesh(geometry.ghost, true, clipping, undefined, ghostOpacity))
    render()
  }, [active, grid, problem, view, femView, refinementView, surface, frame, fem, femType, hasDensity, showEdges, sectioned, renderData, showGhost, ghostOpacity])

  useEffect(() => {
    const current = scene.current
    if (!current) return
    const dimensions = [grid.widthMm, grid.heightMm, grid.depthMm]
    current.planes.length = 0
    current.sectionPlanes.forEach((plane, i) => {
      if (sections[i] === 1) return
      // Keep the cut off exact element faces and aligned wireframe.
      plane.constant = dimensions[i] * (sections[i] - 1e-6)
      current.planes.push(plane)
    })
    current.marker.visible = current.arrow.visible = false
    current.render()
  }, [active, grid, sections])

  useEffect(() => {
    if (!scene.current) return
    const { supports, loads, render } = scene.current
    supports.visible = showSupports
    loads.visible = showLoads
    render()
  }, [active, grid, showSupports, showLoads])

  useEffect(() => {
    const current = scene.current
    const element = canvas.current
    if (!current || !element) return
    const { camera, model, planes, loads, supports, marker, arrow, controls, render } = current
    controls.setEditing(tool !== 'orbit')
    if (tool === 'orbit') { render(); return }
    const ray = new Raycaster()
    const direction = new Vector3()
    const span = Math.max(grid.widthMm, grid.heightMm, grid.depthMm)
    const magnitude = forceMagnitude3D(editor.force)
    const forces = layoutForces(problem)
    const max = forces.reduce((peak, force) => Math.max(peak, force.magnitude), 0)
    let fallback: ReturnType<typeof designDomainMesh3D> | undefined
    function aim(event: MouseEvent) {
      const rect = element!.getBoundingClientRect()
      ray.setFromCamera(new Vector2(2 * (event.clientX - rect.left) / rect.width - 1,
        1 - 2 * (event.clientY - rect.top) / rect.height), camera)
      const forward = ray.ray.direction.dot(camera.getWorldDirection(direction))
      ray.near = camera.near / forward
      ray.far = camera.far / forward
    }
    function snap(event: MouseEvent) {
      aim(event)
      const pickable = model.children.length ? model : (fallback ??= designDomainMesh3D(grid, voidMask, sectioned))
      const hit = firstVisibleMeshHit3D(ray, pickable, planes)
      return hit && snapEditNode3D(grid, hit.point, voidMask, planes)
    }
    function clear() {
      marker.visible = arrow.visible = false
      render()
    }
    function hover(event: PointerEvent) {
      if (event.buttons || event.shiftKey) { if (marker.visible) clear(); return }
      const snapped = snap(event)
      if (!snapped) { if (marker.visible) clear(); return }
      marker.position.copy(snapped.point)
      marker.material.color.set(snapped.valid ? '#e9feff' : '#81909d')
      marker.visible = true
      const length = arrowLength(span, magnitude, max)
      arrow.visible = tool === 'load' && snapped.valid && length > 0
      if (arrow.visible) {
        direction.set(editor.force.fx, editor.force.fy, editor.force.fz).normalize()
        arrow.position.copy(marker.position).addScaledVector(direction, -length)
        arrow.setDirection(direction)
        arrow.setLength(length, length * 0.24, length * 0.13)
        arrow.setColor(new Color(caseColor3D(caseNumber(editor.caseId) - 1)))
      }
      render()
    }
    function place(event: MouseEvent) {
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || controls.claimedEditEvent(event)) return
      const snapped = snap(event)
      if (snapped?.valid) editor.place(snapped.node)
    }
    function remove(event: MouseEvent) {
      event.preventDefault()
      if (event.button !== 2 || controls.claimedEditEvent(event)) return
      const overlay = tool === 'load' ? loads : supports
      if (!overlay.visible) return
      aim(event)
      const occlusion = tool === 'support' ? firstVisibleMeshHit3D(ray, model, planes)?.distance : undefined
      const hit = firstVisibleMeshHit3D(ray, overlay, planes, occlusion)
      if (hit?.instanceId === undefined) return
      const force = forces[hit.instanceId]
      if (tool === 'support') editor.remove(problem.supports[hit.instanceId].node)
      else if (force?.caseId === editor.caseId) editor.remove(force.node)
    }
    element.addEventListener('pointermove', hover)
    element.addEventListener('pointerleave', clear)
    element.addEventListener('click', place)
    element.addEventListener('contextmenu', remove)
    return () => {
      element.removeEventListener('pointermove', hover)
      element.removeEventListener('pointerleave', clear)
      element.removeEventListener('click', place)
      element.removeEventListener('contextmenu', remove)
      marker.visible = arrow.visible = false
      fallback?.geometry.dispose()
      fallback?.material.dispose()
    }
  }, [active, editor, grid, problem, sectioned, tool, voidMask])

  function orient(value: QuickView3D) { scene.current?.controls.fit(value) }

  return (
    <section className="panel viewport viewport-3d" aria-label={t('viewport')}>
      <div className="viewport-tools">
        <div className="segmented" role="group" aria-label={t('resultView')}>
          {choices.filter(([value]) => value !== 'density' || femType === 'adaptiveTet4').map(([value, label, tip]) => <Tooltip key={value} message={tip}>
            <button type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>{t(label)}</button>
          </Tooltip>)}
        </div>
        <div className="segmented" role="group" aria-label={t('camera3d')}>
          <Tooltip message="hint3dCameraNX"><button type="button" aria-pressed={cameraMode === 'nx'} onClick={() => setCameraMode('nx')}>Siemens NX</button></Tooltip>
          <Tooltip message="hint3dCameraStandard"><button type="button" aria-pressed={cameraMode === 'standard'} onClick={() => setCameraMode('standard')}>{t('standard3d')}</button></Tooltip>
        </div>
      </div>
      <div className="viewport-tools">
        <div className="segmented" role="group" aria-label={t('drawTools')}>
          {editTools.map(([value, label, tip]) => <Tooltip key={value} message={tip}>
            <button type="button" disabled={failed && value !== 'orbit'} aria-pressed={tool === value}
              onClick={() => editor.setTool(value)}>{t(label)}</button>
          </Tooltip>)}
        </div>
      </div>
      <div className="viewport-field-3d">
        <canvas ref={canvas} data-tool={tool} tabIndex={0} aria-label={t('viewport')} aria-describedby="camera-hint-3d" />
        <div className="view-presets-3d segmented" role="group" aria-label={t('quickViews3d')}>
          {views.map(([value, label, tip]) => <Tooltip message={tip} key={value}>
            <button type="button" disabled={failed} onClick={() => orient(value)}>{t(label)}{value === 'fit' && ' / F'}</button>
          </Tooltip>)}
        </div>
        <p id="camera-hint-3d" className="camera-hint-3d">{t(tool === 'load' ? 'hint3dPlaceLoad' : tool === 'support' ? 'hint3dPlaceSupport' : cameraMode === 'nx' ? 'nxHint3d' : 'standardHint3d')}</p>
        {failed && <p role="alert" className="viewport-notice-3d">{t('webglError3d')}</p>}
        {!failed && (femView ? mode !== 'auto' && density && !density.some(value => value >= femThreshold)
          : surface && !surface.triangles.length) &&
          <p className="viewport-notice-3d">{t('noMaterial')} {t('helpThreshold')}</p>}
        {refinementView && problem.mesh && <div className="mesh-legend-3d">
          {(['meshCoarse3d', 'meshMedium3d', 'meshFine3d'] as const).map((key, i) => <span key={key}>
            <i style={{ background: refinementPalette[i] }} />{t(key)}
          </span>)}
        </div>}
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
        {(mode === 'voxels' || refinementView || showGhost) && <div className="mesh-threshold-3d">
          <Tooltip message="hint3dMeshThreshold"><label htmlFor="mesh-threshold-3d">{t('threshold')}</label></Tooltip>
          <input id="mesh-threshold-3d" type="range" min={0.01} max={0.99} step={0.01} value={threshold}
            aria-valuetext={fixed(threshold, 2)} onChange={event => setThreshold(event.target.valueAsNumber)} />
        </div>}
        <div className="overlay-controls" role="group" aria-label={t('overlays')}>
          <Tooltip message="hint3dMeshWireframe"><label><input type="checkbox" checked={wireframe} onChange={event => {
            setWireframe(event.target.checked)
            if (event.target.checked && !femView) setMode('voxels')
          }} />{t('meshWireframe3d')}</label></Tooltip>
          <Tooltip message="hint3dGhost"><label><input type="checkbox" checked={showGhost}
            onChange={event => setShowGhost(event.target.checked)} />{t('removedGhost3d')}</label></Tooltip>
          {showGhost && <Tooltip message="hint3dGhostOpacity"><label>{t('ghostOpacity3d')}
            <input type="range" min={0.05} max={0.35} step={0.01} value={ghostOpacity}
              onChange={event => setGhostOpacity(event.target.valueAsNumber)} />
          </label></Tooltip>}
          <Tooltip message="hint3dSupports"><label><input type="checkbox" checked={showSupports} onChange={event => setShowSupports(event.target.checked)} />{t('supports')}</label></Tooltip>
          <Tooltip message="hint3dForces"><label><input type="checkbox" checked={showLoads} onChange={event => setShowLoads(event.target.checked)} />{t('forces')}</label></Tooltip>
        </div>
      </div>
    </section>
  )
}
