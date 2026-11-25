/**
 * Zorii Client-Side P2P Engine
 * - When a user hosts a room, THEIR browser acts as the authoritative host server.
 * - Chat, member validation (5-100 cap), and presence run directly on the host user's computer.
 * - Multi-transport delivery ensures connections never fail across file://, localhost, or remote networks:
 *   1. WebRTC DataChannel (PeerJS)
 *   2. MQTT over WebSockets P2P tunnel (works across file:// tabs, different browsers, and different PCs)
 *   3. Local BroadcastChannel + localStorage event bridge (instant zero-latency local tabs)
 */
class ZoriiP2P {
  constructor(callbacks) {
    this.cb = callbacks || {};
    this.cfg = window.ZORII_CONFIG;
    this.clientId = 'u_' + Math.random().toString(36).slice(2, 10);
    this.username = '';

    // Discovery state
    this.discoveredRooms = new Map();
    this.mqttClients = [];
    this.subscribedRoomTopics = new Set();
    this.seenPacketIds = new Set();

    this.bus = typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(this.cfg.BROADCAST_CHANNEL)
      : null;

    // Active room state
    this.mode = null; // 'host' | 'guest' | null
    this.room = null; // { id, name, desc, max, hostName, hostId }
    this.peer = null;
    this.hostConn = null; // Guest's WebRTC connection to host
    this.guestConns = new Map(); // Host's WebRTC connections: clientId -> conn
    this.members = new Map(); // clientId -> { id, name, isHost, lastSeen }
    this.messages = [];
    this.heartbeatTimer = null;
    this.joinRetryTimer = null;
    this.joinTimeoutTimer = null;

    this._initTransports();
  }

  setUsername(name) {
    this.username = name.trim();
  }

  /* =========================================================
   * MULTI-TRANSPORT SETUP (BroadcastChannel + Storage + MQTT)
   * ========================================================= */
  _initTransports() {
    // 1. Load cached rooms from localStorage
    this._syncFromStorage();

    // 2. BroadcastChannel listener
    if (this.bus) {
      this.bus.onmessage = (ev) => this._onRawPacket(ev.data);
    }

    // 3. localStorage event listener (works even when file:// isolates BroadcastChannel)
    window.addEventListener('storage', (ev) => {
      if (ev.key === this.cfg.STORAGE_ROOMS_KEY) {
        this._syncFromStorage();
      } else if (ev.key === 'zorii_p2p_pkt' && ev.newValue) {
        try {
          this._onRawPacket(JSON.parse(ev.newValue));
        } catch (_) {}
      }
    });

    // 4. Connect to public WebSocket MQTT brokers (discovery + reliable P2P packet relay)
    this._connectMqttBrokers();

    // 5. Request active rooms right away
    this.requestDiscovery();

    // 6. Periodic cleanup of stale rooms
    setInterval(() => this._pruneRooms(), 3500);

    // 7. Clean disconnect when closing tab
    window.addEventListener('beforeunload', () => {
      this.leaveRoom();
    });
  }

  _connectMqttBrokers() {
    if (typeof mqtt === 'undefined') return;

    this.cfg.MQTT_BROKERS.forEach((brokerUrl, idx) => {
      try {
        const client = mqtt.connect(brokerUrl, {
          clientId: `zorii_${this.clientId}_${idx}`,
          clean: true,
          connectTimeout: 5000,
          reconnectPeriod: 5000
        });

        client.on('connect', () => {
          client.subscribe(this.cfg.DISCOVERY_TOPIC);
          this.subscribedRoomTopics.forEach((topic) => client.subscribe(topic));
          this.requestDiscovery();
          if (this.mode === 'host' && this.room) {
            this._announceRoom();
          }
        });

        client.on('message', (_topic, payload) => {
          try {
            const pkt = JSON.parse(payload.toString());
            this._onRawPacket(pkt);
          } catch (_) {}
        });

        this.mqttClients.push(client);
      } catch (_) {}
    });
  }

  _roomTopic(roomId) {
    return `zorii/v1/room/${roomId}`;
  }

