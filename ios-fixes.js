/*
	ios-fixes.js — iPhone / iOS (Safari + Home Screen web app) layer for Cookie Clicker.

	Loaded right after main.js by index.html. It only touches input plumbing,
	viewport/layout, audio playback and PWA behaviour. Game logic, balance,
	the save format and the localStorage save key (Game.SaveTo) are untouched.

	Sub-systems (each can be switched off for field debugging, see CONFIG):
	  fastTap   - pointer-event based taps for the big cookie, golden cookies,
	              buildings and store upgrades (no 350ms wait, no ghost clicks,
	              no double purchases, multi-finger drumming works)
	  zoomGuard - blocks pinch / double-tap zoom even where WebKit ignores
	              the viewport limits or touch-action
	  layout    - keeps the game inside the safe area, fixes touch->game
	              coordinate mapping at scale!=1 and repairs the viewport after
	              rotation, keyboard or background/resume glitches
	  audio     - plays game sounds through Web Audio (low latency on iOS)
	  lifecycle - saves when the app is sent to background (iOS kills
	              suspended web apps without unload events)
*/
(function(){
'use strict';

var DEFAULTS={fastTap:true,zoomGuard:true,layout:true,audio:true,lifecycle:true,debug:false};
var CONFIG={};
(function(){
	var stored={};
	try {stored=JSON.parse(window.localStorage.getItem('CookieClickerIOSFixes')||'{}')||{};} catch(e){}
	for (var k in DEFAULTS) CONFIG[k]=(typeof stored[k]==='boolean')?stored[k]:DEFAULTS[k];
	var q=window.location.search;
	if (/[?&]iosdebug=1\b/.test(q)) CONFIG.debug=true;
	var off=/[?&]iosoff=([a-zA-Z,]+)/.exec(q);
	if (off) off[1].split(',').forEach(function(k){if (k in DEFAULTS) CONFIG[k]=false;});
})();

var TAP_SLOP=10;//px of finger movement before a touch stops being a tap
var LONG_PRESS_MS=500;//holding longer than this only shows the tooltip (no purchase)
var GHOST_CLICK_MS=800;//window in which a native click after a handled tap is swallowed

var docEl=document.documentElement;
var standalone=!!(window.navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches));
docEl.classList.add('ios-fixes');
docEl.classList.add(standalone?'ios-standalone':'ios-browser');

var now=function(){return (window.performance && performance.now)?performance.now():Date.now();};
var log=function(){
	if (!CONFIG.debug) return;
	var args=['[ios-fixes '+now().toFixed(1)+'ms]'].concat([].slice.call(arguments));
	console.log.apply(console,args);
	IOSFixes.debugLog.push(args.join(' '));
	if (IOSFixes.debugLog.length>500) IOSFixes.debugLog.shift();
};
var gameReady=function(){return typeof Game!=='undefined' && Game.ready;};

var IOSFixes=window.IOSFixes={config:CONFIG,standalone:standalone,debugLog:[],stats:{fastTaps:0,ghostClicksBlocked:0,resizes:0,viewportRepairs:0,hideSaves:0}};

/*=====================================================================================
COORDINATES
Game code expects: mouse = position inside #game in logical (unscaled) px,
getBounds() = element rect relative to #wrapper in logical px.
Vanilla computes (pageY-TopBarOffset)/scale which is off by ~33px when scale!=1,
and nothing accounts for #wrapper being moved into the safe area.
=======================================================================================*/
var wrapperOrigin=function(){
	var w=typeof Game!=='undefined' && Game.wrapper;
	if (!w) return {x:0,y:0};
	return {x:w.offsetLeft||0,y:w.offsetTop||0};
};
var toGame=function(clientX,clientY){
	var o=wrapperOrigin();
	var s=(typeof Game!=='undefined' && Game.scale)||1;
	var top=(typeof TopBarOffset!=='undefined')?TopBarOffset:0;
	return {x:(clientX-o.x)/s,y:(clientY-o.y)/s-top};
};
var setMouse=function(clientX,clientY){
	if (!gameReady()) return;
	var p=toGame(clientX,clientY);
	Game.mouseX=p.x;
	Game.mouseY=p.y;
};
IOSFixes.toGame=toGame;

if (CONFIG.layout)
{
	var boundsFrom=function(el){
		var b=el.getBoundingClientRect();
		var o=wrapperOrigin();
		var s=(typeof Game!=='undefined' && Game.scale)||1;
		var r={};
		r.left=r.x=(b.left-o.x)/s;
		r.top=r.y=(b.top-o.y)/s;
		r.width=b.width/s;
		r.height=b.height/s;
		r.right=r.left+r.width;
		r.bottom=r.top+r.height;
		r.centerx=r.left+r.width/2;
		r.centery=r.top+r.height/2;
		return r;
	};
	window.getBounds=boundsFrom;
	Element.prototype.getBounds=function(){return boundsFrom(this);};

	//these run after main.js's own listeners on the same targets, so they correct its values
	document.addEventListener('mousemove',function(e){setMouse(e.clientX,e.clientY);});
	document.addEventListener('touchstart',function(e){
		if (gameReady() && Game.mobileDown && e.touches.length===1) setMouse(e.touches[0].clientX,e.touches[0].clientY);
	},{passive:true});
	document.addEventListener('touchmove',function(e){
		if (gameReady() && (!Game.mouseDown || Game.mobileDown) && e.touches.length===1) setMouse(e.changedTouches[0].clientX,e.changedTouches[0].clientY);
	},{passive:true});
}

/*=====================================================================================
FAST TAP
WebKit only dispatches click after deciding the tap is not a double-tap, and drops
or delays clicks when hover handlers change content (tooltips!). Pointer events are
dispatched immediately, so we act on pointerup and cancel the compatibility mouse
events + click for that touch (touchend.preventDefault), with a click-capture
safety net so a purchase can never happen twice.
=======================================================================================*/
var FAST_SELECTOR='#bigCookie,.shimmer,#products .product,#store .crate.upgrade';
var INNER_CLICKABLE='a,button,input,textarea,select,label,.productButton';
var fastTargetOf=function(node){
	if (!node || !node.closest) return null;
	var el=node.closest(FAST_SELECTOR);
	if (!el) return null;
	var inner=node.closest(INNER_CLICKABLE);
	if (inner && inner!==el && el.contains(inner)) return null;//let nested controls behave natively
	if (typeof Game!=='undefined' && (Game.promptOn || Game.OnAscend)) return null;
	return el;
};
IOSFixes.fastTargetOf=fastTargetOf;

if (CONFIG.fastTap && window.PointerEvent)
{
	var taps={};//pointerId -> tap record
	var touches={};//touch identifier -> {el,x,y,moved}
	var lastTouchPointerAt=-1e9;
	var lastFastTapAt=-1e9;
	var lastPointerType='';

	var hideStaleTooltip=function(target){
		if (!gameReady() || !Game.tooltip) return;
		var from=Game.tooltip.from;
		if (!Game.tooltip.on || (from && from.contains && from.contains(target))) return;
		Game.tooltip.hide();//no mouseout ever comes for a finger, so close it when touching elsewhere
		if (Game.setOnCrate && Game.onCrate && !(Game.onCrate.contains && Game.onCrate.contains(target))) Game.setOnCrate(0);
	};

	document.addEventListener('pointerdown',function(e){
		lastPointerType=e.pointerType;
		if (e.pointerType!=='touch') return;
		var el=fastTargetOf(e.target);
		if (!el) return;
		if (el.classList.contains('shimmer'))
		{
			//golden cookies / storm drops move and fade: pop them the moment the finger lands
			if (!gameReady()) return;
			lastFastTapAt=now();
			IOSFixes.stats.fastTaps++;
			if (CONFIG.layout) setMouse(e.clientX,e.clientY);
			Game.lastActivity=Game.time;
			el.click();
			log('shimmer popped on pointerdown');
			return;
		}
		taps[e.pointerId]={el:el,x:e.clientX,y:e.clientY,t:now(),moved:false};
		if (CONFIG.layout) setMouse(e.clientX,e.clientY);
		if (el.id==='bigCookie' && gameReady()) Game.BigCookieState=1;
		log('pointerdown',el.id||el.className,'@',e.clientX,e.clientY);
	},true);

	document.addEventListener('pointermove',function(e){
		var tap=taps[e.pointerId];
		if (!tap) return;
		if (Math.abs(e.clientX-tap.x)>TAP_SLOP || Math.abs(e.clientY-tap.y)>TAP_SLOP) tap.moved=true;
	},true);

	var endTap=function(e){
		var tap=taps[e.pointerId];
		if (!tap) return null;
		delete taps[e.pointerId];
		if (tap.el.id==='bigCookie' && gameReady()) Game.BigCookieState=0;
		return tap;
	};
	document.addEventListener('pointercancel',function(e){endTap(e);},true);

	document.addEventListener('pointerup',function(e){
		var tap=endTap(e);
		if (!tap) return;
		var t=now();
		if (tap.moved || t-tap.t>LONG_PRESS_MS) {log('pointerup ignored',tap.moved?'moved':'long press');return;}
		//the finger must still be on the same element (lets you slide off to cancel, like a mouse)
		var under=document.elementFromPoint(e.clientX,e.clientY);
		if (!under || !(tap.el===under || tap.el.contains(under))) {log('pointerup ignored: slid off');return;}
		if (!gameReady()) return;
		lastFastTapAt=t;
		IOSFixes.stats.fastTaps++;
		if (CONFIG.layout) setMouse(e.clientX,e.clientY);
		Game.lastActivity=Game.time;
		if (tap.el.id==='bigCookie')
		{
			//no event object on purpose: ClickCookie throttles events whose detail is 0 (PointerEvent.detail) to 3/s
			Game.ClickCookie();
			log('ClickCookie via pointerup, latency',(now()-t).toFixed(2),'ms, total clicks',Game.cookieClicks);
		}
		else
		{
			tap.el.click();//runs the element's own click listener / onclick attribute exactly once
			log('fast click',tap.el.id||tap.el.className);
		}
	},true);

	//touch events: stop the browser from synthesizing mouse events + click (= duplicate action) for taps we handle
	document.addEventListener('touchstart',function(e){
		for (var i=0;i<e.changedTouches.length;i++)
		{
			var t=e.changedTouches[i];
			var el=fastTargetOf(t.target);
			hideStaleTooltip(t.target);
			if (el) touches[t.identifier]={el:el,x:t.clientX,y:t.clientY};
			//the big cookie never needs scrolling or zooming: cancel every native gesture on it
			if (el && el.id==='bigCookie' && e.cancelable) e.preventDefault();
		}
	},{capture:true,passive:false});
	document.addEventListener('touchmove',function(e){
		for (var i=0;i<e.changedTouches.length;i++)
		{
			var t=e.changedTouches[i],rec=touches[t.identifier];
			if (rec && (Math.abs(t.clientX-rec.x)>TAP_SLOP || Math.abs(t.clientY-rec.y)>TAP_SLOP)) rec.moved=true;
		}
	},{capture:true,passive:true});
	document.addEventListener('touchend',function(e){
		for (var i=0;i<e.changedTouches.length;i++)
		{
			var t=e.changedTouches[i],rec=touches[t.identifier];
			delete touches[t.identifier];
			if (rec && !rec.moved && e.cancelable) e.preventDefault();
		}
	},{capture:true,passive:false});
	document.addEventListener('touchcancel',function(e){
		for (var i=0;i<e.changedTouches.length;i++) delete touches[e.changedTouches[i].identifier];
	},{capture:true,passive:true});

	//safety net: if a native click still arrives for a tap we already handled, swallow it
	document.addEventListener('click',function(e){
		if (!e.isTrusted || lastPointerType!=='touch') return;
		if (now()-lastFastTapAt>GHOST_CLICK_MS) return;
		if (!fastTargetOf(e.target) && !(e.target && e.target.closest && e.target.closest(FAST_SELECTOR))) return;
		e.stopImmediatePropagation();
		e.preventDefault();
		IOSFixes.stats.ghostClicksBlocked++;
		log('ghost click blocked on',e.target.id||e.target.className);
	},true);
}

/*=====================================================================================
ZOOM GUARD
user-scalable=no + touch-action cover the normal cases. These cover the rest:
Safari's "ignore viewport scale limits", touch-action not applied through
position:absolute descendants (WebKit #218015), and multi-finger pinches.
=======================================================================================*/
if (CONFIG.zoomGuard)
{
	var block=function(e){if (e.cancelable) e.preventDefault();};
	['gesturestart','gesturechange','gestureend'].forEach(function(n){document.addEventListener(n,block,{passive:false});});
	document.addEventListener('touchmove',function(e){
		if (e.touches.length>1 || (typeof e.scale==='number' && e.scale!==1)) block(e);
	},{passive:false});
	document.addEventListener('dblclick',block,{passive:false});
}

/*=====================================================================================
LAYOUT / VIEWPORT
Layout model: the viewport is device-width and never zooms; the game keeps its own
800px-minimum logical layout and #wrapper is scaled with transform (that is what
Game.resize already does). We only (1) move #wrapper inside the safe area and
(2) re-run Game.resize when the viewport really changed or is visibly broken.
=======================================================================================*/
var probe=null;
var readInsets=function(){
	if (!probe)
	{
		probe=document.createElement('div');
		probe.id='iosSafeAreaProbe';
		probe.setAttribute('aria-hidden','true');
		probe.style.cssText='position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;'+
			'padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);'+
			'padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);';
		(document.body||docEl).appendChild(probe);
	}
	var cs=window.getComputedStyle(probe);
	return {
		t:Math.round(parseFloat(cs.paddingTop)||0),
		r:Math.round(parseFloat(cs.paddingRight)||0),
		b:Math.round(parseFloat(cs.paddingBottom)||0),
		l:Math.round(parseFloat(cs.paddingLeft)||0)
	};
};
IOSFixes.readInsets=readInsets;

var viewportMeta=document.querySelector('meta[name=viewport]');
var VIEWPORT_CONTENT=viewportMeta?viewportMeta.getAttribute('content'):'';
var lastSignature='';
var signature=function(){
	var ins=readInsets();
	var size=layoutSize();
	return [window.innerWidth,window.innerHeight,size.H,ins.t,ins.r,ins.b,ins.l].join(',');
};

//iOS standalone: after the software keyboard has been shown once, innerHeight/visualViewport can stay
//shrunk until the app is killed (bugs.webkit.org 218983, 301994). When that happens on an iPhone
//Home Screen app, lay the game out for the real screen height instead of the stale one.
var keyboardSeen=false;
var textFocused=function(){var a=document.activeElement;return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));};
document.addEventListener('focusin',function(){if (textFocused()) keyboardSeen=true;});
var forceStandalone=/[?&]iosstandalone=1\b/.test(window.location.search);//test hook
var fullHeights={};//width -> tallest height seen before any keyboard (per orientation)
var layoutSize=function(){
	var W=window.innerWidth,H=window.innerHeight,shrunk=false;
	if (!keyboardSeen) {fullHeights[W]=Math.max(fullHeights[W]||0,H);return {W:W,H:H,shrunk:false};}
	if ((standalone || forceStandalone) && !textFocused() && /iPhone|iPod/.test(navigator.userAgent))
	{
		var expectedH=fullHeights[W];
		if (!expectedH && window.screen && screen.width && screen.height)
		{
			var short=Math.min(screen.width,screen.height),long=Math.max(screen.width,screen.height);
			expectedH=(W<=short+2)?long:short;
		}
		if (expectedH && H<expectedH-2 && expectedH-H<500) {H=expectedH;shrunk=true;}
	}
	return {W:W,H:H,shrunk:shrunk};
};
IOSFixes.layoutSize=layoutSize;

