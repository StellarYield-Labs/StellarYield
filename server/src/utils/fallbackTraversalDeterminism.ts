import crypto from "crypto";

export function fallbackTreeAuditEventKey(input: {
  treeKey: string;
  treeVersion: number;
  rootId: string;
  seed: string;
}): string {
  const payload = `${input.treeKey}|${input.treeVersion}|${input.rootId}|${input.seed}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}
