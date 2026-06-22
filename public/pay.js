'use strict';

/* MONKEYGOD — embedded checkout (Web Payments SDK).
   Tier is pre-chosen on the previous page (?tier=). No tier picker here.
   Flow: load config -> mount Apple Pay / Google Pay + card -> tokenize on pay ->
   POST /api/charge -> reveal the tier's private link inline (no redirect).
   The server owns the price. */

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
let paid = false;

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
  // Path form first: /basic, /premium, /exclusive. Then ?tier= fallback.
  const seg = location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (TIER_ORDER.includes(seg)) return seg;
  const t = new URLSearchParams(location.search).get('tier');
  return t && TIER_ORDER.includes(t) ? t : null;
}

function amountCents() {
  const p = CONFIG.products[selectedTier];
  return p ? p.amount : 0;
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
    s.onerror = () => reject(new Error('payment SDK failed to load'));
    document.head.appendChild(s);
  });
}

function buildPaymentRequest(payments) {
  return payments.paymentRequest({
    countryCode: 'US',
    currencyCode: 'USD',
    total: { amount: (amountCents() / 100).toFixed(2), label: 'Total' },
  });
}

// Charge a tokenized source (card or wallet) and reveal the success panel.
async function charge(sourceId, verificationToken) {
  showError('');
  const res = await fetch('/api/charge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: selectedTier, sourceId, buyerVerificationToken: verificationToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok) {
    showSuccess();
    return true;
  }
  showError(data.message || 'Payment could not be completed. Try another card.');
  return false;
}

function showSuccess() {
  paid = true;
  const link = (CONFIG.tierLinks && CONFIG.tierLinks[selectedTier]) || '';
  const a = $('#join-link');
  if (link) {
    a.href = link;
  } else {
    a.textContent = 'Message the admin to get added';
    a.href = (CONFIG.links && CONFIG.links.admin) || '#';
  }
  $('#checkout-card').hidden = true;
  $('#success-card').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---- Wallets (Apple Pay / Google Pay) ----
async function tokenizeWallet(method, label) {
  let result;
  try {
    result = await method.tokenize();
  } catch (err) {
    console.error('[wallet] tokenize threw', err);
    showError(`${label} couldn't start${err && err.message ? ' — ' + err.message : '. Make sure a card is set up and pop-ups are allowed.'}`);
    return;
  }
  if (result.status === 'OK') {
    await charge(result.token, result.details && result.details.verificationToken);
  } else if (result.status === 'Cancel') {
    /* buyer closed the wallet sheet — not an error */
  } else {
    showError((result.errors && result.errors[0] && result.errors[0].message) || `${label} was not completed.`);
  }
}

async function initWallets(payments) {
  const container = $('#wallet-container');
  let any = false;

  // Google Pay
  try {
    const pr = buildPaymentRequest(payments);
    const googlePay = await payments.googlePay(pr);
    const el = document.createElement('div');
    el.id = 'gpay-btn';
    el.className = 'wallet-btn';
    container.appendChild(el);
    await googlePay.attach('#gpay-btn', { buttonColor: 'white', buttonType: 'long', buttonSizeMode: 'fill' });
    el.addEventListener('click', async (e) => {
      e.preventDefault();
      await tokenizeWallet(googlePay, 'Google Pay');
    });
    any = true;
  } catch (e) {
    console.warn('[wallet] google pay unavailable', e && e.message);
  }

  // Apple Pay (Safari on Apple devices; requires the domain registered in Square)
  try {
    const pr = buildPaymentRequest(payments);
    const applePay = await payments.applePay(pr);
    const btn = document.createElement('button');
    btn.id = 'applepay-btn';
    btn.className = 'apple-pay-button';
    btn.setAttribute('aria-label', 'Pay with Apple Pay');
    container.appendChild(btn);
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      await tokenizeWallet(applePay, 'Apple Pay');
    });
    any = true;
  } catch (e) {
    console.warn('[wallet] apple pay unavailable', e && e.message);
  }

  if (any) $('#wallet-sep').hidden = false;
}

// ---- Card field ----
async function initCard(payments) {
  // Only Square-valid style selectors here. If the styled card ever fails to
  // build, fall back to an unstyled (but fully working) field so checkout
  // can't be blocked by a styling issue.
  const style = {
    input: { color: '#000000', fontSize: '16px' },
    'input::placeholder': { color: '#6b7280' },
    '.input-container': { borderColor: 'rgba(255,255,255,0.14)', borderRadius: '12px' },
    '.input-container.is-focus': { borderColor: '#a855f7' },
    '.input-container.is-error': { borderColor: '#ef4444' },
    '.message-text.is-error': { color: '#fca5a5' },
  };
  try {
    card = await payments.card({ style });
  } catch (e) {
    console.warn('[card] styled init failed, retrying unstyled', e);
    card = await payments.card();
  }
  await card.attach('#card-container');
  $('#card-status').hidden = true;
  $('#pay-btn').disabled = false;
}

async function payWithCard() {
  if (!card || paid) return;
  const btn = $('#pay-btn');
  showError('');
  btn.disabled = true;
  const label = $('#pay-btn-text').textContent;
  $('#pay-btn-text').textContent = 'Processing…';
  try {
    const result = await card.tokenize();
    if (result.status !== 'OK') {
      showError((result.errors && result.errors[0] && result.errors[0].message) || 'Please check your card details.');
      return;
    }
    await charge(result.token);
  } catch (e) {
    console.error('[pay] error', e);
    showError('Network error — please try again.');
  } finally {
    if (!paid) {
      btn.disabled = false;
      $('#pay-btn-text').textContent = label;
    }
  }
}

async function initPayments() {
  if (!CONFIG.squareEmbedReady || !CONFIG.squareAppId || !CONFIG.squareLocationId) {
    $('#card-status').textContent = 'Checkout is being set up — please try again shortly.';
    $('#pay-btn').disabled = true;
    return;
  }
  try {
    await loadSquareSdk(CONFIG.squareEnv);
    if (!window.Square) throw new Error('SDK unavailable');
    const payments = window.Square.payments(CONFIG.squareAppId, CONFIG.squareLocationId);
    await initWallets(payments);
    await initCard(payments);
  } catch (err) {
    console.error('[checkout] init failed', err);
    $('#card-status').textContent = 'Checkout failed to load. Refresh the page or message the admin.';
    $('#pay-btn').disabled = true;
  }
}

async function boot() {
  try {
    CONFIG = await (await fetch('/api/config')).json();
  } catch (e) {
    showError('Could not load checkout. Refresh the page.');
    return;
  }

  selectedTier =
    tierFromUrl() ||
    (CONFIG.products.premium ? 'premium' : TIER_ORDER.find((k) => CONFIG.products[k])) ||
    'basic';

  const p = CONFIG.products[selectedTier];
  $('#order-tier').textContent = TIER_LABEL[selectedTier] || selectedTier;
  $('#order-amount').textContent = p ? moneyShort(p.amount) : '—';
  $('#pay-btn-text').textContent = p ? `Pay ${moneyShort(p.amount)}` : 'Pay';

  $('#pay-btn').addEventListener('click', payWithCard);

  await initPayments();
}

boot();
