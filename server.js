
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const rooms = new Map();

const CATEGORIES = [
  'Girl name',
  'Boy name',
  'Fruit',
  'Vegetable',
  'Car',
  'Brand',
  'Country',
  'Animal'
];

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const ROUND_MS = 90000;
const STOP_MS = 10000;

function cleanName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 24);
}

function cleanAnswer(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 70);
}

function makeCode() {
  let code;

  do {
    code = crypto.randomBytes(4)
      .toString('hex')
      .slice(0, 6)
      .toUpperCase();
  } while (rooms.has(code));

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
    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      score: player.score,
      connected: player.connected,
      submitted: Boolean(room.answers[player.id])
    })),
    hostId: room.hostId,
    chooserId: room.chooserId,
    endsAt: room.endsAt,
    results: room.phase === 'results'
      ? room.results
      : null,
    reviewReady: room.reviewReady || {},
    finalized: Boolean(room.finalized)
  };
}

function broadcast(room) {
  io.to(room.code).emit('room:state', publicState(room));
}

function clearRoundTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function finishRound(room) {
  if (room.phase !== 'playing') return;

  clearRoundTimer(room);

  const [first, second] = room.players;

  const rows = CATEGORIES.map(category => {
    const a = cleanAnswer(
      room.answers[first.id]?.[category]
    );

    const b = cleanAnswer(
      room.answers[second.id]?.[category]
    );

    const validA =
      a.length > 0 &&
      a[0].toUpperCase() === room.letter;

    const validB =
      b.length > 0 &&
      b[0].toUpperCase() === room.letter;

    const same =
      validA &&
      validB &&
      a.toLocaleLowerCase() === b.toLocaleLowerCase();

    const pointsA = validA
      ? same ? 5 : 10
      : 0;

    const pointsB = validB
      ? same ? 5 : 10
      : 0;

    return {
      category,
      answers: {
        [first.id]: a,
        [second.id]: b
      },
      points: {
        [first.id]: pointsA,
        [second.id]: pointsB
      },
      basePoints: {
        [first.id]: pointsA,
        [second.id]: pointsB
      },
      challenges: {}
    };
  });

  room.results = rows;
  room.phase = 'results';
  room.reviewReady = {};
  room.finalized = false;
  room.endsAt = null;

  broadcast(room);
}

function scheduleFinish(room, duration) {
  clearRoundTimer(room);

  room.endsAt = Date.now() + duration;

  room.timer = setTimeout(() => {
    finishRound(room);
  }, duration);
}

function sendError(socket, message) {
  socket.emit('game:error', message);
}

function getRoom(socket) {
  const room = rooms.get(socket.data.code);

  if (!room) return null;

  const player = room.players.find(
    player => player.id === socket.data.playerId
  );

  if (!player || player.socketId !== socket.id) {
    return null;
  }

  return room;
}

function joinRoom(socket, room, player) {
  socket.join(room.code);

  socket.data.code = room.code;
  socket.data.playerId = player.id;

  player.connected = true;
  player.socketId = socket.id;

  socket.emit('room:joined', {
    code: room.code,
    playerId: player.id,
    token: player.token
  });

  broadcast(room);
}

function hasUnresolvedChallenges(room) {
  return room.results.some(row =>
    Object.values(row.challenges).some(challenge =>
      challenge.status === 'pending' ||
      challenge.status === 'disputed'
    )
  );
}

