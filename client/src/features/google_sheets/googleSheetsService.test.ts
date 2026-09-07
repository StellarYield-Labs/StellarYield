/**
 * Google Sheets Service Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { GoogleSheetsService } from "./googleSheetsService";

describe("GoogleSheetsService", () => {
    let service: GoogleSheetsService;

    beforeEach(() => {
        service = new GoogleSheetsService("client-id", "client-secret", "http://localhost:3000/callback");
        localStorage.clear();
    });

    it("should generate authorization URL", () => {
        const url = service.getAuthorizationUrl();

        expect(url).toContain("https://accounts.google.com/o/oauth2/v2/auth");
        expect(url).toContain("client_id=client-id");
        expect(url).toContain("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fspreadsheets");
    });

    it("should return null for unconfigured service", () => {
        expect(service.getConfig()).toBeNull();
        expect(service.getSession()).toBeNull();
    });

    it("should detect expired tokens", () => {
        const expiredSession = {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: Date.now() - 1000, // Expired
            email: "test@example.com",
        };

        localStorage.setItem("stellar_yield_google_oauth", JSON.stringify(expiredSession));

        expect(service.getSession()).toBeNull();
    });

    it("should return valid session", () => {
        const validSession = {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: Date.now() + 3600000, // 1 hour from now
            email: "test@example.com",
        };

        localStorage.setItem("stellar_yield_google_oauth", JSON.stringify(validSession));

        const session = service.getSession();
        expect(session).toBeDefined();
        expect(session?.email).toBe("test@example.com");
    });

    it("should unlink account", () => {
        const config = {
            spreadsheetId: "123",
            sheetName: "Metrics",
            isLinked: true,
            linkedAt: Date.now(),
        };

        localStorage.setItem("stellar_yield_google_sheets", JSON.stringify(config));
        service.unlinkAccount();

        expect(service.getConfig()).toBeNull();
        expect(service.getSession()).toBeNull();
    });

    describe("Spreadsheet ID validation and linking (#166)", () => {
        const validId = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
        const validUrl = `https://docs.google.com/spreadsheets/d/${validId}/edit#gid=0`;

        it("should validate valid spreadsheet IDs and URLs", () => {
            expect(service.isValidSpreadsheetId(validId)).toBe(true);
            expect(service.isValidSpreadsheetId(validUrl)).toBe(true);
            expect(service.extractSpreadsheetId(validId)).toBe(validId);
            expect(service.extractSpreadsheetId(validUrl)).toBe(validId);
        });

        it("should reject obviously invalid spreadsheet IDs", () => {
            expect(service.isValidSpreadsheetId("")).toBe(false);
            expect(service.isValidSpreadsheetId("   ")).toBe(false);
            expect(service.isValidSpreadsheetId("short_id")).toBe(false);
            expect(service.isValidSpreadsheetId("123")).toBe(false);
            expect(service.isValidSpreadsheetId("invalid id with spaces")).toBe(false);
            expect(service.isValidSpreadsheetId("invalid!@#$%^&*()")).toBe(false);
            expect(service.isValidSpreadsheetId("https://not-a-google-sheet.com/doc")).toBe(false);
        });

        it("should reject invalid spreadsheet ID before attempting sync in linkSpreadsheet", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch");

            const validSession = {
                accessToken: "mock-token",
                refreshToken: "mock-refresh",
                expiresAt: Date.now() + 3600000,
                email: "test@example.com",
            };
            localStorage.setItem("stellar_yield_google_oauth", JSON.stringify(validSession));

            // Test empty string
            await expect(service.linkSpreadsheet("", "Yield Metrics")).rejects.toThrow("Invalid spreadsheet ID");

            // Test short ID
            await expect(service.linkSpreadsheet("invalid-id", "Yield Metrics")).rejects.toThrow("Invalid spreadsheet ID");

            // Test invalid characters
            await expect(service.linkSpreadsheet("bad_id!@#$%", "Yield Metrics")).rejects.toThrow("Invalid spreadsheet ID");

            // Verify network request was NEVER attempted for invalid IDs
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("should successfully link spreadsheet with a valid ID", async () => {
            const validSession = {
                accessToken: "mock-token",
                refreshToken: "mock-refresh",
                expiresAt: Date.now() + 3600000,
                email: "test@example.com",
            };
            localStorage.setItem("stellar_yield_google_oauth", JSON.stringify(validSession));

            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ success: true }),
            } as Response);

            const config = await service.linkSpreadsheet(validId, "Yield Metrics");

            expect(config.spreadsheetId).toBe(validId);
            expect(config.sheetName).toBe("Yield Metrics");
            expect(config.isLinked).toBe(true);
            expect(service.getConfig()?.spreadsheetId).toBe(validId);
        });
    });
});
