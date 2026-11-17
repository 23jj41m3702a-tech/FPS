// FPS 멀티플레이 서버: index.html 정적 서빙 + WebSocket(같은 포트)
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const HP_MAX = 100, KILL_LIMIT = 30, ROUND_MS = 10 * 60 * 1000, END_MS = 10000, RESPAWN_MS = 3000, PROT_MS = 2000;
const BLAST = { radius: 8, max: 150, pow: 1.2 }, FALL = { safe: 12, k: 5 };
const DMG = { 1: { b: 30, h: 90, l: 22 }, 2: { b: 24, h: 70, l: 18 } };   // 슬롯1=HX7, 슬롯2=권총
const WCODE = { 1: 'r', 2: 'p' };

const server = http.createServer((req, res) => {
  const f = path.join(__dirname, 'index.html');
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('index.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(buf);
  });
});
const wss = new WebSocketServer({ server });

const rooms = {};
let nextId = 1;
function room(name) {
  return rooms[name] || (rooms[name] = { name, players: new Map(), a: 0, b: 0, phase: 'play', endAt: Date.now() + ROUND_MS });
}
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const bcast = (r, o, except) => r.players.forEach(p => { if (p !== except) send(p.ws, o); });
const tl = r => Math.max(0, Math.ceil((r.endAt - Date.now()) / 1000));
function boardMsg(r) {
  return { t: 'b', a: r.a, b: r.b, tl: tl(r), ph: r.phase,
    p: [...r.players.values()].map(p => [p.id, p.name, p.team, p.k, p.d, p.ping, p.alive ? 1 : 0]) };
}
function pickTeam(r) {
  let a = 0, b = 0; r.players.forEach(p => p.team === 'A' ? a++ : b++);
  return a <= b ? 'A' : 'B';
}
function kill(r, victim, killer, slot, head) {
  if (!victim.alive || r.phase !== 'play') return;
  victim.alive = false; victim.hp = 0; victim.d++;
  if (killer && killer !== victim) { killer.k++; if (killer.team === 'A') r.a++; else r.b++; }
  send(victim.ws, { t: 'dead', by: killer && killer !== victim ? killer.id : -1, s: slot, h: head ? 1 : 0, rs: RESPAWN_MS });
  bcast(r, { t: 'kill', k: killer && killer !== victim ? killer.id : -1, v: victim.id, s: slot, h: head ? 1 : 0 });
  bcast(r, boardMsg(r)); send(victim.ws, boardMsg(r));
  if (r.a >= KILL_LIMIT || r.b >= KILL_LIMIT) return endRound(r);
  victim.rt = setTimeout(() => respawn(r, victim), RESPAWN_MS);
}
function respawn(r, p) {
  if (!r.players.has(p.id) || r.phase !== 'play') return;
  p.alive = true; p.hp = HP_MAX; p.prot = Date.now() + PROT_MS;
  const m = { t: 'sp', id: p.id, team: p.team, prot: PROT_MS };
  send(p.ws, m); bcast(r, m, p.ws);
  bcast(r, boardMsg(r)); send(p.ws, boardMsg(r));
}
function damage(r, victim, killer, dmg, slot, head) {
  if (!victim.alive || r.phase !== 'play' || Date.now() < victim.prot) return;
  victim.hp -= dmg;
  send(victim.ws, { t: 'hp', hp: Math.max(0, victim.hp), dmg, from: killer ? killer.id : -1 });
  if (victim.hp <= 0) kill(r, victim, killer, slot, head);
}
function endRound(r) {
  r.phase = 'end';
  const w = r.a === r.b ? '-' : (r.a > r.b ? 'A' : 'B');
  bcast(r, { t: 'end', w, a: r.a, b: r.b, next: END_MS });
  r.players.forEach(p => clearTimeout(p.rt));
  setTimeout(() => {
    r.a = r.b = 0; r.phase = 'play'; r.endAt = Date.now() + ROUND_MS;
    r.players.forEach(p => { p.k = p.d = 0; p.alive = true; p.hp = HP_MAX; p.prot = Date.now() + PROT_MS; });
    bcast(r, { t: 'ms' });
    r.players.forEach(p => { const m = { t: 'sp', id: p.id, team: p.team, prot: PROT_MS }; send(p.ws, m); bcast(r, m, p.ws); send(p.ws, { t: 'hp', hp: HP_MAX, dmg: 0, from: -1 }); });
    bcast(r, boardMsg(r));
  }, END_MS);
}

