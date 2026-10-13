# USDT Merchant Desk

A mobile web app and API for trading USDT for rupees with escrow. Node.js, Express, MongoDB, Socket.io. The app is in `public/` and is served by the same server, so there is one thing to run.

## What it does

A buyer wants USDT and pays rupees. A merchant holds USDT and receives the rupees. The app sits in the middle and holds the USDT in escrow until the merchant confirms the money arrived.

1. **Everyone is verified first.** Merchants and buyers submit their legal name and the last 4 characters of their PAN. Support approves it.
2. **A merchant has one payment account.** The UPI account's holder name must match the verified name. One UPI ID can belong to one merchant only. Changing it takes the merchant offline until support approves the new one.
3. **A merchant goes online** and buyers see them in the merchant list.
4. **A buyer places an order** for some USDT. The USDT moves from the merchant's available balance into escrow, and the buyer gets 15 minutes to pay the merchant's verified account from an account in their own name.
5. **The buyer marks the order as paid** and enters the bank reference.
6. **The merchant checks their own bank statement.** If the money is there, they release the USDT to the buyer. If the buyer never pays, the order cancels itself and the USDT returns to the merchant.
7. **If something is wrong**, either side opens a dispute with proof. The USDT stays in escrow and support decides: release to the buyer or return to the merchant.
8. **Both sides chat** inside the order, live.

```
awaiting_payment --buyer marks paid--> paid --merchant releases--> completed
      |                                  |
      | cancel / 15 min timeout          | dispute
      v                                  v
  cancelled <----- support decides ---- disputed ----- support decides ---> completed
```

## The app

One page, three kinds of account.

