//! Search engine exported via N-API.
//!
//! Exposes `grep()`: filesystem search with glob/type filtering under a
//! processor-time limit and a wall-clock limit. The promise rejects the
//! moment the wall-clock limit expires, no matter what the worker is doing;
//! the shared budget stops the worker
//! itself at cooperative checkpoints, including PCRE2 callouts inside
//! matching, and there charges the processor time of every working thread.

use std::{
	borrow::Cow,
	ffi::c_void,
	fs::File,
	io,
	ops::Range,
	path::{Path, PathBuf},
	ptr::{self, NonNull},
	time::Duration,
};

use globset::GlobSet;
use grep_matcher::{Match, Matcher, NoCaptures};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkFinish, SinkMatch};
use napi::{Env, bindgen_prelude::*};
use napi_derive::napi;
use rayon::prelude::*;
use smallvec::SmallVec;

use crate::{budget::SearchBudget, fs_walk, fs_worker, glob_util};
const MAX_CONTEXT_LINES: u32 = 100;

/// Saturating cast from `u64` to `u32`, clamping at `u32::MAX`.
fn clamp_u32(value: u64) -> u32 {
	value.min(u32::MAX as u64) as u32
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OutputMode {
	Content,
	FilesWithMatches,
	Count,
}

/// Options for searching files on disk.
#[napi(object)]
pub struct GrepOptions {
	/// Regex pattern to search for.
	pub pattern: String,
	/// Regex engine ("default" or "pcre2"); omitted uses the Rust regex engine.
	pub engine: Option<String>,
	/// Directory or file to search.
	pub path: String,
	/// Glob filter for filenames (e.g., "*.ts").
	pub glob: Option<String>,
	/// Filter by file type (e.g., "js", "py", "rust").
	#[napi(js_name = "type")]
	pub type_filter: Option<String>,
	/// Case-insensitive search.
	#[napi(js_name = "ignoreCase")]
	pub ignore_case: Option<bool>,
	/// Enable multiline matching.
	pub multiline: Option<bool>,
	/// Include hidden files (default: true).
	pub hidden: Option<bool>,
	/// Glob patterns pruned from directory walks (matched against
	/// root-relative paths, e.g. "**/node_modules"), in addition to the
	/// directories the repository's ignore rules exclude. Single-file
	/// searches and search roots inside a pruned tree bypass this naturally,
	/// so explicit targeting always works.
	#[napi(js_name = "excludeGlobs")]
	pub exclude_globs: Option<Vec<String>>,
	/// Canonical credential roots that linked descendants must not enter.
	#[napi(js_name = "protectedTraversalRoots")]
	pub protected_traversal_roots: Option<Vec<String>>,
	/// Maximum matching lines (content) or files (filesWithMatches) to return.
	/// Ignored in count mode, which always scans uncapped.
	#[napi(js_name = "maxCount")]
	pub max_count: Option<u32>,
	/// Skip first N matching lines (content) or files (filesWithMatches).
	/// Ignored in count mode.
	pub offset: Option<u32>,
	/// Keep the last `maxCount` matches instead of the first (content mode
	/// only). `offset` is ignored when set; the reported total stays exact
	/// because the scan never stops early.
	pub tail: Option<bool>,
	/// Lines of context before matches.
	#[napi(js_name = "contextBefore")]
	pub context_before: Option<u32>,
	/// Lines of context after matches.
	#[napi(js_name = "contextAfter")]
	pub context_after: Option<u32>,
	/// Lines of context before/after matches (legacy).
	pub context: Option<u32>,
	/// Truncate lines longer than this (characters).
	#[napi(js_name = "maxColumns")]
	pub max_columns: Option<u32>,
	/// Processor time the search may spend, summed across its threads, in
	/// milliseconds. Exceeding it rejects with the processing time reason.
	#[napi(js_name = "cpuLimitMs")]
	pub cpu_limit_ms: u32,
	/// Wall-clock time the search may take, admission included, in
	/// milliseconds. Exceeding it rejects with the wall time reason.
	#[napi(js_name = "timeoutMs")]
	pub timeout_ms: u32,
	/// Output mode (content, filesWithMatches, or count).
	pub mode: Option<String>,
}

/// A context line (before or after a match).
#[derive(Clone)]
#[napi(object)]
pub struct ContextLine {
	#[napi(js_name = "lineNumber")]
	pub line_number: u32,
	/// Raw line content (trimmed line ending).
	pub line: String,
}

/// A single match in a grep result.
#[derive(Clone)]
#[napi(object)]
pub struct GrepMatch {
	/// File path for the match (relative for directory searches).
	pub path: String,
	/// 1-indexed line number (0 for count-only entries).
	#[napi(js_name = "lineNumber")]
	pub line_number: u32,
	/// The matched line content (empty for count-only entries).
	pub line: String,
	/// Context lines before the match.
	#[napi(js_name = "contextBefore")]
	pub context_before: Option<Vec<ContextLine>>,
	/// Context lines after the match.
	#[napi(js_name = "contextAfter")]
	pub context_after: Option<Vec<ContextLine>>,
	/// Whether the line was truncated.
	pub truncated: Option<bool>,
	/// Per-file match count (count mode only).
	#[napi(js_name = "matchCount")]
	pub match_count: Option<u32>,
}

/// Result of searching files.
#[napi(object)]
pub struct GrepResult {
	/// Matches or per-file counts, depending on output mode.
	pub matches: Vec<GrepMatch>,
	/// Matching files in filesWithMatches mode; matching lines otherwise.
	/// Count and tail totals are exact. Capped content totals are a lower bound.
	/// Totals exclude searchFailures and files beyond the walk's entry ceiling.
	#[napi(js_name = "totalMatches")]
	pub total_matches: u32,
	/// Number of files with at least one match.
	#[napi(js_name = "filesWithMatches")]
	pub files_with_matches: u32,
	/// Number of files searched.
	#[napi(js_name = "filesSearched")]
	pub files_searched: u32,
	/// Files skipped because they are binary, unreadable, not regular, or failed matching.
	#[napi(js_name = "filesSkipped")]
	pub files_skipped: u32,
	/// Directory-search files whose matcher failed; their matches and counts are excluded.
	#[napi(js_name = "searchFailures")]
	pub search_failures: Option<Vec<SearchFailure>>,
	/// Number of linked-directory branches skipped after traversal failures.
	#[napi(js_name = "traversalIssues")]
	pub traversal_issues: u32,
	/// Whether the shared filesystem walk ceiling retained only a prefix.
	#[napi(js_name = "entryLimitReached")]
	pub entry_limit_reached: Option<bool>,
	/// Root-relative directories the walk pruned without entering.
	#[napi(js_name = "prunedDirectories")]
	pub pruned_directories: Option<Vec<String>>,
	/// Reason a single-file search was skipped, when applicable.
	#[napi(js_name = "skipReason")]
	pub skip_reason: Option<String>,
	/// Whether the limit/offset stopped the search early.
	#[napi(js_name = "limitReached")]
	pub limit_reached: Option<bool>,
}

/// A file excluded from directory-search results after a matcher error.
#[napi(object)]
pub struct SearchFailure {
	/// Path relative to the search root.
	pub path: String,
	pub reason: String,
}

impl GrepResult {
	fn empty() -> Self {
		Self {
			matches: Vec::new(),
			total_matches: 0,
			files_with_matches: 0,
			files_searched: 0,
			files_skipped: 0,
			search_failures: None,
			skip_reason: None,
			traversal_issues: 0,
			entry_limit_reached: None,
			pruned_directories: None,
			limit_reached: None,
		}
	}
}

/// The scan's signal that the budget stopped it. Stopping is an error, not a
/// partial result: the task rejects with the budget's reason and the model
/// is told to narrow the search. Checked at file boundaries, inside large
/// files at segment boundaries, and inside PCRE2 matching through callouts.
fn budget_exhausted() -> io::Error {
	io::Error::new(io::ErrorKind::TimedOut, "search stopped")
}

enum TypeFilter {
	Known {
		exts: &'static [&'static str],
		names: &'static [&'static str],
	},
	Custom(String),
}

