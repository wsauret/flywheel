pub mod o200k;

use crate::utok::utf::Unit;

pub mod cls {
	use xutf::{GeneralCategory as GC, GeneralCategoryGroup as GCG, Ucd};

	#[inline]
	fn category(codepoint: char) -> GC {
		codepoint.general_category()
	}

	#[inline]
	fn group(codepoint: char) -> GCG {
		codepoint.general_category_group()
	}

	#[inline]
	pub fn is_letter(codepoint: char) -> bool {
		if codepoint.is_ascii() {
			return codepoint.is_ascii_alphabetic();
		}
		group(codepoint) == GCG::Letter
	}

	#[inline]
	pub fn is_number(codepoint: char) -> bool {
		if codepoint.is_ascii() {
			return codepoint.is_ascii_digit();
		}
		group(codepoint) == GCG::Number
	}

	#[inline]
	pub fn in_upper_set(codepoint: char) -> bool {
		if codepoint.is_ascii() {
			return codepoint.is_ascii_uppercase();
		}
		let category = category(codepoint);
		matches!(
			category,
			GC::UppercaseLetter | GC::TitlecaseLetter | GC::ModifierLetter | GC::OtherLetter
		) || category.group() == GCG::Mark
	}

	#[inline]
	pub fn in_lower_set(codepoint: char) -> bool {
		if codepoint.is_ascii() {
			return codepoint.is_ascii_lowercase();
		}
		let category = category(codepoint);
		matches!(
			category,
			GC::LowercaseLetter | GC::ModifierLetter | GC::OtherLetter
		) || category.group() == GCG::Mark
	}
}

#[inline]
pub(crate) fn decode_at<U: Unit>(units: &[U], index: usize) -> Option<(char, usize)> {
	(index < units.len()).then(|| U::decode(units, index))
}

pub(crate) fn contraction_end<U: Unit>(units: &[U], position: usize) -> usize {
	let Some(('\'', first_len)) = decode_at(units, position) else {
		return position;
	};
	let Some((first, second_len)) = decode_at(units, position + first_len) else {
		return position;
	};
	let one = position + first_len + second_len;
	match first {
		's' | 'S' | '\u{17f}' | 't' | 'T' | 'm' | 'M' | 'd' | 'D' => one,
		'r' | 'R' | 'v' | 'V' => match decode_at(units, one) {
			Some(('e' | 'E', len)) => one + len,
			_ => position,
		},
		'l' | 'L' => match decode_at(units, one) {
			Some(('l' | 'L', len)) => one + len,
			_ => position,
		},
		_ => position,
	}
}

pub(crate) fn digits_end<U: Unit>(units: &[U], position: usize) -> Option<usize> {
	let mut end = position;
	for _ in 0..3 {
		match decode_at(units, end) {
			Some((codepoint, len)) if cls::is_number(codepoint) => end += len,
			_ => break,
		}
	}
	(end > position).then_some(end)
}

pub(crate) fn punct_end<U: Unit>(units: &[U], position: usize) -> Option<usize> {
	let mut end = position;
	if let Some((' ', len)) = decode_at(units, position) {
		end += len;
	}
	let start = end;
	while let Some((codepoint, len)) = decode_at(units, end) {
		if codepoint.is_whitespace() || cls::is_letter(codepoint) || cls::is_number(codepoint) {
			break;
		}
		end += len;
	}
	if end == start {
		return None;
	}
	while let Some((codepoint, len)) = decode_at(units, end) {
		if codepoint == '\r' || codepoint == '\n' || codepoint == '/' {
			end += len;
		} else {
			break;
		}
	}
	Some(end)
}

pub(crate) fn whitespace_end<U: Unit>(units: &[U], position: usize) -> Option<usize> {
	let mut end = position;
	let mut last_newline_end = None;
	let mut last_len = 0;
	let mut count = 0;
	while let Some((codepoint, len)) = decode_at(units, end) {
		if !codepoint.is_whitespace() {
			break;
		}
		end += len;
		if codepoint == '\r' || codepoint == '\n' {
			last_newline_end = Some(end);
		}
		last_len = len;
		count += 1;
	}
	if count == 0 {
		return None;
	}
	if let Some(newline_end) = last_newline_end {
		return Some(newline_end);
	}
	if end == units.len() {
		return Some(end);
	}
	Some(if count > 1 { end - last_len } else { end })
}
