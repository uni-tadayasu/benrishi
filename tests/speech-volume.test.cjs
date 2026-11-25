'use strict';
// Node-only behavior checks. No server, browser, dependencies, or production writes.
// node tests/speech-volume.test.cjs [site-root|dist-directory]
// Optional overrides: --app FILE --law FILE --prosody FILE --speech FILE --corpus DIR
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');

const usage=`Usage: node ${path.basename(__filename)} [SITE_ROOT|DIST_DIR]
  --root DIR / --dist DIR   Explicit site root or dist directory
  --app FILE               app.js override (candidate or regression fixture)
  --law FILE               law-library.js override
  --prosody FILE           prosody-engine.js override
  --speech FILE            speech-engine.js override
  --corpus DIR             law-corpus directory override
With no directory, searches the current directory and the test file's parent.`;

function resolveTargets(argv=process.argv.slice(2),full=false){
 const overrides={};let base;
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];
  if(arg.startsWith('--')){
   const name=arg.slice(2);
   if(!['root','dist','app','law','prosody','speech','corpus'].includes(name))throw Error('Unknown argument: '+arg+'\n'+usage);
   if(!argv[i+1]||argv[i+1].startsWith('--'))throw Error('Missing value for '+arg);
   const value=path.resolve(argv[++i]);
   if(name==='root'||name==='dist'){if(base)throw Error('Specify only one site root or dist directory.');base=value}else overrides[name]=value;
  }else{if(base)throw Error('Specify only one site root or dist directory.');base=path.resolve(arg)}
 }
 const candidates=base?[base]:[process.cwd(),path.resolve(__dirname,'..'),__dirname];let dist;
 for(const candidate of candidates){
  if(fs.existsSync(path.join(candidate,'app.js'))){dist=candidate;break}
  if(fs.existsSync(path.join(candidate,'dist','app.js'))){dist=path.join(candidate,'dist');break}
 }
 if(!dist&&overrides.app)dist=path.dirname(overrides.app);
 if(!dist)throw Error('Cannot locate app.js. Pass the site root or dist directory.\n'+usage);
 const result={dist,app:path.join(dist,'app.js'),law:path.join(dist,'law-library.js'),prosody:path.join(dist,'prosody-engine.js'),speech:path.join(dist,'speech-engine.js'),corpus:path.join(dist,'law-corpus'),...overrides};
 for(const key of full?['app','law','prosody','speech','corpus']:['app'])assert(fs.existsSync(result[key]),`Missing ${key}: ${result[key]}`);
 return result;
}

