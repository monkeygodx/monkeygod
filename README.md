# MONKEYGOD

A monkeyappwins-style dark/gold "link-in-bio" vault landing page for the MONKEYGOD
products, with **Square** (card) and **crypto** checkout. **No PayPal anywhere.**

```
monkeygod/
├─ server.js          # Express server + Square Payment Links integration
├─ .env               # your secrets/config (gitignored) — copy from .env.example
├─ .env.example       # template
└─ public/
   ├─ index.html      # the landing page
   ├─ success.html    # post-payment "DM admin to unlock" page
   ├─ styles.css      # Celestial-Noir + gold glass theme
   ├─ script.js       # tiers, checkout modal, crypto modal
   └─ assets/         # crest favicon + 1200x630 share thumbnail
```

## Run locally

```bash
npm install
npm start
# open http://localhost:4000
```

Edit `.env` and restart to change config. Without Square credentials the card
button shows a friendly "not live yet" message; crypto + DM-admin still work.

---

## ✅ EXACTLY what I need from Square

The card form is **embedded** on the payment site (Square Web Payments SDK). The
card number is entered in a secure Square iframe and tokenized in the browser;
your server only ever sees a one-time token, never the card. You need **3 values**
(all from the same Square app, **Production** tab):

| .env key | What it is | Secret? | Where to get it |
|---|---|---|---|
| `SQUARE_APP_ID` | Application ID — loads the card field in the browser | public | Developer Dashboard → your app → **Credentials** |
| `SQUARE_ACCESS_TOKEN` | API token — charges the card server-side | **secret** | Developer Dashboard → your app → **Credentials** |
| `SQUARE_LOCATION_ID` | Which Square location collects the money | public | Same dashboard → **Locations** |
| `SQUARE_ENV` | `sandbox` (testing) or `production` (real money) | — | you choose |

> The test access key has been **removed**. Paste your live `SQUARE_APP_ID`,
> `SQUARE_ACCESS_TOKEN`, and `SQUARE_LOCATION_ID` (production) and the card form
> goes live. Until then the payment page shows "card payments aren't live yet".

### Step-by-step

1. **Create / log into a Square account** → <https://squareup.com>.
   To take *real* cards you must finish Square's business activation
   (business details + a bank account for payouts). Sandbox testing needs none of that.

2. **Open the Developer Dashboard** → <https://developer.squareup.com/apps> →
   **"+" Create app** → name it `MONKEYGOD`.

3. Each app has two sides: **Sandbox** (fake money, for testing) and
   **Production** (real money). Use the toggle at the top.

4. **Grab the Access Token**
   - In your app → **Credentials**.
   - For testing: copy the **Sandbox Access Token**.
   - For live: switch to **Production** and copy the **Production Access Token**.
   - ⚠️ This token is a password. Send it to me privately (not in chat history if
     you can avoid it). Never commit it / never put it in the frontend.

5. **Grab the Location ID**
   - In your app → **Locations** (sandbox and production each list their own).
   - Or Square Dashboard → **Settings → Account & Settings → Business → Locations**.
   - Copy the **Location ID** for the environment you're using.

6. **Put them in `.env`** and restart:
   ```
   SQUARE_ENV=production          # or sandbox while testing
   SQUARE_ACCESS_TOKEN=EAAAl...   # the matching token for that env
   SQUARE_LOCATION_ID=L9XXXXXXXX
   PUBLIC_BASE_URL=https://monkeygod.us   # real domain in production
   ```

That's it. No SDK, no webhook, no OAuth scopes required — a personal access token
for **your own** Square account already has permission to create Payment Links.

### How the card flow works (embedded)
1. Buyer clicks **Get …** on the main site (`monkeygod.fun`) → lands on the
   payment site (`monkeygod.xyz/?tier=…`).
2. The payment page loads Square's **Web Payments SDK** and shows an embedded
   card field (hosted by Square in an iframe — card data never touches our server).
