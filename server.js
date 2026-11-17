'use strict';
/* ═══════════════ 바자르 로우 멀티플레이 서버 ═══════════════
 * - index.html 을 서빙하고, 같은 포트에서 WebSocket(게임 서버)도 처리합니다.
 * - 방(room)별로 A/B 팀 데스매치를 진행합니다. (먼저 KILL_LIMIT 킬 or 시간 종료)
 * - 서버가 체력·데미지·킬·리스폰·점수를 판정합니다.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;

/* ── 설정 (원하는 대로 바꾸세요. 환경변수로도 덮어쓸 수 있음) ── */
const CFG = {
  killLimit: Number(process.env.KILL_LIMIT) || 30,        // 이 킬 수에 먼저 도달한 팀 승리
  matchSeconds: Number(process.env.MATCH_SECONDS) || 600, // 한 판 제한 시간(초)
  endPauseMs: 10000,   // 판 종료 후 다음 판까지 대기
  respawnMs: 3000,     // 사망 후 리스폰 시간
  protectMs: 2000,     // 리스폰 직후 무적 시간
  maxPerRoom: Number(process.env.MAX_PER_ROOM) || 16,
  hpMax: 100,
};
const DAMAGE = {                       // 슬롯 1=HX7(소총), 2=글록 21(권총)
  1: { h: 55, b: 28, l: 20 },          // h=머리, b=몸통, l=다리
  2: { h: 45, b: 22, l: 16 },
};
const BLAST = { radius: 8, max: 150, pow: 1.2 };  // 수류탄 (클라이언트와 동일)
const FALL = { safe: 12, k: 5 };                  // 낙하 피해 (클라이언트와 동일)
const WKEY = { 1: 'r', 2: 'p', 3: 'f' };          // 킬피드에 표시할 무기 코드
const GAP = { shot: 30, hit1: 45, hit2: 90, boom: 400, fall: 300 };  // 도배 방지(ms)

/* ── 유틸 ── */
const now = () => Date.now();
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(num);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function cleanName(s) {
  s = String(s || '').replace(/[\u0000-\u001f<>&"'\\]/g, '').trim().slice(0, 12);
  return s || '플레이어' + (10 + Math.floor(Math.random() * 90));
}
function cleanRoom(s) {
  s = String(s || '').trim().toLowerCase().replace(/[^a-z0-9가-힣_-]/g, '').slice(0, 20);
  return s || 'main';
}

/* ── 전송 ── */
function send(p, obj) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); }
function broadcast(room, obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const p of room.players.values()) if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(s);
}

/* ── 방 ── */
const rooms = new Map();
function getRoom(name) {
  let r = rooms.get(name);
  if (!r) {
    r = { name, players: new Map(), nextId: 1, phase: 'play', a: 0, b: 0, endsAt: now() + CFG.matchSeconds * 1000, endTimer: null };
    rooms.set(name, r);
  }
  return r;
}
const timeLeft = (room) => (room.phase === 'play' ? Math.max(0, Math.ceil((room.endsAt - now()) / 1000)) : 0);

function sendBoard(room) {
  const rows = [];
  for (const p of room.players.values()) rows.push([p.id, p.name, p.team, p.kills, p.deaths, p.ping, p.alive ? 1 : 0]);
  broadcast(room, { t: 'b', a: room.a, b: room.b, tl: timeLeft(room), ph: room.phase, p: rows });
}

function pickTeam(room) {
  let a = 0, b = 0;
  for (const p of room.players.values()) p.team === 'A' ? a++ : b++;
  if (a !== b) return a < b ? 'A' : 'B';
  if (room.a !== room.b) return room.a < room.b ? 'A' : 'B';
  return Math.random() < 0.5 ? 'A' : 'B';
}

/* ── 전투 ── */
function applyDamage(room, v, dmg, attacker, wkey, head) {
  if (room.phase !== 'play' || !v.alive) return;
  v.hp = Math.max(0, v.hp - dmg);
  const dead = v.hp <= 0;
  const self = !attacker || attacker === v;
  send(v, { t: 'hp', hp: Math.ceil(v.hp), dmg: Math.round(dmg), from: self ? -1 : attacker.id });
  if (!self) send(attacker, { t: 'hc', k: dead, z: head ? 'h' : 'b' });
  if (dead) die(room, v, self ? null : attacker, wkey, head);
}

function die(room, v, attacker, wkey, head) {
  v.alive = false; v.hp = 0; v.deaths++;
  if (attacker) { attacker.kills++; attacker.team === 'A' ? room.a++ : room.b++; }
  send(v, { t: 'dead', by: attacker ? attacker.id : -1, s: wkey, h: head ? 1 : 0, rs: CFG.respawnMs });
  broadcast(room, { t: 'kill', k: attacker ? attacker.id : -1, v: v.id, s: wkey, h: head ? 1 : 0 });
  sendBoard(room);
  if (room.a >= CFG.killLimit || room.b >= CFG.killLimit) return endMatch(room);
  v.respawnTimer = setTimeout(() => respawn(room, v), CFG.respawnMs);
}

