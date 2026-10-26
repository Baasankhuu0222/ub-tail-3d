'use strict';
// Хотын мөрдлөг: олон тоглогчийн сервер (Node.js 18+, гадны сан шаардахгүй)
// Ажиллуулах: node server.js   (ub-tail-3d.html-тэй нэг хавтсанд байх ёстой)
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const crypto = require('crypto'), os = require('os');
const PORT = +process.env.PORT || 3000, LIMIT = 300; // тоглолтын хугацаа (секунд)
const NAME = 'ub-tail-3d.html';
const FILE = [path.join(__dirname, NAME), path.join(process.cwd(), NAME), path.join(__dirname, '..', NAME)].find(f => fs.existsSync(f)) || path.join(__dirname, NAME);
// Three.js-ийг интернэтгүйгээр ашиглах: энд байвал local-оос өгнө, үгүй бол CDN хэвээр
const THREE_FILE = [path.join(__dirname, 'three.min.js'), path.join(__dirname, 'node_modules', 'three', 'build', 'three.min.js')].find(f => fs.existsSync(f));
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';

const handler = (q, r) => {
  if (THREE_FILE && (q.url || '').split('?')[0] === '/three.min.js')
    return fs.readFile(THREE_FILE, (e, d) => { r.writeHead(e ? 404 : 200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' }); r.end(e ? '' : d); });
  fs.readFile(FILE, 'utf8', (e, d) => {
    if (e) { r.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return r.end(NAME + ' олдсонгүй. server.js-тэй нэг хавтсанд хуулна уу: ' + __dirname); }
    if (THREE_FILE) d = d.replace(CDN, '/three.min.js');
    r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(d);
  });
};
let srv, secure = false;
try { // key.pem + cert.pem байвал HTTPS (микрофон алсын компьютер дээр ажиллахад хэрэгтэй)
  srv = https.createServer({ key: fs.readFileSync(path.join(__dirname, 'key.pem')), cert: fs.readFileSync(path.join(__dirname, 'cert.pem')) }, handler);
  secure = true;
} catch (e) { srv = http.createServer(handler); }

const T0 = Date.now();
const chan = { p: 0, t: 0 }; // shared radio line per team: id of whoever holds it
const C = new Map();
let nid = 1, host = 0, phase = 'lobby', ev = 0, timer = null;

function frame(str) {
  const p = Buffer.from(str), n = p.length; let h;
  if (n < 126) h = Buffer.from([0x81, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
const send = (c, o) => { try { c.sock.write(frame(JSON.stringify(o))); } catch (e) {} };
const all = (o, except) => { for (const c of C.values()) if (c !== except) send(c, o); };
const lobby = () => all({ t: 'lobby', host, phase, players: [...C.values()].map(c => ({ id: c.id, name: c.name, role: c.role })) });

function endGame(w, why) {
  if (phase !== 'play') return;
  phase = 'lobby'; clearTimeout(timer); chan.p = chan.t = 0;
  all({ t: 'end', winner: w, why }); lobby();
}

function onMsg(c, s) {
  let m; try { m = JSON.parse(s); } catch (e) { return; }
  switch (m.t) {
    case 'hello': c.name = String(m.name || 'Тоглогч').slice(0, 12); lobby(); break;
    case 'role': {
      if (phase !== 'lobby' || !['thief', 'helper', 'police', 'camera'].includes(m.role)) break;
      const n = x => [...C.values()].filter(q => q !== c && q.role === x).length;
      if (m.role === 'thief' && n('thief') >= 1) { send(c, { t: 'err', m: 'Хулгайч аль хэдийн сонгогдсон' }); break; }
      if (m.role === 'camera' && n('camera') >= 1) { send(c, { t: 'err', m: 'Камерын ажиглагч аль хэдийн сонгогдсон' }); break; }
      if (m.role === 'helper' && n('helper') >= 2) { send(c, { t: 'err', m: 'Туслах дүүрсэн (дээд тал нь 2)' }); break; }
      c.role = m.role; lobby(); break;
    }
    case 'start': {
      if (phase !== 'lobby' || c.id !== host) break;
      const L = [...C.values()];
      if (L.filter(q => q.role === 'thief').length !== 1 || !L.some(q => q.role === 'police')) {
        send(c, { t: 'err', m: '1 хулгайч, дор хаяж 1 цагдаа хэрэгтэй' }); break;
      }
      phase = 'play'; ev = 0;
      all({ t: 'start', hide: 1 + Math.floor(Math.random() * 16), hf: Math.random(), limit: LIMIT, tod: m.tod ? 1 : 0, seed: Math.floor(Math.random() * 1e6),
        map: (m.map && JSON.stringify(m.map).length < 250000) ? m.map : null }); lobby();
      timer = setTimeout(() => endGame('thief', 'Хугацаа дууслаа'), LIMIT * 1000);
      break;
    }
    case 'pos':
      if (phase === 'play') { m.id = c.id; all(m, c); } break;
    case 'ping':
      if (phase === 'play' && c.role === 'camera') {
        const o = { t: 'ping', x: +m.x || 0, z: +m.z || 0, n: m.n | 0, k: m.k | 0 };
        for (const q of C.values()) if (q.role === 'police' || q.role === 'camera') send(q, o);
      } break;
    case 'chat': {
      const x = String(m.x || '').slice(0, 120); if (!x) break;
      const o = { t: 'chat', f: c.id, x }, tm = q => (q.role === 'police' || q.role === 'camera') ? 'p' : 't';
      if (m.g === 1) { o.g = 1; for (const q of C.values()) if (tm(q) === tm(c)) send(q, o); }
      else if (m.g === 2) { o.g = 2; all(o); }
      else { const q = C.get(m.to | 0); if (!q) break; o.g = 0; o.to = q.id; send(q, o); if (q !== c) send(c, o); }
      break;
    }
    case 'rep': { // дүнгийн хурал: тоглогч бүрийн тайлан бусад бүгдэд
      if (s.length > 90000 || !m.r || typeof m.r !== 'object') break;
      all({ t: 'rep', f: c.id, r: m.r }, c); break;
    }
    case 'dv': // дүнгийн хурлын нээлттэй яриа (дуу) бүгдэд
      if (phase !== 'play' && typeof m.d === 'string' && m.d.length < 20000) all({ t: 'dv', f: c.id, d: m.d }, c);
      break;
    case 'cring': case 'cacc': case 'cend': case 'cv': {
      const q = C.get(m.to | 0); if (q && q !== c) { m.f = c.id; send(q, m); }
      break;
    }
    case 'bug':
      if (phase === 'play' && (c.role === 'police' || c.role === 'camera')) all({ t: 'bug', id: c.id, x: +m.x || 0, z: +m.z || 0, h: +m.h || 0, k: m.k ? 1 : 0 }, c);
      break;
    case 'rstart': { // real-time push-to-talk: one talker per team line
      if (phase !== 'play') break;
      const tm = (c.role === 'police' || c.role === 'camera') ? 'p' : 't';
      if (!chan[tm] || chan[tm] === c.id) { chan[tm] = c.id; send(c, { t: 'rgrant', ok: true }); all({ t: 'rtalk', id: c.id, on: true, team: tm }, c); }
      else send(c, { t: 'rgrant', ok: false });
      break;
    }
    case 'rv': {
      const tm = (c.role === 'police' || c.role === 'camera') ? 'p' : 't';
      if (phase === 'play' && chan[tm] === c.id) all({ t: 'rv', id: c.id, team: tm, d: m.d, x: m.x, z: m.z }, c);
      break;
    }
    case 'rstop': {
      const tm = (c.role === 'police' || c.role === 'camera') ? 'p' : 't';
      if (chan[tm] === c.id) { chan[tm] = 0; all({ t: 'rtalk', id: c.id, on: false, team: tm }, c); }
      break;
    }
    case 'photo':
      if (phase === 'play' && (c.role === 'police' || c.role === 'camera')) {
        if (m.valid) ev++;
        m.id = c.id; m.ev = ev; all(m);
        if (ev >= 3) endGame('police', '3 баримт цугларлаа');
      } break;
    case 'end':
      if (phase === 'play' && ['police', 'thief'].includes(m.winner)) endGame(m.winner, String(m.why || '').slice(0, 60));
      break;
  }
}

function parse(c) {
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1]; let len = b1 & 127, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
    const masked = b1 & 128;
    if (c.buf.length < off + (masked ? 4 : 0) + len) return;
    const mask = masked ? c.buf.slice(off, off + 4) : null; off += masked ? 4 : 0;
    const pl = Buffer.from(c.buf.slice(off, off + len));
    if (mask) for (let i = 0; i < len; i++) pl[i] ^= mask[i & 3];
    c.buf = c.buf.slice(off + len);
    const op = b0 & 15;
    if (op === 8) { c.sock.end(); return; }
    if (op === 9) { c.sock.write(Buffer.from([0x8a, 0])); continue; }
    if (op === 1) onMsg(c, pl.toString());
  }
}

srv.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  if (C.size >= 7 || phase === 'play') {
    send({ sock }, { t: 'err', m: phase === 'play' ? 'Тоглоом явагдаж байна' : 'Сервер дүүрсэн (дээд тал нь 7)' });
    return sock.end();
  }
  const c = { sock, id: nid++, name: 'Тоглогч', role: 'police', buf: Buffer.alloc(0) };
  C.set(c.id, c); if (!host) host = c.id;
  send(c, { t: 'welcome', id: c.id, now: Date.now(), t0: T0 }); lobby();
  sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); parse(c); });
  const drop = () => {
    if (!C.has(c.id)) return;
    C.delete(c.id);
    if (chan.p === c.id) chan.p = 0;
    if (chan.t === c.id) chan.t = 0;
    if (host === c.id) host = C.size ? [...C.keys()][0] : 0;
    if (phase === 'play' && c.role === 'thief') endGame('police', 'Хулгайч тоглоомоос гарлаа');
    if (!C.size) { phase = 'lobby'; clearTimeout(timer); }
    lobby();
  };
  sock.on('close', drop); sock.on('error', drop); sock.on('end', drop);
});

srv.listen(PORT, '0.0.0.0', () => {
  const pr = secure ? 'https' : 'http';
  console.log('Сервер ажиллаж байна (' + pr + ')');
  console.log('  Тоглоомын файл: ' + FILE + (fs.existsSync(FILE) ? '' : '   <-- ОЛДСОНГҮЙ!'));
  console.log('  Энэ компьютер дээр нээх: ' + pr + '://localhost:' + PORT);
  for (const l of Object.values(os.networkInterfaces()))
    for (const i of l) if (i.family === 'IPv4' && !i.internal) console.log('  Бусад тоглогчдод өгөх хаяг: ' + pr + '://' + i.address + ':' + PORT);
});
