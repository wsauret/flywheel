use crate::utok::scan;

pub fn for_each_piece(units: &[u16], mut consume: impl FnMut(&[u16])) {
	let mut position = 0;
	while position < units.len() {
		let end = scan::o200k::next_piece(units, position);
		debug_assert!(
			position < end && end <= units.len(),
			"utoken: scanner must advance within bounds"
		);
		consume(&units[position..end]);
		position = end;
	}
}
