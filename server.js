const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-before-deployment';
const db = new Database(path.join(__dirname, 'chess.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL, rating INTEGER NOT NULL DEFAULT 1200,
 wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
 draws INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS games (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
 opponent TEXT NOT NULL, mode TEXT NOT NULL, result TEXT NOT NULL,
 pgn TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id)
);`);

app.use(express.json({ limit: '1mb' }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 } }));
app.use(express.static(path.join(__dirname, 'public')));

const publicUser = u => u && ({ id: u.id, username: u.username, rating: u.rating, wins: u.wins, losses: u.losses, draws: u.draws });
const currentUser = req => req.session.userId ? db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) : null;
const authRequired = (req, res, next) => { if (!currentUser(req)) return res.status(401).json({ error: 'Please sign in first.' }); next(); };

app.get('/api/me', (req, res) => res.json({ user: publicUser(currentUser(req)) }));
app.post('/api/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_]{3,18}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–18 characters: letters, numbers or underscores.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    req.session.userId = info.lastInsertRowid;
    res.json({ user: publicUser(currentUser(req)) });
  } catch (e) { res.status(409).json({ error: 'That username is already taken.' }); }
});
app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Incorrect username or password.' });
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/leaderboard', (req, res) => {
  const rows = db.prepare('SELECT username, rating, wins, losses, draws FROM users ORDER BY rating DESC, wins DESC LIMIT 50').all();
  res.json({ leaderboard: rows });
});
app.get('/api/games', authRequired, (req, res) => {
  const games = db.prepare('SELECT id, opponent, mode, result, pgn, created_at FROM games WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.session.userId);
  res.json({ games });
});
app.post('/api/games', authRequired, (req, res) => {
  const { opponent, mode, result, pgn } = req.body || {};
  if (![ 'win', 'loss', 'draw', 'unfinished' ].includes(result) || typeof pgn !== 'string' || pgn.length > 20000) return res.status(400).json({ error: 'Invalid game data.' });
  const user = currentUser(req);
  const info = db.prepare('INSERT INTO games (user_id, opponent, mode, result, pgn) VALUES (?, ?, ?, ?, ?)')
    .run(user.id, String(opponent || 'Opponent').slice(0, 40), String(mode || 'local').slice(0, 20), result, pgn);
  if (result === 'win') db.prepare('UPDATE users SET wins = wins + 1, rating = rating + 12 WHERE id = ?').run(user.id);
  if (result === 'loss') db.prepare('UPDATE users SET losses = losses + 1, rating = MAX(100, rating - 10) WHERE id = ?').run(user.id);
  if (result === 'draw') db.prepare('UPDATE users SET draws = draws + 1, rating = rating + 2 WHERE id = ?').run(user.id);
  res.json({ id: info.lastInsertRowid, user: publicUser(currentUser(req)) });
});

// Live rooms are held in memory. Restarting the server ends active rooms; completed games can be saved by players.
const rooms = new Map();
function roomState(room) { return { fen: room.chess.fen(), pgn: room.chess.pgn(), turn: room.chess.turn(), history: room.chess.history(), players: room.players.map(p => ({ username: p.username, color: p.color })), status: room.chess.isGameOver() ? 'finished' : 'playing' }; }
io.on('connection', socket => {
  socket.on('room:create', ({ username } = {}, cb = () => {}) => {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const room = { chess: new Chess(), players: [{ id: socket.id, username: String(username || 'Guest').slice(0, 18), color: 'w' }], createdAt: Date.now() };
    rooms.set(code, room); socket.join(code); socket.data.roomCode = code; socket.data.color = 'w';
    cb({ ok: true, code, color: 'w', state: roomState(room) });
  });
  socket.on('room:join', ({ code, username } = {}, cb = () => {}) => {
    code = String(code || '').trim().toUpperCase(); const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Room not found. Check the code and try again.' });
    if (room.players.length >= 2) return cb({ ok: false, error: 'This room already has two players.' });
    const player = { id: socket.id, username: String(username || 'Guest').slice(0, 18), color: 'b' };
    room.players.push(player); socket.join(code); socket.data.roomCode = code; socket.data.color = 'b';
    io.to(code).emit('room:state', roomState(room)); cb({ ok: true, code, color: 'b', state: roomState(room) });
  });
  socket.on('room:move', ({ from, to, promotion } = {}, cb = () => {}) => {
    const code = socket.data.roomCode, room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'You are not in a live room.' });
    if (room.players.find(p => p.id === socket.id)?.color !== room.chess.turn()) return cb({ ok: false, error: 'It is not your turn.' });
    try {
      const move = room.chess.move({ from, to, promotion: promotion || 'q' });
      io.to(code).emit('room:move', { move, state: roomState(room) }); cb({ ok: true });
    } catch { cb({ ok: false, error: 'That move is not legal.' }); }
  });
  socket.on('room:resign', () => { const code = socket.data.roomCode; if (code && rooms.has(code)) io.to(code).emit('room:ended', { message: 'A player resigned.' }); });
  socket.on('disconnect', () => {
    const code = socket.data.roomCode, room = rooms.get(code); if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (!room.players.length) rooms.delete(code); else io.to(code).emit('room:opponent-left');
  });
});

server.listen(PORT, () => console.log(`♟ Checkmate Chess is running at http://localhost:${PORT}`));
