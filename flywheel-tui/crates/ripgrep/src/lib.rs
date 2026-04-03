//! Native ripgrep search engine for Flywheel.
//!
//! Exposes `search()`, `hasMatch()`, and `grep()` via N-API.

mod fs_walk;
mod glob_util;
pub mod grep;
