// Tilewise düello sunucusu: 5 haneli oda kodu ile iki oyuncuyu eşleştirir ve mesajları iletir.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ROOM_TTL_MS = 30 * 60 * 1000; // 30 dakika sonra eski odalar silinir
const rooms = new Map(); // code -> { players: [ws], seed, t }

function newCode() {
  let c;
  do { c = String(Math.floor(10000 + Math.random() * 90000)); } while (rooms.has(c));
  return c;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Tilewise duel server ok');
});

const wss = new WebSocketServer({ server });

function send(ws, o) {
  if (ws.readyState === 1) ws.send(JSON.stringify(o));
}

wss.on('connection', ws => {
  ws.room = null;

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === 'create') {
      if (ws.room) return;
      const code = newCode();
      const seed = Math.floor(Math.random() * 2e9);
      rooms.set(code, { players: [ws], seed, t: Date.now() });
      ws.room = code;
      send(ws, { t: 'created', code, seed });
    } else if (m.t === 'join') {
      if (ws.room) return;
      const code = String(m.code || '');
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'error', msg: 'Oda bulunamadı. Kodu kontrol et.' });
      if (room.players.length >= 2) return send(ws, { t: 'error', msg: 'Oda dolu.' });
      room.players.push(ws);
      ws.room = code;
      send(ws, { t: 'joined', code, seed: room.seed });
      send(room.players[0], { t: 'opponent_joined' });
    } else if (m.t === 'relay') {
      const room = rooms.get(ws.room);
      if (!room) return;
      room.players.forEach(p => { if (p !== ws) send(p, { t: 'relay', data: m.data }); });
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.room);
    if (!room) return;
    room.players = room.players.filter(p => p !== ws);
    room.players.forEach(p => send(p, { t: 'opponent_left' }));
    if (room.players.length === 0) rooms.delete(ws.room);
  });
});

// Süresi dolan odaları temizle
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.t > ROOM_TTL_MS) {
      room.players.forEach(p => send(p, { t: 'error', msg: 'Oda zaman aşımına uğradı.' }));
      rooms.delete(code);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => console.log('Tilewise düello sunucusu çalışıyor, port ' + PORT));
