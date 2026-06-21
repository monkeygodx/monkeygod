/**
 * MONKEYGOD — Cloudflare Worker (production host).
 *
 * - Serves the static site (public/ via the ASSETS binding).
 * - Kill-switch: if R2 `data/override.html` is non-empty, that HTML replaces the
 *   ENTIRE site on every page route (default override is empty = normal site).
 * - Secrets live in R2 `data/config.json` (Square tokens, Discord webhook,
 *   crypto wallets, links) — never in code.
 * - POST /api/checkout  -> mints a Square hosted-checkout link.
 * - POST /api/square/webhook -> verifies Square's signature and pings Discord
 *   on every successful payment (works for sandbox AND live keys).
 */

// Prices are the source of truth here (not editable from the client/config).
const PRODUCTS = {
  basic: { id: 'basic', name: 'MONKEYGOD — BASIC', amount: 1499 },
  premium: { id: 'premium', name: 'MONKEYGOD — PREMIUM', amount: 2499 },
  exclusive: { id: 'exclusive', name: 'MONKEYGOD — EXCLUSIVE', amount: 4999 },
};
const SQUARE_VERSION = '2024-10-17';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/config') return apiConfig(env);
      if (path === '/api/checkout' && request.method === 'POST') return apiCheckout(request, env, url);
      if (path === '/api/square/webhook' && request.method === 'POST') return squareWebhook(request, env, ctx);

      // Kill-switch: replace every page route with the override HTML when set.
      if (request.method === 'GET' && !path.startsWith('/api/') && isPageRoute(path)) {
        const override = await readOverride(env);
        if (override) {
          return new Response(override, {
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          });
        }
      }

      // Static assets. Map extensionless page routes to their .html file.
      let assetReq = request;
      if (path === '/success') assetReq = new Request(new URL('/success.html', url.origin), request);
      return env.ASSETS.fetch(assetReq);
    } catch (err) {
      return json({ error: 'server_error', message: String(err && err.message || err) }, 500);
    }
  },
};

const isPageRoute = (p) => p === '/' || p === '/success' || !/\.[a-z0-9]+$/i.test(p);
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function getConfig(env) {
  try {
    const o = await env.BUCKET.get('data/config.json');
    if (!o) return {};
    return JSON.parse(await o.text());
  } catch (e) {
    return {};
  }
}

async function readOverride(env) {
  try {
    const o = await env.BUCKET.get('data/override.html');
    if (!o) return null;
    const t = await o.text();
    return t && t.trim() ? t : null;
  } catch (e) {
    return null;
  }
}

async function listPreviews(env) {
  const base = (env.PREVIEW_BASE_URL || '').replace(/\/$/, '');
  try {
    const l = await env.BUCKET.list({ prefix: 'preview' });
    return l.objects
      .map((o) => o.key)
      .filter((k) => /\.(mp4|webm)$/i.test(k))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((k) => (base ? `${base}/${k}` : `/${k}`));
  } catch (e) {
    return [];
  }
}

async function apiConfig(env) {
  const cfg = await getConfig(env);
  const sq = cfg.square || {};
  return json({
    products: PRODUCTS,
    previews: await listPreviews(env),
    crypto: cfg.crypto || [],
    links: cfg.links || {},
    squareReady: !!(sq.accessToken && sq.locationId),
    squareEnv: sq.env || 'sandbox',
  });
}

async function apiCheckout(request, env, url) {
  const cfg = await getConfig(env);
  const sq = cfg.square || {};
  let tier;
  try { ({ tier } = await request.json()); } catch (e) {}
  const product = PRODUCTS[tier];
  if (!product) return json({ error: 'Unknown tier.' }, 400);

  if (!(sq.accessToken && sq.locationId)) {
    return json({ error: 'card_unconfigured', message: 'Card checkout is not live yet. Pay with crypto or DM the admin.' }, 503);
  }

  const apiBase = sq.env === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
  const body = {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: sq.locationId,
      line_items: [{ name: product.name, quantity: '1', base_price_money: { amount: product.amount, currency: 'USD' } }],
    },
    checkout_options: { redirect_url: `${url.origin}/success?tier=${encodeURIComponent(tier)}`, ask_for_shipping_address: false },
  };

  const r = await fetch(`${apiBase}/v2/online-checkout/payment-links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sq.accessToken}`, 'square-version': SQUARE_VERSION },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = d && d.errors && d.errors[0] ? d.errors[0].detail : 'Square rejected the request.';
    return json({ error: 'square_error', message: detail }, 502);
  }
  const link = d.payment_link && (d.payment_link.long_url || d.payment_link.url);
  if (!link) return json({ error: 'no_url', message: 'No checkout URL returned.' }, 502);
  return json({ url: link });
}

/* ---------------- Square webhook -> Discord ---------------- */
async function squareWebhook(request, env, ctx) {
  const raw = await request.text();
  const cfg = await getConfig(env);
  const keys = (cfg.webhookSignatureKeys || []).filter(Boolean);
  const sig = request.headers.get('x-square-hmacsha256-signature') || '';
  const notifyUrl = cfg.webhookUrl || new URL(request.url).toString();

  // Verify against any configured key (sandbox + live). If none set yet, accept.
  let verified = keys.length === 0;
  for (const k of keys) {
    if (await verifySig(k, notifyUrl + raw, sig)) { verified = true; break; }
  }
  if (!verified) return new Response('invalid signature', { status: 401 });

  let evt = {};
  try { evt = JSON.parse(raw); } catch (e) {}
  const type = evt.type || '';
  const payment = evt && evt.data && evt.data.object && evt.data.object.payment;

  if (type.startsWith('payment') && payment && (payment.status === 'COMPLETED' || payment.status === 'APPROVED')) {
    ctx.waitUntil(notifyDiscord(cfg, payment));
  }
  return new Response('ok');
}

async function verifySig(key, message, expected) {
  try {
    const enc = new TextEncoder();
    const ck = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', ck, enc.encode(message));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
    if (b64.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < b64.length; i++) diff |= b64.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  } catch (e) {
    return false;
  }
}

async function notifyDiscord(cfg, payment) {
  if (!cfg.discordWebhook) return;
  const sq = cfg.square || {};
  const amt = payment.amount_money ? (payment.amount_money.amount / 100).toFixed(2) + ' ' + (payment.amount_money.currency || 'USD') : '?';
  let product = '';
  if (payment.order_id && sq.accessToken) product = await fetchOrderName(sq, payment.order_id);

  const fields = [
    { name: 'Amount', value: `**$${amt}**`, inline: true },
    { name: 'Status', value: payment.status || '?', inline: true },
    { name: 'Env', value: (sq.env || 'sandbox').toUpperCase(), inline: true },
  ];
  if (product) fields.push({ name: 'Product', value: product, inline: false });
  if (payment.id) fields.push({ name: 'Payment ID', value: '`' + payment.id + '`', inline: false });

  await fetch(cfg.discordWebhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'MONKEYGOD',
      embeds: [{ title: '💸 Payment received', color: 0xa855f7, fields, timestamp: new Date().toISOString() }],
    }),
  });
}

async function fetchOrderName(sq, orderId) {
  try {
    const apiBase = sq.env === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
    const r = await fetch(`${apiBase}/v2/orders/${orderId}`, {
      headers: { authorization: `Bearer ${sq.accessToken}`, 'square-version': SQUARE_VERSION },
    });
    const d = await r.json().catch(() => ({}));
    const li = d && d.order && d.order.line_items;
    return li && li[0] ? li[0].name : '';
  } catch (e) {
    return '';
  }
}