var installLayout=function(){
	var origResize=Game.resize;
	Game.resize=function(){
		IOSFixes.stats.resizes++;
		origResize.apply(this,arguments);
		var wrapper=Game.wrapper;
		var ins=readInsets();
		var size=layoutSize(),W=size.W,H=size.H;
		lastSignature=signature();
		document.body.style.height=size.shrunk?H+'px':'';
		document.body.style.bottom=size.shrunk?'auto':'';
		if (size.shrunk) log('standalone viewport stuck at',window.innerHeight,'- using screen height',H);
		if (!(ins.t||ins.r||ins.b||ins.l) && !size.shrunk)
		{
			wrapper.style.left='';
			wrapper.style.top='';
			return;
		}
		//same formula as Game.resize, applied to the safe area instead of the whole window
		var w=Math.max(1,W-ins.l-ins.r);
		var h=Math.max(1,H-ins.t-ins.b);
		var zoom=Game.zoom||1;
		var scale=Math.min(w/Math.max(800*zoom,w),h/Math.max(200*zoom,h))*zoom;
		Game.windowW=Math.floor(w/scale);
		Game.windowH=Math.floor(h/scale);
		wrapper.style.left=ins.l+'px';
		wrapper.style.top=ins.t+'px';
		if (scale!=1)
		{
			wrapper.style.transform='scale('+scale+')';
			wrapper.style.width=Game.windowW+'px';
			wrapper.style.height=Game.windowH+'px';
		}
		else
		{
			wrapper.style.removeProperty('transform');
			wrapper.style.width=w+'px';
			wrapper.style.height=h+'px';
		}
		Game.scale=scale;
		//the original already ran these against the full-window size; canvases must match the safe area
		for (var i in Game.Objects)
		{
			var me=Game.Objects[i];
			me.toResize=true;
			if (me.minigame && me.minigame.onResize) me.minigame.onResize();
		}
		for (var j=0;j<Game.onResizeCallbacks.length;j++) Game.onResizeCallbacks[j](w,h);
		log('resize',W+'x'+H,'insets',JSON.stringify(ins),'scale',scale.toFixed(4),'logical',Game.windowW+'x'+Game.windowH);
	};
	Game.resize();
};

