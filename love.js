const crypto = require('crypto');
const { Pool } = require('pg');
const express = require('express');

function createLoveFeatures(app, io) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true }, max: 5 });
  const router = express.Router();
  router.use(express.json({ limit: '20kb' }));
  const cooldowns = new Map();
  const randomToken = () => crypto.randomBytes(32).toString('hex');
  const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
  const passwordHash = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
  const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

  async function initialize() {
    await pool.query(`CREATE TABLE IF NOT EXISTS love_users (
      id UUID PRIMARY KEY, username VARCHAR(24) UNIQUE NOT NULL,
      display_name VARCHAR(40) NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      invite_code VARCHAR(12) UNIQUE NOT NULL, partner_id UUID REFERENCES love_users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS love_sessions (
      token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES love_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS love_messages (
      id UUID PRIMARY KEY, sender_id UUID NOT NULL REFERENCES love_users(id),
      recipient_id UUID NOT NULL REFERENCES love_users(id),
      kind VARCHAR(8) NOT NULL CHECK(kind IN ('note', 'hug')),
      body TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      opened_at TIMESTAMPTZ
    )`);
    console.log('LetterUs love tables ready');
  }
  async function getUser(token) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const result = await pool.query(`SELECT u.id, u.username, u.display_name, u.invite_code,
      u.partner_id, p.display_name AS partner_name FROM love_sessions s
      JOIN love_users u ON u.id=s.user_id LEFT JOIN love_users p ON p.id=u.partner_id
      WHERE s.token_hash=$1 AND s.expires_at>NOW()`, [tokenHash(token)]);
    return result.rows[0] || null;
  }
  const publicUser = user => ({ username: user.username, displayName: user.display_name,
    inviteCode: user.invite_code, partnerName: user.partner_name || null });
  async function requireUser(req, res, next) {
    try {
      req.loveUser = await getUser((req.headers.authorization || '').replace(/^Bearer /i, ''));
      if (!req.loveUser) return res.status(401).json({ error: 'Please sign in again.' });
      next();
    } catch (error) { next(error); }
  }
  async function issueSession(userId) {
    const token = randomToken();
    await pool.query('INSERT INTO love_sessions(token_hash,user_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL \'30 days\')', [tokenHash(token), userId]);
    return token;
  }
  router.post('/register', async (req, res, next) => {
    try {
      const username = clean(req.body?.username, 24).toLowerCase();
      const displayName = clean(req.body?.displayName, 40);
      const password = req.body?.password;
      if (!/^[a-z0-9_]{3,24}$/.test(username) || !displayName || typeof password !== 'string' || password.length < 10 || password.length > 128)
        return res.status(400).json({ error: 'Use a 3–24 character username, a name, and a password of at least 10 characters.' });
      const id = crypto.randomUUID(), salt = crypto.randomBytes(16).toString('hex');
      const inviteCode = crypto.randomBytes(6).toString('hex').toUpperCase();
      await pool.query('INSERT INTO love_users(id,username,display_name,salt,password_hash,invite_code) VALUES($1,$2,$3,$4,$5,$6)',
        [id, username, displayName, salt, passwordHash(password, salt), inviteCode]);
      res.json({ token: await issueSession(id) });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Username already taken. Try another.' });
      next(error);
    }
  });
  router.post('/login', async (req, res, next) => {
    try {
      const username = clean(req.body?.username, 24).toLowerCase();
      const password = req.body?.password;
      const { rows } = await pool.query('SELECT * FROM love_users WHERE username=$1', [username]);
      const user = rows[0];
      if (!user || typeof password !== 'string' || password.length > 128 ||
        !crypto.timingSafeEqual(Buffer.from(user.password_hash, 'hex'), Buffer.from(passwordHash(password, user.salt), 'hex')))
        return res.status(401).json({ error: 'Incorrect username or password.' });
      res.json({ token: await issueSession(user.id) });
    } catch (error) { next(error); }
  });
  router.get('/me', requireUser, (req, res) => res.json(publicUser(req.loveUser)));
  router.post('/logout', requireUser, async (req, res, next) => {
    try { await pool.query('DELETE FROM love_sessions WHERE token_hash=$1', [tokenHash(req.headers.authorization.replace(/^Bearer /i, ''))]); res.json({ ok: true }); }
    catch (error) { next(error); }
  });
  router.post('/pair', requireUser, async (req, res, next) => {
    const client = await pool.connect().catch(next);
    if (!client) return;
    try {
      const code = clean(req.body?.code, 12).toUpperCase();
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT id, partner_id FROM love_users WHERE invite_code=$1 FOR UPDATE', [code]);
      const other = rows[0];
      const self = (await client.query('SELECT partner_id FROM love_users WHERE id=$1 FOR UPDATE', [req.loveUser.id])).rows[0];
      if (!other || other.id === req.loveUser.id || other.partner_id || self.partner_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid invite code or one of you is already paired.' });
      }
      await client.query('UPDATE love_users SET partner_id=$1 WHERE id=$2', [other.id, req.loveUser.id]);
      await client.query('UPDATE love_users SET partner_id=$1 WHERE id=$2', [req.loveUser.id, other.id]);
      await client.query('COMMIT');
      io.to(`love:${other.id}`).to(`love:${req.loveUser.id}`).emit('love:refresh');
      res.json({ ok: true });
    } catch (error) { await client.query('ROLLBACK'); next(error); }
    finally { client.release(); }
  });
  router.get('/messages', requireUser, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`SELECT m.id,m.kind,m.body,m.created_at,m.opened_at,
        m.sender_id=$1 AS mine,u.display_name AS sender_name FROM love_messages m
        JOIN love_users u ON u.id=m.sender_id
        WHERE m.sender_id=$1 OR m.recipient_id=$1 ORDER BY m.created_at DESC LIMIT 100`, [req.loveUser.id]);
      res.json(rows);
    } catch (error) { next(error); }
  });
  router.post('/messages', requireUser, async (req, res, next) => {
    try {
      const user = await getUser(req.headers.authorization.replace(/^Bearer /i, ''));
      if (!user.partner_id) return res.status(400).json({ error: 'Connect with your person first.' });
      const kind = req.body?.kind;
      if (!['note', 'hug'].includes(kind)) return res.status(400).json({ error: 'Invalid message type.' });
      const body = kind === 'note' ? clean(req.body?.body, 1000) : '';
      if (kind === 'note' && (!body || req.body?.body?.length > 1000)) return res.status(400).json({ error: 'Write a note up to 1,000 characters.' });
      if (kind === 'hug') {
        const last = cooldowns.get(user.id) || 0;
        if (Date.now() - last < 10000) return res.status(429).json({ error: 'Wait 10 seconds before sending another hug.' });
        cooldowns.set(user.id, Date.now());
      }
      const id = crypto.randomUUID();
      await pool.query('INSERT INTO love_messages(id,sender_id,recipient_id,kind,body) VALUES($1,$2,$3,$4,$5)',
        [id, user.id, user.partner_id, kind, body]);
      io.to(`love:${user.partner_id}`).emit('love:new', { kind, senderName: user.display_name });
      io.to(`love:${user.id}`).emit('love:refresh');
      res.json({ ok: true, id });
    } catch (error) { next(error); }
  });
  router.post('/messages/:id/open', requireUser, async (req, res, next) => {
    try {
      const { rowCount } = await pool.query('UPDATE love_messages SET opened_at=COALESCE(opened_at,NOW()) WHERE id=$1 AND recipient_id=$2', [req.params.id, req.loveUser.id]);
      if (!rowCount) return res.status(404).json({ error: 'Message not found.' });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
  app.use('/api/love', router);
  app.use('/api/love', (err, _req, res, _next) => { console.error('Love API:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); });
  io.on('connection', socket => {
    socket.on('love:identify', async token => {
      try {
        const user = await getUser(token);
        if (!user) return;
        socket.join(`love:${user.id}`);
        socket.emit('love:refresh');
      } catch (error) { console.error('Love socket auth:', error.message); }
    });
  });
  return initialize();
}
module.exports = createLoveFeatures;