impl TypeFilter {
	fn match_ext(&self, ext: &str) -> bool {
		match self {
			Self::Known { exts, .. } => exts.iter().any(|e| ext.eq_ignore_ascii_case(e)),
			Self::Custom(custom_ext) => ext.eq_ignore_ascii_case(custom_ext),
		}
	}

	fn match_name(&self, name: &str) -> bool {
		match self {
			Self::Known { names, .. } => names.iter().any(|n| name.eq_ignore_ascii_case(n)),
			Self::Custom(ext) => ext.eq_ignore_ascii_case(name),
		}
	}
}

// ---------------------------------------------------------------------------
// Internal match collection
// ---------------------------------------------------------------------------

struct MatchCollector<'a> {
	matches: Vec<CollectedMatch>,
	match_count: u64,
	collected_count: u64,
	max_count: Option<u64>,
	offset: u64,
	/// Keep the last `max_count` matches (ring buffer) instead of stopping
	/// at the first `max_count`.
	tail: bool,
	skipped: u64,
	limit_reached: bool,
	max_columns: Option<usize>,
	mode: OutputMode,
	before_count: usize,
	after_count: usize,
	/// Lines preceding the current segment when a large file is scanned
	/// segment-by-segment; added to within-segment line numbers so reported
	/// positions stay file-absolute.
	line_base: u64,
	/// Set when the searcher's binary detection quit the scan; the file is
	/// reported as skipped and any collected matches are discarded.
	binary: bool,
	budget: Option<&'a SearchBudget>,
}

struct CollectedMatch {
	line_number: u64,
	line: String,
	context_before: SmallVec<[ContextLine; 8]>,
	context_after: SmallVec<[ContextLine; 8]>,
	truncated: bool,
}

struct SearchResultInternal {
	matches: Vec<CollectedMatch>,
	match_count: u64,
	collected: u64,
	limit_reached: bool,
	binary: bool,
}

struct FileEntry {
	path: PathBuf,
	relative_path: String,
}

struct FileSearchResult {
	relative_path: String,
	matches: Vec<CollectedMatch>,
	match_count: u64,
	limit_reached: bool,
}

enum FileOutcome {
	Searched(FileSearchResult),
	Skipped,
	Failed(SearchFailure),
	/// Budget expired or abort observed before this file was scanned.
	Stopped,
}

enum FileBytes {
	Mapped(memmap2::Mmap),
	Owned(Vec<u8>),
}

impl FileBytes {
	fn as_slice(&self) -> &[u8] {
		match self {
			Self::Mapped(mapped) => mapped.as_ref(),
			Self::Owned(bytes) => bytes.as_slice(),
		}
	}
}

#[derive(Clone, Copy, Debug)]
enum SkipReason {
	NotFile,
	Binary,
	Unreadable,
}

impl SkipReason {
	const fn as_str(self) -> &'static str {
		match self {
			Self::NotFile => "not a regular file",
			Self::Binary => "binary content detected",
			Self::Unreadable => "could not be read",
		}
	}
}

enum FileReadOutcome {
	Bytes(FileBytes),
	Skipped(SkipReason),
}

impl<'a> MatchCollector<'a> {
	fn new(params: SearchParams, budget: Option<&'a SearchBudget>) -> Self {
		let (before_count, after_count) = if params.mode == OutputMode::Content {
			(params.context_before as usize, params.context_after as usize)
		} else {
			(0, 0)
		};
		let (max_count, offset, tail) = if params.mode == OutputMode::Content {
			(params.max_count, params.offset, params.tail)
		} else {
			(None, 0, false)
		};
		Self {
			matches: Vec::new(),
			match_count: 0,
			collected_count: 0,
			max_count,
			offset,
			tail,
			skipped: 0,
			limit_reached: false,
			max_columns: params.max_columns.map(|v| v as usize),
			mode: params.mode,
			before_count,
			after_count,
			line_base: 0,
			binary: false,
			budget,
		}
	}

	/// Collected matches in file order. In tail mode the ring buffer is
	/// rotated so the oldest kept match comes first.
	fn take_matches(&mut self) -> Vec<CollectedMatch> {
		let mut matches = std::mem::take(&mut self.matches);
		if self.tail {
			if let Some(max) = self.max_count {
				if max > 0 && self.collected_count > max {
					matches.rotate_left((self.collected_count % max) as usize);
				}
			}
		}
		matches
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn truncate_line(line: &str, max_columns: Option<usize>) -> (String, bool) {
	match max_columns {
		Some(max) if line.len() > max => {
			let cut = max.saturating_sub(3);
			let boundary = line.floor_char_boundary(cut);
			(format!("{}...", &line[..boundary]), true)
		}
		_ => (line.to_string(), false),
	}
}

fn bytes_to_trimmed_string(bytes: &[u8]) -> String {
	match std::str::from_utf8(bytes) {
		Ok(text) => text.trim_end().to_string(),
		Err(_) => String::from_utf8_lossy(bytes).trim_end().to_string(),
	}
}

/// Extract context lines before and after a match from the searched buffer.
fn extract_context_lines(
	buffer: &[u8],
	match_range: Range<usize>,
	before: usize,
	after: usize,
	match_line_number: u64,
	max_columns: Option<usize>,
) -> (SmallVec<[ContextLine; 8]>, SmallVec<[ContextLine; 8]>) {
	let mut before_lines = SmallVec::new();
	let mut after_lines = SmallVec::new();

	// --- Before context ---
	if before > 0 && match_range.start > 0 {
		let mut end = match_range.start;
		let mut line_num = match_line_number;

		for _ in 0..before {
			if end == 0 || line_num == 0 {
				break;
			}
			let content_end = if buffer[end - 1] == b'\n' {
				end - 1
			} else {
				end
			};
			let start = match buffer[..content_end].iter().rposition(|&b| b == b'\n') {
				Some(pos) => pos + 1,
				None => 0,
			};
			line_num -= 1;
			let raw = bytes_to_trimmed_string(&buffer[start..content_end]);
			let (line, _) = truncate_line(&raw, max_columns);
			before_lines.push(ContextLine {
				line_number: clamp_u32(line_num),
				line,
			});
			end = start;
		}
		before_lines.reverse();
	}

	// --- After context ---
	if after > 0 && match_range.end < buffer.len() {
		#[allow(clippy::naive_bytecount)]
		let newlines = buffer[match_range.clone()]
			.iter()
			.filter(|&&b| b == b'\n')
			.count() as u64;
		let mut start = match_range.end;
		for line_num in
			(match_line_number + newlines)..(match_line_number + newlines + after as u64)
		{
			if start >= buffer.len() {
				break;
			}
			let end = match buffer[start..].iter().position(|&b| b == b'\n') {
				Some(pos) => start + pos,
				None => buffer.len(),
			};
			let raw = bytes_to_trimmed_string(&buffer[start..end]);
			let (line, _) = truncate_line(&raw, max_columns);
			after_lines.push(ContextLine {
				line_number: clamp_u32(line_num),
				line,
			});
			start = end + 1;
		}
	}

	(before_lines, after_lines)
}

// ---------------------------------------------------------------------------
// Sink implementation for grep-searcher
// ---------------------------------------------------------------------------

impl Sink for MatchCollector<'_> {
	type Error = io::Error;

	fn matched(
		&mut self,
		_searcher: &Searcher,
		mat: &SinkMatch<'_>,
	) -> std::result::Result<bool, Self::Error> {
		self.collect(
			mat.buffer(),
			mat.bytes_range_in_buffer(),
			mat.line_number().unwrap_or(0),
		)
	}

	fn finish(
		&mut self,
		_searcher: &Searcher,
		sink_finish: &SinkFinish,
	) -> std::result::Result<(), Self::Error> {
		if sink_finish.binary_byte_offset().is_some() {
			self.binary = true;
		}
		Ok(())
	}
}

impl MatchCollector<'_> {
	fn collect(&mut self, buffer: &[u8], range: Range<usize>, line_number: u64) -> io::Result<bool> {
		self.match_count += 1;

		// Match-dense files produce no other checkpoint (a multiline scan has
		// no segments), so sample the budget every 256th match.
		if self.match_count & 0xff == 0 && self.budget.is_some_and(SearchBudget::stop) {
			return Err(budget_exhausted());
		}

		if self.limit_reached {
			return Ok(false);
		}

		if self.skipped < self.offset {
			self.skipped += 1;
			return Ok(true);
		}

		if self.mode != OutputMode::Count {
			let bytes = &buffer[range.clone()];
			let line_bytes = if self.mode == OutputMode::FilesWithMatches {
				&bytes[..memchr::memchr(b'\n', bytes).unwrap_or(bytes.len())]
			} else {
				bytes
			};
			let raw_line = bytes_to_trimmed_string(line_bytes);
			let (line, truncated) = truncate_line(&raw_line, self.max_columns);
			let line_number = line_number.saturating_add(self.line_base);

			let (context_before, context_after) = if self.before_count > 0 || self.after_count > 0
			{
				extract_context_lines(
					buffer,
					range,
					self.before_count,
					self.after_count,
					line_number,
					self.max_columns,
				)
			} else {
				(SmallVec::new(), SmallVec::new())
			};

			let collected = CollectedMatch {
				line_number,
				line,
				context_before,
				context_after,
				truncated,
			};
			match self.max_count {
				// Tail mode ring buffer: overwrite the oldest slot instead of
				// stopping at the cap; take_matches() rotates back into file order.
				Some(max) if self.tail && max > 0 && self.matches.len() as u64 >= max => {
					self.matches[(self.collected_count % max) as usize] = collected;
				}
				_ => self.matches.push(collected),
			}
		}

		self.collected_count += 1;

		if self.mode == OutputMode::FilesWithMatches {
			return Ok(false);
		}

		if let Some(max) = self.max_count {
			// Tail keeps scanning to the end of input; only head mode stops early.
			if !self.tail && self.collected_count >= max {
				self.limit_reached = true;
			}
		}

		Ok(!self.limit_reached)
	}
}

