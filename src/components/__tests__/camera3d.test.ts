import { expect, it } from 'vitest'
import { cameraGesture } from '../camera3d'

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
