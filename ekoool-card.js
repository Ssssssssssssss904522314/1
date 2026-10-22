'use strict';

// EKOOOL Card is an internal closed-loop balance, not a bank-issued payment card.
module.exports = function installEkooolCard(app, deps) {
  const { userAuth, getDoc, putDoc, patchDoc, getCollection, crypto, BANKA_API_KEY, BANKA_SHOP_ID, YOTI_API_KEY, YOTI_SDK_ID, isAdmin } = deps;
  const CARD_PREFIX = '5112';
  const TOPUP_LIMIT_RUB = 1000;
  const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

  function cardKey(uid, cardId) { return cardId === 'primary' ? String(uid) : String(uid) + ':' + String(cardId); }
  function normalizeCard(card, key) {
    const createdAt = Number(card.createdAt || Date.now());
    return {
      ...card,
      cardId: String(card.cardId || (key && key.includes(':') ? key.slice(key.indexOf(':') + 1) : 'primary')),
      createdAt,
      expiresAt: Number(card.expiresAt || (createdAt + YEAR_MS)),
      status: card.status || 'active'
    };
  }
  function publicCard(input) {
    const card = normalizeCard(input);
    return {
      cardId: card.cardId,
      cardNumber: card.cardNumber,
      balanceKopecks: Number(card.balanceKopecks || 0),
      status: card.status,
      createdAt: card.createdAt,
      expiresAt: card.expiresAt,
      pinSet: !!card.pinHash,
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
  function validPin(pin) { return /^\d{4,6}$/.test(String(pin || '')); }
  function pinDigest(pin, salt) {
    return crypto.scryptSync(String(pin), salt, 32).toString('hex');
  }
  function verifyPin(card, pin) {
    if (!card.pinHash || !card.pinSalt || !validPin(pin)) return false;
    const actual = Buffer.from(pinDigest(pin, card.pinSalt), 'hex');
    const expected = Buffer.from(String(card.pinHash), 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  async function allUserCards(uid) {
    const docs = await getCollection('ekoool_cards');
    return docs.filter(x => String(x.data?.uid) === String(uid))
      .map(x => ({ key: x.id, card: normalizeCard(x.data, x.id) }))
      .sort((a,b) => Number(a.card.createdAt) - Number(b.card.createdAt));
  }
  async function getOrCreatePrimary(uid) {
    let card = await getDoc('ekoool_cards', String(uid));
    if (!card) {
      const docs = await getCollection('ekoool_cards');
      let number, collision = true, attempts = 0;
      while (collision && attempts++ < 8) {
        number = newCardNumber();
        collision = docs.some(x => x.data && x.data.cardNumber === number);
      }
      if (collision) return null;
      card = { uid: String(uid), cardId: 'primary', cardNumber: number, balanceKopecks: 0, status: 'active', createdAt: Date.now(), expiresAt: Date.now() + YEAR_MS, ageVerified: false };
      await putDoc('ekoool_cards', String(uid), card);
    } else {
      const normalized = normalizeCard(card, String(uid));
      if (!card.expiresAt || !card.cardId) {
        card = { ...normalized, uid: String(uid), cardId: 'primary' };
        await putDoc('ekoool_cards', String(uid), card);
      }
    }
    return normalizeCard(card, String(uid));
  }
  async function resolveCard(uid, cardId) {
    const id = String(cardId || 'primary');
    const key = cardKey(uid, id);
    const raw = await getDoc('ekoool_cards', key);
    if (!raw || String(raw.uid) !== String(uid)) return null;
    return { key, card: normalizeCard(raw, key) };
  }

  app.get('/api/ekoool-card', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      const primary = await getOrCreatePrimary(user.id);
      if (!primary) return res.status(503).json({ error: 'Не удалось выпустить номер карты. Повторите позже.' });
      const cards = await allUserCards(user.id);
      const selected = cards.find(x => x.card.cardId === String(req.query.cardId || 'primary')) || cards.find(x => x.card.cardId === 'primary') || { card: primary };
      const txs = (await getCollection('ekoool_card_txs'))
        .filter(x => String(x.data?.uid) === String(user.id))
        .sort((a,b) => Number(b.data?.ts || 0) - Number(a.data?.ts || 0))
        .slice(0, 50).map(x => ({ type: x.data.type, cardId: x.data.cardId || 'primary', amountKopecks: Number(x.data.amountKopecks || 0), note: String(x.data.note || ''), ts: Number(x.data.ts || 0) }));
      res.json({ ok: true, card: publicCard(selected.card), cards: cards.map(x => publicCard(x.card)), transactions: txs, topupLimitRub: TOPUP_LIMIT_RUB, ageVerificationConfigured: !!(YOTI_API_KEY && YOTI_SDK_ID) });
    } catch (e) { res.status(500).json({ error: 'Не удалось загрузить EKOOOL Card' }); }
  });


  // Internal transfers are enabled only with PostgreSQL transactions to prevent double spending.
  app.post('/api/ekoool-card/transfer', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      if (!deps.pool) return res.status(503).json({ error: 'Переводы временно недоступны: требуется транзакционное хранилище. Баланс не изменён.' });
      const amountRub = Number(req.body?.amountRub);
      const pin = String(req.body?.pin || '');
      const recipientNumber = String(req.body?.recipientNumber || '').replace(/\s+/g, '');
      if (!Number.isSafeInteger(amountRub) || amountRub < 1 || amountRub > 100000) return res.status(400).json({ error: 'Введите сумму от 1 до 100 000 ₽ целым числом.' });
      if (!validPin(pin)) return res.status(400).json({ error: 'Введите PIN-код из 4–6 цифр.' });
      if (!/^\d{12}$/.test(recipientNumber) && !/^5112\d{12}$/.test(recipientNumber)) return res.status(400).json({ error: 'Укажите номер карты EKOOOL из 16 цифр или номер администратора из 12 цифр.' });
      const source = await resolveCard(user.id, req.body?.cardId);
      if (!source) return res.status(404).json({ error: 'Ваша карта не найдена.' });
      if (source.card.cardNumber === recipientNumber) return res.status(400).json({ error: 'Нельзя переводить на эту же карту.' });
      const adminRecipient = recipientNumber === '666600001111';
      if (!adminRecipient && !/^5112\d{12}$/.test(recipientNumber)) return res.status(404).json({ error: 'Номер получателя не найден.' });
      const docs = await getCollection('ekoool_cards');
      let recipientDoc = adminRecipient ? docs.find(x => x.id === '__ekoool_admin_wallet__') : docs.find(x => String(x.data?.cardNumber || '') === recipientNumber);
      if (!recipientDoc && adminRecipient) {
        const wallet = { uid: '__ekoool_admin_wallet__', cardId: 'admin', cardNumber: '666600001111', balanceKopecks: 0, status: 'active', createdAt: Date.now(), expiresAt: Date.now() + 100 * YEAR_MS, adminWallet: true };
        await putDoc('ekoool_cards', '__ekoool_admin_wallet__', wallet);
        recipientDoc = { id: '__ekoool_admin_wallet__', data: wallet };
      }
      if (!recipientDoc) return res.status(404).json({ error: 'Карта получателя не найдена.' });
      if (!adminRecipient && String(recipientDoc.data?.uid) === String(user.id)) return res.status(400).json({ error: 'Выберите другую карту получателя.' });
      const sourceKey = source.key, targetKey = recipientDoc.id;
      if (sourceKey === targetKey) return res.status(400).json({ error: 'Нельзя переводить на эту же карту.' });
      const amountKopecks = amountRub * 100;
      const client = await deps.pool.connect();
      try {
        await client.query('BEGIN');
        const keys = [sourceKey, targetKey].sort();
        const rows = await client.query('SELECT id,data FROM ekoool_kv WHERE collection=$1 AND id = ANY($2::text[]) ORDER BY id FOR UPDATE', ['ekoool_cards', keys]);
        const byId = new Map(rows.rows.map(row => [String(row.id), row.data]));
        const sender = byId.get(sourceKey), recipient = byId.get(targetKey);
        const now = Date.now();
        if (!sender || String(sender.uid) !== String(user.id) || sender.status !== 'active' || Number(sender.expiresAt || 0) <= now || !verifyPin(sender, pin)) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Карта, срок действия или PIN-код не прошли проверку. Перевод отменён.' });
        }
        if (!recipient || recipient.cardNumber !== recipientNumber || recipient.status !== 'active' || Number(recipient.expiresAt || (Number(recipient.createdAt || 0) + YEAR_MS)) <= now || Number(recipient.balanceKopecks || 0) < 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Карта получателя недоступна. Перевод отменён.' });
        }
        if (Number(sender.balanceKopecks || 0) < amountKopecks) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Недостаточно средств на карте.' });
        }
        const txId = 'transfer_' + crypto.randomBytes(12).toString('hex');
        const senderNext = { ...sender, balanceKopecks: Number(sender.balanceKopecks || 0) - amountKopecks, updatedAt: now };
        const recipientNext = { ...recipient, balanceKopecks: Number(recipient.balanceKopecks || 0) + amountKopecks, updatedAt: now };
        await client.query('UPDATE ekoool_kv SET data=$3 WHERE collection=$1 AND id=$2', ['ekoool_cards', sourceKey, JSON.stringify(senderNext)]);
        await client.query('UPDATE ekoool_kv SET data=$3 WHERE collection=$1 AND id=$2', ['ekoool_cards', targetKey, JSON.stringify(recipientNext)]);
        await client.query('INSERT INTO ekoool_kv(collection,id,data) VALUES($1,$2,$3)', ['ekoool_card_txs', txId + '_out', JSON.stringify({ uid: String(user.id), cardId: source.card.cardId, type: 'transfer_out', amountKopecks: -amountKopecks, note: 'Перевод на ' + recipientNumber, recipientNumber, transferId: txId, ts: now })]);
        await client.query('INSERT INTO ekoool_kv(collection,id,data) VALUES($1,$2,$3)', ['ekoool_card_txs', txId + '_in', JSON.stringify({ uid: String(recipient.uid), cardId: recipient.cardId || 'admin', type: 'transfer_in', amountKopecks, note: 'Перевод от ' + String(sender.cardNumber), senderNumber: String(sender.cardNumber), transferId: txId, ts: now })]);
        await client.query('COMMIT');
        return res.json({ ok: true, receipt: { transferId: txId, status: 'Успешно', amountRub, from: sender.cardNumber, to: recipientNumber, ts: now, currency: 'RUB' }, balanceKopecks: senderNext.balanceKopecks });
      } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    } catch (e) {
      console.error('EKOOOL Card transfer failed:', e.message);
      return res.status(500).json({ error: 'Перевод не выполнен. Проверьте историю операций; повторите позже.' });
    }
  });

  // Admin-only manual credit to the internal administrator wallet. This does not represent real money.
  app.post('/api/ekoool-card/admin/credit', async (req, res) => {
    try {
      if (typeof isAdmin !== 'function' || !isAdmin(req)) return res.status(401).json({ error: 'Только администратор.' });
      const amountRub = Number(req.body?.amountRub);
      const reason = String(req.body?.reason || '').trim().slice(0, 160);
      if (!Number.isSafeInteger(amountRub) || amountRub < 1 || amountRub > 1000000) {
        return res.status(400).json({ error: 'Введите целую сумму от 1 до 1 000 000 ₽.' });
      }
      if (!reason) return res.status(400).json({ error: 'Укажите основание начисления.' });
      const walletId = '__ekoool_admin_wallet__';
      const cardNumber = '666600001111';
      const now = Date.now();
      const amountKopecks = amountRub * 100;
      if (!Number.isSafeInteger(amountKopecks)) return res.status(400).json({ error: 'Сумма слишком велика.' });
      const existing = await getDoc('ekoool_cards', walletId);
      const initialWallet = existing || {
        uid: '__ekoool_admin_wallet__', cardId: 'admin', cardNumber,
        balanceKopecks: 0, status: 'active', createdAt: now,
        expiresAt: now + 100 * YEAR_MS, adminWallet: true
      };
      if (!deps.pool) {
        if (initialWallet.status !== 'active') return res.status(409).json({ error: 'Кошелёк администратора не активен.' });
        const balanceKopecks = Number(initialWallet.balanceKopecks || 0) + amountKopecks;
        if (!Number.isSafeInteger(balanceKopecks)) return res.status(409).json({ error: 'Баланс превысит допустимый предел.' });
        await putDoc('ekoool_cards', walletId, { ...initialWallet, balanceKopecks, updatedAt: now });
        const transactionId = 'admin_credit_' + crypto.randomBytes(12).toString('hex');
        await putDoc('ekoool_card_txs', transactionId, {
          uid: '__ekoool_admin_wallet__', cardId: 'admin', type: 'admin_credit',
          amountKopecks, note: 'Админское начисление: ' + reason, reason,
          transactionId, ts: now, adminIssued: true
        });
        return res.json({ ok: true, cardNumber, amountKopecks, balanceKopecks, transactionId, internalBalanceOnly: true });
      }
      const client = await deps.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'INSERT INTO ekoool_kv(collection,id,data) VALUES($1,$2,$3) ON CONFLICT(collection,id) DO NOTHING',
          ['ekoool_cards', walletId, JSON.stringify(initialWallet)]
        );
        const row = await client.query(
          'SELECT data FROM ekoool_kv WHERE collection=$1 AND id=$2 FOR UPDATE',
          ['ekoool_cards', walletId]
        );
        const wallet = row.rows[0]?.data;
        if (!wallet || wallet.cardNumber !== cardNumber || wallet.status !== 'active') {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Кошелёк администратора не активен или не прошёл проверку.' });
        }
        const balanceKopecks = Number(wallet.balanceKopecks || 0) + amountKopecks;
        if (!Number.isSafeInteger(balanceKopecks)) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Баланс превысит допустимый предел.' });
        }
        const transactionId = 'admin_credit_' + crypto.randomBytes(12).toString('hex');
        await client.query(
          'UPDATE ekoool_kv SET data=$3 WHERE collection=$1 AND id=$2',
          ['ekoool_cards', walletId, JSON.stringify({ ...wallet, balanceKopecks, updatedAt: now })]
        );
        await client.query(
          'INSERT INTO ekoool_kv(collection,id,data) VALUES($1,$2,$3)',
          ['ekoool_card_txs', transactionId, JSON.stringify({
            uid: '__ekoool_admin_wallet__', cardId: 'admin', type: 'admin_credit',
            amountKopecks, note: 'Админское начисление: ' + reason, reason,
            transactionId, ts: now, adminIssued: true
          })]
        );
        await client.query('COMMIT');
        return res.json({ ok: true, cardNumber, amountKopecks, balanceKopecks, transactionId, internalBalanceOnly: true });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally { client.release(); }
    } catch (e) {
      console.error('EKOOOL admin wallet credit failed:', e.message);
      return res.status(500).json({ error: 'Начисление не выполнено. Баланс не подтверждён; проверьте операции перед повтором.' });
    }
  });

  app.get('/api/ekoool-card/admin/cards', async (req, res) => {
    try {
      if (typeof isAdmin !== 'function' || !isAdmin(req)) return res.status(401).json({ error: 'Только администратор.' });
      const q = String(req.query?.q || '').trim().toLowerCase().slice(0, 100);
      const docs = await getCollection('ekoool_cards');
      const cards = docs.filter(x => x.data && (!q || String(x.data.cardNumber || '').toLowerCase().includes(q) || String(x.data.uid || '').toLowerCase().includes(q)))
        .slice(0, 100).map(x => {
          const c = normalizeCard(x.data, x.id);
          return { uid: String(c.uid || ''), cardId: c.cardId, cardNumber: String(c.cardNumber || ''), balanceKopecks: Number(c.balanceKopecks || 0), status: c.status, expiresAt: Number(c.expiresAt || 0), createdAt: Number(c.createdAt || 0), pinSet: !!c.pinHash, ageVerified: c.ageVerified === true, adminWallet: c.adminWallet === true };
        });
      const txdocs = await getCollection('ekoool_card_txs');
      const transactions = txdocs.map(x => ({ ...(x.data || {}), id: x.id })).filter(t => !q || String(t.uid || '').toLowerCase().includes(q) || String(t.note || '').toLowerCase().includes(q) || String(t.senderNumber || '').includes(q) || String(t.recipientNumber || '').includes(q))
        .sort((a,b) => Number(b.ts || 0) - Number(a.ts || 0)).slice(0, 100)
        .map(t => ({ uid: String(t.uid || ''), cardId: String(t.cardId || ''), type: String(t.type || ''), amountKopecks: Number(t.amountKopecks || 0), note: String(t.note || ''), ts: Number(t.ts || 0), transferId: String(t.transferId || '') }));
      return res.json({ ok: true, cards, transactions, adminCardNumber: '666600001111' });
    } catch (e) { return res.status(500).json({ error: 'Не удалось загрузить данные ECard.' }); }
  });

  app.post('/api/ekoool-card/close', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      const resolved = await resolveCard(user.id, req.body?.cardId);
      if (!resolved) return res.status(404).json({ error: 'Карта не найдена.' });
      if (resolved.card.status === 'frozen') return res.status(409).json({ error: 'Карта заморожена навсегда; повторно открыть её нельзя.' });
      await patchDoc('ekoool_cards', resolved.key, { status: 'closed', statusUpdatedAt: Date.now() });
      return res.json({ ok: true, status: 'closed', message: 'Карта закрыта. Её можно открыть снова.' });
    } catch (e) { res.status(500).json({ error: 'Не удалось закрыть карту.' }); }
  });

  app.post('/api/ekoool-card/reopen', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      const resolved = await resolveCard(user.id, req.body?.cardId);
      if (!resolved) return res.status(404).json({ error: 'Карта не найдена.' });
      if (resolved.card.status === 'frozen') return res.status(409).json({ error: 'Замороженную навсегда карту открыть нельзя.' });
      if (resolved.card.expiresAt <= Date.now()) return res.status(409).json({ error: 'Срок карты истёк. Выпустите новую карту.' });
      await patchDoc('ekoool_cards', resolved.key, { status: 'active', statusUpdatedAt: Date.now() });
      return res.json({ ok: true, status: 'active', message: 'Карта снова активна.' });
    } catch (e) { res.status(500).json({ error: 'Не удалось открыть карту.' }); }
  });

  app.post('/api/ekoool-card/freeze', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      const resolved = await resolveCard(user.id, req.body?.cardId);
      if (!resolved) return res.status(404).json({ error: 'Карта не найдена.' });
      if (resolved.card.status === 'frozen') return res.json({ ok: true, status: 'frozen', message: 'Карта уже заморожена навсегда.' });
      await patchDoc('ekoool_cards', resolved.key, { status: 'frozen', frozenAt: Date.now(), statusUpdatedAt: Date.now() });
      return res.json({ ok: true, status: 'frozen', message: 'Карта заморожена навсегда. Повторное открытие невозможно.' });
    } catch (e) { res.status(500).json({ error: 'Не удалось заморозить карту.' }); }
  });

  app.post('/api/ekoool-card/issue', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      const cards = await allUserCards(user.id);
      if (cards.length >= 2) return res.status(409).json({ error: 'Можно иметь не более двух карт EKOOOL одновременно.' });
      const used = new Set((await getCollection('ekoool_cards')).map(x => x.data?.cardNumber).filter(Boolean));
      let number, collision = true, attempts = 0;
      while (collision && attempts++ < 20) { number = newCardNumber(); collision = used.has(number); }
      if (collision) return res.status(503).json({ error: 'Не удалось выпустить номер карты. Повторите позже.' });
      const cardId = 'card_' + crypto.randomBytes(6).toString('hex');
      const now = Date.now();
      const card = { uid: String(user.id), cardId, cardNumber: number, balanceKopecks: 0, status: 'active', createdAt: now, expiresAt: now + YEAR_MS, ageVerified: false };
      await putDoc('ekoool_cards', cardKey(user.id, cardId), card);
      return res.json({ ok: true, card: publicCard(card), message: 'Выпущена вторая карта со сроком действия один год.' });
    } catch (e) { res.status(500).json({ error: 'Не удалось выпустить новую карту.' }); }
  });

  app.post('/api/ekoool-card/pin', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      const resolved = await resolveCard(user.id, req.body?.cardId);
      if (!resolved) return res.status(404).json({ error: 'Карта не найдена.' });
      const pin = String(req.body?.pin || '');
      if (!validPin(pin)) return res.status(400).json({ error: 'PIN-код должен содержать 4–6 цифр.' });
      if (resolved.card.pinHash && !verifyPin(resolved.card, req.body?.currentPin)) return res.status(403).json({ error: 'Текущий PIN-код неверен.' });
      const salt = crypto.randomBytes(16).toString('hex');
      await patchDoc('ekoool_cards', resolved.key, { pinSalt: salt, pinHash: pinDigest(pin, salt), pinUpdatedAt: Date.now() });
      return res.json({ ok: true, message: 'PIN-код сохранён. Он не показывается на обороте карты.' });
    } catch (e) { res.status(500).json({ error: 'Не удалось сохранить PIN-код.' }); }
  });

  // Safe payout preflight: verifies BANKA API access and balance endpoint only. Never creates a payout.
  app.post('/api/ekoool-card/payout/check', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      if (!BANKA_API_KEY || !BANKA_SHOP_ID) return res.status(503).json({ error: 'BANKA не настроена на сервере. Перевод не создан.' });
      const [accountResp, balanceResp] = await Promise.all([
        fetch('https://api.banka.bot/v1/account', { headers: { Authorization: 'Bearer ' + BANKA_API_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }),
        fetch('https://api.banka.bot/v1/balance', { headers: { Authorization: 'Bearer ' + BANKA_API_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
      ]);
      const account = await accountResp.json().catch(() => ({}));
      const balance = await balanceResp.json().catch(() => ({}));
      if (!accountResp.ok) return res.status(accountResp.status === 401 ? 502 : 503).json({ error: accountResp.status === 401 ? 'BANKA отклонила API-ключ. Перевод не создан.' : 'BANKA временно не ответила на проверку ключа. Перевод не создан.' });
      if (!balanceResp.ok) return res.status(503).json({ error: 'Ключ работает, но баланс BANKA сейчас проверить не удалось. Перевод не создан.' });
      const availableRaw = balance.available ?? balance.rub?.available ?? balance.balances?.rub?.available ?? null;
      const available = availableRaw == null ? null : Number(String(availableRaw));
      return res.json({
        ok: true,
        keyValid: true,
        balanceEndpointReachable: true,
        payoutMethodAvailable: Array.isArray(account.methods) ? account.methods.includes('card') : null,
        availableBalancePositive: Number.isFinite(available) ? available > 0 : null,
        payoutCreated: false,
        message: 'Проверка соединения успешна. Реальная выплата НЕ создавалась и деньги не списывались. Право на выплаты и лимит BANKA ещё требуют отдельной проверки.'
      });
    } catch (e) {
      return res.status(503).json({ error: 'Не удалось связаться с BANKA. Выплата не создавалась, деньги не списывались.' });
    }
  });

  app.post('/api/ekoool-card/topup', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      const amountRub = Number(req.body?.amountRub);
      if (!Number.isSafeInteger(amountRub) || amountRub < 1 || amountRub > 100000) return res.status(400).json({ error: 'Введите сумму от 1 до 100 000 ₽ целым числом.' });
      const resolved = await resolveCard(user.id, req.body?.cardId);
      const card = resolved?.card;
      if (!card || card.status !== 'active' || card.expiresAt <= Date.now()) return res.status(409).json({ error: 'Нужна активная карта с действующим сроком.' });
      if (amountRub > TOPUP_LIMIT_RUB && card.ageVerified !== true) return res.status(403).json({ error: 'Для пополнения свыше 1 000 ₽ требуется подтверждение возраста 14+ через подключённого проверенного провайдера.', code: 'age_verification_required' });
      if (!BANKA_API_KEY || !BANKA_SHOP_ID) return res.status(503).json({ error: 'Пополнение через BANKA BOT пока не подключено к EKOOOL Card. Средства не списаны.', code: 'banka_card_topup_unconfigured' });
      return res.status(503).json({ error: 'Интеграция BANKA Card Top-up требует подтверждённого API-контракта провайдера. Баланс не изменён.', code: 'banka_card_topup_pending_integration' });
    } catch (e) { res.status(500).json({ error: 'Не удалось создать запрос пополнения' }); }
  });

  app.post('/api/ekoool-card/age-verification/start', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      const resolved = await resolveCard(user.id, req.body?.cardId);
      if (!resolved) return res.status(404).json({ error: 'Сначала выпустите карту EKOOOL.' });
      if (resolved.card.ageVerified === true) return res.json({ ok: true, alreadyVerified: true, message: 'Возраст уже подтверждён для этой карты.' });
      if (!YOTI_API_KEY || !YOTI_SDK_ID) return res.status(503).json({ error: 'Yoti пока не настроен на сервере. Добавьте YOTI_API_KEY и YOTI_SDK_ID в Render; лимит остаётся 1 000 ₽.', code: 'age_verification_provider_unconfigured' });
      const referenceId = 'ecv_' + crypto.randomBytes(18).toString('hex');
      const baseUrl = String(process.env.PUBLIC_BASE_URL || 'https://ekool-server.onrender.com').replace(/\/$/, '');
      const payload = {
        type: 'OVER', ttl: 900, reference_id: referenceId,
        age_estimation: { allowed: true, threshold: 16, level: 'PASSIVE', authenticity: 'AUTO', retry_limit: 2 },
        doc_scan: { allowed: true, threshold: 14, level: 'PASSIVE', authenticity: 'AUTO', retry_limit: 2, preset_issuing_country: 'GBR' },
        digital_id: { allowed: true, threshold: 14, age_estimation_allowed: true, age_estimation_threshold: 16, retry_limit: 2 },
        credit_card: { allowed: false }, mobile: { allowed: false },
        callback: { auto: true, url: baseUrl + '/card.html?ageVerification=return' },
        cancel_url: baseUrl + '/card.html?ageVerification=cancel',
        privacy_policy: baseUrl + '/privacy.html',
        notification_url: baseUrl + '/api/ekoool-card/age-verification/notification',
        synchronous_checks: false
      };
      const response = await fetch('https://age.yoti.com/api/v1/sessions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + YOTI_API_KEY, 'Yoti-Sdk-Id': YOTI_SDK_ID, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(12000)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.id) {
        console.error('Yoti session creation failed:', response.status, JSON.stringify(data).slice(0, 500));
        return res.status(502).json({ error: 'Yoti не смог создать сессию проверки. Попробуйте позже.', code: 'yoti_session_creation_failed' });
      }
      await patchDoc('ekoool_cards', resolved.key, {
        ageVerificationSessionId: String(data.id),
        ageVerificationReferenceId: referenceId,
        ageVerificationStartedAt: Date.now(),
        ageVerificationStatus: 'pending'
      });
      return res.json({ ok: true, verificationUrl: 'https://age.yoti.com?sessionId=' + encodeURIComponent(data.id) + '&sdkId=' + encodeURIComponent(YOTI_SDK_ID), expiresAt: data.expires_at || null });
    } catch (e) {
      console.error('Age verification start error:', e.message);
      return res.status(502).json({ error: 'Не удалось начать проверку возраста. Лимит остаётся 1 000 ₽.' });
    }
  });

  app.get('/api/ekoool-card/age-verification/status', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      const resolved = await resolveCard(user.id, req.query?.cardId);
      if (!resolved) return res.status(404).json({ error: 'Карта не найдена.' });
      if (resolved.card.ageVerified === true) return res.json({ ok: true, status: 'verified', ageVerified: true });
      if (!YOTI_API_KEY || !YOTI_SDK_ID) return res.status(503).json({ error: 'Yoti не настроен.', ageVerified: false });
      const sessionId = String(resolved.card.ageVerificationSessionId || '');
      const referenceId = String(resolved.card.ageVerificationReferenceId || '');
      if (!sessionId || !referenceId) return res.json({ ok: true, status: 'not_started', ageVerified: false });
      const response = await fetch('https://age.yoti.com/api/v1/sessions/' + encodeURIComponent(sessionId) + '/result', {
        headers: { Authorization: 'Bearer ' + YOTI_API_KEY, 'Yoti-Sdk-Id': YOTI_SDK_ID, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return res.status(502).json({ error: 'Не удалось получить результат Yoti.', ageVerified: false });
      if (String(data.id || '') !== sessionId || String(data.reference_id || '') !== referenceId) return res.status(502).json({ error: 'Не удалось подтвердить соответствие результата сессии.', ageVerified: false });
      if (data.status === 'COMPLETE' && data.type === 'OVER' && Number(data.age) === 14) {
        await patchDoc('ekoool_cards', resolved.key, { ageVerified: true, ageVerifiedAt: Date.now(), ageVerificationStatus: 'verified', ageVerificationMethod: String(data.method || '') });
        return res.json({ ok: true, status: 'verified', ageVerified: true, message: 'Проверка возраста 14+ пройдена.' });
      }
      if (['FAIL', 'ERROR', 'CANCELLED', 'EXPIRED'].includes(String(data.status || ''))) {
        await patchDoc('ekoool_cards', resolved.key, { ageVerificationStatus: String(data.status).toLowerCase() });
        return res.json({ ok: true, status: String(data.status).toLowerCase(), ageVerified: false, message: 'Возраст не подтверждён. Лимит остаётся 1 000 ₽.' });
      }
      return res.json({ ok: true, status: String(data.status || 'pending').toLowerCase(), ageVerified: false, message: 'Проверка ещё выполняется.' });
    } catch (e) {
      console.error('Age verification status error:', e.message);
      return res.status(502).json({ error: 'Не удалось проверить статус. Попробуйте ещё раз.', ageVerified: false });
    }
  });

  app.post('/api/ekoool-card/age-verification/notification', async (req, res) => {
    // Yoti notifications are informational only; the authenticated status endpoint fetches
    // the authoritative session result from Yoti before changing a card's verified state.
    return res.status(200).json({ ok: true });
  });

  app.post('/api/ekoool-card/purchase', async (req, res) => {
    try {
      const user = await currentUser(req, res); if (!user) return;
      const amountRub = Number(req.body?.amountRub);
      const itemId = String(req.body?.itemId || '').trim().slice(0, 100);
      const note = String(req.body?.note || 'Покупка внутри EKOOOL').trim().slice(0, 160);
      if (!itemId || !Number.isSafeInteger(amountRub) || amountRub < 1 || amountRub > 100000) return res.status(400).json({ error: 'Некорректная покупка.' });
      const resolved = await resolveCard(user.id, req.body?.cardId);
      if (!resolved) return res.status(404).json({ error: 'Карта EKOOOL не найдена.' });
      const { key, card } = resolved;
      if (card.status !== 'active' || card.expiresAt <= Date.now()) return res.status(409).json({ error: 'Карта закрыта, заморожена или срок её действия истёк.' });
      if (!card.pinHash || !verifyPin(card, req.body?.pin)) return res.status(403).json({ error: 'Введите правильный PIN-код. Списание отменено.', code: 'invalid_pin' });
      const amountKopecks = amountRub * 100;
      if (Number(card.balanceKopecks || 0) < amountKopecks) return res.status(409).json({ error: 'Недостаточно средств на карте.' });
      if (deps.pool) {
        const client = await deps.pool.connect();
        try {
          await client.query('BEGIN');
          const row = await client.query('SELECT data FROM ekoool_kv WHERE collection=$1 AND id=$2 FOR UPDATE', ['ekoool_cards', key]);
          const fresh = row.rows[0]?.data;
          if (!fresh || fresh.status !== 'active' || Number(fresh.expiresAt || (Number(fresh.createdAt || 0) + YEAR_MS)) <= Date.now() || !verifyPin(fresh, req.body?.pin) || Number(fresh.balanceKopecks || 0) < amountKopecks) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Проверка карты, PIN-кода или баланса не пройдена. Списание отменено.' });
          }
          const ts = Date.now(), txId = 'card_' + crypto.randomBytes(12).toString('hex');
          await client.query('UPDATE ekoool_kv SET data=$3 WHERE collection=$1 AND id=$2', ['ekoool_cards', key, JSON.stringify({ ...fresh, balanceKopecks: Number(fresh.balanceKopecks || 0) - amountKopecks, updatedAt: ts })]);
          await client.query('INSERT INTO ekoool_kv(collection,id,data) VALUES($1,$2,$3)', ['ekoool_card_txs', txId, JSON.stringify({ uid: String(user.id), cardId: card.cardId, type: 'purchase', amountKopecks: -amountKopecks, note, itemId, ts })]);
          await client.query('COMMIT');
          return res.json({ ok: true, balanceKopecks: Number(fresh.balanceKopecks || 0) - amountKopecks });
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      }
      const fresh = await getDoc('ekoool_cards', key);
      if (!fresh || fresh.status !== 'active' || Number(fresh.expiresAt || (Number(fresh.createdAt || 0) + YEAR_MS)) <= Date.now() || !verifyPin(fresh, req.body?.pin) || Number(fresh.balanceKopecks || 0) < amountKopecks) return res.status(409).json({ error: 'Проверка карты, PIN-кода или баланса не пройдена. Списание отменено.' });
      const ts = Date.now(), txId = 'card_' + crypto.randomBytes(12).toString('hex');
      await patchDoc('ekoool_cards', key, { balanceKopecks: Number(fresh.balanceKopecks || 0) - amountKopecks, updatedAt: ts });
      await putDoc('ekoool_card_txs', txId, { uid: String(user.id), cardId: card.cardId, type: 'purchase', amountKopecks: -amountKopecks, note, itemId, ts });
      return res.json({ ok: true, balanceKopecks: Number(fresh.balanceKopecks || 0) - amountKopecks });
    } catch (e) { res.status(500).json({ error: 'Покупку не удалось обработать' }); }
  });
};
