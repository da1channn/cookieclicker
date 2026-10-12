#!/usr/bin/env node
/*
	iPhone eval suite for Cookie Clicker builds.

	Usage:  node evals/run.js [--target index.html] [--label name] [--only T05,T06] [--quiet]
	Needs:  playwright (global install is fine: NODE_PATH=$(npm root -g))

	Every eval is a deterministic code-graded check that maps to one of the user's
	acceptance criteria (see evals/README.md). Chromium mobile emulation is used as the
	harness; WebKit-only behaviour (350ms tap wait, standalone resume bugs) is covered
	by structural evals + the manual iPhone checklist.
*/
const path=require('path');
let playwright;
try {playwright=require('playwright');}
catch(e){playwright=require(path.join(require('child_process').execSync('npm root -g').toString().trim(),'playwright'));}
const {start}=require('./server');
const fs=require('fs');

const args=process.argv.slice(2);
const arg=(n,d)=>{const i=args.indexOf('--'+n);return i>=0?args[i+1]:d;};
const TARGET=arg('target','index.html');
const LABEL=arg('label',TARGET.replace(/\W+/g,'_'));
const ONLY=arg('only','')?arg('only').split(','):null;
const QUIET=args.includes('--quiet');

const PORTRAIT={width:393,height:852};//iPhone 15/16 Pro, standalone (full screen)
const LANDSCAPE={width:852,height:393};
const UA='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const EVAL_TIMEOUT_MS=150000;//a hung eval fails instead of stalling the suite

let browser,srv;
const pageErrors=[];

async function openGame(file=TARGET,{viewport=PORTRAIT,insets=null,storage=null,init=null,query=''}={}){
	const context=await browser.newContext({viewport,screen:{width:PORTRAIT.width,height:PORTRAIT.height},deviceScaleFactor:3,isMobile:true,hasTouch:true,userAgent:UA});
	await context.route(url=>!url.href.startsWith(srv.base.replace(/cookieclicker\/$/,'')),r=>r.abort());
	await context.addInitScript(([storage])=>{
		try {
			localStorage.setItem('CookieClickerLang','EN');
			if (storage) for (const k in storage) localStorage.setItem(k,storage[k]);
		} catch(e){}
	},[storage]);
	if (init) await context.addInitScript(init);
	const page=await context.newPage();
	page.on('pageerror',e=>pageErrors.push(file+': '+e.message));
	const cdp=await context.newCDPSession(page);
	if (insets)
	{
		try {await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets});}
		catch(e){await context.close();return {unsupported:'Emulation.setSafeAreaInsetsOverride: '+e.message};}
	}
	await page.goto(srv.base+file+query);
	await page.waitForFunction(()=>window.Game && Game.ready && Game.T>10 && Game.wrapper && Game.ObjectsById && Game.ObjectsById.length>0 && !Game.promptOn,null,{timeout:60000});
	await sleep(300);
	const g={page,cdp,context,file};
	return g;
}

//element center in screen (DIP) coordinates, as CDP touch input expects
async function center(g,sel){
	return g.page.evaluate(sel=>{
		const el=typeof sel==='string'?document.querySelector(sel):null;
		if (!el) return null;
		const r=el.getBoundingClientRect(),vv=window.visualViewport||{offsetLeft:0,offsetTop:0,scale:1};
		return {x:(r.left+r.width/2-vv.offsetLeft)*vv.scale,y:(r.top+r.height/2-vv.offsetTop)*vv.scale,w:r.width*vv.scale,h:r.height*vv.scale};
	},sel);
}
async function touch(g,type,points){await g.cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points});}
async function tap(g,p,{hold=15,id=1}={}){
	await touch(g,'touchStart',[{x:p.x,y:p.y,id}]);
	await sleep(hold);
	await touch(g,'touchEnd',[]);
}
async function swipe(g,p,dx,dy,steps=10){
	await touch(g,'touchStart',[{x:p.x,y:p.y,id:1}]);
	for (let i=1;i<=steps;i++){await sleep(16);await touch(g,'touchMove',[{x:p.x+dx*i/steps,y:p.y+dy*i/steps,id:1}]);}
	await sleep(16);
	await touch(g,'touchEnd',[]);
}
async function recorder(g){
	await g.page.evaluate(()=>{
		if (window.__rec) {__rec.clicks=[];__rec.up=[];__rec.end=[];return;}
		window.__rec={clicks:[],up:[],end:[]};
		let v=Game.cookieClicks;
		Object.defineProperty(Game,'cookieClicks',{configurable:true,get(){return v;},set(n){v=n;__rec.clicks.push(performance.now());}});
		window.addEventListener('pointerup',()=>__rec.up.push(performance.now()),true);
		window.addEventListener('touchend',()=>__rec.end.push(performance.now()),true);
	});
}
const vvScale=g=>g.page.evaluate(()=>window.visualViewport?visualViewport.scale:1);
const fits=g=>g.page.evaluate(()=>{
	const vv=window.visualViewport||{offsetLeft:0,offsetTop:0,scale:1,width:innerWidth,height:innerHeight};
	const r=Game.wrapper.getBoundingClientRect();
	const sx=(r.left-vv.offsetLeft)*vv.scale,sy=(r.top-vv.offsetTop)*vv.scale,sr=(r.right-vv.offsetLeft)*vv.scale,sb=(r.bottom-vv.offsetTop)*vv.scale;
	const W=vv.width*vv.scale,H=vv.height*vv.scale;
	return {ok:sx>=-1&&sy>=-1&&sr<=W+1&&sb<=H+1&&document.documentElement.scrollWidth<=innerWidth+1,rect:[sx,sy,sr,sb].map(Math.round),screen:[Math.round(W),Math.round(H)],scale:Game.scale};
});
const percentile=(a,p)=>{if (!a.length) return null;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p*(s.length-1)+0.5))];};
const expectedScale=(w,h)=>Math.min(w/Math.max(800,w),h/Math.max(200,h));

