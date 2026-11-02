import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { isRecord } from "../src/infra/record.js";

// The review tool for the third-party components of the Bun runtime that `bun build --compile` embeds in the flywheel
// binary. The component list is the one in Bun's own LICENSE.md at the bun-v1.4.4 tag. The test cases under
// test/cli/lint/conformance and test/cli/format are not part of the binary, so they are not components. JavaScriptCore,
// WebKit, and tinycc keep their reviewed files next to this folder, because the bundle preamble names their sources.
//
// Each component is pinned. A `ref` is the commit or tag that Bun 1.4.4 links: scripts/build/deps/ of the Bun tag for
// the native libraries, the WebKit commit for simdutf and ICU, and the Bun tag for its own forks. An `npm` pin is the
// version in src/node-fallbacks/bun.lock of the Bun tag, or the version whose license Bun's port carries; its published
// gitHead, or else its version tag, is the commit. Bun names no version for the code it ports or credits, so the `ref`
// of such a component is the upstream commit that the review of 2026-10-30 read. A rerun reads the same texts; move a
// pin only as part of a new review.
//
// The script writes every legal file of each component into components/<slug>/ and the manifest components.json, which
// scripts/generate-third-party-licenses.ts reads offline. Run it from the repository root when the embedded Bun changes:
//   GITHUB_TOKEN=$(gh auth token) bun run scripts/review-bun-runtime-licenses.ts

const BUN_TAG = "bun-v1.4.4";
const WEBKIT_COMMIT = "d6375c72affe0f70222cdcb45012b10f0bf3a9d5";
const DESTINATION = "third-party/reviewed/runtime/bun-1.4.4";
const LEGAL_FILE = /^(?:licen[cs]e|copying|notice|patents|authors)(?:[-._].*|$)|third[-_ ]?party.*(?:notice|licen[cs]e)/iu;

type RepositoryComponent = {
  readonly name: string;
  readonly license: string;
  readonly repo: string;
  readonly dir?: string;
  readonly files?: readonly string[];
  /**
   * Compiled source files whose opening comment is their license notice. Each distinct notice is kept once, under the
   * names of the files that carry it, because BSD and MIT ask for the notice of every copyright holder.
   */
  readonly sourceNotices?: readonly string[];
} & ({ readonly ref: string } | { readonly npm: string });

/** A component whose repository no longer exists, so its published package is the source. */
interface PackageComponent {
  readonly name: string;
  readonly license: string;
  readonly npm: string;
}

type Component = RepositoryComponent | PackageComponent;

/** One reviewed component as the generator reads it from components.json. */
export interface ReviewedRuntimeComponent {
  readonly name: string;
  readonly license: string;
  readonly source: string;
  readonly files: readonly string[];
}

// SOURCES and SOURCES_WIN of scripts/build/deps/libarchive.ts at the Bun tag: the libarchive files that Bun compiles.
const LIBARCHIVE_SOURCES = [
  "archive_acl", "archive_check_magic", "archive_cmdline", "archive_cryptor",
  "archive_digest", "archive_entry", "archive_entry_copy_stat",
  "archive_entry_link_resolver", "archive_entry_sparse", "archive_entry_stat",
  "archive_entry_strmode", "archive_entry_xattr", "archive_hmac", "archive_match",
  "archive_options", "archive_pack_dev", "archive_parse_date", "archive_pathmatch",
  "archive_ppmd7", "archive_random", "archive_rb", "archive_read",
  "archive_read_add_passphrase", "archive_read_append_filter",
  "archive_read_data_into_fd", "archive_read_disk_entry_from_file",
  "archive_read_disk_posix", "archive_read_disk_set_standard_lookup",
  "archive_read_extract", "archive_read_extract2", "archive_read_open_fd",
  "archive_read_open_file", "archive_read_open_filename", "archive_read_open_memory",
  "archive_read_set_format", "archive_read_set_options",
  "archive_read_support_filter_gzip", "archive_read_support_filter_program",
  "archive_read_support_format_empty", "archive_read_support_format_raw",
  "archive_read_support_format_tar", "archive_string", "archive_string_sprintf",
  "archive_time", "archive_util", "archive_version_details", "archive_virtual",
  "archive_write", "archive_write_disk_posix", "archive_write_disk_set_standard_lookup",
  "archive_write_open_fd", "archive_write_open_file", "archive_write_open_filename",
  "archive_write_open_memory", "archive_write_add_filter",
  "archive_write_add_filter_b64encode", "archive_write_add_filter_by_name",
  "archive_write_add_filter_bzip2", "archive_write_add_filter_compress",
  "archive_write_add_filter_grzip", "archive_write_add_filter_gzip",
  "archive_write_add_filter_lrzip", "archive_write_add_filter_lz4",
  "archive_write_add_filter_lzop", "archive_write_add_filter_none",
  "archive_write_add_filter_program", "archive_write_add_filter_uuencode",
  "archive_write_add_filter_xz", "archive_write_add_filter_zstd",
  "archive_write_set_format", "archive_write_set_format_7zip",
  "archive_write_set_format_ar", "archive_write_set_format_by_name",
  "archive_write_set_format_cpio", "archive_write_set_format_cpio_binary",
  "archive_write_set_format_cpio_newc", "archive_write_set_format_cpio_odc",
  "archive_write_set_format_filter_by_ext", "archive_write_set_format_gnutar",
  "archive_write_set_format_iso9660", "archive_write_set_format_mtree",
  "archive_write_set_format_pax", "archive_write_set_format_raw",
  "archive_write_set_format_shar", "archive_write_set_format_ustar",
  "archive_write_set_format_v7tar", "archive_write_set_format_warc",
  "archive_write_set_format_xar", "archive_write_set_format_zip",
  "archive_write_set_options", "archive_write_set_passphrase", "filter_fork_posix",
  "xxhash",
  "archive_entry_copy_bhfi", "archive_read_disk_windows", "archive_windows",
  "archive_write_disk_windows", "filter_fork_windows",
];

