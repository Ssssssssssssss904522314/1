'use strict';

// EKOOOL Card foundation. This is an internal closed-loop balance, not a payment-card PAN.
module.exports = function installEkooolCard(app, deps) {
  const { userAuth, getDoc, putDoc, patchDoc, getCollection, crypto, BANKA_API_KEY, BANKA_SHOP_ID } = deps;
  const CARD_PREFIX = '5112';
  const TOPUP_LIMIT_RUB = 1000;

  function publicCard(card) {
    return {
      cardNumber: card.cardNumber,
      balanceKopecks: Number(card.balanceKopecks || 0),
      status: card.status || 'active',
      createdAt: card.createdAt,
      ageVerified: card.ageVerified === true,
      ageVerifiedAt: card.ageVerifiedAt || null
    };
  }

  async function currentUser(req, res) {
    const user = await userAuth(req);
    if (!user) { res.status(401).json({ error: 'Войдите в EKOOOL' }); return null; }
    return user;
  }

  function newCardNumber() {
    // Display identifier only. It is not a bank-issued payment-card number.
    return CARD_PREFIX + Array.from({ length: 12 }, () => crypto.randomInt(0, 10)).join('');
  }

  app.get('/api/ekoool-card', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      let card = await getDoc('ekoool_cards', String(user.id));
      if (!card) {
        let number, collision = true, attempts = 0;
        while (collision && attempts++ < 8) {
          number = newCardNumber();
          const all = await getCollection('ekoool_cards');
          collision = all.some(x => x.data && x.data.cardNumber === number);
        }
        if (collision) return res.status(503).json({ error: 'Не удалось выпустить номер карты. Повторите позже.' });
        card = { uid: String(user.id), cardNumber: number, balanceKopecks: 0, status: 'active', createdAt: Date.now(), ageVerified: false };
        await putDoc('ekoool_cards', String(user.id), card);
      }
      const txs = (await getCollection('ekoool_card_txs'))
        .filter(x => String(x.data?.uid) === String(user.id))
        .sort((a,b) => Number(b.data?.ts || 0) - Number(a.data?.ts || 0))
        .slice(0, 50).map(x => ({ type: x.data.type, amountKopecks: Number(x.data.amountKopecks || 0), note: String(x.data.note || ''), ts: Number(x.data.ts || 0) }));
      res.json({ ok: true, card: publicCard(card), transactions: txs, topupLimitRub: TOPUP_LIMIT_RUB, ageVerificationConfigured: false });
    } catch (e) { res.status(500).json({ error: 'Не удалось загрузить EKOOOL Card' }); }
  });

  app.post('/api/ekoool-card/topup', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      const amountRub = Number(req.body?.amountRub);
      if (!Number.isSafeInteger(amountRub) || amountRub < 1 || amountRub > 100000) return res.status(400).json({ error: 'Введите сумму от 1 до 100 000 ₽ целым числом.' });
      const card = await getDoc('ekoool_cards', String(user.id));
      if (!card || card.status !== 'active') return res.status(409).json({ error: 'Сначала выпустите активную карту EKOOOL.' });
      if (amountRub > TOPUP_LIMIT_RUB && card.ageVerified !== true) {
        return res.status(403).json({ error: 'Для пополнения свыше 1 000 ₽ требуется подтверждение возраста 14+ через подключённого проверенного провайдера.', code: 'age_verification_required' });
      }
      if (!BANKA_API_KEY || !BANKA_SHOP_ID) return res.status(503).json({ error: 'Пополнение через BANKA BOT пока не подключено к EKOOOL Card. Средства не списаны.', code: 'banka_card_topup_unconfigured' });
      // Do not create a fake paid balance: BANKA's card-top-up API contract must be wired and verified first.
      return res.status(503).json({ error: 'Интеграция BANKA Card Top-up требует подтверждённого API-контракта провайдера. Баланс не изменён.', code: 'banka_card_topup_pending_integration' });
    } catch (e) { res.status(500).json({ error: 'Не удалось создать запрос пополнения' }); }
  });

  const YOTI_API_KEY = process.env.YOTI_AGE_API_KEY || '';
  const YOTI_SDK_ID = process.env.YOTI_AGE_SDK_ID || '';
  const PUBLIC_BASE_URL = (process.env.EKOOOL_PUBLIC_URL || 'https://ekool-server.onrender.com').replace(/\/$/, '');
  const YOTI_API_URL = 'https://age.yoti.com';

  app.post('/api/ekoool-card/age-verification/start', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      const card = await getDoc('ekoool_cards', String(user.id));
      if (!card || card.status !== 'active') return res.status(404).json({ error: 'Сначала выпустите активную карту EKOOOL.' });
      if (!YOTI_API_KEY || !YOTI_SDK_ID) {
        return res.status(503).json({
          error: 'Проверка возраста ещё не настроена: добавьте YOTI_AGE_API_KEY и YOTI_AGE_SDK_ID в Render. Лимит остаётся 1 000 ₽.',
          code: 'age_verification_provider_unconfigured'
        });
      }

      const referenceId = crypto.randomBytes(24).toString('hex');
      const callbackUrl = PUBLIC_BASE_URL + '/api/ekoool-card/age-verification/callback';
      const response = await fetch(YOTI_API_URL + '/api/v1/sessions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + YOTI_API_KEY,
          'Yoti-Sdk-Id': YOTI_SDK_ID,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'OVER',
          ttl: 900,
          reference_id: referenceId,
          age_estimation: {
            allowed: true,
            threshold: 14,
            retry_enabled: true,
            retry_limit: 2,
            level: 'PASSIVE',
            authenticity: 'AUTO'
          },
          digital_id: { allowed: false },
          doc_scan: { allowed: false },
          credit_card: { allowed: false },
          mobile: { allowed: false },
          callback: { url: callbackUrl, auto: true },
          cancel_url: PUBLIC_BASE_URL + '/card.html',
          privacy_policy: PUBLIC_BASE_URL + '/privacy.html',
          terms_and_conditions: PUBLIC_BASE_URL + '/terms.html',
          block_biometric_consent: false,
          retry_enabled: true,
          resume_enabled: false
        })
      });
      const created = await response.json().catch(() => ({}));
      if (!response.ok || !created.id) {
        console.error('Yoti session creation failed with HTTP', response.status);
        return res.status(502).json({ error: 'Сервис проверки возраста не смог создать сессию. Попробуйте позже.', code: 'age_verification_session_failed' });
      }

      await putDoc('ekoool_card_age_sessions', String(created.id), {
        uid: String(user.id),
        referenceId,
        createdAt: Date.now(),
        expiresAt: Date.now() + 15 * 60 * 1000,
        status: 'pending'
      });
      return res.json({
        ok: true,
        verificationUrl: YOTI_API_URL + '?sessionId=' + encodeURIComponent(created.id) + '&sdkId=' + encodeURIComponent(YOTI_SDK_ID),
        expiresAt: created.expires_at || null
      });
    } catch (e) {
      console.error('EKOOOL Card age verification start failed:', e.message);
      res.status(500).json({ error: 'Не удалось начать проверку возраста. Лимит остаётся 1 000 ₽.' });
    }
  });

  app.get('/api/ekoool-card/age-verification/callback', async (req, res) => {
    const cardUrl = '/card.html';
    try {
      const sessionId = String(req.query.sessionId || '');
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return res.status(400).send('Некорректная сессия проверки возраста.');
      if (!YOTI_API_KEY || !YOTI_SDK_ID) return res.status(503).send('Проверка возраста не настроена. Лимит остаётся 1 000 ₽.');
      const record = await getDoc('ekoool_card_age_sessions', sessionId);
      if (!record || !record.uid || Number(record.expiresAt || 0) < Date.now()) {
        return res.status(410).send('Сессия проверки возраста истекла. Вернитесь в EKOOOL Card и начните заново.');
      }

      const response = await fetch(YOTI_API_URL + '/api/v1/sessions/' + encodeURIComponent(sessionId) + '/result', {
        headers: { 'Authorization': 'Bearer ' + YOTI_API_KEY, 'Yoti-Sdk-Id': YOTI_SDK_ID, 'Content-Type': 'application/json' }
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error('Yoti result lookup failed with HTTP', response.status);
        return res.status(502).send('Не удалось получить результат проверки. Лимит остаётся 1 000 ₽.');
      }

      // Only trust a result fetched server-to-server from Yoti. A browser redirect alone never verifies age.
      const passed = result.status === 'COMPLETE' &&
        result.type === 'OVER' &&
        result.age_estimation && result.age_estimation.allowed === true &&
        Number(result.age_estimation.threshold) === 14 &&
        result.method === 'AGE_ESTIMATION';
      if (passed) {
        const card = await getDoc('ekoool_cards', String(record.uid));
        if (card && card.status === 'active') {
          await patchDoc('ekoool_cards', String(record.uid), {
            ageVerified: true,
            ageVerifiedAt: Date.now(),
            ageVerificationProvider: 'yoti',
            ageVerificationReference: String(record.referenceId || '').slice(0, 100)
          });
          await patchDoc('ekoool_card_age_sessions', sessionId, { status: 'passed', completedAt: Date.now() });
          return res.redirect(303, cardUrl + '?ageVerification=success');
        }
      }

      if (['FAIL', 'ERROR', 'CANCELLED', 'EXPIRED'].includes(String(result.status))) {
        await patchDoc('ekoool_card_age_sessions', sessionId, { status: String(result.status).toLowerCase(), completedAt: Date.now() });
        return res.redirect(303, cardUrl + '?ageVerification=failed');
      }
      return res.redirect(303, cardUrl + '?ageVerification=pending');
    } catch (e) {
      console.error('EKOOOL Card age verification callback failed:', e.message);
      return res.status(500).send('Не удалось завершить проверку. Лимит остаётся 1 000 ₽.');
    }
  });

  app.post('/api/ekoool-card/purchase', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      const amountRub = Number(req.body?.amountRub);
      const itemId = String(req.body?.itemId || '').trim().slice(0, 100);
      const note = String(req.body?.note || 'Покупка внутри EKOOOL').trim().slice(0, 160);
      if (!itemId || !Number.isSafeInteger(amountRub) || amountRub < 1 || amountRub > 100000) return res.status(400).json({ error: 'Некорректная покупка.' });
      const card = await getDoc('ekoool_cards', String(user.id));
      if (!card || card.status !== 'active') return res.status(404).json({ error: 'Карта EKOOOL не найдена.' });
      const amountKopecks = amountRub * 100;
      if (Number(card.balanceKopecks || 0) < amountKopecks) return res.status(409).json({ error: 'Недостаточно средств на карте.' });
      // Lock-and-update transaction when PostgreSQL is available to avoid concurrent double-spend.
      if (deps.pool) {
        const client = await deps.pool.connect();
        try {
          await client.query('BEGIN');
          const row = await client.query('SELECT data FROM ekoool_kv WHERE collection=$1 AND id=$2 FOR UPDATE', ['ekoool_cards', String(user.id)]);
          const fresh = row.rows[0]?.data;
          if (!fresh || Number(fresh.balanceKopecks || 0) < amountKopecks || fresh.status !== 'active') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Недостаточно средств на карте.' });
          }
          const ts = Date.now(), txId = 'card_' + crypto.randomBytes(12).toString('hex');
          await client.query('UPDATE ekoool_kv SET data=$3 WHERE collection=$1 AND id=$2', ['ekoool_cards', String(user.id), JSON.stringify({ ...fresh, balanceKopecks: Number(fresh.balanceKopecks || 0) - amountKopecks, updatedAt: ts })]);
          await client.query('INSERT INTO ekoool_kv(collection,id,data) VALUES($1,$2,$3)', ['ekoool_card_txs', txId, JSON.stringify({ uid: String(user.id), type: 'purchase', amountKopecks: -amountKopecks, note, itemId, ts })]);
          await client.query('COMMIT');
          return res.json({ ok: true, balanceKopecks: Number(fresh.balanceKopecks || 0) - amountKopecks });
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      }
      const fresh = await getDoc('ekoool_cards', String(user.id));
      if (!fresh || Number(fresh.balanceKopecks || 0) < amountKopecks) return res.status(409).json({ error: 'Недостаточно средств на карте.' });
      const ts = Date.now(), txId = 'card_' + crypto.randomBytes(12).toString('hex');
      await patchDoc('ekoool_cards', String(user.id), { balanceKopecks: Number(fresh.balanceKopecks || 0) - amountKopecks, updatedAt: ts });
      await putDoc('ekoool_card_txs', txId, { uid: String(user.id), type: 'purchase', amountKopecks: -amountKopecks, note, itemId, ts });
      return res.json({ ok: true, balanceKopecks: Number(fresh.balanceKopecks || 0) - amountKopecks });
    } catch (e) { res.status(500).json({ error: 'Покупку не удалось обработать' }); }
  });
};
