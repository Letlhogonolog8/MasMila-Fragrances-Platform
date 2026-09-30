# Mas'Mila platform — proposal coverage

How each section of the *Mas'Mila Fragrances Website Proposal* maps onto this codebase. Anything that is a business, legal or commercial deliverable rather than software is listed under **Outside the codebase**.

## Demo accounts (development only, when Clerk is not configured)

The API seeds the acceptance scenario from §48: a Manager with three Team Leaders, each with five resellers selling 20 × 50ml bottles at R140.

| Sign in as | Role | What to check |
|---|---|---|
| `admin@masmila.co.za` | Administrator | Dashboard, approve the pending application, run qualification, approve & pay incentives, export reports |
| `manager@masmila.co.za` | Manager | Organisation view; 2% incentive = **R1,008** on the three TL teams |
| `teamleader@masmila.co.za` | Team Leader | Team table; 5% × (100 bottles × R140) = **R700** |
| `reseller@masmila.co.za` | Reseller | R140 reseller pricing, stock ordering, referral link/QR |
| `newreseller@masmila.co.za` | Reseller | 10-bottle opening order enforcement |
| `customer@masmila.co.za` | Customer | Orders, tracking, wishlist, reorder |

## Coverage by section

| § | Requirement | Implementation |
|---|---|---|
| 3 | User roles | `users.role` (customer/reseller/admin) + `resellers.rank` (reseller/team_leader/manager/director); guards in `api-server/src/lib/auth.ts` |
| 4 | Homepage sections & CTAs | `pages/home.tsx` — hero, brand intro, featured, families, best sellers, new arrivals, reseller CTA & opportunity, about, testimonials, social, WhatsApp/newsletter opt-in, footer |
| 5 | Catalogue (160+ products, no developer needed) | `products` table with every listed field; Admin → Products & stock create/edit. Cost and reseller price never leave admin/reseller responses (`lib/catalog.ts`) |
| 6 | Search & filters | Category, family, size, best sellers, new arrivals; search across name, SKU, family, notes, keywords (`routes/catalog.ts`) |
| 7 | Checkout | ZAR, SA provinces & 4-digit postal codes, delivery fee / free threshold, EFT with order-number reference, Shopify hosted checkout when configured, confirmation + tracking pages, notifications |
| 8 | Reseller application & approval queue | `pages/apply.tsx`; Admin → Applications: Approve / Reject / Request more info; duplicate-identity warnings |
| 9 | Reseller portal (`/account/reseller`) | `pages/portal.tsx` — rank, sales, bottles, status, next rank, progress %, requirements |
| 10 | Reseller pricing protection | `resellerPrice` only returned to approved resellers in good standing |
| 11 | Reseller ordering | Opening order (10) and re-order minimum enforced server-side; mixed fragrances; both configurable |
| 12 | Sales tracking & attribution | Personal purchases (`channel = reseller`) vs attributed customer sales (link, code, QR, landing page, manual by admin); IDs like `MSM-000123`, codes like `NOMDADE123` |
| 13–17 | Team structure, ranks, 5% / 2% / 1% | `lib/engine.ts` (pure, unit-tested); Director level built but disabled until switched on in settings |
| 18–19 | Inactivity & Team Leader reversion | Active = ≥1 bottle/month; reactivation = 10 bottles; leaders get a coaching month, then revert; all thresholds configurable |
| 20 | Commission ledger | `commission_ledger` — order, seller, product, qty, wholesale value, qualification status, beneficiary (upline), rank, rate, incentive, approval/payment status, date, reversal link |
| 21 | Commission safety | Incentives only from order lines; no code path pays on joining/registration/recruitment |
| 22 | Refunds & cancellations | Admin refund/cancel/return/chargeback (full or per item) + Shopify webhooks; unpaid accruals reversed, paid ones clawed back, all audited |
| 23–24 | Team Leader & Manager dashboards | Portal overview, Team and Organisation tabs |
| 25 | Admin dashboard | Admin → Dashboard: daily/weekly/monthly/annual sales, retail vs reseller, units/revenue/cost/GP/stock, best & slow sellers, reseller counts, top sellers/teams, organisation & incentive totals |
| 26 | Configurable compensation | Admin → Settings & content (stored in `compensation_settings`, audited) |
| 27 | Marketing portal | Admin → Marketing (links to Drive/Dropbox/Shopify Files); visibility by rank |
| 28 | Referral tools | Referral URL `/r/CODE`, QR code (downloadable), code, WhatsApp/Facebook/Instagram share, copy link |
| 29 | Customer account & corporate enquiry | `pages/account.tsx` (orders, tracking, saved address, profile, wishlist, reorder, referral) and `/corporate` form → Admin → Enquiries |
| 30 | Inventory & low stock | Stock / reserved / sold per product; stock reserved at checkout; LOW STOCK ALERT notifications and dashboard |
| 32 | Reports + CSV/Excel | Admin → Reports: daily, weekly, monthly (incl. net contribution before overhead), products, resellers, teams, commissions, orders; CSV with UTF-8 BOM for Excel; contribution vs target widget |
| 34 | Security | Clerk auth, role-based guards, admin-only settings, audit log, duplicate-claim unique index, self-referral block, same-origin CORS, rate limiting on public writes, HMAC-verified webhooks, formula-safe CSV |
| 35 | Fraud & abuse | Flags for self-referral, duplicate orders, duplicate accounts/applications, suspicious referrals, refund-related commissions, unusual order velocity; accounts can be set to Review / Hold / Suspended |
| 36 | Notifications | In-app for every listed event, email via Resend when configured (`lib/notify.ts`) |
| 37 | WhatsApp | "Order via website", "Chat on WhatsApp", "Share product", "Share reseller link" buttons |
| 38 | Mobile-first | Responsive layouts; portal and admin tables scroll horizontally on phones |
| 39 | Required pages | All 23 routes in `App.tsx` (plus cart, checkout, order tracking) |
| 40–41 | SEO & analytics | Per-page titles/descriptions/canonicals, Product/FAQ/ItemList/Organization JSON-LD, alt text, `/api/sitemap.xml`, robots.txt; GA4, Meta Pixel, TikTok Pixel behind a cookie banner with product view / add to cart / checkout / purchase / lead / referral events |
| 44 | Proper data model | See `lib/db/src/schema/masmila.ts` |
| 48 | Acceptance tests | Demo data above + `pnpm --filter @workspace/api-server test` |

