#!/usr/bin/env bash
# Fail CI if any VITE_*SECRET*, VITE_*PRIVATE*, or VITE_*API_KEY* variable
# names appear in source or .env files under client/.
# These names indicate credentials that must NOT be shipped in the browser bundle.
set -euo pipefail

ROOT="${1:-client}"
PATTERN='VITE_[A-Z0-9_]*(SECRET|PRIVATE|API_KEY|PRIVATE_KEY)[A-Z0-9_]*'
FOUND=0

echo "Scanning ${ROOT} for unsafe VITE_ variable names..."

while IFS= read -r -d '' file; do
  # Skip node_modules and dist
  case "$file" in
    *node_modules*|*/dist/*) continue ;;
  esac

  matches=$(grep -nP "$PATTERN" "$file" 2>/dev/null || true)
  if [[ -n "$matches" ]]; then
    echo ""
    echo "❌ Unsafe VITE_ variable found in: $file"
    echo "$matches"
    FOUND=1
  fi
done < <(find "$ROOT" -type f \( \
  -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \
  -o -name "*.env" -o -name "*.env.*" -o -name ".env*" \
\) -print0)

if [[ $FOUND -eq 1 ]]; then
  echo ""
  echo "CI FAILED: One or more secrets are exposed as VITE_ variables."
  echo "Move them to the server and proxy access through a backend endpoint."
  exit 1
fi

echo "✅ No unsafe VITE_ variable names detected."
