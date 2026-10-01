
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const app = express();
const PORT = Number(process.env.PORT || 10000);

const BOT_TOKEN = String(process.env.TELEGRAM_PASSWORD_BOT_TOKEN || '').trim();
const WEBHOOK_SECRET = String(process.env.TELEGRAM_PASSWORD_BOT_WEBHOOK_SECRET || '').trim();
const WEBHOOK_URL = String(process.env.TELEGRAM_PASSWORD_BOT_WEBHOOK_URL || '').trim();

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const GROQ_API_KEY = String(process.env.GROQ_API_KEY || '').trim();
const GROQ_MODEL = String(process.env.GROQ_MODEL || 'openai/gpt-oss-20b').trim();

const SMTP_HOST = String(process.env.SMTP_HOST || 'smtp.gmail.com').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '').trim();
const SMTP_FROM = String(process.env.SMTP_FROM || '').trim() || SMTP_USER;

const CODE_TTL = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

if (!BOT_TOKEN) throw new Error('TELEGRAM_PASSWORD_BOT_TOKEN is not configured');
if (!DATABASE_URL) throw new Error('DATABASE_URL is not configured');
if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY is not configured');
if (!SMTP_USER || !SMTP_PASS || !SMTP_FROM) throw new Error('SMTP settings are not configured');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  max: 5
});

async function initDb() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS ekoool_kv(collection TEXT NOT NULL,id TEXT NOT NULL,data JSONB NOT NULL,PRIMARY KEY(collection,id))'
  );
}

async function getDoc(collection, id) {
  const r = await pool.query(
    'SELECT data FROM ekoool_kv WHERE collection=$1 AND id=$2',
    [collection, String(id)]
  );
  return r.rows[0]?.data ?? null;
}

async function putDoc(collection, id, data) {
  await pool.query(
    'INSERT INTO ekoool_kv(collection,id,data) VALUES($1,$2,$3) ON CONFLICT(collection,id) DO UPDATE SET data=EXCLUDED.data',
    [collection, String(id), JSON.stringify(data || {})]
  );
}

async function patchDoc(collection, id, patch) {
  const old = await getDoc(collection, id);
  await putDoc(collection, id, { ...(old || {}), ...(patch || {}) });
}

async function deleteDoc(collection, id) {
  await pool.query(
    'DELETE FROM ekoool_kv WHERE collection=$1 AND id=$2',
    [collection, String(id)]
  );
}

async function tg(method, body) {
  const r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const x = await r.json().catch(() => ({}));
  if (!r.ok || !x.ok) throw new Error(x?.description || 'Telegram API error');
  return x.result;
}

async function aiClassify(text) {
  const raw = String(text || '').trim();
  if (!raw) return { intent: 'other', confidence: 1 };

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + GROQ_API_KEY
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0,
      max_tokens: 80,
      messages: [
        {
          role: 'system',
          content:
            'Ты ИИ-классификатор отдельного Telegram-бота EKOOOL. ' +
            'Определи, хочет ли человек восстановить или сменить пароль своего аккаунта EKOOOL, ' +
            'потому что он забыл/не помнит пароль, потерял доступ или не может войти. ' +
            'Учитывай смысл, разговорные фразы, опечатки и русский язык. ' +
            'Не считай просьбой о восстановлении чужой пароль, пароль приложения, Wi-Fi, e-mail или другой сервис. ' +
            'Отвечай ТОЛЬКО JSON: {"intent":"password_reset"|"other","confidence":0..1}.'
        },
        { role: 'user', content: raw }
      ]
    })
  });

  const x = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(x?.error?.message || 'Groq API error');

  const out = String(x?.choices?.[0]?.message?.content || '').trim();
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return { intent: 'other', confidence: 0 };

  const j = JSON.parse(m[0]);
  return {
    intent: j.intent === 'password_reset' ? 'password_reset' : 'other',
    confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0))
  };
}

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function validEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(v);
}

function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  if (!domain) return 'e-mail';
  return (name.length <= 2 ? name[0] + '*' : name.slice(0, 2) + '***') + '@' + domain;
}

function newPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  let out = 'EK';
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(String(salt) + String(password)).digest('hex');
}

function hashCode(chatId, ticket, code) {
  return crypto
    .createHash('sha256')
    .update(String(chatId) + ':' + String(ticket) + ':' + String(code))
    .digest('hex');
}