| Account | Screens |
| --- | --- |
| **Merchant** | Home (balance, online switch, orders that need action, today's numbers), Orders, Chats, Disputes, Account (identity check, the one payment account, limits) |
| **Buyer** | Buy (amount, find merchants, place order), Orders (pay screen with copy buttons and the countdown), Chats, Disputes, Account (identity check) |
| **Support** | Identity checks, Payment accounts, Disputes (with the chat transcript and a decision form), Users (fund balances) |

It follows the phone's light or dark setting, and it can be installed on a phone's home screen (see below).

## Run it

```bash
cp .env.example .env            # set JWT_SECRET (the file shows the command to make one)
docker compose up -d            # MongoDB 7 as a one-node replica set (transactions need this)
npm install
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long password' npm run seed:admin
npm run seed:demo               # optional: a verified merchant (300 USDT) and buyer, passwords are printed
npm start                       # open http://localhost:4000
```

No Docker? Use a MongoDB Atlas cluster (replica sets are on by default) and put its URI in `MONGO_URI`.

### First walkthrough

Use two browser windows (or one normal and one private) so you can be two people.

1. Create a **merchant** account in one and a **buyer** account in the other. Under Account, each submits the identity form.
2. Sign in as the admin. Under **Identity checks**, approve both.
3. As the merchant, add a UPI ID under Account. As the admin, open **Payment accounts**, type the holder name the bank lookup returns (it must match the verified name), and approve.
4. As the admin, open **Users** and add USDT to the merchant.
5. The merchant turns the switch on under Home.
6. The buyer enters an amount on Buy, picks the merchant, pays the account shown, enters the bank reference and taps **I have paid**.
7. The merchant checks their statement, ticks the box and releases the USDT. Both sides can chat or open a dispute along the way.

`npm run seed:demo` skips steps 1 to 5 by creating a verified merchant and buyer.

### Put it on a phone

- **Same Wi-Fi, to try it:** run the server on your computer and open `http://<your computer's address>:4000` on the phone.
- **To install it:** phones only allow installable web apps over HTTPS. Deploy the server behind HTTPS (any host with a TLS certificate, or a tunnel while testing), open the address in Safari (iPhone) or Chrome (Android), then choose **Add to Home Screen** (iPhone, from the Share menu) or **Install app** (Android, from the browser menu). It opens full screen with its own icon.

### Checks

```bash
npm test                                                           # money maths, every app screen against a fake API, server wiring
ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run smoke                   # a full order, dispute and chat flow against your running API and MongoDB
```

## Project layout

```
public/            the mobile app: index.html, styles.css, app.js, manifest, service worker, icons
src/models/        User, Order, Dispute, Message, LedgerEntry
src/services/      orders (escrow), disputes, chat
src/routes/        auth, me, orders, disputes, admin
src/realtime.js    Socket.io chat and live order updates
scripts/           seed-admin, seed-demo, smoke
test/              unit, client and wiring tests
```

## API

All routes are under `/api`. Send `Authorization: Bearer <token>`. Money values are in USDT or rupees as decimals.

| Method and path | Who | What it does |
| --- | --- | --- |
| `GET /config` | anyone | rate, limits, payment window |
| `POST /auth/register` | anyone | `name, email, password (10+), role: merchant or buyer` |
| `POST /auth/login` | anyone | returns `token` and `user` |
| `GET /me` | signed in | profile, KYC state, balances |
| `POST /me/kyc` | merchant, buyer | `legalName, panLast4`, goes to review |
| `PUT /me/payment-account` | merchant | `upi`, goes to review, merchant goes offline |
| `POST /me/online` | merchant | `online: true or false` |
| `GET /me/stats` | merchant | today's totals, completion rate, open disputes |
| `GET /orders/merchants?usdt=` | buyer | online merchants who can fill the amount |
| `POST /orders` | buyer | `merchantId, usdt`, locks the USDT in escrow |
| `GET /orders?status=` | signed in | your orders |
| `GET /orders/:id` | participant | one order with its history |
| `POST /orders/:id/paid` | buyer | `utr` (bank reference) |
| `POST /orders/:id/cancel` | buyer, merchant | only before payment |
| `POST /orders/:id/release` | merchant | `statementChecked: true` |
| `GET, POST /orders/:id/messages` | participant | chat history and REST send |
| `POST /disputes/uploads` | signed in | multipart `files` (JPG, PNG, WebP, PDF, 5 MB) |
| `POST /disputes` | participant | `orderId, reason, details, files` |
| `GET /disputes`, `GET /disputes/:id` | participant, admin | |
| `GET /disputes/:id/files/:name` | participant, admin | proof file |
| `GET /admin/users` | admin | people and balances |
| `GET /admin/kyc`, `POST /admin/kyc/:userId` | admin | approve or reject with a reason |
| `GET /admin/payment-accounts`, `POST /admin/payment-accounts/:userId` | admin | approve with the bank-lookup holder name, which must match the KYC name |
| `GET /admin/disputes`, `POST /admin/disputes/:id/resolve` | admin | `release_to_buyer` or `return_to_merchant`, with a note |
| `POST /admin/users/:id/credit` | admin | development funding, see below |
| `GET /admin/users/:id/ledger` | admin | every balance movement |

### Live chat (Socket.io)

The app connects with `io({ auth: { token } })`.

- Emit `order:join` with an order id, then `chat:send` with `{ orderId, text }`.
- Listen for `chat:message`, `order:updated` (refetch the order and messages), `order:new` and `order:paid`.

## How money is kept safe

- Balances and amounts are integers (USDT hundredths, rupee paise). No floating point.
- Every balance change happens inside a MongoDB transaction together with its order update, its chat line and its ledger entry. Either all of it happens or none of it does.
- State changes use conditional updates (`status: 'paid'` and so on), so a double tap or a retry cannot release or cancel twice.
- The ledger is append-only and records each balance after the change.
- An order stores a snapshot of the pay-to account and the buyer's verified name, so a later account change does not alter an open order.
- Passwords use bcrypt, requests are validated with zod, auth routes are rate limited, uploads are limited by type and size, and a user can only attach files they uploaded.
- The app escapes every piece of user text before showing it, and the service worker never caches API responses.

## What is not included

- **Deposits and withdrawals of USDT.** They need an on-chain custody provider. Until you connect one, an admin funds balances from the Users screen (`POST /admin/users/:id/credit`).
- **Automated identity and bank-name checks.** KYC and payment-account review are manual admin steps. Replace them with a KYC provider and a bank account name-lookup service in `routes/admin.js`.
- **Moving rupees.** The app never touches the rupees. The buyer pays the merchant's own bank account directly, and the merchant confirms.
- **Fees, per-merchant pricing, push notifications and a password reset flow.**
- The sign-in token is kept in the browser's local storage. Before real use, consider short-lived tokens with refresh in an httpOnly cookie.

Running this with real customers and real money needs legal review for your country (for India, crypto and payments rules apply) and a security review before launch.
