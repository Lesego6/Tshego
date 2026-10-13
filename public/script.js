
const socket = io();

const $ = id => document.getElementById(id);

const screens = [
  'waiting',
  'choosing',
  'playing',
  'results'
];

let me = null;
let state = null;
let previousRound = 0;
let currentDraft = {};
let timerHandle = null;
let choosingLocked = false;

function notice(message) {
  $('notice').textContent = message;

  clearTimeout(notice.timeout);

  notice.timeout = setTimeout(() => {
    $('notice').textContent = '';
  }, 6000);
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character])
  );
}

function showScreen(name) {
  $('home').hidden = Boolean(name);
  $('game').hidden = !name;

  screens.forEach(screen => {
    $(screen).hidden = screen !== name;
  });
}

function saveSession(data) {
  sessionStorage.setItem(
    'letterus-session',
    JSON.stringify(data)
  );
}

function session() {
  try {
    return JSON.parse(
      sessionStorage.getItem('letterus-session')
    );
  } catch {
    return null;
  }
}

function joinOrCreate(type) {
  const name = $('name').value.trim();
  const code = $('code').value.trim().toUpperCase();

  if (!name) {
    return notice('Enter your name first, love.');
  }

  if (
    type === 'join' &&
    !/^[A-Z0-9]{6}$/.test(code)
  ) {
    return notice('Enter the six-character room code.');
  }

  socket.emit(
    type === 'join'
      ? 'room:join'
      : 'room:create',
    { name, code }
  );
}

$('create').addEventListener('click', () => {
  joinOrCreate('create');
});

$('join').addEventListener('click', () => {
  joinOrCreate('join');
});

$('copy').addEventListener('click', async () => {
  if (!state) return;

  const link =
    `${location.origin}/?room=${encodeURIComponent(state.code)}`;

  try {
    await navigator.clipboard.writeText(link);
    notice('Invite link copied! Send it to your girl ♡');
  } catch {
    notice(`Share this link: ${link}`);
  }
});

$('stop').addEventListener('click', () => {
  socket.emit('round:stop');
});

$('next').addEventListener('click', () => {
  socket.emit('round:next');
});

// COLLECT ALL CURRENT ANSWERS
function collectAnswers() {
  const answers = {};

  if (!state) return answers;

  state.categories.forEach((category, index) => {
    const input = $(`answer-${index}`);

    answers[category] = input
      ? input.value
      : currentDraft[category] || '';
  });

  return answers;
}

// AUTOMATIC ANSWER SAVING
$('fields').addEventListener('input', event => {
  if (
    !state ||
    state.phase !== 'playing' ||
    !me
  ) {
    return;
  }

  const input = event.target.closest(
    'input[data-category]'
  );

  if (!input) return;

  const mine = state.players.find(
    player => player.id === me
  );

  if (mine?.submitted) return;

  const category = input.dataset.category;

  currentDraft[category] = input.value;

  socket.emit('round:draft', {
    round: state.round,
    answers: {
      [category]: input.value
    }
  });
});

// MANUAL EARLY SUBMISSION
$('answers-form').addEventListener('submit', event => {
  event.preventDefault();

  if (
    !state ||
    state.phase !== 'playing'
  ) {
    return;
  }

  const mine = state.players.find(
    player => player.id === me
  );

  if (mine?.submitted) return;

  const answers = collectAnswers();

  currentDraft = answers;

  socket.emit('round:submit', {
    answers
  });
});

// PLAYER SCORES
function renderScores() {
  $('scores').innerHTML = state.players.map(player => `
    <div class="score">
      <span>
        ${escapeHtml(player.name)}
        ${player.id === me ? '(you)' : ''}
        ${player.connected ? '' : '· offline'}
      </span>

      <strong>${player.score}</strong>

      <span>points</span>
    </div>
  `).join('');
}

// RANDOM MYSTERY TILES
function renderChoosing() {
  $('round-label').textContent =
    `ROUND ${state.round + 1}`;

  const myTurn = state.chooserId === me;

  const bothConnected =
    state.players.length === 2 &&
    state.players.every(player => player.connected);

  $('choose-instruction').textContent = myTurn
    ? 'Choose any mystery tile! Your letter is a surprise ♡'
    : 'Your person is choosing a mystery letter ♡';

  $('alphabet').innerHTML = '';

  for (let index = 0; index < 26; index++) {
    const tile = document.createElement('button');

    tile.type = 'button';
    tile.className = 'tile';
    tile.textContent = '?';

    tile.disabled =
      !myTurn ||
      !bothConnected ||
      choosingLocked;

    tile.addEventListener('click', () => {
      if (choosingLocked) return;

      choosingLocked = true;

      $('alphabet')
        .querySelectorAll('button')
        .forEach(button => {
          button.disabled = true;
        });

      socket.emit('round:choose', {
        tile: index
      });
    });

    $('alphabet').appendChild(tile);
  }
}

