(()=>{
'use strict';
const $=s=>document.querySelector(s);
const api=async(url,opt={})=>{
  const r=await fetch(url,{credentials:'include',...opt});
  const x=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(x.error||'Ошибка сервера');
  return x;
};
const escx=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function snow(){
  if(document.getElementById('ekoSnow'))return;
  const c=document.createElement('canvas');c.id='ekoSnow';
  Object.assign(c.style,{position:'fixed',inset:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:'0',opacity:.28});
  document.body.prepend(c);const x=c.getContext('2d');let w,h,a=[];
  const resize=()=>{w=c.width=innerWidth*devicePixelRatio;h=c.height=innerHeight*devicePixelRatio;x.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);a=Array.from({length:70},()=>({x:Math.random()*innerWidth,y:Math.random()*innerHeight,r:1+Math.random()*2,v:.25+Math.random()*.8,s:(Math.random()-.5)*.25}))};resize();addEventListener('resize',resize);
  const tick=()=>{x.clearRect(0,0,innerWidth,innerHeight);x.fillStyle='#fff';for(const p of a){p.y+=p.v;p.x+=p.s;if(p.y>innerHeight+5)p.y=-5;if(p.x>innerWidth+5)p.x=-5;if(p.x<-5)p.x=innerWidth+5;x.beginPath();x.arc(p.x,p.y,p.r,0,7);x.fill()}requestAnimationFrame(tick)};tick();
}
function base(title,body,back){
  app.innerHTML='<div style="max-width:430px;margin:7vh auto;padding:24px;position:relative;z-index:2"><div class="glass" style="padding:24px;border-radius:26px"><div style="display:flex;align-items:center;gap:10px;margin-bottom:18px">'+(back?'<button class="ib" id="sxback">←</button>':'')+'<h1 style="margin:0;color:var(--pr);font-size:27px">'+title+'</h1></div>'+body+'</div></div>';
  if(back)$('#sxback').onclick=back;
}
async function deviceLogin(){
  try{
    const q=await api('/api/device/login/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device:navigator.userAgent})});
    base('Вход по QR',`<div class="note">Откройте QR камерой на устройстве, где вы уже вошли в EKOOOL.</div>
      <div id="qr" style="display:flex;justify-content:center;padding:18px;background:#fff;border-radius:18px;margin:14px 0"></div>
      <div style="text-align:center;font-size:30px;font-weight:900;letter-spacing:3px">${escx(q.code)}</div>
      <div class="note" style="text-align:center">Или подтвердите этот код: Настройки → Активные сессии → Вход с помощью кода</div>
      <button class="ib" id="backLogin" style="width:100%;margin-top:12px">← Назад</button>`);
    if(window.QRCode)new QRCode($('#qr'),{text:q.qrUrl,width:210,height:210});
    $('#backLogin').onclick=auth;
    const timer=setInterval(async()=>{
      try{const s=await api('/api/device/login/status?id='+encodeURIComponent(q.id));if(s.status==='logged_in'){clearInterval(timer);location.hash='';location.reload()}else if(s.status==='expired'){clearInterval(timer);alert('Код истёк. Создайте новый вход.');auth()}}catch(e){}
    },1000);
  }catch(e){alert(e.message)}
}
async function approveDevice(id,code){
  try{await api('/api/device/login/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(id?{id}:{code})});toast?.('Вход подтверждён ✓');location.hash='';}catch(e){alert(e.message)}
}
async function register(){
  const nm=$('#sxnm')?.value.trim(),un=($('#sxun')?.value||'').trim().toLowerCase().replace(/^@/,''),pw=$('#sxpw')?.value||'',er=$('#sxer');
  if(!nm)return er.textContent='Введите имя';if(!/^[a-z][a-z0-9_]{3,19}$/.test(un))return er.textContent='Юзернейм: 4–20 символов, английские буквы, цифры и _';if(pw.length<6)return er.textContent='Пароль: минимум 6 символов';
  try{
    const q=await api('/api/auth/register/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:nm,username:un,password:pw})});
    er.textContent='Открываем @BotRegistor…';window.open(q.botUrl,'_blank');
    const t=setInterval(async()=>{try{const s=await api('/api/auth/register/status?id='+encodeURIComponent(q.id));if(s.status==='registered'){clearInterval(t);location.reload()}else if(s.status==='expired'){clearInterval(t);er.textContent='Заявка истекла. Начните регистрацию заново.'}}catch(e){}},1200);
  }catch(e){er.textContent=e.message}
}
window.auth=function(){
  snow();
  base('EKOOOL',`<div class="note" style="text-align:center;margin-bottom:14px">Мессенджер</div>
    <input class="t" id="sxid" placeholder="Юзернейм или номер (+888…)" autocomplete="username">
    <input class="t" id="sxpw" type="password" placeholder="Пароль" autocomplete="current-password">
    <div class="err" id="sxer"></div>
    <button class="pr" id="sxgo" style="width:100%">Войти</button>
    <div style="display:flex;gap:8px;margin-top:10px"><button class="ib" id="sxqr" style="flex:1">▣ QR-код</button><button class="ib" id="sxcode" style="flex:1">123-123 Код</button></div>
    <p style="text-align:center"><a href="#" id="sxreg" style="color:var(--pr)">Регистрация через Telegram</a></p>`);
  $('#sxgo').onclick=async()=>{
    const er=$('#sxer');try{const r=await api('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('#sxid').value.trim(),password:$('#sxpw').value})});
      if(r.user){me={id:r.id,...r.user}}else{const s=await db.doc('users/'+r.id).get();if(!s.exists)throw Error('Аккаунт не найден');me={id:r.id,...s.data()}}
      localStorage.ekid=me.id;try{localStorage.ekproof=JSON.stringify({id:me.id,passHash:me.passHash})}catch(e){};start();
    }catch(e){er.textContent=e.message}
  };
  $('#sxqr').onclick=deviceLogin;$('#sxcode').onclick=()=>codeLogin();$('#sxreg').onclick=e=>{e.preventDefault();regScreen()};
};
function regScreen(){
  base('Регистрация',`<input class="t" id="sxnm" placeholder="Ваше имя"><input class="t" id="sxun" placeholder="@psevdonim"><input class="t" id="sxpw" type="password" placeholder="Пароль от 6 символов"><div class="err" id="sxer"></div><button class="pr" id="sxreggo" style="width:100%">Продолжить через Telegram</button><button class="ib" id="sxback" style="width:100%;margin-top:8px">← Войти</button>`);
  $('#sxreggo').onclick=register;$('#sxback').onclick=auth;
}
async function codeLogin(){
  base('Вход по коду',`<div class="note">На новом устройстве должен быть показан код вида <b>123-123</b>. Введите его здесь, чтобы разрешить вход.</div><input class="t" id="sxcodein" placeholder="123-123" inputmode="numeric" maxlength="7"><div class="err" id="sxer"></div><button class="pr" id="sxapprove" style="width:100%">Подтвердить вход</button>`);
  $('#sxapprove').onclick=async()=>{try{await approveDevice('',($('#sxcodein').value||'').trim())}catch(e){$('#sxer').textContent=e.message}};
}
async function sessions(){
  try{
    const r=await api('/api/device/sessions');
    const rows=(r.sessions||[]).map(s=>`<div class="row" style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,.08)"><div style="flex:1"><b>${s.current?'🟢 ':''}${escx(s.device)}</b><div class="note">${escx(s.city)} · ${escx(s.method)} · ${s.createdAt?new Date(s.createdAt).toLocaleString('ru-RU'):''}</div></div>${s.current?'<span class="note">Текущая</span>':`<button class="ib" data-revoke="${escx(s.id)}">Завершить</button>`}</div>`).join('');
    base('Активные сессии',rows+`<button class="ib" id="sessqr" style="width:100%;margin-top:12px">▣ Вход по QR</button><button class="ib" id="sesscode" style="width:100%;margin-top:8px">123-123 Вход с помощью кода</button><button class="ib" id="sessall" style="width:100%;margin-top:8px">Завершить все остальные</button>`,settings);
    document.querySelectorAll('[data-revoke]').forEach(b=>b.onclick=async()=>{if(confirm('Завершить эту сессию?')){await api('/api/device/sessions/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:b.dataset.revoke})});sessions()}});
    $('#sessqr').onclick=deviceLogin;$('#sesscode').onclick=codeLogin;$('#sessall').onclick=async()=>{await api('/api/device/sessions/revoke-all',{method:'POST'});sessions()};
  }catch(e){alert(e.message)}
}
const oldSettings=window.settings;
window.settings=async function(){
  try{if(typeof clean==='function')clean();if(typeof fresh==='function')await fresh()}catch(e){}
  base('Настройки',`<button class="ib" id="sxsessions" style="width:100%;text-align:left">🔐 Активные сессии</button><button class="ib" id="sxoldsettings" style="width:100%;text-align:left;margin-top:8px">⚙️ Остальные настройки</button>`);
  $('#sxsessions').onclick=sessions;$('#sxoldsettings').onclick=()=>oldSettings?.();
};
function approveHash(){
  const m=location.hash.match(/^#device-approve\/([A-Za-z0-9_-]{20,100})$/);if(!m)return;
  if(window.me){approveDevice(m[1],'')}else{setTimeout(approveHash,800)}
}
snow();setTimeout(()=>{approveHash();if(!window.me&&document.querySelector('#app'))auth()},300);
})();
