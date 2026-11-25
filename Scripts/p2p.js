/**
 * Zorii Client-Side P2P Engine
 * - When a user hosts a room, THEIR browser acts as the authoritative host server.
 * - Chat, member validation (5-100 cap), and presence run directly on the host user's computer.
 * - Uses WebRTC DataChannels (PeerJS) + Local BroadcastChannel fallback for instant zero-latency local tabs,
 *   and MQTT over WebSockets + localStorage for decentralized room discovery.
 */
class ZoriiP2P {
  constructor(callbacks) {
    this.cb = callbacks || {};
    this.cfg = window.ZORII_CONFIG;
    this.clientId = 'u_' + Math.random().toString(36).slice(2, 10);
    this.username = '';

    // Discovery state
    this.discoveredRooms = new Map();
    this.mqttClient = null;
    this.bus = typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(this.cfg.BROADCAST_CHANNEL)
      : null;

    // Active room state
    this.mode = null; // 'host' | 'guest' | null
    this.room = null; // { id, name, desc, max, hostName, hostId }
    this.peer = null;
    this.hostConn = null; // Guest's WebRTC connection to host
    this.guestConns = new Map(); // Host's WebRTC connections: clientId -> conn
    this.members = new Map(); // clientId -> { id, name, isHost, transport }
    this.messages = [];
    this.heartbeatTimer = null;

    this._initDiscovery();
  }

  setUsername(name) {
    this.username = name.trim();
  }

  /* =========================================================
   * DECENTRALIZED ROOM DISCOVERY (Local Bus + Storage + MQTT)
   * ========================================================= */
  _initDiscovery() {
    // 1. Load cached rooms from localStorage
    try {
      const raw = localStorage.getItem(this.cfg.STORAGE_ROOMS_KEY);
      if (raw) {
        const list = JSON.parse(raw);
        const now = Date.now();
        list.forEach((r) => {
          if (now - r.updatedAt < this.cfg.ROOM_TTL_MS) {
            this.discoveredRooms.set(r.id, r);
          }
        });
      }
    } catch (_) {}

    // 2. Listen to local BroadcastChannel (for same-machine tabs & local P2P relay)
    if (this.bus) {
      this.bus.onmessage = (ev) => this._handleBusPacket(ev.data);
      this.bus.postMessage({ type: 'DISCOVER_REQ' });
    }

    // 3. Listen to storage events across tabs
    window.addEventListener('storage', (ev) => {
      if (ev.key === this.cfg.STORAGE_ROOMS_KEY) {
        this._syncFromStorage();
      }
    });

    // 4. Connect to public WebSocket MQTT broker for cross-computer room browser
    this._connectMqtt();

    // 5. Periodic cleanup of stale rooms
    setInterval(() => this._pruneRooms(), 3500);

    // 6. Clean disconnect when closing tab
    window.addEventListener('beforeunload', () => {
      this.leaveRoom();
    });
  }

  _connectMqtt() {
    if (typeof mqtt === 'undefined') return;
    try {
      this.mqttClient = mqtt.connect(this.cfg.MQTT_BROKERS[0], {
        clientId: 'zorii_' + this.clientId,
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 8000
      });

      this.mqttClient.on('connect', () => {
        this.mqttClient.subscribe(this.cfg.DISCOVERY_TOPIC);
        this.requestDiscovery();
      });

      this.mqttClient.on('message', (topic, payload) => {
        if (topic !== this.cfg.DISCOVERY_TOPIC) return;
        try {
          const data = JSON.parse(payload.toString());
          this._handleDiscoveryPacket(data);
        } catch (_) {}
      });
    } catch (_) {}
  }

  requestDiscovery() {
    if (this.bus) {
      this.bus.postMessage({ type: 'DISCOVER_REQ' });
    }
    if (this.mqttClient && this.mqttClient.connected) {
      this.mqttClient.publish(
        this.cfg.DISCOVERY_TOPIC,
        JSON.stringify({ type: 'DISCOVER_REQ' })
      );
    }
    this._pruneRooms();
  }

