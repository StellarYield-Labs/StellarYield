# Metrics token rotation (production)

In production, StellarYield protects metrics endpoints with `METRICS_TOKEN`:

- JSON metrics: `GET /api/metrics`
- Prometheus scrape: `GET /metrics`

Both endpoints accept either:

- `Authorization: Bearer <token>` or
- `x-metrics-token: <token>`

This guide explains how to rotate the token without downtime and without leaking secrets in logs or PRs.

---

## Goals and constraints

- **Do not log tokens** in CI, terminals, dashboards, or support requests.
- **No downtime**: allow the new token to be verified before deprecating the old one.
- **Least privilege**: store the token only in your secrets manager / deployment platform.

---

## Recommended rotation approach (two-token window)

The backend currently supports a single `METRICS_TOKEN` value. To rotate safely, you need a short window where both tokens work. There are two operational ways to do this:

### Option A: rotate via proxy (recommended)

1. Keep the backend configured with the **old** token.
2. Update your scraper/proxy to send the **new** token upstream while translating to the old token at the backend boundary.
3. Deploy backend with the **new** `METRICS_TOKEN`.
4. Remove translation once the backend is fully on the new token.

This avoids a period where scrapes fail, and avoids needing the backend to accept two tokens.

### Option B: coordinated cutover (simple, small risk)

If you can tolerate a short scrape gap:

1. Update the backend deployment secret `METRICS_TOKEN` to the **new** value.
2. Deploy.
3. Update the metrics scraper configuration to use the **new** value.

---

## Step-by-step: coordinated cutover (Option B)

### 1) Prepare a new token

Generate a long random token (store it only in your secret manager). Example commands:

```bash
# macOS / Linux (prints the token ONCE; do not paste into logs)
openssl rand -base64 48
```

Do **not** commit the token anywhere. Do **not** paste it into GitHub issues or PRs.

### 2) Update the production secret

Update `METRICS_TOKEN` in your production environment (Vercel, container runtime, systemd unit, Kubernetes secret, etc.).

### 3) Deploy backend

Redeploy the backend so `process.env.METRICS_TOKEN` updates.

### 4) Validate access after rotation

Validate both endpoints using header-based auth (do not put tokens in URLs).

```bash
export BACKEND_URL="https://your-backend.example.com"
export METRICS_TOKEN="REDACTED"  # shell history risk: consider typing directly instead of export

# JSON metrics
curl -fsS "$BACKEND_URL/api/metrics" -H "x-metrics-token: $METRICS_TOKEN" | jq .

# Prometheus scrape (plain text)
curl -fsS "$BACKEND_URL/metrics" -H "Authorization: Bearer $METRICS_TOKEN" | head
```

Expected outcomes:

- With the correct token: **200**
- With a missing/incorrect token in production: **404** (intentional)

### 5) Update your scraper

Update Prometheus / Grafana Agent / whatever scrapes the endpoint to send the new header:

- `Authorization: Bearer <token>` or `x-metrics-token: <token>`

Then confirm scrapes are succeeding again and dashboards show fresh timestamps.

---

## Validating production configuration (optional check)

Before deploying, you can run the optional check script:

```bash
cd server
NODE_ENV=production METRICS_TOKEN="REDACTED" node scripts/check-metrics-token.js
```

This script **never prints the token**, it only validates presence when `NODE_ENV=production`.

---

## Troubleshooting

- **Metrics endpoint returns 404 in production**
  - Wrong or missing header, or the backend is running without `METRICS_TOKEN`.
  - Confirm `METRICS_TOKEN` is set in the runtime environment and the scraper is sending the correct header.
- **Metrics scrape is rate-limited (429)**
  - `/metrics` is rate-limited to reduce brute-force attempts. Adjust scrape intervals or spread scrapes across time.