function createHarness(targets){
 const elements=new Map(),events=new Map(),timers=new Map(),storage=new Map(),scrolls=[],histories=[];
 let timerId=0,now=Date.UTC(2026,10,25),document;
 class Element{
  constructor(tag='button'){
   const classes=new Set();this.tag=tag;this.style={};this.children=[];this.dataset={};this.hidden=false;this.value='';this.attributes={};this.id='';
   this.classList={contains:name=>classes.has(name),add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name)),toggle:name=>classes.has(name)?(classes.delete(name),false):(classes.add(name),true)};
  }
  set innerHTML(html){
   this.html=String(html);for(const old of this.children)if(elements.get('#'+old.id)===old)elements.delete('#'+old.id);this.children=[];
   for(const match of this.html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)){
    const element=new Element(match[1]);element.id=match[2];element.parent=this;element.value=match[0].match(/\bvalue="([^"]*)"/)?.[1]||'';
    const classes=match[0].match(/\bclass="([^"]*)"/)?.[1]||'';element.classList.add(...classes.split(/\s+/).filter(Boolean));
    for(const data of match[0].matchAll(/\bdata-([\w-]+)(?:="([^"]*)")?/g))element.dataset[data[1].replace(/-([a-z])/g,(_m,c)=>c.toUpperCase())]=data[2]||'';
    elements.set('#'+element.id,element);this.children.push(element);
   }
  }
  get innerHTML(){return this.html||''}
  setAttribute(key,value){this.attributes[key]=String(value)}
  contains(element){return element===this||this.children.includes(element)}
  querySelector(query){return document.querySelector(query)}
  querySelectorAll(query){return document.querySelectorAll(query)}
  scrollIntoView(){scrolls.push(this.id)}
  focus(){document.activeElement=this}
  closest(query){
   const matches=query.split(',').some(part=>{
    const selector=part.trim();
    if(selector.startsWith('.'))return this.classList.contains(selector.slice(1));
    if(selector.startsWith('[data-'))return selector.slice(6,-1).replace(/-([a-z])/g,(_m,c)=>c.toUpperCase())in this.dataset;
    return selector===this.tag;
   });
   return matches?this:this.parent?.closest(query)||null;
  }
  addEventListener(){}
 }
 for(const id of ['main','sidebar','sidebar-shade','topbar','mobile-nav','toast','speech-dock','app-dialog']){const element=new Element('div');element.id=id;elements.set('#'+id,element)}
 document={activeElement:null,hidden:false,
  querySelector:query=>elements.get(query)||null,
  querySelectorAll:query=>[...elements.values()].filter(element=>query==='input[data-speech-volume]'?element.tag==='input'&&'speechVolume'in element.dataset:query==='[data-speech-volume-output]'?'speechVolumeOutput'in element.dataset:false),
  addEventListener:(name,fn)=>{if(!events.has(name))events.set(name,[]);events.get(name).push(fn)}
 };
 // Native pause is independent of the app flag: cancel() DOES NOT resume it.
 // speak() while paused queues a record without starting it, making this bug visible.
 const spoken=[],nativeCalls=[];let current=null,cancels=0;
 const synth={speaking:false,pending:false,paused:false,
  getVoices:()=>[{lang:'ja-JP',voiceURI:'local',localService:true}],addEventListener(){},
  speak(utterance){
   nativeCalls.push({type:'speak',paused:this.paused});
   current={u:utterance,end:utterance.onend,error:utterance.onerror,started:!this.paused};spoken.push(current);
   this.speaking=current.started;this.pending=!current.started;
  },
  cancel(){
   nativeCalls.push({type:'cancel',paused:this.paused});cancels++;
   const previous=current;current=null;this.speaking=false;this.pending=false;
   // Deliberately deliver captured callbacks after cancellation to test stale guards.
   if(previous){previous.end?.();previous.error?.({error:'canceled'})}
  },
  pause(){nativeCalls.push({type:'pause'});this.paused=true},
  resume(){nativeCalls.push({type:'resume'});this.paused=false;if(current){current.started=true;this.speaking=true;this.pending=false}}
 };
 class ClockDate extends Date{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
 const context={console,Date:ClockDate,Intl,URL,Map,Set,JSON,Math,document,speechSynthesis:synth,
  SpeechSynthesisUtterance:class{constructor(text){this.text=text;this.volume=1}},navigator:{onLine:true},location:{hash:'#home'},
  localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),get length(){return storage.size}},
  setTimeout:(fn,delay=0)=>{const id=++timerId;delay=Math.max(0,Number(delay)||0);timers.set(id,{fn,delay,due:now+delay});return id},clearTimeout:id=>timers.delete(id),setInterval:()=>0,
  FormData:class{constructor(form){this.values=form.values}get(key){return this.values[key]??null}}
 };
 context.window=context;context.self=context;context.addEventListener=()=>{};context.scrollTo=()=>{};
 context.history={replaceState(_a,_b,hash){context.location.hash=hash;histories.push(hash)}};
 vm.createContext(context);
 const original=fs.readFileSync(targets.app,'utf8'),tail=/\}\)\(\);\s*$/;
 assert(tail.test(original),'app.js must end with its IIFE; cannot safely attach test hooks.');
 const code=original.replace(tail,'window.__test={normalizeSpeechVolume,normalizeSpeechPitch,normalizeSpeechStyle,normalizedState,blank,save,speech,speakQueue,stopSpeech,pauseSpeech,setSpeechVolume,renderSettings};})();');
 vm.runInContext(code,context,{filename:targets.app});
 const test=context.__test;
 const fire=(type,target)=>Promise.all((events.get(type)||[]).map(fn=>fn({target,preventDefault(){}})));
 const flush=()=>{let runs=0;for(;;){const due=[...timers].find(([,entry])=>entry.delay===0&&entry.due<=now);if(!due)break;assert(++runs<1000,'Immediate timer loop');timers.delete(due[0]);due[1].fn()}};
 const advanceTimer=id=>{const timer=timers.get(id);assert(timer,'Expected pending timer '+id);timers.delete(id);now=Math.max(now,timer.due);timer.fn()};
 const gapTimer=()=>test.speech.pauseTimer===null?null:[test.speech.pauseTimer,timers.get(test.speech.pauseTimer)];
 const finish=()=>{assert(current,'Expected a current utterance');assert(current.started&&!synth.paused,'Cannot finish audio that has not resumed');const record=current;current=null;synth.speaking=false;synth.pending=false;record.end();return record};
 const microtasks=async()=>{for(let i=0;i<20;i++)await Promise.resolve()};
 return {targets,context,test,Element,elements,events,timers,storage,scrolls,histories,document,synth,spoken,nativeCalls,fire,flush,advanceTimer,gapTimer,finish,microtasks,get cancels(){return cancels}};
}

