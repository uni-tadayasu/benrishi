'use strict';
// Actual compact-player code and event handlers in the shared DOM/speech VM.
// Native audio and dialog Escape are simulated; browser layout is not measured.
// Usage: node tests/speech-player.test.cjs [site-root|dist-directory]
const assert=require('node:assert/strict');
const {resolveTargets,createHarness}=require('./speech-volume.test.cjs');

async function run(){
 const targets=resolveTargets(),h=createHarness(targets),{test:t,context,document,spoken,nativeCalls,fire,finish}=h;
 for(const name of ['speechDock','openSpeechOptions','minimizeSpeechDock','expandSpeechDock'])assert.equal(typeof t[name],'function',name+' test hook');
 assert(t.speechUi);await fire('DOMContentLoaded',document);
 const dock=h.elements.get('#speech-dock'),dialog=h.elements.get('#app-dialog'),checks=[];
 context.LegalProsody={plan:text=>[{text,pauseAfter:0}]};
 const control=(action,root=dock)=>{const button=root.querySelector('[data-action="'+action+'"]');assert(button,'Missing '+action+' control');return button};
 const click=async(action,root=dock)=>{const button=control(action,root);button.focus();await fire('click',button,{button:0});return button};
 const snapshot=()=>({native:nativeCalls.length,spoken:spoken.length,token:t.speech.token,items:t.speech.items,index:t.speech.index,chunkIndex:t.speech.chunkIndex,utterance:t.speech.utterance,playing:t.speech.playing,paused:t.speech.paused,preparing:t.speech.preparing,loop:t.speech.loop,continuous:t.speech.continuous,pauseTimer:t.speech.pauseTimer,route:context.App.route,hash:context.location.hash,history:h.histories.length,profile:JSON.stringify(context.App.state.profile)});
 const unchanged=(before,label)=>{const after=snapshot();for(const key of Object.keys(before))assert.equal(after[key],before[key],label+': '+key+' must remain unchanged')};
 const outsideTap=async()=>{for(const type of ['pointerdown','pointerup','click'])await fire(type,dialog,{button:0,pointerId:1,isPrimary:true,clientX:50,clientY:50})};
 const assertMini=()=>{assert.equal(t.speechUi.minimized,true);assert(dock.classList.contains('speech-dock-mini'));assert.equal(document.body.dataset.speechPlayer,'mini');assert.equal(dock.querySelector('input,select'),null)};
 const assertCompact=()=>{assert.equal(t.speechUi.minimized,false);assert(dock.classList.contains('speech-dock-compact'));assert.equal(document.body.dataset.speechPlayer,'compact');assert.equal(dock.querySelector('input,select'),null)};

 t.speakQueue([{title:'最初の条文',text:'第一の本文。'},{title:'次の条文',text:'第二の本文。'},{title:'最後の条文',text:'第三の本文。'}],{continuous:true});
 assertCompact();assert.equal(dock.hidden,false);assert.equal(dialog.open,false);assert(dock.textContent.includes('音量・設定'));assert(dock.textContent.includes('小さく'));checks.push('new queue starts with a compact bar and no exposed settings');
 let before=snapshot();await click('speech-options');unchanged(before,'open settings');
 assert.equal(dialog.open,true);assert(dialog.classList.contains('speech-options-dialog'));assert.equal(control('speech-options').getAttribute('aria-expanded'),'true');
 let panel=document.querySelector('#speech-options-panel'),slider=document.querySelector('#dock-volume');assert(panel?.contains(slider));assert(panel.contains(document.querySelector('#dock-rate')));assert(panel.contains(document.querySelector('#dock-loop')));checks.push('real settings button opens the labeled popup without changing audio, queue or route');

 before=snapshot();slider.focus();for(const type of ['pointerdown','pointerup','click'])await fire(type,slider,{button:0,pointerId:1,isPrimary:true,clientX:220,clientY:210});
 assert.equal(dialog.open,true);unchanged(before,'inside settings tap');checks.push('settings input interaction does not dismiss or restart audio');
 await fire('pointerdown',slider,{button:0,pointerId:1,isPrimary:true,clientX:220,clientY:210});await fire('pointerup',dialog,{button:0,pointerId:1,isPrimary:true,clientX:50,clientY:50});await fire('click',dialog,{button:0,clientX:50,clientY:50});assert.equal(dialog.open,true);checks.push('dragging a popup control out of its frame does not dismiss');
 before=snapshot();await outsideTap();unchanged(before,'backdrop close');assert.equal(dialog.open,false);assert.equal(dialog.classList.contains('speech-options-dialog'),false);assert.equal(control('speech-options').getAttribute('aria-expanded'),'false');assert.equal(document.activeElement,control('speech-options'));checks.push('backdrop closes only the popup and restores its current opener');

 await click('speech-options');before=snapshot();await click('close-dialog',dialog);unchanged(before,'explicit close');assert.equal(dialog.open,false);checks.push('explicit popup close preserves active playback');
 await click('speech-options');before=snapshot();let canceled=false;await fire('cancel',dialog,{preventDefault(){canceled=true}});assert.equal(canceled,false);dialog.close();unchanged(before,'native Escape close');checks.push('uncanceled native Escape closes the popup without touching synthesis');

 before=snapshot();await click('minimize-speech');unchanged(before,'minimize');assertMini();assert.equal(document.activeElement,control('expand-speech'));checks.push('minimize keeps the current utterance, queue and route');
 before=snapshot();await click('expand-speech');unchanged(before,'expand');assertCompact();assert.equal(document.activeElement,control('minimize-speech'));checks.push('expand restores compact controls without audio restart');
 await click('minimize-speech');const miniToken=t.speech.token,miniQueue=t.speech.items,miniAudio=spoken.length,miniCancels=h.cancels;
 await click('pause-speech');assertMini();assert.equal(t.speech.paused,true);assert.equal(t.speech.token,miniToken);assert.equal(t.speech.items,miniQueue);assert.equal(spoken.length,miniAudio);assert.equal(h.cancels,miniCancels);assert.match(control('pause-speech').getAttribute('aria-label'),/再開/);checks.push('pause preserves mini mode and retains an accessible resume control');
 before=snapshot();t.openSpeechOptions();unchanged(before,'settings while paused');assert.equal(dialog.open,true);assertMini();before=snapshot();dialog.close();unchanged(before,'close while paused');assert.equal(t.speech.paused,true);checks.push('opening and closing settings never resumes paused speech');
 await click('pause-speech');assertMini();assert.equal(t.speech.paused,false);finish();assert.equal(t.speech.index,1);assertMini();assert.equal(spoken.at(-1).u.text,'第二の本文。');checks.push('automatic next item preserves mini mode');

 // These API calls also cover a mini player whose options were opened explicitly.
 before=snapshot();t.openSpeechOptions();unchanged(before,'options from mini');assertMini();
 panel=document.querySelector('#speech-options-panel');slider=document.querySelector('#dock-volume');const loop=document.querySelector('#dock-loop'),rate=document.querySelector('#dock-rate');
 loop.focus();loop.value='one';await fire('change',loop);assert.equal(t.speech.loop,'one');assertMini();assert.equal(document.activeElement,loop);assert.equal(document.querySelector('#speech-options-panel'),panel);assert.equal(document.querySelector('#dock-loop'),loop);checks.push('repeat selection preserves mini mode, popup DOM and focused control');
 slider.focus();const itemIndex=t.speech.index;finish();assert.equal(t.speech.index,itemIndex);assertMini();assert.equal(document.activeElement,slider);assert.equal(document.querySelector('#dock-volume'),slider);checks.push('repeat-current advances audio without rebuilding settings or stealing focus');
 loop.value='none';await fire('change',loop);slider.focus();finish();assert.equal(t.speech.index,2);assertMini();assert.equal(document.activeElement,slider);assert.equal(document.querySelector('#dock-rate'),rate);assert(document.querySelector('#speech-options-status').textContent.includes('最後の条文'));checks.push('continuous next item updates popup status in place');
 loop.value='all';await fire('change',loop);slider.focus();finish();assert.equal(t.speech.index,0);assertMini();assert.equal(document.activeElement,slider);checks.push('repeat-all retains mini mode and popup focus');
 await click('continuous-speech',panel);assert.equal(t.speech.continuous,false);assert.equal(t.speech.loop,'none');assertMini();assert.equal(document.activeElement,control('continuous-speech',panel));assert.equal(document.querySelector('#speech-options-panel'),panel);checks.push('continuous toggle changes playback policy without rebuilding settings');

 // A focused slider must also survive normal compact-bar rebuilding on pause/next.
 dialog.close();await click('expand-speech');await click('speech-options');slider=document.querySelector('#dock-volume');slider.focus();
 t.pauseSpeech();assert.equal(document.activeElement,slider);assert.equal(document.querySelector('#dock-volume'),slider);t.pauseSpeech();assert.equal(document.activeElement,slider);
 const next=control('next-speech');await fire('click',next,{button:0});assert.equal(document.activeElement,slider);assert.equal(document.querySelector('#dock-volume'),slider);assert.equal(dialog.open,true);checks.push('pause/resume/manual next retain the popup slider node and focus');
 before=snapshot();await outsideTap();unchanged(before,'close after player rerender');assert.equal(document.activeElement,control('speech-options'));assert.equal(control('speech-options').getAttribute('aria-expanded'),'false');checks.push('closing after bar rerender focuses the replacement opener');

 await click('minimize-speech');t.openSpeechOptions();t.speakQueue([{title:'新しい教材',text:'新しい読み上げ本文。'}]);assertCompact();assert.equal(dialog.open,false);assert.equal(t.speech.index,0);assert.equal(t.speech.items.length,1);assert.equal(spoken.at(-1).u.text,'新しい読み上げ本文。');checks.push('replacement queue closes old settings and resets to compact');
 await click('speech-options');t.stopSpeech();assert.equal(t.speech.playing,false);assert.equal(dock.hidden,true);assert.equal(dialog.open,false);assert.equal(document.body.hasAttribute('data-speech-player'),false);checks.push('stop hides player and its own settings popup');
 t.speakQueue([{text:'最後まで読む本文。'}]);await click('speech-options');finish();assert.equal(t.speech.playing,false);assert.equal(dock.hidden,true);assert.equal(dialog.open,false);checks.push('natural queue completion closes its settings popup');

 t.speakQueue([{text:'別画面を開いている本文。'}]);await click('speech-options');context.App.dialog('確認','<p>学習記録の確認画面</p>');assert.equal(dialog.classList.contains('speech-options-dialog'),false);t.stopSpeech();assert.equal(dialog.open,true);checks.push('stop preserves a different dialog that replaced speech settings');
 dialog.classList.add('glossary-dialog');t.speakQueue([{text:'辞典を開いたままの本文。'}]);t.stopSpeech();assert.equal(dialog.open,true);assert(dialog.classList.contains('glossary-dialog'));checks.push('stop preserves the dictionary dialog');
 before=snapshot();t.openSpeechOptions();t.minimizeSpeechDock();t.expandSpeechDock();unchanged(before,'inactive UI actions');assert.equal(dialog.open,true);assert.equal(dock.hidden,true);checks.push('inactive player actions do not hijack another dialog or start speech');dialog.close();
 console.log(JSON.stringify({passed:true,checks:checks.length,app:targets.app,coverage:checks}));
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1});
