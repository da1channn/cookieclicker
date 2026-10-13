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

var DEFAULTS={fastTap:true,zoomGuard:true,layout:true,portraitUI:true,audio:true,lifecycle:true,debug:false};
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
//Everything that spends something gets "tap = do it, long press = only show the tooltip, slide off =
//cancel". With plain clicks, iOS still fires the action after a long press, so reading a tooltip
//could harvest an unripe sugar lump, cast a spell, level a building or uproot a plant.
var FAST_SELECTOR='#bigCookie,.shimmer,#products .product,#store .crate.upgrade,'+
	'#lumps,.productLevel,.grimoireSpell,.gardenTile,.gardenSeed,.bankButton';
var ASCEND_SELECTOR='#ascendUpgrades .crate';//heavenly upgrades, only while ascending
var INNER_CLICKABLE='a,button,input,textarea,select,label,.productButton';
var fastTargetOf=function(node){
	if (!node || !node.closest) return null;
	if (typeof Game!=='undefined' && Game.promptOn) return null;
	var ascending=typeof Game!=='undefined' && Game.OnAscend;
	var el=node.closest(ascending?ASCEND_SELECTOR:FAST_SELECTOR);
	if (!el) return null;
	var inner=node.closest(INNER_CLICKABLE);
	if (inner && inner!==el && el.contains(inner)) return null;//let nested controls behave natively
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
		if (CONFIG.layout) setMouse(e.clientX,e.clientY);//tooltips opened by touchstart are placed from this
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
		if (!fastTargetOf(e.target) && !(e.target && e.target.closest && e.target.closest(FAST_SELECTOR+','+ASCEND_SELECTOR))) return;
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
	var iphoneApp=(standalone || forceStandalone) && /iPhone|iPod/.test(navigator.userAgent);
	if (!keyboardSeen) fullHeights[W]=Math.max(fullHeights[W]||0,H);
	if (iphoneApp && !textFocused())
	{
		//an iPhone Home Screen app always fills the whole screen, but iOS 26 standalone can report
		//innerHeight short by the status bar height (an empty band at the bottom) or stay shrunk
		//after the keyboard; screen size (iOS: always portrait numbers) is the ground truth
		var expectedH=0;
		if (window.screen && screen.width && screen.height)
		{
			var short=Math.min(screen.width,screen.height),long=Math.max(screen.width,screen.height);
			if (Math.abs(W-short)<=2) expectedH=long;
			else if (Math.abs(W-long)<=2) expectedH=short;
		}
		if (keyboardSeen) expectedH=Math.max(expectedH,fullHeights[W]||0);
		if (expectedH && H<expectedH-2 && expectedH-H<500) {H=expectedH;shrunk=true;}
	}
	return {W:W,H:H,shrunk:shrunk};
};
IOSFixes.layoutSize=layoutSize;

var PORTRAIT_LOGICAL_W=375;//portrait UI is laid out for this width, then scaled to the screen
var isPortraitLayout=function(w,h){return CONFIG.portraitUI && w<h && w<600;};

var installLayout=function(){
	var origResize=Game.resize;
	Game.resize=function(){
		IOSFixes.stats.resizes++;
		var wrapper=Game.wrapper;
		var ins=readInsets();
		var size=layoutSize(),W=size.W,H=size.H;
		//safe area = what the game may use
		var w=Math.max(1,W-ins.l-ins.r);
		var h=Math.max(1,H-ins.t-ins.b);
		var portrait=isPortraitLayout(w,h);
		Portrait.setActive(portrait);//switch CSS + top bar before anything measures the layout
		origResize.apply(this,arguments);
		lastSignature=signature();
		document.body.style.height=size.shrunk?H+'px':'';
		document.body.style.bottom=size.shrunk?'auto':'';
		if (size.shrunk) log('standalone viewport stuck at',window.innerHeight,'- using screen height',H);
		if (!(ins.t||ins.r||ins.b||ins.l) && !size.shrunk && !portrait)
		{
			wrapper.style.left='';
			wrapper.style.top='';
			wrapper.style.setProperty('--iosT','0px');
			wrapper.style.setProperty('--iosB','0px');
			return;
		}
		var scale;
		var top=ins.t;
		if (portrait)
		{
			//full-bleed: the game covers the whole screen (cookie art behind the status bar, tab bar
			//down to the bottom edge); CSS keeps the controls inside the safe area via --iosT/--iosB
			scale=w/PORTRAIT_LOGICAL_W;
			h=H;top=0;
			wrapper.style.setProperty('--iosT',(ins.t/scale)+'px');
			wrapper.style.setProperty('--iosB',(ins.b/scale)+'px');
		}
		else
		{
			//same formula as Game.resize, applied to the safe area instead of the whole window
			var zoom=Game.zoom||1;
			scale=Math.min(w/Math.max(800*zoom,w),h/Math.max(200*zoom,h))*zoom;
		}
		Game.windowW=Math.floor(w/scale);
		Game.windowH=Math.floor(h/scale);
		if (!portrait) {wrapper.style.setProperty('--iosT','0px');wrapper.style.setProperty('--iosB','0px');}
		wrapper.style.left=ins.l+'px';
		wrapper.style.top=top+'px';
		if (scale!=1)
		{
			wrapper.style.transform='scale('+scale+')';
			//exact (not floored) size so no 1px strip is left at the screen edge
			wrapper.style.width=(w/scale)+'px';
			wrapper.style.height=(h/scale)+'px';
		}
		else
		{
			wrapper.style.removeProperty('transform');
			wrapper.style.width=w+'px';
			wrapper.style.height=h+'px';
		}
		Game.scale=scale;
		//the original already ran these against the full-window size; canvases must match the final layout
		for (var i in Game.Objects)
		{
			var me=Game.Objects[i];
			me.toResize=true;
			if (me.minigame && me.minigame.onResize) me.minigame.onResize();
		}
		for (var j=0;j<Game.onResizeCallbacks.length;j++) Game.onResizeCallbacks[j](w,h);
		log('resize',W+'x'+H,'insets',JSON.stringify(ins),portrait?'portrait UI':'desktop UI','scale',scale.toFixed(4),'logical',Game.windowW+'x'+Game.windowH);
	};
	Game.resize();
};

