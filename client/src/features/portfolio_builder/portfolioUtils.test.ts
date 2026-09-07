/**
 * Portfolio Builder Utilities Tests
 */

import { describe, it, expect } from "vitest";
import {
    calculateBlendedApy,
    isValidAllocation,
    distributeAmount,
    normalizeWeights,
    applyPreset,
    calculateTotalAllocation,
    formatAllocationSum,
} from "./portfolioUtils";
import type { VaultAllocation } from "./types";

describe("Portfolio Utils", () => {
    const mockAllocations: VaultAllocation[] = [
        {
            vaultContractId: "vault1",
            vaultName: "Vault A",
            apy: 10,
            weight: 50,
            amount: 0n,
        },
        {
            vaultContractId: "vault2",
            vaultName: "Vault B",
            apy: 8,
            weight: 50,
            amount: 0n,
        },
    ];

    it("should calculate blended APY correctly", () => {
        const apy = calculateBlendedApy(mockAllocations);
        expect(apy).toBe(9); // (10 * 0.5) + (8 * 0.5)
    });

    it("should validate valid allocations", () => {
        expect(isValidAllocation(mockAllocations)).toBe(true);
    });

    it("should reject invalid allocations", () => {
        const invalid = [
            { ...mockAllocations[0], weight: 60 },
            { ...mockAllocations[1], weight: 30 },
        ];
        expect(isValidAllocation(invalid)).toBe(false);
    });

    it("should distribute amount correctly", () => {
        const total = 10000n;
        const distributed = distributeAmount(total, mockAllocations);

        const sum = distributed.reduce((acc, a) => acc + a.amount, 0n);
        expect(sum).toBe(total);
    });

    it("should handle rounding in distribution", () => {
        const total = 10001n; // Odd number to test rounding
        const distributed = distributeAmount(total, mockAllocations);

        const sum = distributed.reduce((acc, a) => acc + a.amount, 0n);
        expect(sum).toBe(total);
    });

    it("should normalize weights to exactly 100%", () => {
        const unbalanced = [
            { ...mockAllocations[0], weight: 40 },
            { ...mockAllocations[1], weight: 40 },
        ];

        const normalized = normalizeWeights(unbalanced);
        const totalWeight = normalized.reduce((sum, a) => sum + a.weight, 0);

        expect(totalWeight).toBe(100);
    });

    it("should handle three vaults", () => {
        const threeVaults: VaultAllocation[] = [
            { vaultContractId: "v1", vaultName: "A", apy: 10, weight: 33.33, amount: 0n },
            { vaultContractId: "v2", vaultName: "B", apy: 8, weight: 33.33, amount: 0n },
            { vaultContractId: "v3", vaultName: "C", apy: 12, weight: 33.34, amount: 0n },
        ];

        expect(isValidAllocation(threeVaults)).toBe(true);
        const apy = calculateBlendedApy(threeVaults);
        expect(apy).toBeCloseTo(10.0002, 2);
    });

    describe("calculateTotalAllocation", () => {
        it("returns 0 for empty allocations array", () => {
            expect(calculateTotalAllocation([])).toBe(0);
        });

        it("sums standard 100% allocation correctly", () => {
            expect(calculateTotalAllocation(mockAllocations)).toBe(100);
        });

        it("sums single 100% allocation correctly", () => {
            const single: VaultAllocation[] = [
                { vaultContractId: "v1", vaultName: "Solo", apy: 5, weight: 100, amount: 0n },
            ];
            expect(calculateTotalAllocation(single)).toBe(100);
        });

        it("sums under-allocated (non-100%) weights accurately", () => {
            const underAllocated: VaultAllocation[] = [
                { vaultContractId: "v1", vaultName: "A", apy: 5, weight: 40, amount: 0n },
                { vaultContractId: "v2", vaultName: "B", apy: 7, weight: 30, amount: 0n },
            ];
            expect(calculateTotalAllocation(underAllocated)).toBe(70);
        });

        it("sums over-allocated (non-100%) weights accurately", () => {
            const overAllocated: VaultAllocation[] = [
                { vaultContractId: "v1", vaultName: "A", apy: 5, weight: 65.5, amount: 0n },
                { vaultContractId: "v2", vaultName: "B", apy: 7, weight: 55.5, amount: 0n },
            ];
            expect(calculateTotalAllocation(overAllocated)).toBeCloseTo(121, 5);
        });

        it("handles fractional decimal weights accurately", () => {
            const fractional: VaultAllocation[] = [
                { vaultContractId: "v1", vaultName: "A", apy: 5, weight: 33.33, amount: 0n },
                { vaultContractId: "v2", vaultName: "B", apy: 6, weight: 33.33, amount: 0n },
                { vaultContractId: "v3", vaultName: "C", apy: 7, weight: 33.34, amount: 0n },
            ];
            expect(calculateTotalAllocation(fractional)).toBeCloseTo(100, 5);
        });

        it("safely handles non-finite or NaN weight properties", () => {
            const invalidWeights: VaultAllocation[] = [
                { vaultContractId: "v1", vaultName: "A", apy: 5, weight: Number.NaN, amount: 0n },
                { vaultContractId: "v2", vaultName: "B", apy: 6, weight: 50, amount: 0n },
            ];
            expect(calculateTotalAllocation(invalidWeights)).toBe(50);
        });
    });

    describe("formatAllocationSum", () => {
        it("formats 100% numeric state deterministically", () => {
            expect(formatAllocationSum(100)).toBe("100.0%");
        });

        it("formats 100% allocation array deterministically", () => {
            expect(formatAllocationSum(mockAllocations)).toBe("100.0%");
        });

        it("formats non-100% under-allocated numeric state deterministically", () => {
            expect(formatAllocationSum(70)).toBe("70.0%");
            expect(formatAllocationSum(45.5)).toBe("45.5%");
            expect(formatAllocationSum(0)).toBe("0.0%");
        });

        it("formats non-100% under-allocated allocation array deterministically", () => {
            const underAllocated: VaultAllocation[] = [
                { vaultContractId: "v1", vaultName: "A", apy: 5, weight: 35.2, amount: 0n },
                { vaultContractId: "v2", vaultName: "B", apy: 7, weight: 25.1, amount: 0n },
            ];
            expect(formatAllocationSum(underAllocated)).toBe("60.3%");
        });

        it("formats non-100% over-allocated numeric state deterministically", () => {
            expect(formatAllocationSum(125)).toBe("125.0%");
            expect(formatAllocationSum(150.75)).toBe("150.8%");
        });

        it("formats non-100% over-allocated allocation array deterministically", () => {
            const overAllocated: VaultAllocation[] = [
                { vaultContractId: "v1", vaultName: "A", apy: 5, weight: 60, amount: 0n },
                { vaultContractId: "v2", vaultName: "B", apy: 7, weight: 60, amount: 0n },
            ];
            expect(formatAllocationSum(overAllocated)).toBe("120.0%");
        });

        it("formats empty array as 0.0%", () => {
            expect(formatAllocationSum([])).toBe("0.0%");
        });

        it("supports custom decimal precision", () => {
            expect(formatAllocationSum(100, 2)).toBe("100.00%");
            expect(formatAllocationSum(33.3333, 2)).toBe("33.33%");
            expect(formatAllocationSum(100, 0)).toBe("100%");
        });

        it("handles edge cases such as negative epsilon and NaN gracefully", () => {
            expect(formatAllocationSum(-0)).toBe("0.0%");
            expect(formatAllocationSum(Number.NaN)).toBe("0.0%");
            expect(formatAllocationSum(Number.POSITIVE_INFINITY)).toBe("0.0%");
        });
    });

    describe("applyPreset", () => {
        const availableVaults = [
            { contractId: "v1", name: "Safe", apy: 5 },
            { contractId: "v2", name: "Mid", apy: 10 },
            { contractId: "v3", name: "Aggro", apy: 20 },
        ];

        it("should apply conservative preset", () => {
            const allocations = applyPreset(availableVaults, "conservative");
            expect(isValidAllocation(allocations)).toBe(true);
            // v1 is safest (lowest APY)
            const safe = allocations.find(a => a.vaultContractId === "v1");
            expect(safe?.weight).toBe(60);
        });

        it("should apply aggressive preset", () => {
            const allocations = applyPreset(availableVaults, "aggressive");
            expect(isValidAllocation(allocations)).toBe(true);
            // v3 is riskiest (highest APY)
            const aggro = allocations.find(a => a.vaultContractId === "v3");
            expect(aggro?.weight).toBe(60);
        });

        it("should apply balanced preset", () => {
            const allocations = applyPreset(availableVaults, "balanced");
            expect(isValidAllocation(allocations)).toBe(true);
            allocations.forEach(a => expect(a.weight).toBeCloseTo(33.33, 1));
        });

        it("should apply stablecoin-heavy preset", () => {
            const allocations = applyPreset(availableVaults, "stablecoin-heavy");
            expect(isValidAllocation(allocations)).toBe(true);
            const safe = allocations.find(a => a.vaultContractId === "v1");
            expect(safe?.weight).toBe(100);
        });

        it("should handle empty vaults", () => {
            expect(applyPreset([], "balanced")).toEqual([]);
        });
    });
});