// ---------------------------------------------------------------------------
// Option resolution
// ---------------------------------------------------------------------------

fn parse_output_mode(mode: Option<&str>) -> OutputMode {
	match mode {
		Some("count") => OutputMode::Count,
		Some("filesWithMatches") => OutputMode::FilesWithMatches,
		_ => OutputMode::Content,
	}
}

fn resolve_search_path(path: &str) -> Result<PathBuf> {
	let candidate = PathBuf::from(path);
	if candidate.is_absolute() {
		return Ok(candidate);
	}
	let cwd = std::env::current_dir()
		.map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?;
	Ok(cwd.join(candidate))
}

fn resolve_type_filter(type_name: Option<&str>) -> Option<TypeFilter> {
	let normalized = type_name
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(|value| value.trim_start_matches('.').to_lowercase())?;

	let (exts, names): (&[&str], &[&str]) = match normalized.as_str() {
		"js" | "javascript" => (&["js", "jsx", "mjs", "cjs"], &[]),
		"ts" | "typescript" => (&["ts", "tsx", "mts", "cts"], &[]),
		"json" => (&["json", "jsonc", "json5"], &[]),
		"yaml" | "yml" => (&["yaml", "yml"], &[]),
		"toml" => (&["toml"], &[]),
		"md" | "markdown" => (&["md", "markdown", "mdx"], &[]),
		"py" | "python" => (&["py", "pyi"], &[]),
		"rs" | "rust" => (&["rs"], &[]),
		"go" => (&["go"], &[]),
		"java" => (&["java"], &[]),
		"kt" | "kotlin" => (&["kt", "kts"], &[]),
		"c" => (&["c", "h"], &[]),
		"cpp" | "cxx" => (&["cpp", "cc", "cxx", "hpp", "hxx", "hh"], &[]),
		"cs" | "csharp" => (&["cs", "csx"], &[]),
		"php" => (&["php", "phtml"], &[]),
		"rb" | "ruby" => (&["rb", "rake", "gemspec"], &[]),
		"sh" | "bash" => (&["sh", "bash", "zsh"], &[]),
		"zsh" => (&["zsh"], &[]),
		"fish" => (&["fish"], &[]),
		"html" => (&["html", "htm"], &[]),
		"css" => (&["css"], &[]),
		"scss" => (&["scss"], &[]),
		"sass" => (&["sass"], &[]),
		"less" => (&["less"], &[]),
		"xml" => (&["xml"], &[]),
		"docker" | "dockerfile" => (&[], &["dockerfile"]),
		"make" | "makefile" => (&[], &["makefile"]),
		_ => {
			return Some(TypeFilter::Custom(normalized));
		}
	};

	Some(TypeFilter::Known { exts, names })
}

fn matches_type_filter(path: &Path, filter: &TypeFilter) -> bool {
	let base_name = path
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or("");
	if filter.match_name(base_name) {
		return true;
	}
	let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
	if ext.is_empty() {
		return false;
	}
	filter.match_ext(ext)
}

fn resolve_context(
	context: Option<u32>,
	context_before: Option<u32>,
	context_after: Option<u32>,
) -> Result<(u32, u32)> {
	let resolved = if context_before.is_some() || context_after.is_some() {
		(context_before.unwrap_or(0), context_after.unwrap_or(0))
	} else {
		let value = context.unwrap_or(0);
		(value, value)
	};
	if resolved.0 > MAX_CONTEXT_LINES || resolved.1 > MAX_CONTEXT_LINES {
		return Err(Error::from_reason(format!("context must be at most {MAX_CONTEXT_LINES} lines")));
	}
	Ok(resolved)
}

// ---------------------------------------------------------------------------
// Search engine
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct SearchParams {
	context_before: u32,
	context_after: u32,
	max_columns: Option<u32>,
	mode: OutputMode,
	max_count: Option<u64>,
	offset: u64,
	tail: bool,
	multiline: bool,
}

/// Upper bound on bytes scanned between budget checks. Line searches of
/// files larger than this run segment-by-segment (cut at line boundaries)
/// so a single giant file cannot outlive the budget -- a whole-file slice
/// search only observes the budget between files. Multiline patterns can
/// span any cut, so multiline searches stay whole-file and rely on the
/// per-match budget sample and the task-level deadline.
const SEGMENT_SIZE: usize = 8 << 20;

/// End of the segment starting at `start`: at most `SEGMENT_SIZE` bytes, cut
/// after the last newline so every line lives in exactly one segment. A
/// single line longer than the segment extends to its own end.
fn segment_end(content: &[u8], start: usize) -> usize {
	let tentative = (start + SEGMENT_SIZE).min(content.len());
	if tentative == content.len() {
		return tentative;
	}
	match content[start..tentative].iter().rposition(|&b| b == b'\n') {
		Some(pos) => start + pos + 1,
		None => content[tentative..]
			.iter()
			.position(|&b| b == b'\n')
			.map_or(content.len(), |pos| tentative + pos + 1),
	}
}

trait SearchMatcher: Matcher + Sized {
	fn search(&self, searcher: &mut Searcher, content: &[u8], collector: &mut MatchCollector<'_>) -> io::Result<()> {
		searcher.search_slice(self, content, collector)
	}
}

impl SearchMatcher for grep_regex::RegexMatcher {}

