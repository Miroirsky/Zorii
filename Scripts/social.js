/**
 * Zorii Social — Verified User Directory, Follow System & Live Hosting Status
 *
 * Uses Firebase Realtime Database (/users, /following, /followers) with
 * localStorage + BroadcastChannel sync fallback so multi-tab local testing
 * works even if RTDB rules are not yet configured.
 */
class ZoriiSocial {
  constructor(callbacks) {
    this.cb = callbacks || {};
    this.cfg = window.ZORII_CONFIG;
    this.storageKey = 'zorii_social_mirror_v1';
    this.channel = typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel('zorii_social_bus_v1')
      : null;

    this.db = null;
    this.currentUid = null;
    this.currentUser = null;
    this.isVerified = false;
    this.canFollow = false;
    this.rtdbError = '';

    this.usersMap = new Map(); // uid -> { uid, name, color, verified, hosting, updatedAt }
    this.followingIds = new Set(); // targetUids
    this.followerCounts = new Map(); // uid -> number

    this._rtdbRefs = [];

    if (this.channel) {
      this.channel.onmessage = (e) => {
        if (e && e.data && e.data.type === 'SOCIAL_SYNC') {
          this._loadLocalMirror();
          this._emitChange();
        }
      };
    }

    window.addEventListener('storage', (e) => {
      if (e.key === this.storageKey) {
        this._loadLocalMirror();
        this._emitChange();
      }
    });
  }

  initFirebaseDatabase() {
    if (this.db) return this.db;
    if (typeof firebase !== 'undefined' && typeof firebase.database === 'function') {
      try {
        this.db = firebase.database();
      } catch (_) {
        this.db = null;
      }
    }
    return this.db;
  }

  _detachRtdbListeners() {
    this._rtdbRefs.forEach(({ ref, event, fn }) => {
      try {
        ref.off(event, fn);
      } catch (_) {}
    });
    this._rtdbRefs = [];
  }

