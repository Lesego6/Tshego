
"use strict";

const crypto = require("crypto");
const { Pool } = require("pg");
const express = require("express");

function createLoveFeatures(app, io) {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing.");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: true
    },
    max: 5
  });

  const router = express.Router();

  router.use(express.json({ limit: "20kb" }));

  const cooldowns = new Map();
  const loginAttempts = new Map();

  const LOGIN_LIMIT = 10;
  const LOGIN_WINDOW = 15 * 60 * 1000;
  const HUG_COOLDOWN = 10 * 1000;

  function randomToken() {
    return crypto.randomBytes(32).toString("hex");
  }

  function tokenHash(token) {
    return crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");
  }

  function passwordHash(password, salt) {
    return crypto
      .scryptSync(password, salt, 64)
      .toString("hex");
  }

  function clean(value, limit) {
    return typeof value === "string"
      ? value.trim().slice(0, limit)
      : "";
  }

  function errorResponse(res, status, message) {
    return res.status(status).json({
      error: message
    });
  }

  // DATABASE INITIALIZATION

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS love_users (
        id UUID PRIMARY KEY,
        username VARCHAR(24) UNIQUE NOT NULL,
        display_name VARCHAR(40) NOT NULL,
        salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        invite_code VARCHAR(12) UNIQUE NOT NULL,
        partner_id UUID REFERENCES love_users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS love_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id UUID NOT NULL
          REFERENCES love_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS love_messages (
        id UUID PRIMARY KEY,
        sender_id UUID NOT NULL
          REFERENCES love_users(id),
        recipient_id UUID NOT NULL
          REFERENCES love_users(id),
        kind VARCHAR(8) NOT NULL
          CHECK (kind IN ('note', 'hug')),
        body TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        opened_at TIMESTAMPTZ
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
        idx_love_messages_recipient
      ON love_messages (recipient_id, created_at DESC)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
        idx_love_messages_sender
      ON love_messages (sender_id, created_at DESC)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
        idx_love_sessions_expiry
      ON love_sessions (expires_at)
    `);

    console.log("LetterUs love tables ready");
  }

  // AUTHENTICATION HELPERS

  async function getUser(token) {
    if (
      typeof token !== "string" ||
      !/^[a-f0-9]{64}$/.test(token)
    ) {
      return null;
    }

    const result = await pool.query(`
      SELECT
        u.id,
        u.username,
        u.display_name,
        u.invite_code,
        u.partner_id,
        p.display_name AS partner_name
      FROM love_sessions s
      JOIN love_users u
        ON u.id = s.user_id
      LEFT JOIN love_users p
        ON p.id = u.partner_id
      WHERE s.token_hash = $1
        AND s.expires_at > NOW()
    `, [tokenHash(token)]);

    return result.rows[0] || null;
  }

  function publicUser(user) {
    return {
      username: user.username,
      displayName: user.display_name,
      inviteCode: user.invite_code,
      partnerName: user.partner_name || null
    };
  }

  async function requireUser(req, res, next) {
    try {
      const authorization =
        req.headers.authorization || "";

      const token = authorization.replace(
        /^Bearer /i,
        ""
      );

      req.loveUser = await getUser(token);
      req.loveToken = token;

      if (!req.loveUser) {
        return errorResponse(
          res,
          401,
          "Please sign in again."
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  }

  async function issueSession(userId) {
    const token = randomToken();

    await pool.query(`
      INSERT INTO love_sessions (
        token_hash,
        user_id,
        expires_at
      )
      VALUES (
        $1,
        $2,
        NOW() + INTERVAL '30 days'
      )
    `, [tokenHash(token), userId]);

    return token;
  }

  // BASIC LOGIN RATE LIMITING

  function authRateLimit(req, res, next) {
    const key = req.ip;
    const now = Date.now();

    let record = loginAttempts.get(key);

    if (!record || now > record.resetAt) {
      record = {
        count: 0,
        resetAt: now + LOGIN_WINDOW
      };
    }

    if (record.count >= LOGIN_LIMIT) {
      return errorResponse(
        res,
        429,
        "Too many attempts. Please try again later."
      );
    }

    record.count++;

    loginAttempts.set(key, record);

    next();
  }

  // REGISTER

  router.post(
    "/register",
    authRateLimit,
    async (req, res, next) => {
      try {
        const username = clean(
          req.body?.username,
          24
        ).toLowerCase();

        const displayName = clean(
          req.body?.displayName,
          40
        );

        const password = req.body?.password;

        if (
          !/^[a-z0-9_]{3,24}$/.test(username) ||
          !displayName ||
          typeof password !== "string" ||
          password.length < 10 ||
          password.length > 128
        ) {
          return errorResponse(
            res,
            400,
            "Use a valid username, nickname, and password of at least 10 characters."
          );
        }

        const id = crypto.randomUUID();

        const salt = crypto
          .randomBytes(16)
          .toString("hex");

        const inviteCode = crypto
          .randomBytes(6)
          .toString("hex")
          .toUpperCase();

        const hashedPassword = passwordHash(
          password,
          salt
        );

        await pool.query(`
          INSERT INTO love_users (
            id,
            username,
            display_name,
            salt,
            password_hash,
            invite_code
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          id,
          username,
          displayName,
          salt,
          hashedPassword,
          inviteCode
        ]);

        const token = await issueSession(id);

        res.status(201).json({ token });
      } catch (error) {
        if (error.code === "23505") {
          return errorResponse(
            res,
            409,
            "Username already taken or invitation code conflict. Please try again."
          );
        }

        next(error);
      }
    }
  );

  // LOGIN

  router.post(
    "/login",
    authRateLimit,
    async (req, res, next) => {
      try {
        const username = clean(
          req.body?.username,
          24
        ).toLowerCase();

        const password = req.body?.password;

        if (
          typeof password !== "string" ||
          password.length > 128
        ) {
          return errorResponse(
            res,
            401,
            "Incorrect username or password."
          );
        }

        const result = await pool.query(
          "SELECT * FROM love_users WHERE username = $1",
          [username]
        );

        const user = result.rows[0];

        if (!user) {
          return errorResponse(
            res,
            401,
            "Incorrect username or password."
          );
        }

        const suppliedHash = Buffer.from(
          passwordHash(password, user.salt),
          "hex"
        );

        const storedHash = Buffer.from(
          user.password_hash,
          "hex"
        );

        if (
          suppliedHash.length !== storedHash.length ||
          !crypto.timingSafeEqual(
            suppliedHash,
            storedHash
          )
        ) {
          return errorResponse(
            res,
            401,
            "Incorrect username or password."
          );
        }

        const token = await issueSession(user.id);

        res.json({ token });
      } catch (error) {
        next(error);
      }
    }
  );

  // GET CURRENT USER

  router.get(
    "/me",
    requireUser,
    (req, res) => {
      res.json(publicUser(req.loveUser));
    }
  );

  // LOGOUT

  router.post(
    "/logout",
    requireUser,
    async (req, res, next) => {
      try {
        await pool.query(`
          DELETE FROM love_sessions
          WHERE token_hash = $1
        `, [tokenHash(req.loveToken)]);

        // Remove connected sockets authenticated
        // using this exact session token.
        const sockets = await io.fetchSockets();

        for (const socket of sockets) {
          if (
            socket.data.loveTokenHash ===
            tokenHash(req.loveToken)
          ) {
            for (const room of socket.rooms) {
              if (room.startsWith("love:")) {
                socket.leave(room);
              }
            }

            socket.data.loveTokenHash = null;
          }
        }

        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    }
  );

  // PERMANENT PARTNER PAIRING

  router.post(
    "/pair",
    requireUser,
    async (req, res, next) => {
      let client;
      let transactionOpen = false;

      try {
        const code = clean(
          req.body?.code,
          12
        ).toUpperCase();

        if (!/^[A-F0-9]{12}$/.test(code)) {
          return errorResponse(
            res,
            400,
            "Enter a valid invitation code."
          );
        }

        client = await pool.connect();

        await client.query("BEGIN");
        transactionOpen = true;

        const targetResult = await client.query(`
          SELECT id
          FROM love_users
          WHERE invite_code = $1
        `, [code]);

        const target = targetResult.rows[0];

        if (
          !target ||
          target.id === req.loveUser.id
        ) {
          await client.query("ROLLBACK");
          transactionOpen = false;

          return errorResponse(
            res,
            400,
            "Invalid invitation code."
          );
        }

        const ids = [
          req.loveUser.id,
          target.id
        ].sort();

        const { rows } = await client.query(`
          SELECT id, partner_id
          FROM love_users
          WHERE id = ANY($1::uuid[])
          ORDER BY id
          FOR UPDATE
        `, [ids]);

        if (
          rows.length !== 2 ||
          rows.some(user => user.partner_id !== null)
        ) {
          await client.query("ROLLBACK");
          transactionOpen = false;

          return errorResponse(
            res,
            400,
            "One of you is already paired."
          );
        }

        await client.query(`
          UPDATE love_users
          SET partner_id = CASE
            WHEN id = $1::uuid THEN $2::uuid
            WHEN id = $2::uuid THEN $1::uuid
          END
          WHERE id IN ($1::uuid, $2::uuid)
        `, [
          req.loveUser.id,
          target.id
        ]);

        await client.query("COMMIT");
        transactionOpen = false;

        io.to(`love:${req.loveUser.id}`)
          .to(`love:${target.id}`)
          .emit("love:refresh");

        res.json({ ok: true });
      } catch (error) {
        if (client && transactionOpen) {
          await client.query("ROLLBACK").catch(() => {});
        }

        next(error);
      } finally {
        if (client) client.release();
      }
    }
  );

  // GET SAVED LOVE NOTES AND HUGS

  router.get(
    "/messages",
    requireUser,
    async (req, res, next) => {
      try {
        const { rows } = await pool.query(`
          SELECT
            m.id,
            m.kind,
            m.body,
            m.created_at,
            m.opened_at,
            m.sender_id = $1 AS mine,
            u.display_name AS sender_name
          FROM love_messages m
          JOIN love_users u
            ON u.id = m.sender_id
          WHERE
            m.sender_id = $1
            OR m.recipient_id = $1
          ORDER BY m.created_at DESC
          LIMIT 100
        `, [req.loveUser.id]);

        res.json(rows);
      } catch (error) {
        next(error);
      }
    }
  );

  // SEND LOVE NOTE OR HUG

  router.post(
    "/messages",
    requireUser,
    async (req, res, next) => {
      try {
        const user = await getUser(
          req.loveToken
        );

        if (!user) {
          return errorResponse(
            res,
            401,
            "Please sign in again."
          );
        }

        if (!user.partner_id) {
          return errorResponse(
            res,
            400,
            "Connect with your person first."
          );
        }

        const kind = req.body?.kind;

        if (!["note", "hug"].includes(kind)) {
          return errorResponse(
            res,
            400,
            "Invalid message type."
          );
        }

        let body = "";

        if (kind === "note") {
          if (
            typeof req.body?.body !== "string" ||
            req.body.body.length > 1000
          ) {
            return errorResponse(
              res,
              400,
              "Love Notes must be 1–1000 characters."
            );
          }

          body = req.body.body.trim();

          if (!body) {
            return errorResponse(
              res,
              400,
              "Write a little something first ♡"
            );
          }
        }

        if (kind === "hug") {
          const now = Date.now();

          const last =
            cooldowns.get(user.id) || 0;

          if (now - last < HUG_COOLDOWN) {
            return errorResponse(
              res,
              429,
              "Wait 10 seconds before sending another hug."
            );
          }

          cooldowns.set(user.id, now);
        }

        const id = crypto.randomUUID();

        await pool.query(`
          INSERT INTO love_messages (
            id,
            sender_id,
            recipient_id,
            kind,
            body
          )
          VALUES ($1, $2, $3, $4, $5)
        `, [
          id,
          user.id,
          user.partner_id,
          kind,
          body
        ]);

        io.to(`love:${user.partner_id}`)
          .emit("love:new", {
            kind,
            senderName: user.display_name
          });

        io.to(`love:${user.id}`)
          .emit("love:refresh");

        res.status(201).json({
          ok: true,
          id
        });
      } catch (error) {
        next(error);
      }
    }
  );

  // MARK NOTE OR HUG AS OPENED

  router.post(
    "/messages/:id/open",
    requireUser,
    async (req, res, next) => {
      try {
        if (
          !/^[0-9a-f-]{36}$/i.test(req.params.id)
        ) {
          return errorResponse(
            res,
            400,
            "Invalid message ID."
          );
        }

        const result = await pool.query(`
          UPDATE love_messages
          SET opened_at = COALESCE(
            opened_at,
            NOW()
          )
          WHERE id = $1
            AND recipient_id = $2
        `, [
          req.params.id,
          req.loveUser.id
        ]);

        if (!result.rowCount) {
          return errorResponse(
            res,
            404,
            "Message not found."
          );
        }

        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    }
  );

  // ROUTES AND ERROR HANDLING

  app.use("/api/love", router);

  app.use(
    "/api/love",
    (err, req, res, next) => {
      console.error(
        "LetterUs Love API:",
        err.message
      );

      res.status(500).json({
        error:
          "Something went wrong. Please try again."
      });
    }
  );

  // REAL-TIME SOCKET.IO EVENTS

  io.on("connection", socket => {
    let authVersion = 0;

    socket.on(
      "love:identify",
      async token => {
        const version = ++authVersion;

        for (const room of socket.rooms) {
          if (room.startsWith("love:")) {
            socket.leave(room);
          }
        }

        socket.data.loveTokenHash = null;

        try {
          const user = await getUser(token);

          if (
            version !== authVersion ||
            !socket.connected
          ) {
            return;
          }

          if (!user) return;

          socket.join(`love:${user.id}`);

          socket.data.loveTokenHash =
            tokenHash(token);

          socket.emit("love:refresh");
        } catch (error) {
          console.error(
            "Love Socket Authentication:",
            error.message
          );
        }
      }
    );

    socket.on("disconnect", () => {
      authVersion++;
    });
  });

  return initialize();
}

module.exports = createLoveFeatures;
