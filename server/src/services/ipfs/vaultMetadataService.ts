import crypto from "crypto";
import { DEFAULT_ICON_CONFIG } from "../../utils/iconValidator";

export interface VaultMetadataInput {
  vaultName: string;
  description: string;
  iconSvg: string;
}

export interface VaultMetadataPayload {
  name: string;
  description: string;
  icon: string;
  createdAt: string;
}

export interface UploadVaultMetadataResult {
  cid: string;
  metadataUri: string;
  iconUri: string;
  metadata: VaultMetadataPayload;
  uploadMode: "pinata" | "local-fallback";
}

const PINATA_FILE_API = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const PINATA_JSON_API = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
}

function extractSvgDimensionsFromString(svg: string): { width: number; height: number } | null {
  const viewBoxMatch = svg.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  if (viewBoxMatch) {
    const values = viewBoxMatch[1].split(/\s+/).map(Number);
    if (values.length === 4 && !values.some(isNaN)) {
      return { width: values[2], height: values[3] };
    }
  }

  const widthMatch = svg.match(/width\s*=\s*["']?(\d+)/i);
  const heightMatch = svg.match(/height\s*=\s*["']?(\d+)/i);

  if (widthMatch && heightMatch) {
    return {
      width: parseInt(widthMatch[1], 10),
      height: parseInt(heightMatch[1], 10),
    };
  }

  return null;
}

/**
 * Iteratively applies a replacement until the string stabilises.
 * This prevents bypass via nested payloads such as `<scr<script>ipt>`.
 */
function replaceUntilStable(input: string, pattern: RegExp, replacement: string): string {
  let previous = input;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const next = previous.replace(pattern, replacement);
    if (next === previous) return next;
    previous = next;
  }
}

/**
 * Strip `<script ...>...</script ...>` blocks using indexOf scanning.
 * O(n) with zero backtracking risk.  Handles `</script >` (whitespace
 * before `>`) and self-closing `<script ... />` forms.
 */
function stripScriptTags(input: string): string {
  let result = input;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const openIdx = result.search(/<script[\s>\/]/i);
    if (openIdx === -1) break;

    // Look for the closing </script...> tag
    const closeTagStart = result.search(/<\/script[\s>]/i);
    if (closeTagStart !== -1 && closeTagStart > openIdx) {
      // Find the `>` that actually ends the closing tag
      const closeTagEnd = result.indexOf('>', closeTagStart);
      if (closeTagEnd !== -1) {
        result = result.slice(0, openIdx) + result.slice(closeTagEnd + 1);
        continue;
      }
    }

    // No proper closing tag found — remove from <script to end of its opening tag
    const openTagEnd = result.indexOf('>', openIdx);
    if (openTagEnd !== -1) {
      result = result.slice(0, openIdx) + result.slice(openTagEnd + 1);
    } else {
      // Malformed: no closing `>` at all — truncate from <script onward
      result = result.slice(0, openIdx);
    }
  }
  return result;
}

export function sanitizeSvg(svg: string): string {
  const normalized = requireNonEmpty(svg, "iconSvg");

  if (!normalized.includes("<svg")) {
    throw new Error("iconSvg must be a valid SVG string");
  }

  // 1. Strip <script> blocks via linear indexOf scanning (no regex).
  let sanitized = stripScriptTags(normalized);

  // 2. Strip inline event handlers (on*="…", on*='…', unquoted).
  //    Each regex uses a bounded character class — no nested quantifiers.
  sanitized = replaceUntilStable(sanitized, /(?<=\s|^|['"\/])on\w+\s*=\s*"[^"]*"/gi, "");
  sanitized = replaceUntilStable(sanitized, /(?<=\s|^|['"\/])on\w+\s*=\s*'[^']*'/gi, "");
  sanitized = replaceUntilStable(sanitized, /(?<=\s|^|['"\/])on\w+\s*=\s*[^\s>"']+/gi, "");

  // 3. Strip dangerous URI schemes (javascript:, data:, vbscript:).
  sanitized = replaceUntilStable(sanitized, /javascript\s*:/gi, "");
  sanitized = replaceUntilStable(sanitized, /data\s*:/gi, "");
  sanitized = replaceUntilStable(sanitized, /vbscript\s*:/gi, "");

  const dimensions = extractSvgDimensionsFromString(sanitized);
  if (dimensions) {
    if (
      dimensions.width < DEFAULT_ICON_CONFIG.minDimensionsPx.width ||
      dimensions.height < DEFAULT_ICON_CONFIG.minDimensionsPx.height
    ) {
      throw new Error(
        `Icon validation failed: SVG dimensions (${dimensions.width}x${dimensions.height}) are below minimum (${DEFAULT_ICON_CONFIG.minDimensionsPx.width}x${DEFAULT_ICON_CONFIG.minDimensionsPx.height})`,
      );
    }

    if (
      dimensions.width > DEFAULT_ICON_CONFIG.maxDimensionsPx.width ||
      dimensions.height > DEFAULT_ICON_CONFIG.maxDimensionsPx.height
    ) {
      throw new Error(
        `Icon validation failed: SVG dimensions (${dimensions.width}x${dimensions.height}) exceed maximum (${DEFAULT_ICON_CONFIG.maxDimensionsPx.width}x${DEFAULT_ICON_CONFIG.maxDimensionsPx.height})`,
      );
    }
  }

  const sizeBytes = Buffer.byteLength(sanitized, "utf8");
  if (sizeBytes > DEFAULT_ICON_CONFIG.maxFileSizeBytes) {
    throw new Error(
      `Icon validation failed: SVG size (${sizeBytes} bytes) exceeds maximum allowed size (${DEFAULT_ICON_CONFIG.maxFileSizeBytes} bytes)`,
    );
  }

  return sanitized;
}

function makeDeterministicCid(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 46);
}

function buildMetadata(
  input: VaultMetadataInput,
  iconCid: string,
  createdAt = new Date().toISOString(),
): VaultMetadataPayload {
  return {
    name: requireNonEmpty(input.vaultName, "vaultName"),
    description: requireNonEmpty(input.description, "description"),
    icon: `ipfs://${iconCid}`,
    createdAt,
  };
}

async function uploadSvgToPinata(svg: string, pinataJwt: string): Promise<string> {
  const body = new FormData();
  const svgBlob = new Blob([svg], { type: "image/svg+xml" });
  body.append("file", svgBlob, "vault-icon.svg");

  const response = await fetch(PINATA_FILE_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pinataJwt}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pinata SVG upload failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { IpfsHash?: string };
  if (!data.IpfsHash) {
    throw new Error("Pinata SVG upload did not return IpfsHash");
  }

  return data.IpfsHash;
}

async function uploadJsonToPinata(
  metadata: VaultMetadataPayload,
  pinataJwt: string,
): Promise<string> {
  const response = await fetch(PINATA_JSON_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pinataJwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pinataContent: metadata,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pinata metadata upload failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { IpfsHash?: string };
  if (!data.IpfsHash) {
    throw new Error("Pinata metadata upload did not return IpfsHash");
  }

  return data.IpfsHash;
}

export function validateVaultMetadataInput(input: unknown): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (!input || typeof input !== 'object') {
    errors.push('Input must be a non-null object');
    return { ok: false, errors };
  }

  const data = input as Record<string, unknown>;

  if (!data.vaultName || (typeof data.vaultName === 'string' && data.vaultName.trim() === '')) {
    errors.push('vaultName is required');
  }
  if (!data.description || (typeof data.description === 'string' && data.description.trim() === '')) {
    errors.push('description is required');
  }
  if (!data.iconSvg || (typeof data.iconSvg === 'string' && data.iconSvg.trim() === '')) {
    errors.push('iconSvg is required');
  } else if (typeof data.iconSvg === 'string' && !/<svg[\s\S]*?>/i.test(data.iconSvg)) {
    errors.push('iconSvg must be a valid SVG string');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}

export async function uploadVaultMetadata(
  input: VaultMetadataInput,
): Promise<UploadVaultMetadataResult> {
  const sanitizedSvg = sanitizeSvg(input.iconSvg);
  const pinataJwt = process.env.PINATA_JWT?.trim();

  if (!pinataJwt) {
    const iconCid = makeDeterministicCid(`icon:${sanitizedSvg}`);
    const metadata = buildMetadata(input, iconCid, "1970-01-01T00:00:00.000Z");
    const metadataCid = makeDeterministicCid(
      `meta:${JSON.stringify(metadata)}:${sanitizedSvg}`,
    );

    return {
      cid: metadataCid,
      metadataUri: `ipfs://${metadataCid}`,
      iconUri: `ipfs://${iconCid}`,
      metadata,
      uploadMode: "local-fallback",
    };
  }

  const iconCid = await uploadSvgToPinata(sanitizedSvg, pinataJwt);
  const metadata = buildMetadata(input, iconCid);
  const metadataCid = await uploadJsonToPinata(metadata, pinataJwt);

  return {
    cid: metadataCid,
    metadataUri: `ipfs://${metadataCid}`,
    iconUri: `ipfs://${iconCid}`,
    metadata,
    uploadMode: "pinata",
  };
}
