'use strict';
// Dependency-free HTTP/WebSocket relay. One host runs the authoritative match.
const http=require('node:http');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const PORT=Number(process.env.PORT||3000),HOST=process.env.HOST||'0.0.0.0';
const MAX_MESSAGE=3_000_000,MAX_ROOMS=500,ROOM_TIMEOUT=1000*60*30;
const BUILD_ID='socket-epipe-guard-2026-10-19-v2';
const rooms=new Map(),connections=new Set();
const HTML=fs.readFileSync(path.join(__dirname,'index.html'));
// Guard *every* socket write. EPIPE means the peer is already gone; it must
// never become an uncaught exception or take down unrelated rooms.
const ready=c=>!!(c&&!c.dead&&!c.socket.destroyed&&c.socket.writable&&!c.socket.writableEnded);
function safeWrite(c,packet,kind='message'){
 if(!ready(c))return false;
 try{
  // Never queue a large backlog behind a slow guest or a stalled connection.
  if(c.socket.writableLength>350_000 && kind==='frame')return false;
  c.socket.write(packet,err=>{
   if(err&&!c.dead){
    console.warn('Socket write failed',c.role||'unassigned',c.room?.code||'no-room',kind,err.code||err.message);
    destroy(c,'write_'+(err.code||'failed'));
   }
  });
  return true;
 }catch(err){
  console.warn('Socket write threw',c.role||'unassigned',c.room?.code||'no-room',kind,err.code||err.message);
  destroy(c,'write_'+(err.code||'failed'));
  return false;
 }
}
const send=(c,obj)=>{
 if(!ready(c))return false;
 const data=Buffer.from(JSON.stringify(obj));
 const header=data.length<126?Buffer.from([129,data.length]):data.length<65536?Buffer.from([129,126,data.length>>8,data.length&255]):Buffer.from([129,127,0,0,0,0,(data.length/0x1000000)&255,(data.length>>16)&255,(data.length>>8)&255,data.length&255]);
 return safeWrite(c,Buffer.concat([header,data]),obj.type==='frame'?'frame':'message');
};
const frameControl=(c,code,bytes=Buffer.alloc(0))=>{
 if(!ready(c))return false;
 return safeWrite(c,Buffer.concat([Buffer.from([0x80|code,bytes.length]),bytes]),'control');
};
function leave(c){const r=c.room;if(!r)return;c.room=null;if(c===r.host){rooms.delete(r.code);if(r.guest){const guest=r.guest;r.guest=null;guest.room=null;send(guest,{type:'peerLeft',reason:'Host closed the room'});}}else if(c===r.guest){r.guest=null;r.started=false;for(const k of r.heldKeys)send(r.host,{type:'input',key:k,pressed:false});r.heldKeys.clear();send(r.host,{type:'peerLeft',reason:'Guest disconnected'});} }
function destroy(c,reason='socket_closed'){
 if(c.dead)return;
 const roomCode=c.room?.code||'no-room';
 const ageSeconds=Math.round((Date.now()-c.connectedAt)/1000);
 console.log('Socket disconnected',c.role||'unassigned',roomCode,
   'reason='+reason,'age='+ageSeconds+'s','frames='+c.framesIn,
   'lastActivity='+Math.round((Date.now()-c.lastActivity)/1000)+'s_ago',
   'pendingBytes='+c.socket.writableLength);
 c.dead=true;connections.delete(c);leave(c);try{c.socket.destroy();}catch{}
}
function createCode(){let code;do{code=crypto.randomBytes(5).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);}while(code.length!==6||rooms.has(code));return code;}
const legal=new Set(['np4','np6','np8','np5','np7','np9','np1','np2','np3','np0','npenter','npmultiply','npdecimal','npadd','npsubtract']);
const chars=new Set(['gojo','sukuna','megumi','mahito','yuji','yuta','hakari','yuki']);
function handle(c,m){if(!m||typeof m!=='object'||Array.isArray(m)||typeof m.type!=='string')return;
 if(m.type==='create'){
  if(c.room)return send(c,{type:'error',message:'Already in a room.'});if(rooms.size>=MAX_ROOMS)return send(c,{type:'error',message:'Server has too many rooms.'});
  const code=createCode(),r={code,host:c,guest:null,started:false,created:Date.now(),heldKeys:new Set(),lastFrame:0,lastSequence:0};rooms.set(code,r);c.room=r;c.role='host';send(c,{type:'created',room:code});return;
 }
 if(m.type==='join'){
  if(c.room)return send(c,{type:'error',message:'Already in a room.'});const code=String(m.room||'').toUpperCase(),r=rooms.get(code);
  if(!r)return send(c,{type:'error',message:'Room not found. Double-check the six-character code.'});if(r.guest)return send(c,{type:'error',message:'Room is already full.'});if(r.started)return send(c,{type:'error',message:'Match already started.'});
  r.guest=c;c.room=r;c.role='guest';send(c,{type:'joined',room:code});send(r.host,{type:'peerJoined',room:code});return;
 }
 const r=c.room;if(!r)return send(c,{type:'error',message:'Create or join a room first.'});
 if(m.type==='leave'){leave(c);send(c,{type:'left'});return;}
 if(m.type==='pick'&&c===r.guest){if(chars.has(m.character)&&!r.started)send(r.host,{type:'guestPick',character:m.character});return;}
 if(m.type==='start'&&c===r.host){if(!r.guest)return send(c,{type:'error',message:'Waiting for Player 2.'});if(!Array.isArray(m.characters)||m.characters.length!==2||!m.characters.every(ch=>chars.has(ch)))return;
  r.started=true;r.heldKeys.clear();r.lastSequence=0;r.lastFrame=0;send(r.guest,{type:'start',characters:m.characters});send(r.host,{type:'started'});return;}
 if(!r.started||!r.guest)return;
 if(m.type==='input'&&c===r.guest){if(typeof m.key!=='string'||!legal.has(m.key)||typeof m.pressed!=='boolean')return; // Edge-triggered action relay, explicit key releases.
  if(m.pressed){if(r.heldKeys.has(m.key))return;r.heldKeys.add(m.key);}else{if(!r.heldKeys.has(m.key))return;r.heldKeys.delete(m.key);}send(r.host,{type:'input',key:m.key,pressed:m.pressed});return;}
 if(m.type==='releaseAll'&&c===r.guest){for(const k of r.heldKeys)send(r.host,{type:'input',key:k,pressed:false});r.heldKeys.clear();return;}
 if(m.type==='finisherAudio'&&c===r.host){if(m.sound==='yujiSecret')send(r.guest,{type:'finisherAudio',sound:m.sound});return;}
 if(m.type==='jackpotAudio'&&c===r.host){if(m.action==='start'||m.action==='stop')send(r.guest,{type:'jackpotAudio',action:m.action});return;}
 if(m.type==='domainAudio'&&c===r.host){if(chars.has(m.character))send(r.guest,{type:'domainAudio',character:m.character});return;}
 if(m.type==='frame'&&c===r.host){const now=Date.now();if(now-r.lastFrame<90)return;if(!Number.isSafeInteger(m.sequence)||m.sequence<=r.lastSequence)return;if(typeof m.data!=='string'||!m.data.startsWith('data:image/webp;base64,')||m.data.length>MAX_MESSAGE-100)return;r.lastFrame=now;r.lastSequence=m.sequence;c.framesIn++;
  if(!send(r.guest,{type:'frame',sequence:m.sequence,data:m.data})){
    const dropped=(r.droppedFrames=(r.droppedFrames||0)+1);
    if(dropped===1||dropped%60===0)console.warn('Frame dropped (slow guest)',r.code,'count='+dropped);
  }return;}
}
// RFC 6455 reader: browser clients may legally fragment WebSocket messages.
// Never disconnect solely because a text payload was split into continuation frames.
function parse(c,buf){
 c.lastActivity=Date.now();
 c.buffer=Buffer.concat([c.buffer,buf]);
 while(c.buffer.length>=2){
  const b=c.buffer,opcode=b[0]&15,fin=!!(b[0]&0x80),rsv=b[0]&0x70;
  const masked=!!(b[1]&128);let n=b[1]&127,pos=2;
  if(rsv||!masked)return destroy(c,'invalid_websocket_header');
  if(n===126){if(b.length<4)return;n=b.readUInt16BE(2);pos=4;}
  else if(n===127){if(b.length<10)return;const big=b.readBigUInt64BE(2);if(big>BigInt(MAX_MESSAGE))return destroy(c,'oversized_frame');n=Number(big);pos=10;}
  if(n>MAX_MESSAGE)return destroy(c,'oversized_frame');
  if(b.length<pos+4+n)return;
  const mask=b.subarray(pos,pos+4),payload=Buffer.from(b.subarray(pos+4,pos+4+n));
  c.buffer=b.subarray(pos+4+n);
  for(let i=0;i<payload.length;i++)payload[i]^=mask[i&3];
  c.lastActivity=Date.now();
  if(opcode>=8){
   if(!fin||n>125)return destroy(c,'invalid_control_frame');
   if(opcode===8){
    const code=payload.length>=2?payload.readUInt16BE(0):1005;
    frameControl(c,8,payload);return destroy(c,'browser_close_'+code);
   }
   if(opcode===9){frameControl(c,10,payload);continue;}
   if(opcode===10){c.awaitPong=0;continue;}
   return destroy(c,'unknown_control_frame');
  }
  if(opcode===1){
   if(c.fragmentParts)return destroy(c,'unexpected_new_text_frame');
   if(fin){try{handle(c,JSON.parse(payload.toString('utf8')));}catch{send(c,{type:'error',message:'Invalid JSON message.'});}}
   else{c.fragmentParts=[payload];c.fragmentBytes=payload.length;}
  }else if(opcode===0){
   if(!c.fragmentParts)return destroy(c,'unexpected_continuation');
   c.fragmentBytes+=payload.length;
   if(c.fragmentBytes>MAX_MESSAGE)return destroy(c,'oversized_fragmented_message');
   c.fragmentParts.push(payload);
   if(fin){const parts=c.fragmentParts;c.fragmentParts=null;c.fragmentBytes=0;
    try{handle(c,JSON.parse(Buffer.concat(parts).toString('utf8')));}catch{send(c,{type:'error',message:'Invalid JSON message.'});}}
  }else return destroy(c,'unsupported_opcode_'+opcode);
 }
 if(c.buffer.length>MAX_MESSAGE+16)destroy(c,'input_buffer_limit');
}
const server=http.createServer((req,res)=>{if(req.method!=='GET'){res.writeHead(405);res.end();return;}if(req.url==='/tuca_donka.mp3'){
  const file=path.join(__dirname,'tuca_donka.mp3');
  if(!fs.existsSync(file)){res.writeHead(404);res.end('Add a licensed tuca_donka.mp3 file alongside index.html');return;}
  const size=fs.statSync(file).size,range=req.headers.range;
  if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!match){res.writeHead(416);res.end();return;}
    const first=match[1]?Number(match[1]):0,last=match[2]?Number(match[2]):size-1;
    const start=Math.min(first,size-1),end=Math.min(last,size-1);
    if(first>=size||start>end){res.writeHead(416,{'content-range':`bytes */${size}`});res.end();return;}
    res.writeHead(206,{'content-type':'audio/mpeg','accept-ranges':'bytes','content-range':`bytes ${start}-${end}/${size}`,'content-length':end-start+1,'cache-control':'public,max-age=3600'});
    fs.createReadStream(file,{start,end}).pipe(res);return;
  }
  res.writeHead(200,{'content-type':'audio/mpeg','accept-ranges':'bytes','content-length':size});fs.createReadStream(file).pipe(res);return;
 }if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({ok:true,build:BUILD_ID,rooms:rooms.size,connections:connections.size,uptimeSeconds:Math.round(process.uptime())}));return;}if(req.url==='/'||req.url.startsWith('/?')||req.url==='/index.html'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache','x-content-type-options':'nosniff'});res.end(HTML);return;}res.writeHead(404);res.end('Not found');});
server.on('upgrade',(req,socket,head)=>{if(req.url!=='/ws'||req.headers.upgrade?.toLowerCase()!=='websocket'||!req.headers['sec-websocket-key'])return socket.destroy();if(connections.size>1100)return socket.destroy();const origin=req.headers.origin; // Restrict browser cross-origin WebSockets when origin supplied.
 if(origin){try{const u=new URL(origin);if(u.host!==req.headers.host)return socket.destroy();}catch{return socket.destroy();}}
 const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');const c={socket,buffer:Buffer.alloc(0),room:null,role:null,dead:false,awaitPong:0,connectedAt:Date.now(),lastActivity:Date.now(),framesIn:0,fragmentParts:null,fragmentBytes:0};connections.add(c);socket.on('data',buf=>parse(c,buf));socket.on('end',()=>{c.endSeen=true;});socket.on('close',(hadError)=>destroy(c,hadError?'socket_close_error':(c.endSeen?'tcp_fin_from_peer':'tcp_connection_lost')));socket.on('error',err=>{console.error('WebSocket error:',c.role||'unassigned',c.room?.code||'no-room',err.code||'',err.message);destroy(c,'socket_error_'+(err.code||'unknown'));});if(head.length)parse(c,head);});
setInterval(()=>{for(const c of connections){if(c.awaitPong>=5){destroy(c,'heartbeat_timeout_150s');continue;}c.awaitPong=(c.awaitPong||0)+1;frameControl(c,9);}for(const r of rooms.values()){if(!r.guest&&Date.now()-r.created>ROOM_TIMEOUT){send(r.host,{type:'error',message:'Unused room expired.'});leave(r.host);}}},30000).unref();
process.on('SIGTERM',()=>{console.warn('Render/platform issued SIGTERM: shutting down active connections');server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref();});
process.on('unhandledRejection',e=>console.error('Unhandled rejection',e));
server.listen(PORT,HOST,()=>console.log(`Cursed Clash ${BUILD_ID} multiplayer at http://localhost:${PORT}`));