async function richGame(g){
	await g.page.evaluate(()=>{Game.cookies=1e40;Game.cookiesEarned=1e40;Game.RefreshStore&&Game.RefreshStore();});
	await sleep(600);
}

/*=====================================================================================*/
const EVALS=[
['T01','viewport meta: device-width, non-scalable, viewport-fit=cover','P0 zoom',async()=>{
	const g=await openGame();
	const c=await g.page.evaluate(()=>(document.querySelector('meta[name=viewport]')||{}).content||'');
	await g.context.close();
	const ok=/width=device-width/.test(c)&&/user-scalable=no/.test(c)&&/maximum-scale=1\b/.test(c)&&/minimum-scale=1\b/.test(c)&&/viewport-fit=cover/.test(c);
	return {pass:ok,detail:c};
}],
['T02','layout viewport == device width, page scale 1','P1 viewport',async()=>{
	const g=await openGame();
	const r=await g.page.evaluate(()=>({iw:innerWidth,cw:document.documentElement.clientWidth,s:visualViewport.scale}));
	await g.context.close();
	return {pass:r.iw===PORTRAIT.width&&Math.abs(r.s-1)<0.01,detail:r};
}],
['T03','whole game visible: no overflow, no horizontal scroll (portrait)','P1 viewport',async()=>{
	const g=await openGame();const f=await fits(g);await g.context.close();
	return {pass:f.ok,detail:f};
}],
['T04','touch-action: html/body manipulation, cookie none, store pan-y','P0 zoom',async()=>{
	const g=await openGame();
	const r=await g.page.evaluate(()=>{const ta=s=>{const e=document.querySelector(s);return e?getComputedStyle(e).touchAction:null;};
		return {html:ta('html'),body:ta('body'),cookie:ta('#bigCookie'),store:ta('#sectionRight'),product:ta('#product0'),deep:ta('#productName0')};});
	await g.context.close();
	const ok=r.html==='manipulation'&&r.body==='manipulation'&&r.cookie==='none'&&/pan-y|manipulation/.test(r.store)&&/pan-y|manipulation/.test(r.product)&&r.deep!=='auto';
	return {pass:ok,detail:r};
}],
['T05','single tap on cookie = exactly 1 click (no ghost/double click)','P0 tap',async()=>{
	const g=await openGame();await recorder(g);
	const p=await center(g,'#bigCookie');
	await tap(g,p);await sleep(1000);
	const n=await g.page.evaluate(()=>__rec.clicks.length);
	await g.context.close();
	return {pass:n===1,detail:{clicks:n}};
}],
['T06','20 rapid taps (22/s): all counted, none late','P0 tap',async()=>{
	const g=await openGame();await recorder(g);
	const p=await center(g,'#bigCookie');
	for (let i=0;i<20;i++){await tap(g,{x:p.x+(i%3)*4-4,y:p.y+(i%2)*4},{hold:12});await sleep(33);}
	await sleep(1000);
	const r=await g.page.evaluate(()=>__rec);
	await g.context.close();
	const lat=[];
	if (r.clicks.length===r.up.length) for (let i=0;i<r.clicks.length;i++) lat.push(r.clicks[i]-r.up[i]);
	const p95=percentile(lat,0.95),max=lat.length?Math.max(...lat):null;
	return {pass:r.clicks.length===20&&max!==null&&max<50,detail:{clicks:r.clicks.length,ups:r.up.length},metrics:{lat_p50_ms:percentile(lat,0.5),lat_p95_ms:p95,lat_max_ms:max}};
}],
['T07','two-finger drumming on cookie: every finger lift counts','P0 tap',async()=>{
	const g=await openGame();await recorder(g);
	const p=await center(g,'#bigCookie');
	const A={x:p.x-30,y:p.y,id:1},B={x:p.x+30,y:p.y,id:2};
	for (let i=0;i<10;i++){
		await touch(g,'touchStart',[A]);await sleep(25);
		await touch(g,'touchStart',[A,B]);await sleep(25);
		await touch(g,'touchEnd',[B]);await sleep(25);//A lifted
		await touch(g,'touchEnd',[]);await sleep(25);//B lifted
	}
	await sleep(1000);
	const n=await g.page.evaluate(()=>__rec.clicks.length);
	await g.context.close();
	return {pass:n===20,detail:{clicks:n,expected:20}};
}],
['T08','cookie touchstart is default-prevented (WebKit cannot start zoom/scroll on it)','P0 zoom',async()=>{
	const g=await openGame();
	await g.page.evaluate(()=>{window.__dp=[];window.addEventListener('touchstart',e=>__dp.push(e.defaultPrevented),false);});
	const p=await center(g,'#bigCookie');await tap(g,p);await sleep(200);
	const r=await g.page.evaluate(()=>__dp);
	await g.context.close();
	return {pass:r.length>0&&r.every(Boolean),detail:r};
}],
['T09','double tap (cookie, store, middle) never zooms','P0 zoom',async()=>{
	const g=await openGame();await recorder(g);
	const out={};
	for (const sel of ['#bigCookie','#product0','#sectionMiddle','#centerArea']){
		const p=await center(g,sel);if (!p) continue;
		await tap(g,p,{hold:20});await sleep(60);await tap(g,p,{hold:20});await sleep(700);
		out[sel]=await vvScale(g);
	}
	const clicks=await g.page.evaluate(()=>__rec.clicks.length);
	await g.context.close();
	return {pass:Object.values(out).every(s=>Math.abs(s-1)<0.01)&&clicks===2,detail:{scales:out,cookieClicks:clicks}};
}],
['T10','pinch never zooms','P0 zoom',async()=>{
	const g=await openGame();
	const before=await vvScale(g);
	await g.cdp.send('Input.synthesizePinchGesture',{x:200,y:400,scaleFactor:2.5,gestureSourceType:'touch'});
	await sleep(500);
	const after=await vvScale(g);
	await g.context.close();
	return {pass:Math.abs(after-before)<0.01&&Math.abs(after-1)<0.01,detail:{before,after}};
}],
['T11','store building: 1 tap = 1 building, 5 fast taps = 5','P0 tap',async()=>{
	const g=await openGame();await richGame(g);
	const p=await center(g,'#product0');
	const a0=await g.page.evaluate(()=>Game.ObjectsById[0].amount);
	await tap(g,p);await sleep(800);
	const a1=await g.page.evaluate(()=>Game.ObjectsById[0].amount);
	for (let i=0;i<5;i++){await tap(g,p,{hold:15});await sleep(60);}
	await sleep(800);
	const a2=await g.page.evaluate(()=>Game.ObjectsById[0].amount);
	await g.context.close();
	return {pass:a1-a0===1&&a2-a1===5,detail:{single:a1-a0,rapid:a2-a1}};
}],
['T12','store upgrade: 1 tap buys it exactly once','P0 tap',async()=>{
	const g=await openGame();await richGame(g);
	await g.page.evaluate(()=>{Game.Unlock('Reinforced index finger');Game.Unlock('Carpal tunnel prevention cream');Game.RebuildUpgrades();});
	await sleep(400);
	const id=await g.page.evaluate(()=>{const c=document.querySelector('#upgrades .crate.upgrade');return c?+c.dataset.id:null;});
	const p=await center(g,'#upgrades .crate.upgrade');
	const before=await g.page.evaluate(()=>Game.UpgradesOwned);
	if (p) await tap(g,p);
	await sleep(800);
	const r=await g.page.evaluate(id=>({owned:Game.UpgradesOwned,bought:id!==null?Game.UpgradesById[id].bought:null}),id);
	await g.context.close();
	return {pass:r.bought===1&&r.owned-before===1,detail:{id,...r,before}};
}],
['T13','store scrolls by dragging; dragging never buys (landscape)','P0 tap',async()=>{
	const g=await openGame(TARGET,{viewport:LANDSCAPE});await richGame(g);
	const amounts=()=>g.page.evaluate(()=>Game.ObjectsById.map(o=>o.amount).join(','));
	const a0=await amounts();
	const p=await center(g,'#sectionRight');
	await swipe(g,{x:p.x,y:p.y+100},0,-200,12);await sleep(600);
	const st=await g.page.evaluate(()=>l('sectionRight').scrollTop);
	const a1=await amounts();
	await g.context.close();
	return {pass:st>20&&a0===a1,detail:{scrollTop:st,bought:a0!==a1}};
}],
['T14','long press on a building shows its tooltip and does not buy','P2 ux',async()=>{
	const g=await openGame();await richGame(g);
	const p=await center(g,'#product0');
	const a0=await g.page.evaluate(()=>Game.ObjectsById[0].amount);
	await tap(g,p,{hold:800});await sleep(600);
	const r=await g.page.evaluate(()=>({amount:Game.ObjectsById[0].amount,tooltip:Game.tooltip.on}));
	await g.context.close();
	return {pass:r.amount===a0&&r.tooltip===1,detail:r};
}],
['T15','portrait -> landscape -> portrait keeps layout & scale','P1 rotation',async()=>{
	const g=await openGame();
	const f0=await fits(g);
	await g.page.setViewportSize(LANDSCAPE);await sleep(1500);
	const f1=await fits(g);
	await g.page.setViewportSize(PORTRAIT);await sleep(1500);
	const f2=await fits(g);
	const vs=await vvScale(g);
	await g.context.close();
	const ok=f0.ok&&f1.ok&&f2.ok&&Math.abs(f2.scale-f0.scale)<0.001&&Math.abs(vs-1)<0.01
		&&Math.abs(f0.scale-expectedScale(PORTRAIT.width,PORTRAIT.height))<0.002&&Math.abs(f1.scale-expectedScale(LANDSCAPE.width,LANDSCAPE.height))<0.002;
	return {pass:ok,detail:{portrait:f0,landscape:f1,back:f2,vvScale:vs}};
}],
['T16','finger position maps to game coordinates (particles/drag at the finger)','P1 rotation',async()=>{
	const g=await openGame();
	const p=await center(g,'#bigCookie');
	await tap(g,p);await sleep(200);
	const r=await g.page.evaluate(()=>({mx:Game.mouseX,my:Game.mouseY,cx:Game.cookieOriginX,cy:Game.cookieOriginY}));
	await g.context.close();
	const err=Math.hypot(r.mx-r.cx,r.my-r.cy);
	return {pass:err<6,detail:r,metrics:{mouse_error_px:+err.toFixed(1)}};
}],
['T17','safe area (Dynamic Island + home indicator): game stays inside, taps still map','P1 safe-area',async()=>{
	const insets={top:59,bottom:34,left:0,right:0};
	const g=await openGame(TARGET,{insets});
	if (g.unsupported) return {pass:null,detail:g.unsupported};
	const r=await g.page.evaluate(()=>{const b=Game.wrapper.getBoundingClientRect();return {top:b.top,bottom:b.bottom,h:innerHeight};});
	await recorder(g);
	const p=await center(g,'#bigCookie');await tap(g,p);await sleep(500);
	const m=await g.page.evaluate(()=>({n:__rec.clicks.length,mx:Game.mouseX,my:Game.mouseY,cx:Game.cookieOriginX,cy:Game.cookieOriginY}));
	await g.page.setViewportSize(LANDSCAPE);
	await g.cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,bottom:21,left:59,right:59}});
	await g.page.evaluate(()=>window.dispatchEvent(new Event('resize')));await sleep(1500);
	const l=await g.page.evaluate(()=>{const b=Game.wrapper.getBoundingClientRect();return {left:b.left,right:b.right,bottom:b.bottom,w:innerWidth,h:innerHeight};});
	await g.context.close();
	const err=Math.hypot(m.mx-m.cx,m.my-m.cy);
	const ok=r.top>=insets.top-1&&r.bottom<=r.h-insets.bottom+1&&m.n===1&&err<6&&l.left>=58&&l.right<=l.w-58&&l.bottom<=l.h-20;
	return {pass:ok,detail:{portrait:r,landscape:l,clicks:m.n,mouseErr:+err.toFixed(1)}};
}],
['T18','viewport self-repair after resume; no forced resizes while idle','P1 resume',async()=>{
	const g=await openGame();
	await g.page.evaluate(()=>{window.__rz=0;const o=Game.resize;Game.resize=function(){__rz++;return o.apply(this,arguments);};});
	await sleep(3000);
	const idle=await g.page.evaluate(()=>__rz);
	//simulate the WebKit standalone resume bug: stale layout from a bogus viewport size
	await g.page.evaluate(()=>{Game.wrapper.style.transform='scale(1)';Game.wrapper.style.width='800px';Game.scale=1;
		document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
	await sleep(1500);
	const f=await fits(g);
	await g.context.close();
	return {pass:idle===0&&f.ok&&Math.abs(f.scale-expectedScale(PORTRAIT.width,PORTRAIT.height))<0.002,detail:{idleResizes:idle,after:f}};
}],
['T19','save compatibility with plasma4 mobile.html and desktop.html (both directions, identical format)','P0 save',async()=>{
	const decode=s=>Buffer.from(decodeURIComponent(s).replace('!END!',''),'base64').toString('utf8');
	const strip=s=>{const p=decode(s).split('|');p[2]=p[2].split(';').filter((_,i)=>i!==2).join(';');return p.join('|');};//drop "last opened" date only
	const g=await openGame();
	const save=await g.page.evaluate(()=>{Game.cookies=123456789;Game.cookiesEarned=987654321;Game.ObjectsById[0].getFree(7);Game.ObjectsById[2].getFree(3);
		Game.bakeryName='Eval Bakery';Game.Unlock('Reinforced index finger');Game.Upgrades['Reinforced index finger'].earn();return Game.WriteSave(1);});
	const key=await g.page.evaluate(()=>{Game.WriteSave();return {key:Game.SaveTo,stored:!!localStorage.getItem('CookieClickerGame')};});
	await g.context.close();
	const importInto=async file=>{
		const o=await openGame(file);
		const r=await o.page.evaluate(s=>{const ok=Game.ImportSaveCode(s);return {ok,cookies:Game.cookies,cursors:Game.ObjectsById[0].amount,farms:Game.ObjectsById[2].amount,name:Game.bakeryName,up:Game.Upgrades['Reinforced index finger'].bought,re:Game.WriteSave(1)};},save);
		const back=await o.page.evaluate(()=>{Game.cookies=42;Game.ObjectsById[1].getFree(2);return Game.WriteSave(1);});
		await o.context.close();
		r.valuesOk=r.ok!==false&&r.cookies===123456789&&r.cursors===7&&r.farms===3&&r.name==='Eval Bakery'&&r.up===1;
		r.back=back;
		return r;
	};
	const mine=await importInto(TARGET),base=await importInto('mobile.html'),desk=await importInto('desktop.html');
	const out={key,importedHere:mine.valuesOk,importedPlasmaMobile:base.valuesOk,importedDesktop:desk.valuesOk,
		sameExportAsPlasma:strip(mine.re)===strip(base.re)};
	for (const [n,src] of [['fromPlasmaMobile',base],['fromDesktop',desk]]){
		const o=await openGame();
		out[n]=await o.page.evaluate(s=>{const ok=Game.ImportSaveCode(s);return ok!==false&&Game.cookies===42&&Game.ObjectsById[1].amount===2&&Game.ObjectsById[0].amount===7;},src.back);
		await o.context.close();
	}
	const ok=key.key==='CookieClickerGame'&&key.stored&&out.importedHere&&out.importedPlasmaMobile&&out.importedDesktop&&out.sameExportAsPlasma&&out.fromPlasmaMobile&&out.fromDesktop;
	return {pass:ok,detail:out};
}],
['T20','progress is saved when the app goes to background','P1 lifecycle',async()=>{
	const g=await openGame();
	const r=await g.page.evaluate(async()=>{
		Game.T=Math.max(Game.T,Game.fps*20);Game.cookies=777777;
		localStorage.removeItem(Game.SaveTo);
		Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});
		document.dispatchEvent(new Event('visibilitychange'));
		await new Promise(r=>setTimeout(r,100));
		delete document.visibilityState;
		const s=localStorage.getItem(Game.SaveTo);
		return {saved:!!s};
	});
	await g.context.close();
	return {pass:r.saved,detail:r};
}],
['T21','GitHub Pages subpath: no 404s, no absolute paths','P1 pwa',async()=>{
	srv.log.notFound.length=0;srv.log.outsidePrefix.length=0;
	const g=await openGame();await sleep(1500);await g.context.close();
	const nf=srv.log.notFound.filter(u=>!/favicon/.test(u));
	return {pass:nf.length===0&&srv.log.outsidePrefix.length===0,detail:{notFound:nf.slice(0,10),outside:srv.log.outsidePrefix.slice(0,10)}};
}],
['T22','PWA: manifest, apple meta, icons, service worker','P1 pwa',async()=>{
	const g=await openGame();
	const r=await g.page.evaluate(async()=>{
		const link=document.querySelector('link[rel=manifest]');
		if (!link) return {manifest:false};
		const m=await (await fetch(link.href)).json();
		const icons=await Promise.all((m.icons||[]).map(async i=>(await fetch(new URL(i.src,link.href))).status));
		const ati=document.querySelector('link[rel=apple-touch-icon]');
		const atiStatus=ati?(await fetch(ati.href)).status:0;
		let sw=false;
		if (navigator.serviceWorker) sw=await Promise.race([navigator.serviceWorker.ready.then(()=>true),new Promise(r=>setTimeout(()=>r(false),8000))]);
		return {manifest:true,display:m.display,start:m.start_url,scope:m.scope,icons,atiStatus,
			capable:!!document.querySelector('meta[name=apple-mobile-web-app-capable][content=yes]'),
			status:(document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]')||{}).content,sw};
	});
	await g.context.close();
	const ok=r.manifest&&r.display==='standalone'&&!/^\//.test(r.start)&&r.icons.length>0&&r.icons.every(s=>s===200)&&r.atiStatus===200&&r.capable&&r.sw;
	return {pass:ok,detail:r};
}],
['T23','golden cookie over the big cookie: 1 tap = 1 pop, no ghost cookie click','P0 tap',async()=>{
	const g=await openGame();await recorder(g);
	await g.page.evaluate(()=>{
		const s=new Game.shimmer('golden');window.__gs=s;
		const c=l('bigCookie').getBoundingClientRect(),par=s.l.offsetParent.getBoundingClientRect();
		s.l.style.left=((c.left+c.width/2-par.left)/Game.scale-48)+'px';
		s.l.style.top=((c.top+c.height/2-par.top)/Game.scale-48)+'px';
	});
	await sleep(300);
	const p=await g.page.evaluate(()=>{const r=__gs.l.getBoundingClientRect(),vv=visualViewport;return {x:(r.left+r.width/2-vv.offsetLeft)*vv.scale,y:(r.top+r.height/2-vv.offsetTop)*vv.scale};});
	await g.page.evaluate(()=>{window.__pops=0;const o=__gs.popFunc||null;const pf=Game.shimmerTypes[__gs.type].popFunc;Game.shimmerTypes[__gs.type].popFunc=function(me){__pops++;return pf.apply(this,arguments);};});
	await tap(g,p);await sleep(1000);
	const r=await g.page.evaluate(()=>({popped:__gs.popped,pops:__pops,cookieClicks:__rec.clicks.length}));
	await g.context.close();
	return {pass:r.popped===true&&r.pops===1&&r.cookieClicks===0,detail:r};
}],
['T24','Garden: tapping a tile plants the selected seed','P1 minigame',async()=>{
	const g=await openGame();await richGame(g);
	const ok=await g.page.evaluate(async()=>{
		const F=Game.Objects['Farm'];F.getFree(1);F.level=1;Game.LoadMinigames();
		for (let i=0;i<100 && !(F.minigame && F.minigameLoaded);i++) await new Promise(r=>setTimeout(r,100));
		if (!F.minigame) return false;
		F.switchMinigame(1);await new Promise(r=>setTimeout(r,800));
		F.minigame.seedSelected=0;return true;
	});
	if (!ok) {await g.context.close();return {pass:false,detail:'garden did not load'};}
	const tile=await g.page.evaluate(()=>{const M=Game.Objects['Farm'].minigame;for (let y=0;y<6;y++)for (let x=0;x<6;x++){const t=l('gardenTile-'+x+'-'+y);if (t&&t.style.display!=='none'&&M.isTileUnlocked(x,y)) return {x,y,id:'#gardenTile-'+x+'-'+y};}return null;});
	await g.page.evaluate(id=>l(id.slice(1)).scrollIntoView({block:'center'}),tile.id);await sleep(400);
	const p=await center(g,tile.id);
	await tap(g,p);await sleep(800);
	const r=await g.page.evaluate(t=>Game.Objects['Farm'].minigame.plot[t.y][t.x][0],tile);
	await g.context.close();
	return {pass:r===1,detail:{tile,plot:r}};
}],
['T25','Pantheon: tap a spirit then a slot to place it','P1 minigame',async()=>{
	const g=await openGame();await richGame(g);
	const ok=await g.page.evaluate(async()=>{
		const T=Game.Objects['Temple'];T.getFree(1);T.level=1;Game.LoadMinigames();
		for (let i=0;i<100 && !(T.minigame && T.minigameLoaded);i++) await new Promise(r=>setTimeout(r,100));
		if (!T.minigame) return false;
		T.switchMinigame(1);await new Promise(r=>setTimeout(r,800));return true;
	});
	if (!ok) {await g.context.close();return {pass:false,detail:'pantheon did not load'};}
	await g.page.evaluate(()=>l('templeSlot0').scrollIntoView({block:'center'}));await sleep(400);
	const god=await center(g,'#templeGod0');
	await tap(g,god);await sleep(300);
	const slot=await center(g,'#templeSlot0');
	await tap(g,slot);await sleep(600);
	const r=await g.page.evaluate(()=>({slot0:Game.Objects['Temple'].minigame.slot[0],god0:Game.Objects['Temple'].minigame.godsById[0].id}));
	await g.context.close();
	return {pass:r.slot0===r.god0,detail:r};
}],
['T26','Ascension tree pans with a finger drag','P1 minigame',async()=>{
	const g=await openGame();
	await g.page.evaluate(()=>{Game.cookiesEarned=1e15;Game.Ascend(1);});
	await g.page.waitForFunction(()=>Game.OnAscend===1&&Game.AscendTimer===0,null,{timeout:20000}).catch(()=>{});
	await sleep(500);
	const x0=await g.page.evaluate(()=>[Game.AscendOffXT,Game.AscendOffYT,Game.scale,Game.AscendZoomT]);
	await swipe(g,{x:200,y:500},-120,-80,15);await sleep(600);
	const x1=await g.page.evaluate(()=>[Game.AscendOffXT,Game.AscendOffYT]);
	await g.context.close();
	const dx=x1[0]-x0[0],dy=x1[1]-x0[1];
	const ex=-120/x0[2]/x0[3],ey=-80/x0[2]/x0[3];
	const ok=Math.abs(dx-ex)<Math.abs(ex)*0.25&&Math.abs(dy-ey)<Math.abs(ey)*0.25;
	return {pass:ok,detail:{dx:+dx.toFixed(1),dy:+dy.toFixed(1),expected:[+ex.toFixed(1),+ey.toFixed(1)]}};
}],
['T27','tooltip closes when touching elsewhere','P2 ux',async()=>{
	const g=await openGame();await richGame(g);
	const p=await center(g,'#product0');
	await tap(g,p,{hold:800});await sleep(300);
	const on=await g.page.evaluate(()=>Game.tooltip.on);
	//a spot on the left panel that has no tooltip of its own
	const left=await g.page.evaluate(()=>{const r=l('sectionLeft').getBoundingClientRect(),vv=visualViewport;
		for (let f=0.6;f<0.98;f+=0.02){const x=r.left+r.width*0.15,y=r.top+r.height*f;const e=document.elementFromPoint(x,y);
			if (e && !e.closest('[onmouseover],#bigCookie,.shimmer')) return {x:(x-vv.offsetLeft)*vv.scale,y:(y-vv.offsetTop)*vv.scale,el:e.id};}
		return null;});
	await tap(g,left);await sleep(500);
	//Chromium's touch emulation sends a stray mouseover to (0,0) after a tap, which can open the
	//top bar's own tooltip; what matters is that the building tooltip is gone
	const r=await g.page.evaluate(()=>({on:Game.tooltip.on,display:Game.tooltip.tta.style.display,from:Game.tooltip.from&&Game.tooltip.from.id}));
	await g.context.close();
	return {pass:on===1&&(r.display==='none'||r.from!=='product0'),detail:{before:on,...r}};
}],
['T29','click sound starts quickly after the finger touches the cookie','P0 tap',async()=>{
	const g=await openGame();
	await g.page.evaluate(()=>{
		Game.prefs.cookiesound=1;
		window.__snd=[];window.__down=[];
		if (window.SoundInsts) SoundInsts.forEach(a=>a.addEventListener('playing',()=>__snd.push(performance.now())));
		const st=AudioBufferSourceNode.prototype.start;
		AudioBufferSourceNode.prototype.start=function(){if (this.buffer && this.buffer.length>1) __snd.push(performance.now());return st.apply(this,arguments);};
		window.addEventListener('touchstart',()=>__down.push(performance.now()),true);
	});
	const p=await center(g,'#bigCookie');
	for (let i=0;i<8;i++){await tap(g,p,{hold:20});await sleep(350);}//first taps warm caches/decoders
	await sleep(500);
	const r=await g.page.evaluate(()=>({snd:__snd,down:__down}));
	await g.context.close();
	const lat=r.down.slice(3).map(t=>{const s=r.snd.find(x=>x>=t-0.5);return s===undefined?null:s-t;}).filter(x=>x!==null&&x<1000);
	const p50=percentile(lat,0.5);
	return {pass:lat.length>=4&&p50!==null&&p50<30,detail:{measured:lat.length,sounds:r.snd.length},metrics:{sound_lat_p50_ms:p50!==null?+p50.toFixed(1):null,sound_lat_max_ms:lat.length?+Math.max(...lat).toFixed(1):null}};
}],
['T30','mouse / trackpad clicks still work exactly once (iPad, desktop)','P0 tap',async()=>{
	const g=await openGame();await recorder(g);await richGame(g);
	const c=await g.page.evaluate(()=>{const r=l('bigCookie').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});
	await g.page.mouse.click(c.x,c.y);await sleep(100);await g.page.mouse.click(c.x+5,c.y);await sleep(600);
	const pr=await g.page.evaluate(()=>{const r=l('product0').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});
	const a0=await g.page.evaluate(()=>Game.ObjectsById[0].amount);
	await g.page.mouse.click(pr.x,pr.y);await sleep(600);
	const r=await g.page.evaluate(a0=>({clicks:__rec.clicks.length,bought:Game.ObjectsById[0].amount-a0}),a0);
	await g.context.close();
	return {pass:r.clicks===2&&r.bought===1,detail:r};
}],
['T31','sliding the finger off a building cancels the purchase','P2 ux',async()=>{
	const g=await openGame();await richGame(g);
	const p=await center(g,'#product0');
	const a0=await g.page.evaluate(()=>Game.ObjectsById[0].amount);
	await swipe(g,p,-90,0,6);await sleep(600);
	const a1=await g.page.evaluate(()=>Game.ObjectsById[0].amount);
	await g.context.close();
	return {pass:a1===a0,detail:{bought:a1-a0}};
}],
['T32','Import save prompt: text field editable/pasteable, buttons work, no leftover scroll','P1 save',async()=>{
	const g=await openGame();
	await g.page.evaluate(()=>Game.ImportSave());await sleep(500);
	const st=await g.page.evaluate(()=>{const t=l('textareaPrompt');const cs=getComputedStyle(t);
		return {sel:cs.webkitUserSelect||cs.userSelect,callout:cs.webkitTouchCallout,ta:cs.touchAction,focused:document.activeElement===t};});
	await g.page.evaluate(()=>{l('textareaPrompt').value='not a save';window.scrollTo(0,40);});
	const btn=await g.page.evaluate(()=>{const b=[...document.querySelectorAll('#promptContent .option, #prompt a.option')].find(a=>/Nevermind/i.test(a.textContent));if (!b) return null;b.id=b.id||'evalNevermind';return '#'+b.id;});
	const p=btn?await center(g,btn):null;
	if (p) await tap(g,p);
	await sleep(900);
	const r=await g.page.evaluate(()=>({promptOn:Game.promptOn,scrollY:window.scrollY,gameTop:l('game').scrollTop}));
	await g.context.close();
	const ok=/text/.test(st.sel)&&st.callout!=='none'&&r.promptOn===0&&r.scrollY===0&&r.gameTop===0;
	return {pass:ok,detail:{...st,...r}};
}],
['T33','Home Screen app relaunch works offline (service worker cache)','P1 pwa',async()=>{
	const g=await openGame();
	await g.page.evaluate(()=>navigator.serviceWorker&&navigator.serviceWorker.ready).catch(()=>{});
	await sleep(6000);//first launch: let the worker take over and receive the warm-up list
	await g.context.setOffline(true);
	let ok=false,err='';
	try {
		await Promise.race([(async()=>{
			await g.page.reload({timeout:30000});
			await g.page.waitForFunction(()=>window.Game && Game.ready && Game.T>10 && Game.wrapper,null,{timeout:30000});
		})(),sleep(45000).then(()=>{throw new Error('offline relaunch did not reach Game.ready in 45s');})]);
		ok=true;
	} catch(e){err=e.message.split('\n')[0];}
	const broken=ok?await g.page.evaluate(()=>[...document.images].filter(i=>i.complete&&i.naturalWidth===0&&i.src).length):null;
	g.context.close().catch(()=>{});
	return {pass:ok,detail:{err,brokenImgs:broken}};
}],
['T34','cookie press feedback: cookie shrinks while the finger is down, releases after','P2 ux',async()=>{
	const g=await openGame();
	const p=await center(g,'#bigCookie');
	await touch(g,'touchStart',[{x:p.x,y:p.y,id:1}]);await sleep(80);
	const down=await g.page.evaluate(()=>Game.BigCookieState);
	await touch(g,'touchEnd',[]);await sleep(300);
	const up=await g.page.evaluate(()=>Game.BigCookieState);
	await g.context.close();
	return {pass:down===1&&up!==1,detail:{down,up}};
}],
['T35','Export prompt: one tap copies the save code to the clipboard','P1 save',async()=>{
	const g=await openGame();
	await g.context.grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(srv.base).origin});
	await g.page.evaluate(()=>Game.ExportSave());await sleep(400);
	const btn=await g.page.evaluate(()=>{const b=[...document.querySelectorAll('#prompt a')].find(a=>/copy/i.test(a.textContent));if (!b) return null;b.id=b.id||'evalCopy';return '#'+b.id;});
	if (!btn) {await g.context.close();return {pass:false,detail:'no copy button'};}
	await tap(g,await center(g,btn));await sleep(600);
	const r=await g.page.evaluate(async()=>({clip:await navigator.clipboard.readText().catch(e=>'ERR '+e.message),code:l('textareaPrompt').value}));
	await g.context.close();
	return {pass:r.clip.length>100&&r.clip===r.code,detail:{clipLen:r.clip.length,codeLen:r.code.length}};
}],
['T36','Import prompt: one tap pastes the save code from the clipboard','P1 save',async()=>{
	const g=await openGame();
	await g.context.grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(srv.base).origin});
	const code=await g.page.evaluate(async()=>{const c=Game.WriteSave(1);await navigator.clipboard.writeText(c);return c;});
	await g.page.evaluate(()=>Game.ImportSave());await sleep(400);
	const btn=await g.page.evaluate(()=>{const b=[...document.querySelectorAll('#prompt a')].find(a=>/paste/i.test(a.textContent));if (!b) return null;b.id=b.id||'evalPaste';return '#'+b.id;});
	if (!btn) {await g.context.close();return {pass:false,detail:'no paste button'};}
	await tap(g,await center(g,btn));await sleep(600);
	const v=await g.page.evaluate(()=>l('textareaPrompt').value);
	await g.context.close();
	return {pass:v===code,detail:{len:v.length}};
}],
['T37','standalone: viewport stuck small after the keyboard (iOS 26 bug) -> game still uses the full screen','P1 resume',async()=>{
	const g=await openGame(TARGET,{query:'?iosstandalone=1'});
	//control: a genuinely smaller window with no keyboard involved is respected
	await g.page.setViewportSize({width:393,height:700});await sleep(1200);
	const control=await g.page.evaluate(()=>Math.round(Game.windowH*Game.scale));
	await g.page.setViewportSize(PORTRAIT);await sleep(1200);
	//keyboard shown and dismissed, then WebKit keeps reporting the shrunk height
	await g.page.evaluate(()=>{Game.ImportSave();});await sleep(300);
	await g.page.evaluate(()=>{Game.ClosePrompt();document.activeElement&&document.activeElement.blur();});
	await g.page.setViewportSize({width:393,height:560});await sleep(1500);
	const stuck=await g.page.evaluate(()=>({h:Math.round(Game.windowH*Game.scale),body:document.body.style.height,inner:innerHeight}));
	await g.context.close();
	return {pass:control===700&&stuck.h===852,detail:{control,stuck}};
}],
['T28','no JavaScript errors during the whole suite','P0 stability',async()=>{
	const g=await openGame();await sleep(2000);await g.context.close();
	const mine=pageErrors.filter(e=>e.startsWith(TARGET));
	return {pass:mine.length===0,detail:mine.slice(0,5)};
}],
];

