//! Which directories the repository's ignore rules exclude.
//!
//! A walk that prunes ignored directories must still yield the ignored files
//! of the directories it enters, which the `ignore` crate's walker cannot do:
//! it drops ignored files and directories alike. This oracle answers for one
//! directory with the walker's own precedence. The nearest `.gitignore` with a
//! decision wins, from the directory's parent up to the repository root (the
//! nearest ancestor that holds `.git` or `.jj`); then the repository's
//! `info/exclude`; then the global excludes file. Outside a repository nothing
//! is ignored.

use std::{
	collections::HashMap,
	fs::File,
	io::{BufRead, BufReader},
	path::{Path, PathBuf},
	sync::{Arc, Mutex},
};

use ignore::{
	Match,
	gitignore::{Gitignore, GitignoreBuilder},
};

/// The ignore rules that one directory contributes.
struct Level {
	gitignore: Gitignore,
	/// The `info/exclude` rules when this directory is a repository root.
	repository: Option<Gitignore>,
}

pub(crate) struct IgnoredDirectories {
	levels: Mutex<HashMap<PathBuf, Arc<Level>>>,
	global: Gitignore,
}

fn decision<T>(matched: Match<T>) -> Option<bool> {
	match matched {
		Match::None => None,
		Match::Ignore(_) => Some(true),
		Match::Whitelist(_) => Some(false),
	}
}

impl IgnoredDirectories {
	pub(crate) fn new() -> Self {
		Self { levels: Mutex::new(HashMap::new()), global: Gitignore::global().0 }
	}

	/// Whether the repository's ignore rules exclude the directory `dir`.
	pub(crate) fn contains(&self, dir: &Path) -> bool {
		let mut nearest = None;
		for ancestor in dir.ancestors().skip(1) {
			let level = self.level(ancestor);
			nearest = nearest.or_else(|| decision(level.gitignore.matched(dir, true)));
			if let Some(exclude) = &level.repository {
				return nearest
					.or_else(|| decision(exclude.matched(dir, true)))
					.or_else(|| decision(self.global.matched(dir, true)))
					.unwrap_or(false);
			}
		}
		false
	}

	fn level(&self, dir: &Path) -> Arc<Level> {
		let mut levels = self.levels.lock().unwrap_or_else(|error| error.into_inner());
		levels.entry(dir.to_path_buf()).or_insert_with(|| Arc::new(load_level(dir))).clone()
	}
}

fn load_level(dir: &Path) -> Level {
	let gitignore = Gitignore::new(dir.join(".gitignore")).0;
	let git = dir.join(".git");
	let repository = match git.metadata() {
		Ok(metadata) => Some(exclude_rules(dir, &common_git_dir(&git, metadata.is_file()))),
		Err(_) if dir.join(".jj").exists() => Some(Gitignore::empty()),
		Err(_) => None,
	};
	Level { gitignore, repository }
}

fn exclude_rules(dir: &Path, git_dir: &Option<PathBuf>) -> Gitignore {
	let Some(git_dir) = git_dir else { return Gitignore::empty() };
	let mut builder = GitignoreBuilder::new(dir);
	// A missing exclude file is the common case and holds no rules.
	let _ = builder.add(git_dir.join("info/exclude"));
	builder.build().unwrap_or_else(|_| Gitignore::empty())
}

/// The repository's common git directory, which holds `info/exclude`. A
/// `.git` file names the git directory, relative to the file's own directory
/// or absolute: a submodule's or a `--separate-git-dir` repository's own,
/// or a linked worktree's, whose `commondir` names the shared one.
fn common_git_dir(git: &Path, is_file: bool) -> Option<PathBuf> {
	if !is_file {
		return Some(git.to_path_buf());
	}
	let first_line = |path: &Path| BufReader::new(File::open(path).ok()?).lines().next()?.ok();
	let git_dir = git.parent()?.join(first_line(git)?.strip_prefix("gitdir: ")?);
	Some(match first_line(&git_dir.join("commondir")) {
		Some(common) => git_dir.join(common),
		None => git_dir,
	})
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;

	#[test]
	fn nearest_rule_wins_and_rules_need_a_repository() {
		let root = std::env::temp_dir().join(format!("flywheel-ignored-dirs-{}", std::process::id()));
		let _ = fs::remove_dir_all(&root);
		let repo = root.join("repo");
		for dir in ["results", "bench/results", "bench/kept", "logs"] {
			fs::create_dir_all(repo.join(dir)).unwrap();
		}
		fs::create_dir_all(repo.join(".git/info")).unwrap();
		fs::write(repo.join(".gitignore"), "results/\nkept/\n").unwrap();
		fs::write(repo.join("bench/.gitignore"), "!kept/\n").unwrap();
		fs::write(repo.join(".git/info/exclude"), "/logs/\n").unwrap();
		fs::create_dir_all(root.join("plain/results")).unwrap();
		fs::write(root.join("plain/.gitignore"), "results/\n").unwrap();

		let ignored = IgnoredDirectories::new();
		assert!(ignored.contains(&repo.join("results")));
		assert!(ignored.contains(&repo.join("bench/results")));
		assert!(!ignored.contains(&repo.join("bench/kept")));
		assert!(ignored.contains(&repo.join("logs")));
		assert!(!ignored.contains(&repo.join("bench")));
		assert!(!ignored.contains(&root.join("plain/results")));
		fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn a_git_file_names_the_directory_that_holds_the_exclude_rules() {
		let root = std::env::temp_dir().join(format!("flywheel-git-file-{}", std::process::id()));
		let _ = fs::remove_dir_all(&root);
		// A submodule: a relative gitdir, no commondir.
		let submodule = root.join("super/sub");
		fs::create_dir_all(submodule.join("logs")).unwrap();
		fs::create_dir_all(root.join("super/.git/modules/sub/info")).unwrap();
		fs::write(submodule.join(".git"), "gitdir: ../.git/modules/sub\n").unwrap();
		fs::write(root.join("super/.git/modules/sub/info/exclude"), "/logs/\n").unwrap();
		// A linked worktree: an absolute gitdir whose commondir is relative.
		let worktree = root.join("worktree");
		let main_git = root.join("main/.git");
		fs::create_dir_all(worktree.join("logs")).unwrap();
		fs::create_dir_all(main_git.join("worktrees/w")).unwrap();
		fs::create_dir_all(main_git.join("info")).unwrap();
		fs::write(worktree.join(".git"), format!("gitdir: {}\n", main_git.join("worktrees/w").display())).unwrap();
		fs::write(main_git.join("worktrees/w/commondir"), "../..\n").unwrap();
		fs::write(main_git.join("info/exclude"), "/logs/\n").unwrap();

		let ignored = IgnoredDirectories::new();
		assert!(ignored.contains(&submodule.join("logs")));
		assert!(ignored.contains(&worktree.join("logs")));
		fs::remove_dir_all(root).unwrap();
	}
}
