const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const media=require('./media-server.cjs');
const accounts=require('./accounts-server.cjs');
const population=require('./population-server.cjs');
const admins=new Set(),adminFailures=new Map();
let adCache=[],adCacheAt=0,eventsCache=[],musicCache=[];
const adminPassword=process.env.CAMPUS_ADMIN_PASSWORD||'';
function adminRoster(){return [...users.values()].map(u=>({id:u.id,name:u.name,course:u.course,level:u.level,wallet:u.wallet,room:u.state?.room||'Arriving',hasPicture:!!u.profileUrl,signedIn:!!u.profileId,playerNumber:u.playerNumber||null}))}
function updateAdminRoster(){for(const ws of admins)send(ws,{type:'adminRoster',players:adminRoster()})}
async function updateAdminGallery(){if(!media.mediaReady)return;const photos=await media.readProfiles();for(const ws of admins)send(ws,{type:'adminGallery',photos})}
async function loadAds(force=false){if(!media.mediaReady)return [];if(!force&&Date.now()-adCacheAt<30000)return adCache;adCache=await media.readAds();adCacheAt=Date.now();return adCache}
async function notifyAds(){const all=await loadAds(true);for(const ws of users.keys())send(ws,{type:'adsSnapshot',ads:media.activeAds(all)});for(const ws of admins)send(ws,{type:'adminAds',ads:all})}
async function notifyContent(){if(!media.mediaReady)return;const [events,music]=await Promise.all([media.readEvents(),media.readMusic()]);eventsCache=events;musicCache=music;for(const ws of users.keys())send(ws,{type:'campusContent',events,music});for(const ws of admins)send(ws,{type:'adminContent',events,music})}
setInterval(()=>{if(media.mediaReady)notifyContent().catch(e=>console.warn('Campus content refresh failed:',e.message))},60000).unref();
setInterval(()=>{if(media.mediaReady)notifyAds().catch(e=>console.warn('Advert refresh failed:',e.message))},60000).unref();
const port = Number(process.env.PORT || 8000);
const page = path.join(__dirname,'public','index.html');
const messages = [];
const reports = new Map();
const users = new Map();
const activities = {football:{players:[],started:false,ends:0,holder:0,goals:0,shots:0},study:{players:[],started:false,ends:0,notes:new Set()}};
const server = http.createServer((req,res)=>{
  if(req.url?.startsWith('/api/accounts/')){accounts.handle(req,res).catch(e=>{console.warn('Account API crashed:',e.message);if(!res.headersSent)res.writeHead(500).end('Account service error')});return}
  if(req.method!=='GET'){res.writeHead(405).end();return}
  if(req.url==='/' || req.url==='/index.html'){
    if(!fs.existsSync(page)){
      res.writeHead(200,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}).end('Campus Life live server is running. Play the game on its Vercel URL.');
      return;
    }
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
    fs.createReadStream(page).pipe(res);return;
  }
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,online:users.size,release:'2026-10-15-campus-life-main-road-fuel-tab-release',supabaseEnvPresent:media.mediaReady,passwordAccountsReady:accounts.ready,recoveryMailReady:accounts.mailReady}));return}
  res.writeHead(404).end('Not found');
});
const wss = new WebSocketServer({server,path:'/ws',maxPayload:410*1024});
function send(ws,obj){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj))}
function broadcast(obj){for(const ws of users.keys())send(ws,obj)}
function playersOnline(){return [...users.values()].map(u=>({id:u.id,name:u.name,course:u.course,level:u.level,state:u.state}))}
// Exterior lodge stairs and lift shafts are checked server-side; client-reported heights cannot teleport elsewhere.
const lodgeAccessCoords=[[-18,-111,14,13,'lodgeWest'],[18,-128,14,13,'lodgeEast'],[-18,-159,15,14,'oakTower'],[18,-179,15,14,'riverTower'],[-43,-202,15,14,'unityTower'],[43,-220,15,14,'eastTower']];
function lodgeHeight(x,z,liftRiding,reported){for(const [bx,bz,bw,bd,id] of lodgeAccessCoords){const dir=id==='unityTower'?-1:1,near=bz+dir*(bd/2+2.65),far=near+dir*10,liftX=bx+(Math.abs(bx)>30?(bx<0?1:-1):(bx<0?-1:1))*(bw/2+(Math.abs(bx)>30?1.6:2)),liftZ=near-dir*1.7;if(liftRiding&&Math.hypot(x-liftX,z-liftZ)<1.8&&Number.isFinite(reported))return Math.max(0,Math.min(15.75,reported));if(Math.abs(x-bx)>9||z<Math.min(near,far)-1.35||z>Math.max(near,far)+1.35)continue;for(let f=1;f<=5;f++){const cx=bx-6+(f-1)*3,start=f%2?near:far,end=f%2?far:near,progress=(z-start)/(end-start);if(f<5&&Math.abs(z-end)<1.13&&x>=cx-1.28&&x<=cx+4.28)return f*3.15;if(Math.abs(x-cx)<1.28&&progress>=-.11&&progress<=1.08)return (f-1+Math.max(0,Math.min(1,progress)))*3.15}}return 0}
function crescentHeight(x,z){const on=(a,b,c,d)=>x>=a&&x<=b&&z>=c&&z<=d;if(on(53,65,15.5,18.5))return Math.max(0,Math.min(3.15,(x-53)/12*3.15));if(on(53,65,22.5,26))return 3.15+Math.max(0,Math.min(3.15,(65-x)/12*3.15));if(on(53,65,29.5,33))return 6.3+Math.max(0,Math.min(3.15,(x-53)/12*3.15));if(on(63,66,18,24)||on(63,75,19,22.5))return 3.15;if(on(52,55,25.5,31)||on(52,75,26,29))return 6.3;if(on(63,75,30,33.5))return 9.45;return 0}
const validCourses=new Set(['cs','medicine','media','business','law','nursing','pharmacy','civil','accounting','economics','architecture','education']);
function validLevel(n){return [100,200,300,400].includes(n)?n:100}
function sameScene(a,b){return a.room===b.room&&(a.room==='outside'||a.floor===b.floor&&!!a.private===!!b.private&&(!a.private||a.ownerId===b.ownerId))}
function onlineKinds(){const accounts=new Set(),guests=new Set();for(const user of users.values()){if(user.profileId)accounts.add(user.profileId);else guests.add(user.guestId||user.id)}return {registered:accounts.size,guests:guests.size}}
function count(){population.totalsForDisplay().then(totals=>broadcast({type:'presence',count:users.size,players:playersOnline(),online:onlineKinds(),totals})).catch(()=>{});updateAdminRoster()}
async function notifyRooms(){try{const entries=await population.readRooms();for(const [peer,user] of users)send(peer,await population.snapshotFor(user.profileId?'a:'+user.profileId:user.guestId?'g:'+user.guestId:'',entries))}catch(error){console.warn('Room snapshot unavailable:',error.message)}}
function clean(s,max){return String(s||'').replace(/[\u0000-\u001f\u007f<>]/g,'').trim().slice(0,max)}
function error(ws,text){send(ws,{type:'error',text})}
function activityState(mode){const room=activities[mode];broadcast({type:'activityState',mode,players:room.players.map(p=>({id:p.id,name:p.name})),started:room.started,ends:room.ends,holder:room.players[room.holder]?.id||null,goals:room.goals||0,shots:room.shots||0,notes:room.notes?.size||0,contributors:[...(room.notes||[])]})}
function endActivity(mode,completed=false){const room=activities[mode];for(const p of room.players)send(p.ws,{type:'activityEnd',mode,completed,goals:room.goals||0,shots:room.shots||0});room.players=[];room.started=false;room.ends=0;room.holder=0;room.goals=0;room.shots=0;room.notes=new Set();activityState(mode)}
function leaveActivity(ws){for(const [mode,room] of Object.entries(activities)){const i=room.players.findIndex(p=>p.ws===ws);if(i<0)continue;room.players.splice(i,1);room.notes?.delete(users.get(ws)?.id);if(room.holder>=room.players.length)room.holder=0;if(room.started&&room.players.length<2)endActivity(mode,false);else activityState(mode)}}
function joinActivity(ws,user,mode){if(!Object.hasOwn(activities,mode))return error(ws,'Unknown activity.');const room=activities[mode];if(!room)return error(ws,'Unknown activity.');if(room.players.some(p=>p.ws===ws))return activityState(mode);if(Object.values(activities).some(r=>r.players.some(p=>p.ws===ws)))return error(ws,'Leave your current shared activity first.');if(room.players.length>=4||(room.started&&room.ends-Date.now()<15000))return error(ws,'This round is full or nearly over. Try the next round.');room.players.push({ws,id:user.id,name:user.name,lastAction:0});if(room.players.length>=2){room.started=true;room.ends=Date.now()+(mode==='football'?60000:90000)}activityState(mode)}
setInterval(()=>{for(const [mode,room] of Object.entries(activities))if(room.started&&Date.now()>=room.ends)endActivity(mode,mode==='football')},1000);

