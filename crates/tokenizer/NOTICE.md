# Flywheel tokenizer notices

The portable tokenizer artifact in this directory contains adapted source and data from the projects listed below. The license files named in each section are part of this crate distribution.

## Oh My Pi tokenizer

The tokenizer implementation is adapted from Oh My Pi (OMP), revision `a1b254047d12e143b7c6011536e918c6c35c5906`, from <https://github.com/can1357/oh-my-pi>. It is licensed under the MIT License in `LICENSE.omp` and carries Copyright (c) 2025-2026 Can Bölük and Copyright (c) 2026 Stencil Labs, Inc.

The adapted OMP source list is:

- `src/utok/bpe.rs`
- `src/utok/claude/constants.rs`
- `src/utok/claude/engine.rs`
- `src/utok/claude/mod.rs`
- `src/utok/claude/normalize.rs`
- `src/utok/claude/testdata/fixtures.json`
- `src/utok/claude/testdata/sonnet5_live.json`
- `src/utok/mod.rs`
- `src/utok/pretoken.rs`
- `src/utok/scan/mod.rs`
- `src/utok/scan/o200k.rs`
- `src/utok/utf.rs`
- `fixtures/corpus.json`

Flywheel narrows this material to token counting for O200k and Claude tokenizer families, removes unrelated tokenizer families and Node bindings, exposes a small UTF-16 WebAssembly ABI, and embeds only the required compact tables. These are adaptations by the Flywheel contributors, not an OMP release.

## Claude vocabulary data and ctok

`data/ctok_v3.bin.zst` and `data/ctok_v4_7.bin.zst` originate from the measured vocabulary files in sanderland/ctok v1.0.0, revision `df3b59b5e645289a5eadc8e24036b99d39c333c4`, from <https://github.com/sanderland/ctok>. The data and adapted implementation are licensed under the MIT License in `LICENSE.ctok`. The tracked compressed files have SHA-256 digests `8791577f60f6c5cfd8b9c85c7cd560c6040e2dd25b9fbe5f6feac7e35e9748b1` and `6083d7b803771bc55c537cc3a928d36fcc7104b3c802909e2a73d2bf15f7a458`, respectively.

OMP converted ctok's measured pieces into its compact, front-coded binary representation and supplied the Rust count-only implementation. Flywheel retains that representation and makes only the narrow adaptations described above.

## OpenAI tiktoken vocabulary

`data/o200k_base.bin.zst` originates from OpenAI's public `o200k_base.tiktoken` vocabulary at <https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken>. OMP packed the rank-ordered vocabulary into its UTOK1 container and compressed it with zstd. The tracked compressed file has SHA-256 digest `0e259657a96681b696e63490a50afed27a53a671fbed7aa9fd9a22908273414a`. tiktoken is licensed under the MIT License in `LICENSE.tiktoken`, Copyright (c) 2022 OpenAI and Shantanu Jain.

## xutf

The crate links xutf 1.4.0 from <https://crates.io/crates/xutf/1.4.0>, Cargo checksum `a14f3ca7038796715a5f5fd1c22aac21423b4f86fd9ef5585ef1744a5cfc573e`. xutf supplies Unicode normalization and character-category data. It is licensed under the MIT License in `LICENSE.xutf`, Copyright (c) 2026 Can Bölük.

## Rust standard library

The WebAssembly artifact statically links the Rust standard library for `wasm32-unknown-unknown`. It was built with `nightly-2026-07-28`, rustc commit `09ee43b2d6055539771bee8ac30a6e56eb4db773`. The target archive is <https://static.rust-lang.org/dist/2026-07-28/rust-std-nightly-wasm32-unknown-unknown.tar.xz>, SHA-256 `b96f9154922368d06628eb2dba683a027e58ea328ff8ff3bbdd6d056780f5bbc`.

Rust standard-library copyright and dependency notices are preserved in `COPYRIGHT-library`. Its MIT and Apache License 2.0 terms are preserved in `LICENSE.rust-std-MIT` and `LICENSE.rust-std-APACHE`.

## Fixture interpretation

The JSON files under `fixtures/` and `src/utok/claude/testdata/` are verification fixtures, not additional runtime vocabularies. Each fixture row is interpreted as one input frame. A check is one expected tokenizer-family count for that frame. The tracked inventory therefore represents 6 corpus frames with 30 checks, 493 Claude frames with 1,479 checks, and 63 Sonnet frames with 63 checks, for 1,572 checks in total. The Claude expected counts include the recorded message-level offsets documented by `tokenizer-prebuilt.json`; runtime `count` returns content-token counts and does not add those fixture offsets.

## Reproducibility

`tokenizer-prebuilt.json` is the canonical fingerprint for the committed artifact. It pins the upstream revisions, toolchain, target archive, source hash, Cargo manifests, vocabulary hashes, fixture inventory, WebAssembly ABI, and compressed and uncompressed artifact hashes. `scripts/build-tokenizer.ts` verifies those pins and reproduces the artifact.
