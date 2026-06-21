'use strict';

/**
 * MONKEYGOD — landing + checkout server.
 *
 * Payment model (digital goods, manual fulfilment via Telegram):
 *   - Card  -> Square hosted checkout (Payment Links API). Customer pays on
 *             Square's page, gets redirected back to /success, then DMs admin.
 *   - Crypto -> wallet addresses shown on-page; customer DMs admin the TXID.
 *
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

// Two-domain setup: main site (.fun) and the payment site (.xyz). Both are
// served by THIS one app; requests are routed by hostname. The "Get" buttons on
// the main site send the buyer to PAYMENT_SITE_URL to actually pay.
const PAYMENT_HOST = (process.env.PAYMENT_HOST || 'monkeygod.cloud').toLowerCase();
const PAYMENT_SITE_URL = (process.env.PAYMENT_SITE_URL || 'https://monkeygod.cloud').replace(/\/$/, '');
const MAIN_SITE_URL = (process.env.MAIN_SITE_URL || 'https://monkeygod.fun').replace(/\/$/, '');

const SQUARE_ENV = (process.env.SQUARE_ENV || 'sandbox').toLowerCase();
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || '';
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || '';
// Application ID is PUBLIC (the browser needs it to load the Web Payments SDK).
const SQUARE_APP_ID = process.env.SQUARE_APP_ID || '';
const SQUARE_VERSION = process.env.SQUARE_VERSION || ''; // optional; blank => app default
const SQUARE_API_BASE =
  SQUARE_ENV === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
// Hosted-checkout needs token + location. The EMBEDDED card form additionally
// needs the public application id in the browser.
const SQUARE_READY = Boolean(SQUARE_ACCESS_TOKEN && SQUARE_LOCATION_ID);
const SQUARE_EMBED_READY = Boolean(SQUARE_READY && SQUARE_APP_ID);

// ---------------------------------------------------------------------------
// Product catalog — SERVER is the source of truth for prices (never trust the
// client). Amounts are in cents (USD).
// ---------------------------------------------------------------------------
const PRODUCTS = {
  basic: { id: 'basic', name: 'MONKEYGOD — BASIC', amount: 1500 },
  premium: { id: 'premium', name: 'MONKEYGOD — PREMIUM', amount: 2500 },
  exclusive: { id: 'exclusive', name: 'MONKEYGOD — EXCLUSIVE', amount: 5000 },
};

const CRYPTO = [
  { coin: 'BTC', label: 'Bitcoin', address: process.env.CRYPTO_BTC || '' },
  { coin: 'ETH', label: 'Ethereum (ERC-20)', address: process.env.CRYPTO_ETH || '' },
  { coin: 'USDT', label: 'USDT (TRC-20)', address: process.env.CRYPTO_USDT_TRC20 || '' },
  { coin: 'LTC', label: 'Litecoin', address: process.env.CRYPTO_LTC || '' },
  { coin: 'SOL', label: 'Solana', address: process.env.CRYPTO_SOL || '' },
].filter((c) => c.address);

const LINKS = {
  admin: process.env.TELEGRAM_ADMIN || 'https://t.me/youradmin',
  channel: process.env.TELEGRAM_CHANNEL || 'https://t.me/yourchannel',
  chatroom: process.env.TELEGRAM_CHATROOM || 'https://t.me/yourchatroom',
};

const PREVIEW_BASE_URL = (process.env.PREVIEW_BASE_URL || '').replace(/\/$/, '');
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

// Public config the frontend needs to render (no secrets).
app.get('/api/config', (req, res) => {
  res.json({
    products: PRODUCTS,
    previews: listPreviews(),
    crypto: CRYPTO,
    links: LINKS,
    squareReady: SQUARE_READY,
    squareEmbedReady: SQUARE_EMBED_READY,
    squareEnv: SQUARE_ENV,
    // Public values the embedded Web Payments SDK needs in the browser.
    squareAppId: SQUARE_APP_ID,
    squareLocationId: SQUARE_LOCATION_ID,
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

    if (!SQUARE_EMBED_READY) {
      return res.status(503).json({
        error: 'card_unconfigured',
        message: 'Card payments are not live yet. Pay with crypto or DM the admin.',
      });
    }

    const body = {
      idempotency_key: crypto.randomUUID(),
      source_id: sourceId,
      location_id: SQUARE_LOCATION_ID,
      amount_money: { amount: product.amount, currency: 'USD' },
      autocomplete: true,
      note: product.name,
    };
    if (buyerVerificationToken) body.verification_token = buyerVerificationToken;

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
    };
    if (SQUARE_VERSION) headers['Square-Version'] = SQUARE_VERSION;

    const sqRes = await fetch(`${SQUARE_API_BASE}/v2/payments`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await sqRes.json().catch(() => ({}));

    if (!sqRes.ok) {
      console.error('[square] charge error', sqRes.status, JSON.stringify(data));
      const detail = data && data.errors && data.errors[0] ? data.errors[0].detail : 'Card was declined.';
      return res.status(402).json({ error: 'card_declined', message: detail });
    }

    const payment = data && data.payment;
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

// Create a Square hosted-checkout link for {tier, omegle?} and return its URL.
app.post('/api/checkout', async (req, res) => {
  try {
    const { tier } = req.body || {};
    const product = PRODUCTS[tier];
    if (!product) return res.status(400).json({ error: 'Unknown tier.' });

    if (!SQUARE_READY) {
      return res.status(503).json({
        error: 'card_unconfigured',
        message:
          'Card checkout is not live yet. Pay with crypto or DM the admin to complete your order.',
      });
    }

    const body = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: SQUARE_LOCATION_ID,
        line_items: [
          {
            name: product.name,
            quantity: '1',
            base_price_money: { amount: product.amount, currency: 'USD' },
          },
        ],
      },
      checkout_options: {
        redirect_url: `${PUBLIC_BASE_URL}/success?tier=${encodeURIComponent(tier)}`,
        ask_for_shipping_address: false,
      },
    };

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
    };
    if (SQUARE_VERSION) headers['Square-Version'] = SQUARE_VERSION;

    const sqRes = await fetch(`${SQUARE_API_BASE}/v2/online-checkout/payment-links`, {
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

// Root routing by hostname: the payment domain (.xyz) shows the embedded card
// page; everything else (the .fun main site, localhost) shows the landing.
function isPaymentHost(req) {
  const host = (req.hostname || '').toLowerCase();
  return host === PAYMENT_HOST || host.endsWith('.cloud') || host.endsWith(PAYMENT_HOST);
}
app.get('/', (req, res, next) => {
  if (isPaymentHost(req)) return res.sendFile(path.join(__dirname, 'public', 'pay.html'));
  next(); // fall through to express.static -> index.html
});

// The embedded card checkout is always reachable at /pay (any domain).
app.get('/pay', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
});

// Static assets.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Thank-you page after a successful Square payment.
app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'success.html'));
});

app.listen(PORT, () => {
  console.log('');
  console.log('  MONKEYGOD running');
  console.log(`  Local:        ${PUBLIC_BASE_URL}  (landing: /  ·  payment: /pay)`);
  console.log(`  Main site:    ${MAIN_SITE_URL}`);
  console.log(`  Payment site: ${PAYMENT_SITE_URL}  (host "${PAYMENT_HOST}")`);
  console.log(`  Square card:  ${SQUARE_EMBED_READY ? `EMBEDDED ready (${SQUARE_ENV})` : 'NOT live yet — set SQUARE_APP_ID + token + location (crypto/DM still work)'}`);
  console.log(`  Crypto coins: ${CRYPTO.length ? CRYPTO.map((c) => c.coin).join(', ') : 'none set'}`);
  console.log('');
});
