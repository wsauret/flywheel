//! File listing exported via N-API.
//!
//! Walks the filesystem using `ignore::WalkBuilder` (same engine as ripgrep),
//! filters by glob pattern, and returns relative paths.

use std::{
	path::{Path, PathBuf},
	time::Duration,
};

use globset::GlobSet;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{budget::SearchBudget, fs_walk, fs_worker, glob_util};

const DEFAULT_LIMIT: u32 = 200;
const MAX_LIMIT: u32 = 1_000;
const MAX_DEPTH: u32 = 12;

#[napi(object)]
pub struct ListOptions {
	pub path: String,
	pub pattern: Option<String>,
	pub depth: Option<u32>,
	/// "all" | "files" | "directories"
	pub include: Option<String>,
	/// "name" (directories first, alphabetical; default) | "mtime" (newest first)
	pub sort: Option<String>,
	pub hidden: Option<bool>,
	/// True leaves out every ignored file and directory. Otherwise the walk
	/// prunes the directories the repository's ignore rules exclude and keeps
	/// ignored files.
	pub gitignore: Option<bool>,
	/// Glob patterns of directories the walk does not enter (matched against
	/// root-relative paths, e.g. "**/node_modules"). A pruned directory is
	/// still listed.
	#[napi(js_name = "excludeGlobs")]
	pub exclude_globs: Option<Vec<String>>,
	pub limit: Option<u32>,
	pub offset: Option<u32>,
	/// Canonical credential roots that linked descendants must not enter.
	#[napi(js_name = "protectedTraversalRoots")]
	pub protected_traversal_roots: Option<Vec<String>>,
	/// Processor time the listing may spend, summed across its threads; none
	/// sets no limit. Exceeding it rejects with the processing time reason.
	#[napi(js_name = "cpuLimitMs")]
	pub cpu_limit_ms: Option<u32>,
	/// Wall-clock time the listing may take, admission included. Exceeding it
	/// rejects with the wall time reason.
	#[napi(js_name = "timeoutMs")]
	pub timeout_ms: u32,
}