const COMPONENTS: readonly Component[] = [
  // Linked libraries.
  { name: "boringssl", license: "several licenses", repo: "oven-sh/boringssl", ref: "41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f" },
  { name: "brotli", license: "MIT", repo: "google/brotli", ref: "db24a98aed38a16de78cc05ca15cdd8dc2a0d92d" },
  // COPYING defers to the notice in each source file, so the notices of the files that Bun compiles are kept too.
  { name: "libarchive", license: "several licenses", repo: "libarchive/libarchive", ref: "27cbc7827172698143e440801fc0ba39ccb4f1f5", sourceNotices: LIBARCHIVE_SOURCES.map((source) => `libarchive/${source}.c`) },
  { name: "lol-html", license: "BSD-3-Clause", repo: "oven-sh/lol-html", ref: "725ce499aa9b71e38b7a2d0a9fbb6d7294a4079e" },
  { name: "ls-hpack", license: "MIT", repo: "litespeedtech/ls-hpack", ref: "cf0f70dd10b352194c97448eb5d00b4aa484f531" },
  { name: "ls-qpack", license: "MIT", repo: "litespeedtech/ls-qpack", ref: "91567706c41c0d97ab8dc576873ecd472d7869fa" },
  { name: "lsquic", license: "MIT, with portions under BSD-3-Clause", repo: "litespeedtech/lsquic", ref: "f812ceb9529e26717df78c6064a2ff648b949f3e" },
  { name: "mimalloc", license: "MIT", repo: "oven-sh/mimalloc", ref: "92ef6587c57b262f6e6abf513f7776a2f8d12aeb" },
  { name: "picohttpparser", license: "MIT (dual-licensed with the Perl License)", repo: "h2o/picohttpparser", ref: "f4d94b48b31e0abae029ebeafcfd9ca0680ede58", files: [], sourceNotices: ["picohttpparser.c"] },
  { name: "zstd", license: "BSD-3-Clause (dual-licensed with GPL-2.0)", repo: "facebook/zstd", ref: "f8745da6ff1ad1e7bab384bd1f9d742439278e99", files: ["LICENSE"] },
  { name: "simdutf", license: "MIT (dual-licensed with Apache-2.0; WebKit carries the MIT text)", repo: "oven-sh/WebKit", ref: WEBKIT_COMMIT, files: ["Source/WTF/wtf/simdutf/LICENSE-simdutf.txt"] },
  { name: "uSockets", license: "Apache-2.0", repo: "oven-sh/bun", ref: BUN_TAG, dir: "packages/bun-usockets" },
  { name: "zlib-ng", license: "Zlib", repo: "zlib-ng/zlib-ng", ref: "12731092979c6d07f42da27da673a9f6c7b13586" },
  { name: "c-ares", license: "MIT", repo: "c-ares/c-ares", ref: "c7a3138dcfe3bb0eaaf10c0c24c36dc66dc790ab" },
  { name: "libicu 78.3 (Linux and Windows)", license: "Unicode-3.0 and others", repo: "unicode-org/icu", ref: "release-78.3", files: ["LICENSE"] },
  { name: "libbase64", license: "BSD-2-Clause", repo: "aklomp/base64", ref: "5d5074cb856b9a53fe64f04ddf47812a85f4fb5a" },
  { name: "libuv (Windows)", license: "MIT", repo: "oven-sh/libuv", ref: "8023581113b276e7c1aee3f82da57ca0893faab1", files: ["LICENSE", "LICENSE-extra"] },
  { name: "libdeflate", license: "MIT", repo: "ebiggers/libdeflate", ref: "92e6a0db9fa848d742f9eb286c92afc60f2c3dda" },
  { name: "libjpeg-turbo", license: "BSD-3-Clause, IJG, and Zlib", repo: "libjpeg-turbo/libjpeg-turbo", ref: "c85e6b905bf237038faa936dab160ebfc5da0344", files: ["LICENSE.md", "README.ijg"] },
  { name: "libspng", license: "BSD-2-Clause", repo: "randy408/libspng", ref: "fb768002d4288590083a476af628e51c3f1d47cd" },
  // Bun pins libwebp commit b7e29b9d75bd31422b00c2a446d49d7af06c328d (v1.6.0), which the GitHub mirror lacks; v1.6.0 is its tag there.
  { name: "libwebp", license: "BSD-3-Clause", repo: "webmproject/libwebp", ref: "v1.6.0" },
  { name: "highway", license: "Apache-2.0", repo: "google/highway", ref: "2607d3b5b0113992fe84d3848859eae13b3b52c1" },
  { name: "uucode", license: "MIT", repo: "jacobsandlund/uucode", ref: "1fb73433bba5d93366c57f23ff2e9d7939746500" },
  { name: "uWebSockets (Bun fork)", license: "Apache-2.0", repo: "oven-sh/bun", ref: BUN_TAG, dir: "packages/bun-uws" },
  { name: "Tigerbeetle IO code", license: "Apache-2.0", repo: "tigerbeetle/tigerbeetle", ref: "532c8b70b9142c17e07737ab6d3da68d7500cbca" },
  { name: "LLVM libc++abi", license: "Apache-2.0 WITH LLVM-exception", repo: "llvm/llvm-project", ref: "llvmorg-19.1.0", dir: "libcxxabi" },
  // Code that `bun check`, `bun lint`, and `bun fmt` port.
  { name: "typescript-go", license: "Apache-2.0", repo: "microsoft/typescript-go", ref: "89d5d5b2849a0db0957065889ca58536fa6d2e4a" },
  { name: "TypeScript", license: "Apache-2.0", repo: "microsoft/TypeScript", ref: "60cab4b37a1e2fdb0e41fc2f9c606a60b1965184" },
  { name: "ESLint", license: "MIT", repo: "eslint/eslint", ref: "12cbff4125db3f6446f72fa0c48c46b92b120427" },
  { name: "typescript-eslint", license: "MIT", repo: "typescript-eslint/typescript-eslint", ref: "bdf0a9c5fc58bbba7199106b7fb1346d4cfef822" },
  { name: "esquery", license: "BSD-3-Clause", repo: "estools/esquery", ref: "444da2c9b1f973555102b0e3a2c62f5d607dc6fe" },
  { name: "@eslint-community/regexpp", license: "MIT", repo: "eslint-community/regexpp", ref: "76b6a3aef2d53972e0a3ca5dd9e83f6bb6ec6e78" },
  { name: "@eslint-community/eslint-utils", license: "MIT", repo: "eslint-community/eslint-utils", ref: "3d8d9476c382318bf1a620fc1f6a1ac14dabaaf4" },
  { name: "levn", license: "MIT", repo: "gkz/levn", ref: "bfe5bbd351804304d12adc0de70e512b5f7709f3" },
  { name: "natural-compare-lite", license: "MIT", repo: "litejs/natural-compare-lite", ref: "a8e1e32c85713ba7d079445207a808ce6f4852f9" },
  { name: "ts-api-utils", license: "MIT", repo: "JoshuaKGoldberg/ts-api-utils", ref: "e59a11b8d93e85e5049d2ec335c9c7134dfd7e73" },
  { name: "@eslint/eslintrc", license: "MIT", repo: "eslint/eslintrc", ref: "e88532581c1125ccdc27d500a8171fbc89dc7893" },
  { name: "ajv", license: "MIT", repo: "ajv-validator/ajv", ref: "f177fe323420ccb23e1a79445fd470cbf80aee7c" },
  { name: "acorn", license: "MIT", repo: "acornjs/acorn", ref: "69788e23ca00483aef84005502dc3b88f2af38df", dir: "acorn" },
  { name: "optionator", license: "MIT", repo: "gkz/optionator", ref: "4babe25432de186943d78f8f69875d1255802f72" },
  { name: "globals", license: "MIT", repo: "sindresorhus/globals", ref: "ce512bc1949f918ad6c17cc864a63ab6b077764f" },
  { name: "is-core-module", license: "MIT", repo: "inspect-js/is-core-module", ref: "9b50b2d1bf457b56ab4f547b4ea744da1502cf74" },
  { name: "espree", license: "BSD-2-Clause", repo: "eslint/js", ref: "50d7a50b23a9310d4732de09ecb817400042af2c", dir: "packages/espree" },
  { name: "V8", license: "BSD-3-Clause", repo: "v8/v8", ref: "5dba721424b54adbc27d51b7d95e066058722a14", files: ["LICENSE"] },
  { name: "@eslint/plugin-kit, @eslint/config-array, @eslint/config-helpers, @eslint/compat", license: "Apache-2.0", repo: "eslint/rewrite", ref: "9aa97f2d08bfc04be62a918f1b2a67082cf03f96" },
  { name: "ignore", license: "MIT", repo: "kaelzhang/node-ignore", ref: "edbaa52437931225c601d678fc0acd76853d3104" },
  { name: "is-glob", license: "MIT", repo: "micromatch/is-glob", ref: "789e8bbc62e1fff7a2762449b3a7bac75c08916d" },
  { name: "is-extglob", license: "MIT", repo: "jonschlinkert/is-extglob", ref: "d508f2ed92ddaf8deef6d64d2f749ca1322f883e" },
  { name: "glob-parent", license: "ISC", repo: "gulpjs/glob-parent", ref: "e6aecfc257ba6d1bd863b7e1066cf7aa3adc4b0b" },
  { name: "eslint-plugin-react-hooks", license: "MIT", repo: "facebook/react", ref: "16453bcd12becf76340caa793d185cec1b80ebef" },
  { name: "eslint-plugin-import", license: "MIT", repo: "import-js/eslint-plugin-import", ref: "a60d71548b0d12b750f7a7040285774fed25975a" },
  { name: "eslint-plugin-n", license: "MIT", repo: "eslint-community/eslint-plugin-n", ref: "6e1353be12a49ca570b750eb7386215d881ee6a3" },
  { name: "eslint-plugin-es-x", license: "MIT", repo: "eslint-community/eslint-plugin-es-x", ref: "db5e0305ec9b48594968fd9964f2177222f84219" },
  { name: "eslint-plugin-react", license: "MIT", repo: "jsx-eslint/eslint-plugin-react", ref: "da5431790717d95dc7f5865eb907a79b4786d095" },
  { name: "eslint-plugin-prettier", license: "MIT", repo: "prettier/eslint-plugin-prettier", ref: "e6dd27a4e4015748b2e87c646be2c1a530789343" },
  { name: "jsx-ast-utils", license: "MIT", repo: "jsx-eslint/jsx-ast-utils", ref: "7cc40c4d2b88f221eae5ec2868754d31a85d8d71" },
  { name: "prettier-linter-helpers", license: "MIT", repo: "prettier/prettier-linter-helpers", ref: "f29e489a48ad57b8efd518673d1796bbf282ac03" },
  { name: "diff-match-patch", license: "Apache-2.0", repo: "google/diff-match-patch", ref: "62f2e689f498f9c92dbc588c58750addec9b1654" },
  { name: "fast-diff", license: "Apache-2.0", repo: "jhchen/fast-diff", ref: "0e27223f8792083f5a49a193eb1ddbf26125fdb2" },
  { name: "oxc (oxlint, oxc_jsdoc, oxc_react_compiler, oxc_formatter)", license: "MIT", repo: "oxc-project/oxc", ref: "eaa8e9005d9f8ec2b7770c43a496d19d7ca353dd" },
  { name: "tsgolint", license: "MIT", repo: "oxc-project/tsgolint", ref: "9081583bd5c02c1b42bdebedf38e268fb68602c8" },
  { name: "eslint-plugin-unicorn", license: "MIT", repo: "sindresorhus/eslint-plugin-unicorn", ref: "a8a814a08f6928f595eb578122f9d020f3a1c6a9" },
  { name: "eslint-plugin-react-perf", license: "MIT", repo: "cvazac/eslint-plugin-react-perf", ref: "811b182f60294377dbb8c7d671d15052e5b2b177" },
  { name: "eslint-plugin-jsx-a11y", license: "MIT", repo: "jsx-eslint/eslint-plugin-jsx-a11y", ref: "8f75961d965e47afb88854d324bd32fafde7acfe" },
  { name: "@next/eslint-plugin-next", license: "MIT", repo: "vercel/next.js", ref: "4fed142e56e174947868f4566765d3f1897aa3b3" },
  { name: "eslint-plugin-jest", license: "MIT", repo: "jest-community/eslint-plugin-jest", ref: "af4ad59a1e03423dd87bf737a8f3edc49dea4689" },
  { name: "@vitest/eslint-plugin", license: "MIT", repo: "vitest-dev/eslint-plugin-vitest", ref: "c5df1054a25044a7ca5baf07461b7aee1f15f5f2" },
  { name: "eslint-plugin-promise", license: "ISC", repo: "eslint-community/eslint-plugin-promise", ref: "51c6308694dacaf338c42c4a3e5031583416b877" },
  { name: "aria-query", license: "Apache-2.0", repo: "A11yance/aria-query", ref: "c151dafa6ab17143479e5aeaa0826a3d657cc5be" },
  { name: "Prettier", license: "MIT", repo: "prettier/prettier", ref: "bed4edbb1cf2a9db4004215b0ce5707cdb02b5d9" },
  { name: "Biome", license: "MIT", repo: "biomejs/biome", ref: "1db7c0d725178c53f1db9075c3711a873b0da754", files: ["LICENSE-MIT"] },
  { name: "postcss", license: "MIT", repo: "postcss/postcss", ref: "2455ac8212fe66bc3248aa01186a52c27c87da5a" },
  { name: "postcss-scss", license: "MIT", repo: "postcss/postcss-scss", ref: "028380809e01f5f40367464524b64f1101ae270f" },
  { name: "postcss-less", license: "MIT", repo: "shellscape/postcss-less", ref: "e13ad0146352458da3247386949435b32dec13a4" },
  { name: "postcss-selector-parser", license: "MIT", repo: "postcss/postcss-selector-parser", ref: "1343320971957824a066207a534f9b69ac4faf53" },
  // The repository and the published package declare a license in package.json only and hold no license text.
  { name: "postcss-media-query-parser", license: "MIT (declared; no license text published)", repo: "dryoma/postcss-media-query-parser", ref: "640b0a662b8e918561b69ab79f7723327b3bbcbb", files: [] },
  // Prettier, and so Bun's port, uses version 2. Later versions are MPL-2.0.
  { name: "postcss-values-parser", license: "MIT", repo: "shellscape/postcss-values-parser", npm: "postcss-values-parser@2.0.1" },
  { name: "angular-html-parser", license: "MIT", repo: "prettier/angular-html-parser", ref: "0b9e1364456375554a28547c094e31afbcdf06ce" },
  { name: "graphql-js", license: "MIT", repo: "graphql/graphql-js", ref: "805fadd286dea7053b875f71c91222444c5d1228" },
  { name: "@glimmer/syntax", license: "MIT", repo: "glimmerjs/glimmer-vm", ref: "3c206686cea0c2dafad98eb4c3a8dc65cc572318" },
  { name: "simple-html-tokenizer", license: "MIT", repo: "tildeio/simple-html-tokenizer", ref: "f6190ebf9296154bbf065894e768eaa0795cd119" },
  { name: "@angular/compiler", license: "MIT", repo: "angular/angular", ref: "458303fe94d75ea94a662fa45d2030041bf10ea8" },
  { name: "yaml-unist-parser", license: "MIT", repo: "prettier/yaml-unist-parser", ref: "481e535d15305cabd8395514c036a2e0ac97e29c" },
  { name: "angular-estree-parser", license: "MIT", repo: "prettier/angular-estree-parser", ref: "0736295c913d564340e570fc81d1eb70398c7b70" },
  { name: "@handlebars/parser", license: "ISC (declared; no license text published)", repo: "handlebars-lang/handlebars-parser", ref: "c3c048f8fdd5039840351ef81aaa45309c9c66e1", files: [] },
  { name: "yaml", license: "ISC", repo: "eemeli/yaml", ref: "528ef30d6ded4bd9f2c3521b670eb2b29d503c5c" },
  { name: "@trivago/prettier-plugin-sort-imports", license: "Apache-2.0", repo: "trivago/prettier-plugin-sort-imports", ref: "d9c690fdbfe46334ec2bfb86a75ebde43c6a0fc6" },
  { name: "@ianvs/prettier-plugin-sort-imports", license: "Apache-2.0", repo: "ianvs/prettier-plugin-sort-imports", ref: "26bc50bd2f9846898fa3f8f4bac82cc1f55d7480" },
  { name: "jest-docblock", license: "MIT", repo: "jestjs/jest", ref: "61050e9323e742539dc2360236671110e37329e6" },
  { name: "sort-package-json (crate)", license: "MIT", repo: "oxc-project/sort-package-json", ref: "f493a866b42552a61f83295d232ee2c52dcf9d01" },
  { name: "oxc-toml (crate)", license: "MIT", repo: "oxc-project/oxc-toml", ref: "3239e42bad4dd0616901f1781961e9874e1f1157" },
  { name: "@babel/generator", license: "MIT", repo: "babel/babel", ref: "633b97541f68d7baa8dafc2864561da84971cfab" },
  { name: "micromark", license: "MIT", repo: "micromark/micromark", ref: "6577c200155e9c6b85a42b26d298f8affc348f2f" },
  { name: "editorconfig-without-wasm", license: "MIT", repo: "fisker/editorconfig-core-js-without-wasm", ref: "496eb07822711195926fe88d83ae6fbb41aba3e0" },
  { name: "emoji-regex", license: "MIT", repo: "mathiasbynens/emoji-regex", ref: "28a10d9e23663582faed522853d2ddae38868ca9" },
  { name: "get-east-asian-width", license: "MIT", repo: "sindresorhus/get-east-asian-width", ref: "a1b1c31d2347d10667c4bcad34c58bc531db3b41" },
  { name: "narrow-emojis", license: "MIT", repo: "fisker/narrow-emojis", ref: "ec5e1a1fd9a6d51f8b5d63fdb5c7fee2b50401f1" },
  { name: "prettier-plugin-tailwindcss", license: "MIT", repo: "tailwindlabs/prettier-plugin-tailwindcss", ref: "5b27f947f5d3e6de8702dc40d4054e02fbf4cdd8" },
  { name: "prettier-plugin-svelte", license: "MIT", repo: "sveltejs/prettier-plugin-svelte", ref: "7809486a9716faa2234c8a45d88b601034de52d8" },
  { name: "Svelte", license: "MIT", repo: "sveltejs/svelte", ref: "fe21fce019e7797a9eeb5066211ff42e4e7cca8d" },
  { name: "sort-package-json (npm)", license: "MIT", repo: "keithamus/sort-package-json", ref: "c09b95d1ae966a38e5036287d23629641f86d33e" },
  { name: "git-hooks-list", license: "MIT", repo: "fisker/git-hooks-list", ref: "79ffa6ce10ef9b5b1c7f898de19cedffd36b7e93" },
  // Polyfills embedded in the binary.
  { name: "acorn-walk", license: "MIT", repo: "acornjs/acorn", ref: "69788e23ca00483aef84005502dc3b88f2af38df", dir: "acorn-walk" },
  { name: "assert", license: "MIT", repo: "browserify/commonjs-assert", npm: "assert@2.1.0" },
  { name: "browserify-zlib", license: "MIT", repo: "devongovett/browserify-zlib", npm: "browserify-zlib@0.2.0" },
  { name: "buffer", license: "MIT", repo: "feross/buffer", npm: "buffer@5.0.5" },
  { name: "constants-browserify", license: "MIT", repo: "juliangruber/constants-browserify", ref: "6072360f955fe92be032b1772eb5145a6332d90d" },
  { name: "crypto-browserify", license: "MIT", repo: "browserify/crypto-browserify", npm: "crypto-browserify@3.12.1" },
  // Bun's LICENSE.md says MIT, but version 4.23.0, which Bun bundles, is Artistic-2.0.
  { name: "domain-browser", license: "Artistic-2.0", repo: "bevry/domain-browser", npm: "domain-browser@4.23.0" },
  { name: "events", license: "MIT", repo: "browserify/events", npm: "events@3.3.0" },
  // The repository no longer exists, so the published package is the source.
  { name: "https-browserify", license: "MIT", npm: "https-browserify@1.0.0" },
  { name: "os-browserify", license: "MIT", repo: "CoderPuppy/os-browserify", ref: "9e931aec1131f02a582f715b23c8f6d157622554" },
  { name: "path-browserify", license: "MIT", repo: "browserify/path-browserify", ref: "872fec31a8bac7b9b43be0e54ef3037e0202c5fb" },
  { name: "process", license: "MIT", repo: "defunctzombie/node-process", npm: "process@0.11.10" },
  { name: "punycode", license: "MIT", repo: "mathiasbynens/punycode.js", npm: "punycode@2.3.1" },
  { name: "querystring-es3", license: "MIT", repo: "SpainTrain/querystring-es3", npm: "querystring-es3@1.0.0-0" },
  { name: "stream-browserify", license: "MIT", repo: "browserify/stream-browserify", ref: "a3625cb4181c4bcdf09884e677d4320c641b8724" },
  { name: "stream-http", license: "MIT", repo: "jhiesey/stream-http", npm: "stream-http@3.2.0" },
  { name: "string_decoder", license: "MIT", repo: "nodejs/string_decoder", npm: "string_decoder@1.3.0" },
  { name: "timers-browserify", license: "MIT", repo: "browserify/timers-browserify", ref: "d8de8dddaf43f826111cf972423a16649bda479b" },
  { name: "tty-browserify", license: "MIT", repo: "browserify/tty-browserify", ref: "402e52bc734b0bb7adbfcc2e8ccddb75b4b74ae9" },
  { name: "url", license: "MIT", repo: "defunctzombie/node-url", ref: "455a3e2106bf254498615efc50a8dd5527be4132" },
  { name: "util", license: "MIT", repo: "browserify/node-util", npm: "util@0.12.5" },
  { name: "vm-browserify", license: "MIT", repo: "browserify/vm-browserify", ref: "033537b20cec686adecaa4dde61c91134d59bc41" },
  // Additional credits.
  { name: "esbuild", license: "MIT", repo: "evanw/esbuild", ref: "f6058f8364fe7ab91ca57a83e02577ed74c9cae4" },
];

