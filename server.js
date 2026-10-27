const express = require('express');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const JWT = process.env.JWT_SECRET || 'dev-secret';
const PORT = process.env.PORT || 3000;

// ----- БАЗА -----
const db = new Database('durzoc.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE, password TEXT, color TEXT DEFAULT '#5865f2');
  CREATE TABLE IF NOT EXISTS servers(
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, owner INTEGER);
  CREATE TABLE IF NOT EXISTS channels(
    id INTEGER PRIMARY KEY AUTOINCREMENT, server INTEGER, name TEXT);
  CREATE TABLE IF NOT EXISTS messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT, channel INTEGER, user INTEGER,
    content TEXT, created INTEGER DEFAULT (strftime('%s','now')));
`);

// ----- HTTP -----
const app = express();
const srv = http.createServer(app);
const io = new Server(srv);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const COLORS = ['#5865f2','#eb459e','#ed4245','#faa61a','#57f287','#3ba55c','#f47fff'];

// Регистрация
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'заполни поля' });
  try {
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const info = db.prepare('INSERT INTO users(username,password,color) VALUES(?,?,?)')
      .run(username, bcrypt.hashSync(password, 10), color);
    const user = { id: info.lastInsertRowid, username };
    res.json({ token: jwt.sign(user, JWT), user });
  } catch { res.status(409).json({ error: 'имя занято' }); }
});

// Вход
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !bcrypt.compareSync(password, u.password))
    return res.status(401).json({ error: 'неверные данные' });
  const user = { id: u.id, username: u.username };
  res.json({ token: jwt.sign(user, JWT), user });
});

// Мидлварь авторизации
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  try { req.user = jwt.verify(t, JWT); next(); }
  catch { res.status(401).json({ error: 'unauthorized' }); }
}

// Серверы
app.get('/api/servers', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT s.* FROM servers s
    JOIN (SELECT DISTINCT server FROM channels) c ON c.server = s.id
  `).all());
});

app.post('/api/servers', auth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'нужно имя' });
  const info = db.prepare('INSERT INTO servers(name,owner) VALUES(?,?)').run(name, req.user.id);
  db.prepare('INSERT INTO channels(server,name) VALUES(?,?)').run(info.lastInsertRowid, 'general');
  res.json(db.prepare('SELECT * FROM servers WHERE id=?').get(info.lastInsertRowid));
});

// Каналы
app.get('/api/servers/:id/channels', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM channels WHERE server=?').all(Number(req.params.id)));
});

app.post('/api/servers/:id/channels', auth, (req, res) => {
  const { name } = req.body;
  const info = db.prepare('INSERT INTO channels(server,name) VALUES(?,?)')
    .run(Number(req.params.id), name);
  res.json(db.prepare('SELECT * FROM channels WHERE id=?').get(info.lastInsertRowid));
});

// Сообщения канала
app.get('/api/channels/:id/messages', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT m.id, m.content, m.created as created_at, u.id as user_id, u.username, u.color as avatar_color
    FROM messages m JOIN users u ON u.id = m.user
    WHERE m.channel = ? ORDER BY m.id DESC LIMIT 50
  `).all(Number(req.params.id)).reverse());
});

// ----- SOCKET.IO -----
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, JWT);
    next();
  } catch { next(new Error('unauthorized')); }
});

io.on('connection', socket => {
  const u = socket.user;

  socket.on('join-channel', id => socket.join('ch:' + id));
  socket.on('leave-channel', id => socket.leave('ch:' + id));

  socket.on('message', ({ channelId, content }, ack) => {
    content = (content || '').trim();
    if (!content || content.length > 4000) return ack?.({ error: 'пусто' });

    const info = db.prepare('INSERT INTO messages(channel,user,content) VALUES(?,?,?)')
      .run(channelId, u.id, content);
    const row = db.prepare('SELECT color FROM users WHERE id=?').get(u.id);

    const msg = {
      id: info.lastInsertRowid, content,
      user_id: u.id, username: u.username, avatar_color: row.color,
      created_at: Math.floor(Date.now() / 1000)
    };
    io.to('ch:' + channelId).emit('message', msg);
    ack?.({ ok: true });
  });

  socket.on('typing', ({ channelId }) => {
    socket.to('ch:' + channelId).emit('typing', { username: u.username });
  });
});

srv.listen(PORT, () => console.log('durzoc на порту ' + PORT));