function runVolumeTests(h){
 const {test:t,context,elements,spoken,document,storage,Element,fire,flush,synth,nativeCalls}=h;
 for(const value of [undefined,null,'',NaN,Infinity,{},[],true,'bad'])assert.equal(t.normalizeSpeechVolume(value),1);
 for(const [value,expected]of [[0,0],['0',0],[-1,0],[2,1],[.38,.38],['0.5',.5]])assert.equal(t.normalizeSpeechVolume(value),expected);
 assert.equal(t.blank().profile.speechVolume,1);
 assert.equal(t.normalizedState({profile:{}}).profile.speechVolume,1);
 assert.equal(t.normalizedState({profile:{speechVolume:0}}).profile.speechVolume,0);
 assert.equal(t.normalizedState({profile:{speechVolume:5}}).profile.speechVolume,1);
 context.App.state.profile.speechVolume=-3;t.save();assert.equal(JSON.parse(storage.get('benrishi-lab-v1')).profile.speechVolume,0);
 t.renderSettings();assert(elements.get('#settings-volume'));
 t.speakQueue([{title:'volume',text:'あ'.repeat(310)}]);assert.equal(spoken.at(-1).u.volume,0);
 for(const label of ['停止','繰り返しなし','音量'])assert(elements.get('#speech-dock').innerHTML.includes(label));
 const initial=spoken.at(-1),initialCount=spoken.length,initialCancels=h.cancels;
 const slider=elements.get('#dock-volume');slider.value='25';slider.focus();fire('input',slider);
 assert.equal(context.App.state.profile.speechVolume,.25);assert.equal(elements.get('#settings-volume').value,'25');assert.equal(elements.get('#dock-volume-value').textContent,'25%');assert.equal(spoken.length,initialCount);assert.equal(h.cancels,initialCancels);
 fire('change',slider);assert.equal(t.speech.chunkIndex,0);assert.equal(spoken.length,initialCount);flush();
 assert.equal(spoken.length,initialCount+1);assert.equal(spoken.at(-1).u.volume,.25);assert.equal(spoken.at(-1).u.text,initial.u.text);
 initial.end();initial.error({error:'network'});assert.equal(t.speech.chunkIndex,0);assert.equal(t.speech.playing,true);
 const beforeRapid=spoken.length;t.setSpeechVolume(.3,true);t.setSpeechVolume(.4,true);flush();assert.equal(spoken.length,beforeRapid+1);assert.equal(spoken.at(-1).u.volume,.4);
 t.pauseSpeech();assert.equal(t.speech.paused,true);assert.equal(document.activeElement.id,'dock-volume');
 const beforePauseChange=spoken.length;t.setSpeechVolume(.2,true);flush();assert.equal(spoken.length,beforePauseChange);assert.equal(t.speech.paused,true);assert.equal(synth.paused,true);
 t.pauseSpeech();assert.equal(t.speech.paused,false);assert.equal(spoken.at(-1).u.volume,.2);assert(spoken.at(-1).started);
 t.setSpeechVolume(.6,true);const beforeStop=spoken.length;t.stopSpeech();flush();assert.equal(spoken.length,beforeStop);assert.equal(t.speech.playing,false);
 t.speakQueue([{title:'old',text:'旧項目'.repeat(100)}]);t.setSpeechVolume(.5,true);t.speakQueue([{title:'new',text:'新しい項目'}]);const beforeNew=spoken.length;flush();assert.equal(spoken.length,beforeNew);assert.equal(spoken.at(-1).u.text,'新しい項目');assert.equal(spoken.at(-1).u.volume,.5);
 t.pauseSpeech();const rate=new Element('select');rate.id='dock-rate';rate.value='1.5';fire('change',rate);flush();assert.equal(t.speech.paused,true);t.pauseSpeech();assert.equal(spoken.at(-1).u.rate,1.5);
 const loop=new Element('select');loop.id='dock-loop';loop.value='all';t.speech.continuous=false;fire('change',loop);assert.equal(t.speech.loop,'all');assert.equal(t.speech.continuous,true);
 const continuous=new Element();continuous.dataset.action='continuous-speech';fire('click',continuous);assert.equal(t.speech.continuous,false);assert.equal(t.speech.loop,'none');
 const form=new Element('form');form.id='speech-settings';form.values={voiceURI:'local',speechRate:'1',customReadings:'',speechVolume:'0'};fire('submit',form);flush();
 assert.equal(context.App.state.profile.speechVolume,0);assert.equal(spoken.at(-1).u.volume,0);assert.equal(JSON.parse(storage.get('benrishi-lab-v1')).profile.speechVolume,0);

 // Regressions: native paused survives cancel(), even though speech.paused resets.
 const assertStartedAfterCancel=(label,callStart,expectedText)=>{
  const calls=nativeCalls.slice(callStart),cancel=calls.findIndex(call=>call.type==='cancel'),resume=calls.findIndex(call=>call.type==='resume'),speak=calls.findIndex(call=>call.type==='speak');
  assert(cancel>=0&&calls[cancel].paused,`${label}: cancellation must exercise a natively paused synthesizer`);
  assert(resume>cancel&&resume<speak,`${label}: resume() must occur after cancellation and before speak()`);
  assert.equal(t.speech.paused,false,label+': application state resumed');assert.equal(synth.paused,false,label+': native synthesizer resumed');
  assert.equal(synth.pending,false,label+': no utterance stuck in the native queue');assert.equal(synth.speaking,true,label+': native audio active');assert.equal(spoken.at(-1).started,true,label+': utterance actually started');assert.equal(spoken.at(-1).u.text,expectedText);
 };
 t.speakQueue([{title:'first',text:'最初の項目'},{title:'second',text:'次の項目'}]);t.pauseSpeech();assert.equal(synth.paused,true);
 const nextStart=nativeCalls.length,nextCount=spoken.length,first=spoken.at(-1),next=new Element();next.dataset.action='next-speech';fire('click',next);
 assert.equal(t.speech.index,1);assert.equal(spoken.length,nextCount+1);assertStartedAfterCancel('pause → next',nextStart,'次の項目');
 first.end();first.error({error:'network'});assert.equal(t.speech.index,1);assert.equal(t.speech.chunkIndex,0);assert.equal(t.speech.playing,true);
 t.pauseSpeech();const newStart=nativeCalls.length,newCount=spoken.length,previous=spoken.at(-1);
 t.speakQueue([{title:'replacement',text:'新しい読み上げ'}]);assert.equal(t.speech.index,0);assert.equal(spoken.length,newCount+1);assertStartedAfterCancel('pause → new queue',newStart,'新しい読み上げ');
 previous.end();previous.error({error:'network'});assert.equal(t.speech.chunkIndex,0);assert.equal(t.speech.playing,true);
 t.pauseSpeech();t.stopSpeech();assert.equal(synth.paused,true,'Manual stop does not silently change native pause state');
 const stoppedStart=nativeCalls.length;t.speakQueue([{text:'停止後の読み上げ'}]);assertStartedAfterCancel('pause → stop → new queue',stoppedStart,'停止後の読み上げ');t.stopSpeech();
 console.log('PASS volume: normalization/load/save/import, mute, slider synchronization, same-chunk restart, stale callbacks, coalescing, pause preservation, rate, loops, labels/focus, settings; native pause → next/new queue/stop then new queue resumes before actual audio.');
}

module.exports={resolveTargets,createHarness,runVolumeTests,usage};
if(require.main===module){
 if(process.argv.includes('--help'))console.log(usage);
 else try{const targets=resolveTargets();console.log('Testing app:',targets.app);runVolumeTests(createHarness(targets))}catch(error){console.error(error);process.exitCode=1}
}
