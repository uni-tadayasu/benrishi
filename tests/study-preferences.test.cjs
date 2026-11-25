'use strict';
// Actual app.js normalization/save/export/import in an isolated VM; no production writes.
// Usage: node tests/study-preferences.test.cjs [site-root|dist-directory]
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {resolveTargets}=require('./speech-volume.test.cjs');
const KEY='benrishi-lab-v1';

function makeHarness(appPath,stored){
 const elements=new Map(),all=new Set(),events=new Map(),storage=new Map(),timers=new Map(),blobs=new Map(),downloads=[],motionCalls=[],glossaryCalls=[];
 let timerId=0,blobId=0,motionMode='standard',failNextWrite=false;
 if(stored!==undefined)storage.set(KEY,typeof stored==='string'?stored:JSON.stringify(stored));
 class Element{
  constructor(tag='button'){
   const classes=new Set();this.tag=tag;this.id='';this.dataset={};this.style={};this.attributes={};this.children=[];this.hidden=false;this.value='';this.open=false;all.add(this);
   this.classList={contains:name=>classes.has(name),add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name)),toggle:(name,force)=>{const on=force===undefined?!classes.has(name):force;on?classes.add(name):classes.delete(name);return on}};
  }
  set innerHTML(html){
   this.html=String(html);for(const old of this.children){all.delete(old);if(elements.get('#'+old.id)===old)elements.delete('#'+old.id)}this.children=[];
   for(const match of this.html.matchAll(/<([a-z]+)([^>]*)>/g)){
    const id=match[2].match(/\bid="([^"]+)"/)?.[1],motion=match[2].match(/\bdata-motion-mode="([^"]+)"/)?.[1];if(!id&&!motion)continue;
    const child=new Element(match[1]);child.id=id||'';child.parent=this;child.value=match[2].match(/\bvalue="([^"]*)"/)?.[1]||'';
    if(motion)child.dataset.motionMode=motion;for(const attribute of match[2].matchAll(/\b(aria-[\w-]+)="([^"]*)"/g))child.setAttribute(attribute[1],attribute[2]);
    child.classList.add(...(match[2].match(/\bclass="([^"]*)"/)?.[1]||'').split(/\s+/).filter(Boolean));if(id)elements.set('#'+id,child);this.children.push(child);
   }
  }
  get innerHTML(){return this.html||''}
  setAttribute(key,value){this.attributes[key]=String(value)}
  getAttribute(key){return this.attributes[key]??null}
  removeAttribute(key){delete this.attributes[key];if(key.startsWith('data-'))delete this.dataset[key.slice(5).replace(/-([a-z])/g,(_match,char)=>char.toUpperCase())]}
  closest(query){return query.split(',').some(selector=>selector.trim()===this.tag)?this:this.parent?.closest(query)||null}
  querySelector(query){return elements.get(query)||null}
  querySelectorAll(query){return query==='[data-motion-mode]'?[...all].filter(element=>element.dataset.motionMode):[]}
  appendChild(child){child.parent=this;this.children.push(child);return child}
  remove(){all.delete(this)}
  click(){if(this.tag==='a')downloads.push({name:this.download,blob:blobs.get(this.href)})}
  showModal(){this.open=true}close(){this.open=false}focus(){}addEventListener(){}
 }
 const document=new Element('document');document.body=new Element('body');document.hidden=false;
 for(const id of ['main','sidebar','sidebar-shade','topbar','mobile-nav','toast','speech-dock','app-dialog']){const element=new Element('div');element.id=id;elements.set('#'+id,element)}
 document.createElement=tag=>new Element(tag);document.addEventListener=(name,fn)=>{if(!events.has(name))events.set(name,[]);events.get(name).push(fn)};
 const localStorage={getItem:key=>storage.get(key)||null,setItem(key,value){if(failNextWrite){failNextWrite=false;throw Error('QuotaExceededError')}storage.set(key,String(value))},removeItem:key=>storage.delete(key),key:index=>[...storage.keys()][index]??null,get length(){return storage.size}};
 const context={console,Date,Intl,URL:{createObjectURL(blob){const url='blob:test-'+(++blobId);blobs.set(url,blob);return url},revokeObjectURL:url=>blobs.delete(url)},Blob,document,localStorage,navigator:{onLine:true},location:{hash:'#settings'},
  speechSynthesis:{getVoices:()=>[],addEventListener(){},cancel(){}},
  setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id},clearTimeout:id=>timers.delete(id),setInterval:()=>0,
  SiteMotion:{init({mode}){motionMode=mode;motionCalls.push({kind:'init',mode,profile:context.App.state.profile})},setMode(mode){motionMode=mode;motionCalls.push({kind:'set',mode,profile:context.App.state.profile})},getEffectiveMode:()=>motionMode}
 };
 context.window=context;context.addEventListener=()=>{};context.scrollTo=()=>{};
 vm.createContext(context);const source=fs.readFileSync(appPath,'utf8'),tail=/\}\)\(\);\s*$/;assert(tail.test(source));
 vm.runInContext(source.replace(tail,'window.__preferencesTest={blank,normalizedState,save,exportData,importData,renderSettings};})();'),context,{filename:appPath});
 context.App.glossary={syncStudyMode(){glossaryCalls.push({state:context.App.state,hidden:context.App.state.profile.importantTermsHidden})}};
 const test=context.__preferencesTest;
 const restore=async backup=>{
  const json=JSON.stringify(backup);await test.importData({size:Buffer.byteLength(json),text:async()=>json});
  const confirm=elements.get('#confirm-restore');assert.equal(typeof confirm?.onclick,'function','Import must produce the real confirmation action');confirm.onclick();
 };
 const clickMotion=value=>{const button=new Element();button.dataset.motionMode=value;for(const fn of events.get('click')||[])fn({target:button,preventDefault(){}})};
 return {context,test,storage,elements,downloads,motionCalls,glossaryCalls,restore,clickMotion,failNextWrite(){failNextWrite=true}};
}

