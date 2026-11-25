/**
 * Zorii V2 — Decentralized Host-Authoritative Multiplayer Engine
 *
 * Architecture:
 * 1. Host Computer = Authoritative Server:
 *    When a user hosts a room, their computer owns the room state, validates the 5-100 member cap,
 *    maintains the active connected users list, and broadcasts chat messages to all connected peers.
 *
 * 2. Retained MQTT Registry + Local Registry:
 *    Hosts publish their room metadata with MQTT `retain: true` on `zorii/v2/registry/<roomId>`
 *    AND write to shared localStorage. Any user opening the room menu gets the full room list immediately.
 *
 * 3. Triple-Redundant P2P Data Transport:
 *    - Direct WebRTC DataChannels (PeerJS with Google/Twilio STUN ICE servers)
 *    - Dedicated Room Pub/Sub Relay (`zorii/v2/room/<roomId>`) over WebSocket MQTT
 *    - Instant Local Shared Memory (`BroadcastChannel` + `localStorage` state files)
 */
class ZoriiEngine {
  constructor(callbacks) {
    this.cb = callbacks || {};
    this.cfg = window.ZORII_CONFIG;

    // Persistent tab session ID so a tab has a stable identity
    this.clientId = sessionStorage.getItem('zorii_client_id');
    if (!this.clientId) {
      this.clientId = 'u_' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('zorii_client_id', this.clientId);
    }

    this.username = '';
    this.rooms = new Map(); // roomId -> room metadata

    // Transports
    this.mqttClients = [];
    this.bus = typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(this.cfg.BROADCAST_CHANNEL)
      : null;
    this.processedPackets = new Set();

    // Active room state
    this.role = null; // 'host' | 'guest' | null
    this.activeRoom = null; // { id, name, desc, max, hostId, hostName, count, updatedAt }
    this.members = new Map(); // clientId -> { id, name, isHost, joinedAt }
    this.messages = []; // array of chat & system messages

    // WebRTC PeerJS instances
    this.peer = null;
    this.hostWebRtcConns = new Map(); // clientId -> DataConnection (used when role === 'host')
    this.guestWebRtcConn = null; // DataConnection to host (used when role === 'guest')

    this.heartbeatInterval = null;
    this.guestSyncInterval = null;

    this._boot();
  }

  setUsername(name) {
    this.username = (name || '').trim();
    if (this.activeRoom && this.members.has(this.clientId)) {
      const me = this.members.get(this.clientId);
      me.name = this.username;
      if (this.role === 'host') {
        this.activeRoom.hostName = this.username;
        this._hostCommitState();
      }
    }
  }

  /* =========================================================
   * BOOT & TRANSPORT INITIALIZATION
   * ========================================================= */
  _boot() {
    // 1. Read any local rooms immediately
    this._loadLocalRooms();

    // 2. Same-browser BroadcastChannel
    if (this.bus) {
      this.bus.onmessage = (e) => this._handleEnvelope(e.data);
    }

    // 3. Cross-tab storage events
    window.addEventListener('storage', (e) => {
      if (e.key === this.cfg.STORAGE_ROOMS_KEY) {
        this._loadLocalRooms();
      } else if (e.key === 'zorii_v2_envelope' && e.newValue) {
        try {
          this._handleEnvelope(JSON.parse(e.newValue));
        } catch (_) {}
      } else if (
        this.role === 'guest' &&
        this.activeRoom &&
        e.key === this.cfg.STORAGE_ROOM_STATE_PREFIX + this.activeRoom.id &&
        e.newValue
      ) {
        try {
          this._guestApplySnapshot(JSON.parse(e.newValue));
        } catch (_) {}
      }
    });

    // 4. Connect to public WebSocket MQTT brokers for cross-network room discovery & P2P signaling
    this._initMqttBrokers();

    // 5. Periodic room TTL cleanup (only fires callback when room list actually changes)
    setInterval(() => this._pruneExpiredRooms(), 3000);

    // 6. Clean disconnect on tab close
    window.addEventListener('beforeunload', () => {
      this.leaveRoom();
    });
  }

