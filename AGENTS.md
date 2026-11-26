# AGENTS.md — TopoStudio

Browser-based mechanical engineering Topology Optimization Workbench (2D & 3D SIMP FEA).

## Stack & Architecture
- **Frontend:** React + TypeScript + Vite + Tailwind CSS.
- **Solvers (`src/solver/`, `src/solver3d/`):** Numerical code is independent of React and the DOM. The 3D worker defaults to the Rust SIMD128 kernel (`wasm-solver/`) for Hex8, conforming Tet4, and adaptive Tet4. A typed-array ABI exchanges complete solve inputs and outputs with the kernel. TypeScript handles SIMP orchestration and provides the JS reference and fallback.
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
- Rebuild and commit `src/wasm/topo_solver.wasm` after Rust changes with `npm run build:wasm` using stable Rust and the `wasm32-unknown-unknown` target.
- Fix all TypeScript, build, and test errors before concluding.
- Keep git commits clean and atomic. Do not push unless explicitly instructed.
