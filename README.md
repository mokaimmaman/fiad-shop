<div align="center">

# 🛒 Fiad Shop

**A complete production-grade e-commerce & affiliate platform.**

Vercel serverless backend · Supabase Postgres · GitHub Pages frontend · Ably realtime chat · Mistral AI · NOWPayments crypto & Hawala Visa

![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![prisma](https://img.shields.io/badge/prisma-5.22-blue)
![license](https://img.shields.io/badge/license-MIT-orange)

</div>

---

## 📖 Table of contents

- [What's inside](#-whats-inside)
- [Architecture](#-architecture)
- [Repo layout](#-repo-layout)
- [Local development in 5 minutes](#-local-development-in-5-minutes)
- [Environment variables reference](#-environment-variables-reference)
- [Deploying — backend to Vercel](#-deploying--backend-to-vercel)
- [Deploying — frontend to GitHub Pages](#-deploying--frontend-to-github-pages)
- [First admin login](#-first-admin-login)
- [Testing with Postman](#-testing-with-postman)
- [End-to-end checklist](#-end-to-end-checklist)
- [Rotating API keys](#-rotating-api-keys)
- [Common troubleshooting](#-common-troubleshooting)
- [License](#-license)

---

## ✨ What's inside

| Layer | Tech | Files |
|---|---|---|
| Backend | Express 4 + Prisma 5 on Vercel Serverless Functions | `backend/src/` |
| Database | PostgreSQL (Supabase-ready) — 20 models | `backend/prisma/schema.prisma` |
| Auth | JWT + bcrypt + speakeasy (TOTP 2FA) + email OTP verification | `backend/src/routes/auth.js` |
| Payments | NOWPayments (crypto + Hawala Visa) with HMAC-SHA512 IPN verification | `backend/src/lib/nowpayments.js` |
| Email | Multi-provider failover chain (DB providers → env Brevo → env Sendpulse → SMTP) | `backend/src/lib/email.js` |
| Realtime chat | Ably with **per-session scoped tokens** — customer↔admin bi-directional with typing & presence | `backend/src/lib/ably.js` + `frontend/js/support-chat.js` |
| AI assistant | Mistral chat with a curated admin-managed knowledge base (KB match wins over API) | `backend/src/routes/ai.js` |
| Fulfilment | CJ Dropshipping — "Copy CJ Forward Data" button in admin + tracking sync | `backend/src/lib/cj.js` |
| Frontend | Static HTML + Tailwind CDN + Font Awesome + Inter — 19 pages | `frontend/*.html` |
| Realtime SDK | Ably JS SDK (lazy-loaded on first chat open only) | `frontend/js/support-chat.js` |
| CI/CD | GitHub Actions for Pages · Vercel Git integration for backend | `.github/workflows/` · `backend/vercel.json` |

### 19 frontend pages

**Customer** — `index`, `products`, `product-detail`, `cart`, `checkout`, `order-confirmation`, `order-tracking`, `login`, `wishlist`, `about`, `contact`, `faq`, `privacy`, `terms`

**Featured** — `ai` (chat with Fiad AI), `earn-with-us` (feedback/rewards form), `affiliate-dashboard` (stats, promo code, discount links, withdrawals)

**Admin** — `admin-login` (secret path), `admin-panel` (11-section back-office SPA)

### 4 shared JS modules (loaded on every page)

| File | What it does |
|---|---|
| `js/config.js` | Runtime config (`API_BASE`) — injected by CI on deploy |
| `js/api.js` | fetch wrapper, JWT handling, toast, `cart`/`wishlist` stores |
| `js/auth.js` | Register/login/OTP/2FA/reset/session-refresh helpers |
| `js/ui.js` | Logo swap (new SVG), 3-dot menu, floating "Ask Fiad AI" pill, live-support button, dark mode |
| `js/support-chat.js` | Real-time chat over Ably — lazy-loaded SDK, session-scoped, typing indicators, presence, graceful fallback |

---

## 🏗 Architecture

```
                    ┌───────────────────────────┐
   Users' browsers  │   GitHub Pages (static)   │  ← `frontend/` published here
                    │   fiad-shop.github.io     │
                    └────────────┬──────────────┘
                                 │
                                 │  fetch (CORS-allowed)
                                 ▼
                    ┌───────────────────────────┐
                    │   Vercel Serverless       │  ← `backend/` deployed here
                    │   Express 4 + Prisma 5    │
                    └─────┬──────────┬──────────┘
                          │          │
              ┌───────────┴──┐   ┌───┴─────────┐
              │  Supabase    │   │  External   │
              │  Postgres    │   │  services   │
              └──────────────┘   └─────────────┘
                                    ├─ Ably (realtime chat)
                                    ├─ Mistral (AI answers)
                                    ├─ Brevo / Sendpulse (email)
                                    ├─ NOWPayments (checkout)
                                    └─ CJ Dropshipping (fulfilment)
```

---

## 📁 Repo layout

```
fiad-shop/
├── backend/                    ← Deploys to Vercel
│   ├── prisma/
│   │   ├── schema.prisma       ← 20 models, all relationships wired
│   │   └── seed.js             ← Creates first admin + demo products + KB
│   ├── src/
│   │   ├── index.js            ← Express app entry (helmet, CORS, rate limit)
│   │   ├── routes/             ← auth · products · orders · payment · affiliate
│   │   │                          feedback · ai · support · admin · settings
│   │   ├── controllers/        ← Business logic (auth, orders)
│   │   ├── middleware/         ← auth, roleCheck, rate limits
│   │   ├── lib/                ← prisma · jwt · email · nowpayments · ably · mistral · cj
│   │   └── utils/              ← username & coupon generators
│   ├── .env.example            ← Copy → .env.local
│   ├── vercel.json             ← Serverless routing config
│   ├── package.json
│   └── README.md               ← Backend-specific docs
│
├── frontend/                   ← Publishes to GitHub Pages
│   ├── index.html · products.html · … (19 HTML pages)
│   └── js/
│       ├── config.js           ← ← CI overwrites this with your Vercel URL
│       ├── api.js
│       ├── auth.js
│       ├── ui.js
│       └── support-chat.js
│
├── .github/workflows/
│   └── deploy-frontend.yml     ← Auto-publishes frontend/ to gh-pages
├── postman_collection.json     ← 75 requests, ready to import
├── LICENSE                     ← MIT
├── .gitignore
└── README.md                   ← You are here
```

---

## ⚡ Local development in 5 minutes

**Prerequisites:** Node 18+, a Supabase project (or any Postgres 14+), API keys for the services you want to test (all optional — the app degrades gracefully without them).

### 1. Clone & install

```bash
git clone https://github.com/YOUR-USERNAME/fiad-shop.git
cd fiad-shop/backend
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
# then edit .env.local — see the reference table below
```

**Minimum viable set for local dev** (everything else is optional):

```env
DATABASE_URL=postgresql://postgres:PASSWORD@db.YOUR-PROJECT.supabase.co:5432/postgres
JWT_SECRET=any-long-random-string-here-32-chars-plus
CORS_ORIGINS=http://localhost:5500,http://127.0.0.1:5500
```

### 3. Migrate & seed the database

```bash
npx prisma migrate dev --name init      # creates all tables
node prisma/seed.js                      # creates admin@fiad.shop / ChangeMe123!
```

### 4. Start the backend

```bash
npm run dev
# → http://localhost:4000
# → GET /api/health should return { ok: true }
```

### 5. Serve the frontend

```bash
cd ../frontend
python3 -m http.server 5500
# → http://localhost:5500/index.html
```

Or use any static server (`npx serve`, VS Code Live Server, etc.). The frontend auto-detects `localhost` and points at `http://localhost:4000/api`.

**Login as admin:** open `http://localhost:5500/admin-login.html` → `admin@fiad.shop` / `ChangeMe123!`

---

## 🔑 Environment variables reference

Every variable is loaded from `.env.local` in dev and Vercel's Environment Variables panel in production. **Never commit real values.**

| Variable | Required? | Purpose |
|---|:-:|---|
| `DATABASE_URL` | ✅ | Postgres connection string (Supabase pooled URL recommended for serverless) |
| `DIRECT_URL` | ⭕ | Direct (non-pooled) DB URL — used by `prisma migrate` only |
| `JWT_SECRET` | ✅ | HMAC secret for signing JWTs. Use a 32+ char random string. |
| `JWT_EXPIRES_IN` |   | Default `7d` |
| `BCRYPT_ROUNDS` |   | Default `10` |
| `BREVO_API_KEY` | ⭕ | Primary email provider (env-level fallback) |
| `SENDPULSE_API_KEY` + `SENDPULSE_SECRET` | ⭕ | Secondary email provider (env-level fallback) |
| `ABLY_API_KEY` | ⭕ | Realtime chat — without it, chat falls back to persist-only mode |
| `ABLY_CHANNEL_NAME` |   | Default `fiad-live-support` |
| `MISTRAL_API_KEY` | ⭕ | AI chat — without it, only KB matches will answer |
| `MISTRAL_MODEL` |   | Default `mistral-small-latest` |
| `NOWPAYMENTS_API_KEY` | ⭕ | Payment invoices — without it, orders are created but no payment URL |
| `NOWPAYMENTS_IPN_SECRET` | ⭕ | Webhook signature verification (**strongly recommended**) |
| `CJ_API_KEY` | ⭕ | Fulfilment integration — used only for tracking lookups; order forwarding is manual |
| `CJ_API_BASE` |   | Default `https://developers.cjdropshipping.com/api2.0/v1` |
| `ADMIN_SECRET_PATH` |   | Vanity path for the admin login page. Default `/super-secret-admin-login` |
| `SUPPORT_EMAIL` |   | Default `support@fiad.shop` |
| `FROM_EMAIL` + `FROM_NAME` |   | Default sender identity |
| `FRONTEND_URL` | ✅ (prod) | Public URL of your Pages site — used in email links |
| `BACKEND_URL`  | ✅ (prod) | Public URL of your Vercel app — used for webhook callback |
| `CORS_ORIGINS` | ✅ (prod) | Comma-separated whitelist. Include your Pages URL. |

Legend: ✅ required · ⭕ optional (feature-gated)

---

## 🚀 Deploying — backend to Vercel

### 1. Prepare Supabase

1. Create a new Supabase project — free tier is fine
2. Settings → Database → copy the **Connection Pooling** URL (transaction mode, port `6543`)
3. Also copy the **Direct connection** URL (port `5432`) — used only for migrations

### 2. Push repo to GitHub

```bash
cd fiad-shop
git init && git add . && git commit -m "Initial Fiad Shop"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/fiad-shop.git
git push -u origin main
```

### 3. Import into Vercel

1. [vercel.com/new](https://vercel.com/new) → Import your repo
2. **Root Directory:** `backend` ← critical
3. Framework preset: **Other**
4. Build & Output settings: leave defaults (Vercel picks up `vercel.json`)
5. Add all env vars from `.env.example` under **Environment Variables**
6. Deploy

### 4. Run migrations against production DB

From your local machine (one-time):

```bash
cd backend
DATABASE_URL="your-DIRECT-supabase-url" npx prisma migrate deploy
DATABASE_URL="your-DIRECT-supabase-url" node prisma/seed.js
```

### 5. Verify

```bash
curl https://YOUR-APP.vercel.app/api/health
# → {"ok":true}
```

### 6. Point the NOWPayments webhook

Copy `https://YOUR-APP.vercel.app/api/payment/webhook` into the **IPN callback URL** setting inside your NOWPayments dashboard. Save your `IPN_SECRET` into `NOWPAYMENTS_IPN_SECRET` env var.

---

## 🌐 Deploying — frontend to GitHub Pages

### 1. Enable Pages

Repo → **Settings → Pages** → Source: **GitHub Actions**

### 2. Add the backend URL as a secret

Repo → **Settings → Secrets and variables → Actions** → **New repository secret**

- Name: `FIAD_API_BASE`
- Value: `https://YOUR-APP.vercel.app/api` (no trailing slash)

### 3. Push to main

Any push touching `frontend/**` triggers `.github/workflows/deploy-frontend.yml`, which:
1. Substitutes your `FIAD_API_BASE` into `frontend/js/config.js`
2. Copies `index.html` → `404.html` (so deep links survive)
3. Adds `.nojekyll`
4. Publishes to Pages

Site appears at `https://YOUR-USERNAME.github.io/REPO-NAME/`

### 4. Update `CORS_ORIGINS` on Vercel

Add your Pages URL to the whitelist:

```env
CORS_ORIGINS=https://YOUR-USERNAME.github.io
```

Redeploy the Vercel app to pick up the change.

---

## 👤 First admin login

The seed script creates one admin user:

- **Email:** `admin@fiad.shop` (override with `SEED_ADMIN_EMAIL` env var)
- **Password:** `ChangeMe123!` (override with `SEED_ADMIN_PASSWORD`)

**Sign in at:** `https://YOUR-SITE/admin-login.html`

**⚠ Change the password immediately** via the admin panel or by editing the User row.

To promote another user to admin via SQL:

```sql
UPDATE "User" SET role = 'ADMIN' WHERE email = 'you@example.com';
```

---

## 🧪 Testing with Postman

1. Import `postman_collection.json` (Postman → Import → Upload)
2. Set the collection variable `baseUrl` to your API URL
3. Run **Auth → Register**, then **Verify OTP** (the collection auto-saves `token`)
4. Or run **Auth → Login (admin)** which auto-saves `adminToken`
5. All admin endpoints use `{{adminToken}}`, customer endpoints use `{{token}}`

The collection includes **75 requests** across 18 folders covering every route.

**Recommended smoke test order:**

1. Health → Root
2. Auth → Register → Verify OTP (grab `devOtp` from response in dev mode)
3. Products (public) → List (auto-saves `productId`)
4. Orders → Create (auto-saves `orderNumber`)
5. Orders → Track (guest)
6. Auth → Login (admin) → saves `adminToken`
7. Admin → Dashboard → Overview
8. Admin → Orders → List → Approve → returns copyable CJ forward data

---

## ✅ End-to-end checklist

Before going live, walk through this list:

- [ ] Supabase project provisioned, `DATABASE_URL` + `DIRECT_URL` in Vercel env
- [ ] `JWT_SECRET` is a fresh 32+ char random string (not the example)
- [ ] `prisma migrate deploy` run against production DB
- [ ] `node prisma/seed.js` run — first admin exists
- [ ] Admin logged in and **password rotated**
- [ ] `CORS_ORIGINS` includes your Pages URL
- [ ] `FRONTEND_URL` + `BACKEND_URL` set (used in transactional emails)
- [ ] Brevo/Sendpulse env vars set → send a test OTP, verify email arrives
- [ ] NOWPayments API key + IPN secret set → webhook URL configured in dashboard
- [ ] NOWPayments dashboard webhook URL: `https://YOUR-APP.vercel.app/api/payment/webhook`
- [ ] Ably key set → open the customer live chat, verify "Online" green dot
- [ ] Mistral key set → open `ai.html`, ask "What is your return policy?"
- [ ] Admin → Support Settings → toggle Live Support ON
- [ ] Admin → Homepage → pick 4–8 featured products
- [ ] Admin → Products → create at least one real product with correct SKU + PID
- [ ] Static pages spot-checked in **both** light and dark mode
- [ ] `admin-login.html` reachable only by people who know the URL — consider proxy-protecting it if desired
- [ ] Repo secrets are all secrets, not committed anywhere in code

---

## 🔄 Rotating API keys

If a key leaks (or you just want to rotate on schedule):

1. **In Vercel** — Settings → Environment Variables → edit the value → redeploy
2. **In the provider dashboard** — issue a new key, then revoke the old one
3. For `JWT_SECRET`: rotating invalidates every existing session — every user must log in again. Do this if you suspect a compromise.
4. For `NOWPAYMENTS_IPN_SECRET`: update in the NOWPayments dashboard first, then in Vercel. Any in-flight IPN callbacks may fail during the swap window.

**Never** commit keys to the repo. `.gitignore` already blocks `.env*`.

---

## 🛟 Common troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Frontend loads but every API call returns network error | `FIAD_API_BASE` secret not set or wrong | Repo → Settings → Secrets → set it, then re-run the workflow |
| `CORS: origin … not allowed` in browser console | Your Pages URL missing from `CORS_ORIGINS` | Add it in Vercel, redeploy |
| `Can't reach database server` in Vercel logs | Using the direct URL instead of the pooler in serverless | Use the port-6543 **transaction pooler** URL for `DATABASE_URL` |
| OTP emails never arrive | No email provider configured, or provider rate-limited | Check Vercel logs for `[email]` — add a DB provider under Admin → Email Providers |
| Payment stays PENDING forever | Webhook URL misconfigured on NOWPayments side | Confirm IPN URL + secret match; check `/api/payment/webhook` logs |
| Live chat shows "Persist-only mode" | Ably key missing, blocked, or invalid | Set `ABLY_API_KEY` and redeploy; check network tab for CDN loads |
| AI answers "unavailable" | Mistral key missing or rate-limited | Set `MISTRAL_API_KEY`; KB-matched questions still work regardless |
| Admin panel shows "Access denied" for you | Your user's role isn't `ADMIN` | `UPDATE "User" SET role='ADMIN' WHERE email='…'` |
| GitHub Pages 404 on deep links (e.g. `/products.html`) | Pages Jekyll or missing fallback | Workflow already copies `index.html → 404.html`; ensure `.nojekyll` present |

---

## 📄 License

MIT — see [LICENSE](./LICENSE).

---

<div align="center">

Built with care for **Fiad Shop** · Backend, frontend, realtime chat, AI, payments, and admin panel all in one repo.

</div>