fn run_search<M: SearchMatcher>(
	searcher: &mut Searcher,
	matcher: &M,
	content: &[u8],
	params: SearchParams,
	budget: Option<&SearchBudget>,
) -> io::Result<SearchResultInternal> {
	let mut collector = MatchCollector::new(params, budget);

	let scanned = (|| {
		if params.multiline || content.len() <= SEGMENT_SIZE {
			matcher.search(searcher, content, &mut collector)?;
		} else {
			let mut start = 0usize;
			while start < content.len() && !collector.limit_reached && !collector.binary {
				if budget.is_some_and(SearchBudget::stop) {
					return Err(budget_exhausted());
				}
				let end = segment_end(content, start);
				matcher.search(searcher, &content[start..end], &mut collector)?;
				if params.mode == OutputMode::FilesWithMatches && collector.match_count > 0 {
					break;
				}
				collector.line_base += memchr::memchr_iter(b'\n', &content[start..end]).count() as u64;
				start = end;
			}
		}
		Ok(())
	})();
	// grep-searcher renders matcher errors as io::ErrorKind::Other.
	if budget.is_some_and(SearchBudget::stop) { return Err(budget_exhausted()); }
	scanned?;

	let matches = collector.take_matches();
	Ok(SearchResultInternal {
		matches,
		match_count: collector.match_count,
		collected: collector.collected_count,
		limit_reached: collector.limit_reached,
		binary: collector.binary,
	})
}

fn build_searcher(multiline: bool) -> Searcher {
	SearcherBuilder::new()
		.line_number(true)
		.multi_line(multiline)
		// Quit on the first NUL byte instead of pre-scanning whole files for
		// one: the old upfront scan read every byte of a file (all 728MB of a
		// runaway log) before the search read them all again.
		.binary_detection(BinaryDetection::quit(0))
		.build()
}

/// Attempt to read file bytes for searching, returning the reason on skip.
fn read_file_bytes(path: &Path) -> FileReadOutcome {
	let metadata = match std::fs::symlink_metadata(path) {
		Ok(m) => m,
		Err(_) => return FileReadOutcome::Skipped(SkipReason::Unreadable),
	};
	let resolved_metadata = if metadata.file_type().is_symlink() {
		let target_metadata = match std::fs::metadata(path) {
			Ok(m) => m,
			Err(_) => return FileReadOutcome::Skipped(SkipReason::Unreadable),
		};
		if !target_metadata.is_file() {
			return FileReadOutcome::Skipped(SkipReason::NotFile);
		}
		target_metadata
	} else if metadata.is_file() {
		metadata
	} else {
		return FileReadOutcome::Skipped(SkipReason::NotFile);
	};
	if resolved_metadata.len() == 0 {
		return FileReadOutcome::Bytes(FileBytes::Owned(Vec::new()));
	}
	let file = match File::open(path) {
		Ok(f) => f,
		Err(_) => return FileReadOutcome::Skipped(SkipReason::Unreadable),
	};

	let mapping = unsafe {
		// SAFETY: The mapping is read-only and tied to the opened file handle.
		// We do not mutate through this view; the map is dropped immediately
		// after search for each file.
		memmap2::Mmap::map(&file)
	};

	// Binary detection happens during the search itself (the searcher quits
	// at the first NUL byte); no upfront whole-file scan here.
	match mapping {
		Ok(mapped) => FileReadOutcome::Bytes(FileBytes::Mapped(mapped)),
		Err(_) => match std::fs::read(path) {
			Ok(content) => FileReadOutcome::Bytes(FileBytes::Owned(content)),
			Err(_) => FileReadOutcome::Skipped(SkipReason::Unreadable),
		},
	}
}

// ---------------------------------------------------------------------------
// Result conversion
// ---------------------------------------------------------------------------

fn to_grep_match(path: &str, matched: CollectedMatch) -> GrepMatch {
	let context_before = if matched.context_before.is_empty() {
		None
	} else {
		Some(matched.context_before.into_vec())
	};
	let context_after = if matched.context_after.is_empty() {
		None
	} else {
		Some(matched.context_after.into_vec())
	};
	GrepMatch {
		path: path.to_string(),
		line_number: clamp_u32(matched.line_number),
		line: matched.line,
		context_before,
		context_after,
		truncated: if matched.truncated { Some(true) } else { None },
		match_count: None,
	}
}

// ---------------------------------------------------------------------------
// Regex brace sanitization
// ---------------------------------------------------------------------------

fn find_valid_repetition(bytes: &[u8], start: usize) -> Option<usize> {
	let len = bytes.len();
	let mut i = start + 1;
	if i >= len || !bytes[i].is_ascii_digit() {
		return None;
	}
	while i < len && bytes[i].is_ascii_digit() {
		i += 1;
	}
	if i >= len {
		return None;
	}
	if bytes[i] == b'}' {
		return Some(i);
	}
	if bytes[i] != b',' {
		return None;
	}
	i += 1;
	if i >= len {
		return None;
	}
	while i < len && bytes[i].is_ascii_digit() {
		i += 1;
	}
	if i < len && bytes[i] == b'}' {
		return Some(i);
	}
	None
}

fn find_braced_escape_end(bytes: &[u8], start: usize) -> Option<usize> {
	let mut i = start + 1;
	while i < bytes.len() {
		if bytes[i] == b'}' {
			return Some(i);
		}
		i += 1;
	}
	None
}

fn sanitize_braces(pattern: &str) -> Cow<'_, str> {
	let bytes = pattern.as_bytes();
	if !bytes.contains(&b'{') && !bytes.contains(&b'}') {
		return Cow::Borrowed(pattern);
	}

	let len = bytes.len();
	let mut result = String::with_capacity(len + 8);
	let mut modified = false;
	let mut i = 0;

	while i < len {
		if bytes[i] == b'\\' && i + 1 < len {
			result.push('\\');
			i += 1;
			let ch = pattern[i..]
				.chars()
				.next()
				.expect("non-empty slice has a char");
			result.push(ch);
			i += ch.len_utf8();
			if matches!(ch, 'p' | 'P' | 'x' | 'u') && i < len && bytes[i] == b'{' {
				if let Some(end) = find_braced_escape_end(bytes, i) {
					result.push_str(&pattern[i..=end]);
					i = end + 1;
				} else {
					result.push_str(&pattern[i..]);
					i = len;
				}
			}
			continue;
		}

		if bytes[i] == b'{' {
			if let Some(end) = find_valid_repetition(bytes, i) {
				result.push_str(&pattern[i..=end]);
				i = end + 1;
				continue;
			}
			result.push_str("\\{");
			i += 1;
			modified = true;
			continue;
		}

		if bytes[i] == b'}' {
			result.push_str("\\}");
			i += 1;
			modified = true;
			continue;
		}

		let ch = pattern[i..]
			.chars()
			.next()
			.expect("non-empty slice has a char");
		result.push(ch);
		i += ch.len_utf8();
	}

	if modified {
		Cow::Owned(result)
	} else {
		Cow::Borrowed(pattern)
	}
}

fn escape_unescaped_parentheses(pattern: &str) -> Cow<'_, str> {
	let bytes = pattern.as_bytes();
	if !bytes.contains(&b'(') && !bytes.contains(&b')') {
		return Cow::Borrowed(pattern);
	}

	let mut result = String::with_capacity(pattern.len() + 4);
	let mut modified = false;
	let mut i = 0;

	while i < bytes.len() {
		if bytes[i] == b'\\' && i + 1 < bytes.len() {
			result.push('\\');
			i += 1;
			let ch = pattern[i..]
				.chars()
				.next()
				.expect("non-empty slice has a char");
			result.push(ch);
			i += ch.len_utf8();
			continue;
		}

		let ch = pattern[i..]
			.chars()
			.next()
			.expect("non-empty slice has a char");
		if matches!(ch, '(' | ')') {
			result.push('\\');
			modified = true;
		}
		result.push(ch);
		i += ch.len_utf8();
	}

	if modified {
		Cow::Owned(result)
	} else {
		Cow::Borrowed(pattern)
	}
}

