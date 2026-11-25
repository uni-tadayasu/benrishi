(() => {
'use strict';
const A=window.App,{esc,icon,$}=A;
let dataset=null,index=null,loading=null,mode=false,openId=0,current=null;
let termTrie=null,observer=null,decorationFrame=0,decorating=false,started=false,termGroup=0;
const history=[];
const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter('ja',{granularity:'word'}):null;
async function load(){if(index)return index;if(loading)return loading;loading=(async()=>{const compressed=typeof DecompressionStream==='function';const r=await fetch(compressed?'./glossary-data.json.gz':'./glossary-data.json');if(!r.ok)throw Error('missing');dataset=compressed?await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).json():await r.json();const map=new Map();for(const e of dataset.entries||[])map.set(e.term,{...e,definitions:e.definitions||[]});for(const e of window.STUDY_GLOSSARY||[]){const old=map.get(e.term);map.set(e.term,{...old,...e,definitions:old?.definitions||[]})}index=map;buildTermTrie();scheduleDecoration();return map})();try{return await loading}catch(e){loading=null;throw e}}
function updateMode(){document.body.classList.toggle('term-mode',mode);for(const b of document.querySelectorAll('[data-glossary-mode]')){b.classList.toggle('btn-soft',mode);b.setAttribute('aria-pressed',String(mode));const html=icon('book','small-icon')+(mode?'下線のない言葉も調べる：ON':'下線のない言葉も調べる');if(b.innerHTML!==html)b.innerHTML=html}const chip=$('#term-mode-indicator');if(chip)chip.hidden=!mode}
function installControls(){
  const meta=$('.topbar-meta');
  if(meta&&!$('[data-glossary-open]',meta)){const b=document.createElement('button');b.className='btn btn-small glossary-open-button';b.dataset.glossaryOpen='';b.innerHTML=icon('book','small-icon')+'用語辞典';meta.prepend(b)}
  const main=$('#main');
  if(main&&!$('#glossary-inline-hint')){const hint=document.createElement('p');hint.id='glossary-inline-hint';hint.className='small-note glossary-inline-hint';hint.dataset.glossaryUi='';hint.innerHTML=icon('book','small-icon')+'<span>下線の用語をタップすると、意味と読みを確認できます。</span>';main.prepend(hint)}
  if(main&&!$('#term-mode-indicator')){const bar=document.createElement('div');bar.id='term-mode-indicator';bar.className='term-mode-indicator';bar.dataset.glossaryUi='';bar.hidden=!mode;bar.innerHTML=`<span>${icon('book','small-icon')}下線のない言葉も、本文をタップして検索できます。</span><button class="btn btn-small" data-glossary-disable>終了</button>`;main.prepend(bar)}
}

// Only text nodes are split. Marks, inline formatting, and character offsets stay intact.
const READABLE='p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,dd,dt,.quiz-question,.choice,.quote,.prompt-block,.notice-inline,.essential-content,.oral-answer,.glossary-definition-text,.law-source-note';
const SKIP='a,button:not(.choice),input,textarea,select,option,label,form,nav,[role="navigation"],[role="toolbar"],[role="button"]:not(.glossary-term):not(.choice),[contenteditable]:not([contenteditable="false"]),script,style,noscript,svg,canvas,iframe,object,embed,pre,code,summary,[data-annotation-ui],[data-glossary-ui],.annotation-toolbar,.law-reader-toolbar,.law-toc,.quiz-toolbar,.btn-row,.term-mode-indicator,.choice-num,.glossary-word,.dialog-head,.dialog-footer';
const HIDDEN='[hidden],[aria-hidden="true"],details:not([open])';
const DEFINITION_ROOTS='.glossary-summary,.glossary-detail,.glossary-entry .notice-inline,.glossary-definition-text,.glossary-legal p,.glossary-context p';

function buildTermTrie(){
  termTrie={next:new Map()};
  for(const term of index.keys()){
    if(typeof term!=='string'||!term.trim())continue;
    let node=termTrie;
    for(let i=0;i<term.length;i++){if(!node.next.has(term[i]))node.next.set(term[i],{next:new Map()});node=node.next.get(term[i])}
    node.term=term;
  }
}
function matchedTerms(text){
  const boundaries=new Set([0,text.length]),singles=new Set();
  if(segmenter){
    for(const part of segmenter.segment(text)){
      boundaries.add(part.index);boundaries.add(part.index+part.segment.length);
      if(part.isWordLike!==false&&Array.from(part.segment).length===1&&index.has(part.segment))singles.add(part.index+':'+part.segment.length);
    }
  }else{
    // Without a word segmenter, only explicitly separated multi-character terms
    // are safe to link; the dictionary and manual search remain available.
    for(const part of text.matchAll(/[\s\p{Punctuation}]/gu)){boundaries.add(part.index);boundaries.add(part.index+part[0].length)}
  }
  const matches=[];
  for(let start=0;start<text.length;){
    if(!boundaries.has(start)){start++;continue}
    let node=termTrie,best=null;
    for(let end=start;end<text.length;end++){
      node=node.next.get(text[end]);if(!node)break;
      if(node.term&&boundaries.has(end+1)&&(Array.from(node.term).length>1||singles.has(start+':'+node.term.length)))best=node.term;
    }
    if(best){matches.push({start,end:start+best.length,term:best,group:String(++termGroup)});start+=best.length}else start++;
  }
  return matches;
}
function drawingAt(element){
  const surface=element.closest('.law-original,[data-benrishi-reading]');
  const canvas=surface?.querySelector('.annotation-canvas');
  return !!canvas&&(canvas.style.pointerEvents||getComputedStyle(canvas).pointerEvents)!=='none';
}
function textRuns(block){
  const runs=[];let nodes=[],text='';
  const flush=()=>{if(nodes.length)runs.push({nodes,text});nodes=[];text=''};
  const walk=node=>{
    if(node.nodeType===Node.TEXT_NODE){if(node.data){nodes.push({node,start:text.length,end:text.length+node.data.length});text+=node.data}return}
    if(node.nodeType!==Node.ELEMENT_NODE)return;
    if(node!==block&&(node.matches(SKIP)||node.matches(HIDDEN)||node.matches('.glossary-term[data-term]')||node.matches(READABLE)||node.tagName==='BR'||node.tagName==='IMG')){flush();return}
    for(const child of [...node.childNodes])walk(child);
  };
  walk(block);flush();return runs;
}
function makeTermSpan(match,text,first,choice){
  const span=document.createElement('span');span.className='glossary-term';span.dataset.term=match.term;span.dataset.glossaryGroup=match.group;span.textContent=text;
  span.title=match.term+'の意味と読みを確認';
  if(!choice){span.setAttribute('role','button');span.tabIndex=first?0:-1;span.setAttribute('aria-haspopup','dialog');span.setAttribute('aria-label',match.term);span.setAttribute('aria-description','意味と読みを確認')}
  return span;
}
function decorateRoot(root){
  if(!root||!index||!termTrie)return 0;
  const blocks=[...(root.matches?.(READABLE)?[root]:[]),...root.querySelectorAll(READABLE)];let count=0;
  for(const block of blocks){
    if(block.closest(SKIP)||block.closest(HIDDEN)||block.closest('.glossary-term[data-term]')||drawingAt(block))continue;
    const choice=!!block.closest('.choice');
    for(const run of textRuns(block)){
      const matches=matchedTerms(run.text);if(!matches.length)continue;
      let cursor=0;
      for(const item of run.nodes){
        while(cursor<matches.length&&matches[cursor].end<=item.start)cursor++;
        const overlaps=[];for(let i=cursor;i<matches.length&&matches[i].start<item.end;i++)overlaps.push(matches[i]);
        if(!overlaps.length)continue;
        const fragment=document.createDocumentFragment();let local=0;
        for(const match of overlaps){
          const from=Math.max(item.start,match.start)-item.start,to=Math.min(item.end,match.end)-item.start;
          if(from>local)fragment.appendChild(document.createTextNode(item.node.data.slice(local,from)));
          fragment.appendChild(makeTermSpan(match,item.node.data.slice(from,to),match.start>=item.start,choice));count++;local=to;
        }
        if(local<item.node.data.length)fragment.appendChild(document.createTextNode(item.node.data.slice(local)));
        item.node.replaceWith(fragment);
      }
    }
  }
  return count;
}
function observeRoots(){
  if(!observer)return;
  for(const root of [$('#main'),$('#app-dialog')])if(root)observer.observe(root,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['hidden','open']});
  const topbar=$('#topbar');if(topbar)observer.observe(topbar,{childList:true});
}
function decorate(root){
  if(!index||decorating)return 0;
  decorating=true;observer?.disconnect();let count=0;
  try{
    installControls();
    if(root)count+=decorateRoot(root);
    else{
      count+=decorateRoot($('#main'));
      const dialog=$('#app-dialog');
      if(dialog?.open&&dialog.querySelector('#glossary-search'))for(const section of dialog.querySelectorAll(DEFINITION_ROOTS))count+=decorateRoot(section);
    }
  }finally{decorating=false;observeRoots()}
  return count;
}
function scheduleDecoration(){if(!index||decorationFrame)return;decorationFrame=requestAnimationFrame(()=>{decorationFrame=0;decorate()})}
function readWhole(entry){const definitions=entry.definitions?.filter(d=>d.section==='本則')||[],d=definitions[0]||entry.definitions?.[0];let t=(entry.reading||entry.term)+'。';if(entry.summary)t+=entry.summary+'。';if(entry.detail)t+=entry.detail+'。';if(entry.example)t+='例。'+entry.example+'。';if(!entry.summary&&d)t+='法令での定義。'+d.lawTitle+'。'+d.articleTitle+'。'+d.text;return t}
function definitionHTML(entry){const ds=[...(entry.definitions||[])].sort((a,b)=>Number(b.section==='本則')-Number(a.section==='本則'));return ds.length?`<section class="glossary-legal"><div class="section-head"><h3>法令上の定義・略称</h3><span class="pill">${ds.length}件の出典</span></div><p class="small-note">意味が適用される範囲は法律・条文ごとに異なります。原文の条件と参照先を確認してください。</p>${ds.map((d,i)=>`<details ${i===0&&!entry.summary?'open':''}><summary>${esc(d.lawTitle)} ${esc(d.articleTitle)}${d.section!=='本則'?' · '+esc(d.section||'附属規定'):''}<span class="pill ${d.definitionType==='alias'?'blue':'gold'}" style="margin-left:8px">${d.definitionType==='alias'?'略称・呼称':'法定義'}</span></summary><p class="small-note">${esc(d.scopeNote||'この法令における定義')}</p><div class="glossary-definition-text">${esc(d.text)}</div><div class="btn-row"><button class="btn btn-small" data-glossary-definition="${i}">${icon('sound','small-icon')}この原文を読む</button><button class="btn btn-small" data-glossary-nav="laws/${d.lawId}/${d.articleId}">根拠条文を開く</button></div></details>`).join('')}</section>`:''}
function resultsHTML(query){if(!query)return '<p class="small-note">法律用語、一般的な学習語、法令上の定義をまとめて調べられます。</p>';const normalized=query.toLowerCase(),matches=[...index.values()].filter(e=>e.term.toLowerCase().includes(normalized)||(e.reading||'').includes(query)).slice(0,35);return matches.length?`<div class="glossary-suggestions">${matches.map(e=>`<button class="btn btn-small" data-glossary-term="${esc(e.term)}">${esc(e.term)}${e.reading?`<small>${esc(e.reading)}</small>`:''}</button>`).join('')}</div>`:'<p class="small-note">一致する見出しがありません。複合語や、前後を含む言葉でも検索してみてください。</p>'}
function glossaryBody(query,context=''){const e=index.get(query);current={query,entry:e,context};const stats=`収録 ${index.size.toLocaleString()}語 · 学習説明 ${(window.STUDY_GLOSSARY||[]).length}語 · 法令の定義を含む`;return `${history.length?'<div class="glossary-history" data-glossary-ui><button class="btn btn-small" type="button" data-glossary-back>← 前の用語</button></div>':''}${window.SiteArt?.img('library','glossary-art',{sizes:'720px'})||''}<form id="glossary-search-form"><div class="search-box"><span>${icon('search')}</span><input id="glossary-search" type="search" value="${esc(query)}" placeholder="用語・読みを入力" aria-label="用語辞典の検索" autocomplete="off"></div><div class="btn-row"><button class="btn btn-small" type="submit">説明を開く</button><button class="btn btn-small ${mode?'btn-soft':''}" type="button" data-glossary-mode aria-pressed="${mode}">${icon('book','small-icon')}${mode?'下線のない言葉も調べる：ON':'下線のない言葉も調べる'}</button></div></form><p class="small-note">${stats}</p><div id="glossary-live-results"></div>${e?`<section class="glossary-entry"><div class="glossary-word"><div><h3>${esc(e.term)}</h3>${e.reading?`<p>${esc(e.reading)}</p>`:''}</div><button class="btn btn-primary btn-small" data-glossary-read>${icon('sound','small-icon')}説明を読む</button></div>${e.summary?`<span class="pill">学習用の説明</span><p class="glossary-summary">${esc(e.summary)}</p><p class="glossary-detail">${esc(e.detail||'')}</p>${e.example?`<div class="notice-inline"><span><strong>例</strong><br>${esc(e.example)}</span></div>`:''}`:''}${definitionHTML(e)}</section>`:query?`<div class="empty-state" style="margin-top:22px;padding:24px"><h3>「${esc(query)}」の説明は未収録です。</h3><p>意味を推測して表示することはしません。近い見出しや、原文の前後関係を確認してください。</p></div>${context?`<div class="glossary-context"><h3>この文章での使われ方</h3><p>${esc(context)}</p></div>`:''}${resultsHTML(query)}`:`<div class="glossary-suggestions" style="margin-top:20px">${['発明','意匠','商標','新規性','進歩性','先願','準用','みなす','善意','営業秘密'].filter(t=>index.has(t)).map(t=>`<button class="btn btn-small" data-glossary-term="${t}">${t}</button>`).join('')}</div>`}${query?`<div class="btn-row" style="margin-top:20px"><button class="btn btn-small" data-glossary-read-word>${icon('sound','small-icon')}用語の読みを聞く</button><button class="btn btn-small" data-glossary-stop>読み上げ停止</button></div>`:''}<p class="small-note glossary-scope">全文のどの言葉からも検索できます。すべての日本語の意味を収録した国語辞典ではありません。法定義は2026年11月25日時点の収録法令に基づきます。附則や特定手続だけの定義は、適用範囲を確認してください。</p>`}
async function openTerm(query='',context='',options={}){
  query=String(query).trim();const token=++openId,originRoute=A.route;
  const dialog=$('#app-dialog'),previous=dialog?.open&&dialog.querySelector('#glossary-search')&&current?{query:current.query,context:current.context}:null;
  A.stopSpeech();
  try{
    await load();if(token!==openId||A.route!==originRoute)return;
    if(options.history!=='back'){
      if(!previous)history.length=0;
      else if(previous.query!==query){history.push(previous);if(history.length>50)history.shift()}
    }
    A.dialog('用語辞典',glossaryBody(query,context));$('#app-dialog').classList.add('glossary-dialog');
    const input=$('#glossary-search');input.addEventListener('input',()=>{$('#glossary-live-results').innerHTML=resultsHTML(input.value.trim())});
    decorate();if(!query)input.focus();
  }catch{if(token!==openId||A.route!==originRoute)return;A.dialog('用語辞典','<p>用語データはまだ保存されていません。オンラインで一括保存を完了してください。</p>')}
}
async function toggleMode(){try{await load();mode=!mode;if(mode)A.laws?.setReadingMode();$('#app-dialog').close();updateMode();installControls();scheduleDecoration();A.toast(mode?'下線のない言葉も、本文をタップして検索できます。':'下線の用語は、いつでもタップして調べられます。')}catch{A.toast('用語データを読み込めませんでした。オンラインで保存してください。')}}
function caretAt(x,y){if(document.caretPositionFromPoint){const p=document.caretPositionFromPoint(x,y);if(p)return{node:p.offsetNode,offset:p.offset}}if(document.caretRangeFromPoint){const r=document.caretRangeFromPoint(x,y);if(r)return{node:r.startContainer,offset:r.startOffset}}return null}
function termAt(event){const point=caretAt(event.clientX,event.clientY);if(!point||point.node.nodeType!==Node.TEXT_NODE)return null;const el=point.node.parentElement.closest('.law-original p,.law-explanation p,.law-explanation li,.quote,td,th,.glossary-definition-text,.choice,.prompt-block,.essential-content p,.oral-answer p,.record-card h3,h1,h2,h3,p,li');if(!el||!$('#main').contains(el))return null;const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node,offset=0,text='';while(node=walker.nextNode()){if(node===point.node)offset=text.length+point.offset;text+=node.textContent||''}if(!text.trim())return null;offset=Math.min(Math.max(0,offset),text.length-1);for(const match of matchedTerms(text))if(match.start<=offset&&match.end>offset)return{term:match.term,context:text.slice(Math.max(0,offset-110),offset+170)};if(segmenter){for(const s of segmenter.segment(text))if(s.index<=offset&&s.index+s.segment.length>offset){const t=s.segment.trim();return t?{term:t,context:text.slice(Math.max(0,offset-110),offset+170)}:null}}const t=text.slice(Math.max(0,offset-8),offset+8).match(/[一-龠ぁ-ゔァ-ヴーa-zA-Z0-9]+/)?.[0];return t?{term:t,context:text.slice(Math.max(0,offset-110),offset+170)}:null}
function activateWord(event){
  const target=event.target?.nodeType===Node.ELEMENT_NODE?event.target:event.target?.parentElement;
  const word=target?.closest('.glossary-term[data-term]');if(!word||!index?.has(word.dataset.term))return false;
  const main=$('#main'),dialog=$('#app-dialog');
  if(!main?.contains(word)&&!dialog?.contains(word))return false;
  if(dialog?.open&&!dialog.contains(word)||drawingAt(word)||target.closest('canvas,[data-annotation-ui]'))return false;
  event.preventDefault();event.stopImmediatePropagation();
  if(event.repeat)return true;
  const block=word.closest(READABLE)||word.parentElement,text=block.textContent||'';
  let offset=text.indexOf(word.textContent);try{const range=document.createRange();range.selectNodeContents(block);range.setEndBefore(word);offset=range.toString().length}catch{}
  openTerm(word.dataset.term,text.slice(Math.max(0,offset-110),offset+170));return true;
}
document.addEventListener('click',e=>{
  if(activateWord(e))return;
  if(!mode||$('#app-dialog')?.open||!index||!$('#main')?.contains(e.target))return;
  if(e.target.closest('input,textarea,select,canvas,.annotation-toolbar,.law-reader-toolbar,.law-toc,[data-glossary-ui]')||drawingAt(e.target))return;
  const button=e.target.closest('button,a');if(button&&!button.matches('.choice,.law-search-result,.record-card'))return;
  if(button){e.preventDefault();e.stopImmediatePropagation()}
  const found=termAt(e);if(!found){if(button)A.toast('調べたい言葉の文字をタップしてください。');return}
  e.preventDefault();e.stopImmediatePropagation();openTerm(found.term,found.context);
},{capture:true});
document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches?.('.glossary-term[role="button"]'))activateWord(e)},{capture:true});
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.closest('.annotation-toolbar'))scheduleDecoration();const d=b.dataset;if('glossaryOpen'in d)openTerm();else if('glossaryBack'in d){const previous=history.pop();if(previous)openTerm(previous.query,previous.context,{history:'back'})}else if('glossaryMode'in d)toggleMode();else if('glossaryDisable'in d){mode=false;updateMode()}else if(d.glossaryTerm)openTerm(d.glossaryTerm,current?.context||'');else if('glossaryRead'in d&&current?.entry)A.speakQueue([{title:current.entry.term+'の説明',text:readWhole(current.entry)}]);else if('glossaryStop'in d)A.stopSpeech();else if('glossaryReadWord'in d)A.speakQueue([{title:current.query,text:current.query}]);else if(d.glossaryDefinition!==undefined&&current?.entry){const ds=[...current.entry.definitions].sort((a,b)=>Number(b.section==='本則')-Number(a.section==='本則')),def=ds[Number(d.glossaryDefinition)];if(def)A.speakQueue([{title:current.query+' · '+def.lawTitle,text:def.lawTitle+'。'+def.articleTitle+'。'+def.text}])}else if(d.glossaryNav){$('#app-dialog').close();A.go(d.glossaryNav)}});
document.addEventListener('submit',e=>{if(e.target.id==='glossary-search-form'){e.preventDefault();openTerm($('#glossary-search').value,current?.context||'')}});
function start(){if(started)return;started=true;installControls();observer=new MutationObserver(scheduleDecoration);observeRoots();load().then(scheduleDecoration).catch(()=>{});document.addEventListener('toggle',e=>{if(e.target.matches?.('details'))scheduleDecoration()},{capture:true})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
window.addEventListener('hashchange',()=>{openId++;history.length=0;scheduleDecoration()});
A.glossary={open:openTerm,load,decorate,get size(){return index?.size||0},get mode(){return mode},disable(){mode=false;updateMode()}};
})();