const token = process.env["GITHUB_TOKEN"];

/** Returns the repository paths of the legal files directly inside one directory at one commit. */
async function legalFilesIn(repo: string, dir: string, commit: string): Promise<string[]> {
  const response = await fetch(`https://api.github.com/repos/${repo}/contents/${dir}?ref=${commit}`, {
    headers: { Accept: "application/vnd.github+json", ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
  });
  if (!response.ok) throw new Error(`listing ${repo}/${dir} at ${commit} returned ${response.status}`);
  const listing: unknown = await response.json();
  if (!Array.isArray(listing)) throw new Error(`${repo}/${dir} is not a directory`);
  const paths: string[] = [];
  for (const entry of listing) {
    if (isRecord(entry) && entry["type"] === "file" && typeof entry["name"] === "string" && typeof entry["path"] === "string" && LEGAL_FILE.test(entry["name"])) paths.push(entry["path"]);
  }
  return paths.sort();
}

async function commitExists(repo: string, ref: string): Promise<string | undefined> {
  const response = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
    headers: { Accept: "application/vnd.github.sha", ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
  });
  return response.ok ? (await response.text()).trim() : undefined;
}

async function npmManifest(spec: string): Promise<{ readonly version: string; readonly gitHead?: string; readonly tarball: string }> {
  const at = spec.lastIndexOf("@");
  const version = spec.slice(at + 1);
  const manifest: unknown = await (await fetch(`https://registry.npmjs.org/${spec.slice(0, at)}/${version}`)).json();
  const tarball = isRecord(manifest) && isRecord(manifest["dist"]) ? manifest["dist"]["tarball"] : undefined;
  if (typeof tarball !== "string") throw new Error(`${spec}: the registry has no such version`);
  const gitHead = isRecord(manifest) ? manifest["gitHead"] : undefined;
  return { version, tarball, ...(typeof gitHead === "string" ? { gitHead } : {}) };
}

