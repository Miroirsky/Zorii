/**
 * Zorii V2 — Decentralized Host-Authoritative Multiplayer Engine
 *
 * Features:
 * - Host Computer = Authoritative Server (manages connected members, 5-100 cap, chat, user colors, and live shared room clicker).
 * - Live Shared Clicker: Every click from any player is processed by the host computer and broadcast in real time to all connected players,
 *   plus announced to the room discovery list so players see the live click count before and when joining.
 * - Custom User Colors: Synced across the connected users list and chat messages.
 */
class ZoriiEngine {
  constructor(callbacks) {
    this.cb = callbacks || {};
    this.cfg = window.ZORII_CONFIG;

    this.clientId =
      sessionStorage.getItem('zorii_client_id') ||
      localStorage.getItem('zorii_client_id');
    if (!this.clientId) {
      this.clientId = 'u_' + Math.random().toString(36).slice(2, 10);
    }
    sessionStorage.setItem('zorii_client_id', this.clientId);
    localStorage.setItem('zorii_client_id', this.clientId);

    this.username = '';
    this.userColor = this.cfg.USER_COLORS[0];
    this.isAnonymous = false;
    this.isEmailVerified = false;
    this.rooms = new Map(); // roomId -> room metadata

    // Transports
    this.mqttClients = [];
    this.bus = typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(this.cfg.BROADCAST_CHANNEL)
      : null;
    this.processedPackets = new Set();

    // Active room state
    this.role = null; // 'host' | 'guest' | null
    this.activeRoom = null; // { id, name, desc, max, hostId, hostName, count, spectatorCount, clicks, cooldownUpgradeLevel, adminIds, bannedIds, level, xp, currentLevelXp, xpNeeded, updatedAt }
    this.isRoomSaved = false; // true once host saves room (or loads from saved rooms) -> auto-saves on close
    this.members = new Map(); // clientId -> { id, name, color, isHost, isAdmin, timeoutUntil, clicks, joinedAt }
    this.adminIds = new Set(); // clientIds appointed as Admin by Owner
    this.bannedIds = new Set(); // clientIds banned by Owner
    this.timeouts = new Map(); // clientId -> timeoutUntil epoch ms
    this.playerClicks = new Map(); // clientId -> number (host-authoritative session clicks)
    this.lastPlayerClickAt = new Map(); // clientId -> timestamp ms (host click cooldown enforcement)
    this.lastPlayerChatAt = new Map(); // clientId -> timestamp ms (host 0.5s chat cooldown enforcement)
    this.lastLocalClickAt = 0;
    this.lastLocalChatAt = 0;
    this.lastAppliedSnapshotAt = 0;
    this.processedClickIds = new Set(); // clickId deduplication on host
    this.processedAdminActionIds = new Set(); // admin actionId deduplication on host
    this.spectators = new Map(); // clientId -> lastSeenMs (invisible anonymous spectators)
    this.messages = [];

    // WebRTC PeerJS instances
    this.peer = null;
    this.hostWebRtcRetryTimer = null;
    this.hostWebRtcConns = new Map();
    this.hostWebRtcSpectatorConns = new Map();
    this.guestWebRtcConn = null;

    this.heartbeatInterval = null;
    this.guestSyncInterval = null;

    this._boot();
  }

  setProfile(name, color, isAnonymous = false, uid = null, isEmailVerified = false) {
    if (uid) {
      this.clientId = uid;
      sessionStorage.setItem('zorii_client_id', this.clientId);
      localStorage.setItem('zorii_client_id', this.clientId);
    }
    this.isAnonymous = Boolean(isAnonymous);
    this.isEmailVerified = !this.isAnonymous && Boolean(isEmailVerified);
    this.username = this.isAnonymous ? 'Anonyme' : (name || '').trim();
    this.userColor = color || this.cfg.USER_COLORS[0];

    if (this.activeRoom && !this.isAnonymous && this.members.has(this.clientId)) {
      const me = this.members.get(this.clientId);
      me.name = this.username;
      me.color = this.userColor;
      me.isVerified = this.isEmailVerified;
      if (this.role === 'host') {
        this.activeRoom.hostName = this.username;
        this._hostCommitState();
      } else if (this.role === 'guest') {
        const joinPkt = {
          action: 'GUEST_JOIN',
          clientId: this.clientId,
          username: this.username,
          color: this.userColor,
          isAnonymous: false,
          isVerified: this.isEmailVerified
        };
        if (this.guestWebRtcConn && this.guestWebRtcConn.open) {
          try { this.guestWebRtcConn.send(joinPkt); } catch (_) {}
        }
        this._emitRoomPacket(this.activeRoom.id, 'HOST', joinPkt);
      }
    }
  }

