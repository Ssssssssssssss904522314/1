module.exports = function installRegistrationBot({
  app,
  crypto,
  getDoc,
  putDoc,
  patchDoc,
  getCollection,
  tgFetch,
  token,
  webhookSecret,
  webhookUrl,
  botUsername,
  siteUrl
}) {
  if (!tgFetch) {
    tgFetch = async (tok, method, body) => {
      const response = await fetch(
        'https://api.telegram.org/bot' + tok + '/' + method,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {})
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.ok) {
        throw new Error(data?.description || 'Telegram API error');
      }

      return data.result;
    };
  }

  const now = () => Date.now();
  const stateId = (chatId) => String(chatId);

  const makeId = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let value = 'EK-';

    for (let i = 0; i < 8; i++) {
      value += chars[crypto.randomInt(0, chars.length)];
    }

    return value;
  };

  const hashPassword = (password, salt) =>
    crypto.createHash('sha256').update(salt + password).digest('hex');

  const makePasswordRecord = (password) => {
    const salt = crypto.randomBytes(16).toString('hex');

    return {
      salt,
      passHash: hashPassword(password, salt)
    };
  };

  const validUsername = (username) =>
    /^[a-z][a-z0-9_]{3,19}$/.test(username);

  const send = (chatId, text, replyMarkup) =>
    tgFetch(token, 'sendMessage', {
      chat_id: chatId,
      text,
      reply_markup: replyMarkup
    });

  const keyboard = {
    cancel: {
      inline_keyboard: [
        [{ text: '❌ Отмена', callback_data: 'reg_cancel' }]
      ]
    },

    login: {
      inline_keyboard: [
        [{ text: '🚀 Войти в EKOOOL', url: siteUrl }]
      ]
    },

    restart: {
      inline_keyboard: [
        [{ text: '🔄 Зарегистрироваться заново', callback_data: 'reg_restart' }]
      ]
    }
  };

  async function start(chatId) {
    await putDoc(
      'registration_bot_states',
      stateId(chatId),
      {
        chatId: String(chatId),
        step: 'name',
        expiresAt: now() + 30 * 60 * 1000
      }
    );

    return send(
      chatId,
      'Привет! Это бот для регистрации в мессенджере EKOOOL!\n\nНапиши имя которое хочешь установить.',
      keyboard.cancel
    );
  }

  async function cancel(chatId) {
    await patchDoc(
      'registration_bot_states',
      stateId(chatId),
      {
        step: 'cancelled',
        expiresAt: now() + 5 * 60 * 1000
      }
    );

    return send(
      chatId,
      'Регистрация отменена. Чтобы начать заново, отправь /start.'
    );
  }

  async function finish(chatId, state) {
    const existingUsers = await getCollection('users');

    const telegramDuplicate = existingUsers.find(
      (item) =>
        String(item.data?.telegramChatId || '') === String(chatId)
    );

    if (telegramDuplicate) {
      return send(
        chatId,
        '⚠️ Этот Telegram уже связан с аккаунтом EKOOOL.\n\nЮзернейм: @' +
          String(telegramDuplicate.data?.username || '')
      );
    }

    const usernameMap = await getDoc('usernames', state.username);

    if (usernameMap) {
      return send(
        chatId,
        '❌ Юзернейм @' +
          state.username +
          ' только что заняли. Отправь /start и выбери другой.'
      );
    }

    if (!state.salt || !state.passHash) {
      return send(
        chatId,
        '❌ Данные регистрации устарели. Отправь /start и начни заново.'
      );
    }

    const uid = makeId();
    const timestamp = now();

    const user = {
      name: state.name,
      photo: '',
      bio: '',
      verified: false,
      purchased: false,
      coins: 1000,
      username: state.username,
      extra: [],
      salt: state.salt,
      passHash: state.passHash,
      lastSeen: timestamp,
      ts: timestamp,
      telegramChatId: String(chatId),
      telegramUsername: String(state.telegramUsername || '')
    };

    await putDoc('users', uid, user);
    await putDoc('usernames', state.username, { uid });

    await patchDoc(
      'registration_bot_states',
      stateId(chatId),
      {
        step: 'done',
        uid,
        completedAt: timestamp,
        expiresAt: timestamp + 24 * 60 * 60 * 1000
      }
    );

    return send(
      chatId,
      '✅ Регистрация завершена!\n\n' +
        '👤 Имя: ' + state.name + '\n' +
        '🔹 Юзернейм: @' + state.username + '\n\n' +
        'Аккаунт EKOOOL создан. Теперь можешь войти в мессенджер.',
      keyboard.login
    );
  }

  app.post('/api/telegram/registration-webhook', async (req, res) => {
    if (
      webhookSecret &&
      req.get('x-telegram-bot-api-secret-token') !== webhookSecret
    ) {
      return res.sendStatus(401);
    }

    res.sendStatus(200);

    try {
      const update = req.body || {};
      const message = update.message;
      const callback = update.callback_query;

      if (callback?.message?.chat?.id) {
        const chatId = String(callback.message.chat.id);
        const data = String(callback.data || '');

        if (data === 'reg_cancel') {
          await cancel(chatId);
        } else if (data === 'reg_restart') {
          await start(chatId);
        } else if (data === 'reg_confirm') {
          const state = await getDoc(
            'registration_bot_states',
            stateId(chatId)
          );

          if (
            !state ||
            state.step !== 'confirm' ||
            Number(state.expiresAt || 0) <= now()
          ) {
            await send(
              chatId,
              '❌ Регистрация истекла. Отправь /start и начни заново.',
              keyboard.restart
            );
          } else {
            await finish(chatId, state);
          }
        }

        await tgFetch(token, 'answerCallbackQuery', {
          callback_query_id: callback.id
        });

        return;
      }

      if (!message?.chat?.id) {
        return;
      }

      const chatId = String(message.chat.id);
      const text = String(message.text || '').trim();
      const telegramUsername = String(message.from?.username || '');

      if (text === '/start' || text === 'старт') {
        await start(chatId);
        return;
      }

      const state = await getDoc(
        'registration_bot_states',
        stateId(chatId)
      );

      if (
        !state ||
        Number(state.expiresAt || 0) <= now() ||
        ['cancelled', 'done'].includes(String(state.step || ''))
      ) {
        await start(chatId);
        return;
      }

      if (state.step === 'name') {
        if (text.length < 2 || text.length > 60) {
          await send(
            chatId,
            'Имя должно быть от 2 до 60 символов. Попробуй ещё раз.',
            keyboard.cancel
          );
          return;
        }

        await patchDoc(
          'registration_bot_states',
          stateId(chatId),
          {
            step: 'username',
            name: text,
            telegramUsername
          }
        );

        await send(
          chatId,
          'Отличное имя! Теперь напиши свой юзернейм который хочешь установить.\n\nПример: vyacheslav',
          keyboard.cancel
        );

        return;
      }

      if (state.step === 'username') {
        const username = text.replace(/^@/, '').toLowerCase();

        if (!validUsername(username)) {
          await send(
            chatId,
            '❌ Юзернейм должен быть 4–20 символов: английские буквы, цифры и _.\n\nПервый символ — буква.',
            keyboard.cancel
          );
          return;
        }

        if (await getDoc('usernames', username)) {
          await send(
            chatId,
            '❌ Юзернейм @' + username + ' уже занят. Напиши другой.',
            keyboard.cancel
          );
          return;
        }

        await patchDoc(
          'registration_bot_states',
          stateId(chatId),
          {
            step: 'password',
            username
          }
        );

        await send(
          chatId,
          'Отлично! Юзернейм @' +
            username +
            ' свободен.\n\n' +
            'Теперь придумай пароль для входа в EKOOOL. Минимум 6 символов.',
          keyboard.cancel
        );

        return;
      }

      if (state.step === 'password') {
        if (text.length < 6 || text.length > 128) {
          await send(
            chatId,
            '❌ Пароль должен быть от 6 до 128 символов. Попробуй ещё раз.',
            keyboard.cancel
          );
          return;
        }

        const passwordRecord = makePasswordRecord(text);

        await patchDoc(
          'registration_bot_states',
          stateId(chatId),
          {
            step: 'confirm',
            salt: passwordRecord.salt,
            passHash: passwordRecord.passHash
          }
        );

        await send(
          chatId,
          'Проверь данные:\n\n' +
            '👤 Имя: ' + state.name + '\n' +
            '🔹 Юзернейм: @' + state.username + '\n' +
            '🔐 Пароль: ••••••••\n\n' +
            'Если всё верно, нажми «Создать аккаунт».',
          {
            inline_keyboard: [
              [{ text: '✅ Создать аккаунт', callback_data: 'reg_confirm' }],
              [{ text: '❌ Отмена', callback_data: 'reg_cancel' }]
            ]
          }
        );

        return;
      }
    } catch (error) {
      console.error(
        'EKOOOL registration bot error:',
        error?.message || error
      );
    }
  });

  (async () => {
    try {
      await tgFetch(token, 'setWebhook', {
        url: webhookUrl,
        secret_token: webhookSecret || undefined,
        drop_pending_updates: false
      });

      await tgFetch(token, 'setMyCommands', {
        commands: [
          {
            command: 'start',
            description: 'Начать регистрацию EKOOOL'
          }
        ]
      });

      console.log(
        'EKOOOL Registration Telegram bot webhook configured'
      );
    } catch (error) {
      console.error(
        'EKOOOL Registration bot setup failed:',
        error?.message || error
      );
    }
  })();
};