wss.on('connection', ws => {
  let r = null, me = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join') {
      if (me) return;
      const name = String(m.name || '').trim().slice(0, 12) || '플레이어';
      r = room(String(m.room || 'main').slice(0, 20));
      if ([...r.players.values()].some(p => p.name === name)) return send(ws, { t: 'err', m: '이미 사용 중인 닉네임입니다.' }), ws.close();
      me = { id: nextId++, ws, name, team: pickTeam(r), hp: HP_MAX, alive: true, k: 0, d: 0, ping: 0, prot: Date.now() + PROT_MS, pos: null };
      r.players.set(me.id, me);
      send(ws, { t: 'welcome', id: me.id, team: me.team, name: me.name, phase: r.phase, killLimit: KILL_LIMIT, a: r.a, b: r.b, tl: tl(r), hp: HP_MAX,
        players: [...r.players.values()].filter(p => p !== me).map(p => ({ id: p.id, name: p.name, team: p.team, alive: p.alive })) });
      bcast(r, { t: 'pj', id: me.id, name: me.name, team: me.team }, ws);
      bcast(r, boardMsg(r)); send(ws, boardMsg(r));
      return;
    }
    if (!me || !r) return;
    if (m.t === 'u') {
      if (!me.alive) return;
      me.pos = [m.x, m.y, m.z];
      me.upd = [me.id, m.x, m.y, m.z, m.yw, m.pt, m.sl, m.f];
    } else if (m.t === 'shot') {
      if (!me.alive || r.phase !== 'play') return;
      bcast(r, { t: 'shot', id: me.id, sl: m.sl, o: m.o, d: m.d }, ws);
    } else if (m.t === 'hit') {
      const v = r.players.get(m.id); const d = DMG[m.sl];
      if (!v || !d || !me.alive || v.team === me.team) return;
      damage(r, v, me, d[m.z] || d.b, WCODE[m.sl], m.z === 'h');
      send(ws, { t: 'hc', k: v.alive ? 0 : 1, z: m.z });
    } else if (m.t === 'boom') {
      if (!me.alive || r.phase !== 'play' || !Array.isArray(m.p) || !Array.isArray(m.v)) return;
      bcast(r, { t: 'boom', p: m.p }, ws);
      m.v.slice(0, 32).forEach(id => {
        const v = r.players.get(id); if (!v || (v !== me && v.team === me.team) || !v.pos) return;
        const dist = Math.hypot(v.pos[0] - m.p[0], v.pos[1] + 1 - m.p[1], v.pos[2] - m.p[2]);
        if (dist >= BLAST.radius) return;
        const dmg = BLAST.max * Math.pow(1 - dist / BLAST.radius, BLAST.pow);
        if (dmg > 1) damage(r, v, me, Math.round(dmg), 'f', false);
      });
    } else if (m.t === 'fall') {
      if (!me.alive) return;
      const dmg = Math.min(HP_MAX, (-m.vy - FALL.safe) * FALL.k);
      if (dmg > 0) damage(r, me, null, Math.round(dmg), 'x', false);
    }
  });
  ws.on('close', () => {
    if (!me || !r) return;
    clearTimeout(me.rt); r.players.delete(me.id);
    bcast(r, { t: 'pl', id: me.id }); bcast(r, boardMsg(r));
    if (!r.players.size) delete rooms[r.name];
  });
  ws.on('error', () => {});
});

// 20Hz 위치 스냅샷 · 1초마다 점수판/타이머
setInterval(() => {
  for (const r of Object.values(rooms)) {
    const ups = []; r.players.forEach(p => { if (p.upd) { ups.push(p.upd); p.upd = null; } });
    if (ups.length) bcast(r, { t: 's', p: ups });
  }
}, 50);
setInterval(() => {
  for (const r of Object.values(rooms)) {
    if (r.phase === 'play' && Date.now() >= r.endAt) endRound(r);
    else bcast(r, boardMsg(r));
  }
}, 1000);
setInterval(() => {   // 핑 측정은 WebSocket ping/pong 사용
  for (const r of Object.values(rooms)) r.players.forEach(p => { p.t0 = Date.now(); try { p.ws.ping(); } catch {} });
}, 3000);
wss.on('connection', ws => ws.on('pong', () => {}));

server.listen(PORT, () => console.log('FPS server on :' + PORT));
