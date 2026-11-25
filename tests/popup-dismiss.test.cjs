'use strict';
// Actual app.js + its DOMContentLoaded installation. DOM/PointerEvent simulation,
// not browser hit-testing; native Escape is modeled by an uncanceled cancel event.
// Usage: node tests/popup-dismiss.test.cjs [site-root|dist-directory]
const assert=require('node:assert/strict');
const {resolveTargets,createHarness}=require('./speech-volume.test.cjs');

async function run(){
 const targets=resolveTargets(),h=createHarness(targets),d=h.elements.get('#app-dialog'),listeners=new Map();
 let closes=0;const checks=[];
 d.tag='dialog';d.open=false;
 d.addEventListener=(type,fn)=>{if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn)};
 d.getBoundingClientRect=()=>({left:100,top:100,right:500,bottom:400,width:400,height:300});
 d.showModal=()=>{d.open=true};
 d.close=()=>{if(!d.open)return;d.open=false;closes++;for(const fn of listeners.get('close')||[])fn({target:d})};
 // Exercise real startup instead of exporting/reimplementing the dismiss function.
 await h.fire('DOMContentLoaded',h.document);
 assert((listeners.get('pointerdown')||[]).length>0,'DOMContentLoaded must install the pointer guard');
 assert.equal(typeof h.elements.get('#sidebar-shade').onclick,'function','Existing sidebar dismissal is still installed');
 const child=new h.Element('input');child.parent=d;
 const emit=(type,options={})=>{
  const e={type,target:d,button:0,pointerId:1,isPrimary:true,clientX:50,clientY:50,cancelable:true,defaultPrevented:false,stopped:false,
   preventDefault(){this.defaultPrevented=true},stopPropagation(){this.stopped=true},stopImmediatePropagation(){this.stopped=true},...options};
  for(const fn of listeners.get(type)||[]){fn(e);if(e.stopped)break}
  if(!e.stopped)for(const fn of h.events.get(type)||[]){fn(e);if(e.stopped)break}
  return e;
 };
 const open=()=>{
  h.context.App.dialog('確認','<p>このダイアログを閉じても学習データは変更しません。</p><input id="dismiss-test-edit" value="保存前の入力">');
  assert.equal(d.open,true);assert.equal(d.attributes['aria-labelledby'],'dialog-title');assert(h.elements.get('#dialog-title'));
 };
 const scenario=(name,events,shouldClose)=>{
  open();const before=closes;for(const [type,options]of events)emit(type,options);
  assert.equal(d.open,!shouldClose,name);assert.equal(closes-before,shouldClose?1:0,name+' must close at most once');checks.push(name);d.close();
 };
 const outsideTap=[['pointerdown'],['pointerup'],['click']];
 scenario('primary mouse tap entirely on backdrop closes',outsideTap,true);
 scenario('primary touch tap entirely on backdrop closes',outsideTap.map(([type])=>[type,{pointerType:'touch'}]),true);
 scenario('primary pen tap entirely on backdrop closes',outsideTap.map(([type])=>[type,{pointerType:'pen'}]),true);
 scenario('interior padding does not close',[['pointerdown',{clientX:120,clientY:120}],['pointerup',{clientX:120,clientY:120}],['click',{clientX:120,clientY:120}]],false);
 scenario('interior input does not close',outsideTap.map(([type])=>[type,{target:child,clientX:200,clientY:200}]),false);
 scenario('drag from inside to outside does not close',[['pointerdown',{target:child,clientX:200,clientY:200}],['pointerup'],['click']],false);
 scenario('drag from outside to inside does not close',[['pointerdown'],['pointerup',{target:child,clientX:200,clientY:200}],['click',{target:child,clientX:200,clientY:200}]],false);
 scenario('click on child cannot dismiss despite outside coordinates',outsideTap.map(([type])=>[type,{target:child}]),false);
 scenario('movement over 10 px cancels dismissal',[['pointerdown'],['pointermove',{clientX:61}],['pointerup',{clientX:61}],['click',{clientX:61}]],false);
 scenario('drag out and back remains canceled',[['pointerdown'],['pointermove',{clientX:90}],['pointermove'],['pointerup'],['click']],false);
 scenario('exactly 10 px remains a tap',[['pointerdown'],['pointermove',{clientX:60}],['pointerup',{clientX:60}],['click',{clientX:60}]],true);
 scenario('pointercancel suppresses later click',[['pointerdown'],['pointercancel'],['pointerup'],['click']],false);
 scenario('touch scroll cancellation does not close',[['pointerdown',{pointerType:'touch'}],['pointermove',{pointerType:'touch',clientY:90}],['pointercancel',{pointerType:'touch'}],['click',{pointerType:'touch'}]],false);
 scenario('right mouse click does not close',outsideTap.map(([type])=>[type,{button:2}]),false);
 scenario('middle mouse click does not close',outsideTap.map(([type])=>[type,{button:1}]),false);
 scenario('nonprimary pointer does not close',outsideTap.map(([type])=>[type,{isPrimary:false}]),false);
 scenario('different pointer on release does not close',[['pointerdown',{pointerId:1}],['pointerup',{pointerId:2}],['click',{pointerId:2}]],false);
 scenario('invalid release button does not close',[['pointerdown'],['pointerup',{button:2}],['click']],false);
 scenario('click without a pointer gesture does not close',[['click']],false);
 scenario('release without pointerdown does not close',[['pointerup'],['click']],false);
 scenario('click before pointerup does not close',[['pointerdown'],['click']],false);
 scenario('nonfinite coordinates are rejected',[['pointerdown',{clientX:NaN}],['pointerup'],['click']],false);
 scenario('dialog border counts as inside',[['pointerdown',{clientX:100,clientY:200}],['pointerup',{clientX:100,clientY:200}],['click',{clientX:100,clientY:200}]],false);

 // Closing a dismissible dialog must cancel an operation, never confirm it or
 // remove in-memory edits. The shared close action and native Escape remain usable.
 open();h.context.App.state.notes['qa:unsaved']='学習メモ';h.context.App.state.essayDrafts.qa={text:'答案の下書き',checked:[]};
 const draft=h.elements.get('#dismiss-test-edit');draft.value='入力中の内容';const beforeState=JSON.stringify(h.context.App.state),beforeStorage=JSON.stringify([...h.storage]);
 for(const [type,options]of outsideTap)emit(type,options);
 assert.equal(d.open,false);assert.equal(draft.value,'入力中の内容');assert.equal(JSON.stringify(h.context.App.state),beforeState);assert.equal(JSON.stringify([...h.storage]),beforeStorage);checks.push('dismiss only hides the dialog and preserves drafts/state/storage');
 open();emit('pointerdown');emit('pointerup');d.close();open();emit('click');assert.equal(d.open,true);checks.push('close resets a completed pointer gesture before reopening');d.close();
 emit('pointerdown');emit('pointerup');open();emit('click');assert.equal(d.open,true);checks.push('pointer gesture on a closed dialog cannot dismiss its next opening');d.close();
 open();const closeButton=new h.Element();closeButton.parent=d;closeButton.dataset.action='close-dialog';emit('click',{target:closeButton,clientX:470,clientY:120});assert.equal(d.open,false);checks.push('existing explicit close button remains functional');
 open();const cancel=emit('cancel');assert.equal(cancel.defaultPrevented,false,'Escape cancel must retain its native default');if(!cancel.defaultPrevented)d.close();assert.equal(d.open,false);checks.push('native Escape cancel is not intercepted');
 console.log(JSON.stringify({passed:true,checks:checks.length,app:targets.app,coverage:checks}));
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1});
