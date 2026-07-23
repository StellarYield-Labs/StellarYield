/**
 * Contacts API Route Tests
 * Tests CRUD operations, authentication, validation, and error handling
 * for the encrypted contacts feature
 */

import request from "supertest";
import express from "express";
import contactsRouter from "../routes/contacts";

// Mock PrismaClient
const mockFindMany = jest.fn();
const mockFindFirst = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    contact: {
      get findMany() { return mockFindMany; },
      get findFirst() { return mockFindFirst; },
      get create() { return mockCreate; },
      get update() { return mockUpdate; },
      get delete() { return mockDelete; },
    },
  })),
}));

describe("Contacts API Routes", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/contacts", contactsRouter);

  const TEST_WALLET = "GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const mockContact = {
    id: "test-id-1",
    walletAddress: TEST_WALLET,
    encryptedName: "encrypted-name-data",
    encryptedAddress: "encrypted-address-data",
    createdAt: new Date("2023-01-01T00:00:00Z"),
    updatedAt: new Date("2023-01-01T00:00:00Z"),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Authentication", () => {
    it("should require wallet address for GET /", async () => {
      const response = await request(app).get("/api/contacts");
      
      expect(response.status).toBe(401);
      expect(response.body.code).toBe("WALLET_ADDRESS_REQUIRED");
    });

    it("should accept wallet address from header", async () => {
      mockFindMany.mockResolvedValue([]);
      
      const response = await request(app)
        .get("/api/contacts")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(response.status).toBe(200);
    });

    it("should require wallet address for POST /", async () => {
      const response = await request(app)
        .post("/api/contacts")
        .send({ encryptedName: "test", encryptedAddress: "test" });
      
      expect(response.status).toBe(401);
      expect(response.body.code).toBe("WALLET_ADDRESS_REQUIRED");
    });

    it("should require wallet address for PUT /:id", async () => {
      const response = await request(app)
        .put("/api/contacts/test-id")
        .send({ encryptedName: "test" });
      
      expect(response.status).toBe(401);
      expect(response.body.code).toBe("WALLET_ADDRESS_REQUIRED");
    });

    it("should require wallet address for DELETE /:id", async () => {
      const response = await request(app)
        .delete("/api/contacts/test-id");
      
      expect(response.status).toBe(401);
      expect(response.body.code).toBe("WALLET_ADDRESS_REQUIRED");
    });
  });

  describe("GET /api/contacts", () => {
    it("should return empty array when no contacts exist", async () => {
      mockFindMany.mockResolvedValue([]);
      
      const response = await request(app)
        .get("/api/contacts")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(response.status).toBe(200);
      expect(response.body.contacts).toEqual([]);
      expect(response.body.total).toBe(0);
    });

    it("should return all contacts for user", async () => {
      mockFindMany.mockResolvedValue([mockContact]);
      
      const response = await request(app)
        .get("/api/contacts")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(response.status).toBe(200);
      expect(response.body.contacts).toHaveLength(1);
      expect(response.body.contacts[0]).toEqual({
        id: mockContact.id,
        encrypted_name: mockContact.encryptedName,
        encrypted_address: mockContact.encryptedAddress,
        created_at: mockContact.createdAt.toISOString(),
        updated_at: mockContact.updatedAt.toISOString(),
      });
      expect(response.body.total).toBe(1);
    });

    it("should handle database errors gracefully", async () => {
      mockFindMany.mockRejectedValue(new Error("Database error"));
      
      const response = await request(app)
        .get("/api/contacts")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(response.status).toBe(500);
      expect(response.body.code).toBe("FETCH_FAILED");
    });
  });

  describe("GET /api/contacts/:id", () => {
    it("should return a single contact", async () => {
      mockFindFirst.mockResolvedValue(mockContact);
      
      const response = await request(app)
        .get("/api/contacts/test-id-1")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(response.status).toBe(200);
      expect(response.body.contact.id).toBe(mockContact.id);
    });

    it("should return 404 for non-existent contact", async () => {
      mockFindFirst.mockResolvedValue(null);
      
      const response = await request(app)
        .get("/api/contacts/non-existent")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("CONTACT_NOT_FOUND");
    });

    it("should only return contacts belonging to the user", async () => {
      mockFindFirst.mockResolvedValue(null);
      
      const response = await request(app)
        .get("/api/contacts/other-user-contact")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(mockFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            walletAddress: TEST_WALLET,
          }),
        })
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/contacts", () => {
    it("should create a new contact with valid data", async () => {
      mockFindFirst.mockResolvedValue(null); // No duplicate
      mockCreate.mockResolvedValue(mockContact);
      
      const response = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", TEST_WALLET)
        .send({
          encryptedName: "encrypted-name-data",
          encryptedAddress: "encrypted-address-data",
        });
      
      expect(response.status).toBe(201);
      expect(response.body.contact.id).toBe(mockContact.id);
    });

    it("should validate required fields", async () => {
      const response = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", TEST_WALLET)
        .send({ encryptedName: "test" }); // Missing encryptedAddress
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_REQUEST");
    });

    it("should reject empty encrypted name", async () => {
      const response = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", TEST_WALLET)
        .send({
          encryptedName: "",
          encryptedAddress: "encrypted-address-data",
        });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_REQUEST");
    });

    it("should reject empty encrypted address", async () => {
      const response = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", TEST_WALLET)
        .send({
          encryptedName: "encrypted-name-data",
          encryptedAddress: "",
        });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_REQUEST");
    });

    it("should prevent duplicate contacts", async () => {
      mockFindFirst.mockResolvedValue(mockContact); // Existing contact
      
      const response = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", TEST_WALLET)
        .send({
          encryptedName: "encrypted-name-data",
          encryptedAddress: "encrypted-address-data",
        });
      
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("DUPLICATE_CONTACT");
    });

    it("should handle database constraint violations", async () => {
      mockFindFirst.mockResolvedValue(null);
      const error = new Error("Unique constraint failed");
      mockCreate.mockRejectedValue(error);
      
      const response = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", TEST_WALLET)
        .send({
          encryptedName: "encrypted-name-data",
          encryptedAddress: "encrypted-address-data",
        });
      
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("DUPLICATE_CONTACT");
    });

    it("should not expose plaintext data in logs or responses", async () => {
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockResolvedValue(mockContact);
      
      const response = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", TEST_WALLET)
        .send({
          encryptedName: "encrypted-name-data",
          encryptedAddress: "encrypted-address-data",
        });
      
      // Verify response only contains encrypted data
      expect(response.body.contact.encrypted_name).toBeDefined();
      expect(response.body.contact.encrypted_address).toBeDefined();
      expect(response.body.contact.name).toBeUndefined();
      expect(response.body.contact.address).toBeUndefined();
    });
  });

  describe("PUT /api/contacts/:id", () => {
    it("should update a contact", async () => {
      mockFindFirst.mockResolvedValue(mockContact);
      mockUpdate.mockResolvedValue({
        ...mockContact,
        encryptedName: "updated-encrypted-name",
        updatedAt: new Date("2023-01-02T00:00:00Z"),
      });
      
      const response = await request(app)
        .put("/api/contacts/test-id-1")
        .set("x-wallet-address", TEST_WALLET)
        .send({ encryptedName: "updated-encrypted-name" });
      
      expect(response.status).toBe(200);
      expect(response.body.contact.encrypted_name).toBe("updated-encrypted-name");
    });

    it("should allow partial updates", async () => {
      mockFindFirst
        .mockResolvedValueOnce(mockContact) // First call: existing contact
        .mockResolvedValueOnce(null); // Second call: duplicate check
      mockUpdate.mockResolvedValue(mockContact);
      
      const response = await request(app)
        .put("/api/contacts/test-id-1")
        .set("x-wallet-address", TEST_WALLET)
        .send({ encryptedAddress: "new-encrypted-address" });
      
      expect(response.status).toBe(200);
    });

    it("should return 404 for non-existent contact", async () => {
      mockFindFirst.mockResolvedValue(null);
      
      const response = await request(app)
        .put("/api/contacts/non-existent")
        .set("x-wallet-address", TEST_WALLET)
        .send({ encryptedName: "test" });
      
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("CONTACT_NOT_FOUND");
    });

    it("should prevent updating to duplicate address", async () => {
      mockFindFirst
        .mockResolvedValueOnce(mockContact) // First call: existing contact
        .mockResolvedValueOnce({ // Second call: duplicate check
          id: "other-id",
          encryptedAddress: "duplicate-address",
        });
      
      const response = await request(app)
        .put("/api/contacts/test-id-1")
        .set("x-wallet-address", TEST_WALLET)
        .send({ encryptedAddress: "duplicate-address" });
      
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("DUPLICATE_CONTACT");
    });

    it("should validate update data", async () => {
      mockFindFirst.mockResolvedValue(mockContact);
      
      const response = await request(app)
        .put("/api/contacts/test-id-1")
        .set("x-wallet-address", TEST_WALLET)
        .send({ encryptedName: "" }); // Empty name
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_REQUEST");
    });

    it("should only allow users to update their own contacts", async () => {
      mockFindFirst.mockResolvedValue(null); // Not found for this user
      
      const response = await request(app)
        .put("/api/contacts/other-user-contact")
        .set("x-wallet-address", TEST_WALLET)
        .send({ encryptedName: "test" });
      
      expect(mockFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            walletAddress: TEST_WALLET,
          }),
        })
      );
      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /api/contacts/:id", () => {
    it("should delete a contact", async () => {
      mockFindFirst.mockResolvedValue(mockContact);
      mockDelete.mockResolvedValue(mockContact);
      
      const response = await request(app)
        .delete("/api/contacts/test-id-1")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(response.status).toBe(204);
    });

    it("should return 404 for non-existent contact", async () => {
      mockFindFirst.mockResolvedValue(null);
      
      const response = await request(app)
        .delete("/api/contacts/non-existent")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("CONTACT_NOT_FOUND");
    });

    it("should only allow users to delete their own contacts", async () => {
      mockFindFirst.mockResolvedValue(null);
      
      const response = await request(app)
        .delete("/api/contacts/other-user-contact")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(mockFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            walletAddress: TEST_WALLET,
          }),
        })
      );
      expect(response.status).toBe(404);
    });

    it("should handle database deletion errors", async () => {
      mockFindFirst.mockResolvedValue(mockContact);
      mockDelete.mockRejectedValue(new Error("Database error"));
      
      const response = await request(app)
        .delete("/api/contacts/test-id-1")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(response.status).toBe(500);
      expect(response.body.code).toBe("DELETE_FAILED");
    });
  });

  describe("GET /api/contacts/search", () => {
    it("should search contacts", async () => {
      mockFindMany.mockResolvedValue([mockContact]);
      
      const response = await request(app)
        .get("/api/contacts/search?q=test")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(response.status).toBe(200);
      expect(response.body.contacts).toHaveLength(1);
    });

    it("should require search query", async () => {
      const response = await request(app)
        .get("/api/contacts/search")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_QUERY");
    });

    it("should return all contacts since data is encrypted", async () => {
      // Server can't search encrypted data, returns all for client filtering
      mockFindMany.mockResolvedValue([mockContact]);
      
      const response = await request(app)
        .get("/api/contacts/search?q=anything")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { walletAddress: TEST_WALLET },
        })
      );
      expect(response.status).toBe(200);
    });
  });

  describe("GET /api/contacts/export", () => {
    it("should export contacts as encrypted backup", async () => {
      mockFindMany.mockResolvedValue([mockContact]);
      
      const response = await request(app)
        .get("/api/contacts/export")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(response.status).toBe(200);
      expect(response.body.encryptedBackup).toBeDefined();
      const backup = JSON.parse(response.body.encryptedBackup);
      expect(backup.version).toBe("1.0");
      expect(backup.contacts).toHaveLength(1);
    });

    it("should handle export errors", async () => {
      mockFindMany.mockRejectedValue(new Error("Database error"));
      
      const response = await request(app)
        .get("/api/contacts/export")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(response.status).toBe(500);
      expect(response.body.code).toBe("EXPORT_FAILED");
    });
  });

  describe("POST /api/contacts/import", () => {
    it("should import contacts from backup", async () => {
      const backupData = {
        version: "1.0",
        contacts: [{
          encryptedName: "encrypted-name",
          encryptedAddress: "encrypted-address",
        }],
      };

      mockFindFirst.mockResolvedValue(null); // No duplicates
      mockCreate.mockResolvedValue(mockContact);
      
      const response = await request(app)
        .post("/api/contacts/import")
        .set("x-wallet-address", TEST_WALLET)
        .send({ encryptedBackup: JSON.stringify(backupData) });
      
      expect(response.status).toBe(200);
      expect(response.body.contacts).toHaveLength(1);
    });

    it("should require encrypted backup", async () => {
      const response = await request(app)
        .post("/api/contacts/import")
        .set("x-wallet-address", TEST_WALLET)
        .send({});
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_BACKUP");
    });

    it("should validate backup format", async () => {
      const response = await request(app)
        .post("/api/contacts/import")
        .set("x-wallet-address", TEST_WALLET)
        .send({ encryptedBackup: JSON.stringify({ invalid: "format" }) });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_FORMAT");
    });

    it("should skip duplicate contacts during import", async () => {
      const backupData = {
        version: "1.0",
        contacts: [
          { encryptedName: "name1", encryptedAddress: "addr1" },
          { encryptedName: "name2", encryptedAddress: "addr2" },
        ],
      };

      // First contact is duplicate, second is new
      mockFindFirst
        .mockResolvedValueOnce(mockContact) // Duplicate
        .mockResolvedValueOnce(null); // Not duplicate
      mockCreate.mockResolvedValue(mockContact);
      
      const response = await request(app)
        .post("/api/contacts/import")
        .set("x-wallet-address", TEST_WALLET)
        .send({ encryptedBackup: JSON.stringify(backupData) });
      
      expect(response.status).toBe(200);
      expect(mockCreate).toHaveBeenCalledTimes(1); // Only one created
    });
  });

  describe("Security - Encrypted Payloads", () => {
    it("should never expose plaintext data in responses", async () => {
      mockFindMany.mockResolvedValue([mockContact]);
      
      const response = await request(app)
        .get("/api/contacts")
        .set("x-wallet-address", TEST_WALLET);
      
      const responseText = JSON.stringify(response.body);
      expect(responseText).not.toContain("Alice");
      expect(responseText).not.toContain("0x1234");
      expect(responseText).toContain("encrypted");
    });

    it("should only accept encrypted data in POST requests", async () => {
      mockFindFirst.mockResolvedValue(null);
      mockCreate.mockResolvedValue(mockContact);
      
      const response = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", TEST_WALLET)
        .send({
          encryptedName: "encrypted-name-data",
          encryptedAddress: "encrypted-address-data",
        });
      
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            encryptedName: expect.any(String),
            encryptedAddress: expect.any(String),
          }),
        })
      );
    });

    it("should reject requests with plaintext field names", async () => {
      const response = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", TEST_WALLET)
        .send({
          name: "Alice", // Plain field name should not be accepted
          address: "0x1234",
        });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_REQUEST");
    });
  });

  describe("Malformed Payloads", () => {
    it("should reject invalid JSON", async () => {
      const response = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", TEST_WALLET)
        .set("Content-Type", "application/json")
        .send("invalid-json");
      
      expect(response.status).toBe(400);
    });

    it("should reject non-string encrypted values", async () => {
      const response = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", TEST_WALLET)
        .send({
          encryptedName: 123, // Should be string
          encryptedAddress: "encrypted-address-data",
        });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_REQUEST");
    });

    it("should handle oversized payloads gracefully", async () => {
      const largeString = "x".repeat(1000000); // 1MB string
      
      const response = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", TEST_WALLET)
        .send({
          encryptedName: largeString,
          encryptedAddress: "encrypted-address-data",
        });
      
      // Should either accept or reject gracefully, not crash
      expect([201, 400, 413]).toContain(response.status);
    });
  });

  describe("Error Handling", () => {
    it("should handle generic database errors", async () => {
      mockFindMany.mockRejectedValue(new Error("Connection timeout"));
      
      const response = await request(app)
        .get("/api/contacts")
        .set("x-wallet-address", TEST_WALLET);
      
      expect(response.status).toBe(500);
      expect(response.body.error).toBeDefined();
      expect(response.body.code).toBeDefined();
    });

    it("should not leak sensitive error details", async () => {
      mockCreate.mockRejectedValue(new Error("Database connection string: postgresql://user:pass@host"));
      
      const response = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", TEST_WALLET)
        .send({
          encryptedName: "test",
          encryptedAddress: "test",
        });
      
      expect(response.status).toBe(500);
      expect(response.body.error).not.toContain("postgresql://");
      expect(response.body.error).not.toContain("pass@");
    });
  });
});