  _handleDiscoveryPacket(pkt) {
    if (!pkt || !pkt.type) return;

    if (pkt.type === 'DISCOVER_REQ') {
      if (this.mode === 'host' && this.room) {
        this._announceRoom();
      }
      return;
    }

    if (pkt.type === 'ROOM_ANNOUNCE' && pkt.room) {
      const r = pkt.room;
      r.updatedAt = Date.now();
      this.discoveredRooms.set(r.id, r);
      this._persistRooms();
      if (this.cb.onRoomsUpdated) {
        this.cb.onRoomsUpdated(this.getRooms());
      }
      return;
    }

    if (pkt.type === 'ROOM_CLOSE' && pkt.roomId) {
      this.discoveredRooms.delete(pkt.roomId);
      this._persistRooms();
      if (this.cb.onRoomsUpdated) {
        this.cb.onRoomsUpdated(this.getRooms());
      }
    }
  }

  _syncFromStorage() {
    try {
      const raw = localStorage.getItem(this.cfg.STORAGE_ROOMS_KEY);
      if (!raw) return;
      const list = JSON.parse(raw);
      const now = Date.now();
      list.forEach((r) => {
        if (now - r.updatedAt < this.cfg.ROOM_TTL_MS) {
          this.discoveredRooms.set(r.id, r);
        }
      });
      if (this.cb.onRoomsUpdated) {
        this.cb.onRoomsUpdated(this.getRooms());
      }
    } catch (_) {}
  }

  _persistRooms() {
    try {
      const arr = Array.from(this.discoveredRooms.values());
      localStorage.setItem(this.cfg.STORAGE_ROOMS_KEY, JSON.stringify(arr));
    } catch (_) {}
  }