  _initMqttBrokers() {
    if (typeof mqtt === 'undefined') return;

    this.cfg.MQTT_BROKERS.forEach((url, index) => {
      try {
        const client = mqtt.connect(url, {
          clientId: `zorii_${this.clientId}_${index}_${Math.random().toString(36).slice(2, 5)}`,
          clean: true,
          connectTimeout: 4500,
          reconnectPeriod: 6000
        });

        client.on('connect', () => {
          // Subscribe to wildcard retained room registry
          client.subscribe(this.cfg.REGISTRY_PREFIX + '+');
          // If already inside a room, subscribe to its dedicated topic
          if (this.activeRoom) {
            client.subscribe(this.cfg.ROOM_TOPIC_PREFIX + this.activeRoom.id);
          }
          // If hosting, publish retained registry entry immediately
          if (this.role === 'host' && this.activeRoom) {
            this._publishRoomRegistry(this.activeRoom);
          }
        });

        client.on('message', (topic, payloadBuf) => {
          const str = payloadBuf ? payloadBuf.toString() : '';
          // Empty retained message = room closed
          if (topic.startsWith(this.cfg.REGISTRY_PREFIX)) {
            const roomId = topic.slice(this.cfg.REGISTRY_PREFIX.length);
            if (!str) {
              this._removeRoomFromList(roomId);
              return;
            }
            try {
              const roomObj = JSON.parse(str);
              this._upsertRoomInList(roomObj);
            } catch (_) {}
            return;
          }

          if (!str) return;
          try {
            const env = JSON.parse(str);
            this._handleEnvelope(env);
          } catch (_) {}
        });

        this.mqttClients.push(client);
      } catch (_) {}
    });
  }

  /* =========================================================
   * ROOM DISCOVERY REGISTRY
   * ========================================================= */
  requestDiscovery() {
    this._loadLocalRooms();
    this._pruneExpiredRooms();
    this._emitEnvelope({
      type: 'DISCOVER_PING',
      senderId: this.clientId
    });
  }

  _loadLocalRooms() {
    try {
      const raw = localStorage.getItem(this.cfg.STORAGE_ROOMS_KEY);
      if (!raw) return;
      const list = JSON.parse(raw);
      const now = Date.now();
      let changed = false;
      list.forEach((r) => {
        if (r && r.id && now - r.updatedAt < this.cfg.ROOM_TTL_MS) {
          const prev = this.rooms.get(r.id);
          if (!prev || prev.count !== r.count || prev.name !== r.name || prev.desc !== r.desc) {
            changed = true;
          }
          this.rooms.set(r.id, r);
        }
      });
      if (changed && this.cb.onRoomsChanged) {
        this.cb.onRoomsChanged(this.getRooms());
      }
    } catch (_) {}
  }

  _saveLocalRooms() {
    try {
      const arr = Array.from(this.rooms.values());
      localStorage.setItem(this.cfg.STORAGE_ROOMS_KEY, JSON.stringify(arr));
    } catch (_) {}
  }

  _upsertRoomInList(room) {
    if (!room || !room.id) return;
    const now = Date.now();
    // Ignore stale retained rooms older than 25 seconds
    if (room.timestamp && now - room.timestamp > 25000) {
      return;
    }
    const prev = this.rooms.get(room.id);
    const updated = {
      ...room,
      updatedAt: now
    };
    this.rooms.set(room.id, updated);
    this._saveLocalRooms();

    const hasMeaningfulDiff =
      !prev ||
      prev.count !== updated.count ||
      prev.max !== updated.max ||
      prev.name !== updated.name ||
      prev.desc !== updated.desc ||
      prev.hostName !== updated.hostName;

    if (hasMeaningfulDiff && this.cb.onRoomsChanged) {
      this.cb.onRoomsChanged(this.getRooms());
    }
  }

  _removeRoomFromList(roomId) {
    if (this.rooms.has(roomId)) {
      this.rooms.delete(roomId);
      this._saveLocalRooms();
      if (this.cb.onRoomsChanged) {
        this.cb.onRoomsChanged(this.getRooms());
      }
    }
  }

