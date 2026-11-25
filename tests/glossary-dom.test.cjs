'use strict';
// DOM/unit harness, not a browser layout test.
// Usage: node tests/glossary-dom.test.cjs [dist-directory] [report-json]
// Reports are written only when report-json is explicitly provided.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const projectRoot=path.resolve(__dirname,'..');
const dist=path.resolve(process.argv[2]||(fs.existsSync(path.join(projectRoot,'dist','index.html'))?path.join(projectRoot,'dist'):projectRoot));
const REPORT=process.argv[3]?path.resolve(process.argv[3]):null;
const observers=[],frames=new Map();let frameId=0;
function notify(target,type='childList',attributeName){for(const o of observers)for(const [root,opt]of o.roots)if((target===root||opt.subtree&&root.contains(target))&&(type!=='attributes'||opt.attributes&&(!opt.attributeFilter||opt.attributeFilter.includes(attributeName)))){o.records.push({target,type,attributeName});break}}
class MockNode{
  constructor(type){this.nodeType=type;this.childNodes=[];this.parentNode=null;this.listeners=new Map()}
  get parentElement(){return this.parentNode?.nodeType===1?this.parentNode:null}
  get firstChild(){return this.childNodes[0]||null}
  get textContent(){return this.nodeType===3?this.data:this.childNodes.map(n=>n.textContent).join('')}
  set textContent(value){if(this.nodeType===3){this.data=String(value);notify(this,'characterData');return}for(const n of this.childNodes)n.parentNode=null;this.childNodes=[];if(value!=='')this.appendChild(new Text(String(value)));notify(this)}
  appendChild(node){if(node.nodeType===11){for(const n of [...node.childNodes])this.appendChild(n);return node}node.remove();this.childNodes.push(node);node.parentNode=this;notify(this);return node}
  append(...nodes){for(const node of nodes)this.appendChild(typeof node==='string'?new Text(node):node)}
  prepend(...nodes){for(const node of [...nodes].reverse()){node.remove();this.childNodes.unshift(node);node.parentNode=this}notify(this)}
  before(...nodes){if(!this.parentNode)return;const p=this.parentNode,i=p.childNodes.indexOf(this);const flat=nodes.flatMap(n=>n.nodeType===11?[...n.childNodes]:[n]);for(const n of flat)n.remove();p.childNodes.splice(i,0,...flat);for(const n of flat)n.parentNode=p;notify(p)}
  remove(){if(this.parentNode){const p=this.parentNode;p.childNodes.splice(p.childNodes.indexOf(this),1);this.parentNode=null;notify(p)}}
  replaceWith(...nodes){const p=this.parentNode;if(!p)return;const i=p.childNodes.indexOf(this),flat=nodes.flatMap(n=>n.nodeType===11?[...n.childNodes]:[n]);for(const n of flat)n.remove();p.childNodes.splice(i,1,...flat);this.parentNode=null;for(const n of flat)n.parentNode=p;notify(p)}
  contains(node){for(let n=node;n;n=n.parentNode)if(n===this)return true;return false}
  normalize(){for(const child of [...this.childNodes])child.normalize();for(let i=0;i<this.childNodes.length-1;)if(this.childNodes[i].nodeType===3&&this.childNodes[i+1].nodeType===3){this.childNodes[i].data+=this.childNodes[i+1].data;this.childNodes[i+1].remove()}else i++}
  addEventListener(name,callback,options){const list=this.listeners.get(name)||[];list.push({callback,capture:options===true||!!options?.capture});this.listeners.set(name,list)}
  removeEventListener(name,callback){this.listeners.set(name,(this.listeners.get(name)||[]).filter(x=>x.callback!==callback))}
}
class Text extends MockNode{constructor(data){super(3);this.data=data}normalize(){}}
const dataName=name=>'data-'+name.replace(/[A-Z]/g,c=>'-'+c.toLowerCase());
function selectorParts(selector){let level=0,part='',out=[];for(const c of selector){if(c==='['||c==='(')level++;if(c===']'||c===')')level--;if(c===','&&!level){out.push(part.trim());part=''}else part+=c}if(part.trim())out.push(part.trim());return out}
function matchesSimple(el,selector){
  let rejected=false;
  selector=selector.replace(/:not\(([^()]*)\)/g,(_,inner)=>{if(el.matches(inner))rejected=true;return ''});if(rejected)return false;
  selector=selector.replace(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g,(_,name,a,b,c)=>{if(!el.hasAttribute(name)||(a??b??c)!==undefined&&el.getAttribute(name)!==(a??b??c))rejected=true;return ''});if(rejected)return false;
  const ids=[...selector.matchAll(/#([\w-]+)/g)].map(x=>x[1]);if(ids.some(id=>el.id!==id))return false;
  const classes=[...selector.matchAll(/\.([\w-]+)/g)].map(x=>x[1]);if(classes.some(c=>!el.classList.contains(c)))return false;
  const tag=selector.replace(/[#.][\w-]+/g,'').trim();return !tag||tag==='*'||el.tagName===tag.toUpperCase();
}
function matchesComplex(el,selector){const parts=selector.trim().split(/\s+(?![^\[]*\])/);let cursor=el;if(!matchesSimple(cursor,parts.pop()))return false;while(parts.length){const part=parts.pop();cursor=cursor.parentElement;while(cursor&&!matchesSimple(cursor,part))cursor=cursor.parentElement;if(!cursor)return false}return true}
const decode=text=>text.replace(/&(?:amp|lt|gt|quot|#39|#\d+);/g,m=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[m]||String.fromCharCode(Number(m.slice(2,-1)))));
class Element extends MockNode{
  constructor(tag){super(1);this.tagName=tag.toUpperCase();this.attrs=new Map();this.style={setProperty(name,value){this[name]=value}};this.clientWidth=700;this.clientHeight=300;this.dataset=new Proxy({}, {get:(_,name)=>this.getAttribute(dataName(name))??undefined,set:(_,name,value)=>{this.setAttribute(dataName(name),String(value));return true},has:(_,name)=>this.hasAttribute(dataName(name))});this.classList={contains:c=>this.className.split(/\s+/).includes(c),add:(...cs)=>{this.className=[...new Set([...this.className.split(/\s+/).filter(Boolean),...cs])].join(' ')},remove:c=>{this.className=this.className.split(/\s+/).filter(x=>x!==c).join(' ')},toggle:(c,on)=>{on=on===undefined?!this.classList.contains(c):on;on?this.classList.add(c):this.classList.remove(c);return on}}}
  setAttribute(n,v){this.attrs.set(n,String(v));notify(this,'attributes',n)}getAttribute(n){return this.attrs.get(n)??null}hasAttribute(n){return this.attrs.has(n)}removeAttribute(n){this.attrs.delete(n);notify(this,'attributes',n)}
  get id(){return this.getAttribute('id')||''}set id(v){this.setAttribute('id',v)}get className(){return this.getAttribute('class')||''}set className(v){this.setAttribute('class',v)}
  get hidden(){return this.hasAttribute('hidden')}set hidden(v){v?this.setAttribute('hidden',''):this.removeAttribute('hidden')}
  get open(){return this.hasAttribute('open')}set open(v){v?this.setAttribute('open',''):this.removeAttribute('open')}
  get value(){return this.getAttribute('value')||''}set value(v){this.setAttribute('value',v)}get tabIndex(){return Number(this.getAttribute('tabindex')??-1)}set tabIndex(v){this.setAttribute('tabindex',v)}
  matches(selector){return selectorParts(selector).some(s=>matchesComplex(this,s))}
  closest(selector){for(let e=this;e;e=e.parentElement)if(e.matches(selector))return e;return null}
  querySelectorAll(selector){const result=[];const walk=n=>{for(const child of n.childNodes)if(child.nodeType===1){if(child.matches(selector))result.push(child);walk(child)}};walk(this);return result}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null}
  set innerHTML(html){for(const n of this.childNodes)n.parentNode=null;this.childNodes=[];const stack=[this],voids=new Set(['INPUT','IMG','BR','HR','META','LINK','SOURCE']);for(const token of html.match(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+/g)||[]){if(token.startsWith('<!--'))continue;if(token.startsWith('</')){if(stack.length>1)stack.pop();continue}if(token.startsWith('<')){const match=token.match(/^<([\w-]+)([\s\S]*?)\/?\s*>$/);if(!match)continue;const el=new Element(match[1]);for(const a of match[2].matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g))el.setAttribute(a[1],decode(a[2]??a[3]??a[4]??''));stack.at(-1).appendChild(el);if(!voids.has(el.tagName)&&!token.endsWith('/>'))stack.push(el)}else stack.at(-1).appendChild(new Text(decode(token)))}notify(this)}
  get innerHTML(){return this.childNodes.map(n=>n.nodeType===3?n.data:`<${n.tagName.toLowerCase()} ${[...n.attrs].map(([k,v])=>`${k}="${v}"`).join(' ')}>${n.innerHTML}</${n.tagName.toLowerCase()}>`).join('')}
  focus(){document.activeElement=this}showModal(){this.open=true}close(){this.open=false}
  getBoundingClientRect(){return{left:0,top:0,right:this.clientWidth,bottom:this.clientHeight,width:this.clientWidth,height:this.clientHeight}}
  getContext(){return new Proxy({}, {get:(target,key)=>target[key]||(()=>{}),set:(target,key,value)=>{target[key]=value;return true}})}
}
class Observer{constructor(cb){this.cb=cb;this.roots=new Map();this.records=[];observers.push(this)}observe(root,options){this.roots.set(root,options)}disconnect(){this.roots.clear();this.records=[]}}
const document=new Element('document');document.head=new Element('head');document.body=new Element('body');document.append(document.head,document.body);document.readyState='loading';document.createElement=tag=>new Element(tag);document.createTextNode=text=>new Text(text);document.createDocumentFragment=()=>new MockNode(11);document.getElementById=id=>document.querySelector('#'+id);
document.createTreeWalker=(root,what,filter)=>{const all=[];const walk=n=>{for(const c of n.childNodes){if(c.nodeType===3&&(!filter||filter.acceptNode(c)===1))all.push(c);walk(c)}};walk(root);let i=-1;return{currentNode:null,nextNode(){return this.currentNode=all[++i]||null}}};
document.createRange=()=>{let root,end;return{selectNodeContents(n){root=n},setEndBefore(n){end=n},toString(){let text='',stopped=false;const walk=n=>{if(n===end){stopped=true;return}if(stopped)return;if(n.nodeType===3)text+=n.data;else for(const c of n.childNodes)walk(c)};walk(root);return text}}};
const storage=new Map(),localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value))};
let answerClicks=0,dialogCalls=0,speechStops=0;const savedProfiles=[];
const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const A={esc:escape,icon:()=>'', $:(selector,root=document)=>root.querySelector(selector),route:'practice',state:{profile:{importantTermsHidden:false}},save(){savedProfiles.push(JSON.parse(JSON.stringify(this.state.profile)));localStorage.setItem('benrishi-lab-v1',JSON.stringify(this.state))},stopSpeech(){speechStops++},speakQueue(){},toast(){},go(){},laws:{setReadingMode(){}},dialog(title,body){dialogCalls++;const d=document.querySelector('#app-dialog');d.innerHTML=body;d.showModal()}};
const context={console,document,localStorage,Map,Set,Intl,Array,String,Number,Math,Date,JSON,Response,DecompressionStream,URL,Node:{TEXT_NODE:3,ELEMENT_NODE:1},NodeFilter:{SHOW_TEXT:4,FILTER_REJECT:2,FILTER_ACCEPT:1},HTMLElement:Element,MutationObserver:Observer,App:A,SiteArt:{img:()=>'<img class="glossary-art" alt="" src="library.webp">'},getComputedStyle:el=>({position:el.style.position||'static',pointerEvents:el.style.pointerEvents||(el.tagName==='CANVAS'?'none':'auto')}),fetch:async url=>new Response(fs.readFileSync(path.join(dist,String(url).replace(/^\.\//,'')))),requestAnimationFrame:callback=>{const id=++frameId;frames.set(id,callback);return id},cancelAnimationFrame:id=>frames.delete(id),setTimeout,clearTimeout,performance};
context.window=context;context.addEventListener=()=>{};context.removeEventListener=()=>{};context.devicePixelRatio=1;
function event(type,target,extra={}){const e={type,target,defaultPrevented:false,stopped:false,preventDefault(){this.defaultPrevented=true},stopImmediatePropagation(){this.stopped=true},...extra};const handlers=document.listeners.get(type)||[];for(const h of handlers.filter(x=>x.capture)){h.callback(e);if(e.stopped)return e}for(const h of handlers.filter(x=>!x.capture)){h.callback(e);if(e.stopped)return e}return e}
async function settle(){await new Promise(resolve=>setImmediate(resolve));for(let turn=0;turn<12;turn++){let work=false;for(const o of observers)if(o.records.length){const records=o.records.splice(0);o.cb(records);work=true}if(frames.size){const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback();work=true}if(!work)return;await Promise.resolve()}throw Error('Mutation/animation work did not settle')}
document.body.innerHTML='<div id="topbar"><div class="topbar-meta"></div></div><main id="main"><p id="plain">特許請求の範囲と発明。<em>商標</em>の登録。😀 文字順を保つ。</p><p id="marked-static">特<mark data-benrishi-ink="saved">許請</mark>求の範囲と<em>商</em>標。</p><h2 class="quiz-question">発明の新規性を判断する。</h2><button class="choice" data-choice="0"><span class="choice-num">1</span><span>商標の登録を受ける。</span></button><p id="single">植物 法 物 令 法律 物品 命令。</p><nav><p>発明と商標</p></nav><button id="ordinary-button">発明と商標</button><p id="links">特<a href="#">許</a>請求の範囲。</p><div class="law-reader-toolbar"><p>発明と商標</p></div><p id="hidden" hidden>営業秘密と商標。</p><details id="fold"><summary>営業秘密の説明</summary><p id="fold-text">営業秘密と不正競争。</p></details><article id="mark-host"><div class="law-original"><p id="mark-text">特許請求の範囲と発明の新規性を確認する。</p></div></article></main><dialog id="app-dialog"></dialog>';
const fixtureIds=['plain','marked-static','single','links','mark-text'],beforeText=new Map(fixtureIds.map(id=>[id,document.querySelector('#'+id).textContent]));
const boundaryFixtures=[
  ['latest-exact','自動で最新法に置き換わる仕組みではありません。'],
  ['latest-statutes','最新法令を確認する。'],
  ['new-law','新法及び旧法の施行日を確認する。']
];
for(const[id,text]of boundaryFixtures){const p=new Element('p');p.id=id;p.textContent=text;document.querySelector('#main').appendChild(p)}
const latestMarked=new Element('p');latestMarked.id='latest-marked';latestMarked.innerHTML='自動で最<mark data-benrishi-ink="latest-saved">新法</mark>に置き換わる仕組みではありません。';document.querySelector('#main').appendChild(latestMarked);
const compoundFixtures=[
  ['334AC0000000121','36','特許請求の範囲'],['334AC0000000121','77','専用実施権'],
  ['334AC0000000121','78','通常実施権'],['334AC0000000127','25','登録商標'],
  ['334AC0000000123','29_2','実用新案技術評価書'],['345AC0000000048','59','著作者人格権']
].map(([lawId,number,term],i)=>{const law=JSON.parse(fs.readFileSync(path.join(dist,'law-corpus',lawId+'.json')));const article=law.articles.find(a=>a.section==='本則'&&a.number===number);assert(article?.text.includes(term));const p=new Element('p');p.id='compound-'+i;p.textContent=article.text;document.querySelector('#main').appendChild(p);return{element:p,text:article.text,term,lawId,number}});
const existingMark=document.querySelector('#marked-static mark');
document.addEventListener('click',e=>{if(e.target.closest('.choice'))answerClicks++});
vm.createContext(context);for(const filename of ['glossary-study.js','important-terms.js','annotation.js','glossary.js'])vm.runInContext(fs.readFileSync(path.join(dist,filename),'utf8'),context,{filename});
const checks=[];const pass=name=>checks.push(name);
(async()=>{
  event('DOMContentLoaded',document);await A.glossary.load();await settle();assert.equal(A.glossary.size,1242);pass('merged dictionary loads 1242 terms and decorates at startup');
  for(const[id,text]of beforeText)assert.equal(document.querySelector('#'+id).textContent,text,id);
  assert(document.querySelector('#plain .glossary-term[data-term="特許請求の範囲"]'));
  assert.equal(existingMark.parentElement.id,'marked-static');assert.equal(existingMark.textContent,'許請');
  assert.equal(document.querySelectorAll('#marked-static .glossary-term[data-term="特許請求の範囲"]').map(e=>e.textContent).join(''),'特許請求の範囲');
  assert.equal(document.querySelectorAll('#marked-static .glossary-term[data-term="商標"]').map(e=>e.textContent).join(''),'商標');pass('longest matches span existing marks/inline tags with identical textContent and order');
  assert.equal(document.querySelectorAll('#single .glossary-term[data-term="法"]').length,1);assert.equal(document.querySelectorAll('#single .glossary-term[data-term="物"]').length,1);assert.equal(document.querySelectorAll('#single .glossary-term[data-term="令"]').length,1);pass('single-character legal terms only match complete Intl.Segmenter words');
  for(const[id,text]of boundaryFixtures){assert.equal(document.querySelector('#'+id).textContent,text);if(id!=='new-law')assert.equal(document.querySelectorAll('#'+id+' .glossary-term[data-term="新法"]').length,0)}
  assert.equal(document.querySelectorAll('#latest-marked .glossary-term[data-term="新法"]').length,0);assert.equal(latestMarked.textContent,boundaryFixtures[0][1]);assert.equal(latestMarked.querySelector('mark[data-benrishi-ink]').textContent,'新法');assert(document.querySelector('#new-law .glossary-term[data-term="新法"]'));pass('latest-law wording never links embedded 新法, including across an existing mark, while standalone 新法 remains linked');
  for(const fixture of compoundFixtures){assert.equal(fixture.element.textContent,fixture.text);assert(fixture.element.querySelector('.glossary-term[data-term="'+fixture.term+'"]'),fixture.term+' in '+fixture.lawId+':'+fixture.number);assert([...new Intl.Segmenter('ja',{granularity:'word'}).segment(fixture.term)].length>1)}pass('six actual statute passages retain compound legal terms spanning multiple word segments');
  for(const selector of ['nav .glossary-term','#ordinary-button .glossary-term','a .glossary-term','.law-reader-toolbar .glossary-term','.choice-num .glossary-term','#links .glossary-term[data-term="特許請求の範囲"]'])assert.equal(document.querySelectorAll(selector).length,0,selector);pass('navigation, ordinary buttons, links and toolbars remain undecorated');
  const count=document.querySelectorAll('.glossary-term').length;assert.equal(A.glossary.decorate(),0);await settle();assert.equal(document.querySelectorAll('.glossary-term').length,count);assert.equal(document.querySelectorAll('.glossary-term .glossary-term').length,0);pass('repeated decoration is idempotent and MutationObserver work settles');
  document.querySelector('#hidden').hidden=false;document.querySelector('#fold').open=true;await settle();assert(document.querySelector('#hidden .glossary-term'));assert(document.querySelector('#fold-text .glossary-term'));assert.equal(document.querySelectorAll('summary .glossary-term').length,0);pass('revealed hidden text and opened details gain term links');
  const choiceWord=document.querySelector('.choice .glossary-term');assert.equal(choiceWord.hasAttribute('role'),false);assert.equal(choiceWord.hasAttribute('tabindex'),false);
  const click=event('click',choiceWord);await settle();assert(click.defaultPrevented&&click.stopped);assert.equal(answerClicks,0);assert.equal(document.querySelector('#glossary-search').value,choiceWord.dataset.term);assert.equal(A.glossary.mode,false);pass('one tap opens dictionary with mode off and stops choice selection');
  document.querySelector('#app-dialog').close();event('click',document.querySelector('.choice'));assert.equal(answerClicks,1);pass('ordinary choice button clicks still select an answer');
  for(const key of ['Enter',' ']){document.querySelector('#app-dialog').close();const word=document.querySelector('#plain .glossary-term');assert.equal(word.getAttribute('role'),'button');assert.equal(word.tabIndex,0);const pressed=event('keydown',word,{key});await settle();assert(pressed.defaultPrevented&&pressed.stopped);assert.equal(document.querySelector('#glossary-search').value,word.dataset.term)}pass('normal text terms support Enter and Space');
  await A.glossary.open('発明');await settle();assert.equal(document.querySelectorAll('.glossary-art').length,1);const related=document.querySelector('.glossary-summary .glossary-term');assert(related);const next=related.dataset.term;event('click',related);await settle();assert.equal(document.querySelector('#glossary-search').value,next);const back=document.querySelector('[data-glossary-back]');assert(back);event('click',back);await settle();assert.equal(document.querySelector('#glossary-search').value,'発明');pass('dictionary explanations are linked, library art appears, and previous-term history works');
  await A.glossary.open('絶対に未収録の試験専用語');await settle();assert(document.querySelector('#app-dialog').textContent.includes('説明は未収録'));assert(!document.querySelector('.glossary-entry'));document.querySelector('#app-dialog').close();pass('unknown words remain explicitly unrecorded without guessed definitions');
  await A.glossary.open();await settle();event('click',document.querySelector('[data-glossary-mode]'));await settle();assert.equal(A.glossary.mode,true);
  const latest=document.querySelector('#latest-exact'),latestText=latest.childNodes.find(n=>n.nodeType===3&&n.data.includes('最新'));document.caretPositionFromPoint=()=>({offsetNode:latestText,offset:latestText.data.indexOf('新')});event('click',latest,{clientX:1,clientY:1});await settle();assert.equal(document.querySelector('#glossary-search').value,'最新');assert(document.querySelector('#app-dialog').textContent.includes('説明は未収録'));A.glossary.disable();document.querySelector('#app-dialog').close();delete document.caretPositionFromPoint;pass('manual word lookup uses the same boundaries and does not reinterpret 最新 as 新法');
  const host=document.querySelector('#mark-host'),surface=host.querySelector('.law-original'),text=surface.textContent;let hash=2166136261;for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);const version=text.length+'-'+(hash>>>0).toString(36);const mark={id:'offset-test',start:1,end:5,color:'#f5c451'};localStorage.setItem(context.AnnotationLayer.storageKey,JSON.stringify({version:1,pages:{'qa:marks':{versions:{[version]:{marks:[mark],drawings:{}}}}}}));
  let annotation=context.AnnotationLayer.mount({host,key:'qa:marks'});surface.before(annotation.toolbar);await settle();assert.equal(surface.textContent,text);assert.equal(surface.querySelectorAll('mark[data-benrishi-ink]').map(n=>n.textContent).join(''),text.slice(1,5));assert.equal(annotation.getState().marks[0].start,1);assert.equal(annotation.getState().marks[0].end,5);assert(surface.querySelector('.glossary-term[data-term="特許請求の範囲"]'));
  const word=surface.querySelector('.glossary-term');annotation.setMode('pen');const calls=dialogCalls;event('click',word);await settle();assert.equal(dialogCalls,calls);annotation.setMode('select');event('click',word);await settle();assert.equal(dialogCalls,calls+1);document.querySelector('#app-dialog').close();pass('real AnnotationLayer preserves saved character offsets and blocks term activation while drawing');
  annotation.destroy();await settle();assert.equal(surface.textContent,text);assert.equal(surface.querySelectorAll('mark[data-benrishi-ink]').length,0);annotation=context.AnnotationLayer.mount({host,key:'qa:marks'});await settle();assert.equal(surface.textContent,text);assert.equal(surface.querySelectorAll('mark[data-benrishi-ink]').map(n=>n.textContent).join(''),text.slice(1,5));annotation.destroy();await settle();pass('real AnnotationLayer unwrap/re-render/remount preserves word links and exact marked characters');

  const important=new Set(context.IMPORTANT_LEGAL_TERMS),studyTerms=new Set(context.STUDY_GLOSSARY.map(entry=>entry.term));
  assert.equal(important.size,147);assert.equal(A.glossary.importantCount,147);assert(context.IMPORTANT_LEGAL_TERMS.every(term=>studyTerms.has(term)));
  for(const term of ['特許請求の範囲','専用実施権','新規性','進歩性'])assert(important.has(term));
  for(const term of ['要件','効果','規定','期間','期限','適用','認定','判断','保護','利用','原則','例外'])assert(!important.has(term));
  assert(document.querySelector('#plain .glossary-term[data-term="特許請求の範囲"]').classList.contains('important-term'));
  assert(!document.querySelector('#plain .glossary-term[data-term="登録"]').classList.contains('important-term'));
  assert.equal(document.querySelectorAll('#main .is-important-hidden').length,0);pass('147 explicitly selected study terms are emphasized while general reading words remain ordinary');

  const originalBlocks=[...document.querySelectorAll('#main p,#main h2,#main .choice')].filter(block=>!block.closest('[data-glossary-ui]')).map(block=>({block,text:block.textContent}));
  const assertTextIntact=()=>{for(const original of originalBlocks)assert.equal(original.block.textContent,original.text);const range=document.createRange();range.selectNodeContents(surface);assert.equal(range.toString(),text)};
  const accessibleText=node=>{if(node.nodeType===3)return node.data;if(node.getAttribute?.('aria-hidden')==='true')return '';if(node.hasAttribute?.('aria-label'))return node.getAttribute('aria-label');return node.childNodes.map(accessibleText).join('')};
  const toggle=document.querySelector('[data-important-toggle]'),reset=document.querySelector('[data-important-reset]');
  event('click',toggle);await settle();assert.equal(A.state.profile.importantTermsHidden,true);assert.equal(savedProfiles.at(-1).importantTermsHidden,true);assert.equal(reset.disabled,false);
  const hiddenWord=document.querySelector('#plain .glossary-term[data-term="特許請求の範囲"]');
  assert(hiddenWord.classList.contains('is-important-hidden'));assert.equal(hiddenWord.getAttribute('aria-label'),'隠された重要語句');assert.equal(hiddenWord.getAttribute('aria-haspopup'),null);assert.equal(hiddenWord.querySelector('.important-term-text').getAttribute('aria-hidden'),'true');
  for(const name of ['aria-label','aria-description'])assert(!hiddenWord.getAttribute(name).includes(hiddenWord.dataset.term));assert(!hiddenWord.title.includes(hiddenWord.dataset.term));
  const option=document.querySelector('.choice'),hiddenChoice=option.querySelector('.important-term');
  assert.equal(hiddenChoice.getAttribute('role'),'img');assert.equal(hiddenChoice.hasAttribute('tabindex'),false);assert(!accessibleText(option).includes(hiddenChoice.dataset.term));assert(accessibleText(option).includes('隠された重要語句'));
  assertTextIntact();pass('bulk hiding persists profile state and removes answers from titles and accessible names without changing text or Range offsets');

  const dialogsBeforeReveal=dialogCalls,answersBeforeReveal=answerClicks,stopsBeforeReveal=speechStops;
  const reveal=event('click',hiddenChoice);await settle();assert(reveal.defaultPrevented&&reveal.stopped);assert.equal(dialogCalls,dialogsBeforeReveal);assert.equal(answerClicks,answersBeforeReveal);assert.equal(speechStops,stopsBeforeReveal);assert(!hiddenChoice.classList.contains('is-important-hidden'));assert(accessibleText(option).includes(hiddenChoice.dataset.term));
  event('click',hiddenChoice);await settle();assert.equal(dialogCalls,dialogsBeforeReveal+1);assert.equal(answerClicks,answersBeforeReveal);assert.equal(document.querySelector('#glossary-search').value,hiddenChoice.dataset.term);assert.equal(A.state.profile.importantTermsHidden,true);
  assert(document.querySelector('#app-dialog .important-term'));assert.equal(document.querySelectorAll('#app-dialog .is-important-hidden').length,0);document.querySelector('#app-dialog').close();
  event('click',reset);await settle();assert(hiddenChoice.classList.contains('is-important-hidden'));assertTextIntact();pass('hidden choice tap reveals only the answer, a second tap opens the readable dictionary, and reset masks it again without selecting an answer');

  const splitParts=document.querySelectorAll('#marked-static .glossary-term[data-term="特許請求の範囲"]');assert(splitParts.length>1);
  const splitGroup=splitParts[0].dataset.glossaryGroup;assert(splitParts.every(part=>part.dataset.glossaryGroup===splitGroup&&part.classList.contains('is-important-hidden')));
  assert.equal(splitParts.filter(part=>part.hasAttribute('aria-label')).length,1);assert(splitParts.slice(1).every(part=>part.getAttribute('aria-hidden')==='true'));
  const beforeSplit=dialogCalls;event('click',splitParts[1]);await settle();assert(splitParts.every(part=>!part.classList.contains('is-important-hidden')));assert(hiddenWord.classList.contains('is-important-hidden'));assert.equal(dialogCalls,beforeSplit);assert.equal(existingMark.textContent,'許請');assertTextIntact();
  event('click',reset);await settle();assert(splitParts.every(part=>part.classList.contains('is-important-hidden')));pass('one occurrence reveals all fragments across an existing mark while other occurrences stay hidden and screen-reader names are not repeated');

  for(const key of ['Enter',' ']){event('click',reset);await settle();const before=dialogCalls;const pressed=event('keydown',hiddenWord,{key});await settle();assert(pressed.defaultPrevented&&pressed.stopped);assert(!hiddenWord.classList.contains('is-important-hidden'));assert.equal(dialogCalls,before)}
  event('click',toggle);await settle();assert.equal(A.state.profile.importantTermsHidden,false);assert.equal(savedProfiles.at(-1).importantTermsHidden,false);assert.equal(document.querySelectorAll('#main .is-important-hidden').length,0);assertTextIntact();
  event('click',toggle);await settle();assert.equal(A.state.profile.importantTermsHidden,true);assert(hiddenWord.classList.contains('is-important-hidden'));assertTextIntact();pass('Enter and Space reveal hidden words, and bulk show/hide restores every occurrence without altering paragraph text');

  annotation=context.AnnotationLayer.mount({host,key:'qa:marks'});await settle();annotation.setMode('pen');const maskedDuringInk=surface.querySelector('.important-term'),dialogsDuringInk=dialogCalls;event('click',maskedDuringInk);await settle();assert(maskedDuringInk.classList.contains('is-important-hidden'));assert.equal(dialogCalls,dialogsDuringInk);
  annotation.setMode('select');event('click',maskedDuringInk);await settle();assert(!maskedDuringInk.classList.contains('is-important-hidden'));assert.equal(dialogCalls,dialogsDuringInk);event('click',reset);await settle();
  assert.equal(annotation.getState().marks[0].start,1);assert.equal(annotation.getState().marks[0].end,5);assert.equal(surface.querySelectorAll('mark[data-benrishi-ink]').map(n=>n.textContent).join(''),text.slice(1,5));assertTextIntact();annotation.destroy();await settle();pass('drawing mode blocks hidden-answer activation and real saved annotation offsets survive hide, reveal, reset and teardown');

  event('click',hiddenWord);await settle();assert(!hiddenWord.classList.contains('is-important-hidden'));
  A.route='laws/334AC0000000121/36';A.glossary.decorate();await settle();assert(hiddenWord.classList.contains('is-important-hidden'));assert.equal(A.state.profile.importantTermsHidden,true);
  const followed=new Element('p');followed.textContent='新規性と進歩性を確認する。';document.querySelector('#main').appendChild(followed);await settle();assert(followed.querySelectorAll('.important-term').every(word=>word.classList.contains('is-important-hidden')));assert.equal(followed.textContent,'新規性と進歩性を確認する。');
  event('click',followed.querySelector('.important-term'));await settle();assert(!followed.querySelector('.important-term').classList.contains('is-important-hidden'));
  A.state=JSON.parse(localStorage.getItem('benrishi-lab-v1'));A.glossary.syncStudyMode();await settle();assert.equal(A.state.profile.importantTermsHidden,true);assert(followed.querySelector('.important-term').classList.contains('is-important-hidden'));
  A.state={profile:{importantTermsHidden:false}};A.glossary.syncStudyMode();await settle();assert.equal(document.querySelectorAll('#main .is-important-hidden').length,0);assertTextIntact();pass('route changes and asynchronous text rendering honor the saved mode, while profile replacement/import resynchronizes without stale references');

  const importantCss=fs.readFileSync(path.join(dist,'important-terms.css'),'utf8');
  const termRules=[...importantCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match=>match[1].includes('.important-term')&&!match[1].includes('.important-study'));
  assert(termRules.length>0);for(const rule of termRules)assert(!/(?:^|;)\s*(?:font-weight|font-size|font-family|line-height|letter-spacing|word-spacing|display|padding|width|height|margin|transform)\s*:/.test(rule[2]),rule[1]);
  assert(importantCss.includes('color:transparent!important'));assert(importantCss.includes('forced-color-adjust:none'));assert(importantCss.includes('-webkit-text-stroke'));assert(!/transition\s*:/.test(importantCss));pass('term CSS changes only paint properties, preserves glyph metrics, keeps forced-color masks opaque, and introduces no motion');
  const result={passed:true,kind:'DOM/unit harness (browser layout not simulated)',dist,checks:checks.length,terms:A.glossary.size,tests:checks};if(REPORT){fs.mkdirSync(path.dirname(REPORT),{recursive:true});fs.writeFileSync(REPORT,JSON.stringify(result,null,2)+'\n')}console.log(JSON.stringify({...result,tests:undefined,report:REPORT||undefined}));
})().catch(error=>{console.error(error.stack);process.exitCode=1});