async function resolveNpmCommit(repo: string, spec: string): Promise<string> {
  const { version, gitHead } = await npmManifest(spec);
  const candidates = [gitHead, `v${version}`, version];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const sha = await commitExists(repo, candidate);
    if (sha !== undefined) return sha;
  }
  throw new Error(`${spec}: neither its gitHead nor a version tag is a commit of ${repo}`);
}

async function resolveCommit(component: RepositoryComponent): Promise<string> {
  if ("npm" in component) return resolveNpmCommit(component.repo, component.npm);
  const sha = await commitExists(component.repo, component.ref);
  if (sha === undefined) throw new Error(`${component.name}: ${component.repo} has no commit ${component.ref}`);
  return sha;
}

async function legalPaths(component: RepositoryComponent, commit: string): Promise<string[]> {
  if (component.files !== undefined) return [...component.files];
  const dir = component.dir ?? "";
  const paths = await legalFilesIn(component.repo, dir, commit);
  if (paths.length === 0) throw new Error(`${component.name}: ${component.repo}/${dir} has no legal file at ${commit}`);
  return paths;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

async function fetchAt(component: RepositoryComponent, commit: string, path: string): Promise<Response> {
  const response = await fetch(`https://raw.githubusercontent.com/${component.repo}/${commit}/${path}`);
  if (!response.ok) throw new Error(`${component.name}: ${path} at ${commit} returned ${response.status}`);
  return response;
}

/**
 * Groups the opening comments of the source files by text, so that each distinct notice is printed once. A file that
 * opens with code carries no notice of its own and is listed as such.
 */
async function sourceNotices(component: RepositoryComponent, commit: string, paths: readonly string[]): Promise<Uint8Array> {
  const carriers = new Map<string, string[]>();
  const bare: string[] = [];
  for (const path of paths) {
    const notice = /^\s*(\/\*[\s\S]*?\*\/)/u.exec(await (await fetchAt(component, commit, path)).text())?.[1];
    if (notice === undefined) bare.push(path);
    else carriers.set(notice, [...(carriers.get(notice) ?? []), path]);
  }
  const sections = [...carriers].map(([notice, carrying]) => `Notice in ${carrying.join(", ")}:\n\n${notice}\n`);
  if (bare.length > 0) sections.push(`No notice of its own in ${bare.join(", ")}.\n`);
  return new TextEncoder().encode(sections.join("\n"));
}

async function reviewRepository(component: RepositoryComponent): Promise<{ readonly source: string; readonly documents: Map<string, Uint8Array> }> {
  const commit = await resolveCommit(component);
  const documents = new Map<string, Uint8Array>();
  for (const path of await legalPaths(component, commit)) documents.set(path, await (await fetchAt(component, commit, path)).bytes());
  if (component.sourceNotices !== undefined) documents.set("source-file-notices.txt", await sourceNotices(component, commit, component.sourceNotices));
  const location = component.dir === undefined ? "" : `/${component.dir}`;
  return { source: `https://github.com/${component.repo}/tree/${commit}${location}`, documents };
}

async function reviewPackage(component: PackageComponent): Promise<{ readonly source: string; readonly documents: Map<string, Uint8Array> }> {
  const { tarball } = await npmManifest(component.npm);
  const entries = await new Bun.Archive(await (await fetch(tarball)).bytes()).files();
  const documents = new Map<string, Uint8Array>();
  for (const [path, file] of entries) if (LEGAL_FILE.test(path.split("/").at(-1) ?? "")) documents.set(path, await file.bytes());
  if (documents.size === 0) throw new Error(`${component.name}: ${tarball} has no legal file`);
  return { source: tarball, documents };
}

async function review(root: string, component: Component): Promise<ReviewedRuntimeComponent> {
  const { source, documents } = "repo" in component ? await reviewRepository(component) : await reviewPackage(component);
  const folder = join(DESTINATION, "components", slug(component.name));
  const files: string[] = [];
  for (const [path, bytes] of [...documents].sort(([left], [right]) => left.localeCompare(right))) {
    const relative = join(folder, path.split("/").at(-1) ?? path);
    await Bun.write(join(root, relative), bytes);
    files.push(relative);
  }
  return { name: component.name, license: component.license, source, files };
}

if (import.meta.main) {
  const root = process.cwd();
  await rm(join(root, DESTINATION, "components"), { recursive: true, force: true });
  await mkdir(join(root, DESTINATION, "components"), { recursive: true });
  const reviewed: ReviewedRuntimeComponent[] = [];
  const failures: string[] = [];
  for (const component of COMPONENTS) {
    try {
      reviewed.push(await review(root, component));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  await Bun.write(join(root, DESTINATION, "components.json"), `${JSON.stringify(reviewed, null, 2)}\n`);
  console.log(`Reviewed ${reviewed.length} of ${COMPONENTS.length} components.`);
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  }
}
