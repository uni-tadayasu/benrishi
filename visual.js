/* Decorative artwork only: legal text and controls remain live HTML. */
(() => {
'use strict';
const keys=new Set(['hero','library','patent','utility','design','trademark','treaty','copyright','listening','writing','practice']);
const lawKeys={"334AC0000000121":"patent","335CO0000000016":"patent","335M50000400010":"patent","335CO0000000039":"patent","335M50000400033":"patent","334AC0000000123":"utility","335CO0000000017":"utility","335M50000400011":"utility","335CO0000000040":"utility","335M50000400034":"utility","334AC0000000125":"design","335CO0000000018":"design","335M50000400012":"design","335CO0000000041":"design","335M50000400035":"design","334AC0000000127":"trademark","335CO0000000019":"trademark","335M50000400013":"trademark","335CO0000000042":"trademark","335M50000400036":"trademark","402AC0000000030":"writing","402CO0000000258":"writing","402M50000400041":"writing","335CO0000000020":"writing","353AC0000000030":"treaty","353CO0000000291":"treaty","353M50000400034":"treaty","345AC0000000048":"copyright","345CO0000000335":"copyright","345M50000080026":"copyright","405AC0000000047":"copyright","413CO0000000388":"copyright","412AC0000000049":"library","412CO0000000384":"library","412M50000400411":"library","129AC0000000089":"library","408AC0000000109":"library","426AC0000000068":"library","337AC0000000139":"library","405AC0000000088":"library","354AC0000000004":"library","401AC0000000091":"library"};
function img(key,className='',options={}) {
 if(!keys.has(key))key='library';
 const wide=key==='hero'||key==='library',large=key==='hero'?1440:key==='library'?1200:720,small=key==='hero'?800:key==='library'?600:360;
 const height=wide?Math.round(large*941/1672):large;
 return `<img class="site-art ${className}" src="./art/${key}${options.priority?'':'-small'}.webp" srcset="./art/${key}-small.webp ${small}w, ./art/${key}.webp ${large}w" sizes="${options.sizes||'(max-width: 560px) 42vw, 240px'}" width="${large}" height="${height}" alt="" aria-hidden="true" loading="${options.priority?'eager':'lazy'}" decoding="async"${options.priority?' fetchpriority="high"':''}>`;
}
function lawKey(id){return lawKeys[id]||'treaty'}
function routeKey(route){const [page,id]=String(route).split('/');return page==='laws'?(id?lawKey(id):'library'):({practice:'practice',review:'practice',essays:'writing',oral:'listening',essentials:'patent',plan:'writing',sources:'treaty',settings:'listening'})[page]||null}
function heading(route,kicker,title,desc='',right='') {
 const key=routeKey(route);if(!key)return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1>${desc?`<p>${desc}</p>`:''}</div>${right}</div>`;
 return `<header class="page-heading illustrated-heading ${String(route).startsWith('laws/')?'reader-heading':''}"><div class="heading-copy"><div class="eyebrow">${kicker}</div><h1>${title}</h1>${desc?`<p>${desc}</p>`:''}</div><div class="heading-visual ${key==='library'?'panorama':''}">${img(key,'',{sizes:'(max-width: 560px) 120px, 260px'})}</div>${right?`<div class="heading-extra">${right}</div>`:''}</header>`;
}
window.SiteArt=Object.freeze({img,lawKey,routeKey,heading});
})();