  _pruneExpiredRooms() {
    const now = Date.now();
    let changed = false;
    for (const [id, r] of this.rooms.entries()) {
      // Never prune a room we are currently hosting
      if (this.role === 'host' && this.activeRoom && this.activeRoom.id === id) {
        continue;
      }
      if (now - r.updatedAt > this.cfg.ROOM_TTL_MS) {
        this.rooms.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this._saveLocalRooms();
      if (this.cb.onRoomsChanged) {
        this.cb.onRoomsChanged(this.getRooms());
      }
    }
  }

  getRooms() {
    return Array.from(this.rooms.values()).sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name)
    );
  }

  _publishRoomRegistry(room) {
    if (!room || !room.id) return;
    const payloadObj = {
      ...room,
      timestamp: Date.now(),
      updatedAt: Date.now()
    };
    this._upsertRoomInList(payloadObj);

    const raw = JSON.stringify(payloadObj);
    const regTopic = this.cfg.REGISTRY_PREFIX + room.id;

    this.mqttClients.forEach((c) => {
      if (c && c.connected) {
        try {
          c.publish(regTopic, raw, { qos: 0, retain: true });
        } catch (_) {}
      }
    });

    this._emitEnvelope({
      type: 'ROOM_ANNOUNCE',
      room: payloadObj
    });
  }

  _unpublishRoomRegistry(roomId) {
    this._removeRoomFromList(roomId);
    const regTopic = this.cfg.REGISTRY_PREFIX + roomId;
    this.mqttClients.forEach((c) => {
      if (c && c.connected) {
        try {
          // Publishing empty buffer with retain: true deletes the retained MQTT message
          c.publish(regTopic, '', { qos: 0, retain: true });
        } catch (_) {}
      }
    });
    this._emitEnvelope({
      type: 'ROOM_CLOSE',
      roomId
    });
  }

  /* =========================================================
   * HOSTING A ROOM (YOUR COMPUTER IS THE SERVER)
   * ========================================================= */
  hostRoom({ name, desc, max }) {
    this.leaveRoom();

    const maxMembers = Math.min(
      this.cfg.MAX_MEMBERS,
      Math.max(this.cfg.MIN_MEMBERS, Number(max) || 25)
    );
    const roomId = this._generateCode();

    this.role = 'host';
    this.activeRoom = {
      id: roomId,
      name: (name || 'Room').trim(),
      desc: (desc || '').trim(),
      max: maxMembers,
      hostId: this.clientId,
      hostName: this.username,
      count: 1,
      updatedAt: Date.now()
    };

    this.members.clear();
    this.members.set(this.clientId, {
      id: this.clientId,
      name: this.username,
      isHost: true,
      joinedAt: Date.now()
    });

    this.messages = [
      {
        id: 'sys_' + Date.now(),
        type: 'system',
        text: `Room hosted on your computer (ID: ${roomId})`
      }
    ];

    // 1. Subscribe to dedicated room channel on all MQTT brokers
    this._subscribeMqttRoom(roomId);

    // 2. Start WebRTC PeerJS Host node on this computer
    this._startHostWebRTC(roomId);

    // 3. Commit authoritative state & announce room
    this._hostCommitState();

    this.heartbeatInterval = setInterval(() => {
      if (this.role === 'host' && this.activeRoom) {
        this._publishRoomRegistry(this.activeRoom);
        this._hostSaveLocalSnapshot();
      }
    }, this.cfg.HEARTBEAT_MS);

    // 4. Open Room Screen
    if (this.cb.onEnterRoom) {
      this.cb.onEnterRoom(this.activeRoom, true);
    }
    this._notifyUIState();
  }

  _startHostWebRTC(roomId) {
    if (typeof Peer === 'undefined') return;
    try {
      this.peer = new Peer(this.cfg.APP_PREFIX + roomId, {
        config: { iceServers: this.cfg.ICE_SERVERS }
      });

      this.peer.on('connection', (conn) => {
        conn.on('data', (pkt) => {
          if (this.role !== 'host') return;
          this._hostProcessGuestAction(pkt, conn);
        });
        conn.on('close', () => {
          if (conn._guestId) {
            this._hostRemoveMember(conn._guestId);
          }
        });
      });

      this.peer.on('error', () => {});
    } catch (_) {}
  }

  _hostCommitState() {
    if (this.role !== 'host' || !this.activeRoom) return;
    this.activeRoom.count = this.members.size;
    this.activeRoom.updatedAt = Date.now();

    const snapshot = {
      room: this.activeRoom,
      members: Array.from(this.members.values()),
      messages: this.messages.slice(-80),
      updatedAt: Date.now()
    };

    // 1. Save to local storage for instant local tabs
    this._hostSaveLocalSnapshot(snapshot);

    // 2. Update registry count
    this._publishRoomRegistry(this.activeRoom);

    // 3. Broadcast authoritative snapshot to all guests via WebRTC + Room Topic + Bus
    this._hostBroadcastToGuests({
      action: 'HOST_SNAPSHOT',
      snapshot
    });

    // 4. Update Host UI
    this._notifyUIState();
  }

  _hostSaveLocalSnapshot(snapOverride) {
    if (this.role !== 'host' || !this.activeRoom) return;
    try {
      const snap = snapOverride || {
        room: this.activeRoom,
        members: Array.from(this.members.values()),
        messages: this.messages.slice(-80),
        updatedAt: Date.now()
      };
      localStorage.setItem(
        this.cfg.STORAGE_ROOM_STATE_PREFIX + this.activeRoom.id,
        JSON.stringify(snap)
      );
    } catch (_) {}
  }

  _hostBroadcastToGuests(payload) {
    if (this.role !== 'host' || !this.activeRoom) return;

    // Send over all connected WebRTC DataChannels
    for (const conn of this.hostWebRtcConns.values()) {
      if (conn && conn.open) {
        try { conn.send(payload); } catch (_) {}
      }
    }

    // Also send over multi-transport room channel (BroadcastChannel + MQTT Room Topic)
    this._emitRoomPacket(this.activeRoom.id, 'ALL_GUESTS', payload);
  }

  _hostProcessGuestAction(payload, webrtcConn) {
    if (!payload || !payload.action || this.role !== 'host' || !this.activeRoom) return;

    // Guest wants to join the room
    if (payload.action === 'GUEST_JOIN') {
      const { clientId, username } = payload;
      if (!clientId || !username) return;

      const alreadyMember = this.members.has(clientId);
      if (!alreadyMember && this.members.size >= this.activeRoom.max) {
        const rejectPkt = {
          action: 'HOST_REJECT',
          targetId: clientId,
          reason: `Room is full (${this.activeRoom.max}/${this.activeRoom.max})`
        };
        if (webrtcConn && webrtcConn.open) {
          try { webrtcConn.send(rejectPkt); } catch (_) {}
        }
        this._emitRoomPacket(this.activeRoom.id, clientId, rejectPkt);
        return;
      }

      if (webrtcConn) {
        webrtcConn._guestId = clientId;
        this.hostWebRtcConns.set(clientId, webrtcConn);
      }

      this.members.set(clientId, {
        id: clientId,
        name: username,
        isHost: clientId === this.clientId,
        joinedAt: Date.now()
      });

      if (!alreadyMember) {
        this.messages.push({
          id: 'sys_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          type: 'system',
          text: `${username} joined the room`
        });
      }

      this._hostCommitState();
      return;
    }

    // Guest sent a chat message to the host computer
    if (payload.action === 'GUEST_CHAT') {
      const { clientId, username, text, msgId } = payload;
      const cleanText = (text || '').trim();
      if (!cleanText || !clientId) return;

      // Deduplicate message ID
      if (msgId && this.messages.some((m) => m.id === msgId)) {
        return;
      }

      // Auto-register member if room has space
      if (!this.members.has(clientId)) {
        if (this.members.size >= this.activeRoom.max) return;
        this.members.set(clientId, {
          id: clientId,
          name: username || 'Guest',
          isHost: false,
          joinedAt: Date.now()
        });
      }

      const sender = this.members.get(clientId);
      const msg = {
        id: msgId || ('msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
        type: 'user',
        clientId: sender.id,
        author: sender.name,
        text: cleanText.slice(0, 500),
        time: this._formatTime(new Date())
      };

      this.messages.push(msg);
      this._hostCommitState();
      return;
    }

    // Guest left the room
    if (payload.action === 'GUEST_LEAVE') {
      this._hostRemoveMember(payload.clientId);
    }
  }

  _hostRemoveMember(clientId) {
    if (this.role !== 'host' || !this.activeRoom) return;
    const member = this.members.get(clientId);
    if (!member || member.isHost) return;

    this.members.delete(clientId);
    this.hostWebRtcConns.delete(clientId);

    this.messages.push({
      id: 'sys_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      type: 'system',
      text: `${member.name} left the room`
    });

    this._hostCommitState();
  }

  /* =========================================================
   * JOINING A ROOM AS A CLIENT
   * ========================================================= */
  joinRoom(rawRoomId) {
    const roomId = (rawRoomId || '').trim().toUpperCase();
    if (!roomId) return;

    // If this tab is ALREADY hosting or inside this exact room, just switch to the room screen!
    if (this.activeRoom && this.activeRoom.id === roomId) {
      if (this.cb.onEnterRoom) {
        this.cb.onEnterRoom(this.activeRoom, this.role === 'host');
      }
      this._notifyUIState();
      return;
    }

    const knownMeta = this.rooms.get(roomId);
    const localSnap = this._readLocalSnapshot(roomId);

    this.leaveRoom();

    this.role = 'guest';
    this.activeRoom = (localSnap && localSnap.room)
      ? { ...localSnap.room }
      : knownMeta
      ? { ...knownMeta }
      : {
          id: roomId,
          name: `Room ${roomId}`,
          desc: '',
          max: 25,
          hostId: 'host_' + roomId,
          hostName: 'Host',
          count: 1
        };

    // Check if room is already full before joining
    if (
      localSnap &&
      Array.isArray(localSnap.members) &&
      !localSnap.members.some((m) => m.id === this.clientId) &&
      localSnap.members.length >= this.activeRoom.max
    ) {
      if (this.cb.onError) {
        this.cb.onError(`Room is full (${this.activeRoom.max}/${this.activeRoom.max})`);
      }
      this.role = null;
      this.activeRoom = null;
      return;
    }

    // Hydrate initial members & messages so the Room Screen opens immediately upon click
    this.members.clear();
    if (localSnap && Array.isArray(localSnap.members)) {
      localSnap.members.forEach((m) => this.members.set(m.id, m));
    } else {
      const hid = this.activeRoom.hostId || ('host_' + roomId);
      this.members.set(hid, {
        id: hid,
        name: this.activeRoom.hostName || 'Host',
        isHost: true
      });
    }

    this.members.set(this.clientId, {
      id: this.clientId,
      name: this.username,
      isHost: false
    });

    this.messages = (localSnap && Array.isArray(localSnap.messages))
      ? [...localSnap.messages]
      : [
          {
            id: 'sys_init_' + Date.now(),
            type: 'system',
            text: `Connected to room ${this.activeRoom.name} (${roomId})`
          }
        ];

    // 1. Immediately switch UI to Room Screen
    if (this.cb.onEnterRoom) {
      this.cb.onEnterRoom(this.activeRoom, false);
    }
    this._notifyUIState();

    // 2. Subscribe to dedicated room topic
    this._subscribeMqttRoom(roomId);

    // 3. Connect WebRTC DataChannel to host's computer
    this._startGuestWebRTC(roomId);

    // 4. Send GUEST_JOIN handshake to host computer
    let hostSynced = false;
    const sendJoinPacket = () => {
      if (this.role !== 'guest' || !this.activeRoom) return;
      const joinPkt = {
        action: 'GUEST_JOIN',
        clientId: this.clientId,
        username: this.username
      };
      if (this.guestWebRtcConn && this.guestWebRtcConn.open) {
        try { this.guestWebRtcConn.send(joinPkt); } catch (_) {}
      }
      this._emitRoomPacket(roomId, 'HOST', joinPkt);
    };

    this._onHostConfirmed = () => {
      hostSynced = true;
    };

    sendJoinPacket();

    // Poll local snapshot & retry handshake until synced
    let attempts = 0;
    this.guestSyncInterval = setInterval(() => {
      if (this.role !== 'guest' || !this.activeRoom) return;

      const snap = this._readLocalSnapshot(roomId);
      if (snap && snap.members && snap.members.some((m) => m.id === this.clientId)) {
        hostSynced = true;
        this._guestApplySnapshot(snap);
      }

      if (!hostSynced && attempts < 10) {
        attempts++;
        sendJoinPacket();
      }
    }, 600);
  }

  _startGuestWebRTC(roomId) {
    if (typeof Peer === 'undefined') return;
    try {
      this.peer = new Peer({
        config: { iceServers: this.cfg.ICE_SERVERS }
      });

      this.peer.on('open', () => {
        if (this.role !== 'guest' || !this.activeRoom) return;
        const conn = this.peer.connect(this.cfg.APP_PREFIX + roomId, {
          reliable: true
        });
        this.guestWebRtcConn = conn;

        conn.on('open', () => {
          conn.send({
            action: 'GUEST_JOIN',
            clientId: this.clientId,
            username: this.username
          });
        });

        conn.on('data', (pkt) => this._guestProcessHostPacket(pkt));
      });

      this.peer.on('error', () => {});
    } catch (_) {}
  }

  _guestProcessHostPacket(payload) {
    if (!payload || !payload.action || this.role !== 'guest' || !this.activeRoom) return;

    if (payload.action === 'HOST_REJECT') {
      if (payload.targetId && payload.targetId !== this.clientId) return;
      if (this.cb.onError) {
        this.cb.onError(payload.reason || 'Cannot join room');
      }
      this.leaveRoom();
      return;
    }

    if (payload.action === 'HOST_SNAPSHOT' && payload.snapshot) {
      if (this._onHostConfirmed) this._onHostConfirmed();
      this._guestApplySnapshot(payload.snapshot);
      return;
    }

    if (payload.action === 'HOST_CLOSED') {
      if (this.cb.onError) {
        this.cb.onError('Host closed the room');
      }
      this.leaveRoom();
    }
  }

  _guestApplySnapshot(snap) {
    if (!snap || this.role !== 'guest' || !this.activeRoom) return;
    if (snap.room) {
      this.activeRoom = { ...snap.room };
    }
    if (Array.isArray(snap.members)) {
      this.members.clear();
      snap.members.forEach((m) => this.members.set(m.id, m));
      // Keep self visible while join packet is in flight
      if (!this.members.has(this.clientId)) {
        this.members.set(this.clientId, {
          id: this.clientId,
          name: this.username,
          isHost: false
        });
      }
    }
    if (Array.isArray(snap.messages)) {
      this.messages = [...snap.messages];
    }
    this._notifyUIState();
  }

  _readLocalSnapshot(roomId) {
    try {
      const raw = localStorage.getItem(this.cfg.STORAGE_ROOM_STATE_PREFIX + roomId);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  /* =========================================================
   * SENDING CHAT & LEAVING ROOM
   * ========================================================= */
  sendMessage(text) {
    const clean = (text || '').trim();
    if (!clean || !this.activeRoom) return;

    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

    if (this.role === 'host') {
      this._hostProcessGuestAction({
        action: 'GUEST_CHAT',
        clientId: this.clientId,
        username: this.username,
        text: clean,
        msgId
      });
    } else if (this.role === 'guest') {
      // Optimistic local append so guest sees their own message with zero delay
      this.messages.push({
        id: msgId,
        type: 'user',
        clientId: this.clientId,
        author: this.username,
        text: clean.slice(0, 500),
        time: this._formatTime(new Date())
      });
      this._notifyUIState();

      const chatPkt = {
        action: 'GUEST_CHAT',
        clientId: this.clientId,
        username: this.username,
        text: clean,
        msgId
      };

      if (this.guestWebRtcConn && this.guestWebRtcConn.open) {
        try { this.guestWebRtcConn.send(chatPkt); } catch (_) {}
      }
      this._emitRoomPacket(this.activeRoom.id, 'HOST', chatPkt);
    }
  }

  leaveRoom() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.guestSyncInterval) {
      clearInterval(this.guestSyncInterval);
      this.guestSyncInterval = null;
    }

    if (this.role === 'host' && this.activeRoom) {
      const rid = this.activeRoom.id;
      this._hostBroadcastToGuests({ action: 'HOST_CLOSED' });
      this._unpublishRoomRegistry(rid);
      try {
        localStorage.removeItem(this.cfg.STORAGE_ROOM_STATE_PREFIX + rid);
      } catch (_) {}
      this._unsubscribeMqttRoom(rid);
    } else if (this.role === 'guest' && this.activeRoom) {
      const rid = this.activeRoom.id;
      const leavePkt = {
        action: 'GUEST_LEAVE',
        clientId: this.clientId
      };
      if (this.guestWebRtcConn && this.guestWebRtcConn.open) {
        try { this.guestWebRtcConn.send(leavePkt); } catch (_) {}
      }
      this._emitRoomPacket(rid, 'HOST', leavePkt);
      this._unsubscribeMqttRoom(rid);
    }

    if (this.guestWebRtcConn) {
      try { this.guestWebRtcConn.close(); } catch (_) {}
      this.guestWebRtcConn = null;
    }

    for (const conn of this.hostWebRtcConns.values()) {
      try { conn.close(); } catch (_) {}
    }
    this.hostWebRtcConns.clear();

    if (this.peer) {
      try { this.peer.destroy(); } catch (_) {}
      this.peer = null;
    }

    this.role = null;
    this.activeRoom = null;
    this.members.clear();
    this.messages = [];
  }

  /* =========================================================
   * ENVELOPE ROUTING & HELPERS
   * ========================================================= */
  _subscribeMqttRoom(roomId) {
    const topic = this.cfg.ROOM_TOPIC_PREFIX + roomId;
    this.mqttClients.forEach((c) => {
      if (c && c.connected) {
        try { c.subscribe(topic); } catch (_) {}
      }
    });
  }

  _unsubscribeMqttRoom(roomId) {
    const topic = this.cfg.ROOM_TOPIC_PREFIX + roomId;
    this.mqttClients.forEach((c) => {
      if (c && c.connected) {
        try { c.unsubscribe(topic); } catch (_) {}
      }
    });
  }

  _emitRoomPacket(roomId, target, payload) {
    const env = {
      id: this.clientId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      type: 'ROOM_PKT',
      roomId,
      target,
      payload
    };
    this._emitEnvelope(env, this.cfg.ROOM_TOPIC_PREFIX + roomId);
  }

  _emitEnvelope(env, customMqttTopic) {
    if (!env.id) {
      env.id = this.clientId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    }
    this.processedPackets.add(env.id);

    if (this.bus) {
      try { this.bus.postMessage(env); } catch (_) {}
    }

    try {
      localStorage.setItem('zorii_v2_envelope', JSON.stringify(env));
    } catch (_) {}

    if (customMqttTopic) {
      const str = JSON.stringify(env);
      this.mqttClients.forEach((c) => {
        if (c && c.connected) {
          try { c.publish(customMqttTopic, str); } catch (_) {}
        }
      });
    }
  }

  _handleEnvelope(env) {
    if (!env || !env.type) return;
    if (env.id) {
      if (this.processedPackets.has(env.id)) return;
      this.processedPackets.add(env.id);
      if (this.processedPackets.size > 1000) {
        const oldest = this.processedPackets.values().next().value;
        this.processedPackets.delete(oldest);
      }
    }

    if (env.type === 'DISCOVER_PING') {
      if (this.role === 'host' && this.activeRoom) {
        this._publishRoomRegistry(this.activeRoom);
      }
      return;
    }

    if (env.type === 'ROOM_ANNOUNCE' && env.room) {
      this._upsertRoomInList(env.room);
      return;
    }

    if (env.type === 'ROOM_CLOSE' && env.roomId) {
      this._removeRoomFromList(env.roomId);
      return;
    }

    if (env.type === 'ROOM_PKT' && this.activeRoom && env.roomId === this.activeRoom.id) {
      if (this.role === 'host' && env.target === 'HOST') {
        this._hostProcessGuestAction(env.payload, null);
      } else if (
        this.role === 'guest' &&
        (env.target === 'ALL_GUESTS' || env.target === this.clientId)
      ) {
        this._guestProcessHostPacket(env.payload);
      }
    }
  }

  _notifyUIState() {
    if (!this.activeRoom) return;
    if (this.cb.onRoomState) {
      this.cb.onRoomState({
        room: this.activeRoom,
        isHost: this.role === 'host',
        members: Array.from(this.members.values()),
        messages: this.messages
      });
    }
  }

  _generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 6; i++) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
  }

  _formatTime(d) {
    return d.toTimeString().slice(0, 5);
  }
}

window.ZoriiP2P = ZoriiEngine;
