// Cloudflare Pages Function: /api/live/:id  (D1 binding name: DB)
// স্কোর শেয়ার + স্কোরার পিন + দর্শকের রিয়্যাকশন/চ্যাট/গণনা/ভবিষ্যদ্বাণী: সবই এই একটা ফাইলে।
const J=(o,st=200)=>new Response(JSON.stringify(o),{status:st,headers:{'content-type':'application/json;charset=utf-8','cache-control':'no-store'}});
const OK=/^[a-z0-9]{6,24}$/;
const VID=/^[a-z0-9]{6,24}$/;
const EM=['🔥','👏','😍','😱','🎉','🏏'];
const WIN=300000; // পিন ভুল ৫ বার হলে ৫ মিনিট বন্ধ
let ready=false;
// স্কোরার মোড: সাইটের মূল ম্যাচের আইডি। এতে লিখতে হলে পাসওয়ার্ড লাগে (হ্যাশ হিসেবে রাখা, আসল পাসওয়ার্ড কোডে নেই)।
const SITE='bbbmain';
const SPH='03c4d693e3306376328ed16700cb8e87aca1671d187ffbe16db5ebd95915d2e5';
async function checkPass(DB,request){ // 1 = ঠিক, 0 = ভুল, -1 = অনেকবার ভুল করে সাময়িক বন্ধ
  const pw=request.headers.get('x-pass')||'';
  if(pw.length>200)return 0;
  if(pw&&await sha('bbb-scorer:'+pw)===SPH){
    try{await DB.prepare("DELETE FROM lkv WHERE k='pf'").run()}catch(e){}
    return 1;
  }
  const now=Date.now();
  const r=await DB.prepare("SELECT v FROM lkv WHERE k='pf'").first();
  let n=0,t=0;if(r){const a=r.v.split(':');n=+a[0]||0;t=+a[1]||0}
  if(n>=8&&now-t<300000)return -1;
  n=now-t>=300000?1:n+1;
  await DB.prepare("INSERT OR REPLACE INTO lkv(k,v) VALUES('pf',?)").bind(n+':'+now).run();
  return 0;
}
async function sha(x){
  const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x));
  return [...new Uint8Array(b)].map(v=>v.toString(16).padStart(2,'0')).join('');
}
async function init(DB){
  await DB.batch([
    DB.prepare('CREATE TABLE IF NOT EXISTS live (id TEXT PRIMARY KEY, k TEXT NOT NULL, s TEXT NOT NULL, t INTEGER NOT NULL)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS lreact (id TEXT NOT NULL, e TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(id,e))'),
    DB.prepare('CREATE TABLE IF NOT EXISTS lchat (c INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, t INTEGER NOT NULL, v TEXT, nm TEXT, m TEXT)'),
    DB.prepare('CREATE INDEX IF NOT EXISTS lchat_id ON lchat(id,c)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS lview (id TEXT NOT NULL, v TEXT NOT NULL, t INTEGER NOT NULL, PRIMARY KEY(id,v))'),
    DB.prepare('CREATE TABLE IF NOT EXISTS lpred (id TEXT NOT NULL, m TEXT NOT NULL, v TEXT NOT NULL, nm TEXT, p TEXT NOT NULL, ph INTEGER NOT NULL, t INTEGER NOT NULL, PRIMARY KEY(id,m,v))'),
    DB.prepare('CREATE TABLE IF NOT EXISTS lpush (id TEXT NOT NULL, ep TEXT NOT NULL, p TEXT NOT NULL, a TEXT NOT NULL, f INTEGER NOT NULL DEFAULT 7, t INTEGER NOT NULL, PRIMARY KEY(id,ep))'),
    DB.prepare('CREATE TABLE IF NOT EXISTS lkv (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
  ]);
  // পুরোনো ডেটাবেসে নতুন কলাম যোগ (থাকলে ভুলটা চুপচাপ এড়িয়ে যায়)
  for(const col of ['p TEXT','w TEXT','f INTEGER DEFAULT 0','ft INTEGER DEFAULT 0','pe TEXT']){
    try{await DB.prepare('ALTER TABLE live ADD COLUMN '+col).run()}catch(e){}
  }
  ready=true;
}
// কে লিখছে? 'key' = মালিক, 'pin' = পিন দিয়ে আসা স্কোরার, 'locked' = অনেকবার ভুল, null = অননুমোদিত
async function who(DB,id,request,row){
  if(!row)return null;
  if(id===SITE){const c=await checkPass(DB,request);return c===1?'key':c===-1?'locked':null}
  const key=request.headers.get('x-key')||'',pin=request.headers.get('x-pin')||'';
  if(key.length>=16&&row.k===await sha(key))return 'key';
  if(pin&&row.p){
    const now=Date.now();
    if((row.f||0)>=5&&now-(row.ft||0)<WIN)return 'locked';
    if(row.p===await sha(id+':'+pin)){
      if(row.f)await DB.prepare('UPDATE live SET f=0 WHERE id=?').bind(id).run();
      return 'pin';
    }
    await DB.prepare('UPDATE live SET f=CASE WHEN ft<? THEN 1 ELSE COALESCE(f,0)+1 END, ft=? WHERE id=?').bind(now-WIN,now,id).run();
  }
  return null;
}
// ভবিষ্যদ্বাণীর ধাপ: 0 = প্রথম বলের আগে, 1 = প্রথম ইনিংস, 2 = দ্বিতীয় ইনিংসের শুরু, -1 = বন্ধ
const PH=s=>{
  if(s.so||(s.sm&&s.sm.length))return -1;
  const i0=(s.inns&&s.inns[0])||[],i1=(s.inns&&s.inns[1])||[];
  if(s.cur!==1)return i0.length?1:0;
  const r0=i0.reduce((a,b)=>a+(b.r||0),0),r1=i1.reduce((a,b)=>a+(b.r||0),0);
  if(r1>r0||i1.filter(b=>b.w).length>=10)return -1;
  return i1.filter(b=>b.l).length<Math.max(6,Math.floor((s.ov||5)*6/3))?2:-1;
};

/* ---------- ওয়েব পুশ নোটিফিকেশন (VAPID + aes128gcm, বাইরের লাইব্রেরি ছাড়া) ---------- */
const PUSH_OK=/^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|mozilla\.com|mozaws\.net|push\.apple\.com|windows\.com)\//i;
const MAXSUB=40; // ফ্রি প্ল্যানে এক রিকোয়েস্টে ৫০টা বাইরের কল চলে, তাই প্রতি ম্যাচে সর্বোচ্চ ৪০ জন
const TE=new TextEncoder();
const b64u=u=>btoa(String.fromCharCode(...u)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64u=s=>{s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u};
const cat=(...a)=>{const o=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let k=0;for(const x of a){o.set(x,k);k+=x.length}return o};
let VAP=null;const JWTC={};
async function vapid(DB){
  if(VAP)return VAP;
  let row=await DB.prepare("SELECT v FROM lkv WHERE k='vapid'").first();
  if(!row){
    const kp=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
    const j=await crypto.subtle.exportKey('jwk',kp.privateKey);
    await DB.prepare("INSERT OR IGNORE INTO lkv(k,v) VALUES('vapid',?)").bind(JSON.stringify({kty:j.kty,crv:j.crv,x:j.x,y:j.y,d:j.d})).run();
    row=await DB.prepare("SELECT v FROM lkv WHERE k='vapid'").first();
  }
  const j=JSON.parse(row.v);
  const key=await crypto.subtle.importKey('jwk',j,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const pub=new Uint8Array(65);pub[0]=4;pub.set(unb64u(j.x),1);pub.set(unb64u(j.y),33);
  return VAP={key,pub:b64u(pub)};
}
async function vjwt(DB,aud,host){
  const c=JWTC[aud];if(c&&c.e>Date.now()+600000)return c.t;
  const v=await vapid(DB),exp=Math.floor(Date.now()/1000)+43200;
  const h=b64u(TE.encode(JSON.stringify({typ:'JWT',alg:'ES256'}))),p=b64u(TE.encode(JSON.stringify({aud,exp,sub:'mailto:admin@'+host})));
  const sg=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},v.key,TE.encode(h+'.'+p));
  const t=h+'.'+p+'.'+b64u(new Uint8Array(sg));
  JWTC[aud]={t,e:exp*1000};return t;
}
async function hkdf(salt,ikm,info,len){
  const k=await crypto.subtle.importKey('raw',ikm,'HKDF',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},k,len*8));
}
async function encPush(sub,text){
  const ua=unb64u(sub.p),au=unb64u(sub.a);
  const uaKey=await crypto.subtle.importKey('raw',ua,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const eph=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const asPub=new Uint8Array(await crypto.subtle.exportKey('raw',eph.publicKey));
  const secret=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:uaKey},eph.privateKey,256));
  const ikm=await hkdf(au,secret,cat(TE.encode('WebPush: info\0'),ua,asPub),32);
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const cek=await hkdf(salt,ikm,TE.encode('Content-Encoding: aes128gcm\0'),16);
  const nonce=await hkdf(salt,ikm,TE.encode('Content-Encoding: nonce\0'),12);
  const aes=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['encrypt']);
  const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},aes,cat(TE.encode(text),new Uint8Array([2]))));
  const hd=new Uint8Array(21);hd.set(salt,0);new DataView(hd.buffer).setUint32(16,4096);hd[20]=65;
  return cat(hd,asPub,ct);
}
async function sendOne(DB,id,sub,payload,host){
  try{
    const aud=new URL(sub.ep).origin,t=await vjwt(DB,aud,host),v=await vapid(DB);
    const c=new AbortController(),to=setTimeout(()=>c.abort(),8000);
    const r=await fetch(sub.ep,{method:'POST',signal:c.signal,headers:{Authorization:'vapid t='+t+', k='+v.pub,'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream',TTL:'300',Urgency:'high'},body:await encPush(sub,JSON.stringify(payload))});
    clearTimeout(to);
    if(r.status===404||r.status===410)await DB.prepare('DELETE FROM lpush WHERE id=? AND ep=?').bind(id,sub.ep).run();
    return r.status;
  }catch(e){return 0}
}
const EVF={w:1,b:2,m:4};
async function notify(DB,id,evIn,host){
  try{
    const evs=(Array.isArray(evIn)?evIn:[]).slice(-3).map(e=>({k:String(e&&e.k||''),t:String(e&&e.t||'').slice(0,80),b:String(e&&e.b||'').slice(0,180),g:String(e&&e.g||'').replace(/[^A-Za-z0-9:_-]/g,'').slice(0,60)})).filter(e=>EVF[e.k]&&e.g);
    if(!evs.length)return;
    const row=await DB.prepare('SELECT pe FROM live WHERE id=?').bind(id).first();
    if(!row)return;
    const seen=(row.pe||'').split('|').filter(Boolean);
    const fresh=evs.filter(e=>!seen.includes(e.g));
    if(!fresh.length)return;
    await DB.prepare('UPDATE live SET pe=? WHERE id=?').bind(seen.concat(fresh.map(e=>e.g)).slice(-12).join('|'),id).run();
    const subs=(await DB.prepare('SELECT ep,p,a,f FROM lpush WHERE id=? LIMIT ?').bind(id,MAXSUB).all()).results||[];
    if(!subs.length)return;
    await Promise.allSettled(subs.map(s=>{
      let pick=null;for(const e of fresh)if(s.f&EVF[e.k])pick=e;
      if(!pick)return null;
      return sendOne(DB,id,s,{t:pick.t,b:pick.b,u:'/?watch='+id,g:'bbb-'+id},host);
    }));
  }catch(e){}
}
const getRow=(DB,id)=>DB.prepare('SELECT k,p,w,f,ft,s,t FROM live WHERE id=?').bind(id).first();

