/**
 * vaultData.ts
 *
 * Fetches live APY and TVL for a given vault slug from the yields API.
 */

import { apiUrl } from "./api";

/** Supported vault slugs mapped to their display names and asset symbols. */
export const VAULT_REGISTRY: Record<string, { name: string; asset: string; protocol: string }> = {
  usdc:       { name: "USDC Yield Vault",    asset: "USDC",       protocol: "Blend" },
  xlm:        { name: "XLM Yield Vault",     asset: "XLM",        protocol: "Blend" },
  "xlm-usdc": { name: "XLM-USDC LP Vault",  asset: "XLM-USDC",   protocol: "Soroswap" },
  "xlm-eth":  { name: "XLM-ETH LP Vault",   asset: "XLM-ETH",    protocol: "Soroswap" },
  index:      { name: "Yield Index Vault",   asset: "Yield Index", protocol: "DeFindex" },
  bluechip:   { name: "Blue Chip Vault",     asset: "Blue Chip",  protocol: "DeFindex" },
};

export interface VaultStats {
  name: string;
  asset: string;
  protocol: string;
  apy: number;
  tvl: number;
  /** Whether the data came from the live API (true) or fallback defaults (false). */
  live: boolean;
}

interface YieldsApiEntry {
  protocol: string;
  asset: string;
  apy: number;
  tvl: number;
  risk: string;
}

export interface VaultValidationResult {
  valid: boolean;
  normalized: string;
}

/**
 * Validates and normalizes a vault slug.
 *
 * @param slug - The raw slug string to validate
 * @returns Object indicating if valid and the normalized slug
 */
export function validateVaultSlug(slug: string | undefined): VaultValidationResult {
  if (!slug) {
    return { valid: false, normalized: "" };
  }

  const normalized = slug.trim().toLowerCase();
  const valid = normalized in VAULT_REGISTRY;

  return { valid, normalized };
}

/**
 * Fetches vault stats for the given slug.
 *
 * @param slug   - Vault identifier (e.g. "usdc", "xlm-usdc")
 */
export async function fetchVaultStats(
  slug: string,
): Promise<VaultStats | null> {
  const { valid, normalized } = validateVaultSlug(slug);
  if (!valid) return null;

  const meta = VAULT_REGISTRY[normalized];

  try {
    const res = await fetch(apiUrl("/api/yields"));

    if (!res.ok) throw new Error(`yields API ${res.status}`);

    const data: YieldsApiEntry[] = await res.json();
    const entry = data.find(
      (d) =>
        d.protocol.toLowerCase() === meta.protocol.toLowerCase() &&
        d.asset.toLowerCase() === meta.asset.toLowerCase(),
    );

    return {
      ...meta,
      apy: entry?.apy ?? 0,
      tvl: entry?.tvl ?? 0,
      live: !!entry,
    };
  } catch (error) {
    console.error("Error fetching vault stats:", error);
    // Graceful degradation: return meta with zeroed stats, marked as not live
    return { ...meta, apy: 0, tvl: 0, live: false };
  }
}

/**
 * Formats a TVL number into a human-readable string (e.g. "$2.45M").
 *
 * @param value - Raw TVL in USD
 */
export function formatTvl(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toLocaleString()}`;
}
