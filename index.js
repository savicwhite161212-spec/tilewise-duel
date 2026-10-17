// Tilewise sunucusu: isim, arkadaşlar, odalar (2-4 kişi), çok turlu düello ve puanlı sıralama.
// Veriler bellekte tutulur; sunucu yeniden başlarsa silinir.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ROOM_MAX = 4;
const ROUND_PTS = [100, 70, 50, 30]; // tur sıralaması puanı (1., 2., 3., 4.)
const TIME_BONUS_MAX = 60;           // her saniye için 1 puan: 60 sn'den hızlı çözene ek puan
const ROUND_CAP_MS = 180000;         // bir turda en fazla 3 dk beklenir
const BETWEEN_MS = 7000;             // turlar arası bekleme
const NAME_RE = /^[A-Za-zÇĞİÖŞÜçğıöşü0-9_]{2,12}$/;

const users = new Map();  // key(küçük harf) -> { name, friends:Set, incoming:Set, outgoing:Set, score, streak, wins }
const online = new Map(); // key -> ws
const rooms = new Map();  // code -> { code, host, members:[key], started, between, seed, done:{key:ms}, rounds, round, totals:{key:puan} }

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Tilewise duel server ok');
});
const wss = new WebSocketServer({ server });

function send(ws, o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function sendKey(key, o) { send(online.get(key), o); }
function nameOf(key) { const u = users.get(key); return u ? u.name : ''; }
function newCode() {
  let c;
  do { c = String(10000 + Math.floor(Math.random() * 90000)); } while (rooms.has(c));
  return c;
}

function pushFriends(key) {
  const u = users.get(key); if (!u) return;
  sendKey(key, {
    t: 'friends',
    friends: [...u.friends].map(k => ({ name: nameOf(k), online: online.has(k) })),
    incoming: [...u.incoming].map(nameOf),
    outgoing: [...u.outgoing].map(nameOf),
  });
}
function notifyFriends(key) {
  const u = users.get(key); if (!u) return;
  pushFriends(key);
  u.friends.forEach(f => pushFriends(f));
}

function roomState(room) {
  return { t: 'room', code: room.code, host: nameOf(room.host), players: room.members.map(nameOf), started: room.started, rounds: room.rounds, round: room.round };
}
function broadcastRoom(room) { room.members.forEach(k => sendKey(k, roomState(room))); }

function clearTimers(room) { clearTimeout(room.cap); clearTimeout(room.timer); }

function startRound(room) {
  clearTimers(room);
  room.round++;
  room.started = true; room.between = false; room.done = {};
  room.seed = 1 + Math.floor(Math.random() * 2e9);
  room.cap = setTimeout(() => {
    if (!room.started || room.between) return;
    room.members.forEach(k => { if (room.done[k] == null) room.done[k] = ROUND_CAP_MS; });
    maybeFinish(room);
  }, ROUND_CAP_MS + 5000);
  const players = room.members.map(nameOf);
  room.members.forEach(k => sendKey(k, { t: 'start', seed: room.seed, players, round: room.round, rounds: room.rounds }));
  broadcastRoom(room);
}

// Oyun bitti: toplam puana göre son sıralama
function finalize(room) {
  clearTimers(room);
  const ranks = room.members
    .map(k => ({ key: k, name: nameOf(k), total: room.totals[k] || 0 }))
    .sort((a, b) => b.total - a.total || (room.sumMs[a.key] || 0) - (room.sumMs[b.key] || 0));
  if (ranks.length >= 2) { const u = users.get(ranks[0].key); if (u) u.wins++; }
  const out = ranks.map(r => ({ name: r.name, total: r.total }));
  room.members.forEach(k => sendKey(k, { t: 'result', ranks: out, rounds: room.rounds }));
  room.started = false; room.between = false; room.round = 0; room.done = {}; room.totals = {}; room.sumMs = {};
  broadcastRoom(room);
}

// Herkes turu bitirdiyse puanla; son tursa toplam sıralamayı gönder
function maybeFinish(room) {
  if (!room.started || room.between || room.members.length === 0) return;
  if (!room.members.every(k => room.done[k] != null)) return;
  clearTimeout(room.cap);
  const ranks = room.members
    .map(k => ({ key: k, name: nameOf(k), ms: room.done[k] }))
    .sort((a, b) => a.ms - b.ms);
  ranks.forEach((r, i) => {
    const bonus = Math.max(0, Math.round(TIME_BONUS_MAX - r.ms / 1000));
    r.pts = (ROUND_PTS[i] != null ? ROUND_PTS[i] : 20) + bonus;
    room.totals[r.key] = (room.totals[r.key] || 0) + r.pts;
    room.sumMs[r.key] = (room.sumMs[r.key] || 0) + r.ms;
    r.total = room.totals[r.key];
  });
  if (room.round >= room.rounds) {
    // son turun sonucunu da göster, sonra toplam sıralama
    const last = ranks.map(r => ({ name: r.name, ms: r.ms, pts: r.pts, total: r.total }));
    room.members.forEach(k => sendKey(k, { t: 'round_result', round: room.round, rounds: room.rounds, ranks: last, next: 0 }));
    return finalize(room);
  }
  room.between = true;
  const out = ranks.map(r => ({ name: r.name, ms: r.ms, pts: r.pts, total: r.total }));
  room.members.forEach(k => sendKey(k, { t: 'round_result', round: room.round, rounds: room.rounds, ranks: out, next: BETWEEN_MS / 1000 }));
  room.timer = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (room.members.length < 2) return finalize(room);
    startRound(room);
  }, BETWEEN_MS);
}

