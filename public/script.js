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
  $('result-rows').innerHTML = (state.results || []).map(row => `<div class="result-row"><strong>${escapeHtml(row.category)}</strong><span>${escapeHtml(a.name)}: ${escapeHtml(row.answers[a.id] || '—')} <b>+${row.points[a.id]}</b></span><span>${escapeHtml(b.name)}: ${escapeHtml(row.answers[b.id] || '—')} <b>+${row.points[b.id]}</b></span></div>`).join('');
  $('next').hidden = state.hostId !== me;
  $('next').disabled = state.players.some(p => !p.connected);
  $('next-help').textContent = state.hostId === me ? 'Start the next round when you are both ready.' : 'Waiting for the host to start the next round ♡';
}
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
