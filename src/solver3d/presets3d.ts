import { materials } from '../solver/presets'
import type { Material } from '../solver/types'
import {
  elementCount, elementIndex, nodeIndex3D, type Force3D, type Grid3D,
  type SimpParams3D, type SimpProblem3D, type Support3D,
} from './types3d'

export const resolutions3D = [[24, 12, 8], [36, 18, 12], [48, 24, 16]] as const
export const presets3D = ['cantilever3d', 'boltBracket3d', 'archBridge3d', 'lBracket3d'] as const
export type Preset3D = typeof presets3D[number]
export const defaultParams3D: SimpParams3D = {
  penal: 3, rmin: 1.8, volFrac: 0.45, moveLimit: 0.15, maxIter: 100, changeTol: 0.01, symmetry: 'none',
}

export function presetGrid3D(resolution: readonly [number, number, number]): Grid3D {
  const [nelx, nely, nelz] = resolution
  return { nelx, nely, nelz, widthMm: 120, heightMm: 60, depthMm: 40 }
}

export function makePreset3D(
  id: Preset3D, grid: Grid3D, params = defaultParams3D, material: Material = materials.steel,
): SimpProblem3D {
  const { nelx: nx, nely: ny, nelz: nz } = grid
  const supports: Support3D[] = []
  const forces: Force3D[] = []
  const solid = new Uint8Array(elementCount(grid))
  const voidMask = new Uint8Array(solid.length)
  const fix = (x: number, y: number, z: number, fixX = true) =>
    supports.push({ node: nodeIndex3D(grid, x, y, z), fixX, fixY: true, fixZ: fixX })
  const load = (x: number, y: number, z: number, fy: number, fz = 0) =>
    forces.push({ node: nodeIndex3D(grid, x, y, z), fx: 0, fy, fz })
  const front = nx - 1
  const midY = Math.round(ny / 2)
  const midZ = Math.round(nz / 2)
  const flange = Math.max(1, Math.round(nx * 0.1))
  const pad = Math.max(1, Math.round(nx * 0.09))

  if (id === 'cantilever3d' || id === 'lBracket3d') {
    for (let z = 0; z <= nz; z++) for (let y = 0; y <= ny; y++) fix(0, y, z)
    if (id === 'cantilever3d') load(nx, midY, midZ, -100)
    else load(nx, Math.round(ny * 0.28), Math.round(nz * 0.68), -100, 25)
  } else if (id === 'archBridge3d') {
    for (let z = 0; z <= nz; z++) for (let x = 0; x <= nx; x++) {
      if (x <= pad || x >= nx - pad) fix(x, 0, z, x <= pad)
    }
    const start = Math.ceil(nx * 0.15), end = nx - start
    for (let z = 0; z <= nz; z++) for (let x = start; x <= end; x++) {
      load(x, ny, z, -100 / ((end - start + 1) * (nz + 1)))
    }
  } else {
    const boltY = Math.round(ny * 0.25), boltZ = Math.round(nz * 0.25)
    const hole = Math.max(0.8, Math.min(ny, nz) * 0.105)
    const boss = hole + Math.max(1, nz * 0.07)
    const boltDistance = (y: number, z: number) =>
      Math.hypot(Math.min(y, ny - y) - boltY, Math.min(z, nz - z) - boltZ)
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
      const distance = boltDistance(y + 0.5, z + 0.5)
      for (let x = 0; x < flange; x++) {
        const e = elementIndex(grid, x, y, z)
        if (distance <= hole) voidMask[e] = 1
        else if (distance <= boss) solid[e] = 1
      }
    }
    for (let z = 0; z <= nz; z++) for (let y = 0; y <= ny; y++) {
      const distance = boltDistance(y, z)
      if (distance < hole || distance > boss + 0.5) continue
      let attached = false
      for (let dz = -1; dz <= 0; dz++) for (let dy = -1; dy <= 0; dy++) {
        if (z + dz >= 0 && z + dz < nz && y + dy >= 0 && y + dy < ny) {
          attached ||= !!solid[elementIndex(grid, 0, y + dy, z + dz)]
        }
      }
      if (attached) fix(0, y, z)
    }
    load(nx, midY, midZ, -100)
  }

  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const e = elementIndex(grid, x, y, z)
    if (id === 'archBridge3d') {
      if ((y === 0 && (x < pad || x >= nx - pad)) || (y === ny - 1 && x >= nx * 0.15 && x < nx * 0.85)) solid[e] = 1
    } else if (id === 'lBracket3d' && x >= Math.ceil(nx * 0.36) && y >= Math.ceil(ny * 0.60)) {
      voidMask[e] = 1
    } else if (id === 'boltBracket3d' && x > front - pad && Math.hypot(y + 0.5 - midY, z + 0.5 - midZ) <= 1.6) {
      solid[e] = 1
    }
  }
  return { grid, material, params, supports, loadCases: [{ id, forces }], passive: { solid, void: voidMask } }
}
