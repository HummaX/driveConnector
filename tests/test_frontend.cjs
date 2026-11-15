'use strict';
// Browser-like offline smoke test. Complements, but does not replace, real browser tests.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'frontend/js/app.js'), 'utf8');
class FakeNode {
  constructor(tag='div', id='') { this.tagName=tag.toUpperCase(); this.id=id; this.children=[]; this.listeners={}; this.attrs={}; this.style={}; this._text=''; this.value=''; this.open=false; this.paused=true; this.currentTime=0; this.duration=100; this.playbackRate=1; this.playCalls=0; this.className=''; this.classList={ toggle:()=>{}, add:()=>{}, remove:()=>{} }; this.firstChild={nodeValue:''}; }
  set textContent(value){ this._text=String(value); } get textContent(){return this._text;}
  append(...nodes){this.children.push(...nodes)} replaceChildren(...nodes){this.children=[...nodes]}
  add(node){this.children.push(node)} get options(){return this.children}
  addEventListener(type, fn, options){(this.listeners[type]??=[]).push({fn,once:options?.once})}
  dispatch(type, extra={}){ const handlers=[...(this.listeners[type]||[])]; for(const h of handlers){h.fn({currentTarget:this,target:this,preventDefault(){},...extra});if(h.once)this.listeners[type]=this.listeners[type].filter(x=>x!==h)} }
  setAttribute(k,v){this.attrs[k]=String(v)} getAttribute(k){return this.attrs[k]||null} removeAttribute(k){delete this.attrs[k];if(k==='src')this.src=''}
  querySelectorAll(sel){return sel==='track'?this.children.filter(n=>n.tagName==='TRACK'):[]}
  querySelector(){return new FakeNode('button')}
  showModal(){this.open=true} close(){this.open=false;this.dispatch('close')}
  remove(){} focus(){} load(){} pause(){this.paused=true} play(){this.playCalls++;this.paused=false;return Promise.resolve()}
  getBoundingClientRect(){return {left:0,width:300}}
}
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
const elements = new Map(ids.map(id=>[id,new FakeNode(id==='player'?'video':'div',id)]));
elements.get('sort').value='recent'; elements.get('player-quality').value='original'; elements.get('player-audio').value='default'; elements.get('player-gain').value='100';
const avatar=new FakeNode('span');
const document={ getElementById(id){if(!elements.has(id))throw new Error(`Missing DOM element: ${id}`);return elements.get(id)}, createElement(tag){return new FakeNode(tag)},createElementNS(_ns,tag){return new FakeNode(tag)},querySelectorAll(){return []},querySelector(sel){if(sel==='.avatar')return avatar;return null},addEventListener(){},activeElement:null };
const videos=[{video_id:'one',title:'A title <with markup>',status:'LOCAL_READY',local_path:'/mnt/storage/videos/one.mp4',source:'LOCAL',created_at:'2026-01-02'}, {video_id:'two',title:'Cloud recording',status:'REMOTE_ONLY',source:'GDRIVE',created_at:'2026-01-01'}];
const calls=[];
async function fetch(url, options={}){
 calls.push([url,options.method||'GET']); let data;
 if(url==='/api/auth/me')data={username:'admin'};
 else if(url==='/api/videos')data=videos;
 else if(url==='/api/system/metrics')data={disk:{used_gb:2,total_gb:10,free_gb:8,percent:20},cpu:{percent:7,worker_threads:2},ram:{used_gb:4,total_gb:32}};
 else if(url==='/api/videos/one')data=videos[0];
 else if(String(url).endsWith('/probe-tracks'))data={status:'success'};
 else data={};
 return {ok:true,status:200,json:async()=>data,text:async()=>''};
}
class FakeWebSocket { static OPEN=1; constructor(url){this.url=url;this.readyState=1;this.listeners={};FakeWebSocket.instance=this;} addEventListener(type,fn){this.listeners[type]=fn} send(){} emit(data){this.listeners.message({data:JSON.stringify(data)})} }
class Option extends FakeNode {constructor(text,value){super('option');this.textContent=text;this.value=value}}
const localData=new Map();
const localStorage={getItem:k=>localData.get(k)||null,setItem:(k,v)=>localData.set(k,v),removeItem:k=>localData.delete(k)};
const context={document,fetch,WebSocket:FakeWebSocket,location:{protocol:'http:',host:'localhost',origin:'http://localhost',replace(){}},window:{matchMedia(){return {matches:false}}},localStorage,URL,Headers,Option,console, setTimeout(){return 1},clearTimeout(){},setInterval(){return 1},clearInterval(){},confirm(){return false}};
vm.runInNewContext(js,context,{filename:'app.js'});
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
 for(let i=0;i<8;i++)await tick();
 const grid=elements.get('library-grid'); assert.strictEqual(grid.children.length,2,'catalog should render');
 assert.ok(FakeWebSocket.instance,'websocket should connect'); assert.ok(!FakeWebSocket.instance.url.includes('token='),'websocket should not put tokens in URLs');
 const firstCard=grid.children[0]; const poster=firstCard.children[0]; poster.dispatch('click');
 const player=elements.get('player'); assert.strictEqual(player.src,'/api/stream/one'); assert.strictEqual(player.playCalls,1);
 player.paused=true; const src=player.src;
 FakeWebSocket.instance.emit({event:'PROCESSING_COMPLETE',video_id:'one',metadata:{}});
 for(let i=0;i<6;i++)await tick();
 assert.strictEqual(player.playCalls,1,'processing completion must not resume paused playback');
 assert.strictEqual(player.src,src,'processing completion must not replace video source');
 assert.ok(calls.some(([u])=>u==='/api/auth/me'));
 console.log('PASS frontend renders a catalog, avoids token URLs, and preserves paused playback on processing completion.');
})().catch(error=>{console.error(error);process.exitCode=1});