fn build_regex_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> std::result::Result<grep_regex::RegexMatcher, grep_regex::Error> {
	RegexMatcherBuilder::new()
		.case_insensitive(ignore_case)
		.multi_line(multiline)
		.build(pattern)
}

fn build_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> Result<grep_regex::RegexMatcher> {
	let sanitized = sanitize_braces(pattern);
	match build_regex_matcher(sanitized.as_ref(), ignore_case, multiline) {
		Ok(matcher) => Ok(matcher),
		Err(err) => {
			let message = err.to_string();
			if message.contains("unclosed group") || message.contains("unopened group") {
				let escaped = escape_unescaped_parentheses(sanitized.as_ref());
				if escaped.as_ref() != sanitized.as_ref() {
					return build_regex_matcher(escaped.as_ref(), ignore_case, multiline)
						.map_err(|retry_err| {
							Error::from_reason(format!("Regex error: {retry_err}"))
						});
				}
			}
			Err(Error::from_reason(format!("Regex error: {message}")))
		}
	}
}

fn build_pcre2_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
	budget: &SearchBudget,
) -> Result<Pcre2Matcher> {
	let mut flags = pcre2_sys::PCRE2_AUTO_CALLOUT | pcre2_sys::PCRE2_USE_OFFSET_LIMIT | pcre2_sys::PCRE2_UCP
		| pcre2_sys::PCRE2_UTF | pcre2_sys::PCRE2_MATCH_INVALID_UTF;
	if ignore_case { flags |= pcre2_sys::PCRE2_CASELESS; }
	if multiline { flags |= pcre2_sys::PCRE2_MULTILINE; }
	let mut error = 0;
	let mut offset = 0;
	// SAFETY: PCRE2 borrows the pattern only for this call and owns the returned code.
	let code = unsafe {
		pcre2_sys::pcre2_compile_8(
			pattern.as_ptr(), pattern.len(), flags, &mut error, &mut offset, ptr::null_mut(),
		)
	};
	let code = NonNull::new(code).ok_or_else(|| {
		Error::from_reason(format!("Regex error: PCRE2: error compiling at offset {offset}: {}", pcre2_error(error)))
	})?;
	Ok(Pcre2Matcher { code, budget: budget.clone() })
}

// grep-pcre2 does not expose callouts or match-context limits. This binding
// uses the vendored PCRE2 header's pointer-only ABI; the callout block is opaque.
unsafe extern "C" {
	fn pcre2_set_callout_8(
		context: *mut pcre2_sys::pcre2_match_context_8,
		callback: Option<unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32>,
		data: *mut c_void,
	) -> i32;
}

struct Pcre2Matcher {
	code: NonNull<pcre2_sys::pcre2_code_8>,
	budget: SearchBudget,
}

// SAFETY: compiled code is immutable; each find owns its context and match data.
unsafe impl Sync for Pcre2Matcher {}

impl Drop for Pcre2Matcher {
	fn drop(&mut self) {
		// SAFETY: this is the unique owner, and all matching borrows have ended.
		unsafe { pcre2_sys::pcre2_code_free_8(self.code.as_ptr()); }
	}
}

struct Pcre2Match {
	context: NonNull<pcre2_sys::pcre2_match_context_8>,
	data: NonNull<pcre2_sys::pcre2_match_data_8>,
}

impl Drop for Pcre2Match {
	fn drop(&mut self) {
		// SAFETY: both handles belong to this find and PCRE2 has returned.
		unsafe {
			pcre2_sys::pcre2_match_data_free_8(self.data.as_ptr());
			pcre2_sys::pcre2_match_context_free_8(self.context.as_ptr());
		}
	}
}

unsafe extern "C" fn pcre2_budget_callout(_: *mut c_void, data: *mut c_void) -> i32 {
	// SAFETY: find_at lends its budget to a synchronous match; PCRE2 never retains it.
	let budget = unsafe { &*data.cast::<SearchBudget>() };
	if budget.stop() { pcre2_sys::PCRE2_ERROR_CALLOUT } else { 0 }
}

fn pcre2_error(code: i32) -> io::Error {
	let mut message = [0u8; 256];
	// SAFETY: the buffer is writable for its stated length.
	let length = unsafe { pcre2_sys::pcre2_get_error_message_8(code, message.as_mut_ptr(), message.len()) };
	if length < 0 { return io::Error::other(format!("PCRE2 error {code}")); }
	io::Error::other(String::from_utf8_lossy(&message[..length as usize]).into_owned())
}

impl Matcher for Pcre2Matcher {
	type Captures = NoCaptures;
	type Error = io::Error;

	fn new_captures(&self) -> io::Result<NoCaptures> { Ok(NoCaptures::new()) }

	fn find_at(&self, haystack: &[u8], at: usize) -> io::Result<Option<Match>> {
		self.find_at_until(haystack, at, haystack.len())
	}
}

impl Pcre2Matcher {
	// Bound match starts without truncating the subject: an overlapping match
	// may extend the pending block, but the next line must wait for the collector.
	fn find_at_until(&self, haystack: &[u8], at: usize, last_start: usize) -> io::Result<Option<Match>> {
		if self.budget.stop() { return Err(budget_exhausted()); }
		// SAFETY: code remains borrowed; each allocation is uniquely owned by this call.
		let state = unsafe {
			let context = NonNull::new(pcre2_sys::pcre2_match_context_create_8(ptr::null_mut()))
				.ok_or_else(|| io::Error::other("PCRE2 match context allocation failed"))?;
			let data = NonNull::new(pcre2_sys::pcre2_match_data_create_from_pattern_8(self.code.as_ptr(), ptr::null_mut()));
			let Some(data) = data else {
				pcre2_sys::pcre2_match_context_free_8(context.as_ptr());
				return Err(io::Error::other("PCRE2 match data allocation failed"));
			};
			Pcre2Match { context, data }
		};
		// The reported quadratic and backtracking patterns require in-match
		// cancellation. These independent caps also bound each match's work,
		// nesting, and heap: one million steps, 1,000 frames, and 8 MiB.
		// SAFETY: all handles are live, and budget and haystack outlive the synchronous match.
		let result = unsafe {
			let context = state.context.as_ptr();
			pcre2_sys::pcre2_set_match_limit_8(context, 1_000_000);
			pcre2_sys::pcre2_set_depth_limit_8(context, 1_000);
			pcre2_sys::pcre2_set_heap_limit_8(context, 8_192);
			pcre2_sys::pcre2_set_offset_limit_8(context, last_start);
			pcre2_set_callout_8(context, Some(pcre2_budget_callout), ptr::from_ref(&self.budget).cast_mut().cast());
			pcre2_sys::pcre2_match_8(
				self.code.as_ptr(), haystack.as_ptr(), haystack.len(), at, 0, state.data.as_ptr(), context,
			)
		};
		if self.budget.stop() { return Err(budget_exhausted()); }
		if result == pcre2_sys::PCRE2_ERROR_NOMATCH { return Ok(None); }
		if result < 0 { return Err(pcre2_error(result)); }
		// SAFETY: a successful match has at least the overall match's two offsets.
		let matched = unsafe {
			let offsets = pcre2_sys::pcre2_get_ovector_pointer_8(state.data.as_ptr());
			Match::new(*offsets, *offsets.add(1))
		};
		Ok(Some(matched))
	}
}

