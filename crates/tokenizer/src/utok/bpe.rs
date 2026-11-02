use std::{
	collections::HashMap,
	hash::{BuildHasherDefault, Hasher},
};

use crate::utok::{pretoken, utf::Unit};

#[derive(Default)]
struct FxHasher(u64);

impl Hasher for FxHasher {
	#[inline]
	fn write(&mut self, bytes: &[u8]) {
		const SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;
		let mut hash = self.0;
		let mut remaining = bytes;
		while let Some(chunk) = remaining.first_chunk::<8>() {
			hash = (hash.rotate_left(5) ^ u64::from_le_bytes(*chunk)).wrapping_mul(SEED);
			remaining = &remaining[8..];
		}
		if let Some(chunk) = remaining.first_chunk::<4>() {
			hash = (hash.rotate_left(5) ^ u64::from(u32::from_le_bytes(*chunk))).wrapping_mul(SEED);
			remaining = &remaining[4..];
		}
		for &byte in remaining {
			hash = (hash.rotate_left(5) ^ u64::from(byte)).wrapping_mul(SEED);
		}
		self.0 = hash;
	}

	#[inline]
	fn finish(&self) -> u64 {
		self.0
	}
}

type Fx = BuildHasherDefault<FxHasher>;
type FxMap = HashMap<Box<[u8]>, u32, Fx>;

#[inline]
fn pack(key: &[u8]) -> Option<u128> {
	let len = key.len();
	if len > 15 {
		return None;
	}
	let value = if let (Some(low), Some(high)) = (key.first_chunk::<8>(), key.last_chunk::<8>()) {
		u128::from(u64::from_le_bytes(*low))
			| u128::from(u64::from_le_bytes(*high)) << ((len - 8) * 8)
	} else if let (Some(low), Some(high)) = (key.first_chunk::<4>(), key.last_chunk::<4>()) {
		u128::from(u32::from_le_bytes(*low))
			| u128::from(u32::from_le_bytes(*high)) << ((len - 4) * 8)
	} else if let (Some(low), Some(high)) = (key.first_chunk::<2>(), key.last_chunk::<2>()) {
		u128::from(u16::from_le_bytes(*low))
			| u128::from(u16::from_le_bytes(*high)) << ((len - 2) * 8)
	} else if let [byte] = key {
		u128::from(*byte)
	} else {
		0
	};
	Some(value | (len as u128) << 120)
}

pub struct RankTable {
	pairs: Box<[u32; 65536]>,
	short: HashMap<u128, u32, Fx>,
	long: FxMap,
}

impl RankTable {
	pub fn parse(raw: &[u8]) -> Self {
		let mut input = raw;
		assert_eq!(&input[..6], b"UTOK1\n", "utoken: bad magic");
		input = &input[6..];
		let count = u32::from_le_bytes(input[..4].try_into().unwrap()) as usize;
		input = &input[4..];
		let mut pairs: Box<[u32; 65536]> =
			vec![u32::MAX; 65536].into_boxed_slice().try_into().unwrap();
		let mut short = HashMap::with_capacity_and_hasher(count, Fx::default());
		let mut long = FxMap::default();
		for rank in 0..count as u32 {
			let mut len = 0usize;
			let mut shift = 0;
			loop {
				let byte = input[0];
				input = &input[1..];
				len |= ((byte & 0x7f) as usize) << shift;
				if byte < 0x80 {
					break;
				}
				shift += 7;
			}
			if len == 0 {
				continue;
			}
			let key = &input[..len];
			if let [first, second] = key {
				pairs[usize::from(*first) << 8 | usize::from(*second)] = rank;
			} else if let Some(packed) = pack(key) {
				short.insert(packed, rank);
			} else {
				long.insert(key.into(), rank);
			}
			input = &input[len..];
		}
		assert!(input.is_empty(), "utoken: trailing bytes in UTOK1 blob");
		Self { pairs, short, long }
	}

	#[inline]
	fn rank(&self, piece: &[u8]) -> Option<u32> {
		if let [first, second] = piece {
			let rank = self.pairs[usize::from(*first) << 8 | usize::from(*second)];
			return (rank != u32::MAX).then_some(rank);
		}
		match pack(piece) {
			Some(packed) => self.short.get(&packed).copied(),
			None => self.long.get(piece).copied(),
		}
	}

	fn count_piece(&self, piece: &[u8]) -> u32 {
		if piece.is_empty() {
			return 0;
		}
		if self.rank(piece).is_some() {
			return 1;
		}
		let mut count = 0;
		self.merge(piece, |_, _| count += 1);
		count
	}

	fn merge(&self, piece: &[u8], mut emit: impl FnMut(usize, usize)) {
		let mut parts = Vec::with_capacity(piece.len() + 1);
		let mut minimum = (u32::MAX, usize::MAX);
		for index in 0..piece.len() - 1 {
			let rank = self.rank(&piece[index..index + 2]).unwrap_or(u32::MAX);
			if rank < minimum.0 {
				minimum = (rank, index);
			}
			parts.push((index, rank));
		}
		parts.push((piece.len() - 1, u32::MAX));
		parts.push((piece.len(), u32::MAX));

		let merged_rank = |parts: &[(usize, u32)], index: usize| {
			if index + 3 < parts.len() {
				self.rank(&piece[parts[index].0..parts[index + 3].0])
					.unwrap_or(u32::MAX)
			} else {
				u32::MAX
			}
		};

		while minimum.0 != u32::MAX {
			let index = minimum.1;
			if index > 0 {
				parts[index - 1].1 = merged_rank(&parts, index - 1);
			}
			parts[index].1 = merged_rank(&parts, index);
			parts.remove(index + 1);
			minimum = (u32::MAX, usize::MAX);
			for (index, &(_, rank)) in parts[..parts.len() - 1].iter().enumerate() {
				if rank < minimum.0 {
					minimum = (rank, index);
				}
			}
		}
		for window in parts.windows(2) {
			emit(window[0].0, window[1].0);
		}
	}
}

pub struct BpeEncoding {
	pub table: RankTable,
}

impl BpeEncoding {
	pub fn count(&self, units: &[u16]) -> u32 {
		let mut count = 0;
		let mut bytes = Vec::new();
		pretoken::for_each_piece(units, |piece| {
			bytes.clear();
			bytes.reserve(piece.len());
			let mut index = 0;
			while index < piece.len() {
				if let Some(byte) = piece[index].ascii() {
					bytes.push(byte);
					index += 1;
				} else {
					let (codepoint, consumed) = u16::decode(piece, index);
					index += consumed;
					let mut encoded = [0u8; 4];
					bytes.extend_from_slice(codepoint.encode_utf8(&mut encoded).as_bytes());
				}
			}
			count += self.table.count_piece(&bytes);
		});
		count
	}
}