  _readMirror() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return { users: {}, following: {}, followers: {} };
      const parsed = JSON.parse(raw);
      return {
        users: (parsed && parsed.users) || {},
        following: (parsed && parsed.following) || {},
        followers: (parsed && parsed.followers) || {}
      };
    } catch (_) {
      return { users: {}, following: {}, followers: {} };
    }
  }

  _writeMirror(data) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(data));
      if (this.channel) {
        this.channel.postMessage({ type: 'SOCIAL_SYNC' });
      }
    } catch (_) {}
  }

  _loadLocalMirror() {
    const mirror = this._readMirror();
    if (!this.db || this.rtdbError) {
      this.usersMap.clear();
      Object.values(mirror.users).forEach((u) => {
        if (u && u.uid && u.verified) {
          this.usersMap.set(u.uid, u);
        }
      });

      this.followingIds.clear();
      if (this.currentUid && mirror.following[this.currentUid]) {
        Object.keys(mirror.following[this.currentUid]).forEach((tid) => {
          if (mirror.following[this.currentUid][tid]) {
            this.followingIds.add(tid);
          }
        });
      }

      this.followerCounts.clear();
      Object.entries(mirror.followers).forEach(([uid, map]) => {
        if (map && typeof map === 'object') {
          const count = Object.values(map).filter(Boolean).length;
          this.followerCounts.set(uid, count);
        }
      });
    }
  }

  setUser({ uid, name, color, isVerified, canFollow }) {
    const cleanUid = uid || null;
    const verified = Boolean(isVerified && cleanUid);
    const allowFollow = Boolean((canFollow !== undefined ? canFollow : isVerified) && cleanUid);

    if (
      this.currentUid === cleanUid &&
      this.isVerified === verified &&
      this.canFollow === allowFollow &&
      allowFollow
    ) {
      if (verified) {
        this.syncProfile({ name, color });
      }
      return;
    }

    this._detachRtdbListeners();
    this.currentUid = cleanUid;
    this.isVerified = verified;
    this.canFollow = allowFollow;
    this.rtdbError = '';

    if (!allowFollow) {
      this.currentUser = null;
      this.followingIds.clear();
      this._emitChange();
      return;
    }

    this.currentUser = {
      uid: cleanUid,
      name: (name || 'User').trim(),
      color: color || this.cfg.USER_COLORS[0],
      verified,
      updatedAt: Date.now()
    };

    this._loadLocalMirror();
    if (verified) {
      this.syncProfile({ name: this.currentUser.name, color: this.currentUser.color });
    }

    const db = this.initFirebaseDatabase();
    if (db) {
      this._attachRtdbListeners(db, cleanUid);
    }
    this._emitChange();
  }

  _attachRtdbListeners(db, myUid) {
    const usersRef = db.ref('users');
    const onUsers = (snap) => {
      this.rtdbError = '';
      const val = snap.val() || {};
      this.usersMap.clear();
      Object.entries(val).forEach(([uid, u]) => {
        if (u && u.verified) {
          this.usersMap.set(uid, { ...u, uid });
        }
      });
      this._emitChange();
    };
    const onErr = (err) => {
      if (err && (err.code === 'PERMISSION_DENIED' || /permission_denied/i.test(err.message || ''))) {
        this.rtdbError = 'Activez Realtime Database (auth != null) dans Firebase Console';
        this._loadLocalMirror();
        this._emitChange();
      }
    };
    usersRef.on('value', onUsers, onErr);
    this._rtdbRefs.push({ ref: usersRef, event: 'value', fn: onUsers });

    const followingRef = db.ref(`following/${myUid}`);
    const onFollowing = (snap) => {
      const val = snap.val() || {};
      this.followingIds.clear();
      Object.entries(val).forEach(([targetUid, active]) => {
        if (active) this.followingIds.add(targetUid);
      });
      this._emitChange();
    };
    followingRef.on('value', onFollowing, onErr);
    this._rtdbRefs.push({ ref: followingRef, event: 'value', fn: onFollowing });

    const followersRef = db.ref('followers');
    const onFollowers = (snap) => {
      const val = snap.val() || {};
      this.followerCounts.clear();
      Object.entries(val).forEach(([targetUid, map]) => {
        if (map && typeof map === 'object') {
          const count = Object.values(map).filter(Boolean).length;
          this.followerCounts.set(targetUid, count);
        }
      });
      this._emitChange();
    };
    followersRef.on('value', onFollowers, onErr);
    this._rtdbRefs.push({ ref: followersRef, event: 'value', fn: onFollowers });
  }

  syncProfile({ name, color }) {
    if (!this.isVerified || !this.currentUid) return;
    const cleanName = (name || 'User').trim();
    const cleanColor = color || this.cfg.USER_COLORS[0];
    this.currentUser = {
      uid: this.currentUid,
      name: cleanName,
      color: cleanColor,
      verified: true,
      updatedAt: Date.now()
    };

    // Update local mirror
    const mirror = this._readMirror();
    const existingMirrorUser = mirror.users[this.currentUid] || {};
    mirror.users[this.currentUid] = {
      ...existingMirrorUser,
      uid: this.currentUid,
      name: cleanName,
      color: cleanColor,
      verified: true,
      updatedAt: Date.now()
    };
    this._writeMirror(mirror);
    this.usersMap.set(this.currentUid, {
      ...(this.usersMap.get(this.currentUid) || {}),
      ...mirror.users[this.currentUid]
    });

    const db = this.initFirebaseDatabase();
    if (db) {
      db.ref(`users/${this.currentUid}`).update({
        uid: this.currentUid,
        name: cleanName,
        color: cleanColor,
        verified: true,
        updatedAt: Date.now()
      }).catch(() => {});
    }
  }

  setHostingRoom(room) {
    if (!this.isVerified || !this.currentUid) return;

    const hostingObj = room && room.id
      ? {
          roomId: room.id,
          roomName: room.name || room.id,
          updatedAt: Date.now()
        }
      : null;

    // Update local mirror
    const mirror = this._readMirror();
    if (mirror.users[this.currentUid]) {
      if (hostingObj) {
        mirror.users[this.currentUid].hosting = hostingObj;
      } else {
        delete mirror.users[this.currentUid].hosting;
      }
      this._writeMirror(mirror);
    }

    const existingUser = this.usersMap.get(this.currentUid);
    if (existingUser) {
      if (hostingObj) existingUser.hosting = hostingObj;
      else delete existingUser.hosting;
    }

    const db = this.initFirebaseDatabase();
    if (db) {
      const hostingRef = db.ref(`users/${this.currentUid}/hosting`);
      if (hostingObj) {
        try {
          hostingRef.onDisconnect().remove();
        } catch (_) {}
        hostingRef.set(hostingObj).catch(() => {});
      } else {
        hostingRef.remove().catch(() => {});
      }
    }

    this._emitChange();
  }

  observeRoomMembers(members) {
    if (!Array.isArray(members) || members.length === 0) return;
    let changed = false;
    const mirror = this._readMirror();
    members.forEach((m) => {
      if (!m || !m.id) return;
      const memberVerified = Boolean(m.isVerified || m.isHost);
      if (!memberVerified) return;

      const existing = this.usersMap.get(m.id);
      if (!existing || existing.name !== m.name || existing.color !== m.color) {
        const entry = {
          ...(existing || {}),
          uid: m.id,
          name: m.name || (existing && existing.name) || 'User',
          color: m.color || (existing && existing.color) || this.cfg.USER_COLORS[0],
          verified: true,
          updatedAt: Date.now()
        };
        this.usersMap.set(m.id, entry);
        mirror.users[m.id] = { ...(mirror.users[m.id] || {}), ...entry };
        changed = true;
      }
    });
    if (changed) {
      this._writeMirror(mirror);
      this._emitChange();
    }
  }

  isVerifiedUser(uid) {
    if (!uid) return false;
    const u = this.usersMap.get(uid);
    return Boolean(u && u.verified);
  }

  async follow(targetUid, fallbackMeta = null) {
    if (!this.canFollow || !this.currentUid || !targetUid || targetUid === this.currentUid) {
      return false;
    }
    let target = this.usersMap.get(targetUid);
    if (!target && fallbackMeta && fallbackMeta.verified) {
      target = {
        uid: targetUid,
        name: fallbackMeta.name || 'User',
        color: fallbackMeta.color || this.cfg.USER_COLORS[0],
        verified: true,
        updatedAt: Date.now()
      };
      this.usersMap.set(targetUid, target);
    }
    if (!target || !target.verified) return false;

    if (!this.followingIds.has(targetUid)) {
      this.followingIds.add(targetUid);
      this.followerCounts.set(targetUid, this.getFollowerCount(targetUid) + 1);
    }

    const mirror = this._readMirror();
    if (!mirror.users[targetUid]) mirror.users[targetUid] = target;
    if (!mirror.following[this.currentUid]) mirror.following[this.currentUid] = {};
    mirror.following[this.currentUid][targetUid] = true;
    if (!mirror.followers[targetUid]) mirror.followers[targetUid] = {};
    mirror.followers[targetUid][this.currentUid] = true;
    this._writeMirror(mirror);
    this._emitChange();

    const db = this.initFirebaseDatabase();
    if (db) {
      try {
        await Promise.all([
          db.ref(`following/${this.currentUid}/${targetUid}`).set(true),
          db.ref(`followers/${targetUid}/${this.currentUid}`).set(true)
        ]);
      } catch (_) {}
    }
    return true;
  }

  async unfollow(targetUid) {
    if (!this.canFollow || !this.currentUid || !targetUid) return false;

    if (this.followingIds.has(targetUid)) {
      this.followingIds.delete(targetUid);
      this.followerCounts.set(targetUid, Math.max(0, this.getFollowerCount(targetUid) - 1));
    }

    const mirror = this._readMirror();
    if (mirror.following[this.currentUid]) {
      delete mirror.following[this.currentUid][targetUid];
    }
    if (mirror.followers[targetUid]) {
      delete mirror.followers[targetUid][this.currentUid];
    }
    this._writeMirror(mirror);
    this._emitChange();

    const db = this.initFirebaseDatabase();
    if (db) {
      try {
        await Promise.all([
          db.ref(`following/${this.currentUid}/${targetUid}`).remove(),
          db.ref(`followers/${targetUid}/${this.currentUid}`).remove()
        ]);
      } catch (_) {}
    }
    return true;
  }

  async toggleFollow(targetUid, fallbackMeta = null) {
    if (this.isFollowing(targetUid)) {
      await this.unfollow(targetUid);
      return false;
    }
    await this.follow(targetUid, fallbackMeta);
    return true;
  }

  isFollowing(targetUid) {
    return this.followingIds.has(targetUid);
  }

  getFollowerCount(uid) {
    if (!uid) return 0;
    return Number(this.followerCounts.get(uid)) || 0;
  }

  getMyFollowerCount() {
    return this.getFollowerCount(this.currentUid);
  }

  getHostingInfo(uid, p2pRooms) {
    if (!uid) return null;
    if (Array.isArray(p2pRooms)) {
      const liveRoom = p2pRooms.find((r) => r && r.hostId === uid);
      if (liveRoom) {
        return {
          roomId: liveRoom.id,
          roomName: liveRoom.name || liveRoom.id
        };
      }
    }
    const u = this.usersMap.get(uid);
    if (
      u &&
      u.hosting &&
      u.hosting.roomId &&
      Date.now() - (Number(u.hosting.updatedAt) || 0) < 25000
    ) {
      return {
        roomId: u.hosting.roomId,
        roomName: u.hosting.roomName || u.hosting.roomId
      };
    }
    return null;
  }

  getVerifiedUsers(query = '', p2pRooms = []) {
    const q = (query || '').trim().toLowerCase();
    return Array.from(this.usersMap.values())
      .filter((u) => u && u.verified && u.uid !== this.currentUid)
      .filter((u) => !q || (u.name || '').toLowerCase().includes(q))
      .map((u) => ({
        ...u,
        followersCount: this.getFollowerCount(u.uid),
        isFollowing: this.isFollowing(u.uid),
        hostingInfo: this.getHostingInfo(u.uid, p2pRooms)
      }))
      .sort((a, b) => {
        if (b.followersCount !== a.followersCount) return b.followersCount - a.followersCount;
        return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
      });
  }

  getFollowedUsers(p2pRooms = []) {
    const list = [];
    this.followingIds.forEach((uid) => {
      const u = this.usersMap.get(uid);
      if (u && u.verified) {
        list.push({
          ...u,
          followersCount: this.getFollowerCount(uid),
          hostingInfo: this.getHostingInfo(uid, p2pRooms)
        });
      }
    });
    return list.sort((a, b) => {
      const hostA = a.hostingInfo ? 1 : 0;
      const hostB = b.hostingInfo ? 1 : 0;
      if (hostB !== hostA) return hostB - hostA;
      return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    });
  }

  _emitChange() {
    if (this.cb.onSocialChanged) {
      this.cb.onSocialChanged();
    }
  }
}

window.ZoriiSocial = ZoriiSocial;