impl SearchMatcher for Pcre2Matcher {
	fn search(&self, searcher: &mut Searcher, content: &[u8], collector: &mut MatchCollector<'_>) -> io::Result<()> {
		if !searcher.multi_line() {
			return searcher.search_slice(self, content, collector);
		}
		// grep-searcher's multiline sink coalesces adjacent lines, even when
		// their matches are independent. Keep overlapping line ranges together
		// for real cross-line matches, but page adjacent matches separately.
		if memchr::memchr(0, &content[..content.len().min(64 * 1024)]).is_some() {
			collector.binary = true;
			return Ok(());
		}
		let mut at = 0;
		let mut cursor = 0;
		let mut line_start = 0;
		let mut line_number = 1u64;
		let mut pending: Option<(Range<usize>, u64)> = None;
		while at < content.len() {
			let last_start = pending.as_ref().map_or(content.len(), |(range, _)| range.end - 1);
			let matched = if at <= last_start {
				self.find_at_until(content, at, last_start)?
			} else {
				None
			};
			let Some(matched) = matched else {
				if let Some((range, number)) = pending.take() {
					at = at.max(range.end);
					if !collector.collect(content, range, number)? { return Ok(()); }
					continue;
				}
				break;
			};
			for newline in memchr::memchr_iter(b'\n', &content[cursor..matched.start()]) {
				line_start = cursor + newline + 1;
				line_number += 1;
			}
			cursor = matched.start();
			let end = if matched.end() > line_start && content[matched.end() - 1] == b'\n' {
				matched.end()
			} else {
				memchr::memchr(b'\n', &content[matched.end()..])
					.map_or(content.len(), |index| matched.end() + index + 1)
			};
			let range = line_start..end;
			if range.is_empty() { break; }
			if memchr::memchr(0, &content[range.clone()]).is_some() {
				collector.binary = true;
				return Ok(());
			}
			if collector.mode == OutputMode::FilesWithMatches {
				if !collector.collect(content, range, line_number)? { return Ok(()); }
			} else {
				pending = Some(match pending.take() {
					Some((previous, number)) => (previous.start..range.end, number),
					None => (range, line_number),
				});
			}
			at = matched.end();
			if matched.is_empty() {
				at += 1;
				// PCRE2's UTF mode requires offsets at code-point boundaries.
				while at < content.len() && content[at] & 0xc0 == 0x80 { at += 1; }
			}
		}
		if let Some((range, number)) = pending { collector.collect(content, range, number)?; }
		Ok(())
	}
}

// ---------------------------------------------------------------------------
// File / directory search orchestration
// ---------------------------------------------------------------------------

fn collect_files(
	root: &Path,
	entries: &[fs_walk::WalkEntry],
	glob_set: Option<&GlobSet>,
	type_filter: Option<&TypeFilter>,
) -> Vec<FileEntry> {
	let mut result = Vec::new();
	for entry in entries {
		if entry.file_type != fs_walk::FileType::File {
			continue;
		}
		if let Some(glob_set) = glob_set {
			if !glob_set.is_match(Path::new(&entry.path)) {
				continue;
			}
		}
		let path = root.join(&entry.path);
		if let Some(filter) = type_filter {
			if !matches_type_filter(&path, filter) {
				continue;
			}
		}
		result.push(FileEntry {
			path,
			relative_path: entry.path.clone(),
		});
	}
	result
}

/// Scan collected files in parallel, honoring the budget at file boundaries.
/// In content mode each file collects at most `offset + max_count` matches: the aggregation
/// step takes at most that many from any file prefix, and a file that hits
/// the cap alone satisfies the global limit, so ordering never corrupts.
/// Files mode keeps only the first matching line; count mode scans uncapped.
fn run_parallel_search<M: SearchMatcher + Sync>(
	entries: &[FileEntry],
	matcher: &M,
	params: SearchParams,
	budget: &SearchBudget,
) -> (Vec<FileSearchResult>, u32, bool, Vec<SearchFailure>) {
	let file_params = SearchParams {
		max_count: params.max_count.map(|max| max.saturating_add(params.offset)),
		offset: 0,
		..params
	};
	let outcomes: Vec<FileOutcome> = entries
		.par_iter()
		.map_init(
			|| build_searcher(file_params.multiline),
			|searcher, entry| {
				let _work = budget.work();
				if budget.stop() {
					return FileOutcome::Stopped;
				}
				let bytes = match read_file_bytes(&entry.path) {
					FileReadOutcome::Bytes(b) => b,
					FileReadOutcome::Skipped(_) => return FileOutcome::Skipped,
				};
				let search =
					match run_search(searcher, matcher, bytes.as_slice(), file_params, Some(budget)) {
						Ok(search) => search,
						Err(err) if err.kind() == io::ErrorKind::TimedOut => {
							return FileOutcome::Stopped;
						}
						Err(err) => return FileOutcome::Failed(SearchFailure {
							path: entry.relative_path.clone(),
							reason: err.to_string(),
						}),
					};
				if search.binary {
					return FileOutcome::Skipped;
				}
				FileOutcome::Searched(FileSearchResult {
					relative_path: entry.relative_path.clone(),
					matches: search.matches,
					match_count: search.match_count,
					limit_reached: search.limit_reached,
				})
			},
		)
		.collect();

	let mut results = Vec::new();
	let mut files_skipped = 0u32;
	let mut stopped = false;
	let mut failures = Vec::new();
	for outcome in outcomes {
		match outcome {
			FileOutcome::Searched(result) => results.push(result),
			FileOutcome::Skipped => files_skipped = files_skipped.saturating_add(1),
			FileOutcome::Failed(failure) => {
				files_skipped = files_skipped.saturating_add(1);
				failures.push(failure);
			}
			FileOutcome::Stopped => stopped = true,
		}
	}
	results.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
	(results, files_skipped, stopped, failures)
}

/// Fold per-file results (path order) into the final match list, applying the
/// global offset and limit in matching lines (content) or files (files mode).
/// In tail mode the limit keeps
/// the LAST `max_count` matches of the concatenation instead of the first
/// (each file already kept only its own tail, which preserves the global
/// tail exactly).
fn aggregate_file_results(
	results: Vec<FileSearchResult>,
	mode: OutputMode,
	max_count: Option<u64>,
	offset: u64,
	tail: bool,
) -> (Vec<GrepMatch>, u64, u32, bool) {
	let mut matches = Vec::new();
	let mut total_matches = 0u64;
	let mut files_with_matches = 0u32;
	let mut collected = 0u64;
	let mut remaining_offset = offset;
	let mut limit_reached = false;

	for result in results {
		if result.match_count == 0 {
			continue;
		}
		files_with_matches = files_with_matches.saturating_add(1);
		total_matches = total_matches.saturating_add(result.match_count);
		if result.limit_reached {
			limit_reached = true;
		}
		if max_count.is_some_and(|max| collected >= max) {
			limit_reached = true;
			continue;
		}

		match mode {
			OutputMode::Content if tail => {
				for matched in result.matches {
					matches.push(to_grep_match(&result.relative_path, matched));
				}
			}
			OutputMode::Content | OutputMode::FilesWithMatches => {
				for matched in result.matches {
					if remaining_offset > 0 {
						remaining_offset -= 1;
						continue;
					}
					if max_count.is_some_and(|max| collected >= max) {
						limit_reached = true;
						break;
					}
					matches.push(to_grep_match(&result.relative_path, matched));
					collected += 1;
				}
			}
			OutputMode::Count => {
				matches.push(GrepMatch {
					path: result.relative_path.clone(),
					line_number: 0,
					line: String::new(),
					context_before: None,
					context_after: None,
					truncated: None,
					match_count: Some(clamp_u32(result.match_count)),
				});
			}
		}
	}

	if tail {
		if let Some(max) = max_count {
			let max = max as usize;
			if matches.len() > max {
				matches.drain(..matches.len() - max);
			}
		}
		limit_reached = total_matches > matches.len() as u64;
	}

	(matches, total_matches, files_with_matches, limit_reached)
}

// ---------------------------------------------------------------------------
// Sync entry point
// ---------------------------------------------------------------------------

