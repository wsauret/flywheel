mod bpe;
mod claude;
mod pretoken;
mod scan;
mod utf;

use std::sync::LazyLock;

static O200K: LazyLock<bpe::BpeEncoding> = LazyLock::new(|| bpe::BpeEncoding {
	table: bpe::RankTable::parse(include_bytes!("../../data/o200k_base.bin")),
});

pub fn count(encoding: u32, units: &[u16]) -> u32 {
	match encoding {
		0 => O200K.count(units),
		1 => claude::content_token_count(units, claude::Family::V3),
		2 => claude::content_token_count(units, claude::Family::V47),
		3 => claude::content_token_count(units, claude::Family::V5),
		4 => claude::content_token_count(units, claude::Family::V5Sonnet),
		_ => panic!("invalid tokenizer encoding"),
	}
}
