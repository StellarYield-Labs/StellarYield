#!/usr/bin/env node

const https = require('https');
const http = require('http');
const fs = require('fs');
const { URL } = require('url');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.PREVIEW_API_BASE_URL ||
  process.env.VITE_API_BASE_URL ||
  process.env.VITE_API_URL ||
  process.env.BACKEND_URL ||
  'http://localhost:3001';
const BACKEND_URL = process.env.BACKEND_URL || API_BASE_URL;
const BACKEND_HEALTH_PATH = process.env.BACKEND_HEALTH_PATH || '/api/health';
const BACKEND_YIELDS_PATH = process.env.BACKEND_YIELDS_PATH || '/api/yields';
const BACKEND_SAFE_PATH = process.env.BACKEND_SAFE_PATH || '/api/openapi';
const FRONTEND_ASSET_PATH = process.env.FRONTEND_ASSET_PATH || '/favicon.svg';
const FRONTEND_API_BASE_URL =
  process.env.VITE_API_BASE_URL ||
  process.env.VITE_API_URL ||
  process.env.PREVIEW_API_BASE_URL ||
  process.env.API_BASE_URL ||
  '';

function parseArgs(argv) {
  const flags = new Set();
  /** @type {{ markdownOut: string | null }} */
  const opts = { markdownOut: null };
  for (const a of argv) {
    if (a === '--report') flags.add('report');
    else if (a === '--markdown') flags.add('markdown');
    else if (a.startsWith('--markdown-out=')) {
      flags.add('markdown');
      opts.markdownOut = a.slice('--markdown-out='.length).trim() || null;
    }
  }
  return { flags, opts };
}

function diagnosticForRequestError(error) {
  if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
    return `DNS lookup failed (${error.code}). Check the hostname and deployment DNS.`;
  }
  if (error.code === 'ECONNREFUSED') {
    return 'Connection refused. The service may be down or listening on a different port.';
  }
  if (error.code === 'ECONNRESET') {
    return 'Connection reset before a response was received. Check TLS or proxy configuration.';
  }
  return error.message || 'Request failed before receiving an HTTP response.';
}

