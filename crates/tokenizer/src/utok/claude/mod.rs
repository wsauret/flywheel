//! Offline reconstruction of Claude tokenizer content counts.

mod constants;
mod engine;
mod normalize;

use std::sync::LazyLock;

use engine::VocabCore;
use normalize::{FrameParams, nfc_units, raw_head_space_units, stream_norm, trim_end_ws};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Family {
	V3,
	V47,
	V5,
	V5Sonnet,
}

static CORE_V3: LazyLock<VocabCore> =
	LazyLock::new(|| VocabCore::parse(include_bytes!("../../../data/ctok_v3.bin")));

static CORE_V47: LazyLock<VocabCore> =
	LazyLock::new(|| VocabCore::parse(include_bytes!("../../../data/ctok_v4_7.bin")));

impl Family {
	fn core(self) -> &'static VocabCore {
		match self {
			Self::V3 => &CORE_V3,
			Self::V47 | Self::V5 | Self::V5Sonnet => &CORE_V47,
		}
	}

	fn params(self) -> FrameParams {
		let mut params = self.core().frame_params();
		if matches!(self, Self::V5 | Self::V5Sonnet) {
			params.message_overhead = 6;
			params.frame_bow = false;
			params.ladder = self == Self::V5Sonnet;
		}
		params
	}

	const fn appended_newlines(self) -> usize {
		match self {
			Self::V5Sonnet => 0,
			_ => 2,
		}
	}
}

pub fn content_token_count(units: &[u16], family: Family) -> u32 {
	let core = family.core();
	let params = family.params();
	let head_space = raw_head_space_units(units);
	if params.ladder {
		let norm = nfc_units(units, params.fold_quotes);
		let tail_length = norm.bytes().rev().take_while(|&byte| byte == b'\n').count();
		let stream = stream_norm(&norm, &params, head_space);
		let tail = core.ladder_tail_cost(tail_length, family.appended_newlines());
		if stream.is_empty() {
			tail
		} else {
			core.tile_cost(&stream) + tail
		}
	} else {
		let stripped = trim_end_ws(units);
		let norm = nfc_units(stripped, params.fold_quotes);
		let stream = stream_norm(&norm, &params, head_space);
		if stream.is_empty() {
			0
		} else {
			core.tile_cost(&stream)
		}
	}
}
