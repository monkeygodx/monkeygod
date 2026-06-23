'use strict';

/**
 * MONKEYGOD — landing + checkout server (hosted on Railway).
 *
 * Config/secrets live in a Cloudflare R2 bucket (default "monkeygod") at
 * data/config.json. THIS server reads that file at runtime (short cache) via the
 * R2 S3 API, so the Square live key / location / crypto / links can be changed in
 * the bucket without redeploying Railway. If no R2 creds are set, it falls back
 * to the matching environment variables (handy for local dev).
 *
 * Payment model (digital goods, manual fulfilment via Telegram):
 *   - Card  -> embedded Square Web Payments SDK; browser tokenizes the card and
 *             POSTs a one-time token to /api/charge, charged server-side.
 *   - Crypto -> wallet addresses shown on-page; customer DMs admin the TXID.
 * There is NO PayPal path anywhere by design.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

// ---------------------------------------------------------------------------
// Tiny .env loader (avoids a dotenv dependency). Real env vars win over .env.
// ---------------------------------------------------------------------------
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) {
    console.warn('[env] could not read .env:', e.message);
  }
})();

const PORT = parseInt(process.env.PORT || '4000', 10);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// Two-domain setup: main site (.fun) and the payment site (.cloud). Both are
// served by THIS one app; requests are routed by hostname. The "Get" buttons on
// the main site send the buyer to PAYMENT_SITE_URL to actually pay.
const PAYMENT_HOST = (process.env.PAYMENT_HOST || 'monkeygod.cloud').toLowerCase();
const PAYMENT_SITE_URL = (process.env.PAYMENT_SITE_URL || 'https://monkeygod.cloud').replace(/\/$/, '');
const MAIN_SITE_URL = (process.env.MAIN_SITE_URL || 'https://monkeygod.fun').replace(/\/$/, '');

const PREVIEW_BASE_URL = (process.env.PREVIEW_BASE_URL || '').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Product catalog — SERVER is the source of truth for prices (never trust the
// client). Amounts are in cents (USD).
// ---------------------------------------------------------------------------
const PRODUCTS = {
  basic: { id: 'basic', name: 'MONKEYGOD — BASIC', amount: 1500 },
  premium: { id: 'premium', name: 'MONKEYGOD — PREMIUM', amount: 2500 },
  exclusive: { id: 'exclusive', name: 'MONKEYGOD — EXCLUSIVE', amount: 5000 },
};

// ---------------------------------------------------------------------------
// Cloudflare R2 (S3 API) — where the live config/secrets live.
// ---------------------------------------------------------------------------
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_BUCKET = process.env.R2_BUCKET || 'monkeygod';
const R2_CONFIG_KEY = process.env.R2_CONFIG_KEY || 'data/config.json';
const R2_OVERRIDE_KEY = process.env.R2_OVERRIDE_KEY || 'data/override.html';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_READY = Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
const CONFIG_TTL_MS = parseInt(process.env.CONFIG_TTL_MS || '30000', 10);

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();

// Minimal AWS SigV4 GET of one object from the R2 S3 endpoint (region "auto").
// Returns the body text, or null if missing / not configured / on error.
async function r2GetObject(key) {
  if (!R2_READY) return null;
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const canonicalUri = '/' + R2_BUCKET + '/' + key.split('/').map(encodeURIComponent).join('/');
  const region = 'auto';
  const service = 's3';
  const amzdate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const datestamp = amzdate.slice(0, 8);
  const payloadHash = sha256hex('');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzdate}\n`;
  const signedHeadersStr = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['GET', canonicalUri, '', canonicalHeaders, signedHeadersStr, payloadHash].join('\n');
  const scope = `${datestamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, scope, sha256hex(canonicalRequest)].join('\n');
  let k = hmac('AWS4' + R2_SECRET_ACCESS_KEY, datestamp);
  k = hmac(k, region);
  k = hmac(k, service);
  k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, ` +
    `SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

  const res = await fetch(`https://${host}${canonicalUri}`, {
    headers: { Authorization: authorization, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzdate, host },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn('[r2] get failed', key, res.status);
    return null;
  }
  return res.text();
}

async function r2GetConfig() {
  const txt = await r2GetObject(R2_CONFIG_KEY);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (e) { console.warn('[r2] config.json is not valid JSON'); return null; }
}

// Emergency kill-switch: if data/override.html in the bucket is non-empty, that
// HTML replaces every page on the live site. Empty/missing = normal site.
let _ovHtml = null;
let _ovAt = 0;
async function loadOverride() {
  if (!R2_READY) return null;
  if (Date.now() - _ovAt < CONFIG_TTL_MS) return _ovHtml;
  try {
    const t = await r2GetObject(R2_OVERRIDE_KEY);
    _ovHtml = t && t.trim() ? t : null;
  } catch (e) { /* keep last known value */ }
  _ovAt = Date.now();
  return _ovHtml;
}

