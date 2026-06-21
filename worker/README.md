# MONKEYGOD — Cloudflare Worker (production host)

Live: **https://monkeygod.alphacourse.workers.dev**
Hosted on **your** Cloudflare account (`lumerahq6@gmail.com`, acct `dc54fee2…`). The
client only ever points his domain at this — he never controls the code.

## What's where
- **Worker code**: `worker/src/index.js` (deploy with `wrangler deploy --cwd worker`)
- **Static site**: `../public/` (shared with the local Node dev server)
- **Secrets & content live in R2 bucket `monkeygod` under `data/`** — NOT in code:
  - `data/config.json` — Square tokens, Discord webhook, crypto wallets, links
  - `data/override.html` — the kill-switch (empty by default)
  - `preview1..7.mp4` — slider videos (served publicly via r2.dev)

## 🔴 Kill-switch (reclaim/replace the site instantly)
Put any HTML into `data/override.html` and the **entire site** becomes that HTML
on every page route. Empty file = normal site. `/api/*` keeps working either way.

```bash
# LOCK the site (replace with your HTML)
echo '<h1>Down for maintenance</h1>' > lock.html
wrangler r2 object put monkeygod/data/override.html --file=lock.html --remote --content-type "text/html"

# UNLOCK (restore the real site)
printf '' > empty.html
wrangler r2 object put monkeygod/data/override.html --file=empty.html --remote --content-type "text/html"
```
Takes effect within a second (Worker reads R2 on every request).

## 💸 Payment notifications (Discord)
Every successful Square payment (sandbox **and** live) posts an embed to the
Discord webhook in `config.json`. Square signs each call; the Worker verifies it
against `webhookSignatureKeys` and rejects anything unsigned.

- Sandbox subscription is already created (`wbhk_06d2…`), key is in `config.json`.
- Test card on the Square checkout: `4111 1111 1111 1111`, any future date/CVV/ZIP.

## 🟢 Going live (real money)
1. Client sends the **Production** Square access token + production location id.
2. Edit `data/config.json` → set `square.env="production"`, the live token & location.
3. Create a production webhook subscription (same as sandbox but on
   `connect.squareup.com`), and **append** its signature key to
   `webhookSignatureKeys` (the array verifies sandbox + live).
4. Re-upload `config.json`. No code change, no redeploy needed.

## 🌐 Domain handoff (he owns it at Porkbun)
1. Add `monkeygod.us` as a zone in **your** Cloudflare (free).
2. Give him the **2 Cloudflare nameservers** → he sets them at Porkbun.
3. Attach the Worker to the domain (Workers → Domains & Routes → Custom Domain).
Checkout redirect URLs adapt automatically (they use the request origin). The
Square webhook can stay on the `workers.dev` URL.

## ⚠️ Leverage reality
- He owns the **domain** → he can always repoint it. You can't stop that.
- You own the **Worker + code + R2 + this Cloudflare account** → the site only
  works while it points here, and the kill-switch is yours.
- **Square payouts go to whoever owns the Square account** (him). Taking the site
  down won't claw back payments — so bill your build fee separately & upfront, and
  don't hand over this Cloudflare account or the repo until you're paid.
