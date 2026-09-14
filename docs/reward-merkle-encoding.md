# Reward Merkle Encoding

## Purpose

Reward distributions depend on the off-chain generator and the on-chain
`merkle_distributor` contract producing the exact same leaf bytes. This
document defines the canonical encoding used by both implementations.

## Canonical Leaf

Each claim leaf is:

```text
sha256(recipient || token || amount || campaign_id || metadata_hash)
```

Fields are concatenated in this exact order:

1. `recipient`
2. `token`
3. `amount`
4. `campaign_id`
5. `metadata_hash`

## Field Encoding

- `recipient`: UTF-8 bytes of the Stellar address string.
- `token`: UTF-8 bytes of the reward token address string.
- `amount`: signed 128-bit integer encoded as 16-byte big-endian.
- `campaign_id`: unsigned 32-bit integer encoded as 4-byte big-endian.
- `metadata_hash`: 32 raw bytes.

## Optional Metadata

When no metadata hash is provided, both implementations must use a
32-byte zero hash:

```text
0000000000000000000000000000000000000000000000000000000000000000
```

## Merkle Tree Rules

- Leaves are hashed with SHA-256.
- Parent nodes use sorted-pair hashing:
  `sha256(min(left, right) || max(left, right))`
- Odd nodes are promoted unchanged to the next layer.

## Claim Safety

- Claims are tracked by `(campaign_id, recipient)` on-chain.
- A proof cannot be reused for a second claim in the same campaign.
- The same recipient can claim again in a later campaign when a new root is set.
- Wrong amount, wrong recipient, wrong campaign, wrong metadata hash, and reused proofs must fail.

## Shared Test Vectors

Shared vectors live in:

`backend/rewards/src/__tests__/fixtures/rewardMerkleVectors.json`

These vectors are consumed by both:

- the TypeScript rewards tests in `backend/rewards`
- the Rust contract tests in `contracts/merkle_distributor`

Any future change to the leaf schema must update this document and the shared vectors in the same pull request.
