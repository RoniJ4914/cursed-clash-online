'use strict';
// Dependency-free HTTP/WebSocket relay. One host runs the authoritative match.
const http=require('node:http');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const PORT=Number(process.env.PORT||3000),HOST=process.env.HOST||'0.0.0.0';
const MAX_MESSAGE=850_000,MAX_ROOMS=500,ROOM_TIMEOUT=1000*60*30;
const rooms=new Map(),connections=new Set();
const HTML=fs.readFileSync(path.join(__dirname,'index.html'));
const send=(c,obj)=>{if(!c||c.dead||!c.socket.writable)return false;const data=Buffer.from(JSON.stringify(obj));if(c.socket.writableLength>2_500_000)return false;const header=data.length<126?Buffer.from([129,data.length]):data.length<65536?Buffer.from([129,126,data.length>>8,data.length&255]):Buffer.from([129,127,0,0,0,0,(data.length/0x1000000)&255,(data.length>>16)&255,(data.length>>8)&255,data.length&255]);return c.socket.write(Buffer.concat([header,data]));};
const frameControl=(c,code,bytes=Buffer.alloc(0))=>{if(c.dead||!c.socket.writable)return; c.socket.write(Buffer.concat([Buffer.from([0x80|code,bytes.length]),bytes]));};
function leave(c){const r=c.room;if(!r)return;c.room=null;if(c===r.host){rooms.delete(r.code);if(r.guest){const guest=r.guest;r.guest=null;guest.room=null;send(guest,{type:'peerLeft',reason:'Host closed the room'});}}else if(c===r.guest){r.guest=null;r.started=false;for(const k of r.heldKeys)send(r.host,{type:'input',key:k,pressed:false});r.heldKeys.clear();send(r.host,{type:'peerLeft',reason:'Guest disconnected'});} }
function destroy(c){if(c.dead)return;c.dead=true;connections.delete(c);leave(c);try{c.socket.destroy();}catch{}}
function createCode(){let code;do{code=crypto.randomBytes(5).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);}while(code.length!==6||rooms.has(code));return code;}
const legal=new Set(['np4','np6','np8','np5','np7','np9','np1','np2','np3','np0','npenter','npdecimal','npadd','npsubtract']);
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
 if(m.type==='frame'&&c===r.host){const now=Date.now();if(now-r.lastFrame<35)return;if(!Number.isSafeInteger(m.sequence)||m.sequence<=r.lastSequence)return;if(typeof m.data!=='string'||!m.data.startsWith('data:image/webp;base64,')||m.data.length>MAX_MESSAGE-100)return;r.lastFrame=now;r.lastSequence=m.sequence;send(r.guest,{type:'frame',sequence:m.sequence,data:m.data});return;}
}
function parse(c,buf){c.buffer=Buffer.concat([c.buffer,buf]);while(c.buffer.length>=2){let b=c.buffer,op=b[0]&15,masked=!!(b[1]&128),n=b[1]&127,pos=2;if(!masked)return destroy(c);if(n===126){if(b.length<4)return;n=b.readUInt16BE(2);pos=4;}else if(n===127){if(b.length<10)return;let big=b.readBigUInt64BE(2);if(big>BigInt(MAX_MESSAGE))return destroy(c);n=Number(big);pos=10;}if(n>MAX_MESSAGE)return destroy(c);if(b.length<pos+4+n)return;const mask=b.subarray(pos,pos+4),payload=Buffer.from(b.subarray(pos+4,pos+4+n));c.buffer=b.subarray(pos+4+n);for(let i=0;i<payload.length;i++)payload[i]^=mask[i&3];if(op===8){frameControl(c,8);return destroy(c);}if(op===9){frameControl(c,10,payload);continue;}if(op===10){c.awaitPong=false;continue;}if(op!==1||!(b[0]&0x80))return destroy(c);try{handle(c,JSON.parse(payload.toString('utf8')));}catch{send(c,{type:'error',message:'Invalid JSON message.'});}}if(c.buffer.length>MAX_MESSAGE+16)destroy(c);}
const server=http.createServer((req,res)=>{if(req.method!=='GET'){res.writeHead(405);res.end();return;}if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,rooms:rooms.size}));return;}if(req.url==='/'||req.url.startsWith('/?')||req.url==='/index.html'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache','x-content-type-options':'nosniff'});res.end(HTML);return;}res.writeHead(404);res.end('Not found');});
server.on('upgrade',(req,socket,head)=>{if(req.url!=='/ws'||req.headers.upgrade?.toLowerCase()!=='websocket'||!req.headers['sec-websocket-key'])return socket.destroy();if(connections.size>1100)return socket.destroy();const origin=req.headers.origin; // Restrict browser cross-origin WebSockets when origin supplied.
 if(origin){try{const u=new URL(origin);if(u.host!==req.headers.host)return socket.destroy();}catch{return socket.destroy();}}
 const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');const c={socket,buffer:Buffer.alloc(0),room:null,role:null,dead:false,awaitPong:false};connections.add(c);socket.on('data',buf=>parse(c,buf));socket.on('close',()=>destroy(c));socket.on('error',()=>destroy(c));if(head.length)parse(c,head);});
setInterval(()=>{for(const c of connections){if(c.awaitPong){destroy(c);continue;}c.awaitPong=true;frameControl(c,9);}for(const r of rooms.values()){if(!r.guest&&Date.now()-r.created>ROOM_TIMEOUT){send(r.host,{type:'error',message:'Unused room expired.'});leave(r.host);}}},30000).unref();
server.listen(PORT,HOST,()=>console.log(`Cursed Clash multiplayer at http://localhost:${PORT}`));
