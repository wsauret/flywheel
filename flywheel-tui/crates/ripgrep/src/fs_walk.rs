//! Filesystem walker and path utilities.
//!
//! Thin wrapper around `ignore::WalkBuilder` for directory traversal with
//! gitignore/hidden-file support. No caching, no TTL, no invalidation.

use std::{
	borrow::Cow,
	path::Path,
};

use ignore::WalkBuilder;

/// Filesystem entry type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileType {
	File,
	Dir,
	Symlink,
}

/// A single filesystem entry from a directory scan.
#[derive(Clone)]
pub struct WalkEntry {
	/// Relative path from the search root, using forward slashes.
	pub path: String,
	/// Resolved filesystem type for the match.
	pub file_type: FileType,
}

/// Normalize a filesystem path to a forward-slash relative string.
pub fn normalize_relative_path<'a>(root: &Path, path: &'a Path) -> Cow<'a, str> {
	let relative = path.strip_prefix(root).unwrap_or(path);
	if cfg!(windows) {
		let relative = relative.to_string_lossy();
		if relative.contains('\\') {
			Cow::Owned(relative.replace('\\', "/"))
		} else {
			relative
		}
	} else {
		relative.to_string_lossy()
	}
}

/// Returns true if any path component is `.git`.
fn contains_git_dir(path: &Path) -> bool {
	path.components().any(|component| {
		component
			.as_os_str()
			.to_str()
			.is_some_and(|value| value == ".git")
	})
}

/// Classify a path into a FileType.
pub fn classify_file_type(path: &Path) -> Option<FileType> {
	let metadata = std::fs::symlink_metadata(path).ok()?;
	let ft = metadata.file_type();
	if ft.is_symlink() {
		Some(FileType::Symlink)
	} else if ft.is_dir() {
		Some(FileType::Dir)
	} else if ft.is_file() {
		Some(FileType::File)
	} else {
		None
	}
}

/// Builds a deterministic filesystem walker.
fn build_walker(root: &Path, include_hidden: bool, use_gitignore: bool) -> WalkBuilder {
	let mut builder = WalkBuilder::new(root);
	builder
		.hidden(!include_hidden)
		.follow_links(false)
		.sort_by_file_path(|a, b| a.cmp(b));

	if use_gitignore {
		builder
			.git_ignore(true)
			.git_exclude(true)
			.git_global(true)
			.ignore(true)
			.parents(true);
	} else {
		builder
			.git_ignore(false)
			.git_exclude(false)
			.git_global(false)
			.ignore(false)
			.parents(false);
	}

	builder
}

/// Walk a directory and collect all entries.
pub fn walk_directory(
	root: &Path,
	include_hidden: bool,
	use_gitignore: bool,
) -> Vec<WalkEntry> {
	let builder = build_walker(root, include_hidden, use_gitignore);
	let mut entries = Vec::new();

	for entry in builder.build() {
		let Ok(entry) = entry else { continue };
		let path = entry.path();

		if contains_git_dir(path) {
			continue;
		}

		let relative = normalize_relative_path(root, path);
		if relative.is_empty() {
			continue;
		}

		let Some(file_type) = classify_file_type(path) else {
			continue;
		};

		entries.push(WalkEntry {
			path: relative.into_owned(),
			file_type,
		});
	}

	entries
}