var resetScroll=function(){
	var active=document.activeElement;
	if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return false;//keyboard is up; iOS needs that scroll
	var fixed=false;
	if (window.scrollX || window.scrollY) {window.scrollTo(0,0);fixed=true;}
	[document.body,typeof Game!=='undefined'?Game.wrapper:null,document.getElementById('game')].forEach(function(el){
		if (el && (el.scrollTop || el.scrollLeft)) {el.scrollTop=0;el.scrollLeft=0;fixed=true;}
	});
	return fixed;
};

var viewportProblems=function(){
	var problems=[];
	var vv=window.visualViewport;
	if (vv && Math.abs(vv.scale-1)>0.01) problems.push('zoomed:'+vv.scale.toFixed(3));
	var cw=docEl.clientWidth;
	if (cw && Math.abs(window.innerWidth-cw)>2) problems.push('innerWidth!=clientWidth:'+window.innerWidth+'/'+cw);
	var sw=window.screen?Math.max(screen.width,screen.height):0;
	if (sw && window.innerWidth>sw+2) problems.push('innerWidth>screen:'+window.innerWidth);
	if (gameReady() && Game.wrapper)
	{
		var r=Game.wrapper.getBoundingClientRect();
		if (r.right>window.innerWidth+2 || r.bottom>layoutSize().H+2) problems.push('wrapper overflows:'+Math.round(r.right)+'x'+Math.round(r.bottom));
	}
	return problems;
};
IOSFixes.viewportProblems=viewportProblems;

