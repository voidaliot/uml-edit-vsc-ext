import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { loadModule } from './runtime.mjs';
import { openPreviewDocument } from './preview-document.mjs';

await build({ entryPoints: ['src/webview/main.tsx'], outfile: 'dist/webview.js', bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, sourcemap: true });
const { templates } = await loadModule('src/core/templates.ts', 'templates');
const port = Number(process.env.PORT || 4173);
const modelIndex = process.argv.indexOf('--model');
if (modelIndex >= 0 && !process.argv[modelIndex + 1]) throw new Error('--model requires a file path.');
const modelPath = modelIndex >= 0 ? resolve(process.argv[modelIndex + 1]) : undefined;
const token = randomBytes(24).toString('hex');
const clients = new Set();
const model = modelPath ? await openPreviewDocument(modelPath, message => {
  for (const client of clients) client.write(`data: ${JSON.stringify(message)}\n\n`);
}) : undefined;

const server = createServer(async (request, response) => {
  const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host || '')) return json(403, { error: 'Loopback requests only.' });
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === '/api/document' && request.method === 'GET' && model) return json(200, await model.snapshot());
    if (url.pathname === '/api/events' && request.method === 'GET' && model) {
      const initial = await model.snapshot();
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      clients.add(response);
      response.write(`data: ${JSON.stringify(initial)}\n\n`);
      request.on('close', () => clients.delete(response));
      return;
    }
    if (url.pathname === '/api/message' && request.method === 'POST' && model) {
      if (![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(request.headers.origin || '') || request.headers['x-aliot-preview-token'] !== token) return json(403, { error: 'Same-origin preview session required.' });
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        // JSON escaping and layout dictionaries add transport bytes. The codec
        // validates the smaller source limit after decoding the bounded request.
        if (bytes > 32 * 1024 * 1024) return json(413, { error: 'This request exceeds the preview size limit.' });
        chunks.push(chunk);
      }
      return json(200, await model.receive(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    }
    if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' });
    if (url.pathname === '/') {
      const template = templates.find(item => item.kind === url.searchParams.get('example'));
      const initial = model ? (await model.snapshot()).source : url.searchParams.get('empty') === '1' ? '' : template?.source ?? await readFile('examples/all-native.puml', 'utf8');
      const globals = `window.__ALIOT_INITIAL_SOURCE__=${JSON.stringify(initial).replace(/</g, '\\u003c')};window.__ALIOT_FILE_NAME__=${JSON.stringify(modelPath ? basename(modelPath) : template ? `${template.kind}.puml` : 'all-native.puml')};window.__ALIOT_PREVIEW_MODEL__=${Boolean(model)};window.__ALIOT_PREVIEW_TOKEN__=${JSON.stringify(token)};`;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': `default-src 'none'; script-src 'self' 'nonce-${token}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'` });
      response.end(`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aliot UML Editor · Native diagrams</title><link rel="stylesheet" href="/webview.css"></head><body><div id="root"></div><script nonce="${token}">${globals}</script><script src="/webview.js"></script></body></html>`);
      return;
    }
    const files = { '/webview.js': ['dist/webview.js', 'text/javascript'], '/webview.css': ['dist/webview.css', 'text/css'], '/webview.js.map': ['dist/webview.js.map', 'application/json'] };
    const file = Object.hasOwn(files, url.pathname) ? files[url.pathname] : undefined;
    if (!file) return json(404, { error: 'Not found.' });
    response.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' }); response.end(await readFile(file[0]));
  } catch (error) { json(400, { type: 'error', message: error instanceof Error ? error.message : String(error) }); }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Aliot UML native preview: http://127.0.0.1:${port}${modelPath ? `\nLive file: ${modelPath} (diagram edits are saved to this file)` : `\nScratch showcase: select any of the ${templates.length} native diagrams; edits stay in memory.`}`);
  process.send?.({ type: 'ready', port });
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  model?.close();
  for (const client of clients) client.end();
  server.closeAllConnections();
  server.close(() => process.exit(0));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
process.on('message', message => { if (message?.type === 'shutdown') shutdown(); });
process.on('disconnect', shutdown);
