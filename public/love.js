(() => {
  const $ = id => document.getElementById(id);
  let token = localStorage.getItem('letterus-love-token') || '';
  let account = null;
  let messages = [];
  let selectedNote = null;
  const show = (id, yes) => { $(id).hidden = !yes; };
  const feedback = message => { $('love-feedback').textContent = message; };
  const api = async (path, method = 'GET', body) => {
    const response = await fetch('/api/love' + path, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Request failed.');
    return data;
  };
  function renderAccount() {
    show('love-auth', !account);
    show('love-account', !!account);
    show('love-pair', !!account && !account.partnerName);
    show('love-actions', !!account && !!account.partnerName);
    if (!account) return;
    $('love-greeting').textContent = `Welcome, ${account.displayName} ♡`;
    $('love-invite').textContent = account.inviteCode;
    $('love-partner').textContent = account.partnerName ? `Connected with ${account.partnerName} ♡` : 'Give your person your invitation code, or enter theirs below.';
  }
  async function refresh() {
    if (!token) { account = null; renderAccount(); return; }
    try {
      account = await api('/me');
      renderAccount();
      if (account.partnerName) {
        messages = await api('/messages');
        renderMessages();
      }
      socket.emit('love:identify', token);
    } catch (error) {
      if (error.message === 'Please sign in again.') {
        token = ''; localStorage.removeItem('letterus-love-token'); account = null; renderAccount();
      } else feedback(error.message);
    }
  }
  function renderMessages() {
    const received = messages.filter(message => !message.mine);
    const unread = received.filter(message => !message.opened_at).length;
    $('love-unread').textContent = unread ? `${unread} unopened ♡` : '';
    $('love-messages').replaceChildren();
    if (!messages.length) { $('love-messages').textContent = 'Your little mailbox is empty for now ♡'; return; }
    messages.forEach(message => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'love-message';
      const who = message.mine ? 'You sent' : `${message.sender_name} sent`;
      const status = !message.mine && !message.opened_at ? ' • unopened' : '';
      button.textContent = `${message.kind === 'note' ? '✉' : '♡'} ${who} a ${message.kind} · ${new Date(message.created_at).toLocaleDateString()}${status}`;
      button.addEventListener('click', () => openMessage(message));
      $('love-messages').appendChild(button);
    });
  }
  async function openMessage(message) {
    selectedNote = message;
    $('love-letter-title').textContent = message.kind === 'hug' ? 'A warm hug ♡' : 'A little letter ♡';
    $('love-letter-body').textContent = message.kind === 'hug' ? `${message.mine ? 'You sent a hug ♡' : `${message.sender_name} sent you a big hug ♡`}` : message.body;
    show('love-letter', true);
    if (!message.mine && !message.opened_at) {
      try { await api(`/messages/${message.id}/open`, 'POST'); await refresh(); }
      catch (error) { feedback(error.message); }
    }
  }
  $('love-auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const register = $('love-register').checked;
    const username = $('love-username').value.trim();
    const password = $('love-password').value;
    const displayName = $('love-display').value.trim();
    try {
      const data = await api(register ? '/register' : '/login', 'POST', { username, password, displayName });
      token = data.token; localStorage.setItem('letterus-love-token', token);
      $('love-password').value = ''; feedback('Signed in ♡'); await refresh();
    } catch (error) { feedback(error.message); }
  });
  $('love-register').addEventListener('change', () => show('love-display-wrap', $('love-register').checked));
  $('love-logout').addEventListener('click', async () => {
    try { await api('/logout', 'POST'); } catch {};
    token = ''; account = null; messages = []; localStorage.removeItem('letterus-love-token'); renderAccount(); feedback('Signed out.');
  });
  $('love-pair-button').addEventListener('click', async () => {
    try { await api('/pair', 'POST', { code: $('love-pair-code').value.trim() }); feedback('Connected forever ♡'); await refresh(); }
    catch (error) { feedback(error.message); }
  });
  $('love-send-note').addEventListener('click', async () => {
    const body = $('love-note-text').value.trim();
    if (!body) return feedback('Write a little something first ♡');
    try { await api('/messages', 'POST', { kind: 'note', body }); $('love-note-text').value = ''; feedback('Your letter is on its way ♡'); await refresh(); }
    catch (error) { feedback(error.message); }
  });
  async function sendHug() {
    try { await api('/messages', 'POST', { kind: 'hug' }); feedback('Hug sent ♡'); await refresh(); }
    catch (error) { feedback(error.message); }
  }
  $('love-send-hug').addEventListener('click', sendHug);
  $('love-hug-back').addEventListener('click', () => { show('love-hug-toast', false); sendHug(); });
  $('love-hug-dismiss').addEventListener('click', () => show('love-hug-toast', false));
  $('love-letter-close').addEventListener('click', () => show('love-letter', false));
  socket.on('connect', () => { if (token) socket.emit('love:identify', token); });
  socket.on('love:refresh', refresh);
  socket.on('love:new', ({ kind, senderName }) => {
    if (kind === 'hug') { $('love-hug-text').textContent =
  `${senderName} is sending you the biggest, warmest hug! ♡`; show('love-hug-toast', true); }
    else feedback(`${senderName} left you a little letter ♡`);
    refresh();
  });
  refresh();
})();
