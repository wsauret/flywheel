//! Filesystem walker and path utilities.
//!
//! Thin wrapper around `ignore::WalkBuilder` for directory traversal with
//! ignore-rule and hidden-file support. No caching, no TTL, no invalidation.

use std::{
	borrow::Cow,
	path::{Path, PathBuf},
	sync::{
		Arc, Mutex,
		atomic::{AtomicU32, Ordering},
	},
};

use globset::GlobSet;
use ignore::{DirEntry, WalkBuilder};
use napi_derive::napi;

use crate::{budget::SearchBudget, ignored_dirs::IgnoredDirectories};

pub(crate) const WALK_ENTRY_LIMIT: usize = 100_000;

/// Filesystem entry type without following a non-directory link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileType {
	File,
	Dir,
	Link,
}

/// A single filesystem entry from a directory scan.
#[derive(Clone)]
pub struct WalkEntry {
	/// Relative path from the search root, using forward slashes.
	pub path: String,
	/// Resolved filesystem type for the match.
	pub file_type: FileType,
}

/// Which of the repository's ignore rules a walk applies.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum IgnoreRules {
	/// Prune the directories the rules exclude; ignored files stay.
	Directories,
	/// Leave out every ignored file and directory.
	Everything,
}

pub(crate) struct WalkOptions<'a> {
	pub include_hidden: bool,
	pub ignore: IgnoreRules,
	pub max_depth: Option<usize>,
	/// Directories whose root-relative path matches are pruned. Files are
	/// never pruned, so a file that shares a pruned name (a `build` script)
	/// stays reachable.
	pub exclude: Option<&'a GlobSet>,
	pub protected_roots: &'a [PathBuf],
}

pub struct WalkResult {
	/// Every entry in walk order. A pruned directory is an entry, but the walk
	/// does not enter it.
	pub entries: Vec<WalkEntry>,
	/// Pruned directories whose contents the walk's depth would have reached.
	pub pruned: Vec<String>,
	pub stopped: bool,
	pub entry_limit_reached: bool,
	pub traversal_issues: u32,
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

fn classify_entry(entry: &DirEntry) -> Option<FileType> {
	let cached = entry.file_type()?;
	if entry.path_is_symlink() {
		if cached.is_dir() {
			Some(FileType::Dir)
		} else {
			Some(FileType::Link)
		}
	} else if cached.is_dir() {
		Some(FileType::Dir)
	} else if cached.is_file() {
		Some(FileType::File)
	} else {
		None
	}
}

/// Which directories a walk prunes: those whose root-relative path matches
/// `exclude`, and with [`IgnoreRules::Directories`] those that the
/// repository's ignore rules exclude.
struct Pruning {
	exclude: Option<GlobSet>,
	ignored: Option<IgnoredDirectories>,
}

impl Pruning {
	fn new(exclude: Option<&GlobSet>, ignore: IgnoreRules) -> Self {
		Self { exclude: exclude.cloned(), ignored: (ignore == IgnoreRules::Directories).then(IgnoredDirectories::new) }
	}