  /* =========================================================
   * BOOT & TRANSPORT INITIALIZATION
   * ========================================================= */
  _boot() {
    this._loadLocalRooms();

    if (this.bus) {
      this.bus.onmessage = (e) => this._handleEnvelope(e.data);
    }

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

    this._initMqttBrokers();

    setInterval(() => this._pruneExpiredRooms(), 3000);

    window.addEventListener('pagehide', () => {
      this.leaveRoom();
    });

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
          client.subscribe(this.cfg.REGISTRY_PREFIX + '+');
          if (this.activeRoom) {
            client.subscribe(this.cfg.ROOM_TOPIC_PREFIX + this.activeRoom.id);
          }
          if (this.role === 'host' && this.activeRoom) {
            this._publishRoomRegistry(this.activeRoom);
          }
        });

        client.on('message', (topic, payloadBuf) => {
          const str = payloadBuf ? payloadBuf.toString() : '';
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
          if (
            !prev ||
            prev.count !== r.count ||
            prev.spectatorCount !== r.spectatorCount ||
            prev.clicks !== r.clicks ||
            prev.level !== r.level ||
            prev.xp !== r.xp ||
            prev.name !== r.name ||
            prev.desc !== r.desc
          ) {
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

  isOwner(uid = this.clientId) {
    if (!this.activeRoom || !uid) return false;
    return (this.role === 'host' && uid === this.clientId) || uid === this.activeRoom.hostId;
  }

  isAdmin(uid = this.clientId) {
    if (!this.activeRoom || !uid) return false;
    if (this.adminIds.has(uid)) return true;
    const m = this.members.get(uid);
    if (m && m.isAdmin) return true;
    if (Array.isArray(this.activeRoom.adminIds) && this.activeRoom.adminIds.includes(uid)) {
      return true;
    }
    return false;
  }

  isOwnerOrAdmin(uid = this.clientId) {
    return this.isOwner(uid) || this.isAdmin(uid);
  }

  getUserTimeoutRemainingMs(uid = this.clientId) {
    if (!this.activeRoom || !uid) return 0;
    const m = this.members.get(uid);
    const until = Math.max(
      Number(this.timeouts.get(uid)) || 0,
      Number(m && m.timeoutUntil) || 0
    );
    return Math.max(0, until - Date.now());
  }

  getRemainingChatCooldownMs() {
    if (!this.activeRoom || !this.lastLocalChatAt) return 0;
    return Math.max(0, 500 - (Date.now() - this.lastLocalChatAt));
  }

  canDeleteMessage(msg) {
    if (!msg || msg.type === 'system' || !this.activeRoom || this.isAnonymous) return false;
    if (this.isOwner(this.clientId)) return true;
    if (this.isAdmin(this.clientId)) {
      // Owner and admins can delete messages (admins can delete non-admin/non-owner messages or their own)
      return (
        msg.clientId === this.clientId ||
        (!this.isOwner(msg.clientId) && !this.isAdmin(msg.clientId))
      );
    }
    return false;
  }

  getCooldownUpgradeInfo(levelOverride) {
    const maxLevel = 10; // 1.0s base -> -0.1s per level -> 0.0s at level 10
    const rawLvl =
      levelOverride !== undefined
        ? levelOverride
        : this.activeRoom && this.activeRoom.cooldownUpgradeLevel;
    const level = Math.min(maxLevel, Math.max(0, Math.floor(Number(rawLvl) || 0)));
    const cooldownMs = Math.max(0, 1000 - level * 100);
    const cooldownSec = Number((cooldownMs / 1000).toFixed(1));
    const isMaxed = level >= maxLevel;
    const nextCost = isMaxed ? null : Math.round(1000 * Math.pow(5, level));
    const nextCooldownSec = isMaxed
      ? 0
      : Number((Math.max(0, 1000 - (level + 1) * 100) / 1000).toFixed(1));

    return {
      level,
      maxLevel,
      cooldownMs,
      cooldownSec,
      isMaxed,
      nextCost,
      nextCooldownSec
    };
  }

  computeRoomLevel(xpValue) {
    const totalXp = Math.max(0, Math.floor(Number(xpValue) || 0));
    let level = 1;
    let xpNeeded = (this.cfg && this.cfg.LEVEL1_XP) || 10;
    const mult = (this.cfg && this.cfg.LEVEL_XP_MULTIPLIER) || 10;
    let currentLevelXp = totalXp;

    while (currentLevelXp >= xpNeeded) {
      currentLevelXp -= xpNeeded;
      level += 1;
      xpNeeded *= mult;
    }

    const progressPct = Math.min(100, Math.max(0, (currentLevelXp / xpNeeded) * 100));
    return {
      level,
      totalXp,
      currentLevelXp,
      xpNeeded,
      progressPct
    };
  }

  _upsertRoomInList(room) {
    if (!room || !room.id) return;
    const now = Date.now();
    if (room.timestamp && now - room.timestamp > 25000) {
      return;
    }
    const prev = this.rooms.get(room.id);
    const clicks = Math.max(0, Math.floor(Number(room.clicks) || 0));
    const cooldownUpgradeLevel = Math.min(
      10,
      Math.max(0, Math.floor(Number(room.cooldownUpgradeLevel) || 0))
    );
    const xp = Math.max(Math.floor(clicks / 100), Number(room.xp) || 0);
    const lvlInfo = this.computeRoomLevel(xp);
    const updated = {
      ...room,
      spectatorCount: Math.max(0, Number(room.spectatorCount) || 0),
      clicks,
      cooldownUpgradeLevel,
      level: lvlInfo.level,
      xp: lvlInfo.totalXp,
      currentLevelXp: lvlInfo.currentLevelXp,
      xpNeeded: lvlInfo.xpNeeded,
      updatedAt: now
    };
    this.rooms.set(room.id, updated);
    this._saveLocalRooms();

    const hasMeaningfulDiff =
      !prev ||
      prev.count !== updated.count ||
      prev.spectatorCount !== updated.spectatorCount ||
      prev.clicks !== updated.clicks ||
      prev.cooldownUpgradeLevel !== updated.cooldownUpgradeLevel ||
      prev.xp !== updated.xp ||
      prev.level !== updated.level ||
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
    return Array.from(this.rooms.values()).sort((a, b) => {
      const lvlA = this.computeRoomLevel(a.xp).level;
      const lvlB = this.computeRoomLevel(b.xp).level;
      if (lvlB !== lvlA) return lvlB - lvlA;
      return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    });
  }

  _publishRoomRegistry(room) {
    if (!room || !room.id) return;
    const clicks = Math.max(0, Math.floor(Number(room.clicks) || 0));
    const cooldownUpgradeLevel = Math.min(
      10,
      Math.max(0, Math.floor(Number(room.cooldownUpgradeLevel) || 0))
    );
    const xp = Math.max(Math.floor(clicks / 100), Number(room.xp) || 0);
    const lvlInfo = this.computeRoomLevel(xp);
    const payloadObj = {
      ...room,
      spectatorCount: Math.max(0, Number(room.spectatorCount) || 0),
      clicks,
      cooldownUpgradeLevel,
      level: lvlInfo.level,
      xp: lvlInfo.totalXp,
      currentLevelXp: lvlInfo.currentLevelXp,
      xpNeeded: lvlInfo.xpNeeded,
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
   * SAVED ROOM STATS (HOST PERSISTENCE: LEVELS, CLICKS, MAX MEMBERS — NO MESSAGES/MEMBERS)
   * ========================================================= */
  getSavedRooms() {
    try {
      const raw = localStorage.getItem(this.cfg.STORAGE_SAVED_ROOMS_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((r) => r && r.id && r.name)
        .map((r) => {
          const clicks = Math.max(0, Math.floor(Number(r.clicks) || 0));
          const cooldownUpgradeLevel = Math.min(
            10,
            Math.max(0, Math.floor(Number(r.cooldownUpgradeLevel) || 0))
          );
          const xpVal = Math.max(Math.floor(clicks / 100), Math.max(0, Math.floor(Number(r.xp) || 0)));
          const lvlInfo = this.computeRoomLevel(xpVal);
          return {
            id: r.id,
            name: r.name,
            desc: r.desc || '',
            max: Math.min(this.cfg.MAX_MEMBERS, Math.max(this.cfg.MIN_MEMBERS, Number(r.max) || 25)),
            clicks,
            cooldownUpgradeLevel,
            adminIds: Array.isArray(r.adminIds) ? r.adminIds.filter(Boolean) : [],
            bannedIds: Array.isArray(r.bannedIds) ? r.bannedIds.filter(Boolean) : [],
            level: lvlInfo.level,
            xp: lvlInfo.totalXp,
            currentLevelXp: lvlInfo.currentLevelXp,
            xpNeeded: lvlInfo.xpNeeded,
            savedAt: r.savedAt || Date.now()
          };
        })
        .sort((a, b) => {
          if (b.level !== a.level) return b.level - a.level;
          return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
        });
    } catch (_) {
      return [];
    }
  }

  isCurrentRoomSaved() {
    if (this.role !== 'host' || !this.activeRoom || !this.activeRoom.id) return false;
    if (this.isRoomSaved) return true;
    const found = this.getSavedRooms().some((r) => r.id === this.activeRoom.id);
    if (found) this.isRoomSaved = true;
    return found;
  }

  saveCurrentRoomStats() {
    if (this.role !== 'host' || !this.activeRoom) return null;
    this.isRoomSaved = true;
    const clicks = Math.max(0, Math.floor(Number(this.activeRoom.clicks) || 0));
    const cooldownUpgradeLevel = Math.min(
      10,
      Math.max(0, Math.floor(Number(this.activeRoom.cooldownUpgradeLevel) || 0))
    );
    const xpVal = Math.max(Math.floor(clicks / 100), Math.max(0, Math.floor(Number(this.activeRoom.xp) || 0)));
    const lvlInfo = this.computeRoomLevel(xpVal);
    // Save ONLY room stats (id, name, desc, max, clicks, cooldownUpgradeLevel, level, xp) — never messages or members
    const savedEntry = {
      id: this.activeRoom.id,
      name: this.activeRoom.name,
      desc: this.activeRoom.desc || '',
      max: this.activeRoom.max,
      clicks,
      cooldownUpgradeLevel,
      adminIds: Array.from(this.adminIds),
      bannedIds: Array.from(this.bannedIds),
      level: lvlInfo.level,
      xp: lvlInfo.totalXp,
      currentLevelXp: lvlInfo.currentLevelXp,
      xpNeeded: lvlInfo.xpNeeded,
      savedAt: Date.now()
    };

    try {
      const list = this.getSavedRooms().filter((r) => r.id !== savedEntry.id);
      list.push(savedEntry);
      localStorage.setItem(this.cfg.STORAGE_SAVED_ROOMS_KEY, JSON.stringify(list));
    } catch (_) {}

    return savedEntry;
  }

  deleteSavedRoom(roomId) {
    if (!roomId) return;
    try {
      const list = this.getSavedRooms().filter((r) => r.id !== roomId);
      localStorage.setItem(this.cfg.STORAGE_SAVED_ROOMS_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  /* =========================================================
   * HOSTING A ROOM (YOUR COMPUTER IS THE SERVER)
   * ========================================================= */
  hostRoom({ id, name, desc, max, xp, clicks, cooldownUpgradeLevel, adminIds, bannedIds }) {
    if (this.isAnonymous || !this.isEmailVerified) {
      if (this.cb.onError) {
        this.cb.onError('Compte avec e-mail vérifié requis pour héberger une room');
      }
      return;
    }
    this.leaveRoom();

    const maxMembers = Math.min(
      this.cfg.MAX_MEMBERS,
      Math.max(this.cfg.MIN_MEMBERS, Number(max) || 25)
    );
    const roomId = (id && String(id).trim().toUpperCase()) || this._generateCode();
    const initialClicks = Math.max(0, Math.floor(Number(clicks) || 0));
    const initialUpgradeLvl = Math.min(10, Math.max(0, Math.floor(Number(cooldownUpgradeLevel) || 0)));
    const initialXp = Math.max(Math.floor(initialClicks / 100), Math.max(0, Math.floor(Number(xp) || 0)));
    const lvlInfo = this.computeRoomLevel(initialXp);

    this.adminIds = new Set(Array.isArray(adminIds) ? adminIds.filter(Boolean) : []);
    this.bannedIds = new Set(Array.isArray(bannedIds) ? bannedIds.filter(Boolean) : []);
    this.timeouts.clear();

    this.role = 'host';
    this.isRoomSaved = this.getSavedRooms().some((r) => r.id === roomId);
    this.activeRoom = {
      id: roomId,
      name: (name || 'Room').trim(),
      desc: (desc || '').trim(),
      max: maxMembers,
      hostId: this.clientId,
      hostName: this.username,
      hostColor: this.userColor,
      count: 1,
      spectatorCount: 0,
      clicks: initialClicks,
      cooldownUpgradeLevel: initialUpgradeLvl,
      adminIds: Array.from(this.adminIds),
      bannedIds: Array.from(this.bannedIds),
      level: lvlInfo.level,
      xp: lvlInfo.totalXp,
      currentLevelXp: lvlInfo.currentLevelXp,
      xpNeeded: lvlInfo.xpNeeded,
      updatedAt: Date.now()
    };

    this.members.clear();
    this.playerClicks.clear();
    this.lastPlayerClickAt.clear();
    this.lastPlayerChatAt.clear();
    this.lastLocalClickAt = 0;
    this.lastLocalChatAt = 0;
    this.lastAppliedSnapshotAt = 0;
    this.processedClickIds.clear();
    this.processedAdminActionIds.clear();
    this.spectators.clear();
    this.playerClicks.set(this.clientId, 0);
    this.members.set(this.clientId, {
      id: this.clientId,
      name: this.username,
      color: this.userColor,
      isHost: true,
      isAdmin: false,
      isVerified: true,
      timeoutUntil: 0,
      clicks: 0,
      joinedAt: Date.now()
    });

    this.messages = [
      {
        id: 'sys_' + Date.now(),
        type: 'system',
        text: `Room hosted on your computer (ID: ${roomId})`
      }
    ];

    this._subscribeMqttRoom(roomId);
    this._startHostWebRTC(roomId);
    this._hostCommitState();

    this.heartbeatInterval = setInterval(() => {
      if (this.role === 'host' && this.activeRoom) {
        const pruned = this._hostPruneStaleSpectators();
        if (pruned) {
          this._hostCommitState();
        } else {
          this._publishRoomRegistry(this.activeRoom);
          this._hostSaveLocalSnapshot();
        }
      }
    }, this.cfg.HEARTBEAT_MS);

    if (this.cb.onEnterRoom) {
      this.cb.onEnterRoom(this.activeRoom, true);
    }
    this._notifyUIState();
  }

  _hostPruneStaleSpectators() {
    const now = Date.now();
    const ttl = (this.cfg && this.cfg.SPECTATOR_TTL_MS) || 15000;
    let changed = false;
    for (const [specId, lastSeen] of this.spectators.entries()) {
      const conn = this.hostWebRtcSpectatorConns.get(specId);
      if (conn && conn.open) {
        this.spectators.set(specId, now);
        continue;
      }
      if (now - lastSeen > ttl) {
        this.spectators.delete(specId);
        this.hostWebRtcSpectatorConns.delete(specId);
        changed = true;
      }
    }
    return changed;
  }

  _startHostWebRTC(roomId) {
    if (typeof Peer === 'undefined') return;
    clearTimeout(this.hostWebRtcRetryTimer);
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
          if (conn._spectatorId) {
            this._hostRemoveSpectator(conn._spectatorId);
          }
        });
      });

      this.peer.on('error', (err) => {
        if (
          err &&
          err.type === 'unavailable-id' &&
          this.role === 'host' &&
          this.activeRoom &&
          this.activeRoom.id === roomId
        ) {
          try {
            this.peer.destroy();
          } catch (_) {}
          this.peer = null;
          this.hostWebRtcRetryTimer = setTimeout(() => {
            if (this.role === 'host' && this.activeRoom && this.activeRoom.id === roomId) {
              this._startHostWebRTC(roomId);
            }
          }, 2600);
        }
      });
    } catch (_) {}
  }

  _hostBuildSnapshot() {
    const now = Date.now();
    this.activeRoom.count = this.members.size;
    this.activeRoom.spectatorCount = this.spectators.size;
    this.activeRoom.clicks = Math.max(0, Math.floor(Number(this.activeRoom.clicks) || 0));
    this.activeRoom.cooldownUpgradeLevel = Math.min(
      10,
      Math.max(0, Math.floor(Number(this.activeRoom.cooldownUpgradeLevel) || 0))
    );
    this.activeRoom.adminIds = Array.from(this.adminIds);
    this.activeRoom.bannedIds = Array.from(this.bannedIds);
    const lvlInfo = this.computeRoomLevel(this.activeRoom.xp);
    this.activeRoom.level = lvlInfo.level;
    this.activeRoom.xp = lvlInfo.totalXp;
    this.activeRoom.currentLevelXp = lvlInfo.currentLevelXp;
    this.activeRoom.xpNeeded = lvlInfo.xpNeeded;
    this.activeRoom.updatedAt = now;

    this.members.forEach((m) => {
      m.isAdmin = !m.isHost && this.adminIds.has(m.id);
      const tUntil = Number(this.timeouts.get(m.id)) || 0;
      if (tUntil > now) {
        m.timeoutUntil = tUntil;
      } else {
        m.timeoutUntil = 0;
        this.timeouts.delete(m.id);
      }
    });

    return {
      room: this.activeRoom,
      members: Array.from(this.members.values()),
      messages: this.messages.slice(-80),
      updatedAt: now
    };
  }

  _hostCommitState() {
    if (this.role !== 'host' || !this.activeRoom) return;
    const snapshot = this._hostBuildSnapshot();

    this._hostSaveLocalSnapshot(snapshot);
    if (this.isCurrentRoomSaved()) {
      this.saveCurrentRoomStats();
    }
    this._publishRoomRegistry(this.activeRoom);

    this._hostBroadcastToGuests({
      action: 'HOST_SNAPSHOT',
      snapshot
    });

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

    for (const conn of this.hostWebRtcConns.values()) {
      if (conn && conn.open) {
        try { conn.send(payload); } catch (_) {}
      }
    }

    for (const conn of this.hostWebRtcSpectatorConns.values()) {
      if (conn && conn.open) {
        try { conn.send(payload); } catch (_) {}
      }
    }

    this._emitRoomPacket(this.activeRoom.id, 'ALL_GUESTS', payload);
  }

  _hostProcessGuestAction(payload, webrtcConn) {
    if (!payload || !payload.action || this.role !== 'host' || !this.activeRoom) return;

    // 0. Anonymous spectator enters or pings (invisible, cannot chat, counted separately)
    if (payload.action === 'GUEST_SPECTATE' || (payload.action === 'GUEST_JOIN' && payload.isAnonymous)) {
      const { clientId } = payload;
      if (!clientId) return;

      const isNew = !this.spectators.has(clientId);
      this.spectators.set(clientId, Date.now());

      if (webrtcConn) {
        webrtcConn._spectatorId = clientId;
        this.hostWebRtcSpectatorConns.set(clientId, webrtcConn);
      }

      if (isNew) {
        // Silent commit: no join system message and not added to members
        this._hostCommitState();
      } else {
        const snapshot = this._hostBuildSnapshot();
        const pkt = { action: 'HOST_SNAPSHOT', snapshot };
        if (webrtcConn && webrtcConn.open) {
          try { webrtcConn.send(pkt); } catch (_) {}
        }
        this._emitRoomPacket(this.activeRoom.id, clientId, pkt);
      }
      return;
    }

    // 1. Guest joins or updates profile (verified members only)
    if (payload.action === 'GUEST_JOIN') {
      const { clientId, username, color } = payload;
      if (!clientId || !username) return;

      if (this.bannedIds.has(clientId)) {
        const rejectPkt = {
          action: 'HOST_REJECT',
          targetId: clientId,
          reason: 'You are banned from this room'
        };
        if (webrtcConn && webrtcConn.open) {
          try { webrtcConn.send(rejectPkt); } catch (_) {}
        }
        this._emitRoomPacket(this.activeRoom.id, clientId, rejectPkt);
        return;
      }

      if (this.spectators.has(clientId)) {
        this.spectators.delete(clientId);
        this.hostWebRtcSpectatorConns.delete(clientId);
      }

      const existing = this.members.get(clientId);
      if (!existing && this.members.size >= this.activeRoom.max) {
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

      const prevPlayerClicks = Math.max(
        0,
        Math.floor(Number(this.playerClicks.get(clientId)) || (existing && Number(existing.clicks)) || 0)
      );
      this.playerClicks.set(clientId, prevPlayerClicks);

      const tUntil = Number(this.timeouts.get(clientId)) || 0;
      const isHostMember = clientId === this.clientId;

      this.members.set(clientId, {
        id: clientId,
        name: username,
        color: color || (existing && existing.color) || this.cfg.USER_COLORS[0],
        isHost: isHostMember,
        isAdmin: !isHostMember && this.adminIds.has(clientId),
        isVerified: isHostMember ? true : Boolean(payload.isVerified),
        timeoutUntil: tUntil > Date.now() ? tUntil : 0,
        clicks: prevPlayerClicks,
        joinedAt: existing ? existing.joinedAt : Date.now()
      });

      if (!existing) {
        this.messages.push({
          id: 'sys_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          type: 'system',
          text: `${username} joined the room`
        });
      }

      this._hostCommitState();
      return;
    }

    // 2. Guest or Host clicks in Clicker Event (host-authoritative: cooldown + every 100 clicks -> +1 room XP)
    if (payload.action === 'GUEST_CLICK') {
      const { clientId, clickId, isAnonymous } = payload;
      if (isAnonymous || !clientId || this.spectators.has(clientId) || !this.members.has(clientId)) {
        return;
      }
      if (clickId) {
        if (this.processedClickIds.has(clickId)) {
          return;
        }
        this.processedClickIds.add(clickId);
        if (this.processedClickIds.size > 2000) {
          const oldest = this.processedClickIds.values().next().value;
          this.processedClickIds.delete(oldest);
        }
      }

      const { cooldownMs } = this.getCooldownUpgradeInfo();
      const now = Date.now();
      const prevClickAt = Number(this.lastPlayerClickAt.get(clientId)) || 0;
      if (cooldownMs > 0 && prevClickAt > 0) {
        const earliestAllowed = prevClickAt + cooldownMs;
        const jitterTolerance = clientId === this.clientId ? 0 : 350;
        if (now < earliestAllowed - jitterTolerance) {
          return;
        }
        this.lastPlayerClickAt.set(clientId, Math.max(now, earliestAllowed));
      } else {
        this.lastPlayerClickAt.set(clientId, now);
      }

      const member = this.members.get(clientId);
      const nextMemberClicks =
        Math.max(0, Math.floor(Number(this.playerClicks.get(clientId)) || Number(member.clicks) || 0)) + 1;
      this.playerClicks.set(clientId, nextMemberClicks);
      member.clicks = nextMemberClicks;

      const prevRoomClicks = Math.max(0, Math.floor(Number(this.activeRoom.clicks) || 0));
      const nextRoomClicks = prevRoomClicks + 1;
      this.activeRoom.clicks = nextRoomClicks;

      // Every 100 total room clicks awards +1 room XP
      const xpGained = Math.floor(nextRoomClicks / 100) - Math.floor(prevRoomClicks / 100);
      if (xpGained > 0) {
        this.activeRoom.xp = Math.max(0, Math.floor(Number(this.activeRoom.xp) || 0)) + xpGained;
      }

      this._hostCommitState();
      return;
    }

    // 3. Guest sends chat message (blocked for anonymous spectators, timed-out users, & 0.5s chat cooldown)
    if (payload.action === 'GUEST_CHAT') {
      const { clientId, color, text, msgId, isAnonymous } = payload;
      if (isAnonymous || !clientId || this.spectators.has(clientId) || !this.members.has(clientId)) {
        return;
      }
      const cleanText = (text || '').trim();
      if (!cleanText) return;

      if (msgId && this.messages.some((m) => m.id === msgId)) {
        return;
      }

      // Check active timeout
      const now = Date.now();
      const timeoutUntil = Number(this.timeouts.get(clientId)) || 0;
      if (timeoutUntil > now) {
        return;
      }

      // Enforce 0.5s (500ms) chat cooldown on host server
      const prevChatAt = Number(this.lastPlayerChatAt.get(clientId)) || 0;
      if (prevChatAt > 0) {
        const earliestChat = prevChatAt + 500;
        const jitterTol = clientId === this.clientId ? 0 : 220;
        if (now < earliestChat - jitterTol) {
          return;
        }
        this.lastPlayerChatAt.set(clientId, Math.max(now, earliestChat));
      } else {
        this.lastPlayerChatAt.set(clientId, now);
      }

      const sender = this.members.get(clientId);
      if (color) sender.color = color;

      const msg = {
        id: msgId || ('msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
        type: 'user',
        clientId: sender.id,
        author: sender.name,
        color: sender.color || this.cfg.USER_COLORS[0],
        text: cleanText.slice(0, 500),
        time: this._formatTime(new Date())
      };

      this.messages.push(msg);
      this._hostCommitState();
      return;
    }

    // 4. Administration & Upgrade Actions (Host-Authoritative Permission Verification)
    if (
      payload.action === 'ADMIN_SET_ROLE' ||
      payload.action === 'ADMIN_KICK' ||
      payload.action === 'ADMIN_BAN' ||
      payload.action === 'ADMIN_TIMEOUT' ||
      payload.action === 'ADMIN_DELETE_MSG' ||
      payload.action === 'ADMIN_BUY_UPGRADE'
    ) {
      if (payload.actionId) {
        if (this.processedAdminActionIds.has(payload.actionId)) return;
        this.processedAdminActionIds.add(payload.actionId);
        if (this.processedAdminActionIds.size > 1000) {
          const oldest = this.processedAdminActionIds.values().next().value;
          this.processedAdminActionIds.delete(oldest);
        }
      }

      const actorId = payload.actorId;
      const actor = this.members.get(actorId);
      if (!actorId || !actor) return;

      const actorIsOwner = actorId === this.clientId;
      const actorIsAdmin = !actorIsOwner && this.adminIds.has(actorId);
      if (!actorIsOwner && !actorIsAdmin) return;

      // 4a. Owner defines/removes Admin
      if (payload.action === 'ADMIN_SET_ROLE') {
        if (!actorIsOwner) return;
        const target = this.members.get(payload.targetId);
        if (!target || target.isHost) return;

        if (payload.isAdmin) {
          this.adminIds.add(target.id);
          target.isAdmin = true;
          this.timeouts.delete(target.id);
          target.timeoutUntil = 0;
          this.messages.push({
            id: 'sys_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            type: 'system',
            text: `${target.name} is now a room Admin`
          });
        } else {
          this.adminIds.delete(target.id);
          target.isAdmin = false;
          this.messages.push({
            id: 'sys_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            type: 'system',
            text: `${target.name} is no longer an Admin`
          });
        }
        this._hostCommitState();
        return;
      }

      // 4b. Owner or Admin kicks a non-admin user
      if (payload.action === 'ADMIN_KICK') {
        const target = this.members.get(payload.targetId);
        if (!target || target.isHost || this.adminIds.has(target.id)) return;

        const kickPkt = {
          action: 'HOST_KICK',
          targetId: target.id,
          reason: `You were kicked from the room by ${actor.name}`
        };
        const tConn = this.hostWebRtcConns.get(target.id);
        if (tConn && tConn.open) {
          try { tConn.send(kickPkt); } catch (_) {}
        }
        this._emitRoomPacket(this.activeRoom.id, target.id, kickPkt);

        this.members.delete(target.id);
        this.hostWebRtcConns.delete(target.id);

        this.messages.push({
          id: 'sys_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          type: 'system',
          text: `${target.name} was kicked by ${actor.name}`
        });
        this._hostCommitState();
        return;
      }

      // 4c. Owner bans a user
      if (payload.action === 'ADMIN_BAN') {
        if (!actorIsOwner) return;
        const target = this.members.get(payload.targetId);
        if (!target || target.isHost) return;

        this.bannedIds.add(target.id);
        this.adminIds.delete(target.id);

        const banPkt = {
          action: 'HOST_BAN',
          targetId: target.id,
          reason: `You have been banned from this room by ${actor.name}`
        };
        const tConn = this.hostWebRtcConns.get(target.id);
        if (tConn && tConn.open) {
          try { tConn.send(banPkt); } catch (_) {}
        }
        this._emitRoomPacket(this.activeRoom.id, target.id, banPkt);

        this.members.delete(target.id);
        this.hostWebRtcConns.delete(target.id);

        this.messages.push({
          id: 'sys_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          type: 'system',
          text: `${target.name} was banned by ${actor.name}`
        });
        this._hostCommitState();
        return;
      }

      // 4d. Owner or Admin times out a non-admin user
      if (payload.action === 'ADMIN_TIMEOUT') {
        const target = this.members.get(payload.targetId);
        if (!target || target.isHost || this.adminIds.has(target.id)) return;

        const durationMs = Math.max(0, Math.floor(Number(payload.durationMs) || 0));
        if (durationMs > 0) {
          const until = Date.now() + durationMs;
          this.timeouts.set(target.id, until);
          target.timeoutUntil = until;
          const sec = Math.round(durationMs / 1000);
          this.messages.push({
            id: 'sys_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            type: 'system',
            text: `${target.name} was timed out for ${sec}s by ${actor.name}`
          });
        } else {
          this.timeouts.delete(target.id);
          target.timeoutUntil = 0;
          this.messages.push({
            id: 'sys_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            type: 'system',
            text: `${target.name}'s timeout was removed by ${actor.name}`
          });
        }
        this._hostCommitState();
        return;
      }

      // 4e. Owner or Admin deletes a chat message
      if (payload.action === 'ADMIN_DELETE_MSG') {
        const msgIndex = this.messages.findIndex((m) => m.id === payload.msgId);
        if (msgIndex === -1) return;
        const targetMsg = this.messages[msgIndex];
        if (!targetMsg || targetMsg.type === 'system') return;

        // Admins can only delete non-admin/non-owner messages (or their own)
        if (!actorIsOwner) {
          const msgAuthorIsOwner = targetMsg.clientId === this.clientId;
          const msgAuthorIsAdmin = this.adminIds.has(targetMsg.clientId);
          if ((msgAuthorIsOwner || msgAuthorIsAdmin) && targetMsg.clientId !== actorId) {
            return;
          }
        }

        this.messages.splice(msgIndex, 1);
        this._hostCommitState();
        return;
      }

      // 4f. Owner or Admin buys Clicker Cooldown Upgrade
      if (payload.action === 'ADMIN_BUY_UPGRADE') {
        const info = this.getCooldownUpgradeInfo();
        if (info.isMaxed) return;
        const currentClicks = Math.max(0, Math.floor(Number(this.activeRoom.clicks) || 0));
        if (currentClicks < info.nextCost) return;

        this.activeRoom.clicks = currentClicks - info.nextCost;
        this.activeRoom.cooldownUpgradeLevel = info.level + 1;
        this._hostCommitState();
        return;
      }
    }

    // 5. Guest or spectator leaves
    if (payload.action === 'GUEST_LEAVE') {
      if (payload.isAnonymous || this.spectators.has(payload.clientId)) {
        this._hostRemoveSpectator(payload.clientId);
      } else {
        this._hostRemoveMember(payload.clientId);
      }
    }
  }

  _hostRemoveSpectator(clientId) {
    if (this.role !== 'host' || !this.activeRoom) return;
    if (!this.spectators.has(clientId)) return;
    this.spectators.delete(clientId);
    this.hostWebRtcSpectatorConns.delete(clientId);
    // Silent commit: spectators are invisible in chat
    this._hostCommitState();
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

    if (this.activeRoom && this.activeRoom.id === roomId) {
      if (this.cb.onEnterRoom) {
        this.cb.onEnterRoom(this.activeRoom, this.role === 'host');
      }
      this._notifyUIState();
      return;
    }

    const knownMeta = this.rooms.get(roomId);
    const rawLocalSnap = this._readLocalSnapshot(roomId);
    const localSnap =
      rawLocalSnap &&
      rawLocalSnap.updatedAt &&
      Date.now() - rawLocalSnap.updatedAt < this.cfg.ROOM_TTL_MS
        ? rawLocalSnap
        : null;

    this.leaveRoom();

    this.role = 'guest';
    this.lastAppliedSnapshotAt = (localSnap && Number(localSnap.updatedAt)) || 0;
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
          hostColor: this.cfg.USER_COLORS[0],
          count: 1,
          spectatorCount: 0,
          xp: 0
        };

    this.activeRoom.spectatorCount = Math.max(0, Number(this.activeRoom.spectatorCount) || 0);
    this.activeRoom.clicks = Math.max(0, Math.floor(Number(this.activeRoom.clicks) || 0));
    this.activeRoom.cooldownUpgradeLevel = Math.min(
      10,
      Math.max(0, Math.floor(Number(this.activeRoom.cooldownUpgradeLevel) || 0))
    );
    this.lastLocalClickAt = 0;
    const initLvl = this.computeRoomLevel(this.activeRoom.xp);
    this.activeRoom.level = initLvl.level;
    this.activeRoom.xp = initLvl.totalXp;
    this.activeRoom.currentLevelXp = initLvl.currentLevelXp;
    this.activeRoom.xpNeeded = initLvl.xpNeeded;

    if (
      !this.isAnonymous &&
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

    this.members.clear();
    if (localSnap && Array.isArray(localSnap.members)) {
      localSnap.members.forEach((m) =>
        this.members.set(m.id, {
          ...m,
          clicks: Math.max(0, Math.floor(Number(m.clicks) || 0))
        })
      );
    } else {
      const hid = this.activeRoom.hostId || ('host_' + roomId);
      this.members.set(hid, {
        id: hid,
        name: this.activeRoom.hostName || 'Host',
        color: this.activeRoom.hostColor || this.cfg.USER_COLORS[0],
        isHost: true,
        isVerified: true,
        clicks: 0
      });
    }

    // Anonymous spectators are invisible and never added to members
    if (!this.isAnonymous) {
      const existingMe = this.members.get(this.clientId);
      this.members.set(this.clientId, {
        id: this.clientId,
        name: this.username,
        color: this.userColor,
        isHost: false,
        isVerified: this.isEmailVerified,
        clicks: existingMe ? Math.max(0, Math.floor(Number(existingMe.clicks) || 0)) : 0
      });
    } else {
      this.activeRoom.spectatorCount = Math.max(1, this.activeRoom.spectatorCount);
    }

    this.messages = (localSnap && Array.isArray(localSnap.messages))
      ? [...localSnap.messages]
      : [
          {
            id: 'sys_init_' + Date.now(),
            type: 'system',
            text: `Connected to room ${this.activeRoom.name} (${roomId})`
          }
        ];

    if (this.cb.onEnterRoom) {
      this.cb.onEnterRoom(this.activeRoom, false);
    }
    this._notifyUIState();

    this._subscribeMqttRoom(roomId);
    this._startGuestWebRTC(roomId);

    let hostSynced = false;
    const sendEntryPacket = () => {
      if (this.role !== 'guest' || !this.activeRoom) return;
      const pkt = this.isAnonymous
        ? {
            action: 'GUEST_SPECTATE',
            clientId: this.clientId,
            isAnonymous: true
          }
        : {
            action: 'GUEST_JOIN',
            clientId: this.clientId,
            username: this.username,
            color: this.userColor,
            isAnonymous: false,
            isVerified: this.isEmailVerified
          };
      if (this.guestWebRtcConn && this.guestWebRtcConn.open) {
        try { this.guestWebRtcConn.send(pkt); } catch (_) {}
      }
      this._emitRoomPacket(roomId, 'HOST', pkt);
    };

    this._onHostConfirmed = () => {
      hostSynced = true;
    };

    sendEntryPacket();

    let attempts = 0;
    let tickCount = 0;
    this.guestSyncInterval = setInterval(() => {
      if (this.role !== 'guest' || !this.activeRoom) return;
      tickCount++;

      const snap = this._readLocalSnapshot(roomId);
      if (
        snap &&
        snap.members &&
        snap.updatedAt &&
        Date.now() - snap.updatedAt < this.cfg.ROOM_TTL_MS
      ) {
        if (this.isAnonymous || snap.members.some((m) => m.id === this.clientId)) {
          hostSynced = true;
          if (snap.updatedAt > this.lastAppliedSnapshotAt) {
            this._guestApplySnapshot(snap);
          }
        }
      }

      if (!hostSynced && attempts < 10) {
        attempts++;
        sendEntryPacket();
      } else if (this.isAnonymous && tickCount % 8 === 0) {
        // Periodic spectator heartbeat so host keeps accurate spectator count
        sendEntryPacket();
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
          if (this.isAnonymous) {
            conn.send({
              action: 'GUEST_SPECTATE',
              clientId: this.clientId,
              isAnonymous: true
            });
          } else {
            conn.send({
              action: 'GUEST_JOIN',
              clientId: this.clientId,
              username: this.username,
              color: this.userColor,
              isAnonymous: false,
              isVerified: this.isEmailVerified
            });
          }
        });

        conn.on('data', (pkt) => this._guestProcessHostPacket(pkt));
      });

      this.peer.on('error', () => {});
    } catch (_) {}
  }

  _guestProcessHostPacket(payload) {
    if (!payload || !payload.action || this.role !== 'guest' || !this.activeRoom) return;

    if (
      payload.action === 'HOST_REJECT' ||
      payload.action === 'HOST_KICK' ||
      payload.action === 'HOST_BAN'
    ) {
      if (payload.targetId && payload.targetId !== this.clientId) return;
      if (this.cb.onError) {
        this.cb.onError(payload.reason || 'Removed from room');
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
    const snapTime = Number(snap.updatedAt) || 0;
    if (snapTime && this.lastAppliedSnapshotAt && snapTime < this.lastAppliedSnapshotAt) {
      return;
    }
    if (snapTime) {
      this.lastAppliedSnapshotAt = snapTime;
    }
    if (snap.room) {
      const clicks = Math.max(0, Math.floor(Number(snap.room.clicks) || 0));
      const cooldownUpgradeLevel = Math.min(
        10,
        Math.max(0, Math.floor(Number(snap.room.cooldownUpgradeLevel) || 0))
      );
      const adminIds = Array.isArray(snap.room.adminIds) ? snap.room.adminIds.filter(Boolean) : [];
      const bannedIds = Array.isArray(snap.room.bannedIds) ? snap.room.bannedIds.filter(Boolean) : [];
      this.adminIds = new Set(adminIds);
      this.bannedIds = new Set(bannedIds);

      if (this.bannedIds.has(this.clientId)) {
        if (this.cb.onError) {
          this.cb.onError('You have been banned from this room');
        }
        this.leaveRoom();
        return;
      }

      const xp = Math.max(Math.floor(clicks / 100), Number(snap.room.xp) || 0);
      const lvlInfo = this.computeRoomLevel(xp);
      this.activeRoom = {
        ...snap.room,
        spectatorCount: Math.max(0, Number(snap.room.spectatorCount) || 0),
        clicks,
        cooldownUpgradeLevel,
        adminIds,
        bannedIds,
        level: lvlInfo.level,
        xp: lvlInfo.totalXp,
        currentLevelXp: lvlInfo.currentLevelXp,
        xpNeeded: lvlInfo.xpNeeded
      };
    }
    if (Array.isArray(snap.members)) {
      this.members.clear();
      this.timeouts.clear();
      snap.members.forEach((m) => {
        const tUntil = Math.max(0, Math.floor(Number(m.timeoutUntil) || 0));
        if (tUntil > Date.now()) {
          this.timeouts.set(m.id, tUntil);
        }
        this.members.set(m.id, {
          ...m,
          isAdmin: Boolean(m.isAdmin || this.adminIds.has(m.id)),
          timeoutUntil: tUntil,
          clicks: Math.max(0, Math.floor(Number(m.clicks) || 0))
        });
      });
      if (!this.isAnonymous && !this.members.has(this.clientId)) {
        this.members.set(this.clientId, {
          id: this.clientId,
          name: this.username,
          color: this.userColor,
          isHost: false,
          isAdmin: this.adminIds.has(this.clientId),
          isVerified: this.isEmailVerified,
          timeoutUntil: 0,
          clicks: 0
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
   * CLICKER EVENT, UPGRADES, SENDING CHAT & LEAVING ROOM
   * ========================================================= */
  getRemainingCooldownMs() {
    if (!this.activeRoom) return 0;
    const { cooldownMs } = this.getCooldownUpgradeInfo();
    if (cooldownMs <= 0 || !this.lastLocalClickAt) return 0;
    return Math.max(0, cooldownMs - (Date.now() - this.lastLocalClickAt));
  }

  sendClick() {
    if (this.isAnonymous || !this.activeRoom) return false;

    const { cooldownMs } = this.getCooldownUpgradeInfo();
    const now = Date.now();
    if (cooldownMs > 0 && now - this.lastLocalClickAt < cooldownMs) {
      return false;
    }
    this.lastLocalClickAt = now;

    const clickId =
      'clk_' + this.clientId + '_' + now + '_' + Math.random().toString(36).slice(2, 7);

    if (this.role === 'host') {
      this._hostProcessGuestAction({
        action: 'GUEST_CLICK',
        clientId: this.clientId,
        clickId,
        isAnonymous: false
      });
    } else if (this.role === 'guest') {
      const prevClicks = Math.max(0, Math.floor(Number(this.activeRoom.clicks) || 0));
      const nextClicks = prevClicks + 1;
      this.activeRoom.clicks = nextClicks;
      const xpGained = Math.floor(nextClicks / 100) - Math.floor(prevClicks / 100);
      if (xpGained > 0) {
        this.activeRoom.xp = Math.max(0, Math.floor(Number(this.activeRoom.xp) || 0)) + xpGained;
        const lvlInfo = this.computeRoomLevel(this.activeRoom.xp);
        this.activeRoom.level = lvlInfo.level;
        this.activeRoom.xp = lvlInfo.totalXp;
        this.activeRoom.currentLevelXp = lvlInfo.currentLevelXp;
        this.activeRoom.xpNeeded = lvlInfo.xpNeeded;
      }
      if (this.members.has(this.clientId)) {
        const me = this.members.get(this.clientId);
        me.clicks = Math.max(0, Math.floor(Number(me.clicks) || 0)) + 1;
      }
      this._notifyUIState();

      const clickPkt = {
        action: 'GUEST_CLICK',
        clientId: this.clientId,
        clickId,
        isAnonymous: false
      };
      if (this.guestWebRtcConn && this.guestWebRtcConn.open) {
        try {
          this.guestWebRtcConn.send(clickPkt);
        } catch (_) {}
      }
      this._emitRoomPacket(this.activeRoom.id, 'HOST', clickPkt);
    }
    return true;
  }

  _sendActionToHost(payload) {
    if (!this.activeRoom || !payload) return false;
    const pkt = {
      ...payload,
      actionId:
        payload.actionId ||
        'act_' + this.clientId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)
    };
    if (this.role === 'host') {
      this._hostProcessGuestAction(pkt, null);
    } else if (this.role === 'guest') {
      if (this.guestWebRtcConn && this.guestWebRtcConn.open) {
        try {
          this.guestWebRtcConn.send(pkt);
        } catch (_) {}
      }
      this._emitRoomPacket(this.activeRoom.id, 'HOST', pkt);
    }
    return true;
  }

  setAdmin(targetId, makeAdmin) {
    if (!this.isOwner(this.clientId) || !targetId) return false;
    return this._sendActionToHost({
      action: 'ADMIN_SET_ROLE',
      actorId: this.clientId,
      targetId,
      isAdmin: Boolean(makeAdmin)
    });
  }

  kickUser(targetId) {
    if (!this.isOwnerOrAdmin(this.clientId) || !targetId) return false;
    const target = this.members.get(targetId);
    if (!target || target.isHost || target.isAdmin || this.isAdmin(targetId)) return false;
    return this._sendActionToHost({
      action: 'ADMIN_KICK',
      actorId: this.clientId,
      targetId
    });
  }

  banUser(targetId) {
    if (!this.isOwner(this.clientId) || !targetId) return false;
    const target = this.members.get(targetId);
    if (!target || target.isHost) return false;
    return this._sendActionToHost({
      action: 'ADMIN_BAN',
      actorId: this.clientId,
      targetId
    });
  }

  timeoutUser(targetId, durationMs = 60000) {
    if (!this.isOwnerOrAdmin(this.clientId) || !targetId) return false;
    const target = this.members.get(targetId);
    if (!target || target.isHost || target.isAdmin || this.isAdmin(targetId)) return false;
    return this._sendActionToHost({
      action: 'ADMIN_TIMEOUT',
      actorId: this.clientId,
      targetId,
      durationMs: Math.max(0, Math.floor(Number(durationMs) || 0))
    });
  }

  deleteMessage(msgId) {
    if (!this.isOwnerOrAdmin(this.clientId) || !msgId) return false;
    const msg = this.messages.find((m) => m.id === msgId);
    if (msg && !this.canDeleteMessage(msg)) return false;

    if (this.role === 'guest') {
      this.messages = this.messages.filter((m) => m.id !== msgId);
      this._notifyUIState();
    }
    return this._sendActionToHost({
      action: 'ADMIN_DELETE_MSG',
      actorId: this.clientId,
      msgId
    });
  }

  buyCooldownUpgrade() {
    if (!this.activeRoom || !this.isOwnerOrAdmin(this.clientId)) {
      return { ok: false, reason: 'Only the Owner and Admins can buy upgrades' };
    }
    const info = this.getCooldownUpgradeInfo();
    if (info.isMaxed) {
      return { ok: false, reason: 'Cooldown upgrade is already maxed' };
    }
    const currentClicks = Math.max(0, Math.floor(Number(this.activeRoom.clicks) || 0));
    if (currentClicks < info.nextCost) {
      return { ok: false, reason: `Need ${info.nextCost.toLocaleString()} total clicks` };
    }

    if (this.role === 'guest') {
      this.activeRoom.clicks = currentClicks - info.nextCost;
      this.activeRoom.cooldownUpgradeLevel = info.level + 1;
      this._notifyUIState();
    }

    this._sendActionToHost({
      action: 'ADMIN_BUY_UPGRADE',
      actorId: this.clientId
    });

    return {
      ok: true,
      level: this.activeRoom.cooldownUpgradeLevel,
      info: this.getCooldownUpgradeInfo()
    };
  }

  sendMessage(text) {
    if (this.isAnonymous) return false;
    const clean = (text || '').trim();
    if (!clean || !this.activeRoom) return false;

    if (this.getUserTimeoutRemainingMs(this.clientId) > 0) {
      return false;
    }

    const now = Date.now();
    if (this.lastLocalChatAt > 0 && now - this.lastLocalChatAt < 500) {
      return false;
    }
    this.lastLocalChatAt = now;

    const msgId = 'msg_' + now + '_' + Math.random().toString(36).slice(2, 7);

    if (this.role === 'host') {
      this._hostProcessGuestAction({
        action: 'GUEST_CHAT',
        clientId: this.clientId,
        username: this.username,
        color: this.userColor,
        text: clean,
        msgId,
        isAnonymous: false
      });
    } else if (this.role === 'guest') {
      this.messages.push({
        id: msgId,
        type: 'user',
        clientId: this.clientId,
        author: this.username,
        color: this.userColor,
        text: clean.slice(0, 500),
        time: this._formatTime(new Date())
      });
      this._notifyUIState();

      const chatPkt = {
        action: 'GUEST_CHAT',
        clientId: this.clientId,
        username: this.username,
        color: this.userColor,
        text: clean,
        msgId,
        isAnonymous: false
      };

      if (this.guestWebRtcConn && this.guestWebRtcConn.open) {
        try { this.guestWebRtcConn.send(chatPkt); } catch (_) {}
      }
      this._emitRoomPacket(this.activeRoom.id, 'HOST', chatPkt);
    }
    return true;
  }

  leaveRoom() {
    if (this.hostWebRtcRetryTimer) {
      clearTimeout(this.hostWebRtcRetryTimer);
      this.hostWebRtcRetryTimer = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.guestSyncInterval) {
      clearInterval(this.guestSyncInterval);
      this.guestSyncInterval = null;
    }

    if (this.role === 'host' && this.activeRoom) {
      if (this.isCurrentRoomSaved()) {
        this.saveCurrentRoomStats();
      }
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
        clientId: this.clientId,
        isAnonymous: this.isAnonymous
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

    for (const conn of this.hostWebRtcSpectatorConns.values()) {
      try { conn.close(); } catch (_) {}
    }
    this.hostWebRtcSpectatorConns.clear();

    if (this.peer) {
      try { this.peer.destroy(); } catch (_) {}
      this.peer = null;
    }

    this.role = null;
    this.activeRoom = null;
    this.isRoomSaved = false;
    this.members.clear();
    this.adminIds.clear();
    this.bannedIds.clear();
    this.timeouts.clear();
    this.playerClicks.clear();
    this.lastPlayerClickAt.clear();
    this.lastPlayerChatAt.clear();
    this.lastLocalClickAt = 0;
    this.lastLocalChatAt = 0;
    this.lastAppliedSnapshotAt = 0;
    this.processedClickIds.clear();
    this.processedAdminActionIds.clear();
    this.spectators.clear();
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
