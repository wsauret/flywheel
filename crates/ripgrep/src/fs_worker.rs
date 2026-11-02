//! Shared owner for detached native filesystem workers, and the one way a
//! native search or listing runs: on crate-owned threads that settle its
//! promise, so a call waiting for a worker holds no N-API pool thread.

use std::{
	sync::{Arc, Condvar, Mutex, OnceLock, mpsc},
	time::Instant,
};

use napi::{
	Env, Error, Result,
	bindgen_prelude::{AbortSignal, Object, ToNapiValue},
	JsDeferred,
};

use crate::budget::SearchBudget;

const MAX_FILESYSTEM_WORKERS: usize = 4;

/// Rejection reason for a request that found no free worker before its
/// wall-clock limit. The TypeScript wrapper matches this exact text.
const NO_WORKER_REASON: &str = "found no free search worker before the wall time limit";

struct WorkerState {
	active: usize,
	capacity: usize,
}

pub(crate) struct FilesystemWorkerOwner {
	state: Mutex<WorkerState>,
	available: Condvar,
}

pub(crate) struct WorkerPermit {
	owner: Arc<FilesystemWorkerOwner>,
}

impl Drop for WorkerPermit {
	fn drop(&mut self) {
		let mut state = self.owner.state.lock().unwrap_or_else(|error| error.into_inner());
		state.active -= 1;
		self.owner.available.notify_one();
	}
}

impl FilesystemWorkerOwner {
	fn new(capacity: usize) -> Arc<Self> {
		Arc::new(Self {
			state: Mutex::new(WorkerState { active: 0, capacity }),
			available: Condvar::new(),
		})
	}

	/// Waits for a free worker until `budget` stops: it is cancelled or its
	/// wall-clock limit passes. A cancel reaches a waiter only through
	/// [`Self::wake_waiters`].
	pub(crate) fn acquire(self: &Arc<Self>, budget: &SearchBudget) -> Option<WorkerPermit> {
		let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
		loop {
			if budget.stop() {
				// A permit release wakes one waiter. When that wake reached this
				// stopped waiter, pass it on so the free worker is not stranded.
				if state.active < state.capacity {
					self.available.notify_one();
				}
				return None;
			}
			if state.active < state.capacity {
				state.active += 1;
				return Some(WorkerPermit { owner: self.clone() });
			}
			let remaining = budget.wall_deadline().saturating_duration_since(Instant::now());
			state = self.available.wait_timeout(state, remaining).unwrap_or_else(|error| error.into_inner()).0;
		}
	}

	/// Wakes every waiter so that a cancelled one leaves the queue at once.
	/// Taking the lock orders the wake after a waiter's check of its budget,
	/// so a cancel that lands between the check and the wait is not lost.
	fn wake_waiters(&self) {
		let _state = self.state.lock().unwrap_or_else(|error| error.into_inner());
		self.available.notify_all();
	}
}

fn filesystem_worker_owner() -> &'static Arc<FilesystemWorkerOwner> {
	static OWNER: OnceLock<Arc<FilesystemWorkerOwner>> = OnceLock::new();
	OWNER.get_or_init(|| FilesystemWorkerOwner::new(MAX_FILESYSTEM_WORKERS))
}

type Resolve<T> = Box<dyn FnOnce(Env) -> Result<T> + Send>;
/// The promise of one request; the first of result, wall limit, and abort
/// takes it and settles it.
type Settlement<T> = Arc<Mutex<Option<JsDeferred<T, Resolve<T>>>>>;

fn settle<T: ToNapiValue + Send + 'static>(settlement: &Settlement<T>, result: Result<T>) {
	let Some(deferred) = settlement.lock().unwrap_or_else(|error| error.into_inner()).take() else { return };
	match result {
		Ok(value) => deferred.resolve(Box::new(move |_| Ok(value))),
		Err(error) => deferred.reject(error),
	}
}