async function sendResetEmail(email, code) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  await transporter.sendMail({
    from: SMTP_FROM,
    to: email,
    subject: 'Код восстановления пароля EKOOOL',
    text:
      'Код восстановления пароля EKOOOL: ' + code +
      '\n\nКод действует 10 минут. Если вы не запрашивали восстановление, просто проигнорируйте это письмо.',
    html:
      '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#131826">' +
      '<h2>EKOOOL</h2><p>Ваш код восстановления пароля:</p>' +
      '<div style="font-size:34px;font-weight:800;letter-spacing:8px;margin:20px 0">' + code + '</div>' +
      '<p>Код действует 10 минут. Если вы не запрашивали восстановление, просто проигнорируйте это письмо.</p>' +
      '</div>'
  });
}

async function invalidateSessions(uid) {
  const r = await pool.query('SELECT id,data FROM ekoool_kv WHERE collection=$1', ['sessions']);
  for (const row of r.rows) {
    if (String(row.data?.uid) === String(uid)) await deleteDoc('sessions', row.id);
  }
}

async function beginRecovery(chatId) {
  await putDoc('telegram_password_recovery', String(chatId), {
    step: 'username',
    expires: Date.now() + CODE_TTL,
    attempts: 0,
    startedAt: Date.now()
  });

  return tg('sendMessage', {
    chat_id: chatId,
    text:
      '🔐 Восстановление пароля EKOOOL\n\n' +
      'Назови свой юзернейм EKOOOL, например: @username\n\n' +
      'Я отправлю код подтверждения на почту аккаунта.\n' +
      'Для отмены напиши «отмена».'
  });
}

async function processRecovery(chatId, text) {
  const state = await getDoc('telegram_password_recovery', String(chatId));
  if (!state || state.expires <= Date.now()) {
    await deleteDoc('telegram_password_recovery', String(chatId));
    return false;
  }

  const raw = String(text || '').trim();
  const low = raw.toLowerCase();

  if (['отмена', 'cancel'].includes(low)) {
    await deleteDoc('telegram_password_recovery', String(chatId));
    await tg('sendMessage', { chat_id: chatId, text: '✅ Восстановление пароля отменено.' });
    return true;
  }

  if (state.step === 'confirm') {
    if (['да', 'yes', 'ага', 'точно', 'хочу'].includes(low)) await beginRecovery(chatId);
    else {
      await deleteDoc('telegram_password_recovery', String(chatId));
      await tg('sendMessage', { chat_id: chatId, text: 'Хорошо. Восстановление пароля отменено.' });
    }
    return true;
  }

  if (state.step === 'username') {
    const username = raw.replace(/^@/, '').toLowerCase();

    if (!/^[a-z][a-z0-9_]{3,19}$/.test(username)) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: '❌ Нужен юзернейм EKOOOL из английских букв, цифр и _.'
      });
      return true;
    }

    const map = await getDoc('usernames', username);
    const uid = map?.uid ? String(map.uid) : '';
    if (!uid) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: '❌ Такой юзернейм EKOOOL не найден. Проверь его и отправь ещё раз.'
      });
      return true;
    }

    const user = await getDoc('users', uid);
    const email = normalizeEmail(user?.email);

    if (!user || !validEmail(email)) {
      await deleteDoc('telegram_password_recovery', String(chatId));
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          '⚠️ Для этого аккаунта нет подходящей подтверждённой почты. ' +
          'Автоматическое восстановление недоступно — обратись в поддержку EKOOOL.'
      });
      return true;
    }

    const ticket = crypto.randomBytes(24).toString('hex');
    const code = String(crypto.randomInt(100000, 1000000));

    await putDoc('telegram_password_recovery', String(chatId), {
      step: 'code',
      uid,
      username,
      email,
      ticket,
      codeHash: hashCode(chatId, ticket, code),
      expires: Date.now() + CODE_TTL,
      attempts: 0
    });

    try {
      await sendResetEmail(email, code);
    } catch (e) {
      await deleteDoc('telegram_password_recovery', String(chatId));
      console.error('Password-bot email error:', e.message);
      await tg('sendMessage', {
        chat_id: chatId,
        text: '❌ Не удалось отправить код на почту. Попробуй позже.'
      });
      return true;
    }

    await tg('sendMessage', {
      chat_id: chatId,
      text:
        '📩 Код отправлен на ' + maskEmail(email) + '.\n\n' +
        'Пришли сюда 6 цифр из письма. Код действует 10 минут.'
    });
    return true;
  }

  if (state.step === 'code') {
    if (!/^\d{6}$/.test(raw)) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: '❌ Введи 6-значный код из письма.'
      });
      return true;
    }

    const expected = hashCode(chatId, state.ticket, raw);
    const actual = String(state.codeHash || '');

    if (
      expected.length !== actual.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
    ) {
      const attempts = Number(state.attempts || 0) + 1;

      if (attempts >= MAX_ATTEMPTS) {
        await deleteDoc('telegram_password_recovery', String(chatId));
        await tg('sendMessage', {
          chat_id: chatId,
          text: '❌ Слишком много неверных попыток. Начни восстановление заново.'
        });
      } else {
        await patchDoc('telegram_password_recovery', String(chatId), { attempts });
        await tg('sendMessage', {
          chat_id: chatId,
          text: '❌ Неверный код. Осталось попыток: ' + (MAX_ATTEMPTS - attempts) + '.'
        });
      }
      return true;
    }

    const user = await getDoc('users', String(state.uid));
    if (!user) {
      await deleteDoc('telegram_password_recovery', String(chatId));
      await tg('sendMessage', { chat_id: chatId, text: '❌ Аккаунт больше не найден.' });
      return true;
    }

    const password = newPassword();
    const salt = crypto.randomBytes(8).toString('hex');
    const passHash = hashPassword(password, salt);

    await patchDoc('users', String(state.uid), {
      salt,
      passHash,
      lastSeen: Date.now()
    });

    await invalidateSessions(String(state.uid));
    await deleteDoc('telegram_password_recovery', String(chatId));

    await tg('sendMessage', {
      chat_id: chatId,
      text:
        '✅ Пароль EKOOOL успешно изменён!\n\n' +
        '👤 Юзернейм: @' + state.username + '\n' +
        '🔐 Новый пароль: ' + password + '\n\n' +
        'Теперь войди в EKOOOL. Никому не передавай этот пароль.'
    });
    return true;
  }

  return false;
}

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'EKOOOL password bot' });
});

