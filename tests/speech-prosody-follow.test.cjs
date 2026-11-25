'use strict';
// Full speech behavior suite; also runs all volume and native-pause regressions.
// Keep speech-volume.test.cjs beside this file when copying both into tests/.
// node tests/speech-prosody-follow.test.cjs [site-root|dist-directory]
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {resolveTargets,createHarness,runVolumeTests,usage:sharedUsage}=require('./speech-volume.test.cjs');
const usage=sharedUsage.replace('speech-volume.test.cjs','speech-prosody-follow.test.cjs');

async function runProsodyFollowTests(h){
 const {targets,context,test:t,spoken,synth,Element,fire,flush,advanceTimer,gapTimer,finish,microtasks,histories,scrolls}=h;
 assert.equal(t.normalizeSpeechPitch(undefined),1);assert.equal(t.normalizeSpeechPitch(null),1);assert.equal(t.normalizeSpeechPitch(.1),.8);assert.equal(t.normalizeSpeechPitch(3),1.2);assert.equal(t.normalizeSpeechStyle('invalid'),'natural');
 assert.equal(t.normalizedState({profile:{speechPitch:8,speechStyle:'careful'}}).profile.speechPitch,1.2);assert.equal(t.normalizedState({profile:{speechStyle:'careful'}}).profile.speechStyle,'careful');
 const plans=[];context.LegalProsody={plan:(text,opts)=>{plans.push({text,opts});return[{text:'前半。',pauseAfter:300},{text:'後半。',pauseAfter:0}]}};
 let starts=0;context.App.state.profile.speechPitch=1.1;context.App.state.profile.speechStyle='careful';
 t.speakQueue([{title:'prosody',text:'原文。後の文。',onstart(){starts++}}]);
 assert.equal(spoken.at(-1).u.pitch,1.1);assert.equal(plans.at(-1).opts.mode,'careful');assert.equal(plans.at(-1).opts.maxLength,180);assert.equal(plans.at(-1).opts.lang,'ja-JP');

 finish();const scheduled=gapTimer();assert(scheduled?.[1]);const beforeGap=spoken.length;assert.equal(t.speech.chunkIndex,1);
 assert.equal(spoken.length,beforeGap,'The next chunk waits for its punctuation timer');
 t.pauseSpeech();assert.equal(t.speech.pauseTimer,null);scheduled[1].fn();assert.equal(spoken.length,beforeGap);assert.equal(t.speech.pauseRemaining,300);
 t.pauseSpeech();const resumed=gapTimer();assert(resumed?.[1]);scheduled[1].fn();assert.equal(spoken.length,beforeGap);assert.equal(t.speech.pauseTimer,resumed[0]);
 advanceTimer(resumed[0]);assert.equal(spoken.at(-1).u.text,'後半。');assert.equal(spoken.at(-1).started,true);

 t.speakQueue([{title:'gap-volume',text:'原文。',onstart(){starts++}}]);finish();
 const staleGap=gapTimer(),beforeVolume=spoken.length,beforeStarts=starts;t.setSpeechVolume(.3,true);assert.equal(t.speech.pauseTimer,null);staleGap[1].fn();assert.equal(spoken.length,beforeVolume);
 flush();assert.equal(spoken.at(-1).u.text,'後半。');assert.equal(spoken.at(-1).u.volume,.3);assert.equal(starts,beforeStarts);
 t.speakQueue([{title:'gap-stop',text:'原文。'}]);finish();const stoppedGap=gapTimer(),beforeStopped=spoken.length;t.stopSpeech();stoppedGap[1].fn();assert.equal(spoken.length,beforeStopped);assert.equal(t.speech.pauseTimer,null);

 let resolveStart;t.speakQueue([{title:'pending',text:'原文。',onstart:()=>new Promise(resolve=>{resolveStart=resolve})}]);assert.equal(t.speech.preparing,true);
 const beforePending=spoken.length;t.setSpeechVolume(.4,true);resolveStart();await microtasks();assert.equal(spoken.length,beforePending+1);assert.equal(spoken.at(-1).u.volume,.4);
 let resolveStopped;t.speakQueue([{title:'stop-pending',text:'原文。',onstart:()=>new Promise(resolve=>{resolveStopped=resolve})}]);
 const beforePendingStop=spoken.length;t.stopSpeech();resolveStopped();await microtasks();assert.equal(spoken.length,beforePendingStop);

 context.App.state.profile.speechStyle='natural';t.speakQueue([{title:'style-change',text:'原文。',onstart(){starts++}}]);finish();advanceTimer(gapTimer()[0]);t.pauseSpeech();
 const beforeStyleStarts=starts,beforeStyleAudio=spoken.length,settings=new Element('form');settings.id='speech-settings';settings.values={voiceURI:'local',speechRate:'1',speechVolume:'50',speechStyle:'careful',speechPitch:'1.1',customReadings:''};
 await fire('submit',settings);flush();assert.equal(t.speech.paused,true);assert.equal(synth.paused,true);assert.equal(spoken.length,beforeStyleAudio);assert.equal(t.speech.chunkIndex,0);assert.equal(starts,beforeStyleStarts);
 t.pauseSpeech();assert.equal(spoken.at(-1).u.text,'前半。');assert.equal(spoken.at(-1).u.pitch,1.1);assert.equal(spoken.at(-1).started,true);

 context.LegalProsody={plan:text=>[{text,pauseAfter:0}]};const visits=[];
 t.speakQueue([{text:'一',onstart(){visits.push(1)}},{text:'二',onstart(){visits.push(2)}}],{continuous:true,loop:'all'});finish();finish();assert.deepEqual(visits,[1,2,1]);
 t.speech.loop='one';finish();assert.deepEqual(visits,[1,2,1,1]);
 delete context.LegalProsody;t.speakQueue([{text:'文'.repeat(310)}]);assert.equal(typeof t.speech.chunks[0],'string');assert.equal(spoken.at(-1).u.text.length,150);t.stopSpeech();
 context.LegalProsody={plan(){throw Error('planner unavailable')}};t.speakQueue([{text:'安全な代替読み上げ'}]);assert.equal(typeof t.speech.chunks[0],'string');assert.equal(spoken.at(-1).u.text,'安全な代替読み上げ');t.stopSpeech();

 // Exercise the actual preprocessing and prosody modules supplied by the caller.
 vm.runInContext(fs.readFileSync(targets.speech,'utf8'),context,{filename:targets.speech});
 vm.runInContext(fs.readFileSync(targets.prosody,'utf8'),context,{filename:targets.prosody});
 t.speakQueue([{text:'発明について確認します。次に、実施と存続期間を学びます。'}]);assert.equal(typeof t.speech.chunks[0],'object');
 assert(t.speech.chunks.every(part=>typeof part.text==='string'&&Number.isFinite(part.pauseAfter)&&part.pauseAfter>=0&&part.pauseAfter<=900));assert.equal(t.speech.chunks.at(-1).pauseAfter,0);t.stopSpeech();

 // Keep the real patent law's first three main articles; every fetch is local and explicit.
 const lawId='334AC0000000121',manifest=JSON.parse(fs.readFileSync(path.join(targets.corpus,'manifest.json'),'utf8'));
 const meta=manifest.laws.find(entry=>entry.id===lawId);assert(meta,'Patent law fixture is absent from the manifest');
 const law=JSON.parse(fs.readFileSync(path.join(targets.corpus,meta.file),'utf8'));law.articles=law.articles.filter(article=>article.section==='本則').slice(0,3);law.appendices=[];assert.equal(law.articles.length,3);
 context.fetch=async input=>{
  const request=String(input).replace(/^\.\//,'');
  if(request==='law-corpus/manifest.json')return{ok:true,json:async()=>manifest};
  if(request==='law-corpus/'+meta.file)return{ok:true,json:async()=>law};
  if(request==='treaty-corpus/manifest.json')return{ok:true,json:async()=>({treaties:[]})};
  throw Error('Unexpected fixture request: '+request);
 };
 vm.runInContext(fs.readFileSync(targets.law,'utf8'),context,{filename:targets.law});
 context.location.hash='#laws/'+lawId;await context.App.render('laws/'+lawId);assert.equal(context.App.route,'laws/'+lawId);
 const readAll=new Element();readAll.dataset.lawAction='read-all';await fire('click',readAll);await microtasks();
 assert.equal(context.App.route,'laws/'+lawId+'/'+law.articles[0].id);assert.equal(context.location.hash,'#'+context.App.route);assert.equal(t.speech.items[0].articleId,law.articles[0].id);assert.equal(scrolls.at(-1),'article-surface');assert.equal(spoken.at(-1).started,true);
 const firstRoute=context.App.route,routeCount=histories.length,scrollCount=scrolls.length;t.setSpeechVolume(.7,true);flush();assert.equal(histories.length,routeCount);assert.equal(scrolls.length,scrollCount);assert.equal(context.App.route,firstRoute);

 let guard=0;
 while(t.speech.index===0&&guard++<50){finish();const gap=gapTimer();if(gap)advanceTimer(gap[0]);await microtasks()}
 assert.equal(t.speech.index,1);assert.equal(context.App.route,'laws/'+lawId+'/'+law.articles[1].id);assert.equal(context.location.hash,'#'+context.App.route);assert.equal(scrolls.at(-1),'article-surface');
 // Repeat the pause→next regression through the real asynchronous law-route hook.
 t.pauseSpeech();assert.equal(synth.paused,true);const beforeLawNext=spoken.length,next=new Element();next.dataset.action='next-speech';await fire('click',next);await microtasks();
 assert.equal(t.speech.index,2);assert.equal(context.App.route,'laws/'+lawId+'/'+law.articles[2].id);assert.equal(context.location.hash,'#'+context.App.route);assert.equal(scrolls.at(-1),'article-surface');
 assert.equal(spoken.length,beforeLawNext+1);assert.equal(synth.paused,false);assert.equal(synth.pending,false);assert.equal(spoken.at(-1).started,true,'Paused law navigation must resume native audio after its async route completes');
 const kept=context.App.route;t.stopSpeech();assert.equal(context.App.route,kept);assert.equal(context.location.hash,'#'+kept);
 console.log('PASS prosody/follow: real prepare+plan modules and law corpus, pitch/style, guarded pauses, stale timers, async start/stop/volume, paused style changes, loop hooks, string/error fallback; bare law route, automatic next route/hash/scroll, async paused-next resumes, volume retains viewport, stop retains page.');
}

module.exports={runProsodyFollowTests};
if(require.main===module){
 if(process.argv.includes('--help'))console.log(usage);
 else (async()=>{const targets=resolveTargets(process.argv.slice(2),true);console.log('Testing speech modules:',JSON.stringify(targets));const harness=createHarness(targets);runVolumeTests(harness);await runProsodyFollowTests(harness)})().catch(error=>{console.error(error);process.exitCode=1});
}
