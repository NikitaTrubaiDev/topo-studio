mod elements;
mod filter;
mod multigrid;

use elements::{Elements, Grid};
use multigrid::{Multigrid, NodalBlocks};
use std::{alloc::{alloc, dealloc, Layout}, slice};

#[unsafe(no_mangle)]
pub extern "C" fn wasm_simd_enabled() -> u32 {
    u32::from(cfg!(target_feature = "simd128"))
}

// Scratch allocations are eight-byte aligned for all ABI array types.
#[unsafe(no_mangle)]
pub extern "C" fn wasm_alloc(bytes: usize) -> *mut u8 {
    unsafe { alloc(Layout::from_size_align(bytes.max(1), 8).unwrap()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn wasm_dealloc(ptr: *mut u8, bytes: usize) {
    unsafe { dealloc(ptr, Layout::from_size_align(bytes.max(1), 8).unwrap()) }
}

struct Solver {
    elements: Elements,
    fixed: Vec<u8>,
    mg: Option<Multigrid>,
    adaptive: Option<NodalBlocks>,
    modulus: Vec<f64>,
    derivative: Vec<f64>,
    energy: Vec<f64>,
    gradient: Vec<f64>,
    inverse: Vec<f64>,
    force: Vec<f64>,
    u: Vec<f64>,
    rhs: Vec<f64>,
    residual: Vec<f64>,
    direction: Vec<f64>,
    product: Vec<f64>,
    trial: Vec<f64>,
    z: Vec<f64>,
    stats: [f64; 3],
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

impl Solver {
    fn new(elements: Elements, fixed: &[u8], mg: Option<Multigrid>, adaptive: Option<NodalBlocks>) -> Self {
        let n = fixed.len();
        let m = elements.templates.len();
        Self {
            elements, fixed: fixed.to_vec(), mg, adaptive, modulus: vec![0.; m], derivative: vec![0.; m],
            energy: vec![0.; m], gradient: vec![0.; m], inverse: vec![0.; n],
            force: vec![0.; n], u: vec![0.; n], rhs: vec![0.; n], residual: vec![0.; n],
            direction: vec![0.; n], product: vec![0.; n], trial: vec![0.; n], z: vec![0.; n],
            stats: [0.; 3],
        }
    }

    fn prepare(&mut self, e0: f64, emin: f64, penal: f64) {
        for i in 0..self.modulus.len() {
            let density = self.modulus[i];
            self.modulus[i] = emin + (e0 - emin) * density.powf(penal);
            self.derivative[i] = -penal * (e0 - emin) * density.powf(penal - 1.);
        }
        if let Some(operator) = self.adaptive.as_mut() {
            operator.prepare_adaptive(&self.elements, &self.modulus, &mut self.inverse);
        } else {
            self.elements.inverse_diagonal(&self.fixed, &self.modulus, &mut self.inverse);
        }
        if let Some(mg) = self.mg.as_mut() {
            mg.prepare(&self.elements, &self.modulus);
        }
    }

    fn refresh(&mut self) -> f64 {
        if let Some(operator) = self.adaptive.as_ref() {
            operator.apply(&self.u, &mut self.product);
        } else {
            self.elements.apply(&self.u, &mut self.product, &self.fixed, &self.modulus);
        }
        for (j, value) in self.residual.iter_mut().enumerate() {
            *value = self.rhs[j] - self.product[j];
        }
        dot(&self.residual, &self.residual)
    }

    fn precondition(&mut self, multigrid: bool) -> f64 {
        if multigrid {
            self.mg.as_mut().unwrap().apply(&self.fixed, &self.residual, &mut self.z, &mut self.product);
        } else {
            for (i, value) in self.z.iter_mut().enumerate() {
                *value = self.inverse[i] * self.residual[i];
            }
        }
        dot(&self.residual, &self.z)
    }

    fn restart(&mut self, target: f64, mg: bool, energy: &mut f64) -> f64 {
        let error = self.refresh();
        if error > target {
            *energy = self.precondition(mg);
            self.direction.copy_from_slice(&self.z);
        }
        error
    }

    fn solve(&mut self, tolerance: f64, limit: u32) -> bool {
        const MAX_RESTARTS: u32 = 4;
        const STALL_ITERATIONS: u32 = 256;
        let scale = self.force.iter().zip(&self.fixed)
            .filter(|&(_, &fixed)| fixed == 0).map(|(f, _)| f.abs()).fold(0., f64::max);
        if scale == 0. {
            self.u.fill(0.);
            self.stats = [0.; 3];
            return true;
        }
        for (i, &fixed) in self.fixed.iter().enumerate() {
            self.rhs[i] = if fixed == 0 { self.force[i] / scale } else { 0. };
            self.u[i] = if fixed == 0 { self.u[i] / scale } else { 0. };
        }
        if self.u.iter().any(|v| !v.is_finite()) {
            self.u.fill(0.);
        }
        let norm = dot(&self.rhs, &self.rhs);
        let target = norm * tolerance * tolerance;
        let mut use_mg = self.mg.is_some();
        let mut energy = 0.;
        let mut error = self.restart(target, use_mg, &mut energy);
        if !error.is_finite() {
            self.u.fill(0.);
            use_mg = false;
            error = self.restart(target, use_mg, &mut energy);
        }
        let mut best = error;
        let (mut iterations, mut last_progress, mut restarts) = (0, 0, 0);
        while error.is_finite() && error > target && iterations < limit {
            if let Some(operator) = self.adaptive.as_ref() {
                operator.apply(&self.direction, &mut self.product);
            } else {
                self.elements.apply(&self.direction, &mut self.product, &self.fixed, &self.modulus);
            }
            iterations += 1;
            let curvature = dot(&self.direction, &self.product);
            let alpha = energy / curvature;
            let mut breakdown = !(alpha > 0. && alpha.is_finite() && curvature > 0.);
            if !breakdown {
                error = 0.;
                for (i, value) in self.trial.iter_mut().enumerate() {
                    *value = self.u[i] + alpha * self.direction[i];
                    let r = self.residual[i] - alpha * self.product[i];
                    self.residual[i] = r;
                    error += r * r;
                    breakdown |= !value.is_finite();
                }
                breakdown |= !error.is_finite();
                if !breakdown {
                    self.u.copy_from_slice(&self.trial);
                    if error > target {
                        let next = self.precondition(use_mg);
                        breakdown = !(next > 0. && next.is_finite());
                        let beta = next / energy;
                        for (p, &z) in self.direction.iter_mut().zip(&self.z) {
                            *p = z + beta * *p;
                        }
                        energy = next;
                    }
                }
            }
            if error < 0.99 * best {
                best = error;
                last_progress = iterations;
            }
            let stalled = iterations - last_progress >= STALL_ITERATIONS;
            if breakdown || error <= target || (stalled && restarts < MAX_RESTARTS) {
                if restarts >= MAX_RESTARTS || iterations >= limit { break; }
                use_mg &= !(breakdown || stalled);
                error = self.restart(target, use_mg, &mut energy);
                best = error;
                last_progress = iterations;
                restarts += 1;
            }
        }
        error = self.refresh();
        for (u, &fixed) in self.u.iter_mut().zip(&self.fixed) {
            *u = if fixed == 0 { *u * scale } else { 0. };
        }
        self.stats = [f64::from(iterations), (error / norm).sqrt(), dot(&self.force, &self.u)];
        error <= target && self.u.iter().all(|v| v.is_finite())
    }

    fn sensitivities(&mut self) {
        self.elements.energy(&self.u, &mut self.energy);
        for (i, value) in self.gradient.iter_mut().enumerate() {
            *value = self.derivative[i] * self.energy[i].max(0.);
        }
    }
}

// Input slices must refer to live, aligned WASM allocations. Constructors
// retain their own topology, so the caller can release the staging buffers.
#[unsafe(no_mangle)]
unsafe extern "C" fn solver_structured(
    nx: usize, ny: usize, nz: usize, fixed: *const u8,
    ke: *const f64, corners: *const u8, coarse_ke: *const f64, levels: usize,
) -> *mut Solver {
    let grid = Grid([nx, ny, nz]);
    let tet = !corners.is_null();
    let (fixed, ke, tet_corners, coarse_ke) = unsafe {
        (slice::from_raw_parts(fixed, grid.nodes() * 3),
            slice::from_raw_parts(ke, if tet { 1440 } else { 576 }),
            if tet { slice::from_raw_parts(corners, 40) } else { &[] },
            slice::from_raw_parts(coarse_ke, levels * 576))
    };
    let elements = Elements::structured(grid, ke, tet_corners);
    let mg = (levels != 0).then(|| Multigrid::new(grid, &elements, fixed, coarse_ke));
    Box::into_raw(Box::new(Solver::new(elements, fixed, mg, None)))
}

#[unsafe(no_mangle)]
unsafe extern "C" fn solver_adaptive(
    dofs: usize, fixed: *const u8, count: usize, nodes: *const u32, templates: *const u32,
    packed: *const f64, template_count: usize,
) -> *mut Solver {
    let (fixed, elements) = unsafe {
        let fixed = slice::from_raw_parts(fixed, dofs);
        let elements = Elements::adaptive(slice::from_raw_parts(nodes, 4 * count),
            slice::from_raw_parts(templates, count), fixed, slice::from_raw_parts(packed, 78 * template_count));
        (fixed, elements)
    };
    let operator = NodalBlocks::adaptive(&elements, fixed);
    Box::into_raw(Box::new(Solver::new(elements, fixed, None, Some(operator))))
}

#[unsafe(no_mangle)]
unsafe extern "C" fn solver_drop(handle: *mut Solver) {
    unsafe { drop(Box::from_raw(handle)) };
}

// Buffer addresses are stable for the life of a solver. JS must recreate typed
// views if another allocation grows linear memory and detaches its old buffer.
#[unsafe(no_mangle)]
unsafe extern "C" fn solver_buffer(handle: *mut Solver, field: u32) -> *const u8 {
    let s = unsafe { &mut *handle };
    match field {
        0 => s.modulus.as_mut_ptr().cast(),
        1 => s.force.as_mut_ptr().cast(),
        2 => s.u.as_mut_ptr().cast(),
        3 => s.gradient.as_ptr().cast(),
        4 => s.stats.as_ptr().cast(),
        5 => s.elements.nodes.as_ptr().cast(),
        6 => s.elements.templates.as_ptr().cast(),
        7 => s.elements.coloring.starts.as_ptr().cast(),
        8 => s.elements.coloring.order.as_ptr().cast(),
        9 => s.energy.as_ptr().cast(),
        _ => std::ptr::null(),
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn solver_colors(handle: *mut Solver) -> usize {
    unsafe { (&*handle).elements.coloring.starts.len() - 1 }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn solver_prepare(handle: *mut Solver, e0: f64, emin: f64, penal: f64) {
    unsafe { (&mut *handle).prepare(e0, emin, penal) };
}

#[unsafe(no_mangle)]
unsafe extern "C" fn solver_solve(handle: *mut Solver, tolerance: f64, limit: u32) -> u32 {
    let solver = unsafe { &mut *handle };
    let converged = solver.solve(tolerance, limit);
    if converged { solver.sensitivities(); }
    u32::from(converged)
}
