const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const PRODUCTS = {
  '3D Cartoon Reel Starter': { amount: 99, file: 'starter.pdf', deliverable: true },
  'AI Fashion & Beauty Pack': { amount: 149, file: null, deliverable: false },
  'Ultimate AI Reel Bundle': { amount: 199, file: null, deliverable: false }
};

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '30kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-before-deploying',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 2 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false
}));

function adminOnly(req, res, next) {
  if (req.session && req.session.admin === true) return next();
  return res.status(401).json({ error: 'Admin login required.' });
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function mailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function formatOrder(row) {
  return {
    id: row.id,
    email: row.email,
    utr: row.utr,
    product: row.product,
    amount: row.amount,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at
  };
}

app.post('/api/orders', async (req, res) => {
  try {
    const { email, utr, product, amount } = req.body || {};
    const item = PRODUCTS[product];

    if (!item || Number(amount) !== item.amount)
      return res.status(400).json({ error: 'Product or price is invalid.' });

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '')))
      return res.status(400).json({ error: 'Valid email is required.' });

    if (!/^[A-Za-z0-9-]{8,30}$/.test(String(utr || '')))
      return res.status(400).json({ error: 'Valid UTR / transaction reference is required.' });

    const id = 'GV-' + Date.now().toString(36).toUpperCase() +
      '-' + crypto.randomBytes(2).toString('hex').toUpperCase();

    const result = await pool.query(
      `INSERT INTO orders (id, email, utr, product, amount)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, status`,
      [id, String(email).trim().toLowerCase(), String(utr).trim(), product, item.amount]
    );

    res.status(201).json({
      orderId: result.rows[0].id,
      status: result.rows[0].status
    });
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ error: 'This UTR has already been submitted.' });
    console.error('Order save failed:', e.message);
    res.status(500).json({ error: 'Order could not be saved.' });
  }
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD || !safeEqual(password, process.env.ADMIN_PASSWORD))
    return res.status(401).json({ error: 'Wrong admin password.' });
  req.session.admin = true;
  res.json({ ok: true });
});

app.post('/admin/logout', (req, res) =>
  req.session.destroy(() => res.json({ ok: true }))
);

app.get('/api/admin/orders', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM orders ORDER BY created_at DESC'
    );
    res.json(result.rows.map(formatOrder));
  } catch (e) {
    console.error('Orders fetch failed:', e.message);
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

app.post('/api/admin/orders/:id/approve', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM orders WHERE id = $1',
      [req.params.id]
    );
    const order = result.rows[0];

    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status === 'approved')
      return res.status(409).json({ error: 'Order already approved.' });

    const item = PRODUCTS[order.product];
    if (!item || !item.deliverable || !item.file)
      return res.status(400).json({ error: 'इस प्रोडक्ट की PDF अभी सेट नहीं है।' });

    const pdfPath = path.join(__dirname, item.file);
    const fs = require('fs');
    if (!fs.existsSync(pdfPath))
      return res.status(400).json({ error: 'PDF file नहीं मिली।' });

    const transport = mailer();
    if (!transport)
      return res.status(503).json({ error: 'Email SMTP सेट नहीं है।' });

    await transport.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: order.email,
      subject: 'Your GlamVerse AI e-book is ready',
      text: `Thank you for your order ${order.id}. Your payment was manually verified. Your e-book is attached.`,
      attachments: [{
        filename: 'GlamVerse_AI_3D_Cartoon_Reel_Prompt_Starter.pdf',
        path: pdfPath
      }]
    });

    await pool.query(
      `UPDATE orders SET status = 'approved', approved_at = NOW() WHERE id = $1`,
      [order.id]
    );

    res.json({ ok: true, message: 'Payment marked verified and PDF emailed.' });
  } catch (e) {
    console.error('Approval failed:', e.message);
    res.status(502).json({ error: 'Email send failed or database error. Check settings.' });
  }
});

app.get('/admin', (req, res) =>
  res.sendFile(path.join(__dirname, 'admin.html'))
);

app.get('/health', (req, res) =>
  res.json({ ok: true, service: 'GlamVerse AI order backend' })
);

app.listen(PORT, () =>
  console.log(`GlamVerse AI backend running on port ${PORT}`)
);
