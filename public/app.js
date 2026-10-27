const app = document.getElementById('app');
const state = {
  token: localStorage.getItem('dz_token'),
  user: JSON.parse(localStorage.getItem('dz_user') || 'null'),
  socket: null, servers: [], channels: [], messages: [],
  currentServer: null, currentChannel: null
};

const api = (url, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  return fetch(url, { ...opts, headers }).then(async r => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'error');
    return d;
  });
};
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const initials = n => (n || '?')[0].toUpperCase();
const fmt = ts => new Date(ts * 1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });

// ---------- АВТОРИЗАЦИЯ ----------
function renderAuth(mode = 'login') {
  app.innerHTML = `
    <div class="auth"><form id="auth-form">
      <h1>${mode === 'login' ? 'Вход в durzoc' : 'Регистрация'}</h1>
      <div class="err" id="err"></div>
      <input id="u" placeholder="Имя" autocomplete="username">
      <input id="p" type="password" placeholder="Пароль">
      <button>${mode === 'login' ? 'Войти' : 'Создать'}</button>
      <div class="switch">${mode === 'login'
        ? 'Нет аккаунта? <a id="sw">Регистрация</a>'
        : 'Есть аккаунт? <a id="sw">Вход</a>'}</div>
    </form></div>`;
  document.getElementById('sw').onclick = () => renderAuth(mode === 'login' ? 'reg' : 'login');
  document.getElementById('auth-form').onsubmit = async e => {
    e.preventDefault();
    const username = document.getElementById('u').value.trim();
    const password = document.getElementById('p').value;
    try {
      const d = await api('/api/' + (mode === 'login' ? 'login' : 'register'),
        { method: 'POST', body: JSON.stringify({ username, password }) });
      state.token = d.token; state.user = d.user;
      localStorage.setItem('dz_token', d.token);
      localStorage.setItem('dz_user', JSON.stringify(d.user));
      enterApp();
    } catch (err) { document.getElementById('err').textContent = err.message; }
  };
}

// ---------- ПРИЛОЖЕНИЕ ----------
async function enterApp() {
  state.servers = await api('/api/servers');
  if (state.socket) state.socket.disconnect();
  state.socket = io({ auth: { token: state.token } });
  state.socket.on('connect_error', logout);
  state.socket.on('message', m => {
    if (m.channel_id !== state.currentChannel && m.id !== undefined) return;
    if (state.messages.some(x => x.id === m.id)) return;
    state.messages.push(m);
    appendMsg(m);
  });
  let tid;
  state.socket.on('typing', ({ username }) => {
    const el = document.getElementById('typing');
    if (!el) return;
    el.textContent = username + ' печатает...';
    clearTimeout(tid);
    tid = setTimeout(() => el.textContent = '', 2000);
  });
  renderLayout();
  if (state.servers.length) selectServer(state.servers[0].id);
}

function renderLayout() {
  app.innerHTML = `
    <div class="layout">
      <div class="servers" id="servers"></div>
      <div class="channels">
        <div class="head" id="srv-head">durzoc</div>
        <div class="list" id="channel-list"></div>
        <div class="user">
          <div class="av" style="background:#5865f2">${initials(state.user.username)}</div>
          <div class="name">${esc(state.user.username)}</div>
          <button id="logout">⏻</button>
        </div>
      </div>
      <div class="chat" id="chat"><div class="empty">Выбери сервер</div></div>
    </div>`;
  document.getElementById('logout').onclick = logout;
  renderServers();
}

function renderServers() {
  const el = document.getElementById('servers');
  el.innerHTML = state.servers.map(s => `
    <button class="srv ${s.id === state.currentServer ? 'active' : ''}"
      data-id="${s.id}" title="${esc(s.name)}">${esc(initials(s.name))}</button>
  `).join('') + `<button class="srv add" id="add-srv">+</button>`;
  el.querySelectorAll('.srv[data-id]').forEach(b =>
    b.onclick = () => selectServer(Number(b.dataset.id)));
  document.getElementById('add-srv').onclick = async () => {
    const name = prompt('Название сервера:');
    if (!name) return;
    const s = await api('/api/servers', { method:'POST', body: JSON.stringify({ name }) });
    state.servers.push(s); renderServers(); selectServer(s.id);
  };
}

async function selectServer(id) {
  state.currentServer = id; state.currentChannel = null; state.messages = [];
  renderServers();
  const s = state.servers.find(x => x.id === id);
  document.getElementById('srv-head').textContent = s?.name || 'durzoc';
  state.channels = await api(`/api/servers/${id}/channels`);
  renderChannels();
  if (state.channels.length) selectChannel(state.channels[0].id);
  else document.getElementById('chat').innerHTML = '<div class="empty">Нет каналов</div>';
}

function renderChannels() {
  const el = document.getElementById('channel-list');
  el.innerHTML = state.channels.map(c => `
    <button class="btn ${c.id === state.currentChannel ? 'active' : ''}"
      data-id="${c.id}">${esc(c.name)}</button>
  `).join('') + `<button class="add" id="add-ch">+ канал</button>`;
  el.querySelectorAll('.btn').forEach(b =>
    b.onclick = () => selectChannel(Number(b.dataset.id)));
  document.getElementById('add-ch').onclick = async () => {
    const name = prompt('Название канала:');
    if (!name) return;
    const c = await api(`/api/servers/${state.currentServer}/channels`,
      { method:'POST', body: JSON.stringify({ name }) });
    state.channels.push(c); renderChannels();
  };
}

async function selectChannel(id) {
  if (state.currentChannel) state.socket.emit('leave-channel', state.currentChannel);
  state.currentChannel = id; state.messages = [];
  renderChannels();
  state.socket.emit('join-channel', id);
  state.messages = await api(`/api/channels/${id}/messages`);
  renderChat();
}

function renderChat() {
  const ch = state.channels.find(c => c.id === state.currentChannel);
  if (!ch) return;
  const chat = document.getElementById('chat');
  chat.innerHTML = `
    <div class="head"># ${esc(ch.name)}</div>
    <div class="msgs" id="msgs"></div>
    <div class="typing" id="typing"></div>
    <div class="composer"><div class="inner">
      <input id="msg-input" placeholder="Сообщение..." maxlength="4000" autocomplete="off">
      <button id="send" disabled>→</button>
    </div></div>`;
  state.messages.forEach(appendMsg);
  const inp = document.getElementById('msg-input');
  const btn = document.getElementById('send');
  inp.oninput = () => {
    btn.disabled = !inp.value.trim();
    if (inp.value.trim()) state.socket.emit('typing', { channelId: state.currentChannel });
  };
  const send = () => {
    const content = inp.value.trim();
    if (!content) return;
    inp.value = ''; btn.disabled = true;
    state.socket.emit('message', { channelId: state.currentChannel, content });
  };
  btn.onclick = send;
  inp.onkeydown = e => { if (e.key === 'Enter') send(); };
  inp.focus();
}

function appendMsg(m) {
  const el = document.getElementById('msgs');
  if (!el) return;
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `
    <div class="av" style="background:${esc(m.avatar_color || '#5865f2')}">${initials(m.username)}</div>
    <div class="body">
      <div class="meta">
        <span class="author">${esc(m.username)}</span>
        <span class="time">${fmt(m.created_at)}</span>
      </div>
      <div class="text">${esc(m.content)}</div>
    </div>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function logout() {
  localStorage.clear();
  state.token = null; state.user = null;
  if (state.socket) state.socket.disconnect();
  renderAuth('login');
}

if (state.token && state.user) enterApp().catch(logout);
else renderAuth('login');
