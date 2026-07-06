# Fiad Shop — Backend

Express + Prisma + PostgreSQL, deployed as Vercel serverless.

## Quick start (local)

```bash
cd backend
cp .env.example .env.local
# → fill in DATABASE_URL, JWT_SECRET, provider API keys

npm install
npx prisma migrate dev --name init
node prisma/seed.js         # creates first admin + demo data
npm run dev                  # http://localhost:4000
```

Default seeded admin:

- Email: `admin@fiad.shop` (override with `SEED_ADMIN_EMAIL`)
- Password: `ChangeMe123!` (override with `SEED_ADMIN_PASSWORD`) — **change immediately**

## API surface

| Method | Path                                    | Auth   | Purpose                          |
| ------ | --------------------------------------- | ------ | -------------------------------- |
| POST   | `/api/auth/register`                    | –      | Create account + send OTP        |
| POST   | `/api/auth/verify-otp`                  | –      | Verify email                     |
| POST   | `/api/auth/resend-otp`                  | –      | Resend OTP                       |
| POST   | `/api/auth/login`                       | –      | Login (may require 2FA)          |
| POST   | `/api/auth/forgot-password`             | –      | Send reset link                  |
| POST   | `/api/auth/reset-password`              | –      | Consume reset token              |
| GET    | `/api/auth/me`                          | JWT    | Current user + affiliate         |
| POST   | `/api/auth/2fa/{setup,verify-enable,disable}` | JWT | 2FA lifecycle              |
| GET    | `/api/products`                         | –      | List/search products             |
| GET    | `/api/products/:id`                     | –      | Product detail                   |
| GET    | `/api/settings/homepage`                | –      | Featured products for index.html |
| GET    | `/api/settings/support-status`          | –      | Live chat on/off                 |
| POST   | `/api/orders/create`                    | opt.   | Guest + user checkout            |
| GET    | `/api/orders/mine`                      | JWT    | My orders                        |
| GET    | `/api/orders/:orderNumber/track`        | opt.   | Public tracking (needs email for guest) |
| POST   | `/api/payment/webhook`                  | HMAC   | NOWPayments IPN                  |
| POST   | `/api/affiliate/apply`                  | JWT    | Become an affiliate              |
| GET    | `/api/affiliate/dashboard`              | JWT+AF | Affiliate KPIs                   |
| POST   | `/api/affiliate/promo-code`             | JWT+AF | Set custom promo code (once)     |
| POST   | `/api/affiliate/discount-link`          | JWT+AF | Share commission as discount     |
| POST   | `/api/affiliate/withdraw`               | JWT+AF | Request payout                   |
| POST   | `/api/feedback`                         | opt.   | Submit suggestion / bug          |
| POST   | `/api/ai/chat`                          | opt.   | Chat (KB → Mistral fallback)     |
| GET    | `/api/support/status`                   | –      | Is live support online?          |
| GET    | `/api/support/token`                    | –      | Ably tokenRequest                |
| POST   | `/api/support/session`                  | opt.   | Open a session                   |
| POST   | `/api/support/session/:id/message`      | opt.   | Persist a message                |
| GET    | `/api/admin/*`                          | ADMIN  | Full admin panel                 |

Full endpoint documentation with request/response examples ships in Phase 4.

## Deploy to Vercel

```bash
cd backend
vercel --prod
```

Then in the Vercel dashboard → **Settings → Environment Variables**, paste
every var from `.env.example` (with real values).

The included `vercel.json` routes all traffic to `src/index.js`.
