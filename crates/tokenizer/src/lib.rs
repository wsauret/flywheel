mod utok;

/// Allocate `len` UTF-16 code units in the module memory.
#[unsafe(no_mangle)]
pub extern "C" fn allocate(len: usize) -> *mut u16 {
	Box::into_raw(vec![0u16; len].into_boxed_slice()) as *mut u16
}

/// Release a UTF-16 allocation returned by [`allocate`].
///
/// # Safety
///
/// `ptr` and `len` must identify an allocation returned by [`allocate`] that
/// has not already been released.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn release(ptr: *mut u16, len: usize) {
	unsafe {
		drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
	}
}

/// Count content tokens in UTF-16 code units held in module memory.
///
/// `encoding` must be one of the identifiers accepted by [`utok::count`].
///
/// # Safety
///
/// `ptr` must identify `len` initialized UTF-16 code units in module memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn count(encoding: u32, ptr: *const u16, len: usize) -> u32 {
	utok::count(encoding, unsafe { std::slice::from_raw_parts(ptr, len) })
}
