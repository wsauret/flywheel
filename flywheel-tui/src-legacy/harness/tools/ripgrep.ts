/**
 * Native ripgrep search engine wrapper.
 *
 * Loads the flywheel-ripgrep N-API addon and exposes typed search functions.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

// -- Types ------------------------------------------------------------------

/** A context line returned around a match. */
export interface ContextLine {
	lineNumber: number;
	line: string;
}

/** Options for searching in-memory content. */
export interface SearchOptions {
	pattern: string;
	ignoreCase?: boolean;
	multiline?: boolean;
	maxCount?: number;
	offset?: number;
	contextBefore?: number;
	contextAfter?: number;
	context?: number;
	maxColumns?: number;
	mode?: 'content' | 'count';
}

/** A single content match. */
export interface SearchMatch {
	lineNumber: number;
	line: string;
	contextBefore?: ContextLine[];
	contextAfter?: ContextLine[];
	truncated?: boolean;
}

/** Result of searching in-memory content. */
export interface SearchResult {
	matches: SearchMatch[];
	matchCount: number;
	limitReached: boolean;
	error?: string;
}

/** Options for searching files on disk. */
export interface GrepOptions {
	pattern: string;
	path: string;
	glob?: string;
	type?: string;
	ignoreCase?: boolean;
	multiline?: boolean;
	hidden?: boolean;
	gitignore?: boolean;
	maxCount?: number;
	offset?: number;
	contextBefore?: number;
	contextAfter?: number;
	context?: number;
	maxColumns?: number;
	mode?: 'content' | 'filesWithMatches' | 'count';
}

/** A single grep match or per-file count entry. */
export interface GrepMatch {
	path: string;
	lineNumber: number;
	line: string;
	contextBefore?: ContextLine[];
	contextAfter?: ContextLine[];
	truncated?: boolean;
	matchCount?: number;
}

/** Full grep result including matches and summary counts. */
export interface GrepResult {
	matches: GrepMatch[];
	totalMatches: number;
	filesWithMatches: number;
	filesSearched: number;
	limitReached?: boolean;
}

// -- Native addon binding ---------------------------------------------------

interface NativeAddon {
	search(content: string | Uint8Array, options: SearchOptions): SearchResult;
	hasMatch(
		content: string | Uint8Array,
		pattern: string | Uint8Array,
		ignoreCase: boolean,
		multiline: boolean,
	): boolean;
	grep(options: GrepOptions): GrepResult;
}

function loadAddon(): NativeAddon {
	const require = createRequire(import.meta.url);
	const addonPath = path.resolve(
		import.meta.dir,
		'../../../crates/ripgrep/flywheel-ripgrep.darwin-arm64.node',
	);
	return require(addonPath) as NativeAddon;
}

const native = loadAddon();

// -- Public API -------------------------------------------------------------

/** Search files for a regex pattern. */
export function grep(options: GrepOptions): GrepResult {
	return native.grep(options);
}

/** Search in-memory content for a regex pattern. */
export function search(
	content: string | Uint8Array,
	options: SearchOptions,
): SearchResult {
	return native.search(content, options);
}

/** Quick check if content matches a pattern. */
export function hasMatch(
	content: string | Uint8Array,
	pattern: string | Uint8Array,
	options?: { ignoreCase?: boolean; multiline?: boolean },
): boolean {
	return native.hasMatch(
		content,
		pattern,
		options?.ignoreCase ?? false,
		options?.multiline ?? false,
	);
}
