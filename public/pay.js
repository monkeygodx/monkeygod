'use strict';

/* MONKEYGOD — embedded Square card checkout (Web Payments SDK).
   Flow: load config -> load SDK -> attach card field -> tokenize on Pay ->
   POST /api/charge -> redirect to /success. The server owns the price. */

const $ = (s) => document.querySelector(s);
const moneyShort = (cents) => {
  const d = cents / 100;
  return '$' + (Number.isInteger(d) ? d : d.toFixed(2));
};
const TIER_ORDER = ['basic', 'premium', 'exclusive'];
const TIER_LABEL = { basic: 'Basic', premium: 'Premium', exclusive: 'Exclusive' };

let CONFIG = null;
let card = null;
let selectedTier = 'premium';

function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms || 3200);
}

function showError(msg) {
  const e = $('#pay-error');
  if (!msg) { e.hidden = true; e.textContent = ''; return; }
  e.hidden = false;
  e.textContent = msg;
}

function tierFromUrl() {
  const t = new URLSearchParams(location.search).get('tier');
  return t && TIER_ORDER.includes(t) ? t : null;
}

function renderPills() {
  const wrap = $('#tier-pills');
  wrap.innerHTML = '';
  for (const key of TIER_ORDER) {
    const p = CONFIG.products[key];
    if (!p) continue;
    const b = document.createElement('button');
    b.className = 'tier-pill' + (key === selectedTier ? ' active' : '');
    b.dataset.tier = key;
    b.innerHTML = `<span class="tp-name">${TIER_LABEL[key] || key}</span><span class="tp-price">${moneyShort(p.amount)}</span>`;
    b.addEventListener('click', () => selectTier(key));
    wrap.appendChild(b);
  }
}

function selectTier(key) {
  if (!CONFIG.products[key]) return;
  selectedTier = key;
  document.querySelectorAll('.tier-pill').forEach((b) =>
    b.classList.toggle('active', b.dataset.tier === key)
  );
  $('#order-amount').textContent = moneyShort(CONFIG.products[key].amount);
  $('#pay-btn-text').textContent = `Pay ${moneyShort(CONFIG.products[key].amount)}`;
}

function loadSquareSdk(env) {
  return new Promise((resolve, reject) => {
    const src =
      env === 'production'
        ? 'https://web.squarecdn.com/v1/square.js'
        : 'https://sandbox.web.squarecdn.com/v1/square.js';
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the Square payment SDK.'));
    document.head.appendChild(s);
  });
}

async function initCard() {
  if (!CONFIG.squareEmbedReady || !CONFIG.squareAppId || !CONFIG.squareLocationId) {
    $('#card-status').textContent =
      'Card payments aren’t live yet — use crypto below or DM the admin.';
    $('#pay-btn').disabled = true;
    return;
  }

  try {
    await loadSquareSdk(CONFIG.squareEnv);
    if (!window.Square) throw new Error('Square SDK unavailable.');

    const payments = window.Square.payments(CONFIG.squareAppId, CONFIG.squareLocationId);
    card = await payments.card({
      style: {
        input: { color: '#ffffff', fontSize: '16px' },
        '.input-container': { borderColor: 'rgba(255,255,255,0.14)', borderRadius: '12px' },
        '.input-container.is-focus': { borderColor: '#a855f7' },
        '.input-container.is-error': { borderColor: '#ef4444' },
        '.message-text.is-error': { color: '#fca5a5' },
        '@placeholder': { color: '#6b7280' },
      },
    });
    await card.attach('#card-container');

    $('#card-status').hidden = true;
    $('#pay-btn').disabled = false;
  } catch (err) {
    console.error('[square] init failed', err);
    $('#card-status').textContent =
      'Card field failed to load. Refresh the page, or pay with crypto / DM the admin.';
    $('#pay-btn').disabled = true;
  }
}

async function pay() {
  if (!card) return;
  const btn = $('#pay-btn');
  showError('');
  btn.disabled = true;
  const label = $('#pay-btn-text').textContent;
  $('#pay-btn-text').textContent = 'Processing…';

  try {
    const result = await card.tokenize();
    if (result.status !== 'OK') {
      const msg =
        result.errors && result.errors[0]
          ? result.errors[0].message
          : 'Please check your card details.';
      showError(msg);
      return;
    }

    const res = await fetch('/api/charge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: selectedTier, sourceId: result.token }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.ok) {
      window.location.href = data.redirect || '/success?tier=' + encodeURIComponent(selectedTier);
      return;
    }
    showError(data.message || 'Payment could not be completed. Try another card or pay with crypto.');
  } catch (e) {
    console.error('[pay] error', e);
    showError('Network error — please try again.');
  } finally {
    btn.disabled = false;
    $('#pay-btn-text').textContent = label;
  }
}

async function boot() {
  try {
    CONFIG = await (await fetch('/api/config')).json();
  } catch (e) {
    showError('Could not load checkout. Refresh the page.');
    return;
  }

  selectedTier = tierFromUrl() || (CONFIG.products.premium ? 'premium' : TIER_ORDER.find((k) => CONFIG.products[k])) || 'basic';

  // Back -> main site; crypto -> main site (where the crypto options live).
  $('#pay-back').href = CONFIG.mainSiteUrl || '/';
  $('#pay-crypto').href = CONFIG.mainSiteUrl || '/';

  renderPills();
  selectTier(selectedTier);
  $('#pay-btn').addEventListener('click', pay);

  await initCard();
}

boot();
