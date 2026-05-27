import request from "supertest";
import { createApp } from "../app";
import { _resetDonationsStore } from "../routes/donations";

beforeEach(() => {
    _resetDonationsStore();
});

describe("GET /api/donations/config/:address", () => {
    it("returns default config for unknown address", async () => {
        const res = await request(createApp()).get(
            "/api/donations/config/GDUNKNOWN",
        );
        expect(res.status).toBe(200);
        expect(res.body.bps).toBe(0);
        expect(res.body.charityId).toBeNull();
    });

    it("returns saved config after POST /set", async () => {
        const app = createApp();
        const address = "GADRESSSAVED";
        const charityAddress = "GDCHARITYADDRESS00000000000000000000";

        await request(app).post("/api/donations/set").send({
            address,
            bps: 500,
            charityAddress,
        });

        const res = await request(app).get(
            `/api/donations/config/${encodeURIComponent(address)}`,
        );
        expect(res.status).toBe(200);
        expect(res.body.bps).toBe(500);
    });
});

describe("POST /api/donations/set", () => {
    it("saves a valid donation config", async () => {
        const res = await request(createApp()).post("/api/donations/set").send({
            address: "GADRESS1",
            bps: 1000,
            charityAddress: "GDCHARITY000000000000000000000000001",
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it("accepts bps = 0 (disable donation)", async () => {
        const res = await request(createApp()).post("/api/donations/set").send({
            address: "GADRESSDISABLE",
            bps: 0,
            charityAddress: "GDCHARITY000000000000000000000000001",
        });
        expect(res.status).toBe(200);
    });

    it("rejects missing address", async () => {
        const res = await request(createApp()).post("/api/donations/set").send({
            bps: 500,
            charityAddress: "GDCHARITY000000000000000000000000001",
        });
        expect(res.status).toBe(400);
    });

    it("rejects bps > 10000", async () => {
        const res = await request(createApp()).post("/api/donations/set").send({
            address: "GADRESS1",
            bps: 10001,
            charityAddress: "GDCHARITY000000000000000000000000001",
        });
        expect(res.status).toBe(400);
    });

    it("rejects negative bps", async () => {
        const res = await request(createApp()).post("/api/donations/set").send({
            address: "GADRESS1",
            bps: -1,
            charityAddress: "GDCHARITY000000000000000000000000001",
        });
        expect(res.status).toBe(400);
    });

    it("rejects missing charityAddress", async () => {
        const res = await request(createApp()).post("/api/donations/set").send({
            address: "GADRESS1",
            bps: 500,
        });
        expect(res.status).toBe(400);
    });
});

describe("GET /api/donations/total", () => {
    it("returns numeric totalDonated", async () => {
        const res = await request(createApp()).get("/api/donations/total");
        expect(res.status).toBe(200);
        expect(typeof res.body.totalDonated).toBe("number");
    });
});

describe("GET /api/donations/summary", () => {
    it("returns zero metrics when store is empty", async () => {
        const res = await request(createApp()).get("/api/donations/summary");
        expect(res.status).toBe(200);
        expect(res.body.totalDonated).toBe(0);
        expect(res.body.participatingVaults).toBe(0);
        expect(res.body.projectedMonthlyImpact).toBe(0);
    });

    it("reflects participating vaults after POST /set", async () => {
        const app = createApp();
        await request(app).post("/api/donations/set").send({
            address: "USER1",
            bps: 500,
            charityAddress: "CHARITY1",
        });
        await request(app).post("/api/donations/set").send({
            address: "USER2",
            bps: 1000,
            charityAddress: "CHARITY2",
        });
        await request(app).post("/api/donations/set").send({
            address: "USER3",
            bps: 0, // Should not count
            charityAddress: "CHARITY1",
        });

        const res = await request(app).get("/api/donations/summary");
        expect(res.status).toBe(200);
        expect(res.body.participatingVaults).toBe(2);
        expect(res.body.projectedMonthlyImpact).toBeGreaterThan(0);
    });
});