wss.on('connection',ws=>{
  const user={id:crypto.randomUUID(),name:'',course:'cs',level:100,wallet:0,transferIds:new Set(),last:0,window:[],previous:'',state:null,lastState:0,lastDM:0,lastClub:0,lastYield:0,pendingInvites:new Map(),locationInvites:new Map(),allowedRooms:new Map(),admin:false,adminBusy:false,adminAttempts:0,profileUrl:'',guestId:'',roomBusy:false};
  ws.on('message',raw=>{
    if(raw.length>4096&&!user.admin){ws.close(1009,'Message too large');return}
    let data;try{data=JSON.parse(raw)}catch{return error(ws,'Message was not understood.')}
    if(data.type==='adminAuth'){
      const ip=String(ws._socket?.remoteAddress||''),rec=adminFailures.get(ip)||{attempts:0,until:0};
      if(!adminPassword||adminPassword.length<12)return send(ws,{type:'adminError',text:'Set a server-side CAMPUS_ADMIN_PASSWORD (12+ characters) first.'});
      if(rec.until>Date.now()||user.adminAttempts>=5)return send(ws,{type:'adminError',text:'Too many attempts. Try later.'});
      const typed=typeof data.password==='string'&&data.password.length<=256?data.password:'';
      const correct=crypto.timingSafeEqual(crypto.createHash('sha256').update(typed).digest(),crypto.createHash('sha256').update(adminPassword).digest());
      if(!correct){user.adminAttempts++;rec.attempts++;rec.until=rec.attempts>=5?Date.now()+15*60*1000:0;adminFailures.set(ip,rec);return send(ws,{type:'adminError',text:'Incorrect password.'})}
      adminFailures.delete(ip);user.admin=true;admins.add(ws);send(ws,{type:'adminWelcome',players:adminRoster(),storageReady:media.mediaReady});
      notifyContent().catch(e=>send(ws,{type:'adminError',text:'Could not load events/music: '+e.message}));loadAds().then(ads=>send(ws,{type:'adminAds',ads})).catch(e=>send(ws,{type:'adminError',text:'Could not load adverts: '+e.message}));updateAdminGallery().catch(()=>{});return;
    }
    if(data.type?.startsWith('adminEvent')||data.type?.startsWith('adminMusic')){
      if(!user.admin)return error(ws,'Administrator login required.');
      if(!media.mediaReady)return send(ws,{type:'adminError',text:'Configure Supabase and apply SQL 007 to manage events/music.'});
      if(user.adminBusy)return send(ws,{type:'adminError',text:'Wait for the previous operation to finish.'});
      const location=clean(data.locationId,40),known=new Set(['outside','crescentHostel','pool','club','lecture','library','sports','music','cafe','centre','arts',...Array.from({length:12},(_,i)=>'dept-'+['cs','medicine','media','business','law','nursing','pharmacy','civil','accounting','economics','architecture','education'][i])]);
      if(data.type==='adminEventSave'){
        const title=clean(data.title,80),details=clean(data.details,500),start=Date.parse(data.startsAt),iso=Number.isFinite(start)?new Date(start).toISOString():'';
        if(title.length<3||!iso||start<Date.now()-3600000||start>Date.now()+365*86400000||location&&!known.has(location))return send(ws,{type:'adminError',text:'Check event title, future date (within one year), and location.'});
        user.adminBusy=true;media.addEvent({title,details,startsAt:iso,locationId:location}).then(()=>notifyContent()).then(()=>send(ws,{type:'adminNotice',text:'Campus event published and synced to players.'})).catch(e=>send(ws,{type:'adminError',text:'Event not saved: '+e.message})).finally(()=>user.adminBusy=false);return;
      }
      if(data.type==='adminEventDelete'||data.type==='adminMusicDelete'){
        if(!/^[0-9a-f-]{36}$/i.test(data.id||''))return error(ws,'Invalid item ID.');user.adminBusy=true;
        (data.type==='adminEventDelete'?media.deleteEvent(data.id):media.deleteMusic(data.id)).then(()=>notifyContent()).then(()=>send(ws,{type:'adminNotice',text:'Item removed.'})).catch(e=>send(ws,{type:'adminError',text:'Could not remove item: '+e.message})).finally(()=>user.adminBusy=false);return;
      }
      if(data.type==='adminMusicBegin'){
        const title=clean(data.title,80),size=Number(data.size),mime=String(data.mime||''),radio=data.radio===true;
        if(title.length<2||!Number.isSafeInteger(size)||size<512||size>8*1024*1024||!['audio/mpeg','audio/ogg','audio/mp4'].includes(mime)||!radio&&!known.has(location)||location&&!known.has(location))return send(ws,{type:'adminError',text:'Music must have a title, a public-radio or valid location assignment, and be MP3, Ogg or M4A under 8 MB.'});
        user.upload={title,size,mime,radio,locationId:location,chunks:[],count:0,started:Date.now()};send(ws,{type:'adminMusicReady'});return;
      }
      if(data.type==='adminMusicChunk'){
        const upload=user.upload,chunk=String(data.chunk||'');if(!upload||Date.now()-upload.started>120000||!Number.isInteger(data.index)||data.index!==upload.chunks.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(chunk)||chunk.length>260000){user.upload=null;return send(ws,{type:'adminError',text:'Music upload expired or a chunk was invalid. Try again.'})}
        const buffer=Buffer.from(chunk,'base64');upload.count+=buffer.length;if(upload.count>upload.size||buffer.length<1){user.upload=null;return send(ws,{type:'adminError',text:'Music file size is invalid.'})}upload.chunks.push(buffer);send(ws,{type:'adminMusicNext',index:upload.chunks.length});return;
      }
      if(data.type==='adminMusicFinish'){
        const upload=user.upload;user.upload=null;if(!upload||upload.count!==upload.size)return send(ws,{type:'adminError',text:'Music upload was incomplete.'});const bytes=Buffer.concat(upload.chunks);if(upload.mime==='audio/mpeg'&&bytes.toString('ascii',0,3)!=='ID3'&&!(bytes[0]===255&&(bytes[1]&224)===224)||upload.mime==='audio/ogg'&&bytes.toString('ascii',0,4)!=='OggS'||upload.mime==='audio/mp4'&&bytes.toString('ascii',4,8)!=='ftyp')return send(ws,{type:'adminError',text:'Audio header does not match the selected format.'});
        user.adminBusy=true;media.addMusic({...upload,bytes}).then(()=>notifyContent()).then(()=>send(ws,{type:'adminNotice',text:'Licensed music saved to campus radio/location.'})).catch(e=>send(ws,{type:'adminError',text:'Music was not saved: '+e.message})).finally(()=>user.adminBusy=false);return;
      }
      return;
    }
    if(data.type==='adminTopUp'||data.type==='adminAdSave'||data.type==='adminAdDelete'||data.type==='adminProfileRemove'){
      if(!user.admin)return error(ws,'Administrator login required.');
      if(data.type==='adminTopUp'){
        const amount=Number(data.amount),number=String(data.playerNumber||'');
        if(!Number.isSafeInteger(amount)||amount<1||amount>1000000)return send(ws,{type:'adminError',text:'Enter a whole-naira amount between ₦1 and ₦1,000,000.'});
        if(user.adminBusy)return send(ws,{type:'adminError',text:'Wait for the previous operation to finish.'});
        if(number){
          if(!/^1[0-9]{7}$/.test(number))return send(ws,{type:'adminError',text:'Enter a valid eight-digit signed-in player number.'});
          if(!media.mediaReady)return send(ws,{type:'adminError',text:'Supabase is not configured. No account grant was sent.'});
          user.adminBusy=true;
          media.accountByNumber(number).then(async id=>{
            if(!id)throw Error('Player number not found');
            const result=await media.creditAccount(id,amount);
            for(const [peer,u] of users)if(u.profileId===id)send(peer,{type:'adminGrant',id:crypto.randomUUID(),amount,wallet:result.wallet,revision:result.revision});
            send(ws,{type:'adminNotice',text:`Added ₦${amount.toLocaleString('en-NG')} fictional money to player #${number}'s cloud account. The grant persists even if they are offline.`});updateAdminRoster();
          }).catch(e=>send(ws,{type:'adminError',text:'Grant was not saved: '+e.message})).finally(()=>user.adminBusy=false);return;
        }
        const target=[...users].find(([,u])=>u.id===data.toId);
        if(!target||target[0].readyState!==WebSocket.OPEN)return send(ws,{type:'adminError',text:'This guest is no longer online. Guest grants cannot be made offline.'});
        if(target[1].profileId)return send(ws,{type:'adminError',text:'Use the signed-in player’s number for a durable cloud grant.'});
        target[1].wallet+=amount;send(target[0],{type:'adminGrant',id:crypto.randomUUID(),amount});send(ws,{type:'adminNotice',text:`Added ₦${amount.toLocaleString('en-NG')} to ${target[1].name}'s online guest wallet. This is not a cloud account.`});updateAdminRoster();return;
      }
      if(data.type==='adminProfileRemove'){
        const target=[...users].find(([,u])=>u.id===data.toId||u.profileId===data.profileId);
        const profileId=target?.[1].profileId||data.profileId;
        if(typeof profileId!=='string'||!/^[0-9a-f-]{36}$/i.test(profileId))return send(ws,{type:'adminError',text:'Choose a valid public picture.'});
        if(!media.mediaReady)return send(ws,{type:'adminError',text:'Supabase is not configured.'});
        if(user.adminBusy)return send(ws,{type:'adminError',text:'Wait for the previous operation to finish.'});
        user.adminBusy=true;media.removeProfile(profileId).then(async()=>{if(target){target[1].profileUrl='';updateAdminRoster();if(target[1].state){target[1].state.profileUrl='';count();for(const peer of users.keys())if(peer!==target[0])send(peer,{type:'playerState',id:target[1].id,state:target[1].state})}send(target[0],{type:'profileRemoved'})}send(ws,{type:'adminNotice',text:'Public profile picture removed.'});await updateAdminGallery()}).catch(e=>send(ws,{type:'adminError',text:'Could not remove picture: '+e.message})).finally(()=>user.adminBusy=false);return;
      }
      if(user.adminBusy)return send(ws,{type:'adminError',text:'Wait for the previous advert operation to finish.'});
      if(!media.mediaReady)return send(ws,{type:'adminError',text:'Configure Supabase Storage on Render to save adverts.'});
      if(data.type==='adminAdDelete'){
        if(!/^[0-9a-f-]{36}$/i.test(data.id||''))return;
        user.adminBusy=true;media.deleteAd(data.id).then(ok=>{send(ws,{type:'adminNotice',text:ok?'Advert deleted.':'Advert not found.'});return notifyAds()}).catch(e=>send(ws,{type:'adminError',text:'Could not delete advert: '+e.message})).finally(()=>{user.adminBusy=false});return;
      }
      const title=clean(data.title,60),ids=Array.isArray(data.boardIds)?[...new Set(data.boardIds)]:[],startsOn=data.startsOn,endsOn=data.openEnded===true?null:data.endsOn;
      let link;try{link=new URL(String(data.linkUrl||''))}catch{return send(ws,{type:'adminError',text:'Enter a valid HTTPS owner link.'})}
      const validDate=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x;
      if(title.length<2||link.protocol!=='https:'||link.username||link.password||link.href.length>500||!validDate(startsOn)||(endsOn!==null&&(!validDate(endsOn)||startsOn>endsOn))||!ids.length||ids.length>26||ids.some(id=>typeof id!=='string'||!/^A([1-9]|1[0-9]|2[0-6])$/.test(id)))return send(ws,{type:'adminError',text:'Check title, HTTPS link, billboard codes, start date and optional end date.'});
      if(typeof data.image!=='string'||data.image.length>375000||!/^[A-Za-z0-9+/]+={0,2}$/.test(data.image))return send(ws,{type:'adminError',text:'Choose a JPEG picture under 270 KB.'});
      const bytes=Buffer.from(data.image,'base64');if(bytes.length<500||bytes.length>270000||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)return send(ws,{type:'adminError',text:'The picture must be a valid JPEG under 270 KB.'});
      user.adminBusy=true;media.addAd({title,linkUrl:link.href,boardIds:ids,startsOn,endsOn,bytes}).then(()=>{send(ws,{type:'adminNotice',text:'Advert saved. It will appear from its start date until its end date or admin removal.'});return notifyAds()}).catch(e=>send(ws,{type:'adminError',text:'Could not save advert: '+e.message})).finally(()=>{user.adminBusy=false});return;
    }
    if(data.type==='join'){
      if(user.name||user.joining)return;
      const name=clean(data.name,18);
      if(name.length<2)return error(ws,'Choose a name with at least 2 characters.');
      const finish=profile=>{
        if(ws.readyState!==WebSocket.OPEN)return;
        user.name=name;user.guestId=!profile&&population.guestPattern.test(data.guestId||'')?data.guestId:'';user.profileId=profile?.id||'';user.playerNumber=profile?.playerNumber||'';user.profileUrl=profile?.url||'';user.course=validCourses.has(data.course)?data.course:'cs';user.level=validLevel(data.level);user.wallet=Number.isSafeInteger(data.wallet)&&data.wallet>=0?data.wallet:0;users.set(ws,user);
        send(ws,{type:'welcome',id:user.id,messages:messages.slice(-40),count:users.size,players:playersOnline(),online:onlineKinds()});population.registerGuest(user.guestId).then(()=>count()).catch(()=>{});population.snapshotFor(user.profileId?'a:'+user.profileId:user.guestId?'g:'+user.guestId:'').then(snapshot=>send(ws,snapshot)).catch(()=>{});if(profile)send(ws,{type:'profileReady',url:user.profileUrl,playerNumber:user.playerNumber});count();loadAds().then(ads=>send(ws,{type:'adsSnapshot',ads:media.activeAds(ads)})).catch(()=>{});notifyContent().catch(()=>{});for(const mode of Object.keys(activities))activityState(mode);
      };
      if(!data.token){finish(null);return}
      if(!media.mediaReady)return error(ws,'Account login is unavailable on this server. Play as a guest or try again later.');
      user.joining=true;media.profileForToken(data.token).then(profile=>profile?finish(profile):error(ws,'Account login expired. Sign in again.')).catch(()=>error(ws,'Could not verify account login. Try again.')).finally(()=>user.joining=false);return;
    }
    if(!user.name)return error(ws,'Join the campus chat first.');
    if(data.type==='profileLogout'){ws.close(1008,'Account signed out. Rejoin as a guest.');return}
    if(data.type==='profileAuth'){
      if(!media.mediaReady)return error(ws,'Profile pictures need Supabase configuration.');
      media.profileForToken(data.token).then(profile=>{
        if(!profile)return error(ws,'Profile login expired. Sign in again.');
        if(user.profileId&&profile.id!==user.profileId)return error(ws,'Account changed. Reconnect to campus.');
        user.profileId=profile.id;user.playerNumber=profile.playerNumber||'';user.profileUrl=profile.url;updateAdminRoster();count();if(user.state){user.state.profileUrl=user.profileUrl;for(const peer of users.keys())if(peer!==ws)send(peer,{type:'playerState',id:user.id,state:user.state})}
        send(ws,{type:'profileReady',url:user.profileUrl,playerNumber:user.playerNumber});updateAdminGallery().catch(()=>{});
      }).catch(()=>error(ws,'Could not verify profile. Try again.'));return;
    }
    if(data.type==='roomSnapshotRequest'){population.snapshotFor(user.profileId?'a:'+user.profileId:user.guestId?'g:'+user.guestId:'').then(snapshot=>send(ws,snapshot)).catch(()=>error(ws,'Room statuses could not be loaded.'));return}
    if(data.type==='roomClaim'){
      const owner=user.profileId?'a:'+user.profileId:user.guestId?'g:'+user.guestId:'',kind=clean(data.kind,32),floor=Number(data.floor),unit=clean(data.unit,2),paid=Number(data.paidThroughDay),day=Number(data.day),requestId=clean(data.requestId,45);
      if(!owner||!requestId||!population.validRoom(kind,floor,unit,paid)||!Number.isInteger(day)||day<1||paid<day||paid-day>90)return send(ws,{type:'roomClaimResult',requestId,ok:false,error:'Check the selected room and lease term.'});
      if(user.roomBusy)return send(ws,{type:'roomClaimResult',requestId,ok:false,error:'A room claim is already in progress.'});user.roomBusy=true;
      population.claim(owner,kind,floor,unit,paid,user.profileId&&user.guestId?'g:'+user.guestId:null).then(result=>{send(ws,{type:'roomClaimResult',requestId,...result});if(result.ok)notifyRooms()}).catch(()=>send(ws,{type:'roomClaimResult',requestId,ok:false,error:'The room service is temporarily unavailable.'})).finally(()=>user.roomBusy=false);return;
    }
    if(data.type==='roomRelease'){
      const owner=user.profileId?'a:'+user.profileId:user.guestId?'g:'+user.guestId:'';
      if(!owner||user.roomBusy)return;user.roomBusy=true;population.release(owner).then(()=>notifyRooms()).finally(()=>user.roomBusy=false);return;
    }
    if(data.type==='heartbeat'){send(ws,{type:'heartbeat'});return;}
    if(data.type==='playerState'){
      const now=Date.now();if(now-user.lastState<90)return;
      const v=data.state;if(!v||typeof v!=='object'||!Number.isFinite(v.x)||!Number.isFinite(v.z)||!Number.isFinite(v.dir))return;
      const room=clean(v.room,38),outfit=clean(v.outfit,32),floor=Number(v.floor),ownerId=clean(v.ownerId,40);
      if(!/^(outside|[a-zA-Z][a-zA-Z0-9-]{0,36})$/.test(room)||!Number.isInteger(floor)||floor<0||floor>5||!/^[-a-z0-9]{1,32}$/i.test(outfit))return;
      if(v.private&&ownerId!==user.id){const invite=user.allowedRooms.get(ownerId);if(!invite||invite.kind!==room||invite.floor!==floor)return error(ws,'That bedroom is invitation-only.');}
      const candidate={x:Math.max(-260,Math.min(260,v.x)),z:Math.max(-260,Math.min(260,v.z)),elevation:room==='outside'?Math.max(crescentHeight(v.x,v.z),lodgeHeight(v.x,v.z,!!v.liftRiding,v.elevation)):0,liftRiding:room==='outside'&&!!v.liftRiding,dir:v.dir,room,floor,private:!!v.private,ownerId:v.private?ownerId:'',outfit,avatarStyle:['m1','m2','m3','f1','f2','f3'].includes(v.avatarStyle)?v.avatarStyle:'',schoolBag:!!v.schoolBag,riding:!!v.riding,resting:!!v.resting,seated:!!v.seated,performing:!!v.performing,profileUrl:user.profileUrl};
      if(!candidate.riding&&!candidate.liftRiding&&user.state&&sameScene(candidate,user.state))for(const peer of users.values()){
        if(peer===user||!peer.state||peer.state.riding||!sameScene(candidate,peer.state)||Math.abs(candidate.elevation-(peer.state.elevation||0))>1.3)continue;
        const vx=candidate.x-user.state.x,vz=candidate.z-user.state.z,oldGap=Math.hypot(user.state.x-peer.state.x,user.state.z-peer.state.z),gap=Math.hypot(candidate.x-peer.state.x,candidate.z-peer.state.z),t=Math.max(0,Math.min(1,((peer.state.x-user.state.x)*vx+(peer.state.z-user.state.z)*vz)/(vx*vx+vz*vz||1))),closest=Math.hypot(user.state.x+vx*t-peer.state.x,user.state.z+vz*t-peer.state.z);
        if(oldGap<1.16?gap<oldGap-.02:closest<1.16){send(ws,{type:'collisionStop',room:user.state.room,x:user.state.x,z:user.state.z});return}
      }
      const oldCourse=user.course,oldLevel=user.level;user.course=validCourses.has(v.course)?v.course:user.course;user.level=validLevel(v.level||user.level);user.state=candidate;user.lastState=now;if(user.course!==oldCourse||user.level!==oldLevel)count();
      for(const peer of users.keys())if(peer!==ws)send(peer,{type:'playerState',id:user.id,state:user.state});
      return;
    }
    if(data.type==='yield'){
      const target=[...users].find(([,u])=>u.id===data.toId),dx=Number(data.dx),dz=Number(data.dz),now=Date.now();
      if(!target||target[1]===user||!user.state||!target[1].state||!sameScene(user.state,target[1].state)||!Number.isFinite(dx)||!Number.isFinite(dz)||Math.hypot(dx,dz)>1.5||Math.hypot(user.state.x-target[1].state.x,user.state.z-target[1].state.z)>3.5||now-user.lastYield<1000)return;
      user.lastYield=now;send(target[0],{type:'yield',room:user.state.room,dx,dz});return;
    }
    if(data.type==='clubEvent'){
      if(user.state?.room!=='club'||!['start','finish'].includes(data.phase))return error(ws,'Enter the club before joining its live stage.');
      if(data.phase==='start'){if(Date.now()-user.lastClub<15000)return;user.lastClub=Date.now()}
      else if(!user.lastClub||Date.now()-user.lastClub>120000)return;
      broadcast({type:'clubEvent',name:user.name,id:user.id,phase:data.phase,time:Date.now()});return;
    }
    if(data.type==='directMessage'){
      const target=[...users].find(([,u])=>u.id===data.toId),text=clean(data.text,240),now=Date.now();
      if(!target||target[0].readyState!==WebSocket.OPEN)return error(ws,'That guest went offline. No message was sent.');
      if(target[1].id===user.id||!text)return;
      if(now-user.lastDM<800)return error(ws,'Please wait a moment before sending another private message.');
      if(/https?:\/\/|www\.|@everyone|@here/i.test(text)||/\b(?:idiot|stupid|shut up)\b/i.test(text))return error(ws,'Please keep private chat respectful. Links are not allowed.');
      user.lastDM=now;const msg={id:crypto.randomUUID(),fromId:user.id,fromName:user.name,toId:target[1].id,toName:target[1].name,text,time:now};
      send(target[0],{type:'directMessage',message:msg});send(ws,{type:'directMessage',message:msg});return;
    }
    if(data.type==='locationInvite'){
      const target=[...users].find(([,u])=>u.id===data.toId),st=user.state;
      if(!target||target[0]===ws||!st||st.private||st.room==='outside'&&(Math.abs(st.x)>(st.z<-86?52:108)||st.z< -242||st.z>64))return error(ws,'You must be in a walkable public location to invite another player here.');
      const loc={room:st.room,x:st.x,z:st.z,elevation:st.elevation||0,expires:Date.now()+300000};target[1].locationInvites.set(user.id,loc);
      send(target[0],{type:'locationInvite',fromId:user.id,fromName:user.name,room:loc.room});return;
    }
    if(data.type==='locationInviteAccept'){
      const host=[...users].find(([,u])=>u.id===data.fromId),loc=user.locationInvites.get(data.fromId);
      if(!host||!loc||loc.expires<Date.now())return error(ws,'Location invitation expired or its host left.');
      user.locationInvites.delete(data.fromId);send(ws,{type:'locationInviteGranted',fromId:host[1].id,fromName:host[1].name,room:loc.room,x:loc.x,z:loc.z,elevation:loc.elevation});return;
    }
    if(data.type==='locationInvite'){
      const target=[...users].find(([,u])=>u.id===data.toId),st=user.state;
      if(!target||target[0]===ws||!st||st.private)return error(ws,'You must be in a public location to invite another player here.');
      const loc={room:st.room,x:st.x,z:st.z,expires:Date.now()+300000};target[1].locationInvites.set(user.id,loc);
      send(target[0],{type:'locationInvite',fromId:user.id,fromName:user.name,room:loc.room});return;
    }
    if(data.type==='locationInviteAccept'){
      const host=[...users].find(([,u])=>u.id===data.fromId),loc=user.locationInvites.get(data.fromId);
      if(!host||!loc||loc.expires<Date.now())return error(ws,'Location invitation expired or its host left.');
      user.locationInvites.delete(data.fromId);send(ws,{type:'locationInviteGranted',fromId:host[1].id,fromName:host[1].name,room:loc.room,x:loc.x,z:loc.z});return;
    }
    if(data.type==='roomInvite'){
      const target=[...users].find(([,u])=>u.id===data.toId),kind=clean(data.kind,24),floor=Number(data.floor),unit=data.unit;
      const residences=['hostel','crescentHostel','lodgeWest','lodgeEast','oakTower','riverTower','unityTower','eastTower','campusMaple','campusCedar','campusUnity','campusSummit'];
      if(!target||target[1].id===user.id||!residences.includes(kind)||!Number.isInteger(floor)||floor<0||floor>5||!['A','B'].includes(unit))return error(ws,'Cannot invite that player to a room.');
      target[1].pendingInvites.set(user.id,{kind,floor,unit,expires:Date.now()+300000});
      send(target[0],{type:'roomInvite',fromId:user.id,fromName:user.name,kind,floor,unit});send(ws,{type:'notice',text:`Invitation sent to ${target[1].name}.`});return;
    }
    if(data.type==='roomInviteAccept'){
      const host=[...users].find(([,u])=>u.id===data.fromId),invitation=user.pendingInvites.get(data.fromId);
      if(!host||!invitation||Date.now()>invitation.expires)return error(ws,'That room invitation expired or the host left.');
      user.pendingInvites.delete(data.fromId);user.allowedRooms.set(data.fromId,invitation);
      send(ws,{type:'roomInviteGranted',fromId:host[1].id,fromName:host[1].name,kind:invitation.kind,floor:invitation.floor,unit:invitation.unit});
      send(host[0],{type:'roomInviteAccepted',guestName:user.name});return;
    }
    if(data.type==='roomInviteRevoke'){
      const target=[...users].find(([,u])=>u.id===data.toId);
      if(!target)return;
      target[1].allowedRooms.delete(user.id);target[1].pendingInvites.delete(user.id);
      send(target[0],{type:'roomInviteRevoked',fromId:user.id});return;
    }

    // Session-local, fictional wallets. The browser save remains the source of truth on reconnect.
    // There are no accounts or real-money transfers; clients can edit local saves in this prototype.
    if(data.type==='walletSync'){
      if(Number.isSafeInteger(data.wallet)&&data.wallet>=0){user.wallet=data.wallet;updateAdminRoster()}
      return;
    }
    if(data.type==='transfer'){
      const requestId=String(data.requestId||'').slice(0,80),amount=data.amount;
      const fail=message=>send(ws,{type:'transferResult',requestId,ok:false,error:message});
      if(!requestId||user.transferIds.has(requestId))return fail('This transfer has already been processed.');
      if(!Number.isSafeInteger(amount)||amount<1)return fail('Enter a whole-naira amount of at least ₦1.');
      const recipient=[...users].find(([,u])=>u.id===data.toId);
      if(!recipient||recipient[0].readyState!==WebSocket.OPEN)return fail('That player is no longer online. No money was sent.');
      const [recipientSocket,target]=recipient;
      if(target.id===user.id)return fail('You cannot send money to yourself.');
      if(user.wallet<amount)return fail('Insufficient wallet balance. No money was sent.');
      if(!Number.isSafeInteger(target.wallet+amount))return fail('Recipient balance is too high for this transfer.');
      user.transferIds.add(requestId);if(user.transferIds.size>100)user.transferIds.delete(user.transferIds.values().next().value);
      user.wallet-=amount;target.wallet+=amount;updateAdminRoster();
      send(recipientSocket,{type:'transferReceived',id:user.id+':'+requestId,fromName:user.name,amount});
      send(ws,{type:'transferResult',requestId,ok:true,toName:target.name,amount});
      return;
    }
    if(data.type==='activityJoin'){joinActivity(ws,user,data.mode);return}
    if(data.type==='activityLeave'){leaveActivity(ws);return}
    if(data.type==='activityAction'){
      const mode=data.mode;if(!Object.hasOwn(activities,mode))return;const room=activities[mode],player=room?.players.find(p=>p.ws===ws),now=Date.now();
      if(!player||!room.started||now>=room.ends||now-player.lastAction<600)return;
      if(mode==='football'){
        if(room.players[room.holder]?.ws!==ws)return;
        if(data.action==='pass'){room.holder=(room.holder+1)%room.players.length}
        else if(data.action==='shoot'&&['left','centre','right'].includes(data.lane)){room.shots++;const lanes=['left','centre','right'];const keeper=lanes[crypto.randomInt(3)];if(data.lane!==keeper)room.goals++;room.holder=(room.holder+1)%room.players.length;if(room.shots>=12){activityState(mode);endActivity(mode,true);return}}
        else return;
      }else if(mode==='study'){
        if(data.action!=='notes'||room.notes.has(user.id))return;
        room.notes.add(user.id);
        if(room.notes.size===room.players.length){activityState(mode);endActivity(mode,true);return}
      }
      player.lastAction=now;activityState(mode);return;
    }
    if(data.type==='chat'){
      const text=clean(data.text,240),now=Date.now();
      if(!text)return;
      if(/https?:\/\/|www\.|@everyone|@here/i.test(text))return error(ws,'Links and mass mentions are not allowed.');
      if(/\b(?:idiot|stupid|shut up)\b/i.test(text))return error(ws,'Please keep the campus chat respectful.');
      if(text.toLowerCase()===user.previous&&now-user.last<12000)return error(ws,'Please do not repeat the same message.');
      if(now-user.last<1200)return error(ws,'Slow down a little before sending again.');
      user.window=user.window.filter(t=>now-t<60000);
      if(user.window.length>=8)return error(ws,'You have reached the 8 messages per minute limit.');
      user.last=now;user.previous=text.toLowerCase();user.window.push(now);
      const msg={id:crypto.randomUUID(),uid:user.id,name:user.name,text,time:now};
      messages.push(msg);if(messages.length>80)messages.shift();
      broadcast({type:'chat',message:msg});return;
    }
    if(data.type==='report'){
      const msg=messages.find(m=>m.id===data.id);
      if(!msg||msg.uid===user.id)return;
      let set=reports.get(msg.id);if(!set){set=new Set();reports.set(msg.id,set)}set.add(user.id);
      send(ws,{type:'notice',text:'Thanks. Your report was recorded.'});
      if(set.size>=3){messages.splice(messages.indexOf(msg),1);reports.delete(msg.id);broadcast({type:'remove',id:msg.id})}
    }
  });
  ws.on('close',()=>{admins.delete(ws);leaveActivity(ws);if(users.delete(ws)){for(const [peer,other] of users){other.pendingInvites.delete(user.id);other.locationInvites.delete(user.id);other.locationInvites.delete(user.id);other.locationInvites.delete(user.id);if(other.allowedRooms.delete(user.id))send(peer,{type:'roomInviteRevoked',fromId:user.id})}count()}});
  ws.on('error',()=>{});
});
server.listen(port,'0.0.0.0',()=>console.log(`Campus Life listening on 0.0.0.0:${port}`));