// COUNTDOWN
function updateTimer() {
  if (
    !state ||
    state.phase !== 'playing'
  ) {
    return;
  }

  const remaining = Math.max(
    0,
    Math.ceil(
      (state.endsAt - Date.now()) / 1000
    )
  );

  const minutes = String(
    Math.floor(remaining / 60)
  ).padStart(2, '0');

  const seconds = String(
    remaining % 60
  ).padStart(2, '0');

  $('timer').textContent =
    `${minutes}:${seconds}`;

  const mine = state.players.find(
    player => player.id === me
  );

  if (
    remaining === 0 &&
    !mine?.submitted
  ) {
    $('play-status').textContent =
      'Time is up! Your saved answers are being collected ♡';
  }
}

// PLAYING SCREEN
function renderPlaying() {
  $('play-round').textContent =
    `ROUND ${state.round}`;

  $('letter').textContent = state.letter;

  const mine = state.players.find(
    player => player.id === me
  );

  const submitted = Boolean(mine?.submitted);

  $('fields').innerHTML = state.categories.map(
    (category, index) => `
      <div>
        <label for="answer-${index}">
          ${escapeHtml(category)}
        </label>

        <input
          id="answer-${index}"
          data-category="${escapeHtml(category)}"
          maxlength="70"
          autocomplete="off"
          placeholder="Starts with ${escapeHtml(state.letter)}"
          value="${escapeHtml(currentDraft[category] || '')}"
          ${submitted ? 'disabled' : ''}
        >
      </div>
    `
  ).join('');

  $('submit').disabled = submitted;
  $('stop').disabled = submitted;

  $('play-status').textContent = submitted
    ? 'Answers sent! Waiting for your person ♡'
    : 'Your answers save automatically as you type ♡';

  clearInterval(timerHandle);

  updateTimer();

  timerHandle = setInterval(
    updateTimer,
    250
  );
}

// REVIEW SCREEN
function renderResults() {
  const [first, second] = state.players;

  const other = state.players.find(
    player => player.id !== me
  );

  const ready = Boolean(
    state.reviewReady?.[me]
  );

  const unresolved = (
    state.results || []
  ).some(row =>
    Object.values(
      row.challenges || {}
    ).some(challenge =>
      challenge.status === 'pending' ||
      challenge.status === 'disputed'
    )
  );

  if (state.finalized) {
    $('review-status').textContent =
      'Scores finalized! Ready for another round ♡';
  } else if (unresolved) {
    $('review-status').textContent =
      'Resolve all challenges before confirming.';
  } else if (ready) {
    $('review-status').textContent =
      'Review confirmed. Waiting for your person ♡';
  } else {
    $('review-status').textContent =
      'Check each answer and flag anything incorrect.';
  }

  $('result-rows').innerHTML = (
    state.results || []
  ).map(row => {

    const answers = [
      first,
      second
    ].map(player => {

      const mine = player.id === me;

      const challenge =
        row.challenges?.[player.id];

      const points =
        row.points[player.id];

      const category =
        escapeHtml(row.category);

      let action = '';

      if (challenge?.status === 'pending') {

        if (mine) {
          action = `
            <div class="review-actions">
              <button
                type="button"
                data-action="accept"
                data-category="${category}">
                Accept flag · 0 pts
              </button>

              <button
                type="button"
                data-action="dispute"
                data-category="${category}">
                Dispute flag
              </button>
            </div>
          `;
        } else {
          action = `
            <small class="review-note">
              Flag sent · waiting for response
            </small>
          `;
        }

      } else if (
        challenge?.status === 'disputed'
      ) {

        if (mine) {
          action = `
            <div class="review-actions">
              <small class="review-note">
                You disputed this flag.
              </small>

              <button
                type="button"
                data-action="concede"
                data-category="${category}">
                Accept flag instead
              </button>
            </div>
          `;
        } else {
          action = `
            <div class="review-actions">
              <small class="review-note">
                Your person disputed the flag.
              </small>

              <button
                type="button"
                data-action="withdraw"
                data-category="${category}"
                data-target="${escapeHtml(player.id)}">
                Withdraw flag · keep points
              </button>
            </div>
          `;
        }

      } else if (
        challenge?.status === 'accepted'
      ) {

        action = `
          <small class="review-note">
            Flag accepted · 0 points
          </small>
        `;

      } else if (
        challenge?.status === 'withdrawn'
      ) {

        action = `
          <small class="review-note">
            Flag withdrawn · points kept
          </small>
        `;

      } else if (
        !mine &&
        !state.finalized &&
        !ready &&
        row.basePoints[player.id] > 0
      ) {

        action = `
          <button
            type="button"
            class="flag-button"
            data-action="flag"
            data-category="${category}"
            data-target="${escapeHtml(player.id)}">
            ⚑ Flag answer
          </button>
        `;
      }

      return `
        <div class="review-answer">

          <span class="review-name">
            ${escapeHtml(player.name)}
            ${mine ? '(you)' : ''}
          </span>

          <span class="review-value">
            ${escapeHtml(
              row.answers[player.id] || '—'
            )}
          </span>

          <b>+${points} pts</b>

          ${action}

        </div>
      `;
    }).join('');

    return `
      <div class="result-row">
        <strong>
          ${escapeHtml(row.category)}
        </strong>

        <div class="review-pair">
          ${answers}
        </div>
      </div>
    `;
  }).join('');

  $('confirm-review').hidden =
    Boolean(state.finalized);

  $('confirm-review').disabled =
    unresolved ||
    !other?.connected;

  $('confirm-review').textContent = ready
    ? 'Undo my confirmation'
    : 'Confirm my review ';

  $('next').hidden =
    state.hostId !== me;

  $('next').disabled =
    !state.finalized ||
    state.players.some(
      player => !player.connected
    );

  const confirmedCount =
    state.players.filter(
      player => state.reviewReady?.[player.id]
    ).length;

  $('next-help').textContent = state.finalized
    ? state.hostId === me
      ? 'You can start the next round ♡'
      : 'Waiting for the host to start the next round ♡'
    : `Reviews confirmed: ${confirmedCount}/2. Points are added after both confirm.`;
}