(async()=>{
	srv=await start(0);
	browser=await playwright.chromium.launch({args:['--autoplay-policy=no-user-gesture-required']});
	const results=[];
	for (const [id,name,group,fn] of EVALS){
		if (ONLY && !ONLY.includes(id)) continue;
		const t0=Date.now();
		let r;
		try {r=await Promise.race([fn(),sleep(EVAL_TIMEOUT_MS).then(()=>{throw new Error('eval timed out after '+EVAL_TIMEOUT_MS+'ms');})]);}
		catch(e){r={pass:false,detail:'EXCEPTION '+(e.stack||e).toString().split('\n').slice(0,3).join(' | ')};}
		r.id=id;r.name=name;r.group=group;r.ms=Date.now()-t0;
		results.push(r);
		if (!QUIET) console.log(`${r.pass===null?'SKIP':r.pass?'PASS':'FAIL'}  ${id}  ${name}${r.metrics?'  '+JSON.stringify(r.metrics):''}${r.pass?'':'\n        '+JSON.stringify(r.detail)}`);
	}
	await browser.close();srv.server.close();
	const graded=results.filter(r=>r.pass!==null);
	const passed=graded.filter(r=>r.pass).length;
	const summary={label:LABEL,target:TARGET,date:new Date().toISOString(),passed,total:graded.length,score:+(passed/graded.length).toFixed(3),results};
	fs.mkdirSync(path.join(__dirname,'results'),{recursive:true});
	fs.writeFileSync(path.join(__dirname,'results',LABEL+'.json'),JSON.stringify(summary,null,1));
	console.log(`\n${LABEL}: ${passed}/${graded.length} passed (score ${summary.score})`);
	process.exit(0);
})();