var refreshViewportMeta=function(){
	//re-applying the viewport makes WebKit recompute scale and layout width
	if (!viewportMeta) return;
	viewportMeta.setAttribute('content',VIEWPORT_CONTENT.replace('initial-scale=1','initial-scale=1.0001'));
	requestAnimationFrame(function(){viewportMeta.setAttribute('content',VIEWPORT_CONTENT);});
};

var checkViewport=function(reason){
	if (!gameReady()) return;
	var scrolled=resetScroll();
	var problems=viewportProblems();
	if (problems.length)
	{
		IOSFixes.stats.viewportRepairs++;
		log('viewport repair ('+reason+'):',problems.join(', '));
		if (problems.some(function(p){return p.indexOf('zoomed')===0 || p.indexOf('innerWidth')===0;})) refreshViewportMeta();
		requestAnimationFrame(function(){Game.resize();});
	}
	else if (signature()!==lastSignature)
	{
		log('viewport changed ('+reason+'), resizing');
		Game.resize();
	}
	else if (scrolled) log('scroll reset ('+reason+')');
};
var pendingChecks=[];
var scheduleChecks=function(reason,delays){
	pendingChecks.forEach(clearTimeout);
	pendingChecks=delays.map(function(d){return setTimeout(function(){checkViewport(reason+'+'+d);},d);});
};
IOSFixes.checkViewport=checkViewport;

