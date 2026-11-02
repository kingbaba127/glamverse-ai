const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Resend } = require('resend');
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
  'AI Fashion & Beauty Pack': { amount: 149, file: 'fashion.pdf', deliverable: true },
  'Ultimate AI Reel Bundle': { amount: 199, file: 'ultimate.pdf', deliverable: true }
};

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '30kb' }));
app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
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

    const accessToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex');

    const result = await pool.query(
      `INSERT INTO orders (id, email, utr, product, amount, download_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, status`,
      [id, String(email).trim().toLowerCase(), String(utr).trim(), product, item.amount, tokenHash]
    );

    res.status(201).json({
      orderId: result.rows[0].id,
      status: result.rows[0].status,
      accessToken
    });
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ error: 'This UTR has already been submitted.' });
    console.error('Order save failed:', e.message);
    res.status(500).json({ error: 'Order could not be saved.' });
  }
});

async function verifyCustomerToken(req, res, next) {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer /i, '');
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return res.status(401).json({ error: 'Invalid download access.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await pool.query(
      'SELECT * FROM orders WHERE id = $1 AND download_token = $2',
      [req.params.id, tokenHash]
    );

    if (!result.rowCount) {
      return res.status(401).json({ error: 'Order access not found. Use the original device and order details.' });
    }

    req.customerOrder = result.rows[0];
    next();
  } catch (e) {
    console.error('Customer order check failed:', e.message);
    res.status(500).json({ error: 'Could not check order.' });
  }
}

app.get('/api/my-order/:id', verifyCustomerToken, (req, res) => {
  const order = req.customerOrder;
  const item = PRODUCTS[order.product];
  res.json({
    orderId: order.id,
    product: order.product,
    status: order.status,
    downloadUrl: order.status === 'approved' && item && item.file
      ? '/api/my-order/' + encodeURIComponent(order.id) + '/download'
      : null
  });
});

app.get('/api/my-order/:id/download', verifyCustomerToken, (req, res) => {
  const order = req.customerOrder;
  if (order.status !== 'approved') {
    return res.status(403).json({ error: 'Payment is not approved yet.' });
  }

  const item = PRODUCTS[order.product];
  if (!item || !item.deliverable || !item.file) {
    return res.status(404).json({ error: 'PDF is not available.' });
  }

  const pdfPath = path.join(__dirname, item.file);
  res.download(pdfPath, path.basename(item.file), (err) => {
    if (err) console.error('PDF download failed:', err.message);
  });
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

app.delete('/api/admin/orders/:id', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM orders WHERE id = $1 AND status = 'pending' RETURNING id",
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: 'Pending order not found. Approved orders cannot be deleted.'
      });
    }

    res.json({ ok: true, message: 'Pending order deleted successfully.' });
  } catch (e) {
    console.error('Order delete failed:', e.message);
    res.status(500).json({ error: 'Unable to delete order.' });
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
      return res.status(400).json({ error: 'The PDF for this product is not configured.' });

    const fs = require('fs');
    const pdfPath = path.join(__dirname, item.file);
    if (!fs.existsSync(pdfPath))
      return res.status(400).json({ error: 'PDF file not found.' });

    await pool.query(
      `UPDATE orders SET status = 'approved', approved_at = NOW() WHERE id = $1`,
      [order.id]
    );

    res.json({
      ok: true,
      message: 'Payment approved. Customer can now download the PDF from the website.'
    });
  } catch (e) {
    console.error('Approval failed:', e.message);
    res.status(500).json({ error: 'Could not approve order. Check server logs.' });
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
