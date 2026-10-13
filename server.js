const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const rooms = new Map();
const CATEGORIES = ['Girl name', 'Boy name', 'Fruit', 'Vegetable', 'Car', 'Brand', 'Country', 'Animal'];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const ROUND_MS = 90000;
const STOP_MS = 10000;

function cleanName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}
function cleanAnswer(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 70);
}
function makeCode() {
  let code;
  do { code = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); }
  while (rooms.has(code));
  return code;
}
function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    letter: room.letter,
    usedLetters: room.usedLetters,
    categories: CATEGORIES,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, connected: p.connected, submitted: Boolean(room.answers[p.id]) })),
    hostId: room.hostId,
    chooserId: room.chooserId,
    endsAt: room.endsAt,
    results: room.phase === 'results' ? room.results : null
  };
}
function broadcast(room) { io.to(room.code).emit('room:state', publicState(room)); }
function clearRoundTimer(room) { if (room.timer) clearTimeout(room.timer); room.timer = null; }
function finishRound(room) {
  if (room.phase !== 'playing') return;
  clearRoundTimer(room);
  const p1 = room.players[0];
  const p2 = room.players[1];
  const rows = CATEGORIES.map(category => {
    const a = cleanAnswer(room.answers[p1.id]?.[category]);
    const b = cleanAnswer(room.answers[p2.id]?.[category]);
    const validA = a.length > 0 && a[0].toUpperCase() === room.letter;
    const validB = b.length > 0 && b[0].toUpperCase() === room.letter;
    const same = validA && validB && a.toLocaleLowerCase() === b.toLocaleLowerCase();
    const pointsA = validA ? (same ? 5 : 10) : 0;
    const pointsB = validB ? (same ? 5 : 10) : 0;
    p1.score += pointsA;
    p2.score += pointsB;
    return { category, answers: { [p1.id]: a, [p2.id]: b }, points: { [p1.id]: pointsA, [p2.id]: pointsB } };
  });
  room.results = rows;
  room.phase = 'results';
  room.endsAt = null;
  broadcast(room);
}
function scheduleFinish(room, duration) {
  clearRoundTimer(room);
  room.endsAt = Date.now() + duration;
  room.timer = setTimeout(() => finishRound(room), duration);
}
function error(socket, message) { socket.emit('game:error', message); }
function getRoom(socket) {
  const room = rooms.get(socket.data.code);
  if (!room || !room.players.some(p => p.id === socket.data.playerId)) return null;
  return room;
}
function joinRoom(socket, room, player) {
  socket.join(room.code);
  socket.data.code = room.code;
  socket.data.playerId = player.id;
  player.connected = true;
  player.socketId = socket.id;
  socket.emit('room:joined', { code: room.code, playerId: player.id, token: player.token });
  broadcast(room);
}

io.on('connection', socket => {
  socket.on('room:create', ({ name } = {}) => {
    const playerName = cleanName(name);
    if (!playerName) return error(socket, 'Please enter your name.');
    if (socket.data.code) return error(socket, 'You are already in a room.');
    const code = makeCode();
    const player = { id: crypto.randomUUID(), token: crypto.randomBytes(24).toString('hex'), name: playerName, score: 0, connected: true };
    const room = { code, players: [player], hostId: player.id, chooserId: player.id, phase: 'waiting', round: 0, letter: null, usedLetters: [], answers: {}, results: null, endsAt: null, timer: null };
    rooms.set(code, room);
    joinRoom(socket, room, player);
  });

  socket.on('room:join', ({ code, name } = {}) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    const playerName = cleanName(name);
    if (!room) return error(socket, 'Room not found. Check the code.');
    if (!playerName) return error(socket, 'Please enter your name.');
    if (socket.data.code) return error(socket, 'You are already in a room.');
    if (room.players.length >= 2) return error(socket, 'This room already has two players.');
    const player = { id: crypto.randomUUID(), token: crypto.randomBytes(24).toString('hex'), name: playerName, score: 0, connected: true };
    room.players.push(player);
    joinRoom(socket, room, player);
  });

  socket.on('room:resume', ({ code, token } = {}) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    const player = room?.players.find(p => p.token === token);
    if (!player) return error(socket, 'Your old room is no longer available. Create a new one.');
    if (player.socketId && player.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(player.socketId);
      if (oldSocket) { oldSocket.data.code = null; oldSocket.disconnect(true); }
    }
    joinRoom(socket, room, player);
  });

  socket.on('round:choose', ({ letter } = {}) => {
    const room = getRoom(socket);
    if (!room || room.players.length !== 2 || room.players.some(p => !p.connected)) return error(socket, 'Wait until both players are connected.');
    if (!['waiting', 'results', 'choosing'].includes(room.phase)) return;
    if (socket.data.playerId !== room.chooserId) return error(socket, 'It is your partner’s turn to choose.');
    if (room.phase !== 'choosing') {
      room.phase = 'choosing';
      room.results = null;
      broadcast(room);
    }
    const chosen = String(letter || '').toUpperCase();
    if (!LETTERS.includes(chosen) || room.usedLetters.includes(chosen)) return error(socket, 'Choose an unused mystery tile.');
    room.usedLetters.push(chosen);
    room.letter = chosen;
    room.round++;
    room.answers = {};
    room.phase = 'playing';
    scheduleFinish(room, ROUND_MS);
    broadcast(room);
  });

  socket.on('round:submit', ({ answers } = {}) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'playing' || room.answers[socket.data.playerId]) return;
    const sanitized = {};
    for (const category of CATEGORIES) sanitized[category] = cleanAnswer(answers?.[category]);
    room.answers[socket.data.playerId] = sanitized;
    broadcast(room);
    if (room.players.every(p => room.answers[p.id])) finishRound(room);
  });

  socket.on('round:stop', () => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'playing' || room.answers[socket.data.playerId]) return;
    const remaining = room.endsAt - Date.now();
    if (remaining > STOP_MS) { scheduleFinish(room, STOP_MS); broadcast(room); }
  });

  socket.on('round:next', () => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'results') return;
    if (socket.data.playerId !== room.hostId) return error(socket, 'The host starts the next round.');
    if (room.players.some(p => !p.connected)) return error(socket, 'Wait for your partner to reconnect.');
    room.phase = 'choosing';
    room.letter = null;
    room.results = null;
    room.answers = {};
    room.chooserId = room.players.find(p => p.id !== room.chooserId)?.id || room.hostId;
    if (room.usedLetters.length === LETTERS.length) room.usedLetters = [];
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.data.playerId);
    if (player.socketId !== socket.id) return;
    player.connected = false;
    broadcast(room);
    if (room.players.every(p => !p.connected)) {
      // Keep disconnected rooms briefly so either player can refresh/reconnect.
      setTimeout(() => {
        if (room.players.every(p => !p.connected) && rooms.get(room.code) === room) {
          clearRoundTimer(room);
          rooms.delete(room.code);
        }
      }, 30 * 60 * 1000);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`LetterUs listening on port ${PORT}`));