// REVIEW ACTIONS
$('result-rows').addEventListener(
  'click',
  event => {
    const button = event.target.closest(
      'button[data-action]'
    );

    if (
      !button ||
      !state ||
      state.phase !== 'results' ||
      state.finalized
    ) {
      return;
    }

    const category =
      button.dataset.category;

    const action =
      button.dataset.action;

    if (action === 'flag') {
      socket.emit('review:flag', {
        category,
        targetId: button.dataset.target
      });
    }

    if (
      action === 'accept' ||
      action === 'dispute'
    ) {
      socket.emit('review:respond', {
        category,
        decision: action
      });
    }

    if (
      action === 'withdraw' ||
      action === 'concede'
    ) {
      socket.emit('review:resolve', {
        category,
        targetId: action === 'concede'
          ? me
          : button.dataset.target,
        decision: action
      });
    }
  }
);

// CONFIRM REVIEW
$('confirm-review').addEventListener(
  'click',
  () => {
    if (
      !state ||
      state.phase !== 'results'
    ) {
      return;
    }

    socket.emit(
      state.reviewReady?.[me]
        ? 'review:unconfirm'
        : 'review:confirm'
    );
  }
);

// MAIN RENDER
function render() {
  if (!state || !me) return;

  $('room-code').textContent =
    state.code;

  renderScores();

  let screen = state.phase;

  if (
    screen === 'waiting' &&
    state.players.length === 2
  ) {
    screen = 'choosing';
  }

  if (screen === 'waiting') {
    clearInterval(timerHandle);
    showScreen('waiting');
    return;
  }

  if (
    screen === 'playing' &&
    state.round !== previousRound
  ) {
    currentDraft = {};
    previousRound = state.round;
    choosingLocked = false;
  }

  showScreen(screen);

  if (screen === 'choosing') {
    clearInterval(timerHandle);
    $('fields').innerHTML = '';
    renderChoosing();
  }

  if (screen === 'playing') {

    const needsFields =
      !$('fields').children.length ||
      $('letter').textContent !== state.letter;

    if (needsFields) {
      renderPlaying();
    } else {

      const mine = state.players.find(
        player => player.id === me
      );

      const submitted =
        Boolean(mine?.submitted);

      $('submit').disabled =
        submitted;

      $('stop').disabled =
        submitted;

      if (submitted) {
        $('play-status').textContent =
          'Answers sent! Waiting for your person ♡';

        $('fields')
          .querySelectorAll('input')
          .forEach(input => {
            input.disabled = true;
          });
      }

      clearInterval(timerHandle);
      updateTimer();

      timerHandle = setInterval(
        updateTimer,
        250
      );
    }
  }

  if (screen === 'results') {
    clearInterval(timerHandle);
    $('fields').innerHTML = '';
    renderResults();
  }
}

// SOCKET EVENTS
socket.on('connect', () => {
  const saved = session();

  if (
    saved?.code &&
    saved?.token
  ) {
    socket.emit('room:resume', saved);
  }
});

socket.on('room:joined', data => {
  me = data.playerId;

  saveSession({
    code: data.code,
    token: data.token
  });
});

socket.on('room:state', incoming => {
  state = incoming;
  render();
});

socket.on('game:error', message => {
  if (message.includes('old room')) {
    sessionStorage.removeItem(
      'letterus-session'
    );

    me = null;
    state = null;
    showScreen(null);
  }

  if (message.includes('mystery tile')) {
    choosingLocked = false;
    if (state?.phase === 'choosing') {
      renderChoosing();
    }
  }

  notice(message);
});

socket.on('disconnect', () => {
  choosingLocked = false;
  notice('Connection lost. Reconnecting...');
});

const invite = new URLSearchParams(
  location.search
).get('room');

if (invite) {
  $('code').value =
    invite.toUpperCase().slice(0, 6);
}