  _pruneRooms() {
    const now = Date.now();
    let changed = false;
    for (const [id, r] of this.discoveredRooms.entries()) {
      if (now - r.updatedAt > this.cfg.ROOM_TTL_MS) {
        this.discoveredRooms.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this._persistRooms();
    }
    if (this.cb.onRoomsUpdated) {
      this.cb.onRoomsUpdated(this.getRooms());
    }
  }

  getRooms() {
    return Array.from(this.discoveredRooms.values()).sort(
      (a, b) => b.count - a.count || b.updatedAt - a.updatedAt
    );
  }

  /* =========================================================
   * HOSTING A ROOM ON THE USER'S COMPUTER
   * ========================================================= */
  hostRoom({ name, desc, max }) {
    this.leaveRoom();

    const cleanMax = Math.min(
      this.cfg.MAX_MEMBERS,
      Math.max(this.cfg.MIN_MEMBERS, Number(max) || 25)
    );
    const roomId = this._generateRoomCode();

    this.mode = 'host';
    this.room = {
      id: roomId,
      name: name.trim(),
      desc: (desc || '').trim(),
      max: cleanMax,
      hostName: this.username,
      hostId: this.clientId,
      count: 1,
      updatedAt: Date.now()
    };

    this.members.clear();
    this.members.set(this.clientId, {
      id: this.clientId,
      name: this.username,
      isHost: true,
      transport: 'self'
    });

    this.messages = [];

    // Spin up WebRTC PeerJS host node on this user's machine
    if (typeof Peer !== 'undefined') {
      try {
        this.peer = new Peer(this.cfg.APP_PREFIX + roomId);
        this.peer.on('connection', (conn) => this._setupHostWebRTCConn(conn));
        this.peer.on('error', () => {
          // Even if PeerJS public cloud has an issue, local BroadcastChannel P2P continues working seamlessly
        });
      } catch (_) {}
    }

    // Start heartbeat announcements from host machine
    this._announceRoom();
    this.heartbeatTimer = setInterval(() => {
      if (this.mode === 'host') this._announceRoom();
    }, this.cfg.HEARTBEAT_MS);

    if (this.cb.onRoomJoined) {
      this.cb.onRoomJoined(this.room, true);
    }
    this._emitMembers();
    this._addSystemMessage(`Hosting room on your computer (${roomId})`);
  }

  _announceRoom() {
    if (this.mode !== 'host' || !this.room) return;
    this.room.count = this.members.size;
    this.room.updatedAt = Date.now();

    const pkt = {
      type: 'ROOM_ANNOUNCE',
      room: { ...this.room }
    };

    this._handleDiscoveryPacket(pkt);
    if (this.bus) this.bus.postMessage(pkt);
    if (this.mqttClient && this.mqttClient.connected) {
      this.mqttClient.publish(this.cfg.DISCOVERY_TOPIC, JSON.stringify(pkt));
    }
  }

  _setupHostWebRTCConn(conn) {
    conn.on('data', (data) => {
      if (this.mode !== 'host') return;
      this._handleHostIncoming(data, (reply) => {
        try { conn.send(reply); } catch (_) {}
      }, conn);
    });

    conn.on('close', () => {
      if (conn._zoriiClientId) {
        this._removeMemberOnHost(conn._zoriiClientId);
      }
    });
  }

  /* =========================================================
   * JOINING A HOST'S COMPUTER (WebRTC + Local Bus Dual Path)
   * ========================================================= */
  joinRoom(roomId) {
    const cleanId = roomId.trim().toUpperCase();
    if (!cleanId) return;
    this.leaveRoom();

    this.mode = 'guest';
    const known = this.discoveredRooms.get(cleanId);
    this.room = known
      ? { ...known }
      : {
          id: cleanId,
          name: cleanId,
          desc: 'Connecting to host...',
          max: 25,
          hostName: 'Host',
          count: 1
        };

    let joinedConfirmed = false;

    const onHandshakeTimeout = setTimeout(() => {
      if (!joinedConfirmed && this.mode === 'guest') {
        if (this.cb.onError) this.cb.onError('Host unreachable or room closed');
        this.leaveRoom();
      }
    }, 6500);

    this._onGuestWelcome = (pkt) => {
      if (joinedConfirmed) return;
      joinedConfirmed = true;
      clearTimeout(onHandshakeTimeout);

      this.room = pkt.room;
      this._syncMembersList(pkt.members);
      this.messages = pkt.history || [];

      if (this.cb.onRoomJoined) {
        this.cb.onRoomJoined(this.room, false);
      }
      this._emitMembers();
      if (this.cb.onHistorySync) {
        this.cb.onHistorySync(this.messages);
      }
    };

    // Path A: Instant local BroadcastChannel P2P handshake (if host is on same device/browser)
    if (this.bus) {
      this.bus.postMessage({
        type: 'P2P_PACKET',
        roomId: cleanId,
        target: 'HOST',
        payload: {
          action: 'JOIN_REQ',
          clientId: this.clientId,
          username: this.username
        }
      });
    }

    // Path B: WebRTC PeerJS connection to remote host's computer
    if (typeof Peer !== 'undefined') {
      try {
        this.peer = new Peer();
        this.peer.on('open', () => {
          if (joinedConfirmed || this.mode !== 'guest') return;
          const conn = this.peer.connect(this.cfg.APP_PREFIX + cleanId, {
            reliable: true
          });
          this.hostConn = conn;

          conn.on('open', () => {
            if (joinedConfirmed) return;
            conn.send({
              action: 'JOIN_REQ',
              clientId: this.clientId,
              username: this.username
            });
          });

          conn.on('data', (data) => this._handleGuestIncoming(data));
          conn.on('close', () => {
            if (this.mode === 'guest') {
              if (this.cb.onError) this.cb.onError('Host closed the room');
              this.leaveRoom();
            }
          });
        });
      } catch (_) {}
    }
  }

  /* =========================================================
   * HOST-SIDE AUTHORITATIVE MULTIPLAYER LOGIC
   * ========================================================= */
  _handleHostIncoming(payload, replyFn, webrtcConn) {
    if (!payload || !payload.action) return;

    if (payload.action === 'JOIN_REQ') {
      const { clientId, username } = payload;
      if (!clientId || !username) return;

      // Enforce max members (5-100)
      if (!this.members.has(clientId) && this.members.size >= this.room.max) {
        replyFn({
          action: 'JOIN_REJECT',
          reason: `Room is full (${this.room.max}/${this.room.max})`
        });
        return;
      }

      if (webrtcConn) {
        webrtcConn._zoriiClientId = clientId;
        this.guestConns.set(clientId, webrtcConn);
      }

      const isNew = !this.members.has(clientId);
      this.members.set(clientId, {
        id: clientId,
        name: username,
        isHost: false,
        transport: webrtcConn ? 'webrtc' : 'bus'
      });

      replyFn({
        action: 'WELCOME',
        room: this.room,
        members: Array.from(this.members.values()),
        history: this.messages.slice(-60)
      });

      if (isNew) {
        this._emitMembers();
        this._announceRoom();
        this._broadcastFromHost({
          action: 'STATE_SYNC',
          room: this.room,
          members: Array.from(this.members.values())
        });
        this._broadcastSystemFromHost(`${username} joined`);
      }
      return;
    }

    if (payload.action === 'CHAT_SEND') {
      const sender = this.members.get(payload.clientId);
      if (!sender) return;
      const text = (payload.text || '').trim();
      if (!text) return;

      const msg = {
        id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        clientId: sender.id,
        author: sender.name,
        text: text.slice(0, 500),
        time: this._formatTime(new Date()),
        type: 'user'
      };

      this.messages.push(msg);
      if (this.cb.onMessage) this.cb.onMessage(msg);
      this._broadcastFromHost({ action: 'CHAT_MSG', msg });
      return;
    }

    if (payload.action === 'LEAVE') {
      this._removeMemberOnHost(payload.clientId);
    }
  }

  _removeMemberOnHost(clientId) {
    if (this.mode !== 'host') return;
    const member = this.members.get(clientId);
    if (!member) return;

    this.members.delete(clientId);
    this.guestConns.delete(clientId);
    this._emitMembers();
    this._announceRoom();

    this._broadcastFromHost({
      action: 'STATE_SYNC',
      room: this.room,
      members: Array.from(this.members.values())
    });
    this._broadcastSystemFromHost(`${member.name} left`);
  }

  _broadcastFromHost(packet) {
    if (this.mode !== 'host' || !this.room) return;

    // 1. Send over WebRTC connections
    for (const conn of this.guestConns.values()) {
      try { conn.send(packet); } catch (_) {}
    }

    // 2. Send over local BroadcastChannel
    if (this.bus) {
      this.bus.postMessage({
        type: 'P2P_PACKET',
        roomId: this.room.id,
        target: 'ALL_GUESTS',
        payload: packet
      });
    }
  }

  _broadcastSystemFromHost(text) {
    const msg = {
      id: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      text,
      type: 'system'
    };
    this.messages.push(msg);
    if (this.cb.onMessage) this.cb.onMessage(msg);
    this._broadcastFromHost({ action: 'CHAT_MSG', msg });
  }

  /* =========================================================
   * GUEST-SIDE INCOMING PACKETS
   * ========================================================= */
  _handleGuestIncoming(payload) {
    if (!payload || !payload.action || this.mode !== 'guest') return;

    if (payload.action === 'JOIN_REJECT') {
      if (this.cb.onError) this.cb.onError(payload.reason || 'Cannot join room');
      this.leaveRoom();
      return;
    }

    if (payload.action === 'WELCOME') {
      if (this._onGuestWelcome) this._onGuestWelcome(payload);
      return;
    }

    if (payload.action === 'STATE_SYNC') {
      if (payload.room) this.room = payload.room;
      this._syncMembersList(payload.members || []);
      this._emitMembers();
      return;
    }

    if (payload.action === 'CHAT_MSG' && payload.msg) {
      if (!this.messages.some((m) => m.id === payload.msg.id)) {
        this.messages.push(payload.msg);
        if (this.cb.onMessage) this.cb.onMessage(payload.msg);
      }
      return;
    }

    if (payload.action === 'ROOM_CLOSED') {
      if (this.cb.onError) this.cb.onError('Host closed the room');
      this.leaveRoom();
    }
  }

  _handleBusPacket(pkt) {
    if (!pkt || !pkt.type) return;

    if (
      pkt.type === 'DISCOVER_REQ' ||
      pkt.type === 'ROOM_ANNOUNCE' ||
      pkt.type === 'ROOM_CLOSE'
    ) {
      this._handleDiscoveryPacket(pkt);
      return;
    }

    if (pkt.type === 'P2P_PACKET' && this.room && pkt.roomId === this.room.id) {
      if (this.mode === 'host' && pkt.target === 'HOST') {
        this._handleHostIncoming(pkt.payload, (reply) => {
          this.bus.postMessage({
            type: 'P2P_PACKET',
            roomId: this.room.id,
            target: pkt.payload.clientId,
            payload: reply
          });
        });
      } else if (
        this.mode === 'guest' &&
        (pkt.target === this.clientId || pkt.target === 'ALL_GUESTS')
      ) {
        this._handleGuestIncoming(pkt.payload);
      }
    }
  }

  /* =========================================================
   * SENDING CHAT & LEAVING
   * ========================================================= */
  sendMessage(text) {
    const clean = (text || '').trim();
    if (!clean || !this.room) return;

    if (this.mode === 'host') {
      this._handleHostIncoming({
        action: 'CHAT_SEND',
        clientId: this.clientId,
        text: clean
      });
    } else if (this.mode === 'guest') {
      const pkt = {
        action: 'CHAT_SEND',
        clientId: this.clientId,
        text: clean
      };
      if (this.hostConn && this.hostConn.open) {
        this.hostConn.send(pkt);
      } else if (this.bus) {
        this.bus.postMessage({
          type: 'P2P_PACKET',
          roomId: this.room.id,
          target: 'HOST',
          payload: pkt
        });
      }
    }
  }

  leaveRoom() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.mode === 'host' && this.room) {
      this._broadcastFromHost({ action: 'ROOM_CLOSED' });
      const closePkt = { type: 'ROOM_CLOSE', roomId: this.room.id };
      this._handleDiscoveryPacket(closePkt);
      if (this.bus) this.bus.postMessage(closePkt);
      if (this.mqttClient && this.mqttClient.connected) {
        this.mqttClient.publish(this.cfg.DISCOVERY_TOPIC, JSON.stringify(closePkt));
      }
    } else if (this.mode === 'guest' && this.room) {
      const leavePkt = { action: 'LEAVE', clientId: this.clientId };
      if (this.hostConn && this.hostConn.open) {
        try { this.hostConn.send(leavePkt); } catch (_) {}
      }
      if (this.bus) {
        this.bus.postMessage({
          type: 'P2P_PACKET',
          roomId: this.room.id,
          target: 'HOST',
          payload: leavePkt
        });
      }
    }

    if (this.hostConn) {
      try { this.hostConn.close(); } catch (_) {}
      this.hostConn = null;
    }

    for (const conn of this.guestConns.values()) {
      try { conn.close(); } catch (_) {}
    }
    this.guestConns.clear();

    if (this.peer) {
      try { this.peer.destroy(); } catch (_) {}
      this.peer = null;
    }

    this.mode = null;
    this.room = null;
    this.members.clear();
    this.messages = [];
  }

  /* =========================================================
   * HELPERS
   * ========================================================= */
  _syncMembersList(list) {
    this.members.clear();
    list.forEach((m) => this.members.set(m.id, m));
  }

  _emitMembers() {
    if (this.cb.onMembersUpdated && this.room) {
      this.cb.onMembersUpdated(
        Array.from(this.members.values()),
        this.room.max
      );
    }
  }

  _addSystemMessage(text) {
    const msg = {
      id: 'sys_' + Date.now(),
      text,
      type: 'system'
    };
    this.messages.push(msg);
    if (this.cb.onMessage) this.cb.onMessage(msg);
  }

  _generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  _formatTime(date) {
    return date.toTimeString().slice(0, 5);
  }
}

window.ZoriiP2P = ZoriiP2P;