function requestUrl(url, options = {}) {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const req = client.request(
        url,
        { method: options.method || 'GET', timeout: 10000, headers: options.headers || {} },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
            if (body.length > 64_000) {
              body = body.slice(0, 64_000);
              req.destroy();
            }
          });
          res.on('end', () => {
            resolve({ httpCode: res.statusCode || 0, headers: res.headers, body });
          });
        },
      );

      req.on('error', (error) => {
        resolve({ httpCode: 0, headers: {}, body: '', message: diagnosticForRequestError(error) });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({
          httpCode: 0,
          headers: {},
          body: '',
          message: 'Request timed out after 10s. Check the target URL and network path.',
        });
      });

      req.end();
    } catch (error) {
      resolve({
        httpCode: 0,
        headers: {},
        body: '',
        message: `Invalid URL: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

/**
 * Make HTTP request and return status code
 * @param {string} url - URL to test
 * @returns {Promise<number>} HTTP status code (000 if unreachable)
 */
async function getStatusCode(url) {
  const result = await requestUrl(url);
  return result.httpCode;
}

/**
 * Test endpoint and expect 200 status
 * @param {string} label - Test description
 * @param {string} url - URL to test
 * @returns {Promise<boolean>} True if test passes
 */
async function expect200(label, url) {
  const result = await requestUrl(url);
  const status = result.httpCode;

  if (status === 200) {
    console.log(`[PASS] ${label} (200)`);
    return true;
  }
  if (status === 0) {
    console.log(`[FAIL] ${label} (unreachable)`);
    console.log(`   URL: ${url}`);
    console.log(`   Hint: ${result.message || 'set FRONTEND_URL/API_BASE_URL to deployed URLs or start local services.'}`);
  } else {
    console.log(`[FAIL] ${label} (${status})`);
    console.log(`   URL: ${url}`);
  }
  return false;
}

function isLocalUrl(value) {
  try {
    const hostname = new URL(value).hostname;
    return ['localhost', '127.0.0.1', '::1'].includes(hostname);
  } catch (_error) {
    return false;
  }
}

function validateFrontendApiConfig() {
  if (isLocalUrl(FRONTEND_URL)) {
    return { ok: true, message: 'Local frontend smoke test may rely on BACKEND_URL.' };
  }

  if (!FRONTEND_API_BASE_URL.trim()) {
    return {
      ok: false,
      message: 'Set API_BASE_URL, PREVIEW_API_BASE_URL, VITE_API_BASE_URL, or VITE_API_URL for deployed frontend smoke tests.',
    };
  }

  if (isLocalUrl(FRONTEND_API_BASE_URL)) {
    return {
      ok: false,
      message: `Frontend API base points at a local-only backend: ${FRONTEND_API_BASE_URL}`,
    };
  }

  return { ok: true, message: `Frontend API base: ${FRONTEND_API_BASE_URL}` };
}

function jsonShapeDiagnostic(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed === null || (typeof parsed !== 'object' && !Array.isArray(parsed))) {
      return 'JSON shape failure: expected an object or array response.';
    }
    return '';
  } catch (error) {
    return `JSON parse failure: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function corsDiagnostic(url) {
  const result = await requestUrl(url, {
    method: 'OPTIONS',
    headers: {
      Origin: FRONTEND_URL,
      'Access-Control-Request-Method': 'GET',
    },
  });
  const allowOrigin = result.headers['access-control-allow-origin'];
  const allowed =
    allowOrigin === '*' ||
    allowOrigin === FRONTEND_URL ||
    (Array.isArray(allowOrigin) && (allowOrigin.includes('*') || allowOrigin.includes(FRONTEND_URL)));

  if ((result.httpCode === 200 || result.httpCode === 204) && allowed) {
    return { ok: true, message: 'CORS preflight allows the configured frontend origin.' };
  }

  return {
    ok: false,
    message:
      result.httpCode === 0
        ? result.message || 'CORS preflight was unreachable.'
        : `CORS preflight returned ${result.httpCode}; access-control-allow-origin=${String(allowOrigin || 'missing')}.`,
  };
}

/**
 * Run all four smoke checks and return structured results (always runs every check).
 * @returns {Promise<{ ok: boolean, rows: { label: string, url: string, httpCode: number }[] }>}
 */
async function collectSmokeResults() {
  /** @type {{ label: string, url: string }[]} */
  const tests = [
    {
      label: 'Frontend API env',
      url: 'API_BASE_URL || PREVIEW_API_BASE_URL || VITE_API_BASE_URL || VITE_API_URL',
      config: validateFrontendApiConfig(),
    },
    ...(!isLocalUrl(FRONTEND_URL)
      ? [
          {
            label: 'Backend CORS preflight',
            url: `${BACKEND_URL}${BACKEND_HEALTH_PATH}`,
            cors: true,
          },
        ]
      : []),
    {
      label: `Backend ${BACKEND_HEALTH_PATH}`,
      url: `${BACKEND_URL}${BACKEND_HEALTH_PATH}`,
    },
    {
      label: `Backend ${BACKEND_YIELDS_PATH}`,
      url: `${BACKEND_URL}${BACKEND_YIELDS_PATH}`,
      json: true,
    },
    {
      label: `Backend ${BACKEND_SAFE_PATH}`,
      url: `${BACKEND_URL}${BACKEND_SAFE_PATH}`,
    },
    {
      label: 'Frontend /',
      url: `${FRONTEND_URL}/`,
    },
    {
      label: `Frontend ${FRONTEND_ASSET_PATH}`,
      url: `${FRONTEND_URL}${FRONTEND_ASSET_PATH}`,
    },
  ];

  /** @type {{ label: string, url: string, httpCode: number }[]} */
  const rows = [];
  for (const t of tests) {
    if (t.config) {
      rows.push({
        label: t.label,
        url: t.url,
        httpCode: t.config.ok ? 200 : 0,
        message: t.config.message,
      });
      continue;
    }
    if (t.cors) {
      const diagnostic = await corsDiagnostic(t.url);
      rows.push({
        label: t.label,
        url: t.url,
        httpCode: diagnostic.ok ? 200 : 0,
        message: diagnostic.message,
      });
      continue;
    }
    const result = await requestUrl(t.url);
    const message = t.json && result.httpCode === 200 ? jsonShapeDiagnostic(result.body) : result.message;
    rows.push({ label: t.label, url: t.url, httpCode: message ? 0 : result.httpCode, message });
  }
  const ok = rows.every((r) => r.httpCode === 200);
  return { ok, rows };
}

/**
 * @param {{ label: string, url: string, httpCode: number }[]} rows
 * @param {boolean} ok
 */
function buildMarkdownReport(rows, ok) {
  const ts = new Date().toISOString();
  const statusLine = ok ? '**Overall: PASS**' : '**Overall: FAIL**';
  const lines = [
    '# Release smoke report',
    '',
    `- **Time (UTC):** ${ts}`,
    `- **Frontend base:** \`${FRONTEND_URL}\``,
    `- **API base:** \`${BACKEND_URL}\``,
    `- **Frontend API env:** \`${FRONTEND_API_BASE_URL || '(not set)'}\``,
    `- ${statusLine}`,
    '',
    '| Check | URL | Result |',
    '| --- | --- | --- |',
  ];
  for (const r of rows) {
    const pass = r.httpCode === 200;
    const result =
      r.httpCode === 0
        ? `FAIL${r.message ? ` (${r.message})` : ' (unreachable)'}`
        : pass
          ? 'PASS (200)'
          : `FAIL (${r.httpCode})`;
    lines.push(`| ${r.label} | \`${r.url}\` | ${result} |`);
  }
  lines.push('');
  lines.push('### Rerun locally');
  lines.push('');
  lines.push('```bash');
  lines.push(
      `FRONTEND_URL="${FRONTEND_URL}" API_BASE_URL="${BACKEND_URL}" \\\n` +
      `  VITE_API_BASE_URL="${FRONTEND_API_BASE_URL || BACKEND_URL}" \\\n` +
      `  BACKEND_HEALTH_PATH="${BACKEND_HEALTH_PATH}" BACKEND_YIELDS_PATH="${BACKEND_YIELDS_PATH}" \\\n` +
      `  BACKEND_SAFE_PATH="${BACKEND_SAFE_PATH}" \\\n` +
      `  FRONTEND_ASSET_PATH="${FRONTEND_ASSET_PATH}" \\\n` +
      `  node scripts/smoke-test.js --report --markdown`,
  );
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

/**
 * Report mode: run all checks, print human log + optional markdown file.
 * @param {{ markdownOut: string | null }} opts
 */
async function runSmokeReport(opts) {
  console.log('----------------------------------------');
  console.log('StellarYield Smoke Test (report mode — all checks)');
  console.log('----------------------------------------');
  console.log(`Target Frontend: ${FRONTEND_URL}`);
  console.log(`Target API:      ${BACKEND_URL}`);
  console.log(`Frontend API:    ${FRONTEND_API_BASE_URL || '(not set)'}`);
  console.log('----------------------------------------');

  const { ok, rows } = await collectSmokeResults();
  const md = buildMarkdownReport(rows, ok);

  for (const r of rows) {
    const pass = r.httpCode === 200;
    if (r.label === 'Frontend API env' && pass) {
      console.log(`[PASS] ${r.label}`);
      if (r.message) console.log(`   ${r.message}`);
    } else if (pass) {
      console.log(`[PASS] ${r.label} (200)`);
    } else if (r.label === 'Frontend API env') {
      console.log(`[FAIL] ${r.label}`);
      if (r.message) console.log(`   ${r.message}`);
    } else if (r.httpCode === 0) {
      console.log(`[FAIL] ${r.label} (unreachable)`);
      console.log(`   URL: ${r.url}`);
    } else {
      console.log(`[FAIL] ${r.label} (${r.httpCode})`);
      console.log(`   URL: ${r.url}`);
    }
  }

  console.log('');
  console.log('----------------------------------------');
  console.log(ok ? 'All smoke tests passed.' : 'One or more smoke tests failed.');
  console.log('----------------------------------------');

  if (opts.markdownOut) {
    fs.writeFileSync(opts.markdownOut, md, 'utf8');
  }

  console.log('');
  console.log(md);

  process.exit(ok ? 0 : 1);
}

/**
 * Main smoke test function (fail-fast; default)
 */
async function runSmokeTest() {
  const apiConfig = validateFrontendApiConfig();
  console.log('----------------------------------------');
  console.log('StellarYield Smoke Test');
  console.log('----------------------------------------');
  console.log(`Target Frontend: ${FRONTEND_URL}`);
  console.log(`Target API:      ${BACKEND_URL}`);
  console.log(`Frontend API:    ${FRONTEND_API_BASE_URL || '(not set)'}`);
  console.log('----------------------------------------');

  const tests = [
    {
      step: '[1/6] Checking frontend API environment...',
      label: 'Frontend API env',
      config: apiConfig,
    },
    {
      step: '[2/6] Checking backend health...',
      label: `Backend ${BACKEND_HEALTH_PATH}`,
      url: `${BACKEND_URL}${BACKEND_HEALTH_PATH}`,
    },
    {
      step: '[3/6] Checking backend yield endpoint...',
      label: `Backend ${BACKEND_YIELDS_PATH}`,
      url: `${BACKEND_URL}${BACKEND_YIELDS_PATH}`,
    },
    {
      step: '[4/6] Checking backend unauthenticated-safe route...',
      label: `Backend ${BACKEND_SAFE_PATH}`,
      url: `${BACKEND_URL}${BACKEND_SAFE_PATH}`,
    },
    {
      step: '[5/6] Checking frontend root...',
      label: 'Frontend /',
      url: `${FRONTEND_URL}/`,
    },
    {
      step: '[6/6] Checking frontend static asset...',
      label: `Frontend ${FRONTEND_ASSET_PATH}`,
      url: `${FRONTEND_URL}${FRONTEND_ASSET_PATH}`,
    },
  ];

  for (const test of tests) {
    console.log('');
    console.log(test.step);
    if (test.config) {
      if (test.config.ok) {
        console.log(`[PASS] ${test.label}`);
        console.log(`   ${test.config.message}`);
        continue;
      }

      console.log(`[FAIL] ${test.label}`);
      console.log(`   ${test.config.message}`);
      process.exit(1);
    }
    const passed = await expect200(test.label, test.url);
    if (!passed) {
      process.exit(1);
    }
  }

  console.log('');
  console.log('----------------------------------------');
  console.log('All smoke tests passed.');
  console.log('----------------------------------------');
}

// Run the smoke test
if (require.main === module) {
  const { flags, opts } = parseArgs(process.argv.slice(2));

  if (flags.has('report')) {
    runSmokeReport(opts).catch((error) => {
      console.error('Smoke test failed with error:', error);
      process.exit(1);
    });
  } else {
    runSmokeTest().catch((error) => {
      console.error('Smoke test failed with error:', error);
      process.exit(1);
    });
  }
}

module.exports = {
  runSmokeTest,
  runSmokeReport,
  getStatusCode,
  expect200,
  collectSmokeResults,
  buildMarkdownReport,
  validateFrontendApiConfig,
};
