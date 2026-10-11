import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Public endpoint only: this value is embedded in the browser page, not kept secret.
const liveWsUrl = (process.env.CAMPUS_WS_URL || '').trim();
if (liveWsUrl) {
  const url = new URL(liveWsUrl);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.pathname !== '/ws') {
    throw new Error('CAMPUS_WS_URL must be a public ws:// or wss:// URL ending in /ws (no credentials or fragment).');
  }
}
const result = await build({ entryPoints:['app.js'], bundle:true, format:'iife', platform:'browser', target:['es2022'], minify:true, write:false, loader:{'.js':'js'} });
const js = result.outputFiles[0].text.replaceAll('</script','<\\/script');
const template = await readFile('template.html','utf8');
const config = `window.CAMPUS_WS_URL = ${JSON.stringify(liveWsUrl).replaceAll('<', '\\u003c')};\n`;
const html = template.replace('/* CAMPUS_APP_BUNDLE */', () => config + js);
if (html === template) throw new Error('The template is missing the CAMPUS_APP_BUNDLE marker.');
await mkdir('public', { recursive:true });
await Promise.all([writeFile('index.html', html), writeFile('public/index.html', html)]);
console.log(`Built standalone index.html and public/index.html (${Math.round(js.length/1024)} KB JS${liveWsUrl ? '; live WebSocket configured' : '; same-origin WebSocket fallback'})`);
