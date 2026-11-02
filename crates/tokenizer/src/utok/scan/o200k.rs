use super::{cls, contraction_end, decode_at, digits_end, punct_end, whitespace_end};
use crate::utok::utf::Unit;

pub fn next_piece<U: Unit>(units: &[U], position: usize) -> usize {
	if let Some(end) = word(units, position) {
		return contraction_end(units, end);
	}
	if let Some(end) = digits_end(units, position) {
		return end;
	}
	if let Some(end) = punct_end(units, position) {
		return end;
	}
	if let Some(end) = whitespace_end(units, position) {
		return end;
	}
	position + decode_at(units, position).map_or(1, |(_, len)| len)
}

fn word<U: Unit>(units: &[U], position: usize) -> Option<usize> {
	let (codepoint, len) = decode_at(units, position)?;
	let prefix = (codepoint != '\r'
		&& codepoint != '\n'
		&& !cls::is_letter(codepoint)
		&& !cls::is_number(codepoint))
	.then_some(position + len);
	if let Some(prefix_end) = prefix
		&& let Some(end) = lower_word(units, prefix_end)
	{
		return Some(end);
	}
	if let Some(end) = lower_word(units, position) {
		return Some(end);
	}
	if let Some(prefix_end) = prefix
		&& let Some(end) = upper_word(units, prefix_end)
	{
		return Some(end);
	}
	upper_word(units, position)
}

fn lower_word<U: Unit>(units: &[U], position: usize) -> Option<usize> {
	let mut end = position;
	let mut last_shared_end = None;
	while let Some((codepoint, len)) = decode_at(units, end) {
		if !cls::in_upper_set(codepoint) {
			break;
		}
		if cls::in_lower_set(codepoint) {
			last_shared_end = Some(end + len);
		}
		end += len;
	}
	if let Some((codepoint, len)) = decode_at(units, end)
		&& cls::in_lower_set(codepoint)
	{
		end += len;
		while let Some((codepoint, len)) = decode_at(units, end) {
			if !cls::in_lower_set(codepoint) {
				break;
			}
			end += len;
		}
		return Some(end);
	}
	last_shared_end
}

fn upper_word<U: Unit>(units: &[U], position: usize) -> Option<usize> {
	let mut end = position;
	while let Some((codepoint, len)) = decode_at(units, end) {
		if !cls::in_upper_set(codepoint) {
			break;
		}
		end += len;
	}
	if end == position {
		return None;
	}
	while let Some((codepoint, len)) = decode_at(units, end) {
		if !cls::in_lower_set(codepoint) {
			break;
		}
		end += len;
	}
	Some(end)
}
