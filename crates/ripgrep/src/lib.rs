//! Native ripgrep search engine for Flywheel.
//!
//! Exposes `grep()`, `listFiles()`, and `prunedDirectoryOnPath()` via N-API.

mod budget;
mod fs_walk;
mod fs_worker;
mod glob_util;
mod ignored_dirs;
pub mod grep;
pub mod list;