function respawn(room, p) {
  p.respawnTimer = null;
  if (room.phase !== 'play' || !room.players.has(p.id)) return;
  p.hp = CFG.hpMax; p.alive = true; p.hasPos = false; p.protUntil = now() + CFG.protectMs;
  broadcast(room, { t: 'sp', id: p.id, team: p.team, prot: CFG.protectMs });
}

function endMatch(room) {
  if (room.phase !== 'play') return;
  room.phase = 'end';
  for (const p of room.players.values()) { clearTimeout(p.respawnTimer); p.respawnTimer = null; }
  const w = room.a > room.b ? 'A' : room.b > room.a ? 'B' : '-';
  broadcast(room, { t: 'end', w, a: room.a, b: room.b, next: CFG.endPauseMs });
  sendBoard(room);
  room.endTimer = setTimeout(() => newMatch(room), CFG.endPauseMs);
}

function newMatch(room) {
  room.endTimer = null;
  if (!room.players.size) return;
  room.phase = 'play'; room.a = 0; room.b = 0; room.endsAt = now() + CFG.matchSeconds * 1000;
  const list = shuffle([...room.players.values()]);
  const off = Math.random() < 0.5 ? 0 : 1;   // 팀 재배정 (인원 균등)
  list.forEach((p, i) => {
    p.team = (i + off) % 2 ? 'B' : 'A';
    p.kills = 0; p.deaths = 0; p.hp = CFG.hpMax; p.alive = true; p.hasPos = false; p.protUntil = now() + CFG.protectMs;
  });
  broadcast(room, { t: 'ms' });
  for (const p of list) broadcast(room, { t: 'sp', id: p.id, team: p.team, prot: CFG.protectMs });
  sendBoard(room);
}

/* ── 접속 / 퇴장 ── */
function onJoin(ws, m) {
  if (ws.p) return;
  const room = getRoom(cleanRoom(m.room));
  if (room.players.size >= CFG.maxPerRoom) {
    if (!room.players.size) rooms.delete(room.name);
    return ws.send(JSON.stringify({ t: 'err', m: `방이 가득 찼습니다 (최대 ${CFG.maxPerRoom}명).` }));
  }
  clearTimeout(ws.joinTimer);
  const p = {
    id: room.nextId++, ws, room, name: cleanName(m.name), team: pickTeam(room),
    x: 0, y: 0, z: 0, yw: 0, pt: 0, sl: 1, f: 0, hasPos: false,
    hp: CFG.hpMax, alive: true, kills: 0, deaths: 0, protUntil: now() + CFG.protectMs,
    ping: 0, respawnTimer: null, lastU: 0, lastShot: 0, lastHit: { 1: 0, 2: 0 }, lastBoom: 0, lastFall: 0,
  };
  const others = [...room.players.values()].map((o) => ({ id: o.id, name: o.name, team: o.team, alive: o.alive }));
  room.players.set(p.id, p);
  ws.p = p;
  send(p, { t: 'welcome', id: p.id, team: p.team, name: p.name, phase: room.phase, killLimit: CFG.killLimit, a: room.a, b: room.b, tl: timeLeft(room), hp: p.hp, players: others });
  send(p, { t: 'sp', id: p.id, team: p.team, prot: CFG.protectMs });   // 내 팀 스폰 위치로 이동
  broadcast(room, { t: 'pj', id: p.id, name: p.name, team: p.team }, p.id);
  sendBoard(room);
}

function leave(ws) {
  clearTimeout(ws.joinTimer);
  const p = ws.p; if (!p) return;
  ws.p = null;
  const room = p.room;
  clearTimeout(p.respawnTimer);
  room.players.delete(p.id);
  broadcast(room, { t: 'pl', id: p.id });
  if (!room.players.size) { clearTimeout(room.endTimer); rooms.delete(room.name); return; }
  sendBoard(room);
}

