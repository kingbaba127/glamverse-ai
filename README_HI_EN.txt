# GlamVerse AI — UTR order backend (starter)

## What it does
- Serves the storefront at `/`.
- Accepts customer email, selected product, amount and UTR at `POST /api/orders`.
- Stores orders in `orders.json`.
- Provides an admin page at `/admin`.
- Admin can manually verify payment in the bank/UPI app, then approve and email the configured PDF.

## Important limitations
- A UTR is only a customer-provided reference. It is NOT proof of payment. Always confirm the exact amount, payer and successful credit in your own UPI/bank app before approving.
- The personal UPI QR does not automatically notify this website of payment.
- Only the ₹99 “3D Cartoon Reel Starter” product has a PDF configured (`starter.pdf`). The ₹149 and ₹199 products are intentionally blocked from approval until their correct PDF files are supplied and mapped in `server.js`. Do not send the starter PDF for those products.
- This is a starter deployment project. Before public production use, replace the default secrets, use HTTPS, configure persistent session storage and database storage, back up order records, add privacy/terms/refund pages and test email delivery.
- No PAN, bank details, OTP or payment credentials are collected by this app.

## Run locally
1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Set a long random `SESSION_SECRET`, a strong `ADMIN_PASSWORD`, and SMTP settings. For Gmail use a Google App Password, not your normal Gmail password.
4. Run `npm install`
5. Run `npm start`
6. Open `http://localhost:3000` for the store and `http://localhost:3000/admin` for admin.

## Deploy
Deploy the folder to a Node.js hosting service with persistent storage and HTTPS. Set the `.env` values in the host's environment settings (do not upload `.env` publicly). Do not use static-only hosting; this project needs a Node server.