	/// Whether a walk prunes the directory `dir`, whose root-relative path is
	/// `relative`.
	fn prunes(&self, dir: &Path, relative: &str) -> bool {
		self.exclude.as_ref().is_some_and(|set| set.is_match(Path::new(relative)))
			|| self.ignored.as_ref().is_some_and(|ignored| ignored.contains(dir))
	}
}

/// Options of [`pruned_directory_on_path`].
#[napi(object)]
pub struct PrunedOnPathOptions {
	/// The directory a directory search would walk.
	pub root: String,
	/// A path inside `root`.
	pub path: String,
	/// The exclusion globs the search would pass.
	#[napi(js_name = "excludeGlobs")]
	pub exclude_globs: Option<Vec<String>>,
}

/// The root-relative path of the first directory that a directory search of
/// `root` prunes on the way to `path`, `path` itself included when it is a
/// directory, with the search's own rules. `null` when the search reaches
/// `path`. Rejects a `path` outside `root` and an invalid glob.
#[napi(js_name = "prunedDirectoryOnPath")]
pub fn pruned_directory_on_path(options: PrunedOnPathOptions) -> napi::Result<Option<String>> {
	let root = PathBuf::from(&options.root);
	let path = PathBuf::from(&options.path);
	let relative = path
		.strip_prefix(&root)
		.map_err(|_| napi::Error::from_reason(format!("{} is not inside {}", options.path, options.root)))?;
	let exclude = crate::glob_util::compile_glob_set(options.exclude_globs.as_deref())?;
	let pruning = Pruning::new(exclude.as_ref(), IgnoreRules::Directories);
	let mut dir = root.clone();
	for component in relative.components() {
		dir.push(component);
		if !dir.is_dir() {
			break;
		}
		let relative = normalize_relative_path(&root, &dir);
		if pruning.prunes(&dir, &relative) {
			return Ok(Some(relative.into_owned()));
		}
	}
	Ok(None)
}

/// A directory the entry filter pruned, with whether its contents were in reach.
struct PrunedEntry {
	path: String,
	within_depth: bool,
}

/// Builds a deterministic filesystem walker. The entry filter records each
/// directory it prunes in `pruned`, so the walk can still yield it.
fn build_walker(
	root: &Path,
	options: &WalkOptions<'_>,
	filter_issues: Arc<AtomicU32>,
	pruned: Arc<Mutex<Vec<PrunedEntry>>>,
) -> WalkBuilder {
	let mut builder = WalkBuilder::new(root);
	builder
		.hidden(!options.include_hidden)
		.follow_links(true)
		.max_depth(options.max_depth)
		.sort_by_file_path(|a, b| a.cmp(b));

	let ignore_everything = options.ignore == IgnoreRules::Everything;
	builder
		.git_ignore(ignore_everything)
		.git_exclude(ignore_everything)
		.git_global(ignore_everything)
		.ignore(ignore_everything)
		.parents(ignore_everything);
	if ignore_everything {
		// The ignore crate only reads .gitignore when a .git directory exists.
		// Register .gitignore as a custom ignore filename so it works outside
		// git repos (e.g. temp directories in tests, extracted archives).
		builder.add_custom_ignore_filename(".gitignore");
	}
	let pruning = Pruning::new(options.exclude, options.ignore);

	let root = root.to_path_buf();
	let max_depth = options.max_depth;
	// Compare protected roots in the representation the walk itself produces.
	// Both sides must come from `canonicalize`: on Windows it returns a `\\?\`
	// extended path while callers pass a plain drive path, and the two spell the
	// same directory with different prefix components, so `starts_with` never
	// matches and a protected root stays traversable. A root that cannot be
	// canonicalized keeps its literal path so it still matches an exact walk.
	let protected_roots: Vec<PathBuf> = options
		.protected_roots
		.iter()
		.map(|protected| std::fs::canonicalize(protected).unwrap_or_else(|_| protected.clone()))
		.collect();
	let explicit_root_is_protected = std::fs::canonicalize(&root)
		.is_ok_and(|target| protected_roots.iter().any(|protected| target.starts_with(protected)));
	builder.filter_entry(move |entry| {
		let cached = match entry.file_type() {
			Some(cached) => cached,
			None => return true,
		};
		if !cached.is_dir() || entry.path() == root {
			return true;
		}
		if !explicit_root_is_protected {
			match std::fs::canonicalize(entry.path()) {
				Ok(target) if protected_roots.iter().any(|protected| target.starts_with(protected)) => {
					filter_issues.fetch_add(1, Ordering::Relaxed);
					return false;
				}
				Err(_) => {
					filter_issues.fetch_add(1, Ordering::Relaxed);
					return false;
				}
				_ => {}
			}
		}
		let relative = normalize_relative_path(&root, entry.path());
		let excluded = pruning.prunes(entry.path(), &relative);
		if excluded {
			let within_depth = max_depth.is_none_or(|depth| entry.depth() < depth);
			pruned
				.lock()
				.unwrap_or_else(|error| error.into_inner())
				.push(PrunedEntry { path: relative.into_owned(), within_depth });
		}
		!excluded
	});

	builder
}

/// Walk a directory and collect a bounded logical prefix. The walk stops
/// early when `budget` stops; the result then has `stopped` set.
pub(crate) fn walk_directory(root: &Path, options: &WalkOptions<'_>, budget: &SearchBudget) -> WalkResult {
	walk_directory_with_limit(root, options, budget, WALK_ENTRY_LIMIT)
}

fn walk_directory_with_limit(
	root: &Path,
	options: &WalkOptions<'_>,
	budget: &SearchBudget,
	entry_limit: usize,
) -> WalkResult {
	let filter_issues = Arc::new(AtomicU32::new(0));
	let pruned_entries = Arc::new(Mutex::new(Vec::new()));
	let walker = build_walker(root, options, filter_issues.clone(), pruned_entries.clone()).build();
	let mut result = WalkResult {
		entries: Vec::new(),
		pruned: Vec::new(),
		stopped: false,
		entry_limit_reached: false,
		traversal_issues: 0,
	};

	// The filter records a pruned directory while the walker looks for its
	// next entry, so draining after each step keeps walk order.
	let take_pruned = |result: &mut WalkResult| {
		let drained = std::mem::take(&mut *pruned_entries.lock().unwrap_or_else(|error| error.into_inner()));
		for pruned in drained {
			if result.entries.len() == entry_limit {
				result.entry_limit_reached = true;
				return false;
			}
			if pruned.within_depth {
				result.pruned.push(pruned.path.clone());
			}
			result.entries.push(WalkEntry { path: pruned.path, file_type: FileType::Dir });
		}
		true
	};

	for entry in walker {
		if budget.stop() {
			result.stopped = true;
			break;
		}
		if !take_pruned(&mut result) {
			break;
		}
		let entry = match entry {
			Ok(entry) => entry,
			Err(_) => {
				result.traversal_issues = result.traversal_issues.saturating_add(1);
				continue;
			}
		};
		let relative = normalize_relative_path(root, entry.path());
		if relative.is_empty() {
			continue;
		}
		let Some(file_type) = classify_entry(&entry) else {
			result.traversal_issues = result.traversal_issues.saturating_add(1);
			continue;
		};
		if result.entries.len() == entry_limit {
			result.entry_limit_reached = true;
			break;
		}
		result.entries.push(WalkEntry { path: relative.into_owned(), file_type });
	}
	if !result.stopped && !result.entry_limit_reached {
		take_pruned(&mut result);
	}
	result.traversal_issues = result.traversal_issues.saturating_add(filter_issues.load(Ordering::Relaxed));
	result
}

#[cfg(test)]
mod tests {
	use std::{fs, time::Duration};

