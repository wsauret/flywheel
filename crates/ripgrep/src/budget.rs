//! The limits of one search or listing: processor time summed across every
//! thread that works on it, a wall-clock limit, and cancellation.
//!
//! The caller passes both limits; this crate holds no default for either.
//! Processor time is read from each thread's own CPU clock, so time a
//! thread spends waiting for admission, for a turn on a loaded machine, or
//! for a read does not count. A thread that works on a search holds a
//! [`Work`] guard; checkpoints charge its CPU time since the last charge.

use std::{
	cell::Cell,
	sync::{
		Arc,
		atomic::{AtomicU8, AtomicU64, Ordering},
	},
	time::{Duration, Instant},
};

use napi::Error;

/// Rejection reason for a search or listing that reached its processor-time
/// limit. The TypeScript wrapper matches this exact text.
pub(crate) const CPU_LIMIT_REASON: &str = "stopped at the processing time limit";
/// Rejection reason for a search or listing that reached its wall-clock
/// limit. The TypeScript wrapper matches this exact text.
pub(crate) const WALL_LIMIT_REASON: &str = "stopped at the wall time limit";

const RUNNING: u8 = 0;
const CANCELLED: u8 = 1;
const CPU_LIMIT: u8 = 2;
const WALL_LIMIT: u8 = 3;

/// Checkpoints run far more often than this (the PCRE2 callout fires per
/// pattern step); reading a thread CPU clock costs a system call on some
/// platforms, so a thread charges at most once per interval.
const CHARGE_INTERVAL: Duration = Duration::from_millis(1);

struct Account {
	state: AtomicU8,
	cpu_used_ns: AtomicU64,
	cpu_limit_ns: Option<u64>,
	wall_deadline: Instant,
}

/// Cooperative stop condition shared by every thread of one search.
#[derive(Clone)]
pub(crate) struct SearchBudget(Arc<Account>);

#[derive(Clone, Copy)]
struct Sample {
	account: *const Account,
	cpu_ns: u64,
	at: Instant,
}

thread_local! {
	/// The search this thread works on, and its CPU clock at the last charge.
	static METER: Cell<Option<Sample>> = const { Cell::new(None) };
}

/// Marks the current thread as working on one search until dropped, then
/// charges the CPU time it spent since its last charge.
pub(crate) struct Work<'a> {
	budget: &'a SearchBudget,
}

impl Drop for Work<'_> {
	fn drop(&mut self) {
		self.budget.charge(Instant::now(), true);
		METER.with(|meter| meter.set(None));
	}
}

impl SearchBudget {
	/// `cpu_limit` of `None` sets no processor-time limit.
	pub(crate) fn new(cpu_limit: Option<Duration>, wall_limit: Duration) -> Self {
		Self(Arc::new(Account {
			state: AtomicU8::new(RUNNING),
			cpu_used_ns: AtomicU64::new(0),
			cpu_limit_ns: cpu_limit.map(|limit| u64::try_from(limit.as_nanos()).unwrap_or(u64::MAX)),
			wall_deadline: Instant::now() + wall_limit,
		}))
	}

	pub(crate) fn wall_deadline(&self) -> Instant {
		self.0.wall_deadline
	}

