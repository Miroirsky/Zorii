/**
 * Zorii V2 UI Controller
 * - User colors (8 vibrant swatches on login, applied to user dots, username labels, and chat messages).
 * - Live shared Room Clicker (synced in real time across all players in the room, and visible in the Join menu and immediately on joining).
 */
document.addEventListener('DOMContentLoaded', () => {
  const cfg = window.ZORII_CONFIG;

  // Topbar
  const topbar = document.getElementById('topbar');
  const navHome = document.getElementById('nav-home');
  const userBadge = document.getElementById('user-badge');
  const currentUserDot = document.getElementById('current-user-dot');
  const currentUsernameEl = document.getElementById('current-username');

  // Views
  const views = {
    auth: document.getElementById('view-auth'),
    menu: document.getElementById('view-menu'),
    join: document.getElementById('view-join'),
    host: document.getElementById('view-host'),
    room: document.getElementById('view-room')
  };

  // Auth + Color Picker
  const formAuth = document.getElementById('form-auth');
  const inputUsername = document.getElementById('input-username');
  const colorPickerEl = document.getElementById('color-picker');

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
  const savedRoomsSection = document.getElementById('saved-rooms-section');
  const savedRoomsListEl = document.getElementById('saved-rooms-list');

  // Room / Chat
  const roomTitleEl = document.getElementById('room-title');
  const roomDescEl = document.getElementById('room-desc');
  const roomHostTag = document.getElementById('room-host-tag');
  const roomCodeText = document.getElementById('room-code-text');
  const btnSaveRoom = document.getElementById('btn-save-room');
  const btnCopyCode = document.getElementById('btn-copy-code');
  const btnLeaveRoom = document.getElementById('btn-leave-room');
  const chatMessagesEl = document.getElementById('chat-messages');
  const formChat = document.getElementById('form-chat');
  const inputChat = document.getElementById('input-chat');
  const roomLevelValEl = document.getElementById('room-level-val');
  const roomXpFillEl = document.getElementById('room-xp-fill');
  const roomXpTextEl = document.getElementById('room-xp-text');
  const usersCountEl = document.getElementById('users-count');
  const usersListEl = document.getElementById('users-list');
  const toastEl = document.getElementById('toast');

  let toastTimer = null;
  let lastRenderedSignature = '';
  let renderedMsgCount = 0;
  let selectedColor = localStorage.getItem(cfg.STORAGE_COLOR_KEY) || cfg.USER_COLORS[0];

  // Build color picker swatches
  function initColorPicker() {
    colorPickerEl.innerHTML = '';
    cfg.USER_COLORS.forEach((hex) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch' + (hex === selectedColor ? ' active' : '');
      btn.style.backgroundColor = hex;
      btn.style.color = hex;
      btn.addEventListener('click', () => {
        selectedColor = hex;
        colorPickerEl.querySelectorAll('.color-swatch').forEach((el) => {
          el.classList.toggle('active', el === btn);
        });
      });
      colorPickerEl.appendChild(btn);
    });
  }
  initColorPicker();

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
      initColorPicker();
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
      renderSavedRoomsList();
      setTimeout(() => hostNameInput.focus(), 40);
    } else if (viewId === 'view-room') {
      setTimeout(() => inputChat.focus(), 40);
    }
  }

  function updateRoomXpUI(xpValue) {
    const lvlInfo = p2p.computeRoomLevel(xpValue);
    if (roomLevelValEl) {
      roomLevelValEl.textContent = lvlInfo.level;
    }
    if (roomXpFillEl) {
      roomXpFillEl.style.height = `${lvlInfo.progressPct}%`;
    }
    if (roomXpTextEl) {
      roomXpTextEl.textContent = `${lvlInfo.currentLevelXp} / ${lvlInfo.xpNeeded} XP`;
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
      if (btnSaveRoom) {
        btnSaveRoom.classList.toggle('hidden', !isHost);
      }
      updateRoomXpUI(room.xp);
      showView('view-room');
    },
    onRoomState: ({ room, isHost, members, messages }) => {
      roomTitleEl.textContent = room.name;
      roomDescEl.textContent = room.desc || '';
      roomCodeText.textContent = room.id;
      roomHostTag.textContent = isHost ? 'Hosted on your PC' : `Host: ${room.hostName}`;
      if (btnSaveRoom) {
        btnSaveRoom.classList.toggle('hidden', !isHost);
      }

      // Left vertical XP bar
      updateRoomXpUI(room.xp);

      // Render connected members list with each user's custom color
      usersCountEl.textContent = `${members.length} / ${room.max}`;
      usersListEl.innerHTML = '';

      members.forEach((m) => {
        const li = document.createElement('li');
        li.className = 'user-row';

        const left = document.createElement('div');
        left.className = 'user-row-left';

        const userColor = m.color || cfg.USER_COLORS[0];

        const dot = document.createElement('span');
        dot.className = 'status-dot';
        dot.style.backgroundColor = userColor;
        dot.style.boxShadow = `0 0 8px ${userColor}`;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'user-row-name';
        nameSpan.style.color = userColor;
        nameSpan.textContent = m.name;

        left.appendChild(dot);
        left.appendChild(nameSpan);
        li.appendChild(left);

        const right = document.createElement('div');
        right.className = 'user-row-right';

        if (m.isHost) {
          const tag = document.createElement('span');
          tag.className = 'user-tag';
          tag.textContent = 'Host';
          right.appendChild(tag);
        } else if (m.id === p2p.clientId) {
          const tag = document.createElement('span');
          tag.className = 'user-tag';
          tag.textContent = 'You';
          right.appendChild(tag);
        }

        li.appendChild(right);
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
      const msgColor = msg.color || cfg.USER_COLORS[0];

      const wrap = document.createElement('div');
      wrap.className = 'msg' + (isSelf ? ' self' : '');

      const meta = document.createElement('div');
      meta.className = 'msg-meta';

      const author = document.createElement('span');
      author.className = 'msg-author';
      author.style.color = msgColor;
      author.textContent = isSelf ? 'You' : msg.author;

      const time = document.createElement('span');
      time.textContent = msg.time || '';

      meta.appendChild(author);
      meta.appendChild(time);

      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      bubble.textContent = msg.text;
      if (isSelf) {
        bubble.style.backgroundColor = msgColor;
        bubble.style.borderColor = msgColor;
      } else {
        bubble.style.borderColor = msgColor + '55';
      }

      wrap.appendChild(meta);
      wrap.appendChild(bubble);
      chatMessagesEl.appendChild(wrap);
    }

    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  // Event Delegation on #rooms-list
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

    const filtered = rooms
      .filter(
        (r) =>
          r.name.toLowerCase().includes(query) ||
          (r.desc && r.desc.toLowerCase().includes(query)) ||
          r.id.toLowerCase().includes(query) ||
          (r.hostName && r.hostName.toLowerCase().includes(query))
      )
      .sort((a, b) => {
        const lvlA = p2p.computeRoomLevel(a.xp).level;
        const lvlB = p2p.computeRoomLevel(b.xp).level;
        if (lvlB !== lvlA) return lvlB - lvlA;
        return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
      });

    const cleanCode = rawSearch.toUpperCase();
    if (cleanCode.length >= 3 && /^[A-Z0-9-]+$/.test(cleanCode)) {
      btnDirectJoin.classList.remove('hidden');
    } else {
      btnDirectJoin.classList.add('hidden');
    }

    const signature =
      query +
      '::' +
      filtered
        .map((r) => {
          const lvl = p2p.computeRoomLevel(r.xp).level;
          return `${r.id}:${r.name}:${r.desc}:${r.hostName}:${r.count}:${r.max}:${r.xp || 0}:${lvl}`;
        })
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
      const lvlInfo = p2p.computeRoomLevel(r.xp);
      const item = document.createElement('div');
      item.className = 'room-item';
      item.setAttribute('data-room-id', r.id);

      const info = document.createElement('div');
      info.className = 'room-item-info';

      const top = document.createElement('div');
      top.className = 'room-item-top';

      const levelBadge = document.createElement('span');
      levelBadge.className = 'room-item-level';
      levelBadge.textContent = `Lvl ${lvlInfo.level}`;

      const name = document.createElement('span');
      name.className = 'room-item-name';
      name.textContent = r.name;

      const host = document.createElement('span');
      host.className = 'room-item-host';
      host.textContent = r.hostName;

      top.appendChild(levelBadge);
      top.appendChild(name);
      top.appendChild(host);
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

  // 1. Account (Username + Color)
  const savedUser = localStorage.getItem(cfg.STORAGE_USER_KEY);
  if (savedUser && savedUser.trim()) {
    loginWithProfile(savedUser.trim(), selectedColor);
  }

  function loginWithProfile(name, color) {
    p2p.setProfile(name, color);
    localStorage.setItem(cfg.STORAGE_USER_KEY, name);
    localStorage.setItem(cfg.STORAGE_COLOR_KEY, color);
    currentUsernameEl.textContent = name;
    currentUsernameEl.style.color = color;
    currentUserDot.style.backgroundColor = color;
    currentUserDot.style.boxShadow = `0 0 8px ${color}`;
    showView(p2p.activeRoom ? 'view-room' : 'view-menu');
  }

  formAuth.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = inputUsername.value.trim();
    if (!val) return;
    loginWithProfile(val, selectedColor);
  });

  userBadge.addEventListener('click', () => {
    inputUsername.value = p2p.username;
    showView('view-auth');
  });

  navHome.addEventListener('click', () => {
    if (p2p.activeRoom) {
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

  // 4. Host Room Form & Saved Rooms (5-100 members)
  function renderSavedRoomsList() {
    if (!savedRoomsSection || !savedRoomsListEl) return;
    const savedRooms = p2p.getSavedRooms();
    savedRoomsListEl.innerHTML = '';

    if (savedRooms.length === 0) {
      savedRoomsSection.classList.add('hidden');
      return;
    }

    savedRoomsSection.classList.remove('hidden');

    savedRooms.forEach((sr) => {
      const row = document.createElement('div');
      row.className = 'saved-room-item';

      const info = document.createElement('div');
      info.className = 'saved-room-info';

      const top = document.createElement('div');
      top.className = 'saved-room-top';

      const lvl = document.createElement('span');
      lvl.className = 'room-item-level';
      lvl.textContent = `Lvl ${sr.level}`;

      const title = document.createElement('span');
      title.className = 'saved-room-name';
      title.textContent = sr.name;

      const meta = document.createElement('span');
      meta.className = 'room-item-host';
      meta.textContent = `Max ${sr.max}`;

      top.appendChild(lvl);
      top.appendChild(title);
      top.appendChild(meta);
      info.appendChild(top);

      if (sr.desc) {
        const desc = document.createElement('div');
        desc.className = 'room-item-desc';
        desc.textContent = sr.desc;
        info.appendChild(desc);
      }

      const actions = document.createElement('div');
      actions.className = 'saved-room-actions';

      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.className = 'btn-room-join';
      loadBtn.textContent = 'Host';
      loadBtn.addEventListener('click', () => {
        p2p.hostRoom({
          id: sr.id,
          name: sr.name,
          desc: sr.desc,
          max: sr.max,
          xp: sr.xp
        });
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-icon btn-leave btn-saved-del';
      delBtn.title = 'Delete Saved Room';
      delBtn.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
      delBtn.addEventListener('click', () => {
        p2p.deleteSavedRoom(sr.id);
        renderSavedRoomsList();
        showToast(`Deleted saved room "${sr.name}"`);
      });

      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);

      row.appendChild(info);
      row.appendChild(actions);
      savedRoomsListEl.appendChild(row);
    });
  }

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

  // 5. Room Chat & Save Room Stats
  if (btnSaveRoom) {
    btnSaveRoom.addEventListener('click', () => {
      const saved = p2p.saveCurrentRoomStats();
      if (saved) {
        showToast(`Saved room "${saved.name}" (Lvl ${saved.level}, Max ${saved.max})`);
      }
    });
  }

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
