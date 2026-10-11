const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const port = Number(process.env.PORT || 8000);
const page = path.join(__dirname,'index.html');
const messages = [];
const reports = new Map();
const users = new Map();
const activities = {football:{players:[],started:false,ends:0,holder:0,goals:0,shots:0},study:{players:[],started:false,ends:0,notes:new Set()}};
const server = http.createServer((req,res)=>{
  if(req.method!=='GET'){res.writeHead(405).end();return}
  if(req.url==='/' || req.url==='/index.html'){
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
    fs.createReadStream(page).pipe(res);return;
  }
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,online:users.size}));return}
  res.writeHead(404).end('Not found');
});
const wss = new WebSocketServer({server,path:'/ws',maxPayload:2048});
function send(ws,obj){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj))}
function broadcast(obj){for(const ws of users.keys())send(ws,obj)}
function playersOnline(){return [...users.values()].map(u=>({id:u.id,name:u.name}))}
function count(){broadcast({type:'presence',count:users.size,players:playersOnline()})}
function clean(s,max){return String(s||'').replace(/[\u0000-\u001f\u007f<>]/g,'').trim().slice(0,max)}
function error(ws,text){send(ws,{type:'error',text})}
function activityState(mode){const room=activities[mode];broadcast({type:'activityState',mode,players:room.players.map(p=>({id:p.id,name:p.name})),started:room.started,ends:room.ends,holder:room.players[room.holder]?.id||null,goals:room.goals||0,shots:room.shots||0,notes:room.notes?.size||0,contributors:[...(room.notes||[])]})}
function endActivity(mode,completed=false){const room=activities[mode];for(const p of room.players)send(p.ws,{type:'activityEnd',mode,completed,goals:room.goals||0,shots:room.shots||0});room.players=[];room.started=false;room.ends=0;room.holder=0;room.goals=0;room.shots=0;room.notes=new Set();activityState(mode)}
function leaveActivity(ws){for(const [mode,room] of Object.entries(activities)){const i=room.players.findIndex(p=>p.ws===ws);if(i<0)continue;room.players.splice(i,1);room.notes?.delete(users.get(ws)?.id);if(room.holder>=room.players.length)room.holder=0;if(room.started&&room.players.length<2)endActivity(mode,false);else activityState(mode)}}
function joinActivity(ws,user,mode){if(!Object.hasOwn(activities,mode))return error(ws,'Unknown activity.');const room=activities[mode];if(!room)return error(ws,'Unknown activity.');if(room.players.some(p=>p.ws===ws))return activityState(mode);if(Object.values(activities).some(r=>r.players.some(p=>p.ws===ws)))return error(ws,'Leave your current shared activity first.');if(room.players.length>=4||(room.started&&room.ends-Date.now()<15000))return error(ws,'This round is full or nearly over. Try the next round.');room.players.push({ws,id:user.id,name:user.name,lastAction:0});if(room.players.length>=2){room.started=true;room.ends=Date.now()+(mode==='football'?60000:90000)}activityState(mode)}
setInterval(()=>{for(const [mode,room] of Object.entries(activities))if(room.started&&Date.now()>=room.ends)endActivity(mode,mode==='football')},1000);

wss.on('connection',ws=>{
  const user={id:crypto.randomUUID(),name:'',wallet:0,transferIds:new Set(),last:0,window:[],previous:''};
  ws.on('message',raw=>{
    let data;try{data=JSON.parse(raw)}catch{return error(ws,'Message was not understood.')}
    if(data.type==='join'){
      if(user.name)return;
      const name=clean(data.name,18);
      if(name.length<2)return error(ws,'Choose a name with at least 2 characters.');
      user.name=name;user.wallet=Number.isSafeInteger(data.wallet)&&data.wallet>=0?data.wallet:0;users.set(ws,user);
      send(ws,{type:'welcome',id:user.id,messages:messages.slice(-40),count:users.size,players:playersOnline()});count();for(const mode of Object.keys(activities))activityState(mode);return;
    }
    if(!user.name)return error(ws,'Join the campus chat first.');
    if(data.type==='heartbeat'){send(ws,{type:'heartbeat'});return;}
    // Session-local, fictional wallets. The browser save remains the source of truth on reconnect.
    // There are no accounts or real-money transfers; clients can edit local saves in this prototype.
    if(data.type==='walletSync'){
      if(Number.isSafeInteger(data.wallet)&&data.wallet>=0)user.wallet=data.wallet;
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
      user.wallet-=amount;target.wallet+=amount;
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
  ws.on('close',()=>{leaveActivity(ws);if(users.delete(ws))count()});
  ws.on('error',()=>{});
});
server.listen(port,'0.0.0.0',()=>console.log(`Campus Life listening on 0.0.0.0:${port}`));
