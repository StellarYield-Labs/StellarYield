import { createHash } from "crypto";

/**
 * Represents a single reward allocation for a user.
 */
export interface RewardEntry {
  /** Stellar wallet address of the recipient. */
  address: string;
  /** Stellar token contract/address for this reward campaign. */
  token: string;
  /** Reward amount in stroops (1 YIELD = 10^7 stroops). */
  amount: string;
  /** Campaign or epoch identifier for the distribution. */
  campaignId: number;
  /** Optional metadata hash as a 32-byte hex string. */
  metadataHash?: string;
}

/**
 * A normalized claim payload generated from the Merkle tree.
 */
export interface MerkleClaim {
  /** Positional leaf index within the tree. */
  index: number;
  /** Stellar wallet address of the recipient. */
  address: string;
  /** Stellar token contract/address for this reward campaign. */
  token: string;
  /** Reward amount in stroops. */
  amount: string;
  /** Campaign or epoch identifier for the distribution. */
  campaignId: number;
  /** Canonical 32-byte metadata hash, zeroed when omitted. */
  metadataHash: string;
  /** Merkle proof siblings as 32-byte hex strings. */
  proof: string[];
}

/**
 * The output of generating a Merkle tree: root hash and per-user proofs.
 */
export interface MerkleTreeResult {
  /** The 32-byte Merkle root as a hex string. */
  root: string;
  /** Per-user claim data with proofs. */
  claims: Record<string, MerkleClaim>;
}

/**
 * Compute the SHA-256 hash of a buffer.
 */
function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * Zero hash used for omitted metadata.
 */
export const ZERO_METADATA_HASH = "0".repeat(64);

/**
 * Normalize an optional metadata hash into a canonical 32-byte lowercase hex string.
 */
export function normalizeMetadataHash(metadataHash?: string): string {
  if (metadataHash === undefined || metadataHash === null || metadataHash === "") {
    return ZERO_METADATA_HASH;
  }

  const normalized = metadataHash.startsWith("0x")
    ? metadataHash.slice(2)
    : metadataHash;

  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("metadataHash must be a 32-byte hex string");
  }

  return normalized.toLowerCase();
}

/**
 * Encode a positive campaign identifier as 4-byte big-endian.
 */
function encodeCampaignId(campaignId: number): Buffer {
  if (!Number.isInteger(campaignId) || campaignId < 0 || campaignId > 0xffffffff) {
    throw new Error("campaignId must be a uint32");
  }

  const campaignBuf = Buffer.alloc(4);
  campaignBuf.writeUInt32BE(campaignId, 0);
  return campaignBuf;
}

/**
 * Encode an i128-compatible decimal string as 16-byte big-endian.
 */
function encodeAmount(amount: string): Buffer {
  const amountBigInt = BigInt(amount);
  const amountBuf = Buffer.alloc(16);
  let val = amountBigInt;

  for (let i = 15; i >= 0; i--) {
    amountBuf[i] = Number(val & BigInt(0xff));
    val >>= BigInt(8);
  }

  return amountBuf;
}

/**
 * Compute a leaf hash matching the on-chain formula:
 * SHA256(recipient || token || amount || campaign_id || metadata_hash).
 *
 * @param address      - The Stellar wallet address string.
 * @param token        - The token contract/address string.
 * @param amount       - The reward amount as a bigint-compatible string (int128, big-endian).
 * @param campaignId   - The campaign or epoch identifier (uint32, big-endian).
 * @param metadataHash - Optional 32-byte metadata hash.
 */
export function computeLeaf(
  address: string,
  token: string,
  amount: string,
  campaignId: number,
  metadataHash?: string,
): Buffer {
  const recipientBuf = Buffer.from(address, "utf-8");
  const tokenBuf = Buffer.from(token, "utf-8");
  const amountBuf = encodeAmount(amount);
  const campaignBuf = encodeCampaignId(campaignId);
  const metadataBuf = Buffer.from(normalizeMetadataHash(metadataHash), "hex");

  return sha256(
    Buffer.concat([recipientBuf, tokenBuf, amountBuf, campaignBuf, metadataBuf]),
  );
}

/**
 * Hash two 32-byte values together in sorted order (smaller first).
 * Matches the on-chain `hash_pair` function.
 */
export function hashPair(a: Buffer, b: Buffer): Buffer {
  if (a.compare(b) <= 0) {
    return sha256(Buffer.concat([a, b]));
  }
  return sha256(Buffer.concat([b, a]));
}

/**
 * Generate a Merkle tree from a list of reward entries.
 *
 * Builds the tree bottom-up using sorted-pair hashing, then extracts
 * per-user proofs for on-chain verification.
 *
 * @param entries - The list of reward allocations.
 * @returns The Merkle root and per-user claim data with proofs.
 */
export function generateMerkleTree(entries: RewardEntry[]): MerkleTreeResult {
  if (entries.length === 0) {
    return { root: "0".repeat(64), claims: {} };
  }

  // Compute leaves
  const leaves: Buffer[] = entries.map((entry) =>
    computeLeaf(
      entry.address,
      entry.token,
      entry.amount,
      entry.campaignId,
      entry.metadataHash,
    ),
  );

  // Build tree layers (bottom-up)
  const layers: Buffer[][] = [leaves];

  let currentLayer = leaves;
  while (currentLayer.length > 1) {
    const nextLayer: Buffer[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      if (i + 1 < currentLayer.length) {
        nextLayer.push(hashPair(currentLayer[i], currentLayer[i + 1]));
      } else {
        // Odd node: promote to next level
        nextLayer.push(currentLayer[i]);
      }
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  const root = currentLayer[0].toString("hex");

  // Extract proofs for each leaf
  const claims: MerkleTreeResult["claims"] = {};

  for (const [entryIndex, entry] of entries.entries()) {
    const proof: string[] = [];
    let idx = entryIndex;

    for (let layerIdx = 0; layerIdx < layers.length - 1; layerIdx++) {
      const layer = layers[layerIdx];
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;

      if (siblingIdx < layer.length) {
        proof.push(layer[siblingIdx].toString("hex"));
      }

      idx = Math.floor(idx / 2);
    }

    claims[entry.address] = {
      index: entryIndex,
      address: entry.address,
      token: entry.token,
      amount: entry.amount,
      campaignId: entry.campaignId,
      metadataHash: normalizeMetadataHash(entry.metadataHash),
      proof,
    };
  }

  return { root, claims };
}

/**
 * Verify a single Merkle proof against a root.
 *
 * @param root    - The expected Merkle root (hex string).
 * @param address - The claimant address.
 * @param token   - The reward token address.
 * @param amount  - The claim amount.
 * @param campaignId - The campaign/epoch identifier.
 * @param metadataHash - Optional metadata hash bound to the claim.
 * @param proof   - The Merkle proof (array of hex strings).
 * @returns Whether the proof is valid.
 */
export function verifyProof(
  root: string,
  address: string,
  token: string,
  amount: string,
  campaignId: number,
  metadataHash: string | undefined,
  proof: string[],
): boolean {
  let computed = computeLeaf(address, token, amount, campaignId, metadataHash);

  for (const proofHex of proof) {
    const proofElement = Buffer.from(proofHex, "hex");
    computed = hashPair(computed, proofElement);
  }

  return computed.toString("hex") === root;
}