/*=====================================================================================
PORTRAIT UI
The desktop layout is three columns (cookie | buildings+menus | store) 800px wide,
which on a phone held upright means ~0.45x tiny text and 20px buttons. In portrait:
  - cookie on top, one big panel below, a thumb-reachable tab bar at the bottom
    (Store / Buildings / Stats / Options / Info / Legacy) replacing the small corner buttons
  - laid out at 375 logical px, so everything is ~2x bigger than the desktop layout
  - tooltips are centred and placed above/below the finger instead of beside the store
Same DOM, same handlers: tabs just call the game's own buttons / Game.ShowMenu.
Landscape keeps the original layout.
=======================================================================================*/
var Portrait=IOSFixes.portrait={active:false,tab:'store',bar:null,scrolls:{}};
var TABS=[
	{id:'store',icon:'🛒',label:'Store'},
	{id:'buildings',icon:'🏭',label:'Buildings'},
	{id:'stats',icon:'📊',label:'Stats',menu:'stats'},
	{id:'prefs',icon:'⚙️',label:'Options',menu:'prefs'},
	{id:'log',icon:'ℹ️',label:'Info',menu:'log'},
	{id:'legacy',icon:'👼',label:'Legacy'}
];
var tr=function(s){try {return (typeof loc==='function')?loc(s):s;} catch(e){return s;}};
Portrait.safe=function(){//safe-area insets in logical px (portrait full-bleed layout)
	var cs=Game.wrapper?getComputedStyle(Game.wrapper):null;
	return {t:cs?parseFloat(cs.getPropertyValue('--iosT'))||0:0,b:cs?parseFloat(cs.getPropertyValue('--iosB'))||0:0};
};
Portrait.buildBar=function(){
	if (Portrait.bar) return Portrait.bar;
	var bar=document.createElement('div');
	bar.id='iosTabBar';
	bar.setAttribute('role','tablist');
	TABS.forEach(function(t){
		var b=document.createElement('div');
		b.className='iosTab';
		b.id='iosTab-'+t.id;
		b.setAttribute('role','tab');
		b.innerHTML='<span class="iosTabIcon">'+t.icon+'</span><span class="iosTabLabel">'+tr(t.label)+'</span>';
		b.addEventListener('click',function(e){e.preventDefault();Portrait.select(t.id);});
		bar.appendChild(b);
	});
	Game.l.appendChild(bar);
	Portrait.bar=bar;
	return bar;
};
Portrait.show=function(tab){
	Portrait.tab=tab;
	var panel=(tab==='store')?'store':'middle';
	docEl.classList.toggle('ios-tab-store',panel==='store');
	docEl.classList.toggle('ios-tab-middle',panel==='middle');
	TABS.forEach(function(t){var b=document.getElementById('iosTab-'+t.id);if (b) b.classList.toggle('on',t.id===tab);});
};
Portrait.select=function(tab){
	if (!gameReady()) return;
	var t=TABS.filter(function(x){return x.id===tab;})[0];
	if (!t) return;
	if (tab==='legacy') {l('legacyButton').click();return;}//opens the game's own ascend prompt
	//each tab keeps its own scroll position (menus share #centerArea with the buildings); save it
	//before Game.ShowMenu below, which already switches the highlighted tab
	var center=document.getElementById('centerArea');
	if (center && Portrait.tab!=='store') Portrait.scrolls[Portrait.tab]=center.scrollTop;
	if (t.menu) {if (Game.onMenu!==t.menu) Game.ShowMenu(t.menu);}
	else
	{
		if (tab==='buildings' && Game.onMenu) Game.ShowMenu(Game.onMenu);//close the open menu to reveal the buildings
		else PlaySound('snd/clickOn2.mp3');
	}
	var again=(Portrait.lastTab===tab);
	Portrait.show(tab);
	if (center && tab!=='store') center.scrollTop=again?0:(Portrait.scrolls[tab]||0);
	if (again && tab==='store') l('sectionRight').scrollTop=0;//tapping the active tab again scrolls to top
	Portrait.lastTab=tab;
};
Portrait.syncWithMenu=function(){
	if (!Portrait.active) return;
	if (Game.onMenu) Portrait.show(Game.onMenu);
	else if (Portrait.tab==='stats' || Portrait.tab==='prefs' || Portrait.tab==='log') Portrait.show('buildings');
};
Portrait.setActive=function(on){
	if (on===Portrait.active && Portrait.bar) return;
	Portrait.active=on;
	docEl.classList.toggle('ios-portrait',on);
	if (on)
	{
		Portrait.buildBar();
		Portrait.buildHandle();
		Portrait.buildHelpButton();
		Portrait.show(Game.onMenu?Game.onMenu:Portrait.tab);
		if (!uiState.helpSeen && !/[?&]nohelp=1\b/.test(window.location.search)) setTimeout(Portrait.openHelp,800);//first launch
	}
	//game code offsets the mouse by the top bar's height
	if (typeof TopBarOffset!=='undefined') TopBarOffset=0;//#topBar is hidden on iOS (see ios-fixes.css)
	//sugar lumps live in the buildings header on desktop; in portrait keep them on the cookie panel
	var lumps=document.getElementById('lumps');
	if (lumps)
	{
		var home=on?document.getElementById('sectionLeft'):document.getElementById('comments');
		if (home && lumps.parentNode!==home) home.appendChild(lumps);
	}
	if (!on && Game.tooltip && Game.tooltip.tta) Game.tooltip.tta.style.transform='';
	log('portrait UI',on?'on':'off');
};
//a dot on the Store tab when something there is affordable, so you know when to switch back
Portrait.updateBadge=function(){
	if (!Portrait.active || !Portrait.bar || !gameReady()) return;
	var any=false;
	try {
		for (var i=0;i<Game.ObjectsById.length && !any;i++) {var o=Game.ObjectsById[i];if (!o.locked && o.getPrice()<=Game.cookies) any=true;}
		for (var j=0;j<Game.UpgradesInStore.length && !any;j++) {var u=Game.UpgradesInStore[j];if (u.pool!=='toggle' && u.pool!=='tech' && u.canBuy()) any=true;}
	} catch(e){}
	var tab=document.getElementById('iosTab-store');
	if (tab) tab.classList.toggle('badge',any && Portrait.tab!=='store');
};
//per-viewer UI state (panel expanded, help already shown); never touches the save
var uiState={};
try {uiState=JSON.parse(window.localStorage.getItem('CookieClickerIOSUI')||'{}')||{};} catch(e){uiState={};}
var saveUI=function(){try {window.localStorage.setItem('CookieClickerIOSUI',JSON.stringify(uiState));} catch(e){}};
IOSFixes.uiState=uiState;

