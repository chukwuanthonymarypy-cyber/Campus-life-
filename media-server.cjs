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
function activeAds(all){const today=dateLagos();return all.filter(a=>a.startsOn<=today&&today<=a.endsOn)}
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
async function profileForToken(token){
  if(!mediaReady||typeof token!=='string'||token.length>4096)return null;
  const r=await fetch(project+'/auth/v1/user',{headers:{apikey:key,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(9000)});
  if(!r.ok)return null;
  const user=await r.json();if(!/^[0-9a-f-]{36}$/i.test(user?.id||''))return null;
  const rows=await request(`/rest/v1/campus_avatar_profiles?select=avatar_path,version&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
  const row=rows[0];return {id:user.id,url:row?.avatar_path?publicUrl('campus-avatars',row.avatar_path,String(row.version)):'',hasPicture:!!row?.avatar_path};
}
module.exports={mediaReady,dateLagos,readAds,activeAds,addAd,deleteAd,profileForToken,removeProfile,readProfiles};