## Integration recommendations (§7, §46)

- **Payments:** Shopify Payments is not available in South Africa. Use **PayFast** or **Yoco** (cards, Instant EFT, SnapScan/Zapper), or **Peach Payments**, as the Shopify payment provider. Manual EFT is built in for reseller stock orders.
- **Courier:** **The Courier Guy** or **Bob Go** (multi-courier rates in Shopify), with **Pargo** for pick-up points. The admin records courier and tracking numbers.
- **Native Shopify:** storefront checkout, payments, delivery rates, order confirmation emails, Shopify Analytics.
- **Custom (this codebase):** reseller portal, pricing protection, team hierarchy, qualification, commission ledger, payouts, fraud controls, admin console, reports.
- **Monthly fees / usage costs:** Shopify plan; payment gateway transaction fees (typically ~2.9–3.5% + fee per transaction); courier aggregator fees; Clerk (free tier up to its MAU limit); Resend (free tier, then paid); WhatsApp Business API is charged per conversation by Meta and a BSP.
- **Limitations:** reseller wholesale prices can't be charged through standard Shopify checkout without a Plus/B2B price list or draft orders. That's why reseller orders use the built-in EFT flow.

## Configuration before launch

1. Set the environment variables in `replit.md` (Clerk keys, `ADMIN_EMAILS`, `SITE_URL`, Resend, Shopify, analytics IDs). Set `SEED_DEMO_DATA=false` or leave it unset in production.
2. Replace demo content in Admin → Settings & content: WhatsApp number, banking details, social links.
3. Load the real catalogue in Admin → Products (or map each product to its `shopifyVariantId` for Shopify checkout).
4. Register the Shopify webhooks `orders/paid`, `orders/cancelled` and `refunds/create` to `/api/webhooks/shopify`.
5. Verify the domain in Google Search Console (DNS, or `VITE_GOOGLE_SITE_VERIFICATION`) and submit `https://<domain>/api/sitemap.xml`.
6. Enable Postgres backups (Replit/Neon point-in-time restore) for the "regular backups" requirement.

## Outside the codebase

- **Quotations, timelines, payment schedules, warranties, ownership/IP terms (§43, §45, §47, §51):** commercial documents, not software.
- **Legal review (§21):** the policy pages are marked as drafts. The compensation plan and terms need South African legal review (CPA, ECTA, POPIA and consumer/direct-selling requirements) before launch.
- **Phase 3:** WhatsApp Business API automation, advanced forecasting and a PWA are not built. Notifications are the extension point for WhatsApp; the Director level is built but disabled.