function leaveRoom(ws) {
  const code = ws.room; if (!code) return;
  ws.room = null;
  const room = rooms.get(code); if (!room) return;
  room.members = room.members.filter(k => k !== ws.key);
  if (room.members.length === 0 || room.host === ws.key) {
    room.members.forEach(k => {
      sendKey(k, { t: 'room_closed', msg: 'Oda kurucusu odadan ayrıldı, oda kapandı.' });
      const w = online.get(k); if (w) w.room = null;
    });
    clearTimers(room);
    rooms.delete(code);
    return;
  }
  delete room.done[ws.key]; delete room.totals[ws.key];
  broadcastRoom(room);
  maybeFinish(room);
}

function frAdd(ws, me, toName) {
  const tk = toName.toLowerCase();
  const t = users.get(tk);
  if (!t) return send(ws, { t: 'error', msg: 'Kullanıcı bulunamadı.' });
  if (tk === ws.key) return send(ws, { t: 'error', msg: 'Kendini ekleyemezsin.' });
  if (me.friends.has(tk)) return send(ws, { t: 'error', msg: 'Zaten arkadaşsınız.' });
  if (me.incoming.has(tk)) return frAccept(ws, me, toName);
  if (me.outgoing.has(tk)) return send(ws, { t: 'error', msg: 'İstek zaten gönderildi.' });
  t.incoming.add(ws.key);
  me.outgoing.add(tk);
  notifyFriends(tk); notifyFriends(ws.key);
}
function frAccept(ws, me, fromName) {
  const fk = fromName.toLowerCase(), f = users.get(fk);
  if (!f || !me.incoming.has(fk)) return send(ws, { t: 'error', msg: 'İstek bulunamadı.' });
  me.incoming.delete(fk); f.outgoing.delete(ws.key);
  me.friends.add(fk); f.friends.add(ws.key);
  notifyFriends(fk); notifyFriends(ws.key);
}
function frReject(ws, me, fromName) {
  const fk = fromName.toLowerCase(), f = users.get(fk);
  me.incoming.delete(fk);
  if (f) f.outgoing.delete(ws.key);
  notifyFriends(fk); notifyFriends(ws.key);
}
function frRemove(ws, me, name) {
  const fk = name.toLowerCase(), f = users.get(fk);
  me.friends.delete(fk);
  if (f) f.friends.delete(ws.key);
  notifyFriends(fk); notifyFriends(ws.key);
}

function hello(ws, m) {
  if (ws.key) return send(ws, { t: 'hello_ok', name: nameOf(ws.key) });
  const name = String(m.name || '').trim();
  if (!NAME_RE.test(name)) return send(ws, { t: 'error', msg: 'İsim 2-12 harf ya da rakam olmalı.' });
  const key = name.toLowerCase();
  if (online.has(key) && online.get(key) !== ws) return send(ws, { t: 'error', msg: 'Bu isim şu an kullanımda.' });
  if (!users.has(key)) users.set(key, { name, friends: new Set(), incoming: new Set(), outgoing: new Set(), score: 0, streak: 0, wins: 0 });
  ws.key = key;
  online.set(key, ws);
  send(ws, { t: 'hello_ok', name: users.get(key).name });
  notifyFriends(key);
}

