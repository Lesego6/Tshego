
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
require('dotenv').config();
const createLoveFeatures = require('./love');

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
  'Animal',
  'School',
  'University or college',
  'Shop or store',
  'Restaurant or fast food',
  'City or town',
  'Food or dish',
  'Celebrity',
  'Sport',
  'Job or profession',
  'Movie or TV show'
];

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const STOP_MS = 10000;
const REVIEW_COMMENT_MAX = 500;
const HISTORY_LIMIT = 5;

const DEFAULT_SETTINGS = Object.freeze({
  roundSeconds: 180,
  categoryCount: CATEGORIES.length,
  strictFirstLetter: true
});

const SETTINGS_OPTIONS = Object.freeze({
  roundSeconds: [60, 120, 180, 240, 300],
  categoryCount: [8, 12, CATEGORIES.length]
});

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

function cleanReviewComment(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, REVIEW_COMMENT_MAX);
}

function defaultSettings() {
  return {
    ...DEFAULT_SETTINGS
  };
}

function optionValue(value, options, fallback) {
  const parsed = Number(value);

  return options.includes(parsed)
    ? parsed
    : fallback;
}

function cleanSettings(current, incoming = {}) {
  incoming = incoming || {};

  const settings = {
    ...defaultSettings(),
    ...(current || {})
  };

  return {
    roundSeconds: optionValue(
      incoming.roundSeconds,
      SETTINGS_OPTIONS.roundSeconds,
      settings.roundSeconds
    ),
    categoryCount: optionValue(
      incoming.categoryCount,
      SETTINGS_OPTIONS.categoryCount,
      settings.categoryCount
    ),
    strictFirstLetter:
      typeof incoming.strictFirstLetter === 'boolean'
        ? incoming.strictFirstLetter
        : settings.strictFirstLetter
  };
}

function activeCategories(room) {
  const settings = cleanSettings(room.settings);

  return CATEGORIES.slice(0, settings.categoryCount);
}

function currentRoundCategories(room) {
  return room.roundCategories || activeCategories(room);
}

function isValidAnswer(answer, room) {
  if (!answer.length) {
    return false;
  }

  if (!cleanSettings(room.settings).strictFirstLetter) {
    return true;
  }

  return answer[0].toUpperCase() === room.letter;
}

function roundTotals(room) {
  const totals = {};

  for (const player of room.players) {
    totals[player.id] = room.results.reduce(
      (sum, row) => sum + (row.points[player.id] || 0),
      0
    );
  }

  return totals;
}

function historyEntry(room) {
  const totals = roundTotals(room);
  const highScore = Math.max(
    ...Object.values(totals)
  );

  return {
    round: room.round,
    letter: room.letter,
    settings: cleanSettings(room.settings),
    players: room.players.map(player => ({
      id: player.id,
      name: player.name
    })),
    totals,
    winnerIds: room.players
      .filter(player => totals[player.id] === highScore)
      .map(player => player.id),
    rows: room.results.map(row => ({
      category: row.category,
      answers: {
        ...row.answers
      },
      points: {
        ...row.points
      },
      challenges: Object.fromEntries(
        Object.entries(row.challenges).map(
          ([targetId, challenge]) => [
            targetId,
            {
              by: challenge.by,
              status: challenge.status
            }
          ]
        )
      )
    }))
  };
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
    categories: currentRoundCategories(room),
    settings: cleanSettings(room.settings),
    settingsOptions: SETTINGS_OPTIONS,
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
    finalized: Boolean(room.finalized),
    history: room.history || []
  };
}

function broadcast(room) {
  io.to(room.code).emit('room:state', publicState(room));
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

function clearRoundTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
  }

  room.timer = null;
}

function scheduleFinish(room, duration) {
  clearRoundTimer(room);

  room.endsAt = Date.now() + duration;

  room.timer = setTimeout(() => {
    finishRound(room);
  }, duration);
}

// The server chooses a secret random letter.
// Previously played letters cannot repeat until all 26 are used.
function chooseRandomLetter(room) {
  if (room.usedLetters.length >= LETTERS.length) {
    room.usedLetters = [];
  }

  const available = LETTERS.filter(
    letter => !room.usedLetters.includes(letter)
  );

  const index = crypto.randomInt(available.length);
  const chosen = available[index];

  room.usedLetters.push(chosen);

  return chosen;
}

