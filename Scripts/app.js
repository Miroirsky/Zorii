/**
 * Zorii V2 UI Controller
 * - Uses Event Delegation on `#rooms-list` so room clicks never get lost during live list updates.
 * - Renders authoritative room state (title, host computer badge, connected users, and chat history).
 */
document.addEventListener('DOMContentLoaded', () => {
  const cfg = window.ZORII_CONFIG;

  // Topbar
  const topbar = document.getElementById('topbar');
  const navHome = document.getElementById('nav-home');
  const userBadge = document.getElementById('user-badge');
  const currentUsernameEl = document.getElementById('current-username');

  // Views
  const views = {
    auth: document.getElementById('view-auth'),
    menu: document.getElementById('view-menu'),
    join: document.getElementById('view-join'),
    host: document.getElementById('view-host'),
    room: document.getElementById('view-room')
  };

  // Auth
  const formAuth = document.getElementById('form-auth');
  const inputUsername = document.getElementById('input-username');

  // Main Menu
  const btnGoJoin = document.getElementById('btn-go-join');
  const btnGoHost = document.getElementById('btn-go-host');

  // Join / Search
  const inputSearch = document.getElementById('input-search');
  const btnDirectJoin = document.getElementById('btn-direct-join');
  const btnRefreshRooms = document.getElementById('btn-refresh-rooms');
  const roomsListEl = document.getElementById('rooms-list');

  // Host Setup
  const formHost = document.getElementById('form-host');
  const hostNameInput = document.getElementById('host-name');
  const hostDescInput = document.getElementById('host-desc');
  const hostMaxInput = document.getElementById('host-max');
  const hostMaxVal = document.getElementById('host-max-val');

  // Room / Chat
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

  let toastTimer = null;
  let lastRenderedSignature = '';
  let renderedMsgCount = 0;

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.add('hidden');
    }, 2600);
  }

  function showView(viewId) {
    Object.values(views).forEach((v) => v.classList.remove('active'));
    const target = document.getElementById(viewId);
    if (target) target.classList.add('active');

    if (viewId === 'view-auth') {
      topbar.classList.add('hidden');
      setTimeout(() => inputUsername.focus(), 40);
    } else {
      topbar.classList.remove('hidden');
    }

    if (viewId === 'view-join') {
      lastRenderedSignature = '';
      p2p.requestDiscovery();
      renderRoomsList(p2p.getRooms(), true);
      setTimeout(() => inputSearch.focus(), 40);
    } else if (viewId === 'view-host') {
      setTimeout(() => hostNameInput.focus(), 40);
    } else if (viewId === 'view-room') {
      setTimeout(() => inputChat.focus(), 40);
    }
  }

  // Instantiate Zorii Engine
  const p2p = new window.ZoriiP2P({
    onRoomsChanged: (rooms) => {
      if (views.join.classList.contains('active')) {
        renderRoomsList(rooms, false);
      }
    },
    onEnterRoom: (room, isHost) => {
      renderedMsgCount = 0;
      chatMessagesEl.innerHTML = '';
      roomTitleEl.textContent = room.name;
      roomDescEl.textContent = room.desc || '';
      roomCodeText.textContent = room.id;
      roomHostTag.textContent = isHost ? 'Hosted on your PC' : `Host: ${room.hostName}`;
      showView('view-room');
    },
    onRoomState: ({ room, isHost, members, messages }) => {
      roomTitleEl.textContent = room.name;
      roomDescEl.textContent = room.desc || '';
      roomCodeText.textContent = room.id;
      roomHostTag.textContent = isHost ? 'Hosted on your PC' : `Host: ${room.hostName}`;

      // Render connected members list
      usersCountEl.textContent = `${members.length} / ${room.max}`;
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

      // Render messages efficiently
      if (messages.length < renderedMsgCount) {
        chatMessagesEl.innerHTML = '';
        renderedMsgCount = 0;
      }
      for (let i = renderedMsgCount; i < messages.length; i++) {
        appendMessageNode(messages[i]);
      }
      renderedMsgCount = messages.length;
    },
    onError: (errText) => {
      showToast(errText);
      showView('view-join');
    }
  });

  function appendMessageNode(msg) {
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

  // Event Delegation on #rooms-list so clicking a room card or Join button ALWAYS fires immediately
  function handleRoomListActivate(e) {
    const card = e.target.closest('[data-room-id]');
    if (!card) return;
    e.preventDefault();
    const roomId = card.getAttribute('data-room-id');
    if (roomId) {
      p2p.joinRoom(roomId);
    }
  }

  roomsListEl.addEventListener('click', handleRoomListActivate);

  function renderRoomsList(rooms, force) {
    const rawSearch = inputSearch.value.trim();
    const query = rawSearch.toLowerCase();

    const filtered = rooms.filter(
      (r) =>
        r.name.toLowerCase().includes(query) ||
        (r.desc && r.desc.toLowerCase().includes(query)) ||
        r.id.toLowerCase().includes(query) ||
        (r.hostName && r.hostName.toLowerCase().includes(query))
    );

    const cleanCode = rawSearch.toUpperCase();
    if (cleanCode.length >= 3 && /^[A-Z0-9-]+$/.test(cleanCode)) {
      btnDirectJoin.classList.remove('hidden');
    } else {
      btnDirectJoin.classList.add('hidden');
    }

    // Compute signature so we NEVER rebuild DOM if nothing visually changed
    const signature =
      query +
      '::' +
      filtered
        .map((r) => `${r.id}:${r.name}:${r.desc}:${r.hostName}:${r.count}:${r.max}`)
        .join('|');

    if (!force && signature === lastRenderedSignature) {
      return;
    }
    lastRenderedSignature = signature;

    roomsListEl.innerHTML = '';

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = query
        ? 'No matching rooms — click Connect or press Enter to join by ID'
        : 'No active rooms found';
      roomsListEl.appendChild(empty);
      return;
    }

    filtered.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'room-item';
      item.setAttribute('data-room-id', r.id);

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

      const codeBadge = document.createElement('span');
      codeBadge.className = 'room-item-host';
      codeBadge.textContent = `#${r.id}`;

      top.appendChild(name);
      top.appendChild(host);
      top.appendChild(codeBadge);
      info.appendChild(top);

      if (r.desc) {
        const desc = document.createElement('div');
        desc.className = 'room-item-desc';
        desc.textContent = r.desc;
        info.appendChild(desc);
      }

      const rightWrap = document.createElement('div');
      rightWrap.className = 'room-item-right';

      const count = document.createElement('div');
      count.className = 'room-item-count';
      count.textContent = `${r.count} / ${r.max}`;

      const joinBtn = document.createElement('button');
      joinBtn.type = 'button';
      joinBtn.className = 'btn-room-join';
      joinBtn.setAttribute('data-room-id', r.id);
      joinBtn.textContent = 'Join';

      rightWrap.appendChild(count);
      rightWrap.appendChild(joinBtn);

      item.appendChild(info);
      item.appendChild(rightWrap);
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
    inputUsername.value = p2p.username;
    showView('view-auth');
  });

  navHome.addEventListener('click', () => {
    if (p2p.activeRoom) {
      // If user clicks brand logo while in menu, return to active room or menu
      if (views.room.classList.contains('active')) {
        showView('view-menu');
      } else {
        showView('view-room');
      }
    } else {
      showView('view-menu');
    }
  });

  // 2. Main Menu
  btnGoJoin.addEventListener('click', () => showView('view-join'));
  btnGoHost.addEventListener('click', () => showView('view-host'));

  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => {
      showView(btn.getAttribute('data-back'));
    });
  });

  // 3. Search & Direct Join
  inputSearch.addEventListener('input', () => {
    renderRoomsList(p2p.getRooms(), true);
  });

  inputSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const raw = inputSearch.value.trim();
      if (!raw) return;
      // If a room matches the search query, join the first matching room; otherwise join by Room ID code
      const rooms = p2p.getRooms();
      const exactOrFirst = rooms.find(
        (r) =>
          r.id.toLowerCase() === raw.toLowerCase() ||
          r.name.toLowerCase() === raw.toLowerCase()
      );
      if (exactOrFirst) {
        p2p.joinRoom(exactOrFirst.id);
      } else {
        p2p.joinRoom(raw.toUpperCase());
      }
    }
  });

  btnDirectJoin.addEventListener('click', () => {
    const raw = inputSearch.value.trim();
    if (!raw) return;
    const rooms = p2p.getRooms();
    const exactOrFirst = rooms.find(
      (r) =>
        r.id.toLowerCase() === raw.toLowerCase() ||
        r.name.toLowerCase() === raw.toLowerCase()
    );
    if (exactOrFirst) {
      p2p.joinRoom(exactOrFirst.id);
    } else {
      p2p.joinRoom(raw.toUpperCase());
    }
  });

  btnRefreshRooms.addEventListener('click', () => {
    p2p.requestDiscovery();
    renderRoomsList(p2p.getRooms(), true);
    showToast('Refreshed rooms');
  });

  // 4. Host Room Form (5-100 members)
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
    if (!p2p.activeRoom) return;
    navigator.clipboard.writeText(p2p.activeRoom.id).then(() => {
      showToast(`Copied Room ID: ${p2p.activeRoom.id}`);
    });
  });

  btnLeaveRoom.addEventListener('click', () => {
    p2p.leaveRoom();
    showView('view-menu');
  });
});