// Defaults pulled from env vars (used locally / as fallback when R2 isn't set).
function envDefaults() {
  return {
    square: {
      env: (process.env.SQUARE_ENV || 'sandbox').toLowerCase(),
      accessToken: process.env.SQUARE_ACCESS_TOKEN || '',
      locationId: process.env.SQUARE_LOCATION_ID || '',
      appId: process.env.SQUARE_APP_ID || '',
      version: process.env.SQUARE_VERSION || '',
    },
    crypto: [
      { coin: 'BTC', label: 'Bitcoin', address: process.env.CRYPTO_BTC || '' },
      { coin: 'ETH', label: 'Ethereum (ERC-20)', address: process.env.CRYPTO_ETH || '' },
      { coin: 'USDT', label: 'USDT (TRC-20)', address: process.env.CRYPTO_USDT_TRC20 || '' },
      { coin: 'LTC', label: 'Litecoin', address: process.env.CRYPTO_LTC || '' },
      { coin: 'SOL', label: 'Solana', address: process.env.CRYPTO_SOL || '' },
    ].filter((c) => c.address),
    links: {
      admin: process.env.TELEGRAM_ADMIN || 'https://t.me/youradmin',
      channel: process.env.TELEGRAM_CHANNEL || 'https://t.me/yourchannel',
      chatroom: process.env.TELEGRAM_CHATROOM || 'https://t.me/yourchatroom',
    },
    // Per-tier private invite links shown after a successful payment.
    tierLinks: {
      basic: process.env.TIER_LINK_BASIC || '',
      premium: process.env.TIER_LINK_PREMIUM || '',
      exclusive: process.env.TIER_LINK_EXCLUSIVE || '',
    },
    discordWebhook: process.env.DISCORD_WEBHOOK || '',
  };
}

// Merge the bucket config over the env defaults (bucket wins where it provides a
// value). Cached for CONFIG_TTL_MS so we don't hit R2 on every request.
let _cfgCache = null;
let _cfgAt = 0;
async function loadConfig() {
  if (_cfgCache && Date.now() - _cfgAt < CONFIG_TTL_MS) return _cfgCache;
  const base = envDefaults();
  try {
    const remote = await r2GetConfig();
    if (remote && typeof remote === 'object') {
      const rs = remote.square || {};
      base.square = {
        env: (rs.env || base.square.env).toLowerCase(),
        accessToken: rs.accessToken || base.square.accessToken,
        locationId: rs.locationId || base.square.locationId,
        appId: rs.appId || base.square.appId,
        version: rs.version || base.square.version,
      };
      if (Array.isArray(remote.crypto)) {
        const c = remote.crypto.filter((x) => x && x.address);
        if (c.length) base.crypto = c;
      }
      // For links/tierLinks, only NON-EMPTY bucket values override (so a blank
      // emergency-backup field never wipes out the live value).
      if (remote.links && typeof remote.links === 'object') {
        for (const kk of Object.keys(remote.links)) if (remote.links[kk]) base.links[kk] = remote.links[kk];
      }
      if (remote.tierLinks && typeof remote.tierLinks === 'object') {
        for (const kk of Object.keys(remote.tierLinks)) if (remote.tierLinks[kk]) base.tierLinks[kk] = remote.tierLinks[kk];
      }
      if (remote.discordWebhook) base.discordWebhook = remote.discordWebhook;
    }
  } catch (e) {
    console.warn('[config] using env fallback:', e.message);
  }
  _cfgCache = base;
  _cfgAt = Date.now();
  return base;
}

// Derived Square helpers from a resolved config.
function squareCtx(cfg) {
  const sq = cfg.square || {};
  const apiBase = sq.env === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
  const ready = Boolean(sq.accessToken && sq.locationId); // hosted checkout
  const embedReady = Boolean(ready && sq.appId); // embedded card form
  return { sq, apiBase, ready, embedReady };
}