app.post('/api/telegram/password-webhook', async (req, res) => {
  if (
    WEBHOOK_SECRET &&
    req.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET
  ) {
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  try {
    const msg = req.body?.message;
    if (!msg?.chat?.id) return;

    const chatId = msg.chat.id;
    const raw = String(msg.text || '').trim();

    const state = await getDoc('telegram_password_recovery', String(chatId));
    if (state?.expires > Date.now()) {
      await processRecovery(chatId, raw);
      return;
    }

    if (raw === '/start' || raw === '/help') {
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          '🤖 Я ИИ-бот восстановления пароля EKOOOL.\n\n' +
          'Напиши обычными словами, например: «я не помню пароль».'
      });
      return;
    }

    if (!raw) return;

    let intent;
    try {
      intent = await aiClassify(raw);
    } catch (e) {
      console.error('Password-bot AI error:', e.message);
      await tg('sendMessage', {
        chat_id: chatId,
        text: '🤖 ИИ временно недоступен. Попробуй отправить сообщение ещё раз чуть позже.'
      });
      return;
    }

    if (intent.intent === 'password_reset' && intent.confidence >= 0.78) {
      await beginRecovery(chatId);
      return;
    }

    if (intent.intent === 'password_reset' && intent.confidence >= 0.48) {
      await putDoc('telegram_password_recovery', String(chatId), {
        step: 'confirm',
        expires: Date.now() + CODE_TTL,
        attempts: 0
      });

      await tg('sendMessage', {
        chat_id: chatId,
        text:
          '🤖 Я правильно понял, что ты не помнишь пароль EKOOOL и хочешь его восстановить?\n\n' +
          'Ответь «да» или «нет».'
      });
      return;
    }

    await tg('sendMessage', {
      chat_id: chatId,
      text:
        'Я бот восстановления доступа EKOOOL. ' +
        'Напиши, например: «забыл пароль» или «не могу войти в аккаунт».'
    });
  } catch (e) {
    console.error('Password-bot webhook error:', e);
  }
});

async function setupWebhook() {
  if (!WEBHOOK_URL) {
    console.log('TELEGRAM_PASSWORD_BOT_WEBHOOK_URL is not set; webhook was not configured.');
    return;
  }

  await tg('setWebhook', {
    url: WEBHOOK_URL,
    secret_token: WEBHOOK_SECRET || undefined,
    drop_pending_updates: false
  });

  console.log('EKOOOL password bot webhook configured');
}

initDb()
  .then(async () => {
    app.listen(PORT, '0.0.0.0', async () => {
      console.log('EKOOOL password bot listening on ' + PORT);
      await setupWebhook();
    });
  })
  .catch((e) => {
    console.error('Password bot startup failed:', e);
    process.exit(1);
  });
