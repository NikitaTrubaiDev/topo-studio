# TopoStudio

TopoStudio is a browser-based mechanical topology optimization workbench. [GitHub Pages](https://nikitatrubaidev.github.io/topo-studio/)

- **2D** offers plane-stress Q4 SIMP optimization, interactive support and load editing, manufacturing constraints, stress and deformation views, JSON projects, and DXF, SVG, and extruded STL export.
- **3D** offers solid H8 SIMP optimization, four mechanical presets, density voxels, smoothed CAD surfaces, von Mises stress, section planes, and watertight binary STL and Wavefront OBJ export in millimetres.
- Both modes report mass, deflection, and safety factors. The interface supports English, German, and Russian.

React, TypeScript, and Vite power the workbench. Pure TypeScript solvers run in Web Workers. Three.js renders the 3D viewport with WebGL 2, and Vitest verifies the numerical methods and export geometry.

## Local development

Use Node.js 26 and npm.

```sh
npm ci
npm run dev
npm test
npm run build
```

To benchmark warm 3D SIMP iterations, run `npm run bench:solver -- src/solver3d`.

## Siemens NX camera controls

| Action | Input |
| --- | --- |
| Orbit | Drag with the middle mouse button |
| Zoom | Scroll the wheel or drag with Ctrl + middle button |
| Pan | Drag with Shift + left button or Shift + middle button |
| Orient | Select Iso, Front, Top, or Right |
| Fit the domain | Select Fit or press F |

The Standard scheme uses left drag to orbit and right or middle drag to pan.

## Deployment

Set the repository’s Pages source to **GitHub Actions**. The workflow tests and builds each push to `main` and deploys the output to the `/topo-studio/` base path.