async function run(appPath){
 const h=makeHarness(appPath),{test:t,context}=h;let checks=0;
 assert.equal(context.App.state.profile.motionMode,'standard');assert.equal(context.App.state.profile.importantTermsHidden,false);
 assert.equal(h.motionCalls.length,1);assert.equal(h.motionCalls[0].kind,'init');assert.equal(h.motionCalls[0].profile,context.App.state.profile);checks++;
 for(const mode of ['standard','subtle','off'])for(const hidden of [false,true]){
  const profile=t.normalizedState({profile:{motionMode:mode,importantTermsHidden:hidden}}).profile;
  assert.equal(profile.motionMode,mode);assert.equal(profile.importantTermsHidden,hidden);
  Object.assign(context.App.state.profile,{motionMode:mode,importantTermsHidden:hidden});t.save();
  const saved=JSON.parse(h.storage.get(KEY));assert.equal(saved.profile.motionMode,mode);assert.equal(saved.profile.importantTermsHidden,hidden);checks++;
 }
 for(const value of [undefined,null,'',false,true,0,1,'false','true','OFF',{},[]]){
  const profile=t.normalizedState({profile:{motionMode:value,importantTermsHidden:value}}).profile;
  assert.equal(profile.motionMode,'standard');assert.equal(profile.importantTermsHidden,value===true);checks++;
 }
 Object.assign(context.App.state.profile,{motionMode:'invalid',importantTermsHidden:'true'});t.save();assert.equal(context.App.state.profile.motionMode,'standard');assert.equal(context.App.state.profile.importantTermsHidden,false);checks++;
 for(const [stored,mode,hidden]of [[{profile:{motionMode:'subtle',importantTermsHidden:true}},'subtle',true],[{profile:{}},'standard',false],['{broken-json','standard',false]]){
  const boot=makeHarness(appPath,stored);assert.equal(boot.context.App.state.profile.motionMode,mode);assert.equal(boot.context.App.state.profile.importantTermsHidden,hidden);assert.equal(boot.motionCalls[0].mode,mode);checks++;
 }
 t.renderSettings();h.clickMotion('subtle');assert.equal(context.App.state.profile.motionMode,'subtle');assert.equal(h.motionCalls.at(-1).mode,'subtle');assert.equal(JSON.parse(h.storage.get(KEY)).profile.motionMode,'subtle');checks++;
 Object.assign(context.App.state.profile,{motionMode:'off',importantTermsHidden:true});t.exportData();assert.equal(h.downloads.length,1);
 const backup=JSON.parse(await h.downloads[0].blob.text());assert.equal(backup.app,'benrishi-lab');assert.equal(backup.format,1);assert.equal(backup.state.profile.motionMode,'off');assert.equal(backup.state.profile.importantTermsHidden,true);checks++;
 Object.assign(context.App.state.profile,{motionMode:'standard',importantTermsHidden:false});t.save();const previous=context.App.state;
 await h.restore(backup);assert.notEqual(context.App.state,previous);assert.equal(context.App.state.profile.motionMode,'off');assert.equal(context.App.state.profile.importantTermsHidden,true);
 assert.equal(h.motionCalls.at(-1).mode,'off');assert.equal(h.motionCalls.at(-1).profile,context.App.state.profile);assert.equal(h.glossaryCalls.at(-1).state,context.App.state);assert.equal(h.glossaryCalls.at(-1).hidden,true);
 assert.equal(JSON.parse(h.storage.get(KEY)).profile.motionMode,'off');assert.equal(JSON.parse(h.storage.get(KEY)).profile.importantTermsHidden,true);assert.equal(h.elements.get('#app-dialog').open,false);checks++;
 const reloaded=makeHarness(appPath,JSON.parse(h.storage.get(KEY)));assert.equal(reloaded.motionCalls[0].mode,'off');assert.equal(reloaded.context.App.state.profile.importantTermsHidden,true);checks++;
 const old=JSON.parse(JSON.stringify(backup));delete old.state.profile.motionMode;delete old.state.profile.importantTermsHidden;
 await h.restore(old);assert.equal(context.App.state.profile.motionMode,'standard');assert.equal(context.App.state.profile.importantTermsHidden,false);assert.equal(h.motionCalls.at(-1).mode,'standard');assert.equal(h.glossaryCalls.at(-1).hidden,false);checks++;
 const invalid=JSON.parse(JSON.stringify(backup));invalid.state.profile.motionMode='invalid';invalid.state.profile.importantTermsHidden='false';await h.restore(invalid);
 assert.equal(context.App.state.profile.motionMode,'standard');assert.equal(context.App.state.profile.importantTermsHidden,false);assert.equal(JSON.parse(h.storage.get(KEY)).profile.importantTermsHidden,false);checks++;
 Object.assign(context.App.state.profile,{motionMode:'subtle',importantTermsHidden:true});t.save();const beforeFailure=context.App.state,savedBefore=h.storage.get(KEY),motionCount=h.motionCalls.length,glossaryCount=h.glossaryCalls.length;
 h.failNextWrite();await h.restore(old);assert.equal(context.App.state,beforeFailure);assert.equal(h.storage.get(KEY),savedBefore);assert.equal(h.motionCalls.length,motionCount);assert.equal(h.glossaryCalls.length,glossaryCount);checks++;
 console.log(JSON.stringify({passed:true,checks,app:appPath,coverage:'actual app normalization, startup/init, save, motion button, export, confirmed restore/state replacement, module resync, reload, legacy defaults, invalid values, failed-write rollback'}));
}
if(require.main===module)run(resolveTargets().app).catch(error=>{console.error(error);process.exitCode=1});