fn grep_sync(options: GrepOptions, budget: &SearchBudget) -> Result<GrepResult> {
	let search_path = resolve_search_path(&options.path)?;
	let metadata = std::fs::metadata(&search_path)
		.map_err(|err| Error::from_reason(format!("Path not found: {err}")))?;
	let ignore_case = options.ignore_case.unwrap_or(false);
	let multiline = options.multiline.unwrap_or(false);
	match options.engine.as_deref().unwrap_or("default") {
		"default" => {
			let matcher = build_matcher(&options.pattern, ignore_case, multiline)?;
			grep_with_matcher(options, budget, search_path, metadata, &matcher)
		}
		"pcre2" => {
			let matcher = build_pcre2_matcher(&options.pattern, ignore_case, multiline, budget)?;
			grep_with_matcher(options, budget, search_path, metadata, &matcher)
		}
		engine => Err(Error::from_reason(format!("Unknown regex engine: {engine}"))),
	}
}

fn grep_with_matcher<M: SearchMatcher + Sync>(
	options: GrepOptions,
	budget: &SearchBudget,
	search_path: PathBuf,
	metadata: std::fs::Metadata,
	matcher: &M,
) -> Result<GrepResult> {
	let multiline = options.multiline.unwrap_or(false);
	let output_mode = parse_output_mode(options.mode.as_deref());
	let (context_before, context_after) =
		resolve_context(options.context, options.context_before, options.context_after)?;
	let (context_before, context_after) = if output_mode == OutputMode::Content {
		(context_before, context_after)
	} else {
		(0, 0)
	};
	let max_columns = options.max_columns;
	let max_count = if output_mode == OutputMode::Count {
		None
	} else {
		options.max_count.map(u64::from)
	};
	let tail = output_mode == OutputMode::Content && options.tail.unwrap_or(false);
	// Tail keeps the last matches; skipping leading matches has no meaning there.
	let offset = if tail || output_mode == OutputMode::Count {
		0
	} else {
		options.offset.unwrap_or(0) as u64
	};
	let include_hidden = options.hidden.unwrap_or(true);
	let glob_set = glob_util::try_compile_glob(options.glob.as_deref(), true)?;
	let exclude_set = glob_util::compile_glob_set(options.exclude_globs.as_deref())?;
	let type_filter = resolve_type_filter(options.type_filter.as_deref());

	let params = SearchParams {
		context_before,
		context_after,
		max_columns,
		mode: output_mode,
		max_count,
		offset,
		tail,
		multiline,
	};
	let mut searcher = build_searcher(multiline);

	if !metadata.is_file() && !metadata.is_dir() {
		return Ok(GrepResult::empty());
	}

	if metadata.is_file() {
		if let Some(filter) = type_filter.as_ref() {
			if !matches_type_filter(&search_path, filter) {
				return Ok(GrepResult::empty());
			}
		}

		let bytes = match read_file_bytes(&search_path) {
			FileReadOutcome::Bytes(b) => b,
			FileReadOutcome::Skipped(reason) => {
				return Ok(GrepResult {
					files_skipped: 1,
					skip_reason: Some(reason.as_str().to_string()),
					..GrepResult::empty()
				});
			}
		};

		let search = run_search(&mut searcher, matcher, bytes.as_slice(), params, Some(budget))
			.map_err(|err| {
				if err.kind() == io::ErrorKind::TimedOut {
					budget.stop_error()
				} else {
					Error::from_reason(format!("Search failed: {err}"))
				}
			})?;

		if search.binary {
			return Ok(GrepResult {
				files_skipped: 1,
				skip_reason: Some(SkipReason::Binary.as_str().to_string()),
				..GrepResult::empty()
			});
		}

		if search.match_count == 0 {
			return Ok(GrepResult {
				files_searched: 1,
				..GrepResult::empty()
			});
		}

		let path_string = search_path.to_string_lossy().into_owned();
		// Content has already applied its line window in the sink. Files mode
		// applies its file window here, through the same aggregator as directories.
		let (aggregate_max, aggregate_offset) = if output_mode == OutputMode::Content {
			(None, 0)
		} else {
			(max_count, offset)
		};
		let content_limit = output_mode == OutputMode::Content
			&& max_count.is_some_and(|max| search.collected >= max);
		let (matches, total_matches, files_with_matches, limit_reached) = aggregate_file_results(
			vec![FileSearchResult {
				relative_path: path_string,
				matches: search.matches,
				match_count: search.match_count,
				limit_reached: search.limit_reached,
			}],
			output_mode,
			aggregate_max,
			aggregate_offset,
			false,
		);
		let limit_reached = limit_reached || content_limit;

		return Ok(GrepResult {
			matches,
			total_matches: clamp_u32(total_matches),
			files_with_matches,
			files_searched: 1,
			files_skipped: 0,
			search_failures: None,
			skip_reason: None,
			traversal_issues: 0,
			entry_limit_reached: None,
			pruned_directories: None,
			limit_reached: if limit_reached { Some(true) } else { None },
		});
	}

	// Directory search: walk and collect files under the same single budget
	// that bounds the scan.
	let protected_roots: Vec<PathBuf> = options
		.protected_traversal_roots
		.as_deref()
		.unwrap_or_default()
		.iter()
		.map(PathBuf::from)
		.collect();
	let walk = fs_walk::walk_directory(
		&search_path,
		&fs_walk::WalkOptions {
			include_hidden,
			ignore: fs_walk::IgnoreRules::Directories,
			max_depth: None,
			exclude: exclude_set.as_ref(),
			protected_roots: &protected_roots,
		},
		budget,
	);
	if walk.stopped {
		return Err(budget.stop_error());
	}
	let pruned_directories = (!walk.pruned.is_empty()).then_some(walk.pruned);
	let entries = collect_files(
		&search_path,
		&walk.entries,
		glob_set.as_ref(),
		type_filter.as_ref(),
	);

	if entries.is_empty() {
		return Ok(GrepResult {
			traversal_issues: walk.traversal_issues,
			entry_limit_reached: walk.entry_limit_reached.then_some(true),
			pruned_directories,
			..GrepResult::empty()
		});
	}

	let (results, files_skipped, scan_stopped, search_failures) =
		run_parallel_search(&entries, matcher, params, budget);
	if scan_stopped {
		return Err(budget.stop_error());
	}
	let files_searched = clamp_u32(results.len() as u64);
	let (matches, total_matches, files_with_matches, limit_reached) =
		aggregate_file_results(results, output_mode, max_count, offset, tail);

	Ok(GrepResult {
		matches,
		total_matches: clamp_u32(total_matches),
		files_with_matches,
		files_searched,
		files_skipped,
		search_failures: if search_failures.is_empty() { None } else { Some(search_failures) },
		skip_reason: None,
		traversal_issues: walk.traversal_issues,
		entry_limit_reached: walk.entry_limit_reached.then_some(true),
		pruned_directories,
		limit_reached: if limit_reached { Some(true) } else { None },
	})
}
/// Search files for a regex pattern on crate-owned threads (see
/// [`fs_worker::run_request`]), never on the JS event loop.
///
/// `signal` aborts cooperatively: the promise rejects at once, and the budget
/// it cancels stops the native scan at the next checkpoint.
#[napi(js_name = "grep")]
pub fn grep<'env>(env: &'env Env, options: GrepOptions, signal: Option<AbortSignal>) -> Result<Object<'env>> {
	let budget = SearchBudget::new(
		Some(Duration::from_millis(u64::from(options.cpu_limit_ms))),
		Duration::from_millis(u64::from(options.timeout_ms)),
	);
	fs_worker::run_request(env, "grep", budget, signal, move |budget| grep_sync(options, budget))
}

#[cfg(test)]
mod context_tests {
	use super::*;

