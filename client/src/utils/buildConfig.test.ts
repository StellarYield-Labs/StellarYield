import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { parseBooleanConfig, parseBoolean } from "./buildConfig";

const VITE_CONFIG_PATH = resolve(__dirname, "../../vite.config.ts");

/**
 * Regression tests for the Vite/Vercel production build configuration.
 *
 * Vercel deploys the client as a static site. The `base: './'` setting in
 * vite.config.ts is required so asset URLs are relative — without it, assets
 * 404 when served from a sub-path or CDN prefix.
 */
describe("Vercel production build config", () => {
  let configSource: string;

  try {
    configSource = readFileSync(VITE_CONFIG_PATH, "utf-8");
  } catch {
    configSource = "";
  }

  it("vite.config.ts exists", () => {
    expect(configSource.length).toBeGreaterThan(0);
  });

  it("base is set to './' for relative asset paths on Vercel", () => {
    expect(configSource).toMatch(/base\s*:\s*['"]\.\//);
  });

  it("@vitejs/plugin-react is included", () => {
    expect(configSource).toMatch(/@vitejs\/plugin-react/);
  });

  it("@tailwindcss/vite plugin is included", () => {
    expect(configSource).toMatch(/@tailwindcss\/vite/);
  });
});

describe("build config boolean parser", () => {
  it("accepts uppercase boolean string 'TRUE' as true (#174)", () => {
    expect(parseBooleanConfig("TRUE")).toBe(true);
    expect(parseBoolean("TRUE")).toBe(true);
  });

  it("accepts lowercase and mixed-case boolean strings", () => {
    expect(parseBooleanConfig("true")).toBe(true);
    expect(parseBooleanConfig("True")).toBe(true);
    expect(parseBooleanConfig("tRuE")).toBe(true);
  });

  it("handles false values in uppercase, lowercase, and mixed-case", () => {
    expect(parseBooleanConfig("FALSE")).toBe(false);
    expect(parseBooleanConfig("false")).toBe(false);
    expect(parseBooleanConfig("False")).toBe(false);
  });

  it("handles numeric strings and numbers", () => {
    expect(parseBooleanConfig("1")).toBe(true);
    expect(parseBooleanConfig("0")).toBe(false);
    expect(parseBooleanConfig(1)).toBe(true);
    expect(parseBooleanConfig(0)).toBe(false);
  });

  it("handles boolean types directly", () => {
    expect(parseBooleanConfig(true)).toBe(true);
    expect(parseBooleanConfig(false)).toBe(false);
  });

  it("falls back to defaultValue for undefined, null, or invalid values", () => {
    expect(parseBooleanConfig(undefined)).toBe(false);
    expect(parseBooleanConfig(null)).toBe(false);
    expect(parseBooleanConfig(undefined, true)).toBe(true);
    expect(parseBooleanConfig("invalid", true)).toBe(true);
    expect(parseBooleanConfig(42, true)).toBe(true);
  });
});