export async function onRequest({request,env,params,waitUntil}){
  const id=String(params.id||'');
  if(!OK.test(id))return J({error:'bad id'},400);
  const DB=env.DB;
  if(!DB)return J({error:'D1 binding DB is missing'},500);
  if(!ready)await init(DB);
  const url=new URL(request.url),q=url.searchParams,m=request.method;

  /* ---------- দেখা (দর্শক ও স্কোরার দুজনেই) ---------- */
  if(m==='GET'&&q.get('op')==='vapid'){const v=await vapid(DB);return J({k:v.pub})}
  if(m==='GET'){
    const since=Number(q.get('since')||0),v=q.get('v')||'',now=Date.now();
    // নিজেকে গুনতে আগে হার্টবিট লিখে নিই
    const hbOn=q.get('hb')==='1'&&VID.test(v);
    const pm=q.get('pm')||'',hasPm=VID.test(pm),okV=VID.test(v);
    const stm=[
      DB.prepare('SELECT t,p IS NOT NULL AS hp FROM live WHERE id=?').bind(id),
      DB.prepare('SELECT e,n FROM lreact WHERE id=?').bind(id),
      DB.prepare('SELECT COALESCE(MAX(c),0) AS mx, COUNT(*) AS n FROM lchat WHERE id=?').bind(id),
      DB.prepare('SELECT COUNT(*) AS n FROM lview WHERE id=? AND t>?').bind(id,now-45000)
    ];
    let iPr=-1,iMe=-1,iPl=-1;
    if(hasPm){
      iPr=stm.length;stm.push(DB.prepare('SELECT p,COUNT(*) AS n FROM lpred WHERE id=? AND m=? GROUP BY p').bind(id,pm));
      if(okV){iMe=stm.length;stm.push(DB.prepare('SELECT p,ph FROM lpred WHERE id=? AND m=? AND v=?').bind(id,pm,v))}
      if(q.get('pl')==='1'){iPl=stm.length;stm.push(DB.prepare('SELECT nm,p,ph,t,(v=?) AS me FROM lpred WHERE id=? AND m=? ORDER BY t LIMIT 300').bind(okV?v:'',id,pm))}
    }
    // এক ডিবি-যাত্রায়: হার্টবিট লেখা + সব পড়া + (বদলালে) স্কোর। আলাদা আলাদা অপেক্ষা নেই।
    const iS=stm.length;stm.push(DB.prepare('SELECT s FROM live WHERE id=? AND t>?').bind(id,since));
    if(hbOn)stm.unshift(DB.prepare('INSERT INTO lview(id,v,t) VALUES(?,?,?) ON CONFLICT(id,v) DO UPDATE SET t=excluded.t').bind(id,v,now));
    let rs=await DB.batch(stm);
    if(hbOn)rs=rs.slice(1);
    const meta=rs[0].results&&rs[0].results[0];
    if(!meta)return J({found:false});
    const react={};for(const r of rs[1].results||[])react[r.e]=r.n;
    const cm=rs[2].results[0],ck=cm.mx+':'+cm.n;
    const x={views:rs[3].results[0].n,react,ck};
    if(iPr>=0){
      const pr={};for(const r of rs[iPr].results||[])pr[r.p]=r.n;
      x.pm=pm;x.pr=pr;
      if(iMe>=0)x.me=(rs[iMe].results||[])[0]||null;
      if(iPl>=0)x.pl=(rs[iPl].results||[]).map(r=>({nm:r.nm,p:r.p,ph:r.ph,t:r.t,me:r.me?1:0}));
    }
    if(q.get('ck')!==ck){
      const cr=await DB.prepare('SELECT c,t,nm,m FROM lchat WHERE id=? ORDER BY c DESC LIMIT 30').bind(id).all();
      x.chat=(cr.results||[]).reverse();
    }
    const base={found:true,t:meta.t,pin:!!meta.hp,x};
    if(since&&meta.t<=since)return J({...base,same:true});
    const sr=(rs[iS].results||[])[0];
    return J({...base,s:sr?sr.s:''});
  }

  /* ---------- স্কোর পাঠানো ---------- */
  if(m==='PUT'){
    const key=request.headers.get('x-key')||'';
    const body=await request.text();
    if(body.length>200000)return J({error:'too big'},413);
    let s=null,evIn=null;
    try{const o=JSON.parse(body);if(typeof o.s==='string')s=o.s;if(Array.isArray(o.ev))evIn=o.ev}catch(e){}
    if(!s)return J({error:'bad body'},400);
    const dev=(request.headers.get('x-dev')||'').slice(0,40),take=request.headers.get('x-take')==='1',now=Date.now();
    const row=await getRow(DB,id);
    if(id===SITE){const c=await checkPass(DB,request);if(c===-1)return J({error:'locked'},429);if(c!==1)return J({error:'forbidden'},403)}
    if(!row){
      if(key.length<16)return J({error:'key'},401);
    }else{
      const w=await who(DB,id,request,row);
      if(w==='locked')return J({error:'locked'},429);
      if(!w)return J({error:'forbidden'},403);
      // অন্য ডিভাইস স্কোর দিচ্ছে: নিয়ে নেওয়ার স্পষ্ট অনুমতি ছাড়া ওভাররাইট নয়
      if(dev&&row.w&&row.w!==dev&&!take)return J({error:'other',t:row.t},409);
    }
    const kh=row?row.k:await sha(key);
    await DB.prepare('INSERT INTO live(id,k,s,t,w) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET s=excluded.s,t=excluded.t,w=excluded.w').bind(id,kh,s,now,dev||null).run();
    if(evIn&&evIn.length&&waitUntil)waitUntil(notify(DB,id,evIn,url.hostname));
    if(Math.random()<0.05){
      const old=now-3*86400000;
      await DB.batch([
        DB.prepare('DELETE FROM live WHERE t<?').bind(old),
        DB.prepare('DELETE FROM lchat WHERE id NOT IN (SELECT id FROM live)'),
        DB.prepare('DELETE FROM lreact WHERE id NOT IN (SELECT id FROM live)'),
        DB.prepare('DELETE FROM lview WHERE t<?').bind(now-3600000),
        DB.prepare('DELETE FROM lpred WHERE id NOT IN (SELECT id FROM live)'),
        DB.prepare('DELETE FROM lpush WHERE id NOT IN (SELECT id FROM live)')
      ]);
    }
    return J({ok:true,t:now});
  }

  /* ---------- বাকি কাজ: POST ?op=... ---------- */
  if(m==='POST'){
    const op=q.get('op')||'';
    let b={};
    try{b=JSON.parse(await request.text()||'{}')}catch(e){}
    if(op==='scorer'){ // স্কোরার পাসওয়ার্ড যাচাই
      if(id!==SITE)return J({error:'bad id'},400);
      const c=await checkPass(DB,request);
      return c===1?J({ok:true}):c===-1?J({error:'locked'},429):J({error:'wrong'},403);
    }
    const row=await getRow(DB,id);
    if(!row)return J({error:'not found'},404);

    if(op==='react'){
      const e=String(b.e||'');
      if(!EM.includes(e))return J({error:'bad emoji'},400);
      await DB.prepare('INSERT INTO lreact(id,e,n) VALUES(?,?,1) ON CONFLICT(id,e) DO UPDATE SET n=n+1').bind(id,e).run();
      return J({ok:true});
    }
    if(op==='chat'){
      let on=true;try{on=!JSON.parse(row.s).nochat}catch(e){}
      if(!on)return J({error:'chat off'},403);
      const nm=String(b.n||'').trim().slice(0,16),msg=String(b.m||'').trim().slice(0,140),v=String(b.v||'').slice(0,24),now=Date.now();
      if(!nm||!msg)return J({error:'empty'},400);
      const last=await DB.prepare('SELECT t FROM lchat WHERE id=? AND v=? ORDER BY c DESC LIMIT 1').bind(id,v).first();
      if(last&&now-last.t<3000)return J({error:'slow'},429);
      await DB.batch([
        DB.prepare('INSERT INTO lchat(id,t,v,nm,m) VALUES(?,?,?,?,?)').bind(id,now,v,nm,msg),
        DB.prepare('DELETE FROM lchat WHERE id=? AND c<=(SELECT c FROM lchat WHERE id=? ORDER BY c DESC LIMIT 1 OFFSET 200)').bind(id,id)
      ]);
      return J({ok:true});
    }

    if(op==='sub'){ // দর্শক নোটিফিকেশন চালু/বদল: f = ১ উইকেট, ২ চার-ছক্কা, ৪ ম্যাচ শুরু-শেষ
      const ep=String(b.ep||''),p=String(b.p||''),a=String(b.a||''),f=(Number(b.f)|0)&7;
      if(!PUSH_OK.test(ep)||ep.length>700||!/^[A-Za-z0-9_-]{80,100}$/.test(p)||!/^[A-Za-z0-9_-]{16,30}$/.test(a)||!f)return J({error:'bad'},400);
      const ex=await DB.prepare('SELECT 1 AS x FROM lpush WHERE id=? AND ep=?').bind(id,ep).first();
      if(!ex){const c=await DB.prepare('SELECT COUNT(*) AS n FROM lpush WHERE id=?').bind(id).first();if(c&&c.n>=MAXSUB)return J({error:'full'},429)}
      await DB.prepare('INSERT INTO lpush(id,ep,p,a,f,t) VALUES(?,?,?,?,?,?) ON CONFLICT(id,ep) DO UPDATE SET p=excluded.p,a=excluded.a,f=excluded.f,t=excluded.t').bind(id,ep,p,a,f,Date.now()).run();
      return J({ok:true});
    }
    if(op==='unsub'){
      await DB.prepare('DELETE FROM lpush WHERE id=? AND ep=?').bind(id,String(b.ep||'')).run();
      return J({ok:true});
    }
    if(op==='test'){
      const sub=await DB.prepare('SELECT ep,p,a,f FROM lpush WHERE id=? AND ep=?').bind(id,String(b.ep||'')).first();
      if(!sub)return J({error:'not subscribed'},404);
      const st=await sendOne(DB,id,sub,{t:'🔔 বল বাই বল',b:'নোটিফিকেশন ঠিকমতো কাজ করছে ✓',u:'/?watch='+id,g:'bbb-test'},url.hostname);
      return J({ok:st>=200&&st<300,st});
    }

    if(op==='pred'){ // দর্শকের "কে জিতবে?" ভবিষ্যদ্বাণী: প্রতি দর্শক প্রতি ম্যাচে একবার, পরে বদলানো যায় না
      const m=String(b.m||''),v=String(b.v||''),nm=String(b.n||'').trim().slice(0,16),p=String(b.p||'').slice(0,40);
      if(!VID.test(m)||!VID.test(v)||!nm||!p)return J({error:'bad'},400);
      let s;try{s=JSON.parse(row.s)}catch(e){return J({error:'state'},500)}
      const rt=(s.sm&&s.sm[0])||s;
      if(String(rt.mid||s.mid||'').slice(0,24)!==m)return J({error:'stale'},409);
      const ex=await DB.prepare('SELECT p,ph FROM lpred WHERE id=? AND m=? AND v=?').bind(id,m,v).first();
      if(ex)return J({ok:true,dup:true,p:ex.p,ph:ex.ph});
      const ph=PH(s);
      if(ph<0)return J({error:'closed'},409);
      if(p!=='_t'&&p!==s.a&&p!==s.b)return J({error:'bad pick'},400);
      const cnt=await DB.prepare('SELECT COUNT(*) AS n FROM lpred WHERE id=? AND m=?').bind(id,m).first();
      if(cnt&&cnt.n>=500)return J({error:'full'},429);
      await DB.prepare('INSERT OR IGNORE INTO lpred(id,m,v,nm,p,ph,t) VALUES(?,?,?,?,?,?,?)').bind(id,m,v,nm,p,ph,Date.now()).run();
      return J({ok:true,p,ph});
    }

    // নিচের সবগুলোতে অনুমোদন লাগে
    const w=await who(DB,id,request,row);
    if(w==='locked')return J({error:'locked'},429);
    if(op==='join'){ // পিন দিয়ে অন্য ডিভাইসে স্কোরিং চালিয়ে নেওয়া
      if(w!=='pin'&&w!=='key')return J({error:'forbidden'},403);
      return J({ok:true,t:row.t,s:row.s});
    }
    if(!w)return J({error:'forbidden'},403);
    if(op==='pin'){ // শুধু মালিক বা বর্তমান পিনধারী বদলাতে পারে
      const pin=String(b.pin||'');
      if(!/^\d{4,8}$/.test(pin))return J({error:'pin must be 4-8 digits'},400);
      await DB.prepare('UPDATE live SET p=?,f=0,ft=0 WHERE id=?').bind(await sha(id+':'+pin),id).run();
      return J({ok:true});
    }
    if(op==='pinoff'){
      if(w!=='key')return J({error:'owner only'},403);
      await DB.prepare('UPDATE live SET p=NULL,f=0,ft=0 WHERE id=?').bind(id).run();
      return J({ok:true});
    }
    if(op==='del'){
      await DB.prepare('DELETE FROM lchat WHERE id=? AND c=?').bind(id,Number(q.get('c')||0)).run();
      return J({ok:true});
    }
    if(op==='clear'){
      await DB.batch([
        DB.prepare('DELETE FROM lchat WHERE id=?').bind(id),
        DB.prepare('DELETE FROM lreact WHERE id=?').bind(id)
      ]);
      return J({ok:true});
    }
    return J({error:'bad op'},400);
  }
  return J({error:'method'},405);
}