function sendLb(ws, field) {
  const f = ['score', 'streak', 'wins'].includes(field) ? field : 'score';
  const rows = [...users.values()]
    .filter(u => u[f] > 0)
    .sort((a, b) => b[f] - a[f])
    .slice(0, 20)
    .map(u => ({ name: u.name, v: u[f] }));
  send(ws, { t: 'lb', field: f, rows });
}

wss.on('connection', ws => {
  ws.key = null;
  ws.room = null;

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'hello') return hello(ws, m);
    if (!ws.key) return send(ws, { t: 'error', msg: 'Önce isim seç.' });
    const me = users.get(ws.key);

    switch (m.t) {
      case 'fr_add': return frAdd(ws, me, String(m.to || ''));
      case 'fr_accept': return frAccept(ws, me, String(m.from || ''));
      case 'fr_reject': return frReject(ws, me, String(m.from || ''));
      case 'fr_remove': return frRemove(ws, me, String(m.from || ''));
      case 'stats':
        me.score = Math.max(me.score, Number(m.score) || 0);
        me.streak = Math.max(me.streak, Number(m.streak) || 0);
        return;
      case 'lb': return sendLb(ws, String(m.field || 'score'));

      case 'create': {
        leaveRoom(ws);
        const code = newCode();
        const room = { code, host: ws.key, members: [ws.key], started: false, between: false, seed: 0, done: {}, rounds: 3, round: 0, totals: {}, sumMs: {} };
        rooms.set(code, room);
        ws.room = code;
        return broadcastRoom(room);
      }
      case 'join': {
        const code = String(m.code || '');
        const room = rooms.get(code);
        if (!room) return send(ws, { t: 'error', msg: 'Oda bulunamadı. Kodu kontrol et.' });
        if (room.members.includes(ws.key)) return broadcastRoom(room);
        if (room.started) return send(ws, { t: 'error', msg: 'Oyun devam ediyor, bitince katılabilirsin.' });
        if (room.members.length >= ROOM_MAX) return send(ws, { t: 'error', msg: 'Oda dolu (en fazla 4 kişi).' });
        leaveRoom(ws);
        room.members.push(ws.key);
        ws.room = code;
        return broadcastRoom(room);
      }
      case 'leave':
        leaveRoom(ws);
        return send(ws, { t: 'left' });
      case 'invite': {
        const room = rooms.get(ws.room);
        if (!room) return send(ws, { t: 'error', msg: 'Önce bir oda kur.' });
        const tk = String(m.to || '').toLowerCase();
        if (!me.friends.has(tk) || !online.has(tk)) return send(ws, { t: 'error', msg: 'Arkadaş çevrimiçi değil.' });
        if (room.members.length >= ROOM_MAX) return send(ws, { t: 'error', msg: 'Oda dolu.' });
        return sendKey(tk, { t: 'invite', from: me.name, code: room.code });
      }
      case 'start': {
        const room = rooms.get(ws.room);
        if (!room || room.host !== ws.key) return send(ws, { t: 'error', msg: 'Oyunu sadece oda kurucusu başlatabilir.' });
        if (room.started) return;
        if (room.members.length < 2) return send(ws, { t: 'error', msg: 'Başlamak için en az 2 kişi gerekli.' });
        room.rounds = Math.min(10, Math.max(1, Math.floor(Number(m.rounds)) || 3));
        room.round = 0; room.totals = {}; room.sumMs = {};
        return startRound(room);
      }
      case 'relay': {
        const room = rooms.get(ws.room);
        if (!room || !room.started || room.between) return;
        room.members.forEach(k => { if (k !== ws.key) sendKey(k, { t: 'relay', from: me.name, data: m.data }); });
        if (m.data && m.data.t === 'done' && room.done[ws.key] == null) {
          room.done[ws.key] = Number(m.data.ms) || 0;
          maybeFinish(room);
        }
        return;
      }
    }
  });

  ws.on('close', () => {
    if (!ws.key) return;
    leaveRoom(ws);
    if (online.get(ws.key) === ws) {
      online.delete(ws.key);
      notifyFriends(ws.key);
    }
  });
});

server.listen(PORT, () => console.log('Tilewise sunucusu çalışıyor, port ' + PORT));
