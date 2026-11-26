// @vitest-environment happy-dom

import { PerspectiveCamera, Vector3 } from 'three'
import { expect, it } from 'vitest'
import { cameraGesture, createCamera3D, isFitShortcut } from '../camera3d'

it('uses Siemens NX mouse gestures with Shift pan taking precedence', () => {
  expect(cameraGesture('nx', 1, false, false)).toBe('orbit')
  expect(cameraGesture('nx', 0, true, false)).toBe('pan')
  expect(cameraGesture('nx', 1, true, false)).toBe('pan')
  expect(cameraGesture('nx', 1, false, true)).toBe('zoom')
  expect(cameraGesture('nx', 1, true, true)).toBe('pan')
  expect(cameraGesture('nx', 0, false, false)).toBeUndefined()
})

it('allows conventional left orbit and right or middle pan in Standard mode', () => {
  expect(cameraGesture('standard', 0, false, false)).toBe('orbit')
  expect(cameraGesture('standard', 2, false, false)).toBe('pan')
  expect(cameraGesture('standard', 1, false, false)).toBe('pan')
})

it('fits with physical F on Russian, German and English layouts and ignores form fields', () => {
  function press(target: EventTarget, key: string, code?: string, ctrlKey = false) {
    let fit = false
    target.addEventListener('keydown', event => { fit = isFitShortcut(event as KeyboardEvent) }, { once: true })
    target.dispatchEvent(new KeyboardEvent('keydown', { key, code, ctrlKey }))
    return fit
  }
  const canvas = document.createElement('canvas')
  expect(press(canvas, 'а', 'KeyF')).toBe(true)
  expect(press(canvas, 'F', 'KeyF')).toBe(true)
  expect(press(canvas, 'f')).toBe(true)
  expect(press(canvas, 'а', 'KeyF', true)).toBe(false)
  expect(press(canvas, 'а', 'KeyA')).toBe(false)
  for (const tag of ['input', 'textarea', 'select']) expect(press(document.createElement(tag), 'а', 'KeyF')).toBe(false)
})

it('refits a preset on resize, keeps its orientation, and fits all domain corners', () => {
  const canvas = document.createElement('canvas')
  const center = new Vector3(60, 30, 20)
  const camera = new PerspectiveCamera(37, 2, 0.1, 5000)
  const controls = createCamera3D(canvas, camera, center, 2 * center.length(), () => {})
  controls.fit('top')
  const wide = camera.position.distanceTo(center)
  controls.resize(0.4)
  expect(camera.position.distanceTo(center)).toBeGreaterThan(wide)
  expect(camera.position.clone().sub(center).normalize().toArray()).toEqual([0, 1, 0])
  expect(camera.up.toArray()).toEqual([0, 0, -1])
  camera.updateMatrixWorld()
  for (const x of [0, 120]) for (const y of [0, 60]) for (const z of [0, 40]) {
    const corner = new Vector3(x, y, z).project(camera)
    expect(corner.toArray().every(value => Math.abs(value) < 1)).toBe(true)
  }
  controls.dispose()
})

it.each(['orbit', 'pan', 'drag zoom', 'wheel zoom'])('preserves a manual %s when resizing until Fit is requested', gesture => {
  const canvas = document.createElement('canvas')
  Object.defineProperty(canvas, 'setPointerCapture', { value: () => {} })
  const center = new Vector3(60, 30, 20)
  const camera = new PerspectiveCamera(37, 2, 0.1, 5000)
  const controls = createCamera3D(canvas, camera, center, 2 * center.length(), () => {})
  controls.fit('iso')
  const fitted = camera.position.clone()
  if (gesture === 'wheel zoom') {
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 50 }))
  } else {
    const buttons = { pointerId: 1, button: 1, shiftKey: gesture === 'pan', ctrlKey: gesture === 'drag zoom' }
    canvas.dispatchEvent(new PointerEvent('pointerdown', buttons))
    canvas.dispatchEvent(new PointerEvent('pointermove', { ...buttons, clientX: 2, clientY: 3 }))
  }
  const manual = camera.position.clone()
  expect(manual.equals(fitted)).toBe(false)
  controls.resize(0.4)
  expect(camera.position.equals(manual)).toBe(true)
  controls.fit()
  const fittedAgain = camera.position.clone()
  controls.resize(2)
  expect(camera.position.equals(fittedAgain)).toBe(false)
  controls.dispose()
})
