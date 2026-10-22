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

  app.post('/api/ekoool-card/age-verification/start', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      const card = await getDoc('ekoool_cards', String(user.id));
      if (!card) return res.status(404).json({ error: 'Сначала выпустите карту EKOOOL.' });
      // Never trust a client-side checkbox, uploaded selfie, or claimed AI result.
      return res.status(503).json({
        error: 'Провайдер проверки возраста не настроен. Возраст нельзя подтвердить одним нажатием; лимит остаётся 1 000 ₽.',
        code: 'age_verification_provider_unconfigured'
      });
    } catch (e) { res.status(500).json({ error: 'Не удалось начать проверку возраста' }); }
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
