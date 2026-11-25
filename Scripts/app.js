/**
 * Zorii UI Controller
 */
document.addEventListener('DOMContentLoaded', () => {
  const cfg = window.ZORII_CONFIG;

  // Elements
  const topbar = document.getElementById('topbar');
  const navHome = document.getElementById('nav-home');
  const userBadge = document.getElementById('user-badge');
  const currentUsernameEl = document.getElementById('current-username');

  const views = {
    auth: document.getElementById('view-auth'),
    menu: document.getElementById('view-menu'),
    join: document.getElementById('view-join'),
    host: document.getElementById('view-host'),
    room: document.getElementById('view-room')
  };

  // Forms & Inputs
  const formAuth = document.getElementById('form-auth');
  const inputUsername = document.getElementById('input-username');

  const btnGoJoin = document.getElementById('btn-go-join');
  const btnGoHost = document.getElementById('btn-go-host');

  const inputSearch = document.getElementById('input-search');
  const btnDirectJoin = document.getElementById('btn-direct-join');
  const btnRefreshRooms = document.getElementById('btn-refresh-rooms');
  const roomsListEl = document.getElementById('rooms-list');

  const formHost = document.getElementById('form-host');
  const hostNameInput = document.getElementById('host-name');
  const hostDescInput = document.getElementById('host-desc');
  const hostMaxInput = document.getElementById('host-max');
  const hostMaxVal = document.getElementById('host-max-val');

  // Room View Elements
  const roomTitleEl = document.getElementById('room-title');
  const roomDescEl = document.getElementById('room-desc');
  const roomHostTag = document.getElementById('room-host-tag');
  const roomCodeText = document.getElementById('room-code-text');
  const btnCopyCode = document.getElementById('btn-copy-code');
  const btnLeaveRoom = document.getElementById('btn-leave-room');
  const chatMessagesEl = document.getElementById('chat-messages');
  const formChat = document.getElementById('form-chat');
  const inputChat = document.getElementById('input-chat');
  const usersCountEl = document.getElementById('users-count');
  const usersListEl = document.getElementById('users-list');
  const toastEl = document.getElementById('toast');

  let toastTimeout = null;

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toastEl.classList.add('hidden');
    }, 2600);
  }

  function showView(viewId) {
    Object.values(views).forEach((v) => v.classList.remove('active'));
    const target = document.getElementById(viewId);
    if (target) target.classList.add('active');

    if (viewId === 'view-auth') {
      topbar.classList.add('hidden');
      setTimeout(() => inputUsername.focus(), 50);
    } else {
      topbar.classList.remove('hidden');
    }

    if (viewId === 'view-join') {
      p2p.requestDiscovery();
      renderRoomsList(p2p.getRooms());
      setTimeout(() => inputSearch.focus(), 50);
    } else if (viewId === 'view-host') {
      setTimeout(() => hostNameInput.focus(), 50);
    } else if (viewId === 'view-room') {
      setTimeout(() => inputChat.focus(), 50);
    }
  }

  // Initialize P2P Engine
  const p2p = new window.ZoriiP2P({
    onRoomsUpdated: (rooms) => {
      if (views.join.classList.contains('active')) {
        renderRoomsList(rooms);
      }
    },
    onRoomJoined: (room, isHost) => {
      roomTitleEl.textContent = room.name;
      roomDescEl.textContent = room.desc || '';
      roomCodeText.textContent = room.id;
      roomHostTag.textContent = isHost ? 'Hosted on your PC' : `Host: ${room.hostName}`;
      chatMessagesEl.innerHTML = '';
      showView('view-room');
    },
    onMembersUpdated: (members, max) => {
      usersCountEl.textContent = `${members.length} / ${max}`;
      usersListEl.innerHTML = '';

      members.forEach((m) => {
        const li = document.createElement('li');
        li.className = 'user-row';

        const left = document.createElement('div');
        left.className = 'user-row-left';

        const dot = document.createElement('span');
        dot.className = 'status-dot';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'user-row-name';
        nameSpan.textContent = m.name;

        left.appendChild(dot);
        left.appendChild(nameSpan);
        li.appendChild(left);

        if (m.isHost) {
          const tag = document.createElement('span');
          tag.className = 'user-tag';
          tag.textContent = 'Host';
          li.appendChild(tag);
        } else if (m.id === p2p.clientId) {
          const tag = document.createElement('span');
          tag.className = 'user-tag';
          tag.textContent = 'You';
          li.appendChild(tag);
        }

        usersListEl.appendChild(li);
      });
    },
    onMessage: (msg) => {
      appendMessageEl(msg);
    },
    onHistorySync: (history) => {
      chatMessagesEl.innerHTML = '';
      history.forEach((m) => appendMessageEl(m));
    },
    onError: (errText) => {
      showToast(errText);
      showView('view-join');
    }
  });

  function appendMessageEl(msg) {
    if (msg.type === 'system') {
      const sys = document.createElement('div');
      sys.className = 'msg-system';
      sys.textContent = msg.text;
      chatMessagesEl.appendChild(sys);
    } else {
      const isSelf = msg.clientId === p2p.clientId;
      const wrap = document.createElement('div');
      wrap.className = 'msg' + (isSelf ? ' self' : '');

      const meta = document.createElement('div');
      meta.className = 'msg-meta';

      const author = document.createElement('span');
      author.className = 'msg-author';
      author.textContent = isSelf ? 'You' : msg.author;

      const time = document.createElement('span');
      time.textContent = msg.time || '';

      meta.appendChild(author);
      meta.appendChild(time);

      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      bubble.textContent = msg.text;

      wrap.appendChild(meta);
      wrap.appendChild(bubble);
      chatMessagesEl.appendChild(wrap);
    }

    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  function renderRoomsList(rooms) {
    const query = inputSearch.value.trim().toLowerCase();
    const filtered = rooms.filter(
      (r) =>
        r.name.toLowerCase().includes(query) ||
        (r.desc && r.desc.toLowerCase().includes(query)) ||
        r.id.toLowerCase().includes(query) ||
        (r.hostName && r.hostName.toLowerCase().includes(query))
    );

    // Show quick direct-connect button if query looks like a room ID
    const cleanCode = inputSearch.value.trim().toUpperCase();
    if (/^[A-Z0-9]{4,8}$/.test(cleanCode)) {
      btnDirectJoin.classList.remove('hidden');
    } else {
      btnDirectJoin.classList.add('hidden');
    }

    roomsListEl.innerHTML = '';

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = query
        ? 'No matching rooms — press Enter to connect by Room ID'
        : 'No active rooms found';
      roomsListEl.appendChild(empty);
      return;
    }

    filtered.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'room-item';
      item.addEventListener('click', () => {
        p2p.joinRoom(r.id);
      });

      const info = document.createElement('div');
      info.className = 'room-item-info';

      const top = document.createElement('div');
      top.className = 'room-item-top';

      const name = document.createElement('span');
      name.className = 'room-item-name';
      name.textContent = r.name;

      const host = document.createElement('span');
      host.className = 'room-item-host';
      host.textContent = r.hostName;

      top.appendChild(name);
      top.appendChild(host);
      info.appendChild(top);

      if (r.desc) {
        const desc = document.createElement('div');
        desc.className = 'room-item-desc';
        desc.textContent = r.desc;
        info.appendChild(desc);
      }

      const count = document.createElement('div');
      count.className = 'room-item-count';
      count.textContent = `${r.count} / ${r.max}`;

      item.appendChild(info);
      item.appendChild(count);
      roomsListEl.appendChild(item);
    });
  }

  // 1. Account (Username only)
  const savedUser = localStorage.getItem(cfg.STORAGE_USER_KEY);
  if (savedUser && savedUser.trim()) {
    loginWithUsername(savedUser.trim());
  }

  function loginWithUsername(name) {
    p2p.setUsername(name);
    localStorage.setItem(cfg.STORAGE_USER_KEY, name);
    currentUsernameEl.textContent = name;
    showView('view-menu');
  }

  formAuth.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = inputUsername.value.trim();
    if (!val) return;
    loginWithUsername(val);
  });

  userBadge.addEventListener('click', () => {
    if (p2p.room) {
      p2p.leaveRoom();
    }
    inputUsername.value = p2p.username;
    showView('view-auth');
  });

  navHome.addEventListener('click', () => {
    if (p2p.room) {
      p2p.leaveRoom();
    }
    showView('view-menu');
  });

  // 2. Main Menu Navigation
  btnGoJoin.addEventListener('click', () => showView('view-join'));
  btnGoHost.addEventListener('click', () => showView('view-host'));

  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => {
      showView(btn.getAttribute('data-back'));
    });
  });

  // 3. Room Browser & Search
  inputSearch.addEventListener('input', () => {
    renderRoomsList(p2p.getRooms());
  });

  inputSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = inputSearch.value.trim().toUpperCase();
      if (code) p2p.joinRoom(code);
    }
  });

  btnDirectJoin.addEventListener('click', () => {
    const code = inputSearch.value.trim().toUpperCase();
    if (code) p2p.joinRoom(code);
  });

  btnRefreshRooms.addEventListener('click', () => {
    p2p.requestDiscovery();
    renderRoomsList(p2p.getRooms());
    showToast('Refreshed');
  });

  // 4. Host Room Form (5 - 100 members)
  hostMaxInput.addEventListener('input', () => {
    hostMaxVal.textContent = hostMaxInput.value;
  });

  formHost.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = hostNameInput.value.trim();
    if (!name) return;
    const desc = hostDescInput.value.trim();
    const max = Number(hostMaxInput.value) || 25;

    p2p.hostRoom({ name, desc, max });
    hostNameInput.value = '';
    hostDescInput.value = '';
  });

  // 5. Room Chat & Controls
  formChat.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = inputChat.value.trim();
    if (!text) return;
    p2p.sendMessage(text);
    inputChat.value = '';
  });

  btnCopyCode.addEventListener('click', () => {
    if (!p2p.room) return;
    navigator.clipboard.writeText(p2p.room.id).then(() => {
      showToast(`Copied ID: ${p2p.room.id}`);
    });
  });

  btnLeaveRoom.addEventListener('click', () => {
    p2p.leaveRoom();
    showView('view-menu');
  });
});