// Fire-and-forget Discord notification on a successful payment. The webhook URL
// comes from config (DISCORD_WEBHOOK env var or the bucket's discordWebhook).
async function notifyDiscord(webhook, { product, amountCents, paymentId, status }) {
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'MONKEYGOD',
        embeds: [
          {
            title: '💸 Payment received',
            color: 0xa855f7,
            fields: [
              { name: 'Product', value: String(product || '—'), inline: true },
              { name: 'Amount', value: `$${(amountCents / 100).toFixed(2)}`, inline: true },
              { name: 'Status', value: String(status || 'COMPLETED'), inline: true },
              ...(paymentId ? [{ name: 'Payment ID', value: '`' + paymentId + '`', inline: false }] : []),
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
  } catch (e) {
    console.warn('[discord] notify failed', e.message);
  }
}

function listPreviews() {
  try {
    return fs
      .readdirSync(path.join(__dirname, 'public', 'previews'))
      .filter((f) => /\.(mp4|webm)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((f) => (PREVIEW_BASE_URL ? `${PREVIEW_BASE_URL}/${f}` : `/previews/${f}`));
  } catch (e) {
    return [];
  }
}

const app = express();
app.use(express.json());
app.disable('x-powered-by');

// Emergency override: when data/override.html in the bucket is non-empty, serve
// it for every page route (APIs, assets and the Apple Pay file still work).
const isPageRoute = (p) => p === '/' || !/\.[a-z0-9]+$/i.test(p);
app.use(async (req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/.well-known/')) return next();
  if (!isPageRoute(req.path)) return next();
  try {
    const ov = await loadOverride();
    if (ov) return res.set('cache-control', 'no-store').type('html').send(ov);
  } catch (e) { /* fall through to normal site */ }
  next();
});

// Public config the frontend needs to render (no secrets).
app.get('/api/config', async (req, res) => {
  const cfg = await loadConfig();
  const { sq, ready, embedReady } = squareCtx(cfg);
  res.json({
    products: PRODUCTS,
    previews: listPreviews(),
    crypto: cfg.crypto,
    links: cfg.links,
    tierLinks: cfg.tierLinks,
    squareReady: ready,
    squareEmbedReady: embedReady,
    squareEnv: sq.env,
    // Public values the embedded Web Payments SDK needs in the browser.
    squareAppId: sq.appId,
    squareLocationId: sq.locationId,
    paymentSiteUrl: PAYMENT_SITE_URL,
    mainSiteUrl: MAIN_SITE_URL,
  });
});

// EMBEDDED card charge: the browser tokenizes the card with the Web Payments SDK
// and posts the one-time {sourceId} here; we charge it server-side. The amount is
// taken from the SERVER product table — the client cannot set the price.
app.post('/api/charge', async (req, res) => {
  try {
    const { tier, sourceId, buyerVerificationToken } = req.body || {};
    const product = PRODUCTS[tier];
    if (!product) return res.status(400).json({ error: 'Unknown tier.' });
    if (!sourceId) return res.status(400).json({ error: 'Missing card token.' });

    const cfg = await loadConfig();
    const { sq, apiBase, embedReady } = squareCtx(cfg);
    if (!embedReady) {
      return res.status(503).json({
        error: 'card_unconfigured',
        message: 'Card payments are not live yet. Pay with crypto or DM the admin.',
      });
    }

    const body = {
      idempotency_key: crypto.randomUUID(),
      source_id: sourceId,
      location_id: sq.locationId,
      amount_money: { amount: product.amount, currency: 'USD' },
      autocomplete: true,
      note: product.name,
    };
    if (buyerVerificationToken) body.verification_token = buyerVerificationToken;

    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${sq.accessToken}` };
    if (sq.version) headers['Square-Version'] = sq.version;

    const sqRes = await fetch(`${apiBase}/v2/payments`, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await sqRes.json().catch(() => ({}));

    if (!sqRes.ok) {
      console.error('[square] charge error', sqRes.status, JSON.stringify(data));
      const detail = data && data.errors && data.errors[0] ? data.errors[0].detail : 'Card was declined.';
      return res.status(402).json({ error: 'card_declined', message: detail });
    }

    const payment = data && data.payment;
    // Ping Discord (don't block the buyer's response on it).
    notifyDiscord(cfg.discordWebhook, {
      product: product.name,
      amountCents: product.amount,
      paymentId: payment && payment.id,
      status: payment && payment.status,
    });
    return res.json({
      ok: true,
      paymentId: payment && payment.id,
      status: payment && payment.status,
      redirect: `/success?tier=${encodeURIComponent(tier)}`,
    });
  } catch (err) {
    console.error('[charge] fatal', err);
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong taking the payment.' });
  }
});

// Create a Square hosted-checkout link for {tier} and return its URL.
app.post('/api/checkout', async (req, res) => {
  try {
    const { tier } = req.body || {};
    const product = PRODUCTS[tier];
    if (!product) return res.status(400).json({ error: 'Unknown tier.' });

    const cfg = await loadConfig();
    const { sq, apiBase, ready } = squareCtx(cfg);
    if (!ready) {
      return res.status(503).json({
        error: 'card_unconfigured',
        message: 'Card checkout is not live yet. Pay with crypto or DM the admin to complete your order.',
      });
    }

    const body = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: sq.locationId,
        line_items: [{ name: product.name, quantity: '1', base_price_money: { amount: product.amount, currency: 'USD' } }],
      },
      checkout_options: {
        redirect_url: `${PUBLIC_BASE_URL}/success?tier=${encodeURIComponent(tier)}`,
        ask_for_shipping_address: false,
      },
    };

    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${sq.accessToken}` };
    if (sq.version) headers['Square-Version'] = sq.version;

    const sqRes = await fetch(`${apiBase}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await sqRes.json().catch(() => ({}));

    if (!sqRes.ok) {
      console.error('[square] error', sqRes.status, JSON.stringify(data));
      const detail = data && data.errors && data.errors[0] ? data.errors[0].detail : 'Square rejected the request.';
      return res.status(502).json({ error: 'square_error', message: detail });
    }

    const url = data && data.payment_link && (data.payment_link.long_url || data.payment_link.url);
    if (!url) return res.status(502).json({ error: 'no_url', message: 'No checkout URL returned.' });
    return res.json({ url });
  } catch (err) {
    console.error('[checkout] fatal', err);
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong creating the checkout.' });
  }
});

// Root routing by hostname: the payment domain (.cloud) shows the embedded card
// page; everything else (the .fun main site, localhost) shows the landing.
function isPaymentHost(req) {
  const host = (req.hostname || '').toLowerCase();
  return host === PAYMENT_HOST || host.endsWith('.cloud') || host.endsWith(PAYMENT_HOST);
}
app.get('/', (req, res, next) => {
  if (isPaymentHost(req)) return res.sendFile(path.join(__dirname, 'public', 'pay.html'));
  next(); // fall through to express.static -> index.html
});

// The embedded card checkout is always reachable at /pay (any domain), and at a
// clean per-tier URL: /basic, /premium, /exclusive (tier read from the path).
app.get(['/pay', '/basic', '/premium', '/exclusive'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
});

// Apple Pay domain verification — served verbatim so Apple/Square can verify the
// domain (express.static ignores dot-directories, so this needs its own route).
app.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => {
  res.type('text/plain');
  res.sendFile(path.join(__dirname, 'public', '.well-known', 'apple-developer-merchantid-domain-association'));
});

// Static assets.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Thank-you page after a successful Square payment.
app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'success.html'));
});

app.listen(PORT, async () => {
  const cfg = await loadConfig();
  const { sq, embedReady } = squareCtx(cfg);
  console.log('');
  console.log('  MONKEYGOD running');
  console.log(`  Local:        ${PUBLIC_BASE_URL}  (landing: /  ·  payment: /pay)`);
  console.log(`  Main site:    ${MAIN_SITE_URL}`);
  console.log(`  Payment site: ${PAYMENT_SITE_URL}  (host "${PAYMENT_HOST}")`);
  console.log(`  Config from:  ${R2_READY ? `R2 bucket "${R2_BUCKET}" (${R2_CONFIG_KEY})` : 'env vars (.env) — R2 not configured'}`);
  console.log(`  Square card:  ${embedReady ? `EMBEDDED ready (${sq.env})` : 'NOT live yet — needs token + location + appId (crypto/DM still work)'}`);
  console.log(`  Crypto coins: ${cfg.crypto.length ? cfg.crypto.map((c) => c.coin).join(', ') : 'none set'}`);
  console.log('');
});