/// Runs `work` under `budget` and returns its promise. A crate-owned
/// supervisor thread waits for a worker permit and then for the worker's
/// result, both at most until the budget's wall-clock limit, which is HARD:
/// when it fires, the promise rejects even if the worker is wedged in an
/// uninterruptible read, and the settled budget makes the orphaned worker
/// exit at its next checkpoint. An abort cancels the budget and rejects the
/// promise at once, also while the request still waits for a worker.
pub(crate) fn run_request<'env, T, W>(
	env: &'env Env,
	name: &'static str,
	budget: SearchBudget,
	signal: Option<AbortSignal>,
	work: W,
) -> Result<Object<'env>>
where
	T: ToNapiValue + Send + 'static,
	W: FnOnce(&SearchBudget) -> Result<T> + Send + 'static,
{
	let (deferred, promise) = env.create_deferred::<T, Resolve<T>>()?;
	let settlement: Settlement<T> = Arc::new(Mutex::new(Some(deferred)));
	if let Some(signal) = signal {
		let (budget, settlement) = (budget.clone(), settlement.clone());
		signal.on_abort(move || {
			budget.cancel();
			filesystem_worker_owner().wake_waiters();
			settle(&settlement, Err(budget.stop_error()));
		});
	}
	let supervised = settlement.clone();
	let spawned = std::thread::Builder::new()
		.name(format!("flywheel-{name}-supervisor"))
		.spawn(move || settle(&supervised, supervise(name, budget, work)));
	if let Err(err) = spawned {
		settle(&settlement, Err(Error::from_reason(format!("Failed to spawn {name} supervisor: {err}"))));
	}
	Ok(promise)
}

fn supervise<T, W>(name: &'static str, budget: SearchBudget, work: W) -> Result<T>
where
	T: Send + 'static,
	W: FnOnce(&SearchBudget) -> Result<T> + Send + 'static,
{
	if budget.stop() {
		return Err(budget.stop_error());
	}
	let Some(permit) = filesystem_worker_owner().acquire(&budget) else {
		// A cancel already settled the promise, so only a wall limit that
		// passed while every worker was busy reaches here.
		return Err(Error::from_reason(NO_WORKER_REASON));
	};
	let (result_tx, result_rx) = mpsc::channel();
	let worker_budget = budget.clone();
	std::thread::Builder::new()
		.name(format!("flywheel-{name}"))
		.spawn(move || {
			let _permit = permit;
			let _work = worker_budget.work();
			let _ = result_tx.send(work(&worker_budget));
		})
		.map_err(|err| Error::from_reason(format!("Failed to spawn {name} worker: {err}")))?;
	match result_rx.recv_timeout(budget.wall_deadline().saturating_duration_since(Instant::now())) {
		Ok(result) => result,
		Err(mpsc::RecvTimeoutError::Timeout) => {
			budget.expire();
			Err(budget.stop_error())
		}
		Err(mpsc::RecvTimeoutError::Disconnected) => Err(Error::from_reason(format!("{name} worker terminated unexpectedly"))),
	}
}

#[cfg(test)]
mod tests {
	use std::{sync::mpsc, time::Duration};

	use super::*;

	fn budget(wall_limit: Duration) -> SearchBudget {
		SearchBudget::new(None, wall_limit)
	}

	#[test]
	fn permit_is_retained_until_worker_exits() {
		let owner = FilesystemWorkerOwner::new(1);
		let permit = owner.acquire(&budget(Duration::from_secs(1))).unwrap();
		let (release_tx, release_rx) = mpsc::channel();
		let worker = std::thread::spawn(move || {
			let _permit = permit;
			let _ = release_rx.recv();
		});

		assert!(owner.acquire(&budget(Duration::from_millis(10))).is_none());
		release_tx.send(()).unwrap();
		worker.join().unwrap();
		assert!(owner.acquire(&budget(Duration::from_secs(1))).is_some());
	}

	#[test]
	fn permit_releases_when_worker_finishes() {
		let owner = FilesystemWorkerOwner::new(1);
		let permit = owner.acquire(&budget(Duration::from_secs(1))).unwrap();
		std::thread::spawn(move || drop(permit)).join().unwrap();
		assert!(owner.acquire(&budget(Duration::from_secs(1))).is_some());
	}

	#[test]
	fn a_cancelled_waiter_leaves_the_queue_before_its_wall_limit() {
		let owner = FilesystemWorkerOwner::new(1);
		let _held = owner.acquire(&budget(Duration::from_secs(1))).unwrap();
		let waiting = budget(Duration::from_secs(60));
		let (owner_clone, waiting_clone) = (owner.clone(), waiting.clone());
		let started = Instant::now();
		let waiter = std::thread::spawn(move || owner_clone.acquire(&waiting_clone).is_none());
		std::thread::sleep(Duration::from_millis(20));
		waiting.cancel();
		owner.wake_waiters();
		assert!(waiter.join().unwrap());
		assert!(started.elapsed() < Duration::from_secs(5));
	}
}