//panel drawer: tap (or swipe) the handle to pull the store / buildings panel up over the cookie
Portrait.setExpanded=function(on){
	uiState.expanded=!!on;saveUI();
	docEl.classList.toggle('ios-panel-expanded',!!on);
	var h=document.getElementById('iosPanelHandle');
	if (h) h.setAttribute('aria-expanded',on?'true':'false');
};
Portrait.buildHandle=function(){
	if (document.getElementById('iosPanelHandle')) return;
	var h=document.createElement('div');
	h.id='iosPanelHandle';
	h.setAttribute('role','button');
	h.setAttribute('aria-label','Expand panel');
	h.innerHTML='<span class="iosHandlePill"></span>';
	var startY=null;
	h.addEventListener('pointerdown',function(e){startY=e.clientY;});
	h.addEventListener('pointerup',function(e){
		if (startY===null) return;
		var dy=e.clientY-startY;startY=null;
		if (dy<-20) Portrait.setExpanded(true);
		else if (dy>20) Portrait.setExpanded(false);
		else Portrait.setExpanded(!uiState.expanded);
		PlaySound('snd/tick.mp3');
	});
	h.addEventListener('pointercancel',function(){startY=null;});
	Game.l.appendChild(h);
	Portrait.setExpanded(!!uiState.expanded);
};

