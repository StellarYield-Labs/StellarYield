/**
 * Utility functions for parsing build configuration and environment variables.
 */

/**
 * Parses a boolean configuration value from build or environment configuration.
 *
 * Accepts case-insensitive boolean string representations:
 * - `true`, `"true"`, `"TRUE"`, `"1"`, `1` -> `true`
 * - `false`, `"false"`, `"FALSE"`, `"0"`, `0` -> `false`
 *
 * @param value The value to parse
 * @param defaultValue Optional fallback if value is undefined or invalid
 * @returns boolean representation
 */
export function parseBooleanConfig(
  value: string | boolean | number | null | undefined,
  defaultValue = false,
): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return defaultValue;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }

  return defaultValue;
}

/**
 * Alias for `parseBooleanConfig`.
 */
export const parseBoolean = parseBooleanConfig;
