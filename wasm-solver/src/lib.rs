mod elements;
mod filter;
mod multigrid;

use elements::{Elements, Grid};
use multigrid::{Multigrid, NodalBlocks};
use std::{
    alloc::{alloc_zeroed, dealloc, Layout},
    cell::{Cell, RefCell},
    collections::BTreeMap,
    mem::{align_of, size_of},
    ptr, slice,
};

struct Allocation {
    pointer: *mut u8,
    bytes: usize,
    layout: Layout,
}

type Allocations = BTreeMap<usize, Allocation>;

thread_local! {
    static ALLOCATIONS: RefCell<Allocations> = const { RefCell::new(BTreeMap::new()) };
    static SOLVERS: RefCell<BTreeMap<u32, Box<Solver>>> = const { RefCell::new(BTreeMap::new()) };
    static NEXT_HANDLE: Cell<u32> = const { Cell::new(1) };
}

fn checked_bytes<T>(len: usize) -> Option<usize> {
    len.checked_mul(size_of::<T>()).filter(|&bytes| bytes <= isize::MAX as usize)
}

fn abi_pointer<T>(allocations: &Allocations, pointer: *const T, len: usize) -> Option<*mut T> {
    let allocation = allocations.get(&(pointer as usize))?;
    (pointer.is_aligned() && allocation.bytes == checked_bytes::<T>(len)?)
        .then(|| allocation.pointer.cast())
}