  _subscribeRoomTopic(roomId) {
    const topic = this._roomTopic(roomId);
    this.subscribedRoomTopics.add(topic);
    this.mqttClients.forEach((c) => {
      if (c && c.connected) {
        try { c.subscribe(topic); } catch (_) {}
      }
    });
  }

  _unsubscribeAllRoomTopics() {
    this.subscribedRoomTopics.forEach((topic) => {
      this.mqttClients.forEach((c) => {
        if (c && c.connected) {
          try { c.unsubscribe(topic); } catch (_) {}
        }
      });
    });
    this.subscribedRoomTopics.clear();
  }

  _sendEverywhere(pkt, mqttTopic) {
    if (!pkt._pid) {
      pkt._pid = this.clientId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    }
    this.seenPacketIds.add(pkt._pid);

    // 1. BroadcastChannel
    if (this.bus) {
      try { this.bus.postMessage(pkt); } catch (_) {}
    }

    // 2. localStorage bridge
    try {
      localStorage.setItem('zorii_p2p_pkt', JSON.stringify(pkt));
    } catch (_) {}

    // 3. MQTT WebSockets
    const topic = mqttTopic || this.cfg.DISCOVERY_TOPIC;
    const raw = JSON.stringify(pkt);
    this.mqttClients.forEach((c) => {
      if (c && c.connected) {
        try { c.publish(topic, raw); } catch (_) {}
      }
    });
  }

