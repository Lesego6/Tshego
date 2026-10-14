# LetterUs - Fair Challenge Edition

Run `npm install` then `npm start`. Open http://localhost:3000 in two separate browser sessions.

After a round ends, each player can flag the other player's valid-looking answers with a reason. The author sees that reason and can accept the flag for 0 points or dispute it with an explanation. Both comments stay visible while the players resolve the disagreement.

Outstanding challenges must be resolved before either review can be confirmed. Scores are committed only after both players confirm, and then the host can start another round.

The host can adjust the next round's timer, category count, and strict first-letter scoring before play starts. The review screen shows challenge badges, a current round score preview, and a recent round history with answers, flags, points, and winners.

A disagreement cannot be forcibly resolved by either player; talk it out and choose one of the available actions. Room state lives in memory and resets on Render free-service restarts.

## Our Forever Space (Neon PostgreSQL)

1. Create a Neon PostgreSQL database and copy its connection string.
2. Copy `.env.example` to `.env` and replace the placeholder with your actual `DATABASE_URL`.
3. Run `npm install` (this generates an updated package-lock.json) and `npm start`.
4. Register two separate accounts, one for each person. Each person can sign in anytime.
5. One person enters the other person's invitation code to link the accounts permanently.
6. Love Notes and Hugs are saved in Neon, even if the other person is offline or game room codes change.
7. On Render, set the `DATABASE_URL` environment variable to the Neon connection string and deploy.

Notes: The database tables are created automatically on server startup. Each account can pair only once. This is a small private-app starter: for public deployment add stronger signup rate limits, account recovery and CSRF protection as appropriate. Hugs and notes are shown on the next website visit; phone push notifications are not implemented. The game room still uses its original temporary room codes and in-memory state.
