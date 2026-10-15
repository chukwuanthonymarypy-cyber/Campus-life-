const crypto=require('node:crypto');
const project=(process.env.CAMPUS_SUPABASE_URL||'').replace(/\/$/,'');
const key=process.env.CAMPUS_SUPABASE_SECRET_KEY||process.env.CAMPUS_SUPABASE_SERVICE_ROLE_KEY||'';
const mediaReady=!!(project&&key&&/^https:\/\/[a-z0-9.-]+\.supabase\.co$/i.test(project));
const publicUrl=(bucket,path,version='')=>`${project}/storage/v1/object/public/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}${version?`?v=${encodeURIComponent(version)}`:''}`;
const dateLagos=()=>{const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Lagos',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const v=Object.fromEntries(parts.map(p=>[p.type,p.value]));return `${v.year}-${v.month}-${v.day}`};
async function request(path,options={}){
  if(!mediaReady)throw Error('Supabase image storage is not configured.');
  const headers={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:`Bearer ${key}`}),...options.headers};
  const r=await fetch(project+path,{...options,headers,signal:AbortSignal.timeout(12000)});
  if(!r.ok){const detail=(await r.text()).slice(0,300);throw Error(`Supabase returned ${r.status}: ${detail}`)}
  if(r.status===204)return null;
  const text=await r.text();return text?JSON.parse(text):null;
}
async function readAds(){
  if(!mediaReady)return [];
  const rows=await request('/rest/v1/campus_ads?select=id,title,link_url,asset_path,board_ids,starts_on,ends_on,created_at&order=created_at.desc&limit=150');
  return rows.map(r=>({id:r.id,title:r.title,linkUrl:r.link_url,imageUrl:publicUrl('campus-ads',r.asset_path),boardIds:r.board_ids,startsOn:r.starts_on,endsOn:r.ends_on,createdAt:r.created_at}));
}
function activeAds(all){const today=dateLagos();return all.filter(a=>a.startsOn<=today&&(a.endsOn==null||today<=a.endsOn))}
async function addAd({title,linkUrl,boardIds,startsOn,endsOn,bytes}){
  const id=crypto.randomUUID(),assetPath=`${id}.jpg`;
  await request(`/storage/v1/object/campus-ads/${assetPath}`,{method:'POST',body:bytes,headers:{'content-type':'image/jpeg','cache-control':'3600'}});
  try{await request('/rest/v1/campus_ads',{method:'POST',body:JSON.stringify({id,title,link_url:linkUrl,board_ids:boardIds,starts_on:startsOn,ends_on:endsOn,asset_path:assetPath}),headers:{'content-type':'application/json',Prefer:'return=minimal'}})}
  catch(e){await request(`/storage/v1/object/campus-ads/${assetPath}`,{method:'DELETE'}).catch(()=>{});throw e}
  return id;
}
async function deleteAd(id){
  const [ad]=await request(`/rest/v1/campus_ads?select=asset_path&id=eq.${encodeURIComponent(id)}`);if(!ad)return false;
  await request(`/rest/v1/campus_ads?id=eq.${encodeURIComponent(id)}`,{method:'DELETE'});
  await request(`/storage/v1/object/campus-ads/${encodeURIComponent(ad.asset_path)}`,{method:'DELETE'}).catch(()=>{});
  return true;
}
async function readProfiles(){
  if(!mediaReady)return [];
  const rows=await request('/rest/v1/campus_avatar_profiles?select=user_id,avatar_path,version&avatar_path=not.is.null&order=updated_at.desc&limit=100');
  return rows.filter(r=>r.avatar_path).map(r=>({id:r.user_id,url:publicUrl('campus-avatars',r.avatar_path,String(r.version))}));
}
async function removeProfile(id){
  if(!/^[0-9a-f-]{36}$/i.test(id||''))return false;
  await request(`/rest/v1/campus_avatar_profiles?user_id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({avatar_path:null,version:Date.now(),updated_at:new Date().toISOString()})});
  await request(`/storage/v1/object/campus-avatars/${encodeURIComponent(id)}/avatar.jpg`,{method:'DELETE'}).catch(()=>{});
  return true;
}
async function readEvents(){if(!mediaReady)return [];const rows=await request('/rest/v1/campus_events?select=id,title,details,starts_at,location_id&order=starts_at.asc&limit=100');return rows.map(r=>({id:r.id,title:r.title,details:r.details,startsAt:r.starts_at,locationId:r.location_id}))}
async function addEvent({title,details,startsAt,locationId}){const id=crypto.randomUUID();await request('/rest/v1/campus_events',{method:'POST',headers:{'content-type':'application/json',Prefer:'return=minimal'},body:JSON.stringify({id,title,details,starts_at:startsAt,location_id:locationId||null})});return id}
async function deleteEvent(id){await request(`/rest/v1/campus_events?id=eq.${encodeURIComponent(id)}`,{method:'DELETE'});return true}
async function readMusic(){if(!mediaReady)return [];const rows=await request('/rest/v1/campus_music?select=id,title,asset_path,location_id,radio&order=created_at.desc&limit=80');return rows.map(r=>({id:r.id,title:r.title,url:publicUrl('campus-music',r.asset_path),locationId:r.location_id,radio:r.radio}))}
async function addMusic({title,locationId,radio,bytes,mime}){const id=crypto.randomUUID(),ext=mime==='audio/ogg'?'ogg':mime==='audio/mp4'?'m4a':'mp3',assetPath=`${id}.${ext}`;await request(`/storage/v1/object/campus-music/${assetPath}`,{method:'POST',body:bytes,headers:{'content-type':mime,'cache-control':'3600'}});try{await request('/rest/v1/campus_music',{method:'POST',body:JSON.stringify({id,title,asset_path:assetPath,location_id:locationId||null,radio:!!radio}),headers:{'content-type':'application/json',Prefer:'return=minimal'}})}catch(e){await request(`/storage/v1/object/campus-music/${assetPath}`,{method:'DELETE'}).catch(()=>{});throw e}return id}
async function deleteMusic(id){const rows=await request(`/rest/v1/campus_music?select=asset_path&id=eq.${encodeURIComponent(id)}`);if(!rows[0])return false;await request(`/rest/v1/campus_music?id=eq.${encodeURIComponent(id)}`,{method:'DELETE'});await request(`/storage/v1/object/campus-music/${encodeURIComponent(rows[0].asset_path)}`,{method:'DELETE'}).catch(()=>{});return true}
async function accountByNumber(number){if(!/^[1-9][0-9]{7}$/.test(String(number)))throw Error('Enter an eight-digit player number');const rows=await request(`/rest/v1/campus_player_numbers?select=user_id,player_number&player_number=eq.${encodeURIComponent(number)}&limit=1`);return rows[0]?.user_id||null}
async function creditAccount(userId,amount){
  if(!/^[0-9a-f-]{36}$/i.test(userId||'')||!Number.isSafeInteger(amount)||amount<1||amount>1000000)throw Error('Invalid account or amount');
  const data=await request('/rest/v1/rpc/campus_admin_credit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_user_id:userId,p_amount:amount})});
  if(!data||!Number.isSafeInteger(Number(data.wallet))||!Number.isSafeInteger(Number(data.revision)))throw Error('The cloud save did not confirm the top-up');
  return {wallet:Number(data.wallet),revision:Number(data.revision)};
}
async function profileForToken(token){
  if(!mediaReady||typeof token!=='string'||token.length>4096)return null;
  const r=await fetch(project+'/auth/v1/user',{headers:{apikey:key,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(9000)});
  if(!r.ok)return null;
  const user=await r.json();if(!/^[0-9a-f-]{36}$/i.test(user?.id||''))return null;
  const rows=await request(`/rest/v1/campus_avatar_profiles?select=avatar_path,version&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
  const row=rows[0];const numbers=await request(`/rest/v1/campus_player_numbers?select=player_number&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);return {id:user.id,playerNumber:String(numbers[0]?.player_number||''),url:row?.avatar_path?publicUrl('campus-avatars',row.avatar_path,String(row.version)):'',hasPicture:!!row?.avatar_path};
}
module.exports={mediaReady,dateLagos,readAds,activeAds,addAd,deleteAd,profileForToken,removeProfile,readProfiles,creditAccount,accountByNumber,readEvents,addEvent,deleteEvent,readMusic,addMusic,deleteMusic};
