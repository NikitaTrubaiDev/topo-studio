# AGENTS.md — TopoStudio

Browser-based mechanical engineering Topology Optimization Workbench (2D & 3D SIMP FEA).

## Stack & Architecture
- **Frontend:** React + TypeScript + Vite + Tailwind CSS.
- **Solver (`src/solver/`):** Pure TypeScript with **zero React/DOM imports**. Uses `Float64Array` / `Float32Array`, structured Q4 plane-stress elements (2D) and H8 hexahedra (3D in Phase 4), **Matrix-Free Jacobi-Preconditioned Conjugate Gradient (PCG)** with warm-starting, cone density/sensitivity filter, and Optimality Criteria (OC) update.
- **Worker (`src/workers/`):** WebWorker executing iterations off the main thread and streaming frames (`density`, `compliance`, `volFrac`, `vonMises`, `displacements`, `iterMs`) with Start / Pause / Step / Reset control.
- **Rendering (`src/components/`):** Dark-mode CAD/CAE engineering UI. Canvas 2D for 2D mode; Three.js for 3D mode (Phase 4).
- **Tests (`src/solver/__tests__/`):** Vitest mathematical & convergence verification tests.

## Engineering Rules
- Keep numerical solver completely decoupled from UI and browser APIs.
- Document and type all solver parameters (`E0`, `Emin`, `nu`, `penal`, `rmin`, `volFrac`, `moveLimit`, `maxIter`, `tol`).
- Ensure deterministic results and numerical stability (no NaNs, guarded denominators, enforced passive solid/void masks, exact support DOF clamping).
- Never skip verification: before finishing any task, ALWAYS run:
  1. `npm test`
  2. `npm run build`
- Fix all TypeScript, build, and test errors before concluding.
- Keep git commits clean and atomic. Do not push unless explicitly instructed.