	#[test]
	fn context_is_bounded_at_the_native_boundary() {
		assert_eq!(resolve_context(Some(100), None, None).unwrap(), (100, 100));
		assert!(resolve_context(Some(101), None, None).is_err());
		assert!(resolve_context(None, Some(101), None).is_err());
		assert!(resolve_context(None, None, Some(101)).is_err());
	}
}

#[cfg(test)]
mod engine_tests {
	use std::time::Instant;

	use super::*;

	fn test_budget() -> SearchBudget {
		SearchBudget::new(None, Duration::from_secs(10))
	}

	#[test]
	fn pcre2_stops_before_an_expensive_nonmatch_after_the_requested_match() {
		let content = format!("foo\n{}!\n", "a".repeat(28));
		let budget = test_budget();
		for multiline in [false, true] {
			let matcher = build_pcre2_matcher(r"foo|(?=a)(a+)+$", false, multiline, &budget).unwrap();
			for mode in [OutputMode::FilesWithMatches, OutputMode::Content, OutputMode::Count] {
				let params = SearchParams {
					context_before: 0, context_after: 0, max_columns: None,
					mode, max_count: Some(1), offset: 0, tail: false, multiline,
				};
				let result = run_search(
					&mut build_searcher(multiline), &matcher, content.as_bytes(), params, Some(&budget),
				);
				if mode == OutputMode::Count {
					assert!(result.is_err_and(|err| err.to_string().contains("match limit exceeded")));
				} else {
					let result = result.unwrap();
					assert_eq!(result.match_count, 1);
					assert_eq!(result.matches.len(), 1);
					assert_eq!(result.matches[0].line, "foo");
				}
			}
		}
	}

	#[test]
	fn pcre2_observes_the_budget_during_a_single_match() {
		let content = format!("{}!\n", "a".repeat(4_000));
		let params = SearchParams {
			context_before: 0, context_after: 0, max_columns: None,
			mode: OutputMode::Content, max_count: Some(1), offset: 0,
			tail: false, multiline: false,
		};
		let budget = SearchBudget::new(None, Duration::from_millis(1));
		let matcher = build_pcre2_matcher(r"(?=a)a+(?<!a)", false, false, &budget).unwrap();
		let start = Instant::now();
		let result = run_search(
			&mut build_searcher(false), &matcher, content.as_bytes(), params, Some(&budget),
		);
		assert!(result.is_err_and(|err| err.kind() == io::ErrorKind::TimedOut));
		assert!(start.elapsed() < Duration::from_millis(100));
	}

	#[test]
	fn pcre2_observes_cancellation_during_a_single_match() {
		let content = format!("{}!\n", "a".repeat(150_000));
		let budget = test_budget();
		let matcher = build_pcre2_matcher(r"(?=a)a+(?<!a)", false, false, &budget).unwrap();
		std::thread::scope(|scope| {
			scope.spawn(|| {
				std::thread::sleep(Duration::from_millis(2));
				budget.cancel();
			});
			let start = Instant::now();
			let result = matcher.find(content.as_bytes());
			assert!(result.is_err_and(|err| err.kind() == io::ErrorKind::TimedOut));
			assert!(start.elapsed() < Duration::from_millis(100));
		});
	}

	#[test]
	fn directory_search_retains_matches_and_reports_pcre2_match_limit_failures() {
		let root = std::env::temp_dir().join(format!(
			"flywheel-pcre2-{}-{}",
			std::process::id(),
			std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
		));
		std::fs::create_dir(&root).unwrap();
		let result = (|| {
			std::fs::write(root.join("bad.txt"), format!("{}!\n", "a".repeat(28)))?;
			std::fs::write(root.join("good.txt"), "aaaa\n")?;
			grep_sync(GrepOptions {
				pattern: "(a+)+$".into(),
				engine: Some("pcre2".into()),
				path: root.to_string_lossy().into_owned(),
				mode: Some("count".into()),
				glob: None,
				type_filter: None,
				ignore_case: None,
				multiline: None,
				hidden: None,
				exclude_globs: None,
				protected_traversal_roots: None,
				max_count: None,
				offset: None,
				tail: None,
				context_before: None,
				context_after: None,
				context: None,
				max_columns: None,
				cpu_limit_ms: 10_000,
				timeout_ms: 10_000,
			}, &test_budget())
		})();
		std::fs::remove_dir_all(root).unwrap();
		let result = result.unwrap();
		assert_eq!(result.total_matches, 1);
		assert_eq!(result.matches[0].path, "good.txt");
		assert_eq!(result.matches[0].match_count, Some(1));
		assert_eq!(result.files_skipped, 1);
		let failures = result.search_failures.unwrap();
		assert_eq!(failures.len(), 1);
		assert_eq!(failures[0].path, "bad.txt");
		assert!(failures[0].reason.contains("match limit exceeded"));
	}

	#[test]
	fn pcre2_supports_lookaround_and_backreferences_while_default_refuses_them() {
		let params = SearchParams {
			context_before: 1,
			context_after: 1,
			max_columns: None,
			mode: OutputMode::Content,
			max_count: None,
			offset: 0,
			tail: false,
			multiline: false,
		};
		for (pattern, content, expected_line) in [
			(r"(?<!x)foo", "xfoo\nFOO\nend\n", "FOO"),
			(r"foo(?=bar)", "foo baz\nFOObar\nend\n", "FOObar"),
			(r"(\w+)\s+\1", "café tea\nCAFÉ café\nend\n", "CAFÉ café"),
		] {
			assert!(build_matcher(pattern, true, false).is_err());
			let matcher = build_pcre2_matcher(pattern, true, false, &test_budget()).unwrap();
			let result = run_search(
				&mut build_searcher(false), &matcher, content.as_bytes(), params, None,
			).unwrap();
			assert_eq!(result.match_count, 1);
			assert_eq!(result.matches[0].line_number, 2);
			assert_eq!(result.matches[0].line, expected_line);
			assert_eq!(result.matches[0].context_before[0].line_number, 1);
			assert_eq!(result.matches[0].context_after[0].line_number, 3);
		}
	}
}

#[cfg(test)]
mod files_mode_tests {
	use super::*;

	#[test]
	fn files_mode_stops_at_first_match_even_across_segments() {
		let params = SearchParams {
			context_before: 0,
			context_after: 0,
			max_columns: None,
			mode: parse_output_mode(Some("filesWithMatches")),
			max_count: Some(5),
			offset: 0,
			tail: false,
			multiline: false,
		};
		let matcher = build_matcher("needle", false, false).unwrap();
		let mut content = b"// heading\nexport function needle() {}\n".to_vec();
		content.extend("needle();\n".repeat(20).bytes());
		content.resize(SEGMENT_SIZE + 1, b'\n');
		content.extend_from_slice(b"needle();\n");
		let result = run_search(&mut build_searcher(false), &matcher, &content, params, None).unwrap();
		assert_eq!(result.match_count, 1);
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].line_number, 2);
		assert_eq!(result.matches[0].line, "export function needle() {}");
		assert!(!result.limit_reached);
	}

	#[test]
	fn multiline_files_mode_keeps_one_representative_line() {
		let params = SearchParams {
			context_before: 2,
			context_after: 2,
			max_columns: None,
			mode: parse_output_mode(Some("filesWithMatches")),
			max_count: None,
			offset: 0,
			tail: false,
			multiline: true,
		};
		let matcher = build_matcher(r"export function needle\(\) \{\n\}", false, true).unwrap();
		let content = b"// heading\nexport function needle() {\n}\nexport function needle() {\n}\n";
		let result = run_search(&mut build_searcher(true), &matcher, content, params, None).unwrap();
		assert_eq!(result.match_count, 1);
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].line, "export function needle() {");
		assert_eq!(result.matches[0].line_number, 2);
		assert!(result.matches[0].context_before.is_empty());
		assert!(result.matches[0].context_after.is_empty());
	}
}
