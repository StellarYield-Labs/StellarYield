export interface TreasuryPreset {
  id: string;
  name: string;
  description: string;
  allocations: {
    vaultId: string;
    vaultName: string;
    allocationPct: number;
  }[];
}

export const TREASURY_PRESETS: TreasuryPreset[] = [
  {
    id: "conservative",
    name: "Conservative",
    description: "Low-risk, capital preservation focused allocation",
    allocations: [
      { vaultId: "blend", vaultName: "Blend", allocationPct: 60 },
      { vaultId: "soroswap", vaultName: "Soroswap", allocationPct: 20 },
      { vaultId: "defindex", vaultName: "DeFindex", allocationPct: 20 },
    ],
  },
  {
    id: "balanced",
    name: "Balanced",
    description: "Moderate risk, balanced growth and income",
    allocations: [
      { vaultId: "blend", vaultName: "Blend", allocationPct: 40 },
      { vaultId: "soroswap", vaultName: "Soroswap", allocationPct: 35 },
      { vaultId: "defindex", vaultName: "DeFindex", allocationPct: 25 },
    ],
  },
  {
    id: "aggressive",
    name: "Aggressive",
    description: "High risk, maximum growth focus",
    allocations: [
      { vaultId: "blend", vaultName: "Blend", allocationPct: 15 },
      { vaultId: "soroswap", vaultName: "Soroswap", allocationPct: 55 },
      { vaultId: "defindex", vaultName: "DeFindex", allocationPct: 30 },
    ],
  },
  {
    id: "liquidity-defense",
    name: "Liquidity Defense",
    description: "Emergency liquidity preservation mode",
    allocations: [
      { vaultId: "blend", vaultName: "Blend", allocationPct: 70 },
      { vaultId: "soroswap", vaultName: "Soroswap", allocationPct: 10 },
      { vaultId: "defindex", vaultName: "DeFindex", allocationPct: 20 },
    ],
  },
];