#[napi(object)]
pub struct ListResult {
	pub entries: Vec<String>,
	pub truncated: bool,
	#[napi(js_name = "nextOffset")]
	pub next_offset: u32,
	pub limit: u32,
	#[napi(js_name = "traversalIssues")]
	pub traversal_issues: u32,
	#[napi(js_name = "entryLimitReached")]
	pub entry_limit_reached: bool,
	/// Root-relative directories the walk listed but did not enter, although
	/// its depth reached their contents.
	#[napi(js_name = "prunedDirectories")]
	pub pruned_directories: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum IncludeFilter {
	All,
	Files,
	Directories,
}

fn parse_include(value: Option<&str>) -> IncludeFilter {
	match value {
		Some("files") => IncludeFilter::Files,
		Some("directories") => IncludeFilter::Directories,
		_ => IncludeFilter::All,
	}
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SortOrder {
	Name,
	Mtime,
}

fn parse_sort(value: Option<&str>) -> SortOrder {
	match value {
		Some("mtime") => SortOrder::Mtime,
		_ => SortOrder::Name,
	}
}

fn clamp(value: u32, min: u32, max: u32) -> u32 {
	value.max(min).min(max)
}

fn resolve_list_path(path: &str) -> Result<PathBuf> {
	let candidate = PathBuf::from(path);
	if candidate.is_absolute() {
		return Ok(candidate);
	}
	let cwd = std::env::current_dir()
		.map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?;
	Ok(cwd.join(candidate))
}

fn matches_glob(glob_set: &GlobSet, path: &str) -> bool {
	glob_set.is_match(Path::new(path))
}

fn format_entry(path: &str, file_type: fs_walk::FileType) -> String {
	if file_type == fs_walk::FileType::Dir {
		format!("{path}/")
	} else {
		path.to_string()
	}
}

fn list_sync(options: ListOptions, budget: &SearchBudget) -> Result<ListResult> {
	let root = resolve_list_path(&options.path)?;
	let metadata = std::fs::metadata(&root)
		.map_err(|err| Error::from_reason(format!("Path not found: {err}")))?;

	if !metadata.is_dir() {
		return Err(Error::from_reason(format!(
			"'{}' is not a directory",
			options.path
		)));
	}

	let has_pattern = options
		.pattern
		.as_deref()
		.is_some_and(|p| !p.trim().is_empty());
	let default_depth = if has_pattern { 8 } else { 1 };
	let depth = clamp(options.depth.unwrap_or(default_depth), 1, MAX_DEPTH) as usize;
	let limit = clamp(options.limit.unwrap_or(DEFAULT_LIMIT), 1, MAX_LIMIT);
	let offset = options.offset.unwrap_or(0);
	let include = parse_include(options.include.as_deref());
	let sort = parse_sort(options.sort.as_deref());
	let ignore = if options.gitignore.unwrap_or(false) {
		fs_walk::IgnoreRules::Everything
	} else {
		fs_walk::IgnoreRules::Directories
	};
	let exclude = glob_util::compile_glob_set(options.exclude_globs.as_deref())?;

	let glob_set: Option<GlobSet> = if has_pattern {
		Some(glob_util::compile_glob(
			options.pattern.as_deref().unwrap(),
			true,
		)?)
	} else {
		None
	};

	let protected_roots: Vec<PathBuf> = options
		.protected_traversal_roots
		.as_deref()
		.unwrap_or_default()
		.iter()
		.map(PathBuf::from)
		.collect();
	let walk = fs_walk::walk_directory(
		&root,
		&fs_walk::WalkOptions {
			include_hidden: options.hidden.unwrap_or(true),
			ignore,
			max_depth: Some(depth),
			exclude: exclude.as_ref(),
			protected_roots: &protected_roots,
		},
		budget,
	);
	if walk.stopped {
		return Err(budget.stop_error());
	}
	let mut walk_entries = walk.entries;
	// Name order: directories first (alphabetical), then files (alphabetical).
	// Mtime order is applied after filtering, where the stat cost is smallest.
	if sort == SortOrder::Name {
		walk_entries.sort_by(|a, b| {
			let a_is_dir = a.file_type == fs_walk::FileType::Dir;
			let b_is_dir = b.file_type == fs_walk::FileType::Dir;
			b_is_dir.cmp(&a_is_dir).then_with(|| a.path.cmp(&b.path))
		});
	}

	let mut filtered: Vec<&fs_walk::WalkEntry> = walk_entries
		.iter()
		.filter(|entry| {
			if let Some(ref glob_set) = glob_set {
				if !matches_glob(glob_set, &entry.path) {
					return false;
				}
			}
			match include {
				IncludeFilter::Files => entry.file_type != fs_walk::FileType::Dir,
				IncludeFilter::Directories => entry.file_type == fs_walk::FileType::Dir,
				IncludeFilter::All => true,
			}
		})
		.collect();

	if sort == SortOrder::Mtime {
		// Newest first (ls -t). Unreadable entries sort oldest; path breaks
		// ties deterministically.
		filtered.sort_by_cached_key(|entry| {
			let mtime = std::fs::symlink_metadata(root.join(&entry.path))
				.and_then(|m| m.modified())
				.unwrap_or(std::time::SystemTime::UNIX_EPOCH);
			(std::cmp::Reverse(mtime), entry.path.clone())
		});
	}

	let entries: Vec<String> = filtered
		.iter()
		.skip(offset as usize)
		.take(limit as usize)
		.map(|entry| format_entry(&entry.path, entry.file_type))
		.collect();
	let truncated = walk.entry_limit_reached || filtered.len() > offset as usize + entries.len();
	let next_offset = offset + entries.len() as u32;

	Ok(ListResult {
		entries,
		truncated,
		next_offset,
		limit,
		traversal_issues: walk.traversal_issues,
		entry_limit_reached: walk.entry_limit_reached,
		pruned_directories: walk.pruned,
	})
}

/// List files on crate-owned threads (see [`fs_worker::run_request`]).
#[napi(js_name = "listFiles")]
pub fn list_files<'env>(env: &'env Env, options: ListOptions) -> Result<Object<'env>> {
	let budget = SearchBudget::new(
		options.cpu_limit_ms.map(|ms| Duration::from_millis(u64::from(ms))),
		Duration::from_millis(u64::from(options.timeout_ms)),
	);
	fs_worker::run_request(env, "list", budget, None, move |budget| list_sync(options, budget))
}
