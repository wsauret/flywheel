pub trait Unit: Copy {
	fn decode(units: &[Self], index: usize) -> (char, usize);
	fn ascii(self) -> Option<u8>;
}

impl Unit for u16 {
	#[inline]
	fn decode(units: &[Self], index: usize) -> (char, usize) {
		let unit = units[index];
		if !(0xd800..=0xdfff).contains(&unit) {
			return (char::from_u32(unit as u32).unwrap_or(char::REPLACEMENT_CHARACTER), 1);
		}
		if unit < 0xdc00
			&& let Some(&low) = units.get(index + 1)
			&& (0xdc00..=0xdfff).contains(&low)
		{
			let codepoint = 0x10000 + (((unit as u32 - 0xd800) << 10) | (low as u32 - 0xdc00));
			return (char::from_u32(codepoint).unwrap_or(char::REPLACEMENT_CHARACTER), 2);
		}
		(char::REPLACEMENT_CHARACTER, 1)
	}

	#[inline]
	fn ascii(self) -> Option<u8> {
		(self < 0x80).then_some(self as u8)
	}
}
