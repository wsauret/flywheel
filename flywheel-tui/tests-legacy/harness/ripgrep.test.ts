/**
 * Native ripgrep N-API addon — validation tests.
 *
 * Confirms the flywheel-ripgrep native addon loads under Bun and produces
 * correct search results for content search, file grep, and match detection.
 */

import { describe, it, expect } from 'bun:test';
import path from 'node:path';
import { grep, search, hasMatch } from '../../src/harness/tools/ripgrep.js';

const PROJECT_ROOT = path.resolve(import.meta.dir, '../..');
const CRATE_SRC = path.resolve(PROJECT_ROOT, 'crates/ripgrep/src');

// ---------------------------------------------------------------------------
// Module loading
// ---------------------------------------------------------------------------

describe('ripgrep native addon loading', () => {
	it('exports grep, search, and hasMatch functions', () => {
		expect(typeof grep).toBe('function');
		expect(typeof search).toBe('function');
		expect(typeof hasMatch).toBe('function');
	});
});

// ---------------------------------------------------------------------------
// search() — in-memory content search
// ---------------------------------------------------------------------------

describe('search()', () => {
	it('finds matches in a string', () => {
		const result = search('hello world\nfoo bar\nhello there', {
			pattern: 'hello',
		});
		expect(result.matchCount).toBe(2);
		expect(result.matches).toHaveLength(2);
		expect(result.matches[0]!.lineNumber).toBe(1);
		expect(result.matches[0]!.line).toBe('hello world');
		expect(result.matches[1]!.lineNumber).toBe(3);
		expect(result.matches[1]!.line).toBe('hello there');
		expect(result.limitReached).toBe(false);
		expect(result.error).toBeUndefined();
	});

	it('accepts Uint8Array content', () => {
		const content = new TextEncoder().encode('alpha\nbeta\nalpha again');
		const result = search(content, { pattern: 'alpha' });
		expect(result.matchCount).toBe(2);
	});

	it('respects maxCount', () => {
		const result = search('a\na\na\na\na', { pattern: 'a', maxCount: 2 });
		expect(result.matches).toHaveLength(2);
		expect(result.limitReached).toBe(true);
	});

	it('respects offset', () => {
		const result = search('a\nb\na\nb\na', { pattern: 'a', offset: 1 });
		expect(result.matchCount).toBe(3);
		expect(result.matches).toHaveLength(2);
		expect(result.matches[0]!.lineNumber).toBe(3);
	});

	it('supports case-insensitive search', () => {
		const result = search('Hello\nhello\nHELLO', {
			pattern: 'hello',
			ignoreCase: true,
		});
		expect(result.matchCount).toBe(3);
	});

	it('returns empty results for no match', () => {
		const result = search('nothing here', { pattern: 'xyz' });
		expect(result.matchCount).toBe(0);
		expect(result.matches).toHaveLength(0);
	});

	it('returns error for invalid regex', () => {
		const result = search('test', { pattern: '[invalid' });
		expect(result.error).toBeDefined();
		expect(result.matchCount).toBe(0);
	});

	it('provides context lines when requested', () => {
		const content = 'line1\nline2\ntarget\nline4\nline5';
		const result = search(content, {
			pattern: 'target',
			contextBefore: 1,
			contextAfter: 1,
		});
		expect(result.matches).toHaveLength(1);
		const match = result.matches[0]!;
		expect(match.contextBefore).toHaveLength(1);
		expect(match.contextBefore![0]!.line).toBe('line2');
		expect(match.contextAfter).toHaveLength(1);
		expect(match.contextAfter![0]!.line).toBe('line4');
	});
});

// ---------------------------------------------------------------------------
// hasMatch() — quick boolean check
// ---------------------------------------------------------------------------

describe('hasMatch()', () => {
	it('returns true when pattern matches', () => {
		expect(hasMatch('hello world', 'hello')).toBe(true);
	});

	it('returns false when pattern does not match', () => {
		expect(hasMatch('goodbye world', 'hello')).toBe(false);
	});

	it('respects case sensitivity', () => {
		expect(hasMatch('Hello', 'hello')).toBe(false);
		expect(hasMatch('Hello', 'hello', { ignoreCase: true })).toBe(true);
	});

	it('accepts Uint8Array inputs', () => {
		const content = new TextEncoder().encode('test string');
		const pattern = new TextEncoder().encode('test');
		expect(hasMatch(content, pattern)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// grep() — filesystem search
// ---------------------------------------------------------------------------

describe('grep()', () => {
	it('searches a directory for matches', () => {
		const result = grep({
			pattern: 'napi',
			path: CRATE_SRC,
			type: 'rust',
		});
		expect(result.totalMatches).toBeGreaterThan(0);
		expect(result.filesWithMatches).toBeGreaterThan(0);
		expect(result.filesSearched).toBeGreaterThan(0);
		expect(result.matches.length).toBeGreaterThan(0);
		expect(result.matches[0]!.path).toBeDefined();
		expect(result.matches[0]!.lineNumber).toBeGreaterThan(0);
	});

	it('searches a single file', () => {
		const result = grep({
			pattern: 'fn main',
			path: path.resolve(PROJECT_ROOT, 'crates/ripgrep/build.rs'),
		});
		expect(result.totalMatches).toBe(1);
		expect(result.filesSearched).toBe(1);
	});

	it('respects glob filter', () => {
		const result = grep({
			pattern: 'pub',
			path: CRATE_SRC,
			glob: '*.rs',
		});
		expect(result.filesSearched).toBeGreaterThan(0);
		for (const m of result.matches) {
			expect(m.path.endsWith('.rs')).toBe(true);
		}
	});

	it('respects type filter', () => {
		const result = grep({
			pattern: 'fn',
			path: CRATE_SRC,
			type: 'rust',
		});
		expect(result.filesSearched).toBeGreaterThan(0);
		for (const m of result.matches) {
			expect(m.path.endsWith('.rs')).toBe(true);
		}
	});

	it('returns empty for no matches', () => {
		const result = grep({
			pattern: 'zzz_nonexistent_pattern_zzz',
			path: CRATE_SRC,
		});
		expect(result.totalMatches).toBe(0);
		expect(result.matches).toHaveLength(0);
	});

	it('returns count mode results', () => {
		const result = grep({
			pattern: 'fn',
			path: CRATE_SRC,
			type: 'rust',
			mode: 'count',
		});
		expect(result.totalMatches).toBeGreaterThan(0);
		for (const m of result.matches) {
			expect(m.matchCount).toBeGreaterThan(0);
		}
	});

	it('supports maxCount', () => {
		const result = grep({
			pattern: 'fn',
			path: CRATE_SRC,
			maxCount: 3,
		});
		expect(result.matches).toHaveLength(3);
		expect(result.limitReached).toBe(true);
	});

	it('handles invalid path gracefully', () => {
		expect(() =>
			grep({
				pattern: 'test',
				path: '/nonexistent/path/that/does/not/exist',
			}),
		).toThrow();
	});

	it('sanitizes brace patterns in regex', () => {
		const result = grep({
			pattern: '${pattern}',
			path: CRATE_SRC,
		});
		// Should not throw — braces are escaped internally
		expect(result).toBeDefined();
	});
});
