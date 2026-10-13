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

async function openGame(file=TARGET,{viewport=PORTRAIT,insets=null,storage=null,init=null,query='',firstRun=false,screen=PORTRAIT}={}){
	const context=await browser.newContext({viewport,screen:{width:screen.width,height:screen.height},deviceScaleFactor:3,isMobile:true,hasTouch:true,userAgent:UA});
	await context.route(url=>!url.href.startsWith(srv.base.replace(/cookieclicker\/$/,'')),r=>r.abort());
	await context.addInitScript(([storage,firstRun])=>{
		try {
			localStorage.setItem('CookieClickerLang','EN');
			if (!firstRun && !localStorage.getItem('CookieClickerIOSUI')) localStorage.setItem('CookieClickerIOSUI',JSON.stringify({helpSeen:true}));//first-run help has its own eval
			if (storage) for (const k in storage) localStorage.setItem(k,storage[k]);
		} catch(e){}
	},[storage,firstRun]);
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

//portrait UI: the buildings/minigames live behind the Buildings tab; tap it like a player would
async function showBuildings(g){
	const tab=await center(g,'#iosTab-buildings');
	if (tab && tab.w>0) {await tap(g,tab);await sleep(400);}
}
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
['T14','long press on a building: tooltip while the finger is down, gone on release, nothing bought','P2 ux',async()=>{
	const g=await openGame();await richGame(g);
	const p=await center(g,'#product0');
	const a0=await g.page.evaluate(()=>Game.ObjectsById[0].amount);
	await touch(g,'touchStart',[{x:p.x,y:p.y,id:1}]);await sleep(800);
	const during=await g.page.evaluate(()=>Game.tooltip.on);
	await touch(g,'touchEnd',[]);await sleep(500);
	const r=await g.page.evaluate(()=>({amount:Game.ObjectsById[0].amount,after:Game.tooltip.tta.style.display}));
	await g.context.close();
	return {pass:r.amount===a0&&during===1&&r.after==='none',detail:{tooltipWhileHeld:during,tooltipAfterRelease:r.after,bought:r.amount-a0}};
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
		&&Math.abs(f1.scale-expectedScale(LANDSCAPE.width,LANDSCAPE.height))<0.002;
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
	//portrait is full-bleed: the art fills the screen, every control sits inside the safe area
	const r=await g.page.evaluate(()=>{const b=Game.wrapper.getBoundingClientRect(),c=l('cookies').getBoundingClientRect(),hb=document.getElementById('iosHelpButton'),tabs=[...document.querySelectorAll('.iosTab')];
		return {wrapTop:b.top,wrapBottom:b.bottom,top:Math.min(c.top,hb?hb.getBoundingClientRect().top:1e9),bottom:tabs.length?Math.max(...tabs.map(t=>t.getBoundingClientRect().bottom)):b.bottom,h:innerHeight};});
	await recorder(g);
	const p=await center(g,'#bigCookie');await tap(g,p);await sleep(500);
	const m=await g.page.evaluate(()=>({n:__rec.clicks.length,mx:Game.mouseX,my:Game.mouseY,cx:Game.cookieOriginX,cy:Game.cookieOriginY}));
	await g.page.setViewportSize(LANDSCAPE);
	await g.cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,bottom:21,left:59,right:59}});
	await g.page.evaluate(()=>window.dispatchEvent(new Event('resize')));await sleep(1500);
	const l=await g.page.evaluate(()=>{const b=Game.wrapper.getBoundingClientRect();return {left:b.left,right:b.right,bottom:b.bottom,w:innerWidth,h:innerHeight};});
	await g.context.close();
	const err=Math.hypot(m.mx-m.cx,m.my-m.cy);
	const ok=r.top>=insets.top-1&&r.bottom<=r.h-insets.bottom+1&&r.wrapTop<=1&&r.wrapBottom>=r.h-1&&m.n===1&&err<6&&l.left>=58&&l.right<=l.w-58&&l.bottom<=l.h-20;
	return {pass:ok,detail:{portrait:r,landscape:l,clicks:m.n,mouseErr:+err.toFixed(1)}};
}],
['T18','viewport self-repair after resume; no forced resizes while idle','P1 resume',async()=>{
	const g=await openGame();
	const scale0=await g.page.evaluate(()=>Game.scale);
	await g.page.evaluate(()=>{window.__rz=0;const o=Game.resize;Game.resize=function(){__rz++;return o.apply(this,arguments);};});
	await sleep(3000);
	const idle=await g.page.evaluate(()=>__rz);
	//simulate the WebKit standalone resume bug: stale layout from a bogus viewport size
	await g.page.evaluate(()=>{Game.wrapper.style.transform='scale(1)';Game.wrapper.style.width='800px';Game.scale=1;
		document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
	await sleep(1500);
	const f=await fits(g);
	await g.context.close();
	return {pass:idle===0&&f.ok&&Math.abs(f.scale-scale0)<0.002,detail:{idleResizes:idle,scale0,after:f}};
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
	await showBuildings(g);
	await g.page.evaluate(id=>{const c=l('centerArea'),t=l(id.slice(1)),r=t.getBoundingClientRect(),cr=c.getBoundingClientRect();c.scrollTop+=r.top-cr.top-cr.height/2;},tile.id);await sleep(400);
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
	await showBuildings(g);
	await g.page.evaluate(()=>{const c=l('centerArea'),r=l('templeSlot0').getBoundingClientRect(),cr=c.getBoundingClientRect();c.scrollTop+=r.top-cr.top-cr.height/3;});await sleep(400);
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
['T27','quick tap on a building buys it without flashing a tooltip over the store','P2 ux',async()=>{
	const g=await openGame();await richGame(g);
	await g.page.evaluate(()=>{window.__draws=0;const d=Game.tooltip.draw;Game.tooltip.draw=function(){__draws++;return d.apply(this,arguments);};});
	const p=await center(g,'#product0');
	const a0=await g.page.evaluate(()=>Game.ObjectsById[0].amount);
	for (let i=0;i<3;i++){await tap(g,p,{hold:60});await sleep(250);}
	await sleep(400);
	const r=await g.page.evaluate(a0=>({draws:__draws,bought:Game.ObjectsById[0].amount-a0,display:Game.tooltip.tta.style.display}),a0);
	await g.context.close();
	return {pass:r.draws===0&&r.bought===3&&r.display!=='block',detail:r};
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
	return {pass:Math.abs(control-700)<=2&&Math.abs(stuck.h-852)<=2,detail:{control,stuck}};
}],
['T38','portrait: readable size (text scale >= 0.95, not the 0.44 desktop shrink)','P2 portrait UI',async()=>{
	const g=await openGame();
	const r=await g.page.evaluate(()=>({scale:Game.scale,vv:visualViewport.scale,font:parseFloat(getComputedStyle(l('productName0')||document.body).fontSize)}));
	await g.context.close();
	const eff=r.scale*r.vv;
	return {pass:eff>=0.95,detail:r,metrics:{ui_scale:+eff.toFixed(3),building_name_pt:+(r.font*eff).toFixed(1)}};
}],
['T39','portrait: tab bar at the bottom (thumb zone), above the home indicator, every tab >= 44pt','P2 portrait UI',async()=>{
	const g=await openGame(TARGET,{insets:{top:59,bottom:34,left:0,right:0}});
	if (g.unsupported) return {pass:null,detail:g.unsupported};
	const r=await g.page.evaluate(()=>{const tabs=[...document.querySelectorAll('#iosTabBar .iosTab')];
		if (!tabs.length) return {tabs:0};
		const rs=tabs.map(t=>t.getBoundingClientRect());
		return {tabs:tabs.length,minW:Math.min(...rs.map(x=>x.width)),minH:Math.min(...rs.map(x=>x.height)),top:Math.min(...rs.map(x=>x.top)),bottom:Math.max(...rs.map(x=>x.bottom)),H:innerHeight};});
	await g.context.close();
	const ok=r.tabs>=5&&r.minW>=44&&r.minH>=44&&r.bottom<=r.H-34+1&&r.top>=r.H*0.8;
	return {pass:ok,detail:r};
}],
['T40','portrait: every tab opens its screen (store, buildings, stats, options, info, legacy prompt)','P2 portrait UI',async()=>{
	const g=await openGame();
	const has=await g.page.evaluate(()=>!!document.getElementById('iosTabBar'));
	if (!has) {await g.context.close();return {pass:false,detail:'no tab bar'};}
	const out={};
	const visibleAt=sel=>g.page.evaluate(sel=>{const e=document.querySelector(sel);if (!e) return false;const r=e.getBoundingClientRect();if (!r.width) return false;const h=document.elementFromPoint(r.left+r.width/2,r.top+Math.min(r.height/2,20));return !!h&&(e===h||e.contains(h));},sel);
	for (const [tab,check] of [['buildings',async()=>await visibleAt('#centerArea')&&await g.page.evaluate(()=>Game.onMenu==='')],
		['stats',async()=>g.page.evaluate(()=>Game.onMenu==='stats')],['prefs',async()=>g.page.evaluate(()=>Game.onMenu==='prefs')],
		['log',async()=>g.page.evaluate(()=>Game.onMenu==='log')],['store',async()=>visibleAt('#product0')],
		['legacy',async()=>g.page.evaluate(()=>!!Game.promptOn)]]){
		await tap(g,await center(g,'#iosTab-'+tab));await sleep(500);
		out[tab]=await check();
	}
	await g.context.close();
	return {pass:Object.values(out).every(Boolean),detail:out};
}],
['T41','portrait: store rows are full width and >= 44pt tall','P2 portrait UI',async()=>{
	const g=await openGame();await richGame(g);
	const r=await g.page.evaluate(()=>{const p=l('product0').getBoundingClientRect(),c=l('upgrades').querySelector('.crate');const cr=c?c.getBoundingClientRect():null;return {w:p.width,h:p.height,W:innerWidth,crate:cr?Math.min(cr.width,cr.height):null};});
	await g.context.close();
	return {pass:r.w>=r.W*0.9&&r.h>=44&&(r.crate===null||r.crate>=44),detail:r};
}],
['T42','portrait: whole big cookie is visible and tappable (not under a panel)','P2 portrait UI',async()=>{
	const g=await openGame();
	const r=await g.page.evaluate(()=>{const b=l('bigCookie').getBoundingClientRect();const cx=b.left+b.width/2,cy=b.top+b.height/2,R=b.width*0.4;
		const pts=[[cx,cy],[cx,cy-R],[cx,cy+R],[cx-R,cy],[cx+R,cy]];
		return {hits:pts.map(([x,y])=>{const e=document.elementFromPoint(x,y);return !!e&&e.id==='bigCookie';}),size:b.width};});
	await g.context.close();
	return {pass:r.hits.every(Boolean),detail:r};
}],
['T43','portrait: no content cut off sideways in any panel','P2 portrait UI',async()=>{
	const g=await openGame();await richGame(g);
	const out={};
	const measure=()=>g.page.evaluate(()=>{const f=id=>{const e=l(id);return e?e.scrollWidth-e.clientWidth:0;};return Math.max(f('sectionRight'),f('centerArea'),f('menu'),document.documentElement.scrollWidth-innerWidth);});
	out.store=await measure();
	for (const t of ['buildings','stats','prefs','log']){const p=await center(g,'#iosTab-'+t);if (p) {await tap(g,p);await sleep(500);}out[t]=await measure();}
	await g.context.close();
	return {pass:Object.values(out).every(v=>v<=1),detail:out};
}],
['T44','portrait: building tooltip fits on screen','P2 portrait UI',async()=>{
	const g=await openGame();await richGame(g);
	const p=await center(g,'#product0');
	await touch(g,'touchStart',[{x:p.x,y:p.y,id:1}]);await sleep(700);
	const r=await g.page.evaluate(()=>{const t=l('tooltip').getBoundingClientRect();return {l:t.left,r:t.right,t:t.top,b:t.bottom,W:innerWidth,H:innerHeight,on:Game.tooltip.on};});
	await touch(g,'touchEnd',[]);
	await g.context.close();
	return {pass:r.on===1&&r.l>=-1&&r.r<=r.W+1&&r.t>=-1&&r.b<=r.H+1,detail:r};
}],
['T45','notifications never block the cookie, the store or the tab bar','P2 portrait UI',async()=>{
	const g=await openGame();await recorder(g);
	await g.page.evaluate(()=>{for (let i=0;i<4;i++) Game.Notify('Test notification '+i,'This one has a description text','',0,1);});
	await sleep(400);
	const p=await center(g,'#bigCookie');
	await tap(g,p);await sleep(600);
	const r=await g.page.evaluate(()=>{const n=l('notes').getBoundingClientRect(),s=l('sectionRight').getBoundingClientRect(),tb=document.getElementById('iosTabBar');
		const under=(x,y)=>{const e=document.elementFromPoint(x,y);return e?(e.closest('#notes')?'notes':e.id||e.className):null;};
		return {clicks:__rec.clicks.length,overStore:n.bottom>s.top+2&&n.height>0,tab:tb?under(tb.getBoundingClientRect().left+20,tb.getBoundingClientRect().top+20):null};});
	await g.context.close();
	return {pass:r.clicks===1&&!r.overStore,detail:r};
}],
['T46','rotate: landscape gets the original 3-column layout, portrait gets the tab UI back (link bar hidden on iOS)','P2 portrait UI',async()=>{
	const g=await openGame();
	await tap(g,await center(g,'#iosTab-buildings')||{x:0,y:0});await sleep(300);
	await g.page.setViewportSize(LANDSCAPE);await sleep(1500);
	const land=await g.page.evaluate(()=>{const tb=document.getElementById('iosTabBar');return {tabBar:tb?getComputedStyle(tb).display:'none',topBar:getComputedStyle(l('topBar')).display,store:l('sectionRight').getBoundingClientRect().width,scale:Game.scale};});
	await g.page.setViewportSize(PORTRAIT);await sleep(1500);
	const port=await g.page.evaluate(()=>{const tb=document.getElementById('iosTabBar');return {tabBar:tb?getComputedStyle(tb).display:'none',active:(document.querySelector('.iosTab.on')||{}).id,topBar:getComputedStyle(l('topBar')).display};});
	const f=await fits(g);
	await g.context.close();
	const ok=land.tabBar==='none'&&land.store<400&&port.tabBar==='flex'&&port.active==='iosTab-buildings'&&port.topBar==='none'&&f.ok;
	return {pass:ok,detail:{land,port}};
}],
['T47','help: ? button (>=44pt) opens the touch-controls guide, X closes it','P2 help',async()=>{
	const g=await openGame();
	const btn=await center(g,'#iosHelpButton');
	if (!btn||!btn.w) {await g.context.close();return {pass:false,detail:'no help button'};}
	await tap(g,btn);await sleep(1500);
	const r=await g.page.evaluate(()=>{const o=document.getElementById('iosHelp');const f=o&&o.querySelector('iframe');let txt='';try {txt=f.contentDocument.body.innerText;} catch(e){}
		const rr=o?o.getBoundingClientRect():{width:0,height:0};return {open:!!o&&o.classList.contains('on'),cover:rr.width>=innerWidth-1&&rr.height>=innerHeight-1,hasTouch:/Touch controls|タッチ操作/.test(txt),hasLongPress:/Long press|長押し/.test(txt)};});
	const close=await center(g,'#iosHelp .iosHelpClose');
	await tap(g,close);await sleep(400);
	const closed=await g.page.evaluate(()=>!document.getElementById('iosHelp').classList.contains('on'));
	await g.context.close();
	return {pass:btn.w>=44&&btn.h>=44&&r.open&&r.cover&&r.hasTouch&&r.hasLongPress&&closed,detail:{btn:[Math.round(btn.w),Math.round(btn.h)],...r,closed}};
}],
['T48','help opens by itself on the very first launch only','P2 help',async()=>{
	const g=await openGame(TARGET,{firstRun:true});
	await sleep(1500);
	const first=await g.page.evaluate(()=>{const o=document.getElementById('iosHelp');return !!o&&o.classList.contains('on');});
	await g.page.reload();
	await g.page.waitForFunction(()=>window.Game&&Game.ready&&Game.T>10,null,{timeout:60000});await sleep(1500);
	const second=await g.page.evaluate(()=>{const o=document.getElementById('iosHelp');return !!o&&o.classList.contains('on');});
	await g.context.close();
	return {pass:first&&!second,detail:{first,second}};
}],
['T49','panel drawer: handle pulls the store up (more rows), again puts it back, state remembered','P2 portrait UI',async()=>{
	const g=await openGame();await richGame(g);
	const rows=()=>g.page.evaluate(()=>{const p=l('sectionRight').getBoundingClientRect();return [...document.querySelectorAll('#products .product')].filter(e=>{const r=e.getBoundingClientRect();return r.height>0&&r.top>=p.top-1&&r.bottom<=p.bottom+1;}).length;});
	const h=await center(g,'#iosPanelHandle');
	if (!h||!h.w) {await g.context.close();return {pass:false,detail:'no handle'};}
	const r0=await rows();
	await tap(g,h);await sleep(500);
	const r1=await rows();
	const countVisible=await g.page.evaluate(()=>{const c=l('cookies').getBoundingClientRect();const e=document.elementFromPoint(c.left+c.width/2,c.top+8);return !!e&&!e.closest('#sectionRight');});
	await g.page.reload();await g.page.waitForFunction(()=>window.Game&&Game.ready&&Game.T>10,null,{timeout:60000});await sleep(800);
	const remembered=await g.page.evaluate(()=>document.documentElement.classList.contains('ios-panel-expanded'));
	await tap(g,await center(g,'#iosPanelHandle'));await sleep(500);
	const back=await g.page.evaluate(()=>!document.documentElement.classList.contains('ios-panel-expanded'));
	await g.context.close();
	return {pass:r1>=r0+3&&countVisible&&remembered&&back,detail:{rowsBefore:r0,rowsExpanded:r1,countVisible,remembered,back}};
}],
['T50','long press never spends: sugar lump not harvested, garden plot not planted; tap still works','P1 minigame',async()=>{
	const g=await openGame();await richGame(g);
	await g.page.evaluate(()=>{window.__lump=0;const o=Game.clickLump;Game.clickLump=function(){__lump++;};Game.lumpsTotal=Math.max(Game.lumpsTotal,0);});
	await sleep(500);
	const lp=await center(g,'#lumps');
	if (!lp||!lp.w) {await g.context.close();return {pass:false,detail:'lumps not shown'};}
	await tap(g,lp,{hold:800});await sleep(400);
	const afterHold=await g.page.evaluate(()=>__lump);
	await tap(g,lp);await sleep(400);
	const afterTap=await g.page.evaluate(()=>__lump);
	//garden: long press with a seed selected must not plant
	const ok=await g.page.evaluate(async()=>{const F=Game.Objects['Farm'];F.getFree(1);F.level=1;Game.LoadMinigames();
		for (let i=0;i<100&&!(F.minigame&&F.minigameLoaded);i++) await new Promise(r=>setTimeout(r,100));
		if (!F.minigame) return false;F.switchMinigame(1);await new Promise(r=>setTimeout(r,800));F.minigame.seedSelected=0;return true;});
	let planted=null;
	if (ok){
		await showBuildings(g);
		const tile=await g.page.evaluate(()=>{const M=Game.Objects['Farm'].minigame;for (let y=0;y<6;y++)for (let x=0;x<6;x++){const t=l('gardenTile-'+x+'-'+y);if (t&&t.style.display!=='none'&&M.isTileUnlocked(x,y)) return {x,y,id:'#gardenTile-'+x+'-'+y};}return null;});
		await g.page.evaluate(id=>{const c=l('centerArea'),r=l(id.slice(1)).getBoundingClientRect(),cr=c.getBoundingClientRect();c.scrollTop+=r.top-cr.top-cr.height/2;},tile.id);await sleep(400);
		await tap(g,await center(g,tile.id),{hold:800});await sleep(500);
		planted=await g.page.evaluate(t=>Game.Objects['Farm'].minigame.plot[t.y][t.x][0],tile);
	}
	await g.context.close();
	return {pass:afterHold===0&&afterTap===1&&planted===0,detail:{lumpAfterHold:afterHold,lumpAfterTap:afterTap,gardenPlantedByHold:planted}};
}],
['T51','ascension: long press a heavenly upgrade = info only, tap buys it','P1 minigame',async()=>{
	const g=await openGame();
	await g.page.evaluate(()=>{Game.cookiesEarned=1e15;Game.heavenlyChips=1e6;Game.Ascend(1);});
	await g.page.waitForFunction(()=>Game.OnAscend===1&&Game.AscendTimer===0,null,{timeout:20000}).catch(()=>{});
	await sleep(800);
	const sel=await g.page.evaluate(()=>{const c=[...document.querySelectorAll('#ascendUpgrades .crate')].find(e=>{const u=Game.UpgradesById[e.dataset.id];const r=e.getBoundingClientRect();return u&&!u.bought&&r.top>60&&r.bottom<innerHeight-10&&r.left>0&&r.right<innerWidth&&u.canBePurchased!==false;});if (!c) return null;c.id=c.id||'evalHeavenly';return {sel:'#'+c.id,id:+c.dataset.id};});
	if (!sel) {await g.context.close();return {pass:false,detail:'no heavenly upgrade on screen'};}
	await tap(g,await center(g,sel.sel),{hold:800});await sleep(500);
	const held=await g.page.evaluate(id=>Game.UpgradesById[id].bought,sel.id);
	await tap(g,await center(g,sel.sel));await sleep(600);
	const tapped=await g.page.evaluate(id=>Game.UpgradesById[id].bought,sel.id);
	await g.context.close();
	return {pass:held===0&&tapped===1,detail:{upgrade:sel.id,boughtByHold:held,boughtByTap:tapped}};
}],
['T52','no broken images or assets on any screen (tabs, 4 minigames, ascension, help, landscape)','P2 visual',async()=>{
	const g=await openGame();await richGame(g);
	const bad=new Set();
	g.page.on('response',r=>{if (r.url().startsWith(srv.base)&&r.status()>=400) bad.add(r.status()+' '+r.url().replace(srv.base,''));});
	const css=new Set();
	const sweep=async label=>{
		const r=await g.page.evaluate(()=>{const imgs=[],urls=new Set();
			document.querySelectorAll('img').forEach(i=>{if (i.offsetParent&&i.complete&&i.naturalWidth===0) imgs.push(i.src);});
			document.querySelectorAll('*').forEach(e=>{const bg=getComputedStyle(e).backgroundImage;(bg.match(/url\("([^"]+)"\)/g)||[]).forEach(u=>urls.add(u.slice(5,-2)));});
			return {imgs,urls:[...urls]};});
		r.imgs.forEach(u=>bad.add(label+' img '+u));r.urls.forEach(u=>css.add(u));
	};
	await sweep('store');
	await g.page.evaluate(async()=>{for (const n of ['Farm','Temple','Wizard tower','Bank']){const o=Game.Objects[n];o.getFree(1);o.level=1;}Game.LoadMinigames();
		for (let i=0;i<100;i++){if (['Farm','Temple','Wizard tower','Bank'].every(n=>Game.Objects[n].minigameLoaded)) break;await new Promise(r=>setTimeout(r,100));}
		for (const n of ['Farm','Temple','Wizard tower','Bank']) Game.Objects[n].switchMinigame(1);});
	for (const t of ['buildings','stats','prefs','log']){const p=await center(g,'#iosTab-'+t);if (p) {await tap(g,p);await sleep(600);}await sweep(t);}
	const hb=await center(g,'#iosHelpButton');if (hb) {await tap(g,hb);await sleep(1500);}
	const helpBroken=await g.page.evaluate(()=>{const f=document.querySelector('#iosHelp iframe');if (!f) return [];return [...f.contentDocument.images].filter(i=>i.complete&&i.naturalWidth===0).map(i=>i.src);});
	helpBroken.forEach(u=>bad.add('help img '+u));
	await g.page.evaluate(()=>{IOSFixes.portrait.closeHelp();Game.cookiesEarned=1e15;Game.Ascend(1);});
	await g.page.waitForFunction(()=>Game.OnAscend===1&&Game.AscendTimer===0,null,{timeout:20000}).catch(()=>{});await sleep(800);
	await sweep('ascend');
	await g.page.evaluate(()=>Game.Reincarnate(1));await sleep(2500);
	await g.page.setViewportSize(LANDSCAPE);await sleep(1500);await sweep('landscape');
	const cssBad=await g.page.evaluate(async us=>{const out=[];for (const u of us){if (!u.startsWith(location.origin)) continue;try {const r=await fetch(u);if (!r.ok) out.push(r.status+' '+u);} catch(e){out.push('ERR '+u);}}return out;},[...css]);
	cssBad.forEach(x=>bad.add('css '+x));
	await g.context.close();
	return {pass:bad.size===0,detail:{problems:[...bad].slice(0,10),cssImagesChecked:css.size},metrics:{css_images_checked:css.size}};
}],
['T53','ascension screen is clean: no tab bar / drawer handle / help button, notifications clear of the top buttons','P2 visual',async()=>{
	const g=await openGame();
	await g.page.evaluate(()=>{Game.cookiesEarned=1e15;Game.Ascend(1);});
	await g.page.waitForFunction(()=>Game.OnAscend===1&&Game.AscendTimer===0,null,{timeout:20000}).catch(()=>{});await sleep(600);
	await g.page.evaluate(()=>Game.Notify('Test','Notification during ascension','',0,1));await sleep(400);
	const r=await g.page.evaluate(()=>{const vis=id=>{const e=document.getElementById(id);if (!e) return false;const cs=getComputedStyle(e),b=e.getBoundingClientRect();return cs.display!=='none'&&cs.visibility!=='hidden'&&b.width>0&&b.height>0;};
		const btn=document.getElementById('ascendButton')||document.querySelector('#ascendOverlay .framed');const n=l('notes').getBoundingClientRect();let overlap=false;
		if (btn){const b=btn.getBoundingClientRect();overlap=!(n.bottom<=b.top||n.top>=b.bottom||n.right<=b.left||n.left>=b.right)&&n.height>0;}
		return {tabBar:vis('iosTabBar'),handle:vis('iosPanelHandle'),help:vis('iosHelpButton'),notesOverTopButton:overlap};});
	await g.context.close();
	return {pass:!r.tabBar&&!r.handle&&!r.help&&!r.notesOverTopButton,detail:r};
}],
['T54','each tab keeps its own scroll position; a menu never opens half-scrolled from another tab','P2 portrait UI',async()=>{
	const g=await openGame();await richGame(g);
	await tap(g,await center(g,'#iosTab-stats'));await sleep(500);
	await g.page.evaluate(()=>{l('centerArea').scrollTop=600;});await sleep(200);
	const stats=await g.page.evaluate(()=>l('centerArea').scrollTop);
	await tap(g,await center(g,'#iosTab-log'));await sleep(500);
	const info=await g.page.evaluate(()=>l('centerArea').scrollTop);
	await tap(g,await center(g,'#iosTab-stats'));await sleep(500);
	const back=await g.page.evaluate(()=>l('centerArea').scrollTop);
	await g.context.close();
	return {pass:stats>100&&info===0&&Math.abs(back-stats)<=2,detail:{statsScrolled:stats,infoOpenedAt:info,statsRestored:back}};
}],
['T55','progress survives a relaunch: 60s autosave, save on leaving the app, and nothing saved if autosave is off','P0 save',async()=>{
	const g=await openGame();
	//1) the game's own autosave fires on the next 60-second tick
	const auto=await g.page.evaluate(async()=>{
		localStorage.removeItem(Game.SaveTo);
		Game.cookies=111111;Game.ObjectsById[0].getFree(3);
		Game.T=Game.fps*60*Math.ceil((Game.T+Game.fps*11)/(Game.fps*60))-2;//two ticks before a 60s boundary
		await new Promise(r=>setTimeout(r,800));
		return !!localStorage.getItem(Game.SaveTo);
	});
	//2) relaunch restores it
	await g.page.reload();await g.page.waitForFunction(()=>window.Game&&Game.ready&&Game.T>10,null,{timeout:60000});
	const restored=await g.page.evaluate(()=>({cookies:Math.floor(Game.cookies),cursors:Game.ObjectsById[0].amount}));
	//3) leaving the app saves the latest state immediately (no waiting for the next tick)
	await g.page.evaluate(()=>{Game.T=Math.max(Game.T,Game.fps*20);Game.cookies=222222;Game.ObjectsById[1].getFree(4);
		Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});document.dispatchEvent(new Event('visibilitychange'));delete document.visibilityState;});
	await g.page.reload();await g.page.waitForFunction(()=>window.Game&&Game.ready&&Game.T>10,null,{timeout:60000});
	const afterHide=await g.page.evaluate(()=>({cookies:Math.floor(Game.cookies),grandmas:Game.ObjectsById[1].amount}));
	//4) with autosave turned off in Options, leaving the app does not save either (respects the player's setting)
	const respected=await g.page.evaluate(()=>{Game.prefs.autosave=0;const before=localStorage.getItem(Game.SaveTo);Game.T=Math.max(Game.T,Game.fps*20);Game.cookies=333333;
		Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});document.dispatchEvent(new Event('visibilitychange'));delete document.visibilityState;
		return localStorage.getItem(Game.SaveTo)===before;});
	await g.context.close();
	const ok=auto&&restored.cookies>=111111&&restored.cursors===3&&afterHide.cookies>=222222&&afterHide.grandmas===4&&respected;
	return {pass:ok,detail:{autosaveWrote:auto,restoredAfterRelaunch:restored,restoredAfterLeavingApp:afterHide,autosaveOffRespected:respected}};
}],
['T56','iPhone Air Home Screen app: iOS reports the height short by the status bar -> still no empty band at the bottom','P1 viewport',async()=>{
	//iPhone Air is 420x912pt; iOS 26 standalone can report innerHeight=844 (912 minus the 68pt status bar)
	const g=await openGame(TARGET,{viewport:{width:420,height:844},screen:{width:420,height:912},insets:{top:68,bottom:34,left:0,right:0},query:'?iosstandalone=1'});
	if (g.unsupported) return {pass:null,detail:g.unsupported};
	const r=await g.page.evaluate(()=>{const w=Game.wrapper.getBoundingClientRect(),tabs=[...document.querySelectorAll('.iosTab')],tb=document.getElementById('iosTabBar').getBoundingClientRect();
		return {inner:innerHeight,wrapperBottom:Math.round(w.bottom),tabBarBottom:Math.round(tb.bottom),tabsBottom:Math.round(Math.max(...tabs.map(t=>t.getBoundingClientRect().bottom))),bodyH:document.body.getBoundingClientRect().height};});
	await g.context.close();
	const ok=r.wrapperBottom>=911&&r.tabBarBottom>=911&&r.tabsBottom<=912-34+1&&r.tabsBottom>=912-34-8;
	return {pass:ok,detail:r};
}],
['T57','portrait is full screen: game art behind the status bar, tab bar down to the bottom edge, no black bands','P1 viewport',async()=>{
	const g=await openGame(TARGET,{insets:{top:59,bottom:34,left:0,right:0}});
	if (g.unsupported) return {pass:null,detail:g.unsupported};
	await sleep(400);
	const r=await g.page.evaluate(()=>{const at=(x,y)=>{const e=document.elementFromPoint(x,y);return e?(e.closest('#iosTabBar')?'tabBar':e.closest('#sectionLeft')?'cookiePanel':(e.id||e.tagName)):null;};
		const W=innerWidth,H=innerHeight;return {statusBarArea:at(W/2,20),homeIndicatorArea:at(W/2,H-10),cookies:l('cookies').getBoundingClientRect().top};});
	await g.context.close();
	return {pass:r.statusBarArea==='cookiePanel'&&r.homeIndicatorArea==='tabBar'&&r.cookies>=58,detail:r};
}],
['T58','long-press tooltip sits next to the pressed button and does not move while shown','P2 ux',async()=>{
	const g=await openGame();await richGame(g);
	const sel='#product2';
	const p=await center(g,sel);
	const rect=()=>g.page.evaluate(()=>{const r=l('tooltip').getBoundingClientRect();return [Math.round(r.top),Math.round(r.left),Math.round(r.bottom)];});
	await touch(g,'touchStart',[{x:p.x,y:p.y,id:1}]);await sleep(600);
	const r1=await rect();
	await touch(g,'touchMove',[{x:p.x+3,y:p.y+4,id:1}]);await sleep(300);//a slight wobble of the finger
	const r2=await rect();await sleep(400);
	const r3=await rect();
	const el=await g.page.evaluate(s=>{const r=document.querySelector(s).getBoundingClientRect();return [Math.round(r.top),Math.round(r.bottom)];},sel);
	await touch(g,'touchEnd',[]);await sleep(300);
	const after=await g.page.evaluate(()=>Game.tooltip.tta.style.display);
	await g.context.close();
	const still=JSON.stringify(r1)===JSON.stringify(r2)&&JSON.stringify(r2)===JSON.stringify(r3);
	const beside=r1[2]<=el[0]+1||r1[0]>=el[1]-1;//entirely above or below the button
	return {pass:still&&beside&&after==='none',detail:{tooltip:[r1,r2,r3],button:el,afterRelease:after}};
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
