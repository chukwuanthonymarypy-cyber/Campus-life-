// Optional password accounts on top of Supabase Auth, using a server-only
// username lookup. Resend sends verification/reset links; no email-code signup.
const crypto=require('node:crypto');
const net=require('node:net');
const project=(process.env.CAMPUS_SUPABASE_URL||'').trim().replace(/\/$/,'');
const secret=process.env.CAMPUS_SUPABASE_SECRET_KEY||process.env.CAMPUS_SUPABASE_SERVICE_ROLE_KEY||'';
const ready=!!(project&&secret&&/^https:\/\/[a-z0-9.-]+\.supabase\.co$/i.test(project));
const gameUrl=(process.env.CAMPUS_PUBLIC_GAME_URL||'').trim().replace(/\/$/,'');
const resendKey=process.env.CAMPUS_RESEND_API_KEY||'';
const resendFrom=process.env.CAMPUS_RESEND_FROM||'';
const mailReady=!!(gameUrl&&/^https:\/\/[^\s/#?]+$/i.test(gameUrl)&&resendKey&&resendFrom);
const allowed=(process.env.CAMPUS_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
const attempts=new Map();setInterval(()=>{for(const [k,v] of attempts)if(v.until<Date.now())attempts.delete(k)},600000).unref();
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const isName=x=>typeof x==='string'&&/^[a-z][a-z0-9_]{2,19}$/.test(x.toLowerCase());
const isPassword=x=>typeof x==='string'&&x.length>=12&&x.length<=128;
const isEmail=x=>typeof x==='string'&&x.length<=254&&/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x);
function send(res,status,body){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}).end(JSON.stringify(body))}
function guard(req,res){const origin=req.headers.origin;if(!origin)return true;const own=`${req.headers['x-forwarded-proto']==='https'?'https':'http'}://${req.headers.host}`;
 if(origin!==own&&!allowed.includes(origin)){send(res,403,{error:'This game website is not allowed to use the account service.'});return false}
 res.setHeader('access-control-allow-origin',origin);res.setHeader('access-control-allow-methods','GET, POST, OPTIONS');res.setHeader('access-control-allow-headers','Authorization, Content-Type');res.setHeader('vary','Origin');return true}
function limit(req,scope,n,windowMs){
 // Render's edge supplies CF-Connecting-IP. Never trust a caller-supplied
 // forwarding header when running outside that managed proxy.
 const edgeIp=process.env.RENDER==='true'?String(req.headers['cf-connecting-ip']||'').trim():'';
 const address=net.isIP(edgeIp)?edgeIp:String(req.socket.remoteAddress||'unknown');
 const key=address+':'+scope,now=Date.now();let row=attempts.get(key);
 if(!row||row.until<now)row={count:0,until:now+windowMs};row.count++;
 attempts.set(key,row);return row.count<=n;
}
async function readBody(req){let length=0,text='';for await(const chunk of req){length+=chunk.length;if(length>8192)throw Error('Request is too large');text+=chunk.toString('utf8')}let data;try{data=JSON.parse(text)}catch{throw Error('Invalid JSON')}if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Invalid input');return data}
async function supa(path,method='GET',data,token){if(!ready)throw Error('Account server is not configured on Render');const headers={apikey:secret,...(secret.startsWith('sb_secret_')?{}:{Authorization:`Bearer ${secret}`})};if(token)headers.Authorization=`Bearer ${token}`;if(data!==undefined){headers['content-type']='application/json';if(path.startsWith('/rest/v1/'))headers.Prefer='return=minimal'}
 const response=await fetch(project+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(14000)});const text=await response.text();let result;try{result=text?JSON.parse(text):null}catch{result={message:text.slice(0,200)}}
 if(!response.ok){const err=new Error('Supabase account request failed');err.status=response.status;err.detail=String(result?.msg||result?.message||result?.error_description||'').slice(0,130);throw err}return result}
