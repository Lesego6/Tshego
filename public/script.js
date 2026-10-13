const socket = io();
const $ = id => document.getElementById(id);
const screens = ['waiting', 'choosing', 'playing', 'results'];
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
let me = null;
let state = null;
let previousRound = 0;
let currentDraft = {};
let timerHandle = null;

function notice(message) {
  $('notice').textContent = message;
  clearTimeout(notice.timeout);
  notice.timeout = setTimeout(() => $('notice').textContent = '', 6000);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function showScreen(name) {
  $('home').hidden = Boolean(name);
  $('game').hidden = !name;
  screens.forEach(screen => $(screen).hidden = screen !== name);
}
function saveSession(data) {
  sessionStorage.setItem('letterus-session', JSON.stringify(data));
}
function session() {
  try { return JSON.parse(sessionStorage.getItem('letterus-session')); } catch { return null; }
}
function joinOrCreate(type) {
  const name = $('name').value.trim();
  if (!name) return notice('Enter your name first, love.');
  const code = $('code').value.trim().toUpperCase();
  if (type === 'join' && !/^[A-Z0-9]{6}$/.test(code)) return notice('Enter the six-character room code.');
  socket.emit(type === 'join' ? 'room:join' : 'room:create', { name, code });
}
$('create').addEventListener('click', () => joinOrCreate('create'));
$('join').addEventListener('click', () => joinOrCreate('join'));
$('copy').addEventListener('click', async () => {
  const link = `${location.origin}/?room=${encodeURIComponent(state.code)}`;
  try { await navigator.clipboard.writeText(link); notice('Invite link copied! Send it to your girl ♡'); }
  catch { notice(`Share this link: ${link}`); }
});
$('stop').addEventListener('click', () => socket.emit('round:stop'));
$('next').addEventListener('click', () => socket.emit('round:next'));
$('answers-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!state || state.phase !== 'playing') return;
  const answers = {};
  state.categories.forEach((category, i) => answers[category] = $(`answer-${i}`).value.trim());
  currentDraft = answers;
  socket.emit('round:submit', { answers });
});
function renderScores() {
  $('scores').innerHTML = state.players.map(p => `<div class="score"><span>${escapeHtml(p.name)}${p.id === me ? ' (you)' : ''}${p.connected ? '' : ' · offline'}</span><strong>${p.score}</strong><span>points</span></div>`).join('');
}
function renderChoosing() {
  $('round-label').textContent = `ROUND ${state.round + 1}`;
  const myTurn = state.chooserId === me;
  $('choose-instruction').textContent = myTurn ? 'Your turn! Choose one mystery tile.' : 'Your girl is choosing a letter ♡';
  $('alphabet').innerHTML = '';
  alphabet.forEach(letter => {
    const tile = document.createElement('button');
    tile.className = `tile${state.usedLetters.includes(letter) ? ' used' : ''}`;
    tile.textContent = state.usedLetters.includes(letter) ? '✓' : '?';
    tile.disabled = !myTurn || state.usedLetters.includes(letter) || state.players.some(p => !p.connected);
    tile.title = 'Mystery letter';
    tile.addEventListener('click', () => socket.emit('round:choose', { letter }));
    $('alphabet').appendChild(tile);
  });
}
function renderPlaying() {
  $('play-round').textContent = `ROUND ${state.round}`;
  $('letter').textContent = state.letter;
  const mine = state.players.find(p => p.id === me);
  const submitted = Boolean(mine?.submitted);
  $('fields').innerHTML = state.categories.map((category, i) => `<div><label for="answer-${i}">${escapeHtml(category)}</label><input id="answer-${i}" maxlength="70" autocomplete="off" placeholder="Starts with ${escapeHtml(state.letter)}" value="${escapeHtml(currentDraft[category] || '')}" ${submitted ? 'disabled' : ''}></div>`).join('');
  $('submit').disabled = submitted;
  $('stop').disabled = submitted;
  $('play-status').textContent = submitted ? 'Answers sent! Waiting for your person ♡' : 'Think fast, love!';
  clearInterval(timerHandle);
  const updateTimer = () => {
    const remaining = Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000));
    $('timer').textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  };
  updateTimer();
  timerHandle = setInterval(updateTimer, 250);
}
function renderResults() {
  const [a, b] = state.players;
  const other = state.players.find(p => p.id !== me);
  const unresolved = (state.results || []).some(row => Object.values(row.challenges || {}).some(c => ['pending','disputed'].includes(c.status)));
  const ready = Boolean(state.reviewReady?.[me]);
  const allReady = state.players.every(p => state.reviewReady?.[p.id]);
  $('review-status').textContent = state.finalized
    ? 'Scores finalized! Ready for another round ♡'
    : unresolved ? 'A challenge needs resolving before you can confirm.'
    : ready ? 'Your review is confirmed. Waiting for your person ♡'
    : 'Check each answer and flag anything that does not belong.';
  $('result-rows').innerHTML = (state.results || []).map(row => {
    const answers = [a,b].map(player => {
      const mine = player.id === me;
      const challenge = row.challenges?.[player.id];
      const points = row.points[player.id];
      let action = '';
      if (challenge?.status === 'pending') {
        action = mine ? `<div class="review-actions"><button data-action="accept" data-category="${escapeHtml(row.category)}">Accept flag · 0 pts</button><button data-action="dispute" data-category="${escapeHtml(row.category)}">Dispute flag</button></div>` : '<small class="review-note">Flag sent · waiting for response</small>';
      } else if (challenge?.status === 'disputed') {
        action = mine ? `<div class="review-actions"><small class="review-note">You disputed this flag.</small><button data-action="concede" data-category="${escapeHtml(row.category)}">Accept flag instead</button></div>` : `<div class="review-actions"><small class="review-note">Your partner disputed the flag.</small><button data-action="withdraw" data-category="${escapeHtml(row.category)}" data-target="${escapeHtml(player.id)}">Withdraw flag · keep points</button></div>`;
      } else if (challenge?.status === 'accepted') action = '<small class="review-note">Flag accepted · 0 points</small>';
      else if (challenge?.status === 'withdrawn') action = '<small class="review-note">Flag withdrawn · points kept</small>';
      else if (!mine && !state.finalized && !ready && row.basePoints[player.id] > 0) action = `<button class="flag-button" data-action="flag" data-category="${escapeHtml(row.category)}" data-target="${escapeHtml(player.id)}">⚑ Flag answer</button>`;
      return `<div class="review-answer"><span class="review-name">${escapeHtml(player.name)}${mine ? ' (you)' : ''}</span><span class="review-value">${escapeHtml(row.answers[player.id] || '—')}</span><b>+${points} pts</b>${action}</div>`;
    }).join('');
    return `<div class="result-row"><strong>${escapeHtml(row.category)}</strong><div class="review-pair">${answers}</div></div>`;
  }).join('');
  $('challenge-panel').hidden = true; // Actions appear beside the relevant answer.
  $('confirm-review').hidden = Boolean(state.finalized);
  $('confirm-review').disabled = unresolved || !other?.connected;
  $('confirm-review').textContent = ready ? 'Undo my confirmation' : 'Confirm my review ♡';
  $('next').hidden = state.hostId !== me;
  $('next').disabled = !state.finalized || state.players.some(p => !p.connected);
  $('next-help').textContent = state.finalized
    ? (state.hostId === me ? 'You can start the next round ♡' : 'Waiting for your person to start the next round ♡')
    : `Reviews confirmed: ${state.players.filter(p => state.reviewReady?.[p.id]).length}/2. Points will be added after both confirm.`;
}
$('result-rows').addEventListener('click', event => {
  const btn = event.target.closest('button[data-action]');
  if (!btn || !state || state.phase !== 'results' || state.finalized) return;
  const category = btn.dataset.category;
  const action = btn.dataset.action;
  if (action === 'flag') socket.emit('review:flag', { category, targetId: btn.dataset.target });
  if (action === 'accept' || action === 'dispute') socket.emit('review:respond', { category, decision: action });
  if (action === 'withdraw' || action === 'concede') socket.emit('review:resolve', { category, targetId: action === 'concede' ? me : btn.dataset.target, decision: action });
});
$('confirm-review').addEventListener('click', () => socket.emit(state.reviewReady?.[me] ? 'review:unconfirm' : 'review:confirm'));
function render() {
  if (!state || !me) return;
  $('room-code').textContent = state.code;
  renderScores();
  let screen = state.phase;
  if (screen === 'waiting' && state.players.length === 2) screen = 'choosing';
  if (screen === 'waiting') { showScreen('waiting'); return; }
  if (screen === 'playing' && state.round !== previousRound) { currentDraft = {}; previousRound = state.round; }
  showScreen(screen);
  if (screen === 'choosing') renderChoosing();
  if (screen === 'playing') {
    // Preserve text while the partner submits or the STOP timer changes.
    if (!$('fields').children.length || $('letter').textContent !== state.letter) renderPlaying();
    else {
      const submitted = state.players.find(p => p.id === me)?.submitted;
      $('submit').disabled = Boolean(submitted);
      $('stop').disabled = Boolean(submitted);
      if (submitted) {
        $('play-status').textContent = 'Answers sent! Waiting for your person ♡';
        $('fields').querySelectorAll('input').forEach(input => input.disabled = true);
      }
    }
  }
  if (screen === 'results') { clearInterval(timerHandle); $('fields').innerHTML = ''; renderResults(); }
  if (screen === 'choosing') $('fields').innerHTML = '';
}
socket.on('connect', () => {
  const saved = session();
  if (saved?.code && saved?.token) socket.emit('room:resume', saved);
});
socket.on('room:joined', data => {
  me = data.playerId;
  saveSession({ code: data.code, token: data.token });
});
socket.on('room:state', incoming => { state = incoming; render(); });
socket.on('game:error', message => {
  if (message.includes('old room')) { sessionStorage.removeItem('letterus-session'); me = null; state = null; showScreen(null); }
  notice(message);
});
socket.on('disconnect', () => notice('Connection lost. Reconnecting...'));
const invite = new URLSearchParams(location.search).get('room');
if (invite) $('code').value = invite.toUpperCase().slice(0, 6);