	/// Starts charging the current thread's CPU time to this search.
	pub(crate) fn work(&self) -> Work<'_> {
		if self.0.cpu_limit_ns.is_some() {
			let sample = Sample { account: Arc::as_ptr(&self.0), cpu_ns: thread_cpu_ns(), at: Instant::now() };
			METER.with(|meter| meter.set(Some(sample)));
		}
		Work { budget: self }
	}

	pub(crate) fn cancel(&self) {
		self.settle(CANCELLED);
	}

	/// Records that the wall-clock limit expired, unless another stop came first.
	pub(crate) fn expire(&self) {
		self.settle(WALL_LIMIT);
	}

	/// Whether the search must stop: it was cancelled or reached a limit.
	pub(crate) fn stop(&self) -> bool {
		if self.0.state.load(Ordering::Relaxed) != RUNNING {
			return true;
		}
		let now = Instant::now();
		if now >= self.0.wall_deadline {
			self.settle(WALL_LIMIT);
			return true;
		}
		let Some(limit) = self.0.cpu_limit_ns else { return false };
		self.charge(now, false);
		if self.0.cpu_used_ns.load(Ordering::Relaxed) >= limit {
			self.settle(CPU_LIMIT);
			return true;
		}
		false
	}

	/// The rejection for a stopped search, naming the first stop that occurred.
	pub(crate) fn stop_error(&self) -> Error {
		Error::from_reason(match self.0.state.load(Ordering::Relaxed) {
			CPU_LIMIT => CPU_LIMIT_REASON,
			WALL_LIMIT => WALL_LIMIT_REASON,
			_ => "search aborted",
		})
	}

	fn settle(&self, reason: u8) {
		let _ = self.0.state.compare_exchange(RUNNING, reason, Ordering::Relaxed, Ordering::Relaxed);
	}

	fn charge(&self, now: Instant, force: bool) {
		METER.with(|meter| {
			let Some(sample) = meter.get() else { return };
			if sample.account != Arc::as_ptr(&self.0) || (!force && now.duration_since(sample.at) < CHARGE_INTERVAL) {
				return;
			}
			let cpu_ns = thread_cpu_ns();
			self.0.cpu_used_ns.fetch_add(cpu_ns.saturating_sub(sample.cpu_ns), Ordering::Relaxed);
			meter.set(Some(Sample { cpu_ns, at: now, ..sample }));
		});
	}
}

/// The current thread's CPU time (user and system) in nanoseconds.
#[cfg(unix)]
fn thread_cpu_ns() -> u64 {
	let mut time = libc::timespec { tv_sec: 0, tv_nsec: 0 };
	// SAFETY: `time` is a valid out-pointer; the thread CPU clock exists on
	// every supported Unix (Linux, and macOS 10.12 and later).
	let status = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut time) };
	if status != 0 {
		return 0;
	}
	u64::try_from(time.tv_sec).unwrap_or(0) * 1_000_000_000 + u64::try_from(time.tv_nsec).unwrap_or(0)
}

/// The current thread's CPU time (user and kernel) in nanoseconds.
#[cfg(windows)]
fn thread_cpu_ns() -> u64 {
	use windows_sys::Win32::{
		Foundation::FILETIME,
		System::Threading::{GetCurrentThread, GetThreadTimes},
	};
	let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
	let (mut creation, mut exit, mut kernel, mut user) = (zero, zero, zero, zero);
	// SAFETY: the pseudo handle names the calling thread; every out-pointer is valid.
	let ok = unsafe { GetThreadTimes(GetCurrentThread(), &mut creation, &mut exit, &mut kernel, &mut user) };
	if ok == 0 {
		return 0;
	}
	let hundreds = |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
	(hundreds(kernel) + hundreds(user)) * 100
}

#[cfg(test)]
mod tests {
	use super::*;

	fn spin(duration: Duration) {
		let start = thread_cpu_ns();
		while thread_cpu_ns() - start < u64::try_from(duration.as_nanos()).unwrap() {
			std::hint::black_box(());
		}
	}

	#[test]
	fn waiting_does_not_count_toward_the_cpu_limit() {
		let budget = SearchBudget::new(Some(Duration::from_millis(20)), Duration::from_secs(10));
		let _work = budget.work();
		std::thread::sleep(Duration::from_millis(60));
		assert!(!budget.stop());
	}

	#[test]
	fn cpu_time_of_every_working_thread_adds_up_to_the_limit() {
		let budget = SearchBudget::new(Some(Duration::from_millis(40)), Duration::from_secs(10));
		std::thread::scope(|scope| {
			for _ in 0..2 {
				scope.spawn(|| {
					let _work = budget.work();
					spin(Duration::from_millis(25));
				});
			}
		});
		// Neither thread alone reached 40 ms; their sum did.
		assert!(budget.stop());
		assert_eq!(budget.stop_error().reason, CPU_LIMIT_REASON);
	}

	#[test]
	fn the_wall_limit_stops_a_search_that_spends_no_cpu_time() {
		let budget = SearchBudget::new(Some(Duration::from_secs(10)), Duration::from_millis(20));
		let _work = budget.work();
		std::thread::sleep(Duration::from_millis(30));
		assert!(budget.stop());
		assert_eq!(budget.stop_error().reason, WALL_LIMIT_REASON);
	}

	#[test]
	fn the_first_stop_names_the_reason() {
		let budget = SearchBudget::new(None, Duration::from_millis(0));
		budget.cancel();
		assert!(budget.stop());
		assert_eq!(budget.stop_error().reason, "search aborted");
	}
}
