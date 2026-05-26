/**
 * Off-Ramp Retry and Resume Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { OffRampService } from "./offRampService";
import type { WithdrawalRequest } from "./types";

describe("OffRampService Retry and Resume", () => {
    let service: OffRampService;

    beforeEach(() => {
        service = new OffRampService("moonpay", "test-key", "https://api.test.com");
        localStorage.clear();
        global.fetch = vi.fn();
    });

    it("should store request data for later retry", async () => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: "tx-retry-1", status: "pending" }),
        });

        const request: WithdrawalRequest = {
            vaultContractId: "test-vault",
            shares: 1000n,
            usdcAmount: 5000n,
            bankAccount: "123456789",
            bankName: "Chase",
            accountHolder: "John Doe",
        };

        const tx = await service.initiateWithdrawal(request);
        expect(tx.request).toBeDefined();
        expect(tx.request?.shares).toBe(1000n);

        const loaded = service.getAllTransactions()[0];
        expect(loaded.request?.shares).toBe(1000n);
    });

    it("should identify retryable errors (500)", async () => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
        });

        const request: WithdrawalRequest = {
            vaultContractId: "test-vault",
            shares: 1000n,
            usdcAmount: 5000n,
            bankAccount: "123456789",
            bankName: "Chase",
            accountHolder: "John Doe",
        };

        try {
            await service.initiateWithdrawal(request);
        } catch (e) {
            // expected
        }

        const tx = service.getAllTransactions()[0];
        expect(tx.status).toBe("failed");
        expect(tx.isRetryable).toBe(true);
    });

    it("should identify terminal errors (403)", async () => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 403,
            statusText: "Forbidden",
        });

        const request: WithdrawalRequest = {
            vaultContractId: "test-vault",
            shares: 1000n,
            usdcAmount: 5000n,
            bankAccount: "123456789",
            bankName: "Chase",
            accountHolder: "John Doe",
        };

        try {
            await service.initiateWithdrawal(request);
        } catch (e) {
            // expected
        }

        const tx = service.getAllTransactions()[0];
        expect(tx.status).toBe("failed");
        expect(tx.isRetryable).toBe(false);
    });

    it("should successfully retry a failed transaction", async () => {
        // First attempt fails
        (global.fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
        });

        const request: WithdrawalRequest = {
            vaultContractId: "test-vault",
            shares: 1000n,
            usdcAmount: 5000n,
            bankAccount: "123456789",
            bankName: "Chase",
            accountHolder: "John Doe",
        };

        try {
            await service.initiateWithdrawal(request);
        } catch (e) {}

        const failedTx = service.getAllTransactions()[0];
        expect(failedTx.status).toBe("failed");

        // Retry succeeds
        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: failedTx.id, status: "pending" }),
        });

        const retriedTx = await service.retryTransaction(failedTx.id);
        expect(retriedTx.status).toBe("pending");
        expect(retriedTx.errorMessage).toBeUndefined();
    });

    it("should resume polling after refresh (pollStatus)", async () => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: "tx-resume", status: "pending" }),
        });

        const request: WithdrawalRequest = {
            vaultContractId: "test-vault",
            shares: 1000n,
            usdcAmount: 5000n,
            bankAccount: "123456789",
            bankName: "Chase",
            accountHolder: "John Doe",
        };

        const tx = await service.initiateWithdrawal(request);
        
        // Mock poll response showing completion
        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ status: "completed" }),
        });

        const updated = await service.pollStatus(tx.id);
        expect(updated?.status).toBe("completed");
    });
});
