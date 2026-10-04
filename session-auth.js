module.exports=function installSessionAuth({app,crypto,getDoc,putDoc,patchDoc,deleteDoc,getCollection,createSession,sessionAuth,setSessionCookie,clearSessionCookie,sendTelegramBotMessage,telegramBotToken,botUsername='BotRegistor'}){
  const now=()=>Date.now();
  const reqId=()=>crypto.randomBytes(24).toString('base64url');
  const code=()=>String(crypto.randomInt(100000,1000000)).replace(/^(\\d{3})(\\d{3})$/,'$1-$2');
  const hash=v=>crypto.createHash('sha256').update('EKOOOL-DEVICE:'+String(v)).digest('hex');
  const deviceInfo=req=>String(req.body?.device||req.headers['user-agent']||'Неизвестное устройство').slice(0,180);
  const city=async req=>{
    try{
      const ip=String(req.headers['x-forwarded-for']||req.ip||'').split(',')[0].trim().replace(/^::ffff:/,'');
      if(!ip||ip==='127.0.0.1'||ip==='::1')return 'Город не определён';
      const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),2500);
      const r=await fetch('https://ipapi.co/'+encodeURIComponent(ip)+'/json/',{signal:ac.signal});
      clearTimeout(tm);const x=await r.json().catch(()=>({}));
      return String(x.city||x.region||'Город не определён').trim()||'Город не определён';
    }catch(e){return 'Город не определён'}
  };
  app.post('/api/device/login/request',async(req,res)=>{
    try{
      const id=reqId(),c=code(),t=now();
      await putDoc('device_login_requests',id,{codeHash:hash(c),displayCode:c,status:'pending',expiresAt:t+5*60*1000,createdAt:t,device:deviceInfo(req),city:await city(req)});
      res.json({ok:true,id,code:c,expiresAt:t+5*60*1000,qrUrl:req.protocol+'://'+req.get('host')+'/#device-approve/'+id});
    }catch(e){res.status(500).json({error:e.message||'Не удалось создать запрос входа'})}
  });
  app.get('/api/device/login/status',async(req,res)=>{
    try{
      const id=String(req.query.id||'').trim(),r=await getDoc('device_login_requests',id);
      if(!id||!r)return res.status(404).json({error:'Запрос не найден'});
      if(Number(r.expiresAt||0)<=now()&&r.status==='pending'){await patchDoc('device_login_requests',id,{status:'expired'});return res.json({ok:true,status:'expired'})}
      if(r.status!=='approved')return res.json({ok:true,status:r.status,expiresAt:r.expiresAt});
      const u=await getDoc('users',String(r.uid));if(!u||!u.passHash)return res.status(404).json({error:'Аккаунт не найден'});
      const token=await createSession(String(r.uid),{device:r.device,city:r.city,loginMethod:r.method||'qr'});
      await patchDoc('device_login_requests',id,{status:'consumed',consumedAt:now()});
      setSessionCookie(res,token);
      res.json({ok:true,status:'logged_in',id:String(r.uid)});
    }catch(e){res.status(500).json({error:e.message||'Ошибка проверки входа'})}
  });
  app.post('/api/device/login/approve',async(req,res)=>{
    try{
      const u=await sessionAuth(req);if(!u)return res.status(401).json({error:'Нужно быть вошедшим в EKOOOL на этом устройстве'});
      const id=String(req.body?.id||'').trim(),c=String(req.body?.code||'').trim();
      const r=await getDoc('device_login_requests',id);
      if(!r||Number(r.expiresAt||0)<=now()||r.status!=='pending')return res.status(400).json({error:'Запрос входа устарел или уже обработан'});
      if(c&&hash(c)!==String(r.codeHash))return res.status(400).json({error:'Неверный код входа'});
      await patchDoc('device_login_requests',id,{status:'approved',uid:u.id,approvedAt:now(),method:c?'code':'qr',approvedBySession:hash(String(req.headers.cookie||''))});
      res.json({ok:true});
    }catch(e){res.status(500).json({error:e.message||'Не удалось подтвердить вход'})}
  });
  app.get('/api/device/sessions',async(req,res)=>{
    try{
      const u=await sessionAuth(req);if(!u)return res.status(401).json({error:'Unauthorized'});
      const raw=String(req.headers.cookie||''),current=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-EKOOOL-SESSION='))?.split('=').slice(1).join('')||'';
      const currentId=current?crypto.createHash('sha256').update(String(decodeURIComponent(current))).digest('hex'):'';
      const docs=await getCollection('sessions'),items=docs.filter(x=>String(x.data?.uid)===String(u.id)&&Number(x.data?.expires||0)>now()).map(x=>({id:x.id,current:x.id===currentId,device:String(x.data?.device||'Неизвестное устройство'),city:String(x.data?.city||'Город не определён'),createdAt:Number(x.data?.createdAt||0),expires:Number(x.data?.expires||0),method:String(x.data?.loginMethod||'password')})).sort((a,b)=>b.createdAt-a.createdAt);
      res.json({ok:true,sessions:items});
    }catch(e){res.status(500).json({error:e.message||'Не удалось загрузить сессии'})}
  });
  app.post('/api/device/sessions/revoke',async(req,res)=>{
    try{
      const u=await sessionAuth(req);if(!u)return res.status(401).json({error:'Unauthorized'});
      const id=String(req.body?.id||''),s=await getDoc('sessions',id);
      if(!s||String(s.uid)!==String(u.id))return res.status(404).json({error:'Сессия не найдена'});
      const raw=String(req.headers.cookie||''),cur=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-EKOOOL-SESSION='))?.split('=').slice(1).join('')||'';
      const curId=cur?crypto.createHash('sha256').update(String(decodeURIComponent(cur))).digest('hex'):'';
      if(id===curId)return res.status(400).json({error:'Текущую сессию завершайте кнопкой «Выйти»'});
      await deleteDoc('sessions',id);res.json({ok:true});
    }catch(e){res.status(500).json({error:e.message||'Не удалось завершить сессию'})}
  });
  app.post('/api/device/sessions/revoke-all',async(req,res)=>{
    try{
      const u=await sessionAuth(req);if(!u)return res.status(401).json({error:'Unauthorized'});
      const raw=String(req.headers.cookie||''),cur=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-EKOOOL-SESSION='))?.split('=').slice(1).join('')||'';
      const curId=cur?crypto.createHash('sha256').update(String(decodeURIComponent(cur))).digest('hex'):'';
      const docs=await getCollection('sessions');for(const x of docs)if(String(x.data?.uid)===String(u.id)&&x.id!==curId)await deleteDoc('sessions',x.id);
      res.json({ok:true});
    }catch(e){res.status(500).json({error:e.message||'Не удалось завершить сессии'})}
  });
  app.post('/api/auth/register/request',async(req,res)=>{
    try{
      const name=String(req.body?.name||'').trim().slice(0,60),username=String(req.body?.username||'').trim().toLowerCase().replace(/^@/,'');
      const password=String(req.body?.password||'');
      if(!name||!/^[a-z][a-z0-9_]{3,19}$/.test(username)||password.length<6)return res.status(400).json({error:'Проверьте имя, юзернейм и пароль'});
      if(await getDoc('usernames',username))return res.status(409).json({error:'Юзернейм занят'});
      const id=reqId(),t=now(),salt=crypto.randomBytes(8).toString('hex'),passHash=crypto.createHash('sha256').update(salt+password).digest('hex');
      await putDoc('registration_requests',id,{name,username,salt,passHash,status:'pending',expiresAt:t+10*60*1000,createdAt:t});
      res.json({ok:true,id,expiresAt:t+10*60*1000,botUrl:'https://t.me/'+botUsername+'?start=reg_'+id});
    }catch(e){res.status(500).json({error:e.message||'Не удалось создать регистрацию'})}
  });
  app.get('/api/auth/register/status',async(req,res)=>{
    try{
      const id=String(req.query.id||'').trim(),r=await getDoc('registration_requests',id);
      if(!r)return res.status(404).json({error:'Заявка не найдена'});
      if(Number(r.expiresAt||0)<=now()&&r.status==='pending'){await patchDoc('registration_requests',id,{status:'expired'});return res.json({ok:true,status:'expired'})}
      if(r.status!=='approved')return res.json({ok:true,status:r.status,expiresAt:r.expiresAt});
      const uid=String(r.uid||'');const u=await getDoc('users',uid);if(!u)return res.status(404).json({error:'Аккаунт не найден'});
      const token=await createSession(uid,{device:'Регистрация через Telegram',city:r.city||'Не определён',loginMethod:'telegram'});
      await patchDoc('registration_requests',id,{status:'consumed',consumedAt:now()});setSessionCookie(res,token);
      res.json({ok:true,status:'registered',id:uid});
    }catch(e){res.status(500).json({error:e.message||'Ошибка регистрации'})}
  });
  app.post('/api/telegram/registration-hook',async(req,res)=>{
    if(req.get('x-ekool-registration-hook')!=='1')return res.sendStatus(401);
    res.sendStatus(200);
  });
  app._ekooolRegistrationHandler=async(msg)=>{
    const text=String(msg?.text||'').trim(),m=text.match(/^\\/start\\s+reg_([A-Za-z0-9_-]{20,100})$/);
    if(!m)return false;
    const id=m[1],r=await getDoc('registration_requests',id);
    if(!r||r.status!=='pending'||Number(r.expiresAt||0)<=now())return true;
    const chatId=String(msg.chat?.id||msg.from?.id||'');if(!chatId)return true;
    const username=String(msg.from?.username||'').trim();
    await putDoc('users','__pending__'+id,{});
    const userId='EK-'+Array.from({length:8},()=> 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(0,32)]).join('');
    const user={name:r.name,photo:'',bio:'',verified:false,purchased:false,coins:1000,username:r.username,extra:[],salt:r.salt,passHash:r.passHash,lastSeen:now(),ts:now(),telegramChatId:chatId,telegramUsername:username};
    await putDoc('users',userId,user);await putDoc('usernames',r.username,{uid:userId});
    await patchDoc('registration_requests',id,{status:'approved',uid:userId,telegramChatId:chatId,telegramUsername:username,approvedAt:now(),city:'Telegram'});
    if(sendTelegramBotMessage)await sendTelegramBotMessage(telegramBotToken,chatId,'✅ Регистрация EKOOOL подтверждена!\\n\\n👤 @'+r.username+' создан. Вернитесь в EKOOOL — вход завершится автоматически.');
    return true;
  };
};