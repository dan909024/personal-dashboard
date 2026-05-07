# Crypto.com → Dashboard ingest

USDT/USDC withdrawals from Crypto.com are credited as payments to
Harley. The flow:

```
Crypto.com → noreply@crypto.com → Gmail (your personal account)
  → Gmail filter forwards "from:crypto.com subject:withdrawal" to
    your CloudMailin inbound address
      → CloudMailin POSTs JSON to /api/crypto/inbound
        → endpoint parses + appends to "Harley Payments" Sheet tab
          → dashboard's HARLEY BALANCE tile re-renders
```

## Prerequisites

- `CRYPTO_INGEST_SECRET` env var set in Vercel (Production +
  Development; Preview is optional but the CLI bug we hit on the
  other secrets applies here too — set via dashboard UI). Generate
  with `openssl rand -hex 32`.
- The same Gmail forwarder + CloudMailin route that handles Amex —
  or a separate one if you prefer to keep the audit trails distinct.

## 1. Gmail filter (personal account)

Settings → Filters and Blocked Addresses → Create new filter.

- **From**: `noreply@crypto.com` (and add other Crypto.com sender
  variants you've seen if any: `cdcwallet.com`, `crypto.com`).
- **Subject**: `withdrawal`
- Apply → **Forward to**: `<your-cloudmailin-address>@cloudmailin.net`
  (same address Amex uses, or a fresh one).

If you've never set up Gmail forwarding for Crypto.com,
verify the destination once via Gmail's verification email — the
CloudMailin endpoint already special-cases the verification email
(see `/api/amex/inbound` adapter) and prints the verification code
in its response.

## 2. CloudMailin route

If you're piggybacking on the existing Amex CloudMailin address,
update the target URL to a route that distinguishes Amex vs Crypto
emails — easiest is to give Crypto.com its own CloudMailin address.

Either way, the target URL for the Crypto.com address is:

```
https://crypto:<CRYPTO_INGEST_SECRET>@personal-dashboard-six-tan.vercel.app/api/crypto/inbound
```

CloudMailin Free uses HTTP Basic auth via URL credentials —
username is ignored, only the password (after the `:`) is
verified against `CRYPTO_INGEST_SECRET`. The endpoint also accepts
`Authorization: Bearer <secret>` if your inbound provider supports
custom headers (Postmark, Resend Inbound, etc.).

## 3. Test it

Send yourself a USDT or USDC withdrawal of a small amount. When the
confirmation email arrives:

- Gmail filter forwards it to CloudMailin
- CloudMailin POSTs to the endpoint
- Sheet → "Harley Payments" tab gets a new row
- Reload the dashboard → HARLEY BALANCE tile drops by the Total
  amount

If nothing happens, check:

- CloudMailin dashboard → Inbound Mails: did the email arrive?
- Vercel logs for `/api/crypto/inbound`: did the POST land?
- The endpoint returns `{ ok: true, skipped: true, reason: "..." }`
  for emails it deliberately ignores (not a USDT/USDC withdrawal,
  status not Completed, etc.). That's a 200, not an error.

## What gets counted

Only emails matching ALL of these:

- Sender domain contains `crypto.com`
- Subject matches `(USDT|USDC) withdrawal request confirmed` (also
  accepts `is successful`)
- Body has `Status: Completed`
- Body has `Total: <amount> (USDT|USDC)` parseable

Anything else (deposits, security alerts, marketing, BTC/ETH
withdrawals, pending status) returns 200-with-skipped so
CloudMailin doesn't retry.

## What doesn't get counted

- Non-USDT/USDC withdrawals — different volatility, not a stable
  proxy for AUD value. If you start paying Harley in BTC, extend
  the parser.
- The `Fee` line — only `Total` (the amount that actually left
  your wallet) is logged.
- USD-equivalent conversion — we trust 1 USDT = $1 AUD for now.
  If you want precision, hook in a price feed; otherwise the
  balance is approximately right.

## Monthly +$1000 auto-fine

Independent of this flow. `.github/workflows/monthly-fine.yml`
runs on the 1st of each month and appends a `Monthly fee — <Month>
<Year>` row to the Punishments tab. Idempotent on the Reason
string so duplicate fires are no-ops. Trigger manually via the
Actions tab if you need to backfill.