async function rowForName(username){const list=await supa(`/rest/v1/campus_usernames?select=*&username=eq.${encodeURIComponent(username)}&limit=1`);return list?.[0]||null}
async function rowForUser(id){const list=await supa(`/rest/v1/campus_usernames?select=*&user_id=eq.${encodeURIComponent(id)}&limit=1`);return list?.[0]||null}
async function patch(username,fields){return supa(`/rest/v1/campus_usernames?username=eq.${encodeURIComponent(username)}`,'PATCH',fields)}
async function getUser(token){if(typeof token!=='string'||token.length>4096)throw Error('Sign in first');const u=await supa('/auth/v1/user','GET',undefined,token);if(!/^[0-9a-f-]{36}$/i.test(u?.id||''))throw Error('Sign in first');return u}
function tokenMatch(provided,stored,expires){if(typeof provided!=='string'||!/^[0-9a-f]{64}$/.test(provided)||!stored||!expires||Date.parse(expires)<Date.now())return false;const a=Buffer.from(hash(provided),'hex'),b=Buffer.from(stored,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)}
async function sendLink(to,kind,username,token){if(!mailReady)throw Error('Recovery email sender is not configured');const url=new URL(gameUrl);url.searchParams.set(kind==='verify'?'verifyRecovery':'resetPassword',username);url.searchParams.set('token',token);const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${resendKey}`,'content-type':'application/json'},body:JSON.stringify({from:resendFrom,to:[to],subject:kind==='verify'?'Confirm your Campus Life recovery email':'Reset your Campus Life password',text:`Open this link to ${kind==='verify'?'confirm your optional recovery email':'set a new password'}: ${url.toString()}\n\nThis link expires in 20 minutes. If you did not request it, ignore this message.`}),signal:AbortSignal.timeout(14000)});if(!response.ok)throw Error('Email provider could not send the link')}
async function beginVerification(row,email){const token=crypto.randomBytes(32).toString('hex');await patch(row.username,{recovery_pending_email:email,verify_token_hash:hash(token),verify_expires_at:new Date(Date.now()+20*60000).toISOString()});await sendLink(email,'verify',row.username,token)}
async function handle(req,res){if(!guard(req,res))return;const pathname=new URL(req.url,'http://localhost').pathname;if(req.method==='OPTIONS')return res.writeHead(204).end();if(!ready)return send(res,503,{error:'Password accounts need Supabase setup on Render. Guest play is still available.'});
 const scope=pathname.split('/').pop();if(!limit(req,scope,scope==='login'?15:scope==='register'?6:scope==='recover'?5:20,scope==='register'||scope==='recover'?3600000:900000))return send(res,429,{error:'Too many requests. Try again later.'});
 let body={};try{if(req.method==='POST')body=await readBody(req);else if(req.method!=='GET')return send(res,405,{error:'Method not allowed'});
 const username=typeof body.username==='string'?body.username.toLowerCase():'';
 if(pathname==='/api/accounts/register'&&req.method==='POST'){
   if(!isName(username)||!isPassword(body.password))return send(res,400,{error:'Use a 3–20 character username (letters, numbers, _) and a password of at least 12 characters.'});
   if(body.recoveryEmail&&!isEmail(body.recoveryEmail))return send(res,400,{error:'Enter a valid optional recovery email.'});
   if(await rowForName(username))return send(res,409,{error:'That username is taken.'});
   const credentialEmail=`game-${crypto.randomUUID()}@accounts.campus-life.invalid`;
   const created=await supa('/auth/v1/admin/users','POST',{email:credentialEmail,password:body.password,email_confirm:true});const authUser=created?.user||created;
   if(!/^[0-9a-f-]{36}$/i.test(authUser?.id||''))throw Error('Could not create the account');
   try{await supa('/rest/v1/campus_usernames','POST',{username,user_id:authUser.id,credential_email:credentialEmail})}catch(e){await supa('/auth/v1/admin/users/'+authUser.id,'DELETE').catch(()=>{});if(e.status===409)return send(res,409,{error:'That username is taken.'});throw e}
   let recovery='not-set';if(body.recoveryEmail){try{await beginVerification({username},body.recoveryEmail.trim().toLowerCase());recovery='verification-sent'}catch(e){console.warn('Recovery verification not sent:',e.message);recovery='unavailable'}}
   const session=await supa('/auth/v1/token?grant_type=password','POST',{email:credentialEmail,password:body.password});return send(res,201,{username,session,recovery});
 }
 if(pathname==='/api/accounts/login'&&req.method==='POST'){
   if(!isName(username)||typeof body.password!=='string')return send(res,401,{error:'Invalid username or password.'});const row=await rowForName(username);if(!row)return send(res,401,{error:'Invalid username or password.'});
   try{const session=await supa('/auth/v1/token?grant_type=password','POST',{email:row.credential_email,password:body.password});return send(res,200,{username,session})}catch{return send(res,401,{error:'Invalid username or password.'})}
 }
 if(pathname==='/api/accounts/convert'&&req.method==='POST'){
   if(!isName(username)||!isPassword(body.password))return send(res,400,{error:'Choose a username and password of at least 12 characters.'});
   const token=String(req.headers.authorization||'').replace(/^Bearer /i,'');const old=await getUser(token);if(await rowForUser(old.id))return send(res,409,{error:'This account already has a username.'});if(await rowForName(username))return send(res,409,{error:'That username is taken.'});
   await supa('/rest/v1/campus_usernames','POST',{username,user_id:old.id,credential_email:old.email,recovery_email:old.email,recovery_verified_at:new Date().toISOString()});
   try{await supa('/auth/v1/admin/users/'+old.id,'PUT',{password:body.password})}catch(e){await supa(`/rest/v1/campus_usernames?username=eq.${encodeURIComponent(username)}`,'DELETE').catch(()=>{});throw e}
   return send(res,200,{username,recovery:'verified',message:'Your existing cloud save is now linked to this username.'});
 }
 if(pathname==='/api/accounts/me'&&req.method==='GET'){
   const token=String(req.headers.authorization||'').replace(/^Bearer /i,'');const user=await getUser(token),row=await rowForUser(user.id);return send(res,200,{username:row?.username||null,recovery:row?.recovery_verified_at?(row.recovery_pending_email?'verified-change-pending':'verified'):row?.recovery_pending_email?'pending':'not-set',recoveryEmail:row?.recovery_verified_at?row.recovery_email:null,canConvert:!row});
 }
 if(pathname==='/api/accounts/recovery/email'&&req.method==='POST'){
   if(!isEmail(body.email))return send(res,400,{error:'Enter a valid email address.'});const token=String(req.headers.authorization||'').replace(/^Bearer /i,''),user=await getUser(token),row=await rowForUser(user.id);if(!row)return send(res,403,{error:'Convert your old account first.'});
   await beginVerification(row,body.email.trim().toLowerCase());return send(res,200,{message:'Check your email for a confirmation link.'});
 }
 if(pathname==='/api/accounts/recovery/confirm'&&req.method==='POST'){
   const row=await rowForName(username);if(!row?.recovery_pending_email||!tokenMatch(body.token,row.verify_token_hash,row.verify_expires_at))return send(res,400,{error:'This email confirmation link is invalid or expired.'});
   await patch(username,{recovery_email:row.recovery_pending_email,recovery_verified_at:new Date().toISOString(),recovery_pending_email:null,verify_token_hash:null,verify_expires_at:null});return send(res,200,{message:'Recovery email confirmed.'});
 }
 if(pathname==='/api/accounts/recovery/recover'&&req.method==='POST'){
   const row=isName(username)?await rowForName(username):null;if(row?.recovery_verified_at&&row.recovery_email){try{const token=crypto.randomBytes(32).toString('hex');await patch(username,{reset_token_hash:hash(token),reset_expires_at:new Date(Date.now()+20*60000).toISOString()});await sendLink(row.recovery_email,'reset',username,token)}catch(e){console.warn('Recovery link not sent:',e.message)}}return send(res,200,{message:'If this username has a verified recovery email, a reset link has been sent.'});
 }
 if(pathname==='/api/accounts/recovery/reset'&&req.method==='POST'){
   if(!isPassword(body.password))return send(res,400,{error:'Your new password must be at least 12 characters.'});const row=await rowForName(username);if(!row||!tokenMatch(body.token,row.reset_token_hash,row.reset_expires_at))return send(res,400,{error:'This reset link is invalid or expired.'});
   await supa('/auth/v1/admin/users/'+row.user_id,'PUT',{password:body.password});await patch(username,{reset_token_hash:null,reset_expires_at:null});return send(res,200,{message:'Password updated. Sign in with your username.'});
 }
 return send(res,404,{error:'Account action not found'});
 }catch(e){console.warn('Account API:',scope,e.status||'',e.detail||e.message);return send(res,e.message==='Recovery email sender is not configured'?503:e.message==='Sign in first'||e.status===401?401:500,{error:e.message==='Recovery email sender is not configured'?'Email recovery is not configured on Render yet.':e.message==='Sign in first'?'Sign in first.':'Account service could not complete this request. Try again.'})}}
module.exports={handle,ready,mailReady};
