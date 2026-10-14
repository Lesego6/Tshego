
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
let pendingReviewComment = null;

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

function cleanReviewComment(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

function updateReviewModalCount() {
  $('review-modal-count').textContent =
    `${$('review-modal-input').value.length}/500`;
}

function closeReviewModal(value) {
  if (!pendingReviewComment) {
    return;
  }

  const { resolve } = pendingReviewComment;
  pendingReviewComment = null;

  $('review-modal').hidden = true;
  $('review-modal-input').value = '';
  updateReviewModalCount();

  resolve(value);
}

function requestReviewComment({
  title,
  prompt,
  submitLabel,
  emptyMessage
}) {
  if (pendingReviewComment) {
    closeReviewModal(null);
  }

  return new Promise(resolve => {
    pendingReviewComment = {
      resolve,
      emptyMessage
    };

    $('review-modal-title').textContent = title;
    $('review-modal-prompt').textContent = prompt;
    $('review-modal-submit').textContent = submitLabel;
    $('review-modal').hidden = false;

    updateReviewModalCount();
    $('review-modal-input').focus();
  });
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

$('review-modal-input').addEventListener(
  'input',
  updateReviewModalCount
);

$('review-modal-cancel').addEventListener(
  'click',
  () => closeReviewModal(null)
);

$('review-modal').addEventListener('click', event => {
  if (event.target === $('review-modal')) {
    closeReviewModal(null);
  }
});

$('review-modal-form').addEventListener('submit', event => {
  event.preventDefault();

  if (!pendingReviewComment) {
    return;
  }

  const comment = cleanReviewComment(
    $('review-modal-input').value
  );

  if (!comment) {
    notice(pendingReviewComment.emptyMessage);
    $('review-modal-input').focus();
    return;
  }

  closeReviewModal(comment);
});

document.addEventListener('keydown', event => {
  if (
    event.key === 'Escape' &&
    pendingReviewComment
  ) {
    closeReviewModal(null);
  }
});

[
  'setting-timer',
  'setting-categories',
  'setting-strict'
].forEach(id => {
  $(id).addEventListener('change', emitSettingsUpdate);
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

function currentSettings() {
  return {
    roundSeconds: 180,
    categoryCount: 18,
    strictFirstLetter: true,
    ...(state?.settings || {})
  };
}

function settingsEditable() {
  return Boolean(
    state &&
    ['waiting', 'choosing'].includes(state.phase)
  );
}

function emitSettingsUpdate() {
  if (
    !state ||
    state.hostId !== me ||
    !settingsEditable()
  ) {
    return;
  }

  socket.emit('settings:update', {
    roundSeconds: Number($('setting-timer').value),
    categoryCount: Number($('setting-categories').value),
    strictFirstLetter: $('setting-strict').checked
  });
}

function renderSettings() {
  const panel = $('settings-panel');
  const visible = settingsEditable();

  panel.hidden = !visible;

  if (!visible) {
    return;
  }

  const settings = currentSettings();
  const editable = state.hostId === me;

  $('setting-timer').value = String(settings.roundSeconds);
  $('setting-categories').value = String(settings.categoryCount);
  $('setting-strict').checked = Boolean(
    settings.strictFirstLetter
  );

  [
    'setting-timer',
    'setting-categories',
    'setting-strict'
  ].forEach(id => {
    $(id).disabled = !editable;
  });

  $('settings-help').textContent = editable
    ? 'Host settings apply to the next round.'
    : 'Only the host can edit these settings.';
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
  const strictLetter =
    currentSettings().strictFirstLetter;
  const placeholder = strictLetter
    ? `Starts with ${state.letter}`
    : 'Any answer';

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
          placeholder="${escapeHtml(placeholder)}"
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

const challengeStatusLabels = {
  pending: 'Flag pending',
  disputed: 'Disputed',
  accepted: 'Flag accepted',
  withdrawn: 'Flag withdrawn'
};

function challengeLabel(status) {
  return challengeStatusLabels[status] || 'Flagged';
}

function renderRoundPreview() {
  const results = state.results || [];

  $('round-preview').innerHTML = state.players.map(player => {
    const total = results.reduce(
      (sum, row) => sum + (row.points[player.id] || 0),
      0
    );

    const finalScore = state.finalized
      ? player.score
      : player.score + total;

    return `
      <div class="round-total">
        <span>${escapeHtml(player.name)}</span>
        <strong>+${total}</strong>
        <span>
          ${state.finalized ? 'Score' : 'After confirm'}
          ${finalScore}
        </span>
      </div>
    `;
  }).join('');
}

function renderHistory() {
  const history = state.history || [];
  const card = $('history-card');

  card.hidden = !history.length;

  if (!history.length) {
    $('history-list').innerHTML = '';
    return;
  }

  $('history-list').innerHTML = history
    .slice(-3)
    .reverse()
    .map((entry, index) => {
      const players = entry.players || state.players;
      const playerById = Object.fromEntries(
        players.map(player => [player.id, player])
      );

      const flags = (entry.rows || []).reduce(
        (total, row) =>
          total + Object.keys(row.challenges || {}).length,
        0
      );

      const winnerIds = entry.winnerIds || [];
      const winnerText = winnerIds.length === players.length
        ? 'Tie'
        : `${winnerIds.map(id =>
            playerById[id]?.name || 'Player'
          ).join(' and ')} won`;

      const scoreText = players.map(player =>
        `${escapeHtml(player.name)} +${entry.totals?.[player.id] || 0}`
      ).join(' / ');

      const rows = (entry.rows || []).map(row => {
        const answerLines = players.map(player => {
          const answer = row.answers?.[player.id] || '-';
          const points = row.points?.[player.id] || 0;

          return `
            ${escapeHtml(player.name)}:
            ${escapeHtml(answer)}
            (+${points})
          `;
        }).join('<br>');

        const challengeLines = Object.entries(
          row.challenges || {}
        ).map(([targetId, challenge]) => {
          const challenger =
            playerById[challenge.by]?.name || 'Player';
          const target =
            playerById[targetId]?.name || 'Player';

          return `
            ${escapeHtml(challenger)}
            -&gt;
            ${escapeHtml(target)}:
            ${escapeHtml(challengeLabel(challenge.status))}
          `;
        }).join('<br>');

        return `
          <div class="history-line">
            <strong>${escapeHtml(row.category)}</strong><br>
            ${answerLines}
            ${challengeLines ? `<br>${challengeLines}` : ''}
          </div>
        `;
      }).join('');

      return `
        <details class="history-entry" ${index === 0 ? 'open' : ''}>
          <summary>
            Round ${entry.round} - ${escapeHtml(winnerText)}
          </summary>

          <div class="history-meta">
            Letter ${escapeHtml(entry.letter)}
            &middot;
            ${flags} flag${flags === 1 ? '' : 's'}
            &middot;
            ${scoreText}
          </div>

          <div class="history-lines">
            ${rows}
          </div>
        </details>
      `;
    }).join('');
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

  renderRoundPreview();

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
      const challengeStatus =
        challengeStatusLabels[challenge?.status]
          ? challenge.status
          : null;

      const points =
        row.points[player.id];

      const category =
        escapeHtml(row.category);

      const comments = [];

      if (challenge?.reason) {
        comments.push(`
          <p>
            <strong>Flag reason</strong>
            ${escapeHtml(challenge.reason)}
          </p>
        `);
      }

      if (challenge?.response) {
        comments.push(`
          <p>
            <strong>Dispute explanation</strong>
            ${escapeHtml(challenge.response)}
          </p>
        `);
      }

      const commentHtml = comments.length
        ? `
          <div class="review-comments">
            ${comments.join('')}
          </div>
        `
        : '';

      let action = '';

      if (challenge?.status === 'pending') {

        if (mine) {
          action = `
            <div class="review-actions">
              <button
                type="button"
                data-action="accept"
                data-category="${category}">
                Accept flag &middot; 0 pts
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
              Flag sent &middot; waiting for response
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
                Withdraw flag &middot; keep points
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
            data-target="${escapeHtml(player.id)}"
            data-answer="${escapeHtml(row.answers[player.id] || '')}">
            Flag answer
          </button>
        `;
      }

      return `
        <div class="review-answer ${challengeStatus ? `has-${challengeStatus}` : ''}">

          <span class="review-name">
            ${escapeHtml(player.name)}
            ${mine ? '(you)' : ''}
          </span>

          ${challengeStatus
            ? `
              <span class="challenge-badge ${challengeStatus}">
                ${escapeHtml(challengeLabel(challengeStatus))}
              </span>
            `
            : ''}

          <span class="review-value">
            ${escapeHtml(
              row.answers[player.id] || '—'
            )}
          </span>

          <b>+${points} pts</b>

          ${commentHtml}

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
  async event => {
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
      const answer =
        button.dataset.answer || 'this answer';

      const reason = await requestReviewComment({
        title: 'Flag answer',
        prompt: `Why are you flagging "${answer}"?`,
        submitLabel: 'Send flag',
        emptyMessage: 'Please add a reason for the flag.'
      });

      if (reason === null) {
        return;
      }

      if (
        !state ||
        state.phase !== 'results' ||
        state.finalized
      ) {
        return;
      }

      socket.emit('review:flag', {
        category,
        targetId: button.dataset.target,
        reason
      });

      return;
    }

    if (
      action === 'accept' ||
      action === 'dispute'
    ) {
      const payload = {
        category,
        decision: action
      };

      if (action === 'dispute') {
        const response = await requestReviewComment({
          title: 'Dispute flag',
          prompt: 'Explain why this answer should count.',
          submitLabel: 'Send dispute',
          emptyMessage: 'Please add an explanation before disputing.'
        });

        if (response === null) {
          return;
        }

        if (
          !state ||
          state.phase !== 'results' ||
          state.finalized
        ) {
          return;
        }

        payload.response = response;
      }

      socket.emit('review:respond', payload);

      return;
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

      return;
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
  renderSettings();
  renderHistory();

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
