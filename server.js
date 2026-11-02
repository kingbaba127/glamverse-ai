const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'orders.json');
const PDF_FILE = path.join(__dirname, 'starter.pdf');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '30kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-before-deploying',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 2*60*60*1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', rateLimit({ windowMs: 15*60*1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));

const PRODUCTS = {
  '3D Cartoon Reel Starter': { amount: 99, file: 'starter.pdf', deliverable: true },
  'AI Fashion & Beauty Pack': { amount: 149, file: null, deliverable: false },
  'Ultimate AI Reel Bundle': { amount: 199, file: null, deliverable: false }
};

function readOrders() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}
function writeOrders(rows) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}
function adminOnly(req,res,next) {
  if (req.session && req.session.admin === true) return next();
  return res.status(401).json({ error: 'Admin login required.' });
}
function safeEqual(a,b) {
  const aa=Buffer.from(String(a||'')), bb=Buffer.from(String(b||''));
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}
function mailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT||587),
    secure: String(process.env.SMTP_SECURE||'false')==='true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

app.post('/api/orders', (req,res) => {
  const { email, utr, product, amount } = req.body || {};
  const item = PRODUCTS[product];
  if (!item || Number(amount)!==item.amount) return res.status(400).json({error:'Product or price is invalid.'});
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email||''))) return res.status(400).json({error:'Valid email is required.'});
  if (!/^[A-Za-z0-9-]{8,30}$/.test(String(utr||''))) return res.status(400).json({error:'Valid UTR / transaction reference is required.'});
  const rows=readOrders();
  if (rows.some(o=>o.utr.toLowerCase()===String(utr).toLowerCase())) return res.status(409).json({error:'This UTR has already been submitted.'});
  const order = {
    id: 'GV-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase(),
    email: String(email).trim().toLowerCase(), utr: String(utr).trim(),
    product, amount:item.amount, status:'pending',
    createdAt:new Date().toISOString()
  };
  rows.unshift(order); writeOrders(rows);
  res.status(201).json({orderId:order.id, status:'pending'});
});

app.post('/admin/login', (req,res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD || !safeEqual(password, process.env.ADMIN_PASSWORD))
    return res.status(401).json({error:'Wrong admin password.'});
  req.session.admin=true; res.json({ok:true});
});
app.post('/admin/logout', (req,res) => req.session.destroy(()=>res.json({ok:true})));
app.get('/api/admin/orders', adminOnly, (req,res)=>res.json(readOrders()));
app.post('/api/admin/orders/:id/approve', adminOnly, async (req,res) => {
  const rows=readOrders(); const order=rows.find(o=>o.id===req.params.id);
  if(!order) return res.status(404).json({error:'Order not found.'});
  if(order.status==='approved') return res.status(409).json({error:'Order already approved.'});
  const item=PRODUCTS[order.product];
  if(!item || !item.deliverable || !item.file || !fs.existsSync(path.join(__dirname,item.file)))
    return res.status(400).json({error:'इस प्रोडक्ट की PDF अभी सेट नहीं है। पहले सही PDF फाइल जोड़ें।'});
  const transport=mailer();
  if(!transport) return res.status(503).json({error:'Email SMTP सेट नहीं है। .env में SMTP details भरें।'});
  try {
    await transport.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: order.email,
      subject: 'Your GlamVerse AI e-book is ready',
      text: `Thank you for your order ${order.id}. Your payment was manually verified. Your e-book is attached.`,
      attachments:[{filename:'GlamVerse_AI_3D_Cartoon_Reel_Prompt_Starter.pdf',path:path.join(__dirname,item.file)}]
    });
    order.status='approved'; order.approvedAt=new Date().toISOString(); writeOrders(rows);
    res.json({ok:true,message:'Payment marked verified and PDF emailed.'});
  } catch(e) {
    console.error('Email send failed:',e.message);
    res.status(502).json({error:'Email send failed. Check SMTP settings; order remains pending.'});
  }
});

app.get('/admin', (req,res)=>res.sendFile(path.join(__dirname,'admin.html')));
app.get('/health', (req,res)=>res.json({ok:true,service:'GlamVerse AI order backend'}));
app.listen(PORT, ()=>console.log(`GlamVerse AI backend running on port ${PORT}`));