function finishRound(room) {
  if (room.phase !== 'playing') return;

  clearRoundTimer(room);

  const [first, second] = room.players;

  // Use saved answers when a player has not pressed Submit.
  for (const player of room.players) {
    if (!room.answers[player.id]) {
      room.answers[player.id] = {
        ...(room.drafts[player.id] || {})
      };
    }
  }

  const categories = currentRoundCategories(room);

  room.results = categories.map(category => {
    const a = cleanAnswer(
      room.answers[first.id]?.[category]
    );

    const b = cleanAnswer(
      room.answers[second.id]?.[category]
    );

    const validA = isValidAnswer(a, room);
    const validB = isValidAnswer(b, room);

    const same =
      validA &&
      validB &&
      a.toLocaleLowerCase() === b.toLocaleLowerCase();

    const pointsA = validA ? (same ? 5 : 10) : 0;
    const pointsB = validB ? (same ? 5 : 10) : 0;

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

  room.phase = 'results';
  room.reviewReady = {};
  room.finalized = false;
  room.endsAt = null;

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

  // CREATE ROOM
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
      drafts: {},
      results: null,
      reviewReady: {},
      settings: defaultSettings(),
      roundCategories: null,
      history: [],
      finalized: false,
      endsAt: null,
      timer: null
    };

    rooms.set(code, room);
    joinRoom(socket, room, player);
  });

  // JOIN ROOM
  socket.on('room:join', ({ code, name } = {}) => {
    const roomCode = String(code || '')
      .trim()
      .toUpperCase();

    const room = rooms.get(roomCode);
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

  // ROOM SETTINGS
  socket.on('settings:update', settings => {
    const room = getRoom(socket);

    if (!room) return;

    if (socket.data.playerId !== room.hostId) {
      return sendError(
        socket,
        'Only the host can change room settings.'
      );
    }

    if (!['waiting', 'choosing'].includes(room.phase)) {
      return sendError(
        socket,
        'Settings can change before a round starts.'
      );
    }

    room.settings = cleanSettings(
      room.settings,
      settings
    );

    broadcast(room);
  });

  // RECONNECT TO ROOM
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

  // RANDOM MYSTERY LETTER
  socket.on('round:choose', ({ tile } = {}) => {
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

    if (
      !Number.isInteger(tile) ||
      tile < 0 ||
      tile >= 26
    ) {
      return sendError(socket, 'Choose a mystery tile.');
    }

    // The tile number is only a selection.
    // It does not reveal or determine a fixed letter.
    const chosen = chooseRandomLetter(room);

    room.letter = chosen;
    room.round++;
    room.roundCategories = activeCategories(room);
    room.answers = {};
    room.drafts = {};
    room.results = null;
    room.reviewReady = {};
    room.finalized = false;
    room.phase = 'playing';

    scheduleFinish(
      room,
      cleanSettings(room.settings).roundSeconds * 1000
    );
    broadcast(room);
  });

  // AUTOMATIC ANSWER SAVING
  socket.on('round:draft', ({ round, answers } = {}) => {
    const room = getRoom(socket);

    if (
      !room ||
      room.phase !== 'playing' ||
      room.round !== round ||
      Date.now() >= room.endsAt ||
      room.answers[socket.data.playerId]
    ) {
      return;
    }

    if (
      !answers ||
      typeof answers !== 'object' ||
      Array.isArray(answers)
    ) {
      return;
    }

    const draft = room.drafts[socket.data.playerId] || {};

    for (const category of currentRoundCategories(room)) {
      if (
        Object.prototype.hasOwnProperty.call(
          answers,
          category
        )
      ) {
        draft[category] = cleanAnswer(answers[category]);
      }
    }

    room.drafts[socket.data.playerId] = draft;
  });

  // SUBMIT ANSWERS EARLY
  socket.on('round:submit', ({ answers } = {}) => {
    const room = getRoom(socket);

    if (
      !room ||
      room.phase !== 'playing' ||
      room.answers[socket.data.playerId] ||
      Date.now() >= room.endsAt
    ) {
      return;
    }

    const sanitized = {};

    for (const category of currentRoundCategories(room)) {
      sanitized[category] = cleanAnswer(
        answers?.[category]
      );
    }

    room.answers[socket.data.playerId] = sanitized;
    room.drafts[socket.data.playerId] = sanitized;

    broadcast(room);

    if (
      room.players.length === 2 &&
      room.players.every(
        player => room.answers[player.id]
      )
    ) {
      finishRound(room);
    }
  });

  // STOP COUNTDOWN
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

  // FLAG AN ANSWER
  socket.on(
    'review:flag',
    ({ category, targetId, reason } = {}) => {
      const room = getRoom(socket);

      if (
        !room ||
        room.phase !== 'results' ||
        room.finalized
      ) {
        return;
      }

      const reviewerId = socket.data.playerId;
      const cleanReason = cleanReviewComment(reason);

      if (!cleanReason) {
        return sendError(
          socket,
          'Add a reason for the flag.'
        );
      }

      if (room.reviewReady[reviewerId]) {
        return sendError(
          socket,
          'Undo your confirmation before flagging.'
        );
      }

      if (
        targetId === reviewerId ||
        !room.players.some(
          player => player.id === targetId
        )
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
        reason: cleanReason,
        response: '',
        status: 'pending'
      };

      room.reviewReady = {};
      broadcast(room);
    }
  );

  // ACCEPT OR DISPUTE A FLAG
  socket.on(
    'review:respond',
    ({ category, decision, response } = {}) => {
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

      const challenge =
        row?.challenges[socket.data.playerId];

      if (
        !challenge ||
        challenge.status !== 'pending'
      ) {
        return;
      }

      if (decision === 'accept') {
        challenge.status = 'accepted';
        row.points[socket.data.playerId] = 0;
      } else if (decision === 'dispute') {
        const cleanResponse = cleanReviewComment(response);

        if (!cleanResponse) {
          return sendError(
            socket,
            'Add an explanation before disputing.'
          );
        }

        challenge.response = cleanResponse;
        challenge.status = 'disputed';
      } else {
        return;
      }

      room.reviewReady = {};
      broadcast(room);
    }
  );

  // RESOLVE DISPUTE
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

      if (
        !challenge ||
        challenge.status !== 'disputed'
      ) {
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

  // BOTH PLAYERS CONFIRM SCORES
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
      room.players.every(
        player => room.reviewReady[player.id]
      )
    ) {
      for (const row of room.results) {
        for (const player of room.players) {
          player.score += row.points[player.id];
        }
      }

      room.history = [
        ...(room.history || []),
        historyEntry(room)
      ].slice(-HISTORY_LIMIT);

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

  // NEXT ROUND
  socket.on('round:next', () => {
    const room = getRoom(socket);

    if (
      !room ||
      room.phase !== 'results'
    ) {
      return;
    }

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

    if (
      room.players.some(player => !player.connected)
    ) {
      return sendError(
        socket,
        'Wait for your partner to reconnect.'
      );
    }

    room.phase = 'choosing';
    room.letter = null;
    room.roundCategories = null;
    room.answers = {};
    room.drafts = {};
    room.results = null;
    room.reviewReady = {};
    room.finalized = false;

    room.chooserId = room.players.find(
      player => player.id !== room.chooserId
    )?.id || room.hostId;

    broadcast(room);
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const room = getRoom(socket);

    if (!room) return;

    const player = room.players.find(
      player => player.id === socket.data.playerId
    );

    player.connected = false;
    broadcast(room);

    if (
      room.players.every(player => !player.connected)
    ) {
      setTimeout(() => {
        if (
          room.players.every(
            player => !player.connected
          ) &&
          rooms.get(room.code) === room
        ) {
          clearRoundTimer(room);
          rooms.delete(room.code);
        }
      }, 30 * 60 * 1000);
    }
  });
});

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Configure Neon PostgreSQL.');
  process.exit(1);
}
createLoveFeatures(app, io).then(() => {
  server.listen(PORT, '0.0.0.0', () => console.log(`LetterUs listening on port ${PORT}`));
}).catch(error => { console.error('Database initialization failed:', error); process.exit(1); });
