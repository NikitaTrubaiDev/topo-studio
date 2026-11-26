import { MathUtils, PerspectiveCamera, Spherical, Vector3 } from 'three'

export type CameraMode3D = 'nx' | 'standard'
export type QuickView3D = 'iso' | 'front' | 'top' | 'right' | 'fit'

export function isFitShortcut(event: KeyboardEvent) {
  return (event.code === 'KeyF' || event.key.toLowerCase() === 'f') && !event.ctrlKey && !event.metaKey && !event.altKey &&
    !(event.target instanceof HTMLElement && event.target.closest('input, select, textarea, [contenteditable], dialog'))
}

export function cameraGesture(mode: CameraMode3D, button: number, shift: boolean, ctrl: boolean, touch = false) {
  if (touch) return 'orbit'
  if (mode === 'nx') {
    if (shift && (button === 0 || button === 1)) return 'pan'
    if (button === 1) return ctrl ? 'zoom' : 'orbit'
  } else {
    if (button === 0) return shift ? 'pan' : 'orbit'
    if (button === 1 || button === 2) return 'pan'
  }
}

export function createCamera3D(canvas: HTMLCanvasElement, camera: PerspectiveCamera, center: Vector3, span: number, draw: () => void) {
  const target = center.clone()
  const offset = new Vector3(), right = new Vector3(), up = new Vector3()
  const spherical = new Spherical()
  let mode: CameraMode3D = 'nx'
  let editing = false
  let isFitted = false
  let drag: { id: number; x: number; y: number; gesture: NonNullable<ReturnType<typeof cameraGesture>> } | undefined
  let claimedPointer: number | undefined
  const maxZoomDistance = span * 30
  camera.far = Math.max(camera.far, maxZoomDistance + span * 2)
  camera.updateProjectionMatrix()

  function zoom(factor: number) {
    offset.subVectors(camera.position, target)
    offset.setLength(MathUtils.clamp(offset.length() * factor, span * 0.05, maxZoomDistance))
    camera.position.copy(target).add(offset)
  }

  function fit(view: QuickView3D = 'fit') {
    if (view === 'iso') offset.set(1, 1, 1)
    else if (view === 'front') offset.set(0, 0, 1)
    else if (view === 'top') offset.set(0, 1, 0)
    else if (view === 'right') offset.set(1, 0, 0)
    else offset.subVectors(camera.position, target)
    if (view !== 'fit') camera.up.set(0, view === 'top' ? 0 : 1, view === 'top' ? -1 : 0)
    const vertical = MathUtils.degToRad(camera.fov) / 2
    const angle = Math.min(vertical, Math.atan(Math.tan(vertical) * camera.aspect))
    const distance = 0.56 * span / Math.sin(angle)
    if (distance + span > camera.far) {
      camera.far = distance + span
      camera.updateProjectionMatrix()
    }
    target.copy(center)
    camera.position.copy(target).add(offset.setLength(distance))
    camera.lookAt(target)
    isFitted = true
    draw()
  }

  function resize(aspect: number) {
    camera.aspect = aspect
    camera.updateProjectionMatrix()
    if (isFitted) fit()
    else draw()
  }

  function down(event: PointerEvent) {
    const gesture = cameraGesture(editing ? 'nx' : mode, event.button, event.shiftKey, event.ctrlKey, event.pointerType === 'touch')
    if (drag) return
    claimedPointer = undefined
    if (!gesture) return
    claimedPointer = event.pointerId
    event.preventDefault()
    canvas.focus({ preventScroll: true })
    canvas.setPointerCapture(event.pointerId)
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, gesture }
    canvas.dataset.drag = gesture
  }

  function move(event: PointerEvent) {
    if (!drag || drag.id !== event.pointerId) return
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y
    drag.x = event.clientX
    drag.y = event.clientY
    if (!dy && (!dx || drag.gesture === 'zoom')) return
    isFitted = false
    const height = Math.max(1, canvas.clientHeight)
    if (drag.gesture === 'zoom') zoom(Math.exp(dy * 0.012))
    else if (drag.gesture === 'orbit') {
      offset.subVectors(camera.position, target)
      spherical.setFromVector3(offset)
      spherical.theta -= dx * 2 * Math.PI / height
      spherical.phi = MathUtils.clamp(spherical.phi - dy * 2 * Math.PI / height, 0.001, Math.PI - 0.001)
      camera.up.set(0, 1, 0)
      camera.position.copy(target).add(offset.setFromSpherical(spherical))
    } else {
      camera.updateMatrix()
      right.setFromMatrixColumn(camera.matrix, 0)
      up.setFromMatrixColumn(camera.matrix, 1)
      const unit = 2 * camera.position.distanceTo(target) * Math.tan(MathUtils.degToRad(camera.fov / 2)) / height
      offset.copy(right).multiplyScalar(-dx * unit).addScaledVector(up, dy * unit)
      camera.position.add(offset)
      target.add(offset)
    }
    camera.lookAt(target)
    draw()
  }

  function end(event: PointerEvent) {
    if (drag?.id !== event.pointerId) return
    drag = undefined
    delete canvas.dataset.drag
  }

  function wheel(event: WheelEvent) {
    event.preventDefault()
    if (!event.deltaY) return
    isFitted = false
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1
    zoom(Math.exp(MathUtils.clamp(event.deltaY * units * 0.0015, -1, 1)))
    draw()
  }

  const suppress = (event: MouseEvent) => event.preventDefault()
  const suppressMiddle = (event: MouseEvent) => { if (event.button === 1) event.preventDefault() }
  canvas.addEventListener('pointerdown', down)
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', end)
  canvas.addEventListener('lostpointercapture', end)
  canvas.addEventListener('pointercancel', end)
  canvas.addEventListener('wheel', wheel, { passive: false })
  canvas.addEventListener('mousedown', suppressMiddle)
  canvas.addEventListener('auxclick', suppressMiddle)
  canvas.addEventListener('contextmenu', suppress)

  return {
    fit, resize,
    // The browser can synthesize a click after pointerup and lostpointercapture.
    claimedEditEvent(event: MouseEvent) {
      return claimedPointer !== undefined && (!('pointerId' in event) || event.pointerId === claimedPointer)
    },
    setEditing(value: boolean) { editing = value },
    setMode(value: CameraMode3D) { mode = value; canvas.dataset.camera = value },
    dispose() {
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', end)
      canvas.removeEventListener('lostpointercapture', end)
      canvas.removeEventListener('pointercancel', end)
      canvas.removeEventListener('wheel', wheel)
      canvas.removeEventListener('mousedown', suppressMiddle)
      canvas.removeEventListener('auxclick', suppressMiddle)
      canvas.removeEventListener('contextmenu', suppress)
    },
  }
}
