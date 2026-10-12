// Static server that mimics GitHub Pages: the repo is served under /cookieclicker/
// and every request outside that prefix (an absolute /img/... path) is a failure.
const http=require('http');
const fs=require('fs');
const path=require('path');

const ROOT=path.resolve(__dirname,'..');
const PREFIX='/cookieclicker/';
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
	'.png':'image/png','.jpg':'image/jpeg','.gif':'image/gif','.ico':'image/x-icon','.mp3':'audio/mpeg','.ogg':'audio/ogg',
	'.woff2':'font/woff2','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.txt':'text/plain'};

function start(port=0){
	const log={requests:[],notFound:[],outsidePrefix:[]};
	const server=http.createServer((req,res)=>{
		const url=new URL(req.url,'http://x');
		log.requests.push(url.pathname);
		if (!url.pathname.startsWith(PREFIX))
		{
			log.outsidePrefix.push(url.pathname);
			res.writeHead(404);res.end('outside GitHub Pages base path');return;
		}
		let rel=decodeURIComponent(url.pathname.slice(PREFIX.length))||'index.html';
		if (rel.endsWith('/')) rel+='index.html';
		const file=path.join(ROOT,rel);
		if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
		{
			log.notFound.push(url.pathname);
			res.writeHead(404);res.end('not found');return;
		}
		res.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});
		fs.createReadStream(file).pipe(res);
	});
	return new Promise(r=>server.listen(port,'127.0.0.1',()=>r({server,log,base:`http://127.0.0.1:${server.address().port}${PREFIX}`})));
}
module.exports={start};
if (require.main===module) start(Number(process.env.PORT)||8080).then(s=>console.log('serving',s.base));