// The caller holds the allocation-table borrow and must keep mutable views
// disjoint from all other views. ABI types contain only integer and float data.
unsafe fn abi_slice<T>(allocations: &Allocations, pointer: *const T, len: usize) -> Option<&[T]> {
    let pointer = abi_pointer(allocations, pointer, len)?;
    Some(unsafe { slice::from_raw_parts(pointer, len) })
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_simd_enabled() -> u32 {
    u32::from(cfg!(target_feature = "simd128"))
}

// Scratch allocations are eight-byte aligned for all ABI array types.
#[unsafe(no_mangle)]
pub extern "C" fn wasm_alloc(bytes: usize) -> *mut u8 {
    let Ok(layout) = Layout::from_size_align(bytes.max(1), align_of::<f64>()) else { return ptr::null_mut() };
    // Raw callers may leave parts of their staging allocations unwritten.
    let pointer = unsafe { alloc_zeroed(layout) };
    if !pointer.is_null() {
        ALLOCATIONS.with_borrow_mut(|allocations| {
            allocations.insert(pointer as usize, Allocation { pointer, bytes, layout });
        });
    }
    pointer
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_dealloc(pointer: *mut u8, bytes: usize) -> i32 {
    ALLOCATIONS.with_borrow_mut(|allocations| {
        if abi_pointer(allocations, pointer, bytes).is_none() { return -1; }
        let allocation = allocations.remove(&(pointer as usize)).unwrap();
        unsafe { dealloc(allocation.pointer, allocation.layout) };
        0
    })
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

fn register_solver(solver: Solver) -> Option<u32> {
    let handle = NEXT_HANDLE.with(|next| {
        let handle = next.get();
        next.set(handle.checked_add(1)?);
        Some(handle)
    })?;
    SOLVERS.with_borrow_mut(|solvers| solvers.insert(handle, Box::new(solver)));
    Some(handle)
}

// Constructors copy validated staging buffers into their own storage.
#[unsafe(no_mangle)]
extern "C" fn solver_structured(
    nx: usize, ny: usize, nz: usize, fixed: *const u8,
    ke: *const f64, corners: *const u8, coarse_ke: *const f64, levels: usize,
) -> u32 {
    ALLOCATIONS.with_borrow(|allocations| {
        let grid = Grid([nx, ny, nz]);
        let tet = !corners.is_null();
        if grid.0.contains(&0) { return None; }
        let nodes = grid.0.iter().try_fold(1usize, |product, &n| product.checked_mul(n.checked_add(1)?))?;
        let dofs = nodes.checked_mul(3)?;
        checked_bytes::<f64>(dofs)?;
        let elements = nx.checked_mul(ny)?.checked_mul(nz)?.checked_mul(if tet { 5 } else { 1 })?;
        let width = if tet { 4 } else { 8 };
        checked_bytes::<u32>(elements.checked_mul(width)?)?;
        if levels != 0 {
            checked_bytes::<[f64; 9]>(nodes.checked_mul(27)?)?;
            checked_bytes::<usize>(elements.checked_mul(width * width)?)?;
        }
        let mut coarse = grid;
        for _ in 0..levels { coarse = coarse.coarse()?; }
        let (fixed, ke, tet_corners, coarse_ke) = unsafe {
            (abi_slice(allocations, fixed, dofs)?,
                abi_slice(allocations, ke, if tet { 1440 } else { 576 })?,
                if tet { abi_slice(allocations, corners, 40)? } else { &[] },
                abi_slice(allocations, coarse_ke, levels.checked_mul(576)?)?)
        };
        // A structured Tet4 stencil omits links across a brick's long diagonal.
        for nodes in tet_corners.chunks_exact(4) {
            for (i, &node) in nodes.iter().enumerate() {
                if node >= 8 || nodes[..i].iter().any(|&other| other == node || other ^ node == 7) {
                    return None;
                }
            }
        }
        let elements = Elements::structured(grid, ke, tet_corners);
        let mg = (levels != 0).then(|| Multigrid::new(grid, &elements, fixed, coarse_ke));
        register_solver(Solver::new(elements, fixed, mg, None))
    }).unwrap_or_default()
}

#[unsafe(no_mangle)]
extern "C" fn solver_adaptive(
    dofs: usize, fixed: *const u8, count: usize, nodes: *const u32, templates: *const u32,
    packed: *const f64, template_count: usize,
) -> u32 {
    ALLOCATIONS.with_borrow(|allocations| {
        if dofs == 0 || dofs % 3 != 0 || count == 0 || template_count == 0 { return None; }
        let node_count = dofs / 3;
        checked_bytes::<f64>(dofs)?;
        checked_bytes::<[f64; 9]>(count.checked_mul(12)?.checked_add(node_count)?)?;
        checked_bytes::<[[f64; 9]; 16]>(template_count)?;
        let (fixed, nodes, templates, packed) = unsafe {
            (abi_slice(allocations, fixed, dofs)?,
                abi_slice(allocations, nodes, count.checked_mul(4)?)?,
                abi_slice(allocations, templates, count)?,
                abi_slice(allocations, packed, template_count.checked_mul(78)?)?)
        };
        if nodes.iter().any(|&node| node as usize >= node_count)
            || templates.iter().any(|&template| template as usize >= template_count) {
            return None;
        }
        let elements = Elements::adaptive(nodes, templates, fixed, packed);
        let operator = NodalBlocks::adaptive(&elements, fixed);
        register_solver(Solver::new(elements, fixed, None, Some(operator)))
    }).unwrap_or_default()
}

#[unsafe(no_mangle)]
extern "C" fn solver_drop(handle: u32) -> i32 {
    SOLVERS.with_borrow_mut(|solvers| if solvers.remove(&handle).is_some() { 0 } else { -1 })
}

// Buffer addresses are stable for the life of a solver. JS must recreate typed
// views if another allocation grows linear memory and detaches its old buffer.
#[unsafe(no_mangle)]
extern "C" fn solver_buffer(handle: u32, field: u32) -> *const u8 {
    SOLVERS.with_borrow_mut(|solvers| {
        let Some(s) = solvers.get_mut(&handle) else { return ptr::null(); };
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
            _ => ptr::null(),
        }
    })
}

#[unsafe(no_mangle)]
extern "C" fn solver_colors(handle: u32) -> usize {
    SOLVERS.with_borrow(|solvers| solvers.get(&handle).map_or(0, |s| s.elements.coloring.starts.len() - 1))
}

#[unsafe(no_mangle)]
extern "C" fn solver_prepare(handle: u32, e0: f64, emin: f64, penal: f64) -> i32 {
    SOLVERS.with_borrow_mut(|solvers| {
        let Some(solver) = solvers.get_mut(&handle) else { return -1; };
        solver.prepare(e0, emin, penal);
        0
    })
}

#[unsafe(no_mangle)]
extern "C" fn solver_solve(handle: u32, tolerance: f64, limit: u32) -> u32 {
    SOLVERS.with_borrow_mut(|solvers| {
        let Some(solver) = solvers.get_mut(&handle) else { return 0; };
        let converged = solver.solve(tolerance, limit);
        if converged { solver.sensitivities(); }
        u32::from(converged)
    })
}
