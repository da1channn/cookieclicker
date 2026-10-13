/*
	gate.js — simple password gate for this private copy.

	Loaded first in every game page. Until the right password has been entered once on a device,
	the page shows a password screen and the game does not start (its window.onload is held back).

	This is a "please keep out" sign, not real security: the repository is public, so only the
	SHA-256 of the password is stored here, never the password itself. Changing HASH (see README)
	locks every device again.
*/
(function(){
'use strict';
var HASH='d4de2d53a987df9bd04d2c885851d8359aee951ea5bb9b6be215ee01d74efa65';//sha256('cc-gate:'+password)
var KEY='CookieClickerGate';//localStorage: the hash that was unlocked on this device
var unlocked=false;
try {unlocked=window.localStorage.getItem(KEY)===HASH;} catch(e){}
if (unlocked) return;

var doc=document.documentElement;
doc.classList.add('cc-locked');
var style=document.createElement('style');
style.textContent=
	'html.cc-locked body>*:not(#ccGate){display:none !important;}'+
	'html.cc-locked,html.cc-locked body{background:#120b05 !important;}'+
	'#ccGate{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;'+
		'padding:env(safe-area-inset-top) 20px env(safe-area-inset-bottom);background:#120b05 url(img/darkNoise.jpg);'+
		'font:16px/1.5 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;color:#f3e6d3;}'+
	'#ccGate form{width:100%;max-width:320px;text-align:center;}'+
	'#ccGate img{width:88px;height:88px;border-radius:20px;}'+
	'#ccGate h1{font-size:20px;margin:14px 0 4px;}'+
	'#ccGate p{margin:0 0 16px;color:#b9a58c;font-size:14px;}'+
	'#ccGate input{box-sizing:border-box;width:100%;height:48px;border-radius:12px;border:1px solid rgba(255,200,120,0.4);'+
		'background:#0b0703;color:#f3e6d3;font-size:17px;padding:0 14px;text-align:center;-webkit-user-select:text;user-select:text;}'+
	'#ccGate button{width:100%;height:48px;margin-top:12px;border-radius:12px;border:0;background:#c98a2b;color:#1b120a;'+
		'font-size:17px;font-weight:700;}'+
	'#ccGate .err{color:#ff8a7a;min-height:22px;margin-top:10px;font-size:14px;}';
(document.head||doc).appendChild(style);

//hold back the game's start (main.js assigns window.onload after this script runs)
window.addEventListener('load',function(e){if (!unlocked) e.stopImmediatePropagation();},true);

var ja=/^ja\b/i.test(navigator.language||'');
try {var l=localStorage.getItem('CookieClickerLang');if (l) ja=(l==='JA');} catch(e){}
var T=ja?{title:'Cookie Clicker（プライベート）',lead:'パスワードを入力してください',ph:'パスワード',go:'開く',bad:'パスワードが違います'}
	:{title:'Cookie Clicker (private)',lead:'Enter the password to play',ph:'Password',go:'Open',bad:'Wrong password'};

var sha256=function(text){
	return crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)).then(function(buf){
		return Array.prototype.map.call(new Uint8Array(buf),function(b){return ('0'+b.toString(16)).slice(-2);}).join('');
	});
};

var show=function(){
	if (document.getElementById('ccGate')) return;
	var g=document.createElement('div');
	g.id='ccGate';
	g.innerHTML='<form autocomplete="off"><img src="img/ios/apple-touch-icon.png" alt=""><h1></h1><p></p>'+
		'<input type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false">'+
		'<button type="submit"></button><div class="err" role="alert"></div></form>';
	g.querySelector('h1').textContent=T.title;
	g.querySelector('p').textContent=T.lead;
	var input=g.querySelector('input');input.placeholder=T.ph;
	g.querySelector('button').textContent=T.go;
	g.querySelector('form').addEventListener('submit',function(e){
		e.preventDefault();
		var err=g.querySelector('.err');err.textContent='';
		sha256('cc-gate:'+input.value).then(function(h){
			if (h!==HASH) {err.textContent=T.bad;input.select();return;}
			try {localStorage.setItem(KEY,HASH);} catch(e2){}
			unlocked=true;
			g.remove();
			doc.classList.remove('cc-locked');
			if (input.blur) input.blur();
			window.scrollTo(0,0);
			//start the game now (it was held back at load)
			if (document.readyState==='complete' && typeof window.onload==='function') window.onload();
		});
	});
	document.body.appendChild(g);
	setTimeout(function(){try {input.focus();} catch(e){}},300);
};
if (document.body) show(); else document.addEventListener('DOMContentLoaded',show);
})();
