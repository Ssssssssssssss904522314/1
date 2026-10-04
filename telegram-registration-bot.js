module.exports=function installRegistrationBot({app,crypto,getDoc,putDoc,patchDoc,getCollection,tgFetch,token,webhookSecret,webhookUrl,botUsername,siteUrl}){
  if(!tgFetch)tgFetch=async(tok,method,body)=>{const r=await fetch('https://api.telegram.org/bot'+tok+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});const x=await r.json().catch(()=>({}));if(!r.ok||!x.ok)throw new Error(x?.description||'Telegram API error');return x.result};
  const now=()=>Date.now();
  const stateId=chatId=>String(chatId);
  const makeId=()=> 'EK-'+Array.from({length:8},()=> 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(0,32)]).join('');
  const hashPassword=(password,salt)=>crypto.createHash('sha256').update(salt+password).digest('hex');
  const validUsername=u=>/^[a-z][a-z0-9_]{3,19}$/.test(u);
  const send=(chat_id,text,reply_markup)=>tgFetch(token,'sendMessage',{chat_id,text,reply_markup});
  const edit=(chat_id,message_id,text,reply_markup)=>tgFetch(token,'editMessageText',{chat_id,message_id,text,reply_markup});
  const keyboard={cancel:{inline_keyboard:[[ {text:'❌ Отмена',callback_data:'reg_cancel'} ]]},login:{inline_keyboard:[[ {text:'🚀 Войти в EKOOOL',url:siteUrl} ]]},restart:{inline_keyboard:[[ {text:'🔄 Зарегистрироваться заново',callback_data:'reg_restart'} ]]}}};

  async function start(chatId){
    await putDoc('registration_bot_states',stateId(chatId),{chatId:String(chatId),step:'name',expiresAt:now()+30*60*1000});
    return send(chatId,'Привет! Это бот для регистрации в мессенджере EKOOOL!\n\nНапиши имя которое хочешь установить.',keyboard.cancel);
  }
  async function cancel(chatId){
    await patchDoc('registration_bot_states',stateId(chatId),{step:'cancelled',expiresAt:now()+5*60*1000});
    return send(chatId,'Регистрация отменена. Чтобы начать заново, отправь /start.');
  }
  async function finish(chatId,state){
    const existing=await getCollection('users');
    const duplicate=existing.find(x=>String(x.data?.telegramChatId||'')===String(chatId));
    if(duplicate)return send(chatId,'⚠️ Этот Telegram уже связан с аккаунтом EKOOOL.\n\nЮзернейм: @'+String(duplicate.data?.username||''));
    const salt=crypto.randomBytes(16).toString('hex');
    const uid=makeId();
    const user={name:state.name,photo:'',bio:'',verified:false,purchased:false,coins:1000,username:state.username,extra:[],salt:state.salt||salt,passHash:state.passHash||hashPassword(state.password||'',state.salt||salt),lastSeen:now(),ts:now(),telegramChatId:String(chatId),telegramUsername:String(state.telegramUsername||'')};
    await putDoc('users',uid,user);
    await putDoc('usernames',state.username,{uid});
    await patchDoc('registration_bot_states',stateId(chatId),{step:'done',uid,completedAt:now(),expiresAt:now()+24*60*60*1000});
    return send(chatId,'✅ Регистрация завершена!\n\n👤 Имя: '+state.name+'\n🔹 Юзернейм: @'+state.username+'\n\nАккаунт EKOOOL создан. Теперь можешь войти в мессенджер.',keyboard.login);
  }

  app.post('/api/telegram/registration-webhook',async(req,res)=>{
    if(webhookSecret&&req.get('x-telegram-bot-api-secret-token')!==webhookSecret)return res.sendStatus(401);
    res.sendStatus(200);
    try{
      const u=req.body||{},msg=u.message,cb=u.callback_query;
      if(cb?.message?.chat?.id){
        const chatId=String(cb.message.chat.id),data=String(cb.data||'');
        if(data==='reg_cancel')await cancel(chatId);
        else if(data==='reg_restart')await start(chatId);
        else if(data==='reg_confirm'){
          const st=await getDoc('registration_bot_states',stateId(chatId));
          if(!st||st.step!=='confirm'||Number(st.expiresAt||0)<=now())await send(chatId,'❌ Регистрация истекла. Отправь /start и начни заново.',keyboard.restart);
          else await finish(chatId,st);
        }
        await tgFetch(token,'answerCallbackQuery',{callback_query_id:cb.id});
        return;
      }
      if(!msg?.chat?.id)return;
      const chatId=String(msg.chat.id),text=String(msg.text||'').trim();
      const tgUsername=String(msg.from?.username||'');
      if(text==='/start'||text==='старт'){await start(chatId);return;}
      let st=await getDoc('registration_bot_states',stateId(chatId));
      if(!st||Number(st.expiresAt||0)<=now()||['cancelled','done'].includes(String(st.step||''))){await start(chatId);return;}
      if(st.step==='name'){
        if(text.length<2||text.length>60)return send(chatId,'Имя должно быть от 2 до 60 символов. Попробуй ещё раз.',keyboard.cancel);
        await patchDoc('registration_bot_states',stateId(chatId),{step:'username',name:text,telegramUsername:tgUsername});
        await send(chatId,'Отличное имя! Теперь напиши свой юзернейм который хочешь установить.\n\nПример: vyacheslav',keyboard.cancel);
        return;
      }
      if(st.step==='username'){
        const username=text.replace(/^@/,'').toLowerCase();
        if(!validUsername(username))return send(chatId,'❌ Юзернейм должен быть 4–20 символов: английские буквы, цифры и _.\n\nПервый символ — буква.',keyboard.cancel);
        if(await getDoc('usernames',username))return send(chatId,'❌ Юзернейм @'+username+' уже занят. Напиши другой.',keyboard.cancel);
        await patchDoc('registration_bot_states',stateId(chatId),{step:'password',username});
        await send(chatId,'Отлично! Юзернейм @'+username+' свободен.\n\nТеперь придумай пароль для входа в EKOOOL. Минимум 6 символов.',keyboard.cancel);
        return;
      }
      if(st.step==='password'){
        if(text.length<6||text.length>128)return send(chatId,'❌ Пароль должен быть от 6 до 128 символов. Попробуй ещё раз.',keyboard.cancel);
        await patchDoc('registration_bot_states',stateId(chatId),{step:'confirm',password:text});
        await send(chatId,'Проверь данные:\n\n👤 Имя: '+st.name+'\n🔹 Юзернейм: @'+st.username+'\n🔐 Пароль: ••••••••\n\nЕсли всё верно, нажми «Создать аккаунт».', {inline_keyboard:[[ {text:'✅ Создать аккаунт',callback_data:'reg_confirm'} ],[ {text:'❌ Отмена',callback_data:'reg_cancel'} ]]});
        return;
      }
    }catch(e){console.error('EKOOOL registration bot error:',e.message)}
  });

  app.post('/api/telegram/registration-confirm',async(req,res)=>{
    res.sendStatus(404);
  });

  (async()=>{try{
    await tgFetch(token,'setWebhook',{url:webhookUrl,secret_token:webhookSecret||undefined,drop_pending_updates:false});
    console.log('EKOOOL Registration Telegram bot webhook configured');
    await tgFetch(token,'setMyCommands',{commands:[{command:'start',description:'Начать регистрацию EKOOOL'}]});
  }catch(e){console.error('EKOOOL Registration bot setup failed:',e.message)}})();
};