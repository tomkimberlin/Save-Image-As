import { createServer } from 'node:http';

export const imageSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
  <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#b4ddd7"/><stop offset="1" stop-color="#e4edcf"/></linearGradient></defs>
  <rect x="24" y="24" width="592" height="352" rx="32" fill="url(#sky)"/>
  <circle cx="464" cy="120" r="45" fill="#ffe5a0"/>
  <path d="M24 300L197 106l186 270H56a32 32 0 0 1-32-32z" fill="#507f74"/>
  <path d="M197 106l-53 60 53-13 44 17z" fill="#f9f7e9"/>
  <path d="M194 376L411 163l205 175v6a32 32 0 0 1-32 32z" fill="#28594e"/>
  <path d="M411 163l-53 52 54-11 49 2z" fill="#e9efdf"/>
</svg>`;

export const cleanPage = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Save Image As · Test gallery</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f4ee;color:#213d34;font:16px system-ui,sans-serif}
main{max-width:1050px;margin:56px auto;padding:0 36px}.eyebrow{font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#537469}
h1{font-size:42px;letter-spacing:-.04em;margin:12px 0}p{color:#587064;line-height:1.6}.card{margin-top:30px;display:grid;grid-template-columns:1.5fr 1fr;gap:32px;align-items:center;background:#fffdf8;border:1px solid #dedfd4;border-radius:24px;padding:30px}
img{display:block;max-width:100%;border-radius:12px;background-color:#fff;background-image:linear-gradient(45deg,#ecede5 25%,transparent 25%),linear-gradient(-45deg,#ecede5 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ecede5 75%),linear-gradient(-45deg,transparent 75%,#ecede5 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0}
h2{font-size:22px;margin:0}.formats{display:flex;gap:8px;margin-top:20px}.formats span{padding:7px 12px;border:1px solid #d6dfd3;border-radius:8px;font-size:13px;font-weight:700}footer{margin-top:25px;color:#7a867c;font-size:12px}
</style><main><div class="eyebrow">Save Image As · Local test gallery</div><h1>One image. Your format.</h1><p>Right-click the image, open Save image as, and choose PNG, JPG, or WebP.</p>
<section class="card"><img id="sample" src="/landscape.svg" alt="Illustrated mountains beneath a pale yellow sun"><div><h2>A little room to explore.</h2><p>This original test illustration has transparent corners. PNG and WebP retain them; JPG gives them a clean white background.</p><div class="formats"><span>PNG</span><span>JPG</span><span>WebP</span></div></div></section>
<footer>Synthetic image · Local fixture · No personal browsing data</footer></main></html>`;

// Two 2×1 frames with a red/blue palette. No external fixture downloads.
const animation = Buffer.from('47494638396102000100800000ff00000000ff21ff0b4e45545343415045322e30030100000021f904000a0000002c0000000002000100000202040a0021f904000a0000002c00000000020001000002024c0a003b', 'hex');

export async function startFixtures() {
  let png;
  const sockets = new Set();
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    if (path === '/stall') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.flushHeaders();
      return;
    }
    if (path === '/oversized') {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': 33 * 1024 * 1024 });
      response.end('too large');
      return;
    }
    if (path === '/denied') { response.writeHead(403); response.end('Forbidden'); return; }
    if (path === '/empty') { response.end(); return; }
    if (path === '/corrupt') { response.writeHead(200, { 'content-type': 'image/png' }); response.end('not an image'); return; }
    if (path === '/transparent.png') { response.writeHead(200, { 'content-type': 'image/png' }); response.end(png); return; }
    if (path === '/animation.gif') { response.writeHead(200, { 'content-type': 'image/gif' }); response.end(animation); return; }
    if (path === '/landscape.svg') { response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.end(imageSvg); return; }
    if (path === '/frame') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<iframe src="/inner"></iframe>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html', ...(path === '/csp' ? {
      'content-security-policy': "default-src 'self'; img-src 'self'; style-src 'unsafe-inline'"
    } : {}) });
    response.end(cleanPage);
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, setPng(bytes) { png = bytes; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); } };
}
