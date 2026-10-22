const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = process.env.DATABASE_URL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const COOKIE_NAME = 'ekoool_admin_session';
const MAX_BODY = '32kb';
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 8000
}) : null;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  next();
});
app.use(express.json({ limit: MAX_BODY, type: 'application/json' }));

const attempts = new Map();
function rateLimit(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = bucket + ':' + String(req.ip || req.socket.remoteAddress || 'unknown');
    const now = Date.now();
    let item = attempts.get(key);
    if (!item || now - item.start > windowMs) item = { start: now, count: 0 };
    item.count++;
    attempts.set(key, item);
    if (attempts.size > 5000) for (const [k, v] of attempts) if (now - v.start > windowMs) attempts.delete(k);
    if (item.count > max) return res.status(429).json({ error: 'Слишком много попыток. Попробуйте позже.' });
    next();
  };
}
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function sign(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return encoded + '.' + sig;
}
function verify(token) {
  if (!token || !SESSION_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(parts[0]).digest('base64url');
  if (!safeEqual(expected, parts[1])) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data : null;
  } catch (_) { return null; }
}
function requireDb(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'Хранилище пока не настроено. Администратору нужно задать DATABASE_URL в Render.' });
  next();
}
function requireAdmin(req, res, next) {
  const session = verify((req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE_NAME + '='))?.slice(COOKIE_NAME.length + 1));
  if (!session || session.role !== 'admin') return res.status(401).json({ error: 'Требуется вход администратора.' });
  req.admin = session;
  next();
}
async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS admin_portal;
    CREATE TABLE IF NOT EXISTS admin_portal.applications (
      id UUID PRIMARY KEY,
      public_id VARCHAR(24) UNIQUE NOT NULL,
      access_hash CHAR(64) NOT NULL,
      product VARCHAR(32) NOT NULL CHECK (product IN ('messenger','ecard')),
      username VARCHAR(64) NOT NULL,
      contact VARCHAR(100),
      experience TEXT NOT NULL,
      reason TEXT NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'На рассмотрении'
        CHECK (status IN ('На рассмотрении','Одобрена','Отклонена')),
      rejection_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS applications_status_created_idx
      ON admin_portal.applications (status, created_at DESC);
  `);
}
app.get('/api/health', async (req, res) => {
  let database = false;
  if (pool) { try { await pool.query('SELECT 1'); database = true; } catch (_) {} }
  res.status(database ? 200 : 503).json({ ok: database, database, adminConfigured: Boolean(ADMIN_PASSWORD && SESSION_SECRET) });
});
app.post('/api/applications', requireDb, rateLimit('submit', 8, 60 * 60 * 1000), async (req, res) => {
  const product = req.body && req.body.product;
  const username = String(req.body?.username || '').trim().replace(/^@+/, '').slice(0, 64);
  const contact = String(req.body?.contact || '').trim().slice(0, 100);
  const experience = String(req.body?.experience || '').trim().slice(0, 800);
  const reason = String(req.body?.reason || '').trim().slice(0, 800);
  if (!['messenger', 'ecard'].includes(product) || username.length < 2 || experience.length < 10 || reason.length < 10) {
    return res.status(400).json({ error: 'Проверьте форму: укажите username, опыт и причину (не менее 10 символов).' });
  }
  const id = crypto.randomUUID();
  const publicId = 'EK-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  const accessToken = crypto.randomBytes(24).toString('base64url');
  try {
    await pool.query(
      `INSERT INTO admin_portal.applications
       (id, public_id, access_hash, product, username, contact, experience, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, publicId, hash(accessToken), product, '@' + username, contact, experience, reason]
    );
    res.status(201).json({ id: publicId, accessToken, status: 'На рассмотрении' });
  } catch (err) {
    console.error('application insert failed:', err.message);
    res.status(500).json({ error: 'Не удалось сохранить заявку. Попробуйте позже.' });
  }
});
app.get('/api/status/:id', requireDb, rateLimit('status', 30, 15 * 60 * 1000), async (req, res) => {
  const token = String(req.query.token || '');
  if (!/^[A-Z0-9-]{5,24}$/.test(req.params.id) || token.length < 20) return res.status(400).json({ error: 'Укажите номер заявки и секретный код доступа.' });
  try {
    const result = await pool.query(
      'SELECT public_id, product, status, rejection_reason, created_at, updated_at, access_hash FROM admin_portal.applications WHERE public_id=$1',
      [req.params.id]
    );
    const a = result.rows[0];
    if (!a || !safeEqual(a.access_hash, hash(token))) return res.status(404).json({ error: 'Заявка не найдена или код доступа неверен.' });
    res.json({ id: a.public_id, product: a.product, status: a.status, rejectionReason: a.status === 'Отклонена' ? a.rejection_reason : null, createdAt: a.created_at, updatedAt: a.updated_at });
  } catch (err) { console.error('status lookup failed:', err.message); res.status(500).json({ error: 'Не удалось проверить статус.' }); }
});
app.post('/api/admin/login', rateLimit('login', 8, 15 * 60 * 1000), (req, res) => {
  if (!ADMIN_PASSWORD || !SESSION_SECRET) return res.status(503).json({ error: 'Вход не настроен: задайте ADMIN_PASSWORD и SESSION_SECRET в Render.' });
  const password = String(req.body?.password || '');
  if (!safeEqual(password, ADMIN_PASSWORD)) return res.status(401).json({ error: 'Неверный пароль.' });
  const token = sign({ role: 'admin', exp: Date.now() + 8 * 60 * 60 * 1000 });
  res.setHeader('Set-Cookie', COOKIE_NAME + '=' + token + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800');
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/admin/applications', requireDb, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT public_id AS id, product, username, contact, experience, reason, status, rejection_reason AS "rejectionReason", created_at AS "createdAt"
       FROM admin_portal.applications ORDER BY created_at DESC LIMIT 300`
    );
    res.json({ applications: result.rows });
  } catch (err) { console.error('admin list failed:', err.message); res.status(500).json({ error: 'Не удалось загрузить заявки.' }); }
});
app.patch('/api/admin/applications/:id', requireDb, requireAdmin, rateLimit('decision', 100, 60 * 60 * 1000), async (req, res) => {
  const status = req.body?.status;
  const rejectionReason = String(req.body?.rejectionReason || '').trim().slice(0, 1000);
  if (!['Одобрена', 'Отклонена'].includes(status)) return res.status(400).json({ error: 'Недопустимый статус.' });
  if (status === 'Отклонена' && rejectionReason.length < 3) return res.status(400).json({ error: 'Для отказа укажите причину.' });
  try {
    const result = await pool.query(
      `UPDATE admin_portal.applications SET status=$1, rejection_reason=$2, updated_at=NOW()
       WHERE public_id=$3 RETURNING public_id AS id, status, rejection_reason AS "rejectionReason"`,
      [status, status === 'Отклонена' ? rejectionReason : null, req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Заявка не найдена.' });
    res.json({ application: result.rows[0] });
  } catch (err) { console.error('decision update failed:', err.message); res.status(500).json({ error: 'Не удалось обновить заявку.' }); }
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const server = app.listen(PORT, async () => {
  try { await initDb(); console.log(pool ? 'Application database initialized' : 'DATABASE_URL is not configured'); }
  catch (err) { console.error('Database initialization failed:', err.message); }
  console.log('EKOOOL application portal listening on port ' + PORT);
});
server.requestTimeout = 15000;
server.headersTimeout = 20000;
process.on('SIGTERM', async () => { server.close(); if (pool) await pool.end(); process.exit(0); });