	use super::*;

	fn budget() -> SearchBudget {
		SearchBudget::new(None, Duration::from_secs(10))
	}

	fn options<'a>(exclude: Option<&'a GlobSet>, protected_roots: &'a [PathBuf]) -> WalkOptions<'a> {
		WalkOptions { include_hidden: true, ignore: IgnoreRules::Directories, max_depth: None, exclude, protected_roots }
	}

	#[test]
	fn entry_limit_keeps_a_deterministic_prefix() {
		let root = std::env::temp_dir().join(format!("flywheel-walk-limit-{}", std::process::id()));
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(&root).unwrap();
		for name in ["a", "b", "c"] {
			fs::write(root.join(name), name).unwrap();
		}
		let result = walk_directory_with_limit(&root, &options(None, &[]), &budget(), 2);
		assert_eq!(result.entries.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>(), ["a", "b"]);
		assert!(result.entry_limit_reached);
		fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn pruned_directories_are_unentered_entries_and_block_the_way_to_a_path() {
		let root = std::env::temp_dir().join(format!("flywheel-walk-pruned-{}", std::process::id()));
		let _ = fs::remove_dir_all(&root);
		for dir in [".git/objects", "node_modules/dep", "results", "src"] {
			fs::create_dir_all(root.join(dir)).unwrap();
		}
		fs::write(root.join(".gitignore"), "results/\n*.log\n").unwrap();
		fs::write(root.join("debug.log"), "log").unwrap();
		fs::write(root.join("results/out.txt"), "out").unwrap();
		fs::write(root.join("node_modules/dep/index.js"), "dep").unwrap();
		fs::write(root.join("src/a.ts"), "a").unwrap();
		let exclude = crate::glob_util::compile_glob_set(Some(&["**/.git".into(), "**/node_modules".into()])).unwrap().unwrap();

		let result = walk_directory(&root, &options(Some(&exclude), &[]), &budget());
		let paths = result.entries.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>();
		assert_eq!(paths, [".git", ".gitignore", "debug.log", "node_modules", "results", "src", "src/a.ts"]);
		assert_eq!(result.pruned, [".git", "node_modules", "results"]);
		assert!(!result.stopped);

		fs::create_dir_all(root.join("src/build")).unwrap();
		fs::write(root.join("src/dist"), "a file that shares a pruned name").unwrap();
		let pruned_on_the_way = |path: &str| {
			pruned_directory_on_path(PrunedOnPathOptions {
				root: root.to_string_lossy().into_owned(),
				path: root.join(path).to_string_lossy().into_owned(),
				exclude_globs: Some(vec!["**/node_modules".into(), "**/build".into(), "**/dist".into()]),
			})
			.unwrap()
		};
		assert_eq!(pruned_on_the_way("results/out.txt").as_deref(), Some("results"));
		assert_eq!(pruned_on_the_way("node_modules/dep").as_deref(), Some("node_modules"));
		assert_eq!(pruned_on_the_way("src/build").as_deref(), Some("src/build"));
		assert_eq!(pruned_on_the_way("src/dist"), None);
		assert_eq!(pruned_on_the_way("src/a.ts"), None);
		fs::remove_dir_all(root).unwrap();
	}

	#[cfg(unix)]
	#[test]
	fn protected_linked_directory_is_pruned_without_blocking_ordinary_links() {
		use std::os::unix::fs::symlink;

		let root = std::env::temp_dir().join(format!("flywheel-walk-protected-{}", std::process::id()));
		let search = root.join("search");
		let shared = root.join("shared");
		let auth = root.join("auth");
		let _ = fs::remove_dir_all(&root);
		for directory in [&search, &shared, &auth] {
			fs::create_dir_all(directory).unwrap();
		}
		fs::write(shared.join("public.txt"), "public").unwrap();
		fs::write(auth.join("secret.txt"), "secret").unwrap();
		symlink(&shared, search.join("shared-link")).unwrap();
		symlink(&auth, search.join("auth-link")).unwrap();

		let protected = [auth];
		let result = walk_directory(&search, &options(None, &protected), &budget());
		let paths = result.entries.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>();
		assert!(paths.contains(&"shared-link/public.txt"));
		assert!(!paths.contains(&"auth-link/secret.txt"));
		assert_eq!(result.traversal_issues, 1);
		fs::remove_dir_all(root).unwrap();
	}
}
