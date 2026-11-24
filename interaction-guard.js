(() => {
  'use strict';
  const prevent=e=>{if(e.cancelable)e.preventDefault()};
  document.addEventListener('contextmenu',prevent,{capture:true});
  document.addEventListener('dblclick',prevent,{capture:true});
  document.addEventListener('dragstart',prevent,{capture:true});
  document.addEventListener('mousedown',e=>{if(e.button===2||e.detail>1)prevent(e)},{capture:true});
  document.addEventListener('selectstart',e=>{if(!e.target.closest('input,textarea,[contenteditable="true"]'))prevent(e)},{capture:true});
  document.addEventListener('touchstart',e=>{if(e.touches.length>1)prevent(e)},{passive:false,capture:true});
  for(const event of ['gesturestart','gesturechange','gestureend'])document.addEventListener(event,prevent,{passive:false});
  document.addEventListener('wheel',e=>{if(e.ctrlKey)prevent(e)},{passive:false});
})();