if (CONFIG.layout)
{
	window.addEventListener('orientationchange',function(){scheduleChecks('orientationchange',[50,250,600,1200]);});
	if (window.screen && screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change',function(){scheduleChecks('orientation',[50,250,600,1200]);});
	window.addEventListener('resize',function(){scheduleChecks('resize',[100,500]);});
	window.addEventListener('pageshow',function(){scheduleChecks('pageshow',[0,300,1000]);});
	document.addEventListener('visibilitychange',function(){if (document.visibilityState==='visible') scheduleChecks('visible',[0,300,1000]);});
	document.addEventListener('focusout',function(){scheduleChecks('focusout',[100,400]);});
	if (window.visualViewport) window.visualViewport.addEventListener('resize',function(){scheduleChecks('visualViewport',[150,600]);});
}

/*=====================================================================================
AUDIO
PlaySound re-assigns <audio>.src on every call; Safari reloads and decodes the file
each time, so click sounds lag behind taps and drop out when drumming. Same
signature and volume curve, but decoded buffers played through Web Audio.
The audio session is "ambient": game sounds mix with music from other apps
(instead of pausing it) and follow the silent switch.
=======================================================================================*/
var installAudio=function(){
	try {if (navigator.audioSession) navigator.audioSession.type='ambient';} catch(e){}
	var AC=window.AudioContext||window.webkitAudioContext;
	if (!AC || window.location.protocol==='file:' || typeof window.fetch!=='function') return;
	var origPlaySound=window.PlaySound;
	var ctx=null,buffers={},loading={},voices=0,MAX_VOICES=24;
	var getCtx=function(){
		if (!ctx) {try {ctx=new AC();} catch(e){ctx=null;}}
		return ctx;
	};
	var unlock=function(){
		var c=getCtx();
		if (!c) return;
		if (c.state!=='running') {try {c.resume();} catch(e){}}
		//iOS only starts audio output from inside a user gesture
		try {var b=c.createBuffer(1,1,22050),s=c.createBufferSource();s.buffer=b;s.connect(c.destination);s.start(0);} catch(e){}
	};
	['touchend','pointerup','click','keydown'].forEach(function(n){document.addEventListener(n,unlock,{capture:true,passive:true});});
	document.addEventListener('visibilitychange',function(){if (document.visibilityState==='visible' && ctx && ctx.state!=='running') {try {ctx.resume();} catch(e){}}});

	var load=function(src){
		if (loading[src]) return loading[src];
		var c=getCtx();
		loading[src]=fetch(src).then(function(r){if (!r.ok) throw new Error(r.status);return r.arrayBuffer();})
		.then(function(data){return new Promise(function(res,rej){var p=c.decodeAudioData(data,res,rej);if (p && p.then) p.then(res,rej);});})
		.then(function(buf){buffers[src]=buf;return buf;},function(){buffers[src]=false;return false;});
		return loading[src];
	};
	var play=function(buf,gain){
		if (voices>=MAX_VOICES) return;
		var c=ctx;
		var s=c.createBufferSource(),g=c.createGain();
		s.buffer=buf;
		g.gain.value=gain;
		s.connect(g);g.connect(c.destination);
		voices++;
		s.onended=function(){voices--;try {s.disconnect();g.disconnect();} catch(e){}};
		s.start(0);
	};
	window.PlaySound=function(url,vol,pitchVar){
		var volume=1;
		var volumeSetting=Game.volume;
		if (typeof vol!=='undefined') volume=vol;
		if (volume<-5) {volume+=10;volumeSetting=Game.volumeMusic;}
		if (!volumeSetting || volume==0) return 0;
		var c=getCtx();
		var src=url.indexOf('snd/')==0?(Game.resPath+url):url;
		if (!c || buffers[src]===false) return origPlaySound(url,vol,pitchVar);
		var gain=Math.pow(volume*volumeSetting/100,2);
		if (c.state!=='running') {try {c.resume();} catch(e){}}
		if (buffers[src]) {play(buffers[src],gain);return;}
		//first use: play once decoded, unless it is too late to still make sense (same idea as the original onloadeddata replay)
		var asked=now();
		load(src).then(function(buf){if (buf && now()-asked<400) play(buf,gain);});
	};
	IOSFixes.audio={context:getCtx,buffers:buffers};
	//warm up the sounds used on every tap
	for (var i=1;i<=7;i++) {load(Game.resPath+'snd/clickb'+i+'.mp3');load(Game.resPath+'snd/click'+i+'.mp3');}
	['snd/buy1.mp3','snd/buy2.mp3','snd/buy3.mp3','snd/buy4.mp3','snd/tick.mp3','snd/shimmerClick.mp3'].forEach(function(u){load(Game.resPath+u);});
};

/*=====================================================================================
LIFECYCLE
=======================================================================================*/
var lastHideSave=0;
var saveOnHide=function(reason){
	if (!gameReady() || !Game.prefs || !Game.prefs.autosave) return;
	if (Game.OnAscend || Game.AscendTimer>0 || Game.T<Game.fps*10) return;//same guards as the built-in autosave
	if (Date.now()-lastHideSave<3000) return;
	lastHideSave=Date.now();
	try {Game.WriteSave();IOSFixes.stats.hideSaves++;log('saved on',reason);} catch(e){}
};
if (CONFIG.lifecycle)
{
	document.addEventListener('visibilitychange',function(){if (document.visibilityState==='hidden') saveOnHide('hidden');});
	window.addEventListener('pagehide',function(){saveOnHide('pagehide');});
	try {if (navigator.storage && navigator.storage.persist) navigator.storage.persist();} catch(e){}
}

/*=====================================================================================
SAVE TRANSFER
Selecting a multi-kilobyte save code by long-press is painful on a phone, and Safari
and the Home Screen app have separate storage, so moving saves is common. Adds
Copy / Paste buttons to the existing Export / Import prompts (save code unchanged).
=======================================================================================*/
var copyText=function(text,textarea){
	var fallback=function(){
		if (!textarea) return false;
		textarea.removeAttribute('readonly');
		textarea.focus();
		textarea.setSelectionRange(0,textarea.value.length);
		var ok=false;
		try {ok=document.execCommand('copy');} catch(e){}
		textarea.setAttribute('readonly','');
		textarea.blur();
		return ok;
	};
	if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function(){return true;},function(){return fallback();});
	return Promise.resolve(fallback());
};
var addPromptButton=function(label,onTap){
	var area=document.getElementById('textareaPrompt');
	if (!area || !area.parentNode) return null;
	var b=document.createElement('a');
	b.className='option smallFancyButton iosSaveButton';
	b.textContent=label;
	b.style.cssText='display:inline-block;margin:6px 4px 0 0;';
	b.addEventListener('click',function(e){e.preventDefault();onTap(b,area);});
	area.parentNode.appendChild(b);
	return b;
};
var installSaveTransfer=function(){
	var origExport=Game.ExportSave,origImport=Game.ImportSave;
	Game.ExportSave=function(){
		var r=origExport.apply(this,arguments);
		addPromptButton('Copy to clipboard',function(b,area){
			copyText(area.value,area).then(function(ok){b.textContent=ok?'Copied!':'Copy failed - select the text instead';});
			PlaySound('snd/tick.mp3');
		});
		return r;
	};
	Game.ImportSave=function(){
		var r=origImport.apply(this,arguments);
		if (navigator.clipboard && navigator.clipboard.readText)
		{
			addPromptButton('Paste from clipboard',function(b,area){
				navigator.clipboard.readText().then(function(t){area.value=(t||'').trim();b.textContent='Pasted';},function(){b.textContent='Paste blocked - long-press the box instead';});
				PlaySound('snd/tick.mp3');
			});
		}
		return r;
	};
};

