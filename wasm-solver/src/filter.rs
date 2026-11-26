use crate::{ALLOCATIONS, abi_pointer, abi_slice, checked_bytes};
use std::slice;

fn entry_count(starts: &[u32]) -> Option<usize> {
    if starts.first() != Some(&0) || starts.windows(2).any(|row| row[0] > row[1]) { return None; }
    starts.last().map(|&length| length as usize)
}

#[unsafe(no_mangle)]
extern "C" fn filter_csr(
    rows: usize, count: usize, starts: *const u32, columns: *const u32, weights: *const f64,
    input: *const f64, output: *mut f64, transpose: u32,
) -> i32 {
    ALLOCATIONS.with_borrow(|allocations| {
        if rows > count || transpose > 1
            || [starts as usize, columns as usize, weights as usize, input as usize].contains(&(output as usize)) {
            return None;
        }
        let output = abi_pointer(allocations, output, count)?;
        // Every slice uses a checked, live allocation. Output has a distinct base.
        let (starts, columns, weights, input) = unsafe {
            let starts = abi_slice(allocations, starts, rows.checked_add(1)?)?;
            let length = entry_count(starts)?;
            (starts, abi_slice(allocations, columns, length)?,
                abi_slice(allocations, weights, length)?, abi_slice(allocations, input, count)?)
        };
        if columns.iter().any(|&j| j as usize >= count) { return None; }
        let output = unsafe { slice::from_raw_parts_mut(output, count) };
        output.fill(0.);
        for (row, limits) in starts.windows(2).enumerate() {
            let range = limits[0] as usize..limits[1] as usize;
            let entries = columns[range.clone()].iter().zip(&weights[range]);
            if transpose == 0 {
                output[row] = entries.map(|(&j, &w)| w * input[j as usize]).sum();
            } else {
                let value = input[row];
                for (&j, &w) in entries { output[j as usize] += w * value; }
            }
        }
        Some(0)
    }).unwrap_or(-1)
}

// Structured CSR rows share the same relative column offsets inside each
// parity family. This preserves sparse filtering without materializing
// millions of repeated entries for large meshes or cone radii.
#[unsafe(no_mangle)]
extern "C" fn filter_stencil(
    nx: usize, ny: usize, nz: usize, per_cell: usize,
    starts: *const u32, offsets: *const i32, weights: *const f64,
    inverse: *const f64, input: *const f64, output: *mut f64, transpose: u32,
) -> i32 {
    ALLOCATIONS.with_borrow(|allocations| {
        if nx == 0 || ny == 0 || nz == 0 || per_cell == 0 || transpose > 1
            || [starts as usize, offsets as usize, weights as usize, inverse as usize, input as usize].contains(&(output as usize)) {
            return None;
        }
        let count = nx.checked_mul(ny)?.checked_mul(nz)?.checked_mul(per_cell)?;
        checked_bytes::<f64>(count)?;
        let output = abi_pointer(allocations, output, count)?;
        let (starts, offsets, weights, inverse, input) = unsafe {
            let starts = abi_slice(allocations, starts, per_cell.checked_mul(2)?.checked_add(1)?)?;
            let length = entry_count(starts)?;
            (starts, abi_slice(allocations, offsets.cast::<[i32; 4]>(), length)?,
                abi_slice(allocations, weights, length)?, abi_slice(allocations, inverse, count)?,
                abi_slice(allocations, input, count)?)
        };
        // Each delta must address a local element in the shifted cell.
        // Validate once per stencil entry, before visiting the grid.
        for &[dx, dy, dz, delta] in offsets {
            if dx.unsigned_abs() as usize >= nx || dy.unsigned_abs() as usize >= ny || dz.unsigned_abs() as usize >= nz {
                return None;
            }
            let cell = (i64::from(dz) * ny as i64 + i64::from(dy)) * nx as i64 + i64::from(dx);
            let local = i64::from(delta) - cell * per_cell as i64;
            if !(0..per_cell as i64).contains(&local) { return None; }
        }
        let output = unsafe { slice::from_raw_parts_mut(output, count) };
        output.fill(0.);
        let mut base = 0;
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let parity = (x + y + z) & 1;
                    for t in 0..per_cell {
                        let e = base + t;
                        if inverse[e] == 0. { continue; }
                        let row = parity * per_cell + t;
                        let range = starts[row] as usize..starts[row + 1] as usize;
                        let mut sum = 0.;
                        let value = input[e] * inverse[e];
                        for (&[dx, dy, dz, delta], &w) in offsets[range.clone()].iter().zip(&weights[range]) {
                            if (x as i32 + dx) as usize >= nx || (y as i32 + dy) as usize >= ny
                                || (z as i32 + dz) as usize >= nz { continue; }
                            let j = (base as i32 + delta) as usize;
                            if inverse[j] == 0. { continue; }
                            if transpose == 0 { sum += w * input[j]; }
                            else { output[j] += w * value; }
                        }
                        if transpose == 0 { output[e] = sum * inverse[e]; }
                    }
                    base += per_cell;
                }
            }
        }
        Some(0)
    }).unwrap_or(-1)
}