3. On **Pay**, the SDK tokenizes the card and POSTs the one-time token to
   `/api/charge`. The server charges it via the **Payments API** (`/v2/payments`)
   using the price from the server-side product table (the client can't change it).
4. On success the buyer is sent to `…/success`, which tells them to **DM the admin**
   with their receipt to get added (manual fulfilment).

### Test it (sandbox)
Set `SQUARE_ENV=sandbox` and paste your **sandbox** app id / token / location, then
use Square's test card in the embedded field:
`4111 1111 1111 1111`, any future expiry, any CVV, any ZIP. No real charge.

### Optional later: auto-verify payments
Right now fulfilment is manual (buyer DMs admin). If you ever want the server to
*know* a payment succeeded automatically, add a Square **Webhook** (event
`payment.created` / `order.fulfillment.updated`) + the **Webhook Signature Key**.
Not required for launch — say the word and I'll wire it up.

### No-code fallback (if you don't want to share an API token)
You can instead create a **Payment Link per tier** by hand in the Square Dashboard
(**Online → Checkout Links**) and I'll hard-code those URLs on the buttons.
Downside: the Omegle add-on / combined totals stop being dynamic — each link is a
fixed product/price. The API method above is recommended.

---

## ₿ Crypto config

Put your real receiving addresses in `.env` (any you leave blank are hidden):

```
CRYPTO_BTC=your-btc-address
CRYPTO_ETH=your-eth-address
CRYPTO_USDT_TRC20=your-usdt-tron-address
CRYPTO_LTC=
CRYPTO_SOL=
```

The crypto modal shows the amount + addresses with copy buttons, then a
**DM Admin with proof** button. (The addresses currently in `.env` are
placeholders — replace them.)

---

## Links

Set these in your env / Railway Variables (placeholders shown):

```
TELEGRAM_ADMIN=https://t.me/youradmin
TELEGRAM_CHANNEL=https://t.me/yourchannel
TELEGRAM_CHATROOM=https://t.me/yourchatroom
```

## Deploy on Railway (one app, two domains)

Both `monkeygod.fun` and `monkeygod.xyz` point at the **same** Railway service.
The app routes by hostname: `.xyz` shows the embedded card page, `.fun` shows the
landing.

### 1. Push the project to Railway
- New Project → **Deploy from GitHub repo** (or `railway up` from the CLI).
- Railway auto-detects Node, runs `npm install`, then `npm start`. It injects
  `PORT` automatically — the app already reads `process.env.PORT`.

### 2. Set the environment variables (Railway → service → **Variables**)
```
SQUARE_ENV=production
SQUARE_APP_ID=<your production Application ID>
SQUARE_ACCESS_TOKEN=<your production Access Token>
SQUARE_LOCATION_ID=<your production Location ID>
SQUARE_VERSION=2024-10-17
MAIN_SITE_URL=https://monkeygod.fun
PAYMENT_SITE_URL=https://monkeygod.xyz
PAYMENT_HOST=monkeygod.xyz
PUBLIC_BASE_URL=https://monkeygod.xyz
PREVIEW_BASE_URL=https://pub-8565158f23444cbbb9c07a3b1f102e56.r2.dev
CRYPTO_BTC=...   CRYPTO_ETH=...   CRYPTO_LTC=...   CRYPTO_SOL=...
TELEGRAM_ADMIN=https://t.me/youradmin
TELEGRAM_CHANNEL=https://t.me/yourchannel
TELEGRAM_CHATROOM=https://t.me/yourchatroom
```
Do **not** put secrets in the repo — set them here. The `.env` file is for local only.

### 3. Add both custom domains (Railway → service → **Settings → Networking → Custom Domain**)
Add `monkeygod.fun`, then add `monkeygod.xyz`. For **each** domain Railway shows a
target host that looks like `xxxxxxxx.up.railway.app`. **Copy that exact value** —
it's unique per domain and you can't know it before adding the domain.

---

## 🌐 DNS config (what to set at your registrar)

Both are **root/apex** domains, so the record type matters. Use whichever your DNS
provider supports:

### Option A — Cloudflare (recommended, free, handles apex automatically)
Move each domain's nameservers to Cloudflare, then add (DNS-only, **grey cloud**):

| Domain | Type | Name | Value (from Railway) | Proxy |
|---|---|---|---|---|
| monkeygod.fun | CNAME | `@` | `xxxxxxxx.up.railway.app` | DNS only (grey) |
| monkeygod.fun | CNAME | `www` | `xxxxxxxx.up.railway.app` | DNS only (grey) |
| monkeygod.xyz | CNAME | `@` | `yyyyyyyy.up.railway.app` | DNS only (grey) |
| monkeygod.xyz | CNAME | `www` | `yyyyyyyy.up.railway.app` | DNS only (grey) |

Cloudflare **flattens** the apex `CNAME` automatically, so a `CNAME` on `@` works.
Keep the cloud **grey (DNS only)** — orange-proxy can fight Railway's TLS. Each
domain uses **its own** Railway target (the two are different).

### Option B — Registrar that supports ALIAS / ANAME at the apex
(e.g. Namecheap, Porkbun, DNSimple) — same idea, different record type:

| Domain | Type | Host | Value |
|---|---|---|---|
| monkeygod.fun | ALIAS (or ANAME) | `@` | `xxxxxxxx.up.railway.app` |
| monkeygod.fun | CNAME | `www` | `xxxxxxxx.up.railway.app` |
| monkeygod.xyz | ALIAS (or ANAME) | `@` | `yyyyyyyy.up.railway.app` |
| monkeygod.xyz | CNAME | `www` | `yyyyyyyy.up.railway.app` |

### Option C — provider with NO apex CNAME/ALIAS support
Point the apex at `www` instead: set the **www** `CNAME` to the Railway target,
add `www.monkeygod.fun` / `www.monkeygod.xyz` as the custom domains in Railway,
and use the registrar's "domain forwarding" to redirect `@` → `www`.

> Replace `xxxxxxxx.up.railway.app` / `yyyyyyyy.up.railway.app` with the **exact**
> targets Railway shows after you add each domain. Railway issues the HTTPS
> certificates automatically once DNS resolves (can take a few minutes to ~1 hour).

### Verify
```bash
curl -I https://monkeygod.fun     # -> landing
curl -I https://monkeygod.xyz     # -> embedded card checkout
```

The 1200×630 share image is an SVG at `/assets/og-image.svg`. Some platforms
prefer PNG/JPG for OG — say the word and I'll export a `.png`.