/*=====================================================================================
BOOT: wait for Game.Init (runs after window.onload + asset loading)
=======================================================================================*/
var installed=false;
var install=function(){
	if (installed) return;
	installed=true;
	if (CONFIG.layout) installLayout();
	if (CONFIG.audio) {try {installAudio();} catch(e){log('audio install failed',e);}}
	installSaveTransfer();
	if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol) && !/[?&]nosw=1\b/.test(window.location.search))
	{
		navigator.serviceWorker.register('sw.js').then(function(){return navigator.serviceWorker.ready;}).then(function(reg){
			//hand over everything this first launch already loaded so the next launch works offline
			setTimeout(function(){
				if (!reg.active || !window.performance || !performance.getEntriesByType) return;
				var urls=performance.getEntriesByType('resource').map(function(r){return r.name;})
					.concat([].slice.call(document.images).map(function(i){return i.src;}))
					.concat(Object.keys((Game.Loader && Game.Loader.assets)||{}).map(function(k){var a=Game.Loader.assets[k];return a && a.src;}).filter(Boolean));
				reg.active.postMessage({type:'cache-urls',urls:urls.concat([window.location.href])});
			},4000);
		}).catch(function(){});
	}
	log('installed',JSON.stringify(CONFIG),standalone?'standalone':'browser');
};
var waitForGame=function(){
	if (gameReady() && Game.wrapper && Game.resize) install();
	else setTimeout(waitForGame,50);
};
waitForGame();

})();