//help: help.html in an overlay, opened from the ? button; shown once on the first portrait launch
Portrait.openHelp=function(){
	var o=document.getElementById('iosHelp');
	if (!o)
	{
		o=document.createElement('div');
		o.id='iosHelp';
		o.innerHTML='<div class="iosHelpBar"><span class="iosHelpTitle"></span><a class="iosHelpClose" role="button" aria-label="Close">✕</a></div><iframe src="help.html?embed=1" title="Help"></iframe>';
		document.body.appendChild(o);
		var ja=false;try {ja=window.localStorage.getItem('CookieClickerLang')==='JA';} catch(e){}
		o.querySelector('.iosHelpTitle').textContent=ja?'遊び方':'How to play';
		o.querySelector('.iosHelpClose').addEventListener('click',Portrait.closeHelp);
	}
	o.classList.add('on');
	uiState.helpSeen=true;saveUI();
};
Portrait.closeHelp=function(){var o=document.getElementById('iosHelp');if (o) o.classList.remove('on');};
Portrait.buildHelpButton=function(){
	if (document.getElementById('iosHelpButton')) return;
	var b=document.createElement('div');
	b.id='iosHelpButton';
	b.setAttribute('role','button');
	b.setAttribute('aria-label','Help');
	var ja=false;try {ja=window.localStorage.getItem('CookieClickerLang')==='JA';} catch(e){}
	b.innerHTML='<span class="iosHelpIcon">\uD83D\uDCD6</span><span>'+(ja?'遊び方':'Help')+'</span>';
	b.addEventListener('click',function(e){e.preventDefault();PlaySound('snd/tick.mp3');Portrait.openHelp();});
	l('sectionLeft').appendChild(b);
};

var installPortrait=function(){
	setInterval(Portrait.updateBadge,1000);
	//tab highlight follows menus opened by the game itself
	var origShowMenu=Game.ShowMenu;
	Game.ShowMenu=function(){var r=origShowMenu.apply(this,arguments);Portrait.syncWithMenu();return r;};
	//tooltips: desktop puts store tooltips left of the 300px store column, off-screen in portrait
	var origUpdate=Game.tooltip.update;
	Game.tooltip.update=function(){
		var r=origUpdate.apply(this,arguments);
		if (Portrait.active && this.on && this.tta.style.display!=='none')
		{
			var tt=this.tt,tta=this.tta;
			var safe=Portrait.safe();
			var W=Game.windowW,H=Game.windowH-60-safe.b;//keep clear of the tab bar
			//desktop tooltips are up to ~400px wide: shrink to fit the screen width
			var fit=Math.min(1,(W-8)/Math.max(1,tt.offsetWidth));
			tta.style.transformOrigin='0 0';
			tta.style.transform=fit<1?'scale('+fit+')':'';
			var width=tt.offsetWidth*fit,height=tt.offsetHeight*fit;
			var X=Math.max(4,Math.floor((W-width)/2));
			var fingerY=Game.mouseY;
			var Y=(fingerY>H/2)?fingerY-height-40:fingerY+40;
			Y=Math.max(safe.t+4,Math.min(H-height-4,Y));
			tta.style.left=X+'px';tta.style.right='auto';
			tta.style.top=Y+'px';tta.style.bottom='auto';
			tt.style.left='0px';tt.style.top='0px';tt.style.right='auto';tt.style.bottom='auto';
		}
		return r;
	};
	//golden cookies spawn between the left edge and "300px before the store"; in a 375px wide
	//portrait layout that is always x=0. Spread them over the screen instead (position only).
	var gt=Game.shimmerTypes && Game.shimmerTypes.golden;
	if (gt && gt.initFunc)
	{
		var origInit=gt.initFunc;
		gt.initFunc=function(me){
			var r=origInit.apply(this,arguments);
			if (Portrait.active && me && me.l)
			{
				me.x=Math.floor(8+Math.random()*Math.max(0,Game.windowW-112));
				me.l.style.left=me.x+'px';
				//not under the Dynamic Island / status bar, not under the tab bar
				var sf=Portrait.safe();
				me.y=Math.max(sf.t+8,Math.min(Game.windowH-sf.b-60-104,me.y));
				me.l.style.top=me.y+'px';
			}
			return r;
		};
	}
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
	if (CONFIG.layout) {installPortrait();installLayout();}
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
