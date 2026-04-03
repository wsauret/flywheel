//! Shared glob-pattern helpers used by [`crate::grep`].

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use napi::bindgen_prelude::*;

/// Normalize a raw glob string: fix path separators, optionally prepend `**/`
/// for recursive matching, and close any unclosed `{` alternation groups.
pub fn build_glob_pattern(glob: &str, recursive: bool) -> String {
	let normalized = glob.replace('\\', "/");
	let pattern = if !recursive || normalized.contains('/') || normalized.starts_with("**") {
		normalized
	} else {
		format!("**/{normalized}")
	};
	fix_unclosed_braces(pattern)
}

/// Compile a glob pattern string into a [`GlobSet`].
///
/// When `recursive` is true, simple patterns (no path separators, no leading
/// `**`) are automatically prefixed with `**/`.
pub fn compile_glob(glob: &str, recursive: bool) -> Result<GlobSet> {
	let mut builder = GlobSetBuilder::new();
	let pattern = build_glob_pattern(glob, recursive);
	let glob = GlobBuilder::new(&pattern)
		.literal_separator(true)
		.build()
		.map_err(|err| Error::from_reason(format!("Invalid glob pattern: {err}")))?;
	builder.add(glob);
	builder
		.build()
		.map_err(|err| Error::from_reason(format!("Failed to build glob matcher: {err}")))
}

/// Like [`compile_glob`], but accepts an `Option<&str>` — returns `Ok(None)`
/// when the input is `None`, empty, or whitespace-only.
pub fn try_compile_glob(glob: Option<&str>, recursive: bool) -> Result<Option<GlobSet>> {
	let Some(glob) = glob.map(str::trim).filter(|v| !v.is_empty()) else {
		return Ok(None);
	};
	compile_glob(glob, recursive).map(Some)
}

/// Close unclosed `{` alternation groups in a glob pattern.
fn fix_unclosed_braces(pattern: String) -> String {
	let opens = pattern.chars().filter(|&c| c == '{').count();
	let closes = pattern.chars().filter(|&c| c == '}').count();
	if opens > closes {
		let mut fixed = pattern;
		for _ in 0..(opens - closes) {
			fixed.push('}');
		}
		fixed
	} else {
		pattern
	}
}