io.on('connection', socket => {

  socket.on('room:create', ({ name } = {}) => {
    const playerName = cleanName(name);

    if (!playerName) {
      return sendError(socket, 'Please enter your name.');
    }

    if (socket.data.code) {
      return sendError(socket, 'You are already in a room.');
    }

    const code = makeCode();

    const player = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString('hex'),
      name: playerName,
      score: 0,
      connected: true
    };

    const room = {
      code,
      players: [player],
      hostId: player.id,
      chooserId: player.id,
      phase: 'waiting',
      round: 0,
      letter: null,
      usedLetters: [],
      answers: {},
      results: null,
      reviewReady: {},
      finalized: false,
      endsAt: null,
      timer: null
    };

    rooms.set(code, room);
    joinRoom(socket, room, player);
  });

  socket.on('room:join', ({ code, name } = {}) => {
    const room = rooms.get(
      String(code || '').trim().toUpperCase()
    );

    const playerName = cleanName(name);

    if (!room) {
      return sendError(socket, 'Room not found. Check the code.');
    }

    if (!playerName) {
      return sendError(socket, 'Please enter your name.');
    }

    if (socket.data.code) {
      return sendError(socket, 'You are already in a room.');
    }

    if (room.players.length >= 2) {
      return sendError(socket, 'This room already has two players.');
    }

    const player = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString('hex'),
      name: playerName,
      score: 0,
      connected: true
    };

    room.players.push(player);
    joinRoom(socket, room, player);
  });

  socket.on('room:resume', ({ code, token } = {}) => {
    const room = rooms.get(
      String(code || '').trim().toUpperCase()
    );

    const player = room?.players.find(
      player => player.token === token
    );

    if (!player) {
      return sendError(
        socket,
        'Your old room is no longer available. Create a new one.'
      );
    }

    if (player.socketId && player.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(player.socketId);

      if (oldSocket) {
        oldSocket.data.code = null;
        oldSocket.disconnect(true);
      }
    }

    joinRoom(socket, room, player);
  });

  socket.on('round:choose', ({ letter } = {}) => {
    const room = getRoom(socket);
    if (!room) return;

    if (
      room.players.length !== 2 ||
      room.players.some(player => !player.connected)
    ) {
      return sendError(
        socket,
        'Wait until both players are connected.'
      );
    }

    if (!['waiting', 'choosing'].includes(room.phase)) {
      return;
    }

    if (socket.data.playerId !== room.chooserId) {
      return sendError(
        socket,
        "It is your partner's turn to choose."
      );
    }

    const chosen = String(letter || '').toUpperCase();

    if (
      !LETTERS.includes(chosen) ||
      room.usedLetters.includes(chosen)
    ) {
      return sendError(
        socket,
        'Choose an unused mystery tile.'
      );
    }

    room.usedLetters.push(chosen);
    room.letter = chosen;
    room.round++;
    room.answers = {};
    room.results = null;
    room.phase = 'playing';
    room.reviewReady = {};
    room.finalized = false;

    scheduleFinish(room, ROUND_MS);
    broadcast(room);
  });

  socket.on('round:submit', ({ answers } = {}) => {
    const room = getRoom(socket);

    if (
      !room ||
      room.phase !== 'playing' ||
      room.answers[socket.data.playerId]
    ) {
      return;
    }

    const sanitized = {};

    for (const category of CATEGORIES) {
      sanitized[category] = cleanAnswer(answers?.[category]);
    }

    room.answers[socket.data.playerId] = sanitized;

    broadcast(room);

    if (
      room.players.length === 2 &&
      room.players.every(player => room.answers[player.id])
    ) {
      finishRound(room);
    }
  });

  socket.on('round:stop', () => {
    const room = getRoom(socket);

    if (
      !room ||
      room.phase !== 'playing' ||
      room.answers[socket.data.playerId]
    ) {
      return;
    }

    const remaining = room.endsAt - Date.now();

    if (remaining > STOP_MS) {
      scheduleFinish(room, STOP_MS);
      broadcast(room);
    }
  });

  // Player flags their partner's answer.
  socket.on('review:flag', ({ category, targetId } = {}) => {
    const room = getRoom(socket);

    if (
      !room ||
      room.phase !== 'results' ||
      room.finalized
    ) {
      return;
    }

    const reviewerId = socket.data.playerId;

    if (room.reviewReady[reviewerId]) {
      return sendError(
        socket,
        'Undo your review confirmation before flagging.'
      );
    }

    if (
      targetId === reviewerId ||
      !room.players.some(player => player.id === targetId)
    ) {
      return;
    }

    const row = room.results.find(
      row => row.category === category
    );

    if (
      !row ||
      !row.basePoints[targetId] ||
      row.challenges[targetId]
    ) {
      return;
    }

    row.challenges[targetId] = {
      by: reviewerId,
      status: 'pending'
    };

    room.reviewReady = {};
    broadcast(room);
  });

  // Author accepts or disputes a flag.
  socket.on('review:respond', ({ category, decision } = {}) => {
    const room = getRoom(socket);

    if (
      !room ||
      room.phase !== 'results' ||
      room.finalized
    ) {
      return;
    }

    const row = room.results.find(
      row => row.category === category
    );

    const challenge = row?.challenges[socket.data.playerId];

    if (!challenge || challenge.status !== 'pending') {
      return;
    }

    if (decision === 'accept') {
      challenge.status = 'accepted';
      row.points[socket.data.playerId] = 0;
    } else if (decision === 'dispute') {
      challenge.status = 'disputed';
    } else {
      return;
    }

    room.reviewReady = {};
    broadcast(room);
  });

  // Resolve disputed answers by agreement.
  socket.on(
    'review:resolve',
    ({ category, targetId, decision } = {}) => {
      const room = getRoom(socket);

      if (
        !room ||
        room.phase !== 'results' ||
        room.finalized
      ) {
        return;
      }

      const row = room.results.find(
        row => row.category === category
      );

      const challenge = row?.challenges[targetId];

      if (!challenge || challenge.status !== 'disputed') {
        return;
      }

      if (
        decision === 'withdraw' &&
        socket.data.playerId === challenge.by
      ) {
        challenge.status = 'withdrawn';
      } else if (
        decision === 'concede' &&
        socket.data.playerId === targetId
      ) {
        challenge.status = 'accepted';
        row.points[targetId] = 0;
      } else {
        return;
      }

      room.reviewReady = {};
      broadcast(room);
    }
  );

  // Both players must confirm before points are added.
  socket.on('review:confirm', () => {
    const room = getRoom(socket);

    if (
      !room ||
      room.phase !== 'results' ||
      room.finalized
    ) {
      return;
    }

    if (hasUnresolvedChallenges(room)) {
      return sendError(
        socket,
        'Resolve all challenges before confirming.'
      );
    }

    room.reviewReady[socket.data.playerId] = true;

    if (
      room.players.length === 2 &&
      room.players.every(player => room.reviewReady[player.id])
    ) {
      for (const row of room.results) {
        for (const player of room.players) {
          player.score += row.points[player.id];
        }
      }

      room.finalized = true;
    }

    broadcast(room);
  });

  socket.on('review:unconfirm', () => {
    const room = getRoom(socket);

    if (
      !room ||
      room.phase !== 'results' ||
      room.finalized
    ) {
      return;
    }

    delete room.reviewReady[socket.data.playerId];
    broadcast(room);
  });

  socket.on('round:next', () => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'results') return;

    if (!room.finalized) {
      return sendError(
        socket,
        'Both players must finish reviewing first.'
      );
    }

    if (socket.data.playerId !== room.hostId) {
      return sendError(
        socket,
        'The host starts the next round.'
      );
    }

    if (room.players.some(player => !player.connected)) {
      return sendError(
        socket,
        'Wait for your partner to reconnect.'
      );
    }

    room.phase = 'choosing';
    room.letter = null;
    room.results = null;
    room.answers = {};
    room.reviewReady = {};
    room.finalized = false;

    room.chooserId = room.players.find(
      player => player.id !== room.chooserId
    )?.id || room.hostId;

    if (room.usedLetters.length === LETTERS.length) {
      room.usedLetters = [];
    }

    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket);
    if (!room) return;

    const player = room.players.find(
      player => player.id === socket.data.playerId
    );

    player.connected = false;
    broadcast(room);

    if (room.players.every(player => !player.connected)) {
      setTimeout(() => {
        if (
          room.players.every(player => !player.connected) &&
          rooms.get(room.code) === room
        ) {
          clearRoundTimer(room);
          rooms.delete(room.code);
        }
      }, 30 * 60 * 1000);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`LetterUs listening on port ${PORT}`);
});