  _onRawPacket(pkt) {
    if (!pkt || !pkt.type) return;
    if (pkt._pid) {
      if (this.seenPacketIds.has(pkt._pid)) return;
      this.seenPacketIds.add(pkt._pid);
      if (this.seenPacketIds.size > 600) {
        const first = this.seenPacketIds.values().next().value;
        this.seenPacketIds.delete(first);
      }
    }

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
          this._sendRoomPacket(this.room.id, pkt.payload.clientId, reply);
        });
      } else if (
        this.mode === 'guest' &&
        (pkt.target === this.clientId || pkt.target === 'ALL_GUESTS')
      ) {
        this._handleGuestIncoming(pkt.payload);
      }
    }
  }

  _sendRoomPacket(roomId, target, payload) {
    const pkt = {
      type: 'P2P_PACKET',
      roomId,
      target,
      payload
    };
    this._sendEverywhere(pkt, this._roomTopic(roomId));
  }

  /* =========================================================
   * ROOM DISCOVERY
   * ========================================================= */
  requestDiscovery() {
    this._syncFromStorage();
    this._sendEverywhere({ type: 'DISCOVER_REQ' }, this.cfg.DISCOVERY_TOPIC);
    this._pruneRooms();
  }

  _handleDiscoveryPacket(pkt) {
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
      isHost: true
    });

    this.messages = [];

    // Subscribe to room P2P channel on MQTT
    this._subscribeRoomTopic(roomId);

    // Spin up WebRTC PeerJS host node on this user's machine
    if (typeof Peer !== 'undefined') {
      try {
        this.peer = new Peer(this.cfg.APP_PREFIX + roomId);
        this.peer.on('connection', (conn) => this._setupHostWebRTCConn(conn));
        this.peer.on('error', () => {});
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

    this.discoveredRooms.set(this.room.id, { ...this.room });
    this._persistRooms();
    this._sendEverywhere(pkt, this.cfg.DISCOVERY_TOPIC);
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
   * JOINING A HOST'S COMPUTER
   * ========================================================= */
  joinRoom(roomId) {
    const cleanId = roomId.trim().toUpperCase();
    if (!cleanId) return;

    // If user is already hosting this room, keep them in it
    if (this.mode === 'host' && this.room && this.room.id === cleanId) {
      if (this.cb.onRoomJoined) this.cb.onRoomJoined(this.room, true);
      return;
    }

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

    // Subscribe to the room's P2P relay topic immediately
    this._subscribeRoomTopic(cleanId);

    let joinedConfirmed = false;

    const sendJoinRequest = () => {
      if (joinedConfirmed || this.mode !== 'guest') return;
      const reqPayload = {
        action: 'JOIN_REQ',
        clientId: this.clientId,
        username: this.username
      };

      // Send over BroadcastChannel + localStorage + MQTT room topic
      this._sendRoomPacket(cleanId, 'HOST', reqPayload);

      // Also send over WebRTC if open
      if (this.hostConn && this.hostConn.open) {
        try { this.hostConn.send(reqPayload); } catch (_) {}
      }
    };

    this._onGuestWelcome = (pkt) => {
      if (joinedConfirmed) return;
      joinedConfirmed = true;
      clearInterval(this.joinRetryTimer);
      clearTimeout(this.joinTimeoutTimer);

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

    // Retry join handshake every 900ms while MQTT / WebRTC finishes connecting
    sendJoinRequest();
    this.joinRetryTimer = setInterval(sendJoinRequest, 900);

    this.joinTimeoutTimer = setTimeout(() => {
      if (!joinedConfirmed && this.mode === 'guest') {
        clearInterval(this.joinRetryTimer);
        if (this.cb.onError) this.cb.onError('Host unreachable or room closed');
        this.leaveRoom();
      }
    }, 9000);

    // Also establish direct WebRTC connection to host computer
    if (typeof Peer !== 'undefined') {
      try {
        this.peer = new Peer();
        this.peer.on('open', () => {
          if (this.mode !== 'guest') return;
          const conn = this.peer.connect(this.cfg.APP_PREFIX + cleanId, {
            reliable: true
          });
          this.hostConn = conn;

          conn.on('open', () => {
            sendJoinRequest();
          });

          conn.on('data', (data) => this._handleGuestIncoming(data));
        });
        this.peer.on('error', () => {});
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
        isHost: false
      });

      const welcomePkt = {
        action: 'WELCOME',
        room: this.room,
        members: Array.from(this.members.values()),
        history: this.messages.slice(-60)
      };

      replyFn(welcomePkt);
      this._sendRoomPacket(this.room.id, clientId, welcomePkt);

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

      // Deduplicate if guest sent via both WebRTC and bus
      if (payload.msgId && this.messages.some((m) => m.id === payload.msgId)) {
        return;
      }

      const msg = {
        id: payload.msgId || ('m_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
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

    // 2. Send over BroadcastChannel + localStorage + MQTT room topic
    this._sendRoomPacket(this.room.id, 'ALL_GUESTS', packet);
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
      clearInterval(this.joinRetryTimer);
      clearTimeout(this.joinTimeoutTimer);
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

  /* =========================================================
   * SENDING CHAT & LEAVING
   * ========================================================= */
  sendMessage(text) {
    const clean = (text || '').trim();
    if (!clean || !this.room) return;

    const msgId = 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

    if (this.mode === 'host') {
      this._handleHostIncoming({
        action: 'CHAT_SEND',
        clientId: this.clientId,
        text: clean,
        msgId
      });
    } else if (this.mode === 'guest') {
      const pkt = {
        action: 'CHAT_SEND',
        clientId: this.clientId,
        text: clean,
        msgId
      };
      if (this.hostConn && this.hostConn.open) {
        try { this.hostConn.send(pkt); } catch (_) {}
      }
      this._sendRoomPacket(this.room.id, 'HOST', pkt);
    }
  }

  leaveRoom() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.joinRetryTimer) {
      clearInterval(this.joinRetryTimer);
      this.joinRetryTimer = null;
    }
    if (this.joinTimeoutTimer) {
      clearTimeout(this.joinTimeoutTimer);
      this.joinTimeoutTimer = null;
    }

    if (this.mode === 'host' && this.room) {
      this._broadcastFromHost({ action: 'ROOM_CLOSED' });
      const closePkt = { type: 'ROOM_CLOSE', roomId: this.room.id };
      this.discoveredRooms.delete(this.room.id);
      this._persistRooms();
      this._sendEverywhere(closePkt, this.cfg.DISCOVERY_TOPIC);
    } else if (this.mode === 'guest' && this.room) {
      const leavePkt = { action: 'LEAVE', clientId: this.clientId };
      if (this.hostConn && this.hostConn.open) {
        try { this.hostConn.send(leavePkt); } catch (_) {}
      }
      this._sendRoomPacket(this.room.id, 'HOST', leavePkt);
    }

    this._unsubscribeAllRoomTopics();

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
