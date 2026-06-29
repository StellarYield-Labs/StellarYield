import { PrismaClient } from "@prisma/client";

// NOTE:
// The Prisma schema currently does not include the models referenced by this repository.
// This file is kept as a compile-safe stub so the service layer can be wired up
// without breaking TypeScript builds until the schema/migration is applied.
//
// After adding the Prisma models (`fallbackTreeDefinition`, `fallbackTraversalAudit`),
// replace the stubbed methods with real `prisma.<model>` calls.
export function fallbackTraversalAuditRepository(_prisma: PrismaClient) {
  return {
    async createTreeDefinition() {
      throw new Error(
        "fallbackTraversalAuditRepository.createTreeDefinition is not available because Prisma models are not yet defined (fallbackTreeDefinition).",
      );
    },

    async getTreeDefinition() {
      throw new Error(
        "fallbackTraversalAuditRepository.getTreeDefinition is not available because Prisma models are not yet defined (fallbackTreeDefinition).",
      );
    },

    async createTraversalAudit() {
      throw new Error(
        "fallbackTraversalAuditRepository.createTraversalAudit is not available because Prisma models are not yet defined (fallbackTraversalAudit).",
      );
    },

    async getTraversalAuditById() {
      throw new Error(
        "fallbackTraversalAuditRepository.getTraversalAuditById is not available because Prisma models are not yet defined (fallbackTraversalAudit).",
      );
    },
  };
}