/* ── 메시지 처리 ── */
function handle(ws, m) {
  if (m.t === 'join') return onJoin(ws, m);
  const p = ws.p; if (!p) return;
  const room = p.room, t = now();

  switch (m.t) {
    case 'u': {   // 내 위치·시점 (20Hz)
      if (t - p.lastU < 25 || !p.alive) return;
      if (![m.x, m.y, m.z, m.yw, m.pt].every(num)) return;
      if (Math.abs(m.x) > 2000 || Math.abs(m.z) > 2000 || m.y < -100 || m.y > 500) return;
      p.lastU = t; p.x = m.x; p.y = m.y; p.z = m.z; p.yw = m.yw; p.pt = m.pt;
      const sl = m.sl | 0; p.sl = sl >= 1 && sl <= 3 ? sl : 1;
      p.f = (m.f | 0) & 3; p.hasPos = true;
      break;
    }
    case 'shot': {   // 총 발사 (소리·총알 이펙트용 중계)
      if (!p.alive || room.phase !== 'play') return;
      const sl = m.sl | 0;
      if (sl < 1 || sl > 3 || !vec3(m.o) || !vec3(m.d)) return;
      if (t - p.lastShot < GAP.shot) return;
      p.lastShot = t;
      broadcast(room, { t: 'shot', id: p.id, sl, o: m.o, d: m.d }, p.id);
      break;
    }
    case 'hit': {    // 명중 신고
      if (!p.alive || room.phase !== 'play') return;
      const sl = m.sl | 0, table = DAMAGE[sl];
      if (!table) return;
      const v = room.players.get(m.id | 0);
      if (!v || v === p || !v.alive || v.team === p.team || v.protUntil > t) return;
      if (t - p.lastHit[sl] < (sl === 1 ? GAP.hit1 : GAP.hit2)) return;
      p.lastHit[sl] = t;
      if (p.hasPos && v.hasPos && Math.hypot(p.x - v.x, p.y - v.y, p.z - v.z) > 220) return;
      const z = m.z === 'h' ? 'h' : m.z === 'l' ? 'l' : 'b';
      applyDamage(room, v, table[z], p, WKEY[sl], z === 'h');
      break;
    }
    case 'boom': {   // 수류탄 폭발 (피해 대상 목록은 서버가 거리로 다시 계산)
      if (!p.alive || room.phase !== 'play' || !vec3(m.p)) return;
      if (t - p.lastBoom < GAP.boom) return;
      p.lastBoom = t;
      if (p.hasPos && Math.hypot(m.p[0] - p.x, m.p[1] - p.y, m.p[2] - p.z) > 150) return;
      broadcast(room, { t: 'boom', p: m.p }, p.id);
      const seen = new Set();
      for (const raw of (Array.isArray(m.v) ? m.v.slice(0, 20) : [])) {
        const id = raw | 0;
        if (seen.has(id)) continue;
        seen.add(id);
        const v = room.players.get(id);
        if (!v || !v.alive || !v.hasPos) continue;
        if (v !== p && (v.team === p.team || v.protUntil > t)) continue;
        const d = Math.hypot(v.x - m.p[0], v.y + 1 - m.p[1], v.z - m.p[2]);
        if (d >= BLAST.radius) continue;
        const dmg = BLAST.max * Math.pow(1 - d / BLAST.radius, BLAST.pow);
        if (dmg > 1) applyDamage(room, v, dmg, p, 'f', false);
      }
      break;
    }
    case 'fall': {   // 낙하 피해
      if (!p.alive || room.phase !== 'play' || p.protUntil > t || !num(m.vy)) return;
      if (t - p.lastFall < GAP.fall) return;
      p.lastFall = t;
      const dmg = Math.min(CFG.hpMax, (-Math.max(-80, m.vy) - FALL.safe) * FALL.k);
      if (dmg > 0) applyDamage(room, p, dmg, null, 'x', false);
      break;
    }
  }
}

/* ── HTTP (index.html 서빙) ── */
const INDEX = path.join(__dirname, 'index.html');
const indexRaw = fs.readFileSync(INDEX);
const indexGz = zlib.gzipSync(indexRaw, { level: 9 });

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url === '/' || url === '/index.html') {
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const head = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
    if (gz) head['Content-Encoding'] = 'gzip';
    res.writeHead(200, head);
    return res.end(gz ? indexGz : indexRaw);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

/* ── WebSocket ── */
const wss = new WebSocketServer({ server, maxPayload: 4096, perMessageDeflate: false });
wss.on('connection', (ws) => {
  ws.missed = 0; ws.pingSentAt = 0; ws.p = null;
  ws.joinTimer = setTimeout(() => { if (!ws.p) ws.close(); }, 10000);   // 10초 안에 join 안 하면 끊기
  ws.on('pong', () => { ws.missed = 0; if (ws.p) ws.p.ping = Math.min(999, now() - ws.pingSentAt); });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error('handler error:', e); }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

/* 20Hz: 모든 플레이어 위치를 서로에게 전송 / 시간 종료 체크 */
setInterval(() => {
  const t = now();
  for (const room of rooms.values()) {
    if (room.phase === 'play' && t >= room.endsAt) { endMatch(room); continue; }
    if (room.players.size < 2) continue;
    const rows = [];
    for (const p of room.players.values()) {
      if (p.alive && p.hasPos) rows.push([p.id, JSON.stringify([p.id, r2(p.x), r2(p.y), r2(p.z), r3(p.yw), r3(p.pt), p.sl, p.f])]);
    }
    for (const p of room.players.values()) {
      if (p.ws.readyState !== 1) continue;
      const mine = rows.filter((r) => r[0] !== p.id).map((r) => r[1]);
      if (mine.length) p.ws.send('{"t":"s","p":[' + mine.join(',') + ']}');
    }
  }
}, 50);

/* 1Hz: 스코어보드·남은 시간·핑 갱신 */
setInterval(() => { for (const room of rooms.values()) sendBoard(room); }, 1000);

/* 5초마다 연결 확인(핑 측정 + 끊긴 연결 정리) */
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.missed >= 4) { ws.terminate(); continue; }
    ws.missed++; ws.pingSentAt = now();
    try { ws.ping(); } catch (e) {}
  }
}, 5000);

server.listen(PORT, () => console.log(`바자르 로우 서버 실행 중: http://localhost:${PORT}`));
