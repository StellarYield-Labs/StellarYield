import { describe, it, expect, vi } from "vitest";
import {
  validateRegistry,
  getContractId,
  getAllContractIds,
  CONTRACT_NAMES,
} from "./contractRegistry";

describe("contractRegistry", () => {
  describe("validateRegistry", () => {
    it("returns empty warnings when all contracts are configured", () => {
      vi.stubEnv("VITE_CONTRACT_ID", "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEZG7");
      vi.stubEnv("VITE_ZAP_CONTRACT_ID", "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBZG7");
      vi.stubEnv("VITE_TOKEN_CONTRACT_ID", "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCZG7");
      vi.stubEnv("VITE_GOVERNANCE_CONTRACT_ID", "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDZG7");
      vi.stubEnv("VITE_STRATEGY_CONTRACT_ID", "CEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEZG7");
      vi.stubEnv("VITE_EMISSION_CONTROLLER_CONTRACT_ID", "CFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFZG7");
      vi.stubEnv("VITE_LIQUID_STAKING_CONTRACT_ID", "CGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGZG7");
      vi.stubEnv("VITE_STABLESWAP_CONTRACT_ID", "CHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHZG7");

      const result = validateRegistry("testnet");
      expect(result.missingContracts).toEqual([]);
      expect(result.warningMessage).toBe("");
    });

    it("detects missing contracts", () => {
      vi.stubEnv("VITE_CONTRACT_ID", "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEZG7");
      vi.stubEnv("VITE_ZAP_CONTRACT_ID", "");
      vi.stubEnv("VITE_TOKEN_CONTRACT_ID", "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCZG7");
      vi.stubEnv("VITE_GOVERNANCE_CONTRACT_ID", "");
      vi.stubEnv("VITE_STRATEGY_CONTRACT_ID", "CEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEZG7");
      vi.stubEnv("VITE_EMISSION_CONTROLLER_CONTRACT_ID", "");
      vi.stubEnv("VITE_LIQUID_STAKING_CONTRACT_ID", "CGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGZG7");
      vi.stubEnv("VITE_STABLESWAP_CONTRACT_ID", "");

      const result = validateRegistry("testnet");
      expect(result.missingContracts).toEqual(["emissionController", "governance", "stableswap", "zap"]);
      expect(result.warningMessage).toContain("Missing contract IDs for testnet:");
      expect(result.warningMessage).toContain("- emissionController");
      expect(result.warningMessage).toContain("- governance");
      expect(result.warningMessage).toContain("- stableswap");
      expect(result.warningMessage).toContain("- zap");
    });

    it("treats empty string as missing", () => {
      vi.stubEnv("VITE_CONTRACT_ID", "");
      vi.stubEnv("VITE_ZAP_CONTRACT_ID", "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBZG7");
      vi.stubEnv("VITE_TOKEN_CONTRACT_ID", "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCZG7");
      vi.stubEnv("VITE_GOVERNANCE_CONTRACT_ID", "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDZG7");
      vi.stubEnv("VITE_STRATEGY_CONTRACT_ID", "CEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEZG7");
      vi.stubEnv("VITE_EMISSION_CONTROLLER_CONTRACT_ID", "CFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFZG7");
      vi.stubEnv("VITE_LIQUID_STAKING_CONTRACT_ID", "CGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGZG7");
      vi.stubEnv("VITE_STABLESWAP_CONTRACT_ID", "CHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHZG7");

      const result = validateRegistry("testnet");
      expect(result.missingContracts).toEqual(["vault"]);
    });

    it("treats whitespace-only string as missing", () => {
      vi.stubEnv("VITE_CONTRACT_ID", "   ");
      vi.stubEnv("VITE_ZAP_CONTRACT_ID", "\t\n");
      vi.stubEnv("VITE_TOKEN_CONTRACT_ID", "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCZG7");
      vi.stubEnv("VITE_GOVERNANCE_CONTRACT_ID", "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDZG7");
      vi.stubEnv("VITE_STRATEGY_CONTRACT_ID", "CEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEZG7");
      vi.stubEnv("VITE_EMISSION_CONTROLLER_CONTRACT_ID", "CFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFZG7");
      vi.stubEnv("VITE_LIQUID_STAKING_CONTRACT_ID", "CGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGZG7");
      vi.stubEnv("VITE_STABLESWAP_CONTRACT_ID", "CHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHZG7");

      const result = validateRegistry("testnet");
      expect(result.missingContracts).toEqual(["vault", "zap"]);
    });

    it("returns stable deterministic ordering across repeated calls", () => {
      vi.stubEnv("VITE_CONTRACT_ID", "");
      vi.stubEnv("VITE_ZAP_CONTRACT_ID", "");
      vi.stubEnv("VITE_TOKEN_CONTRACT_ID", "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCZG7");
      vi.stubEnv("VITE_GOVERNANCE_CONTRACT_ID", "");
      vi.stubEnv("VITE_STRATEGY_CONTRACT_ID", "");
      vi.stubEnv("VITE_EMISSION_CONTROLLER_CONTRACT_ID", "");
      vi.stubEnv("VITE_LIQUID_STAKING_CONTRACT_ID", "");
      vi.stubEnv("VITE_STABLESWAP_CONTRACT_ID", "");

      const results = Array.from({ length: 10 }, () => validateRegistry("testnet"));
      const firstOrder = results[0].missingContracts;
      for (const result of results) {
        expect(result.missingContracts).toEqual(firstOrder);
      }
    });

    it("includes network in the result", () => {
      vi.stubEnv("VITE_CONTRACT_ID", "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEZG7");
      vi.stubEnv("VITE_ZAP_CONTRACT_ID", "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBZG7");
      vi.stubEnv("VITE_TOKEN_CONTRACT_ID", "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCZG7");
      vi.stubEnv("VITE_GOVERNANCE_CONTRACT_ID", "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDZG7");
      vi.stubEnv("VITE_STRATEGY_CONTRACT_ID", "CEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEZG7");
      vi.stubEnv("VITE_EMISSION_CONTROLLER_CONTRACT_ID", "CFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFZG7");
      vi.stubEnv("VITE_LIQUID_STAKING_CONTRACT_ID", "CGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGZG7");
      vi.stubEnv("VITE_STABLESWAP_CONTRACT_ID", "CHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHZG7");

      const result = validateRegistry("mainnet");
      expect(result.network).toBe("mainnet");
    });

    it("handles unknown network gracefully", () => {
      vi.stubEnv("VITE_CONTRACT_ID", "");
      vi.stubEnv("VITE_ZAP_CONTRACT_ID", "");
      vi.stubEnv("VITE_TOKEN_CONTRACT_ID", "");
      vi.stubEnv("VITE_GOVERNANCE_CONTRACT_ID", "");
      vi.stubEnv("VITE_STRATEGY_CONTRACT_ID", "");
      vi.stubEnv("VITE_EMISSION_CONTROLLER_CONTRACT_ID", "");
      vi.stubEnv("VITE_LIQUID_STAKING_CONTRACT_ID", "");
      vi.stubEnv("VITE_STABLESWAP_CONTRACT_ID", "");

      const result = validateRegistry("testnet");
      expect(result.network).toBe("testnet");
      expect(result.missingContracts).toHaveLength(CONTRACT_NAMES.length);
    });

    it("never throws", () => {
      expect(() => validateRegistry("testnet")).not.toThrow();
      expect(() => validateRegistry("mainnet")).not.toThrow();
      expect(() => validateRegistry("local")).not.toThrow();
    });
  });

  describe("getContractId", () => {
    it("returns empty string for missing contract", () => {
      vi.stubEnv("VITE_CONTRACT_ID", "");
      vi.stubEnv("VITE_ZAP_CONTRACT_ID", "");
      vi.stubEnv("VITE_TOKEN_CONTRACT_ID", "");
      vi.stubEnv("VITE_GOVERNANCE_CONTRACT_ID", "");
      vi.stubEnv("VITE_STRATEGY_CONTRACT_ID", "");
      vi.stubEnv("VITE_EMISSION_CONTROLLER_CONTRACT_ID", "");
      vi.stubEnv("VITE_LIQUID_STAKING_CONTRACT_ID", "");
      vi.stubEnv("VITE_STABLESWAP_CONTRACT_ID", "");

      expect(getContractId("vault", "testnet")).toBe("");
    });

    it("returns env override when set", () => {
      vi.stubEnv("VITE_CONTRACT_ID", "MY_VAULT_ID");
      expect(getContractId("vault", "testnet")).toBe("MY_VAULT_ID");
    });
  });

  describe("getAllContractIds", () => {
    it("returns all contract names", () => {
      vi.stubEnv("VITE_CONTRACT_ID", "");
      vi.stubEnv("VITE_ZAP_CONTRACT_ID", "");
      vi.stubEnv("VITE_TOKEN_CONTRACT_ID", "");
      vi.stubEnv("VITE_GOVERNANCE_CONTRACT_ID", "");
      vi.stubEnv("VITE_STRATEGY_CONTRACT_ID", "");
      vi.stubEnv("VITE_EMISSION_CONTROLLER_CONTRACT_ID", "");
      vi.stubEnv("VITE_LIQUID_STAKING_CONTRACT_ID", "");
      vi.stubEnv("VITE_STABLESWAP_CONTRACT_ID", "");

      const ids = getAllContractIds("testnet");
      expect(Object.keys(ids)).toEqual(CONTRACT_NAMES);
    });
  });
});
