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
  const btnToggleFollowSidebar = document.getElementById('btn-toggle-follow-sidebar');
  const topbarFollowersPill = document.getElementById('topbar-followers-pill');
  const topbarFollowersCount = document.getElementById('topbar-followers-count');
  const userBadge = document.getElementById('user-badge');
  const currentUserDot = document.getElementById('current-user-dot');
  const currentUsernameEl = document.getElementById('current-username');

  // Discord-style Follow Sidebar
  const followSidebar = document.getElementById('follow-sidebar');
  const sidebarFollowersCount = document.getElementById('sidebar-followers-count');
  const followSearchInput = document.getElementById('follow-search-input');
  const followRtdbNotice = document.getElementById('follow-rtdb-notice');
  const followSearchResultsEl = document.getElementById('follow-search-results');
  const followingListEl = document.getElementById('following-list');

  // Views
  const views = {
    auth: document.getElementById('view-auth'),
    profile: document.getElementById('view-profile'),
    menu: document.getElementById('view-menu'),
    join: document.getElementById('view-join'),
    host: document.getElementById('view-host'),
    room: document.getElementById('view-room')
  };

  // Auth Views & Controls (Firebase)
  const authErrorEl = document.getElementById('auth-error');
  const authFormsWrap = document.getElementById('auth-forms-wrap');
  const authVerifyPanel = document.getElementById('auth-verify-panel');
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const formLogin = document.getElementById('form-login');
  const loginNoEmailToggle = document.getElementById('login-no-email-toggle');
  const loginEmailInput = document.getElementById('login-email');
  const loginPasswordInput = document.getElementById('login-password');
  const btnForgotPassword = document.getElementById('btn-forgot-password');
  const btnLoginSubmit = document.getElementById('btn-login-submit');
  const formRegister = document.getElementById('form-register');
  const regUsernameInput = document.getElementById('reg-username');
  const regNoEmailToggle = document.getElementById('reg-no-email-toggle');
  const regEmailInput = document.getElementById('reg-email');
  const regPasswordInput = document.getElementById('reg-password');
  const btnRegisterSubmit = document.getElementById('btn-register-submit');
  const colorPickerEl = document.getElementById('color-picker');
  const btnAnonLogin = document.getElementById('btn-anon-login');
  const verifyEmailLabel = document.getElementById('verify-email-label');
  const btnCheckVerified = document.getElementById('btn-check-verified');
  const btnResendVerify = document.getElementById('btn-resend-verify');
  const btnVerifyLogout = document.getElementById('btn-verify-logout');

  // Profile View
  const btnProfileBack = document.getElementById('btn-profile-back');
  const profileVerifiedBox = document.getElementById('profile-verified-box');
  const profileAnonBox = document.getElementById('profile-anon-box');
  const profileEmailText = document.getElementById('profile-email-text');
  const profileFollowersCount = document.getElementById('profile-followers-count');
  const profileVerifiedBadge = document.getElementById('profile-verified-badge');
  const formProfile = document.getElementById('form-profile');
  const profileUsernameInput = document.getElementById('profile-username');
  const profileColorPickerEl = document.getElementById('profile-color-picker');
  const passwordFeedbackEl = document.getElementById('password-feedback');
  const formChangePassword = document.getElementById('form-change-password');
  const currentPasswordInput = document.getElementById('current-password');
  const newPasswordInput = document.getElementById('new-password');
  const confirmNewPasswordInput = document.getElementById('confirm-new-password');
  const btnChangePassword = document.getElementById('btn-change-password');
  const btnPasswordEmailPerm = document.getElementById('btn-password-email-perm');
  const btnLogout = document.getElementById('btn-logout');

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
  const roomLayoutEl = document.getElementById('room-layout');
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
  const chatReadonlyNotice = document.getElementById('chat-readonly-notice');
  const roomLevelValEl = document.getElementById('room-level-val');
  const roomXpFillEl = document.getElementById('room-xp-fill');
  const roomXpTextEl = document.getElementById('room-xp-text');
  const usersCountEl = document.getElementById('users-count');
  const spectatorsCountEl = document.getElementById('spectators-count');
  const usersListEl = document.getElementById('users-list');
  const eventTabPanel = document.getElementById('event-tab-panel');
  const eventResizeHandle = document.getElementById('event-resize-handle');
  const btnCloseEventTab = document.getElementById('btn-close-event-tab');
  const btnOpenClickerEvent = document.getElementById('btn-open-clicker-event');
  const eventBarClickerCount = document.getElementById('event-bar-clicker-count');
  const btnRoomClicker = document.getElementById('btn-room-clicker');
  const clickerTotalVal = document.getElementById('clicker-total-val');
  const clickerXpProgressLabel = document.getElementById('clicker-xp-progress-label');
  const clickerXpFill = document.getElementById('clicker-xp-fill');
  const clickerPlayersListEl = document.getElementById('clicker-players-list');
  const eventScaleBtns = document.querySelectorAll('.btn-event-scale');
  const toastEl = document.getElementById('toast');

  let activeEventId = null;
  let currentEventScaleRatio = 0.35;

  let toastTimer = null;
  let lastRenderedSignature = '';
  let renderedMsgCount = 0;
  let selectedColor = localStorage.getItem(cfg.STORAGE_COLOR_KEY) || cfg.USER_COLORS[0];
  let currentFirebaseUser = null;
  let pendingRegisterPseudo = '';
  let isAuthenticatedSession = false;

  // Initialize Firebase
  let firebaseAuth = null;
  if (typeof firebase !== 'undefined' && cfg.FIREBASE_CONFIG) {
    if (!firebase.apps || firebase.apps.length === 0) {
      firebase.initializeApp(cfg.FIREBASE_CONFIG);
    }
    firebaseAuth = firebase.auth();
    try {
      if (typeof firebase.analytics === 'function') {
        firebase.analytics();
      }
    } catch (_) {}
  }

  // Build color picker swatches
  function renderColorSwatches(containerEl) {
    if (!containerEl) return;
    containerEl.innerHTML = '';
    cfg.USER_COLORS.forEach((hex) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch' + (hex === selectedColor ? ' active' : '');
      btn.style.backgroundColor = hex;
      btn.style.color = hex;
      btn.addEventListener('click', () => {
        selectedColor = hex;
        renderColorSwatches(colorPickerEl);
        renderColorSwatches(profileColorPickerEl);
      });
      containerEl.appendChild(btn);
    });
  }
  renderColorSwatches(colorPickerEl);
  renderColorSwatches(profileColorPickerEl);

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.add('hidden');
    }, 2800);
  }

  function showAuthError(msg) {
    if (!authErrorEl) return;
    if (!msg) {
      authErrorEl.textContent = '';
      authErrorEl.classList.add('hidden');
    } else {
      authErrorEl.textContent = msg;
      authErrorEl.classList.remove('hidden');
    }
  }

  function formatFirebaseError(err) {
    const code = (err && err.code) || '';
    switch (code) {
      case 'auth/email-already-in-use':
        return 'Cette adresse e-mail est déjà utilisée.';
      case 'auth/invalid-email':
        return 'Adresse e-mail invalide.';
      case 'auth/weak-password':
        return 'Mot de passe trop faible (6 caractères minimum).';
      case 'auth/user-not-found':
      case 'auth/wrong-password':
      case 'auth/invalid-credential':
        return 'E-mail ou mot de passe incorrect.';
      case 'auth/too-many-requests':
        return 'Trop de tentatives. Patientez quelques instants.';
      case 'auth/operation-not-allowed':
        return 'Cette méthode de connexion n’est pas activée dans la console Firebase.';
      case 'auth/network-request-failed':
        return 'Erreur réseau. Vérifiez votre connexion internet.';
      default:
        return (err && err.message) || 'Une erreur est survenue.';
    }
  }

  function showView(viewId) {
    if (!isAuthenticatedSession && viewId !== 'view-auth') {
      viewId = 'view-auth';
    }
    Object.values(views).forEach((v) => v.classList.remove('active'));
    const target = document.getElementById(viewId);
    if (target) target.classList.add('active');

    if (viewId === 'view-auth') {
      topbar.classList.add('hidden');
      renderColorSwatches(colorPickerEl);
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
      scrollChatToBottom();
      if (!p2p.isAnonymous) {
        setTimeout(() => inputChat.focus(), 40);
      }
    } else if (viewId === 'view-profile') {
      renderColorSwatches(profileColorPickerEl);
    }
    if (typeof social !== 'undefined') {
      renderSocialUI();
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

  function syncRoomSpectatorUI() {
    if (formChat && chatReadonlyNotice) {
      formChat.classList.toggle('hidden', p2p.isAnonymous);
      chatReadonlyNotice.classList.toggle('hidden', !p2p.isAnonymous);
    }
    if (btnRoomClicker) {
      btnRoomClicker.disabled = p2p.isAnonymous;
    }
  }

  function applyEventTabWidthByRatio(ratio) {
    if (!eventTabPanel || !roomLayoutEl) return;
    const clampedRatio = Math.min(2 / 3, Math.max(0.24, Number(ratio) || 0.35));
    currentEventScaleRatio = clampedRatio;
    const containerWidth = roomLayoutEl.clientWidth || window.innerWidth || 1080;
    const maxPx = Math.floor(containerWidth * (2 / 3));
    const minPx = 260;
    const targetPx = Math.min(maxPx, Math.max(minPx, Math.round(containerWidth * clampedRatio)));
    eventTabPanel.style.setProperty('--event-tab-width', `${targetPx}px`);
    roomLayoutEl.classList.toggle('event-wide', clampedRatio >= 0.48);

    eventScaleBtns.forEach((btn) => {
      const btnScale = Number(btn.getAttribute('data-scale')) || 0;
      btn.classList.toggle('active', Math.abs(btnScale - clampedRatio) < 0.045);
    });
  }

  function openEventTab(eventId) {
    activeEventId = eventId;
    if (eventTabPanel) {
      eventTabPanel.classList.remove('hidden');
    }
    if (roomLayoutEl) {
      roomLayoutEl.classList.add('event-open');
    }
    if (btnOpenClickerEvent) {
      btnOpenClickerEvent.classList.toggle('active', eventId === 'clicker');
    }
    requestAnimationFrame(() => {
      applyEventTabWidthByRatio(currentEventScaleRatio);
    });
  }

  function closeEventTab() {
    activeEventId = null;
    if (eventTabPanel) {
      eventTabPanel.classList.add('hidden');
    }
    if (roomLayoutEl) {
      roomLayoutEl.classList.remove('event-open', 'event-wide');
    }
    if (btnOpenClickerEvent) {
      btnOpenClickerEvent.classList.remove('active');
    }
  }

  function updateClickerEventUI(room, members) {
    const totalClicks = Math.max(0, Math.floor(Number(room && room.clicks) || 0));
    const cycleClicks = totalClicks % 100;

    if (clickerTotalVal) {
      clickerTotalVal.textContent = totalClicks.toLocaleString();
    }
    if (eventBarClickerCount) {
      eventBarClickerCount.textContent = `${totalClicks.toLocaleString()} ${totalClicks === 1 ? 'click' : 'clicks'}`;
    }
    if (clickerXpProgressLabel) {
      clickerXpProgressLabel.textContent = `${cycleClicks} / 100`;
    }
    if (clickerXpFill) {
      clickerXpFill.style.width = `${cycleClicks}%`;
    }

    if (!clickerPlayersListEl) return;
    clickerPlayersListEl.innerHTML = '';

    const sortedMembers = [...(members || [])].sort((a, b) => {
      const ca = Math.max(0, Math.floor(Number(a && a.clicks) || 0));
      const cb = Math.max(0, Math.floor(Number(b && b.clicks) || 0));
      if (cb !== ca) return cb - ca;
      if (Boolean(b && b.isHost) !== Boolean(a && a.isHost)) return b && b.isHost ? 1 : -1;
      return ((a && a.name) || '').localeCompare((b && b.name) || '', undefined, { sensitivity: 'base' });
    });

    sortedMembers.forEach((m, index) => {
      const li = document.createElement('li');
      li.className = 'clicker-player-row';

      const left = document.createElement('div');
      left.className = 'clicker-player-left';

      const rank = document.createElement('span');
      rank.className = 'clicker-player-rank';
      rank.textContent = `#${index + 1}`;

      const userColor = m.color || cfg.USER_COLORS[0];
      const dot = document.createElement('span');
      dot.className = 'status-dot';
      dot.style.backgroundColor = userColor;
      dot.style.boxShadow = `0 0 8px ${userColor}`;

      const nameEl = document.createElement('span');
      nameEl.className = 'clicker-player-name';
      nameEl.style.color = userColor;
      nameEl.textContent = m.name;

      left.appendChild(rank);
      left.appendChild(dot);
      left.appendChild(nameEl);

      const right = document.createElement('div');
      right.className = 'clicker-player-right';

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

      const playerClicks = Math.max(0, Math.floor(Number(m.clicks) || 0));
      const countBadge = document.createElement('span');
      countBadge.className = 'clicker-player-count';
      countBadge.textContent = `${playerClicks.toLocaleString()} ${playerClicks === 1 ? 'click' : 'clicks'}`;
      right.appendChild(countBadge);

      li.appendChild(left);
      li.appendChild(right);
      clickerPlayersListEl.appendChild(li);
    });
  }

  let latestMembers = [];
  let hostingHeartbeatTimer = null;

  const social = new window.ZoriiSocial({
    onSocialChanged: () => {
      renderSocialUI();
    }
  });

  function formatFollowersLabel(count) {
    const n = Number(count) || 0;
    return n === 1 ? '1 abonné' : `${n} abonnés`;
  }

  const NO_EMAIL_DOMAIN = '@noemail.zorii.app';

  function isNoEmailUser(user) {
    return Boolean(user && user.email && user.email.toLowerCase().endsWith(NO_EMAIL_DOMAIN));
  }

  function pseudoToNoEmailAddress(pseudo) {
    const clean = (pseudo || '').trim().toLowerCase();
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < clean.length; i++) {
      const ch = clean.charCodeAt(i);
      h1 ^= ch;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= ch + i;
      h2 = Math.imul(h2, 0x85ebca6b);
    }
    const hex = (h1 >>> 0).toString(36) + '_' + (h2 >>> 0).toString(36);
    return `u_${hex}${NO_EMAIL_DOMAIN}`;
  }

  function renderSocialUI() {
    const canUseFollow = isAuthenticatedSession && !p2p.isAnonymous && !views.auth.classList.contains('active');
    const canHaveFollowers = canUseFollow && p2p.isEmailVerified;

    if (followSidebar) {
      followSidebar.classList.toggle('hidden', !canUseFollow);
    }
    if (topbarFollowersPill) {
      topbarFollowersPill.classList.toggle('hidden', !canHaveFollowers);
    }
    if (sidebarFollowersCount) {
      sidebarFollowersCount.classList.toggle('hidden', !canHaveFollowers);
    }
    if (btnToggleFollowSidebar) {
      btnToggleFollowSidebar.classList.toggle('hidden', !canUseFollow);
    }

    if (!canUseFollow) return;

    const myFollowers = social.getMyFollowerCount();
    if (topbarFollowersCount) topbarFollowersCount.textContent = myFollowers;
    if (sidebarFollowersCount) sidebarFollowersCount.textContent = formatFollowersLabel(myFollowers);
    if (profileFollowersCount) profileFollowersCount.textContent = formatFollowersLabel(myFollowers);

    if (followRtdbNotice) {
      if (social.rtdbError) {
        followRtdbNotice.textContent = social.rtdbError;
        followRtdbNotice.classList.remove('hidden');
      } else {
        followRtdbNotice.classList.add('hidden');
      }
    }

    const p2pRooms = p2p.getRooms();

    // 1. Search / Discover Verified Users
    if (followSearchResultsEl && followSearchInput) {
      const q = followSearchInput.value.trim();
      if (!q) {
        followSearchResultsEl.classList.add('hidden');
        followSearchResultsEl.innerHTML = '';
      } else {
        const matches = social.getVerifiedUsers(q, p2pRooms);
        followSearchResultsEl.classList.remove('hidden');
        followSearchResultsEl.innerHTML = '';

        if (matches.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'follow-empty-search';
          empty.textContent = 'Aucun utilisateur vérifié trouvé';
          followSearchResultsEl.appendChild(empty);
        } else {
          matches.slice(0, 12).forEach((u) => {
            const row = document.createElement('div');
            row.className = 'follow-search-row';

            const left = document.createElement('div');
            left.className = 'follow-user-left';

            const dot = document.createElement('span');
            dot.className = 'status-dot';
            dot.style.backgroundColor = u.color || cfg.USER_COLORS[0];
            dot.style.boxShadow = `0 0 8px ${u.color || cfg.USER_COLORS[0]}`;

            const info = document.createElement('div');
            info.className = 'follow-user-info';

            const nameEl = document.createElement('div');
            nameEl.className = 'follow-user-name';
            nameEl.style.color = u.color || cfg.USER_COLORS[0];
            nameEl.textContent = u.name;

            const subEl = document.createElement('div');
            subEl.className = 'follow-user-sub';
            subEl.textContent = formatFollowersLabel(u.followersCount);

            info.appendChild(nameEl);
            info.appendChild(subEl);
            left.appendChild(dot);
            left.appendChild(info);

            const followBtn = document.createElement('button');
            followBtn.type = 'button';
            followBtn.className = 'btn-follow-sm' + (u.isFollowing ? ' following' : '');
            followBtn.textContent = u.isFollowing ? 'Suivi' : 'Follow';
            followBtn.addEventListener('click', async () => {
              await social.toggleFollow(u.uid);
            });

            row.appendChild(left);
            row.appendChild(followBtn);
            followSearchResultsEl.appendChild(row);
          });
        }
      }
    }

    // 2. Discord-style Followed Users List
    if (followingListEl) {
      const followed = social.getFollowedUsers(p2pRooms);
      followingListEl.innerHTML = '';

      if (followed.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'follow-empty';
        empty.textContent = 'Aucun abonnement. Cherchez un utilisateur vérifié ci-dessus ou cliquez sur Follow dans une room.';
        followingListEl.appendChild(empty);
      } else {
        followed.forEach((u) => {
          const item = document.createElement('div');
          item.className = 'following-item' + (u.hostingInfo ? ' is-hosting' : '');

          const left = document.createElement('div');
          left.className = 'follow-user-left';

          const avatar = document.createElement('span');
          avatar.className = 'follow-avatar-dot' + (u.hostingInfo ? ' hosting-pulse' : '');
          avatar.style.backgroundColor = u.color || cfg.USER_COLORS[0];
          avatar.style.color = u.color || cfg.USER_COLORS[0];

          const info = document.createElement('div');
          info.className = 'follow-user-info';

          const nameRow = document.createElement('div');
          nameRow.className = 'follow-name-row';

          const nameEl = document.createElement('span');
          nameEl.className = 'follow-user-name';
          nameEl.style.color = u.color || cfg.USER_COLORS[0];
          nameEl.textContent = u.name;

          const countEl = document.createElement('span');
          countEl.className = 'follow-count-mini';
          countEl.textContent = `${u.followersCount}`;
          countEl.title = formatFollowersLabel(u.followersCount);

          nameRow.appendChild(nameEl);
          nameRow.appendChild(countEl);
          info.appendChild(nameRow);

          const statusEl = document.createElement('div');
          statusEl.className = 'follow-user-status';
          if (u.hostingInfo) {
            statusEl.classList.add('hosting');
            statusEl.textContent = `Héberge : ${u.hostingInfo.roomName}`;
          } else {
            statusEl.textContent = 'Ne héberge pas';
          }
          info.appendChild(statusEl);

          left.appendChild(avatar);
          left.appendChild(info);

          const actions = document.createElement('div');
          actions.className = 'following-actions';

          if (u.hostingInfo) {
            const joinBtn = document.createElement('button');
            joinBtn.type = 'button';
            joinBtn.className = 'btn-follow-join';
            joinBtn.textContent = 'Join';
            joinBtn.title = `Rejoindre ${u.hostingInfo.roomName}`;
            joinBtn.addEventListener('click', () => {
              p2p.joinRoom(u.hostingInfo.roomId);
              if (followSidebar) followSidebar.classList.remove('mobile-open');
            });
            actions.appendChild(joinBtn);
          }

          const unfollowBtn = document.createElement('button');
          unfollowBtn.type = 'button';
          unfollowBtn.className = 'btn-unfollow-x';
          unfollowBtn.title = `Ne plus suivre ${u.name}`;
          unfollowBtn.textContent = '×';
          unfollowBtn.addEventListener('click', async () => {
            await social.unfollow(u.uid);
          });
          actions.appendChild(unfollowBtn);

          item.appendChild(left);
          item.appendChild(actions);
          followingListEl.appendChild(item);
        });
      }
    }

    // Keep room member rows synchronized with follow state & follower counts
    if (views.room.classList.contains('active') && p2p.activeRoom) {
      renderRoomMembersList(latestMembers);
    }
  }

  function renderRoomMembersList(members) {
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

      const isTargetVerified = Boolean(m.isVerified || m.isHost || social.isVerifiedUser(m.id));
      if (!p2p.isAnonymous && m.id && m.id !== p2p.clientId && isTargetVerified) {
        const following = social.isFollowing(m.id);
        const fBtn = document.createElement('button');
        fBtn.type = 'button';
        fBtn.className = 'btn-member-follow' + (following ? ' following' : '');
        fBtn.title = `${social.getFollowerCount(m.id)} abonnés`;
        fBtn.textContent = following ? 'Suivi' : '+ Follow';
        fBtn.addEventListener('click', async () => {
          await social.toggleFollow(m.id, {
            uid: m.id,
            name: m.name,
            color: m.color,
            verified: true
          });
        });
        right.appendChild(fBtn);
      }

      li.appendChild(right);
      usersListEl.appendChild(li);
    });
  }

  // Instantiate Zorii Engine
  const p2p = new window.ZoriiP2P({
    onRoomsChanged: (rooms) => {
      if (views.join.classList.contains('active')) {
        renderRoomsList(rooms, false);
      }
      renderSocialUI();
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
      if (spectatorsCountEl) {
        spectatorsCountEl.textContent = Number(room.spectatorCount) || 0;
      }
      syncRoomSpectatorUI();
      updateRoomXpUI(room.xp);
      updateClickerEventUI(room, Array.from(p2p.members.values()));

      clearInterval(hostingHeartbeatTimer);
      if (isHost) {
        social.setHostingRoom(room);
        hostingHeartbeatTimer = setInterval(() => {
          if (p2p.role === 'host' && p2p.activeRoom) {
            social.setHostingRoom(p2p.activeRoom);
          }
        }, 8000);
      } else {
        social.setHostingRoom(null);
      }

      showView('view-room');
    },
    onRoomState: ({ room, isHost, members, messages }) => {
      latestMembers = members || [];
      social.observeRoomMembers(latestMembers);

      roomTitleEl.textContent = room.name;
      roomDescEl.textContent = room.desc || '';
      roomCodeText.textContent = room.id;
      roomHostTag.textContent = isHost ? 'Hosted on your PC' : `Host: ${room.hostName}`;
      if (btnSaveRoom) {
        btnSaveRoom.classList.toggle('hidden', !isHost);
      }

      // Left vertical XP bar & Clicker Event state
      updateRoomXpUI(room.xp);
      syncRoomSpectatorUI();
      updateClickerEventUI(room, latestMembers);

      // Render connected members list + separate spectator count
      usersCountEl.textContent = `${latestMembers.length} / ${room.max}`;
      if (spectatorsCountEl) {
        spectatorsCountEl.textContent = Number(room.spectatorCount) || 0;
      }
      renderRoomMembersList(latestMembers);

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

  function scrollChatToBottom() {
    if (!chatMessagesEl) return;
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    requestAnimationFrame(() => {
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    });
  }

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

    scrollChatToBottom();
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
          return `${r.id}:${r.name}:${r.desc}:${r.hostName}:${r.count}:${r.spectatorCount || 0}:${r.max}:${r.xp || 0}:${lvl}`;
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

      const specCount = Number(r.spectatorCount) || 0;
      const specBadge = document.createElement('div');
      specBadge.className = 'room-item-spectators';
      specBadge.title = 'Spectateurs anonymes';
      specBadge.textContent = `${specCount} spec.`;

      const count = document.createElement('div');
      count.className = 'room-item-count';
      count.title = 'Membres';
      count.textContent = `${r.count} / ${r.max}`;

      const joinBtn = document.createElement('button');
      joinBtn.type = 'button';
      joinBtn.className = 'btn-room-join';
      joinBtn.setAttribute('data-room-id', r.id);
      joinBtn.textContent = 'Join';

      rightWrap.appendChild(specBadge);
      rightWrap.appendChild(count);
      rightWrap.appendChild(joinBtn);

      item.appendChild(info);
      item.appendChild(rightWrap);
      roomsListEl.appendChild(item);
    });
  }

  // 1. Firebase Account System (Pseudo + Password + Verified Email + Anonymous Spectator)
  function switchAuthTab(mode) {
    showAuthError('');
    const isLogin = mode === 'login';
    tabLogin.classList.toggle('active', isLogin);
    tabRegister.classList.toggle('active', !isLogin);
    formLogin.classList.toggle('hidden', !isLogin);
    formRegister.classList.toggle('hidden', isLogin);
    setTimeout(() => {
      if (isLogin) loginEmailInput.focus();
      else regUsernameInput.focus();
    }, 40);
  }

  tabLogin.addEventListener('click', () => switchAuthTab('login'));
  tabRegister.addEventListener('click', () => switchAuthTab('register'));

  if (followSearchInput) {
    followSearchInput.addEventListener('input', () => {
      renderSocialUI();
    });
  }

  if (btnToggleFollowSidebar && followSidebar) {
    btnToggleFollowSidebar.addEventListener('click', () => {
      followSidebar.classList.toggle('mobile-open');
    });
  }

  if (loginNoEmailToggle) {
    loginNoEmailToggle.addEventListener('change', () => {
      showAuthError('');
      const noEmail = loginNoEmailToggle.checked;
      loginEmailInput.type = noEmail ? 'text' : 'email';
      loginEmailInput.placeholder = noEmail ? 'Pseudo' : 'Adresse e-mail';
      loginEmailInput.value = '';
      if (btnForgotPassword) {
        btnForgotPassword.classList.toggle('hidden', noEmail);
      }
      loginEmailInput.focus();
    });
  }

  if (regNoEmailToggle) {
    regNoEmailToggle.addEventListener('change', () => {
      showAuthError('');
      const noEmail = regNoEmailToggle.checked;
      regEmailInput.classList.toggle('hidden', noEmail);
      regEmailInput.required = !noEmail;
      if (noEmail) regEmailInput.value = '';
    });
  }

  function applyAuthenticatedUser(user) {
    currentFirebaseUser = user;
    if (!user) {
      isAuthenticatedSession = false;
      clearInterval(hostingHeartbeatTimer);
      social.setHostingRoom(null);
      social.setUser({ uid: null, isVerified: false, canFollow: false });
      if (p2p.activeRoom) p2p.leaveRoom();
      showAuthError('');
      authFormsWrap.classList.remove('hidden');
      authVerifyPanel.classList.add('hidden');
      showView('view-auth');
      renderSocialUI();
      return;
    }

    if (user.isAnonymous) {
      isAuthenticatedSession = true;
      clearInterval(hostingHeartbeatTimer);
      social.setHostingRoom(null);
      social.setUser({ uid: user.uid, isVerified: false, canFollow: false });
      p2p.setProfile('Anonyme', cfg.USER_COLORS[0], true, user.uid, false);
      currentUsernameEl.textContent = 'Anonyme (Spectateur)';
      currentUsernameEl.style.color = 'var(--text-dim)';
      currentUserDot.style.backgroundColor = 'var(--text-dim)';
      currentUserDot.style.boxShadow = 'none';
      btnGoHost.classList.add('btn-menu-locked');
      showView(p2p.activeRoom ? 'view-room' : 'view-menu');
      renderSocialUI();
      return;
    }

    const noEmailAccount = isNoEmailUser(user);

    if (!noEmailAccount && !user.emailVerified) {
      isAuthenticatedSession = false;
      clearInterval(hostingHeartbeatTimer);
      social.setHostingRoom(null);
      social.setUser({ uid: user.uid, isVerified: false, canFollow: false });
      if (p2p.activeRoom) p2p.leaveRoom();
      verifyEmailLabel.textContent = user.email || '';
      authFormsWrap.classList.add('hidden');
      authVerifyPanel.classList.remove('hidden');
      showAuthError('');
      showView('view-auth');
      renderSocialUI();
      return;
    }

    // Authenticated Firebase user (either Email Verified OR No-Email limited account)
    isAuthenticatedSession = true;
    const isVerifiedAccount = !noEmailAccount && Boolean(user.emailVerified);
    const savedUserColor =
      localStorage.getItem(`${cfg.STORAGE_COLOR_KEY}_${user.uid}`) ||
      localStorage.getItem(cfg.STORAGE_COLOR_KEY) ||
      selectedColor;
    selectedColor = savedUserColor;

    const pseudo =
      (user.displayName && user.displayName.trim()) ||
      pendingRegisterPseudo ||
      (user.email && !noEmailAccount ? user.email.split('@')[0] : 'User');
    pendingRegisterPseudo = '';

    p2p.setProfile(pseudo, savedUserColor, false, user.uid, isVerifiedAccount);
    social.setUser({
      uid: user.uid,
      name: pseudo,
      color: savedUserColor,
      isVerified: isVerifiedAccount,
      canFollow: true
    });
    localStorage.setItem(cfg.STORAGE_USER_KEY, pseudo);
    localStorage.setItem(`${cfg.STORAGE_COLOR_KEY}_${user.uid}`, savedUserColor);
    localStorage.setItem(cfg.STORAGE_COLOR_KEY, savedUserColor);

    currentUsernameEl.textContent = pseudo;
    currentUsernameEl.style.color = savedUserColor;
    currentUserDot.style.backgroundColor = savedUserColor;
    currentUserDot.style.boxShadow = `0 0 8px ${savedUserColor}`;
    btnGoHost.classList.toggle('btn-menu-locked', !isVerifiedAccount);

    showView(p2p.activeRoom ? 'view-room' : 'view-menu');
    renderSocialUI();
  }

  if (firebaseAuth) {
    firebaseAuth.onAuthStateChanged((user) => {
      applyAuthenticatedUser(user);
    });
  } else {
    showAuthError('SDK Firebase indisponible.');
  }

  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!firebaseAuth) return;
    const rawIdentifier = loginEmailInput.value.trim();
    const password = loginPasswordInput.value;
    if (!rawIdentifier || !password) return;

    const noEmailMode = loginNoEmailToggle && loginNoEmailToggle.checked;
    const email = noEmailMode ? pseudoToNoEmailAddress(rawIdentifier) : rawIdentifier;

    showAuthError('');
    btnLoginSubmit.disabled = true;
    try {
      const cred = await firebaseAuth.signInWithEmailAndPassword(email, password);
      if (cred.user && !isNoEmailUser(cred.user) && !cred.user.emailVerified) {
        await cred.user.reload();
      }
      applyAuthenticatedUser(firebaseAuth.currentUser);
    } catch (err) {
      if (noEmailMode && err && (err.code === 'auth/invalid-credential' || err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password')) {
        showAuthError('Pseudo ou mot de passe incorrect.');
      } else {
        showAuthError(formatFirebaseError(err));
      }
    } finally {
      btnLoginSubmit.disabled = false;
    }
  });

  formRegister.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!firebaseAuth) return;
    const pseudo = regUsernameInput.value.trim();
    const noEmailMode = regNoEmailToggle && regNoEmailToggle.checked;
    const email = noEmailMode ? pseudoToNoEmailAddress(pseudo) : regEmailInput.value.trim();
    const password = regPasswordInput.value;
    if (pseudo.length < 2) {
      showAuthError('Le pseudo doit contenir au moins 2 caractères.');
      return;
    }
    if ((!noEmailMode && !email) || password.length < 6) {
      showAuthError('E-mail invalide ou mot de passe trop court (6 min).');
      return;
    }

    showAuthError('');
    btnRegisterSubmit.disabled = true;
    pendingRegisterPseudo = pseudo;
    try {
      const cred = await firebaseAuth.createUserWithEmailAndPassword(email, password);
      await cred.user.updateProfile({ displayName: pseudo });
      localStorage.setItem(`${cfg.STORAGE_COLOR_KEY}_${cred.user.uid}`, selectedColor);
      localStorage.setItem(cfg.STORAGE_COLOR_KEY, selectedColor);

      if (noEmailMode) {
        showToast(`Compte sans e-mail créé pour ${pseudo} (Join, Chat, Follow)`);
        applyAuthenticatedUser(cred.user);
      } else {
        await cred.user.sendEmailVerification();
        showToast(`E-mail de vérification envoyé à ${email}`);
        applyAuthenticatedUser(cred.user);
      }
    } catch (err) {
      pendingRegisterPseudo = '';
      if (noEmailMode && err && err.code === 'auth/email-already-in-use') {
        showAuthError('Ce pseudo sans e-mail est déjà utilisé.');
      } else {
        showAuthError(formatFirebaseError(err));
      }
    } finally {
      btnRegisterSubmit.disabled = false;
    }
  });

  btnForgotPassword.addEventListener('click', async () => {
    if (!firebaseAuth) return;
    const email = loginEmailInput.value.trim();
    if (!email) {
      showAuthError('Entrez votre e-mail pour réinitialiser le mot de passe.');
      loginEmailInput.focus();
      return;
    }
    showAuthError('');
    try {
      await firebaseAuth.sendPasswordResetEmail(email);
      showToast(`Lien de réinitialisation envoyé à ${email}`);
    } catch (err) {
      showAuthError(formatFirebaseError(err));
    }
  });

  btnAnonLogin.addEventListener('click', async () => {
    if (!firebaseAuth) return;
    showAuthError('');
    btnAnonLogin.disabled = true;
    try {
      await firebaseAuth.signInAnonymously();
    } catch (err) {
      showAuthError(formatFirebaseError(err));
    } finally {
      btnAnonLogin.disabled = false;
    }
  });

  btnCheckVerified.addEventListener('click', async () => {
    if (!firebaseAuth || !firebaseAuth.currentUser) return;
    showAuthError('');
    btnCheckVerified.disabled = true;
    try {
      await firebaseAuth.currentUser.reload();
      const user = firebaseAuth.currentUser;
      if (user && user.emailVerified) {
        showToast('Compte vérifié ! Bienvenue sur Zorii.');
        applyAuthenticatedUser(user);
      } else {
        showAuthError("E-mail pas encore vérifié. Cliquez sur le lien reçu par e-mail (vérifiez vos spams).");
      }
    } catch (err) {
      showAuthError(formatFirebaseError(err));
    } finally {
      btnCheckVerified.disabled = false;
    }
  });

  btnResendVerify.addEventListener('click', async () => {
    if (!firebaseAuth || !firebaseAuth.currentUser) return;
    showAuthError('');
    btnResendVerify.disabled = true;
    try {
      await firebaseAuth.currentUser.sendEmailVerification();
      showToast('Nouvel e-mail de vérification envoyé !');
    } catch (err) {
      showAuthError(formatFirebaseError(err));
    } finally {
      btnResendVerify.disabled = false;
    }
  });

  btnVerifyLogout.addEventListener('click', async () => {
    if (!firebaseAuth) return;
    await firebaseAuth.signOut();
  });

  function showPasswordFeedback(msg, type) {
    if (!passwordFeedbackEl) return;
    if (!msg) {
      passwordFeedbackEl.textContent = '';
      passwordFeedbackEl.className = 'password-feedback hidden';
    } else {
      passwordFeedbackEl.textContent = msg;
      passwordFeedbackEl.className = `password-feedback ${type === 'success' ? 'success' : 'error'}`;
    }
  }

  // Profile View
  userBadge.addEventListener('click', () => {
    if (!currentFirebaseUser) return;
    showPasswordFeedback('');
    if (formChangePassword) formChangePassword.reset();
    if (p2p.isAnonymous) {
      profileVerifiedBox.classList.add('hidden');
      profileAnonBox.classList.remove('hidden');
    } else {
      const noEmail = isNoEmailUser(currentFirebaseUser);
      profileVerifiedBox.classList.remove('hidden');
      profileAnonBox.classList.add('hidden');
      profileEmailText.textContent = noEmail ? 'Compte sans e-mail (Pas de Host)' : (currentFirebaseUser.email || '');
      profileUsernameInput.value = p2p.username;
      if (profileFollowersCount) {
        profileFollowersCount.classList.toggle('hidden', noEmail);
      }
      if (profileVerifiedBadge) {
        profileVerifiedBadge.textContent = noEmail ? 'Sans e-mail' : 'Vérifié';
        profileVerifiedBadge.classList.toggle('unverified-badge', noEmail);
      }
      if (btnPasswordEmailPerm) {
        btnPasswordEmailPerm.classList.toggle('hidden', noEmail);
      }
    }
    showView('view-profile');
  });

  btnProfileBack.addEventListener('click', () => {
    showView(p2p.activeRoom ? 'view-room' : 'view-menu');
  });

  formProfile.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentFirebaseUser || p2p.isAnonymous) return;
    const newPseudo = profileUsernameInput.value.trim();
    if (newPseudo.length < 2) {
      showToast('Le pseudo doit contenir au moins 2 caractères.');
      return;
    }
    try {
      await currentFirebaseUser.updateProfile({ displayName: newPseudo });
      localStorage.setItem(`${cfg.STORAGE_COLOR_KEY}_${currentFirebaseUser.uid}`, selectedColor);
      localStorage.setItem(cfg.STORAGE_COLOR_KEY, selectedColor);
      localStorage.setItem(cfg.STORAGE_USER_KEY, newPseudo);

      p2p.setProfile(newPseudo, selectedColor, false, currentFirebaseUser.uid, p2p.isEmailVerified);
      if (p2p.isEmailVerified) {
        social.syncProfile({ name: newPseudo, color: selectedColor });
      }
      currentUsernameEl.textContent = newPseudo;
      currentUsernameEl.style.color = selectedColor;
      currentUserDot.style.backgroundColor = selectedColor;
      currentUserDot.style.boxShadow = `0 0 8px ${selectedColor}`;

      showToast('Profil mis à jour');
      showView(p2p.activeRoom ? 'view-room' : 'view-menu');
    } catch (err) {
      showToast(formatFirebaseError(err));
    }
  });

  formChangePassword.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!firebaseAuth || !firebaseAuth.currentUser || p2p.isAnonymous) return;
    const user = firebaseAuth.currentUser;
    const oldPassword = currentPasswordInput.value;
    const newPassword = newPasswordInput.value;
    const confirmPassword = confirmNewPasswordInput.value;

    if (!oldPassword) {
      showPasswordFeedback('Entrez votre ancien mot de passe.', 'error');
      return;
    }
    if (newPassword.length < 6) {
      showPasswordFeedback('Le nouveau mot de passe doit contenir au moins 6 caractères.', 'error');
      return;
    }
    if (newPassword !== confirmPassword) {
      showPasswordFeedback('Les nouveaux mots de passe ne correspondent pas.', 'error');
      return;
    }
    if (oldPassword === newPassword) {
      showPasswordFeedback("Le nouveau mot de passe doit être différent de l'ancien.", 'error');
      return;
    }

    showPasswordFeedback('');
    btnChangePassword.disabled = true;
    try {
      const credential = firebase.auth.EmailAuthProvider.credential(user.email, oldPassword);
      await user.reauthenticateWithCredential(credential);
      await user.updatePassword(newPassword);
      formChangePassword.reset();
      showPasswordFeedback('Mot de passe modifié avec succès.', 'success');
      showToast('Mot de passe mis à jour !');
    } catch (err) {
      const code = (err && err.code) || '';
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        showPasswordFeedback('Ancien mot de passe incorrect.', 'error');
      } else {
        showPasswordFeedback(formatFirebaseError(err), 'error');
      }
    } finally {
      btnChangePassword.disabled = false;
    }
  });

  btnPasswordEmailPerm.addEventListener('click', async () => {
    if (!firebaseAuth || !firebaseAuth.currentUser || p2p.isAnonymous) return;
    const email = firebaseAuth.currentUser.email;
    if (!email) return;

    showPasswordFeedback('');
    btnPasswordEmailPerm.disabled = true;
    try {
      await firebaseAuth.sendPasswordResetEmail(email);
      showPasswordFeedback(
        `Autorisation envoyée : un lien pour modifier votre mot de passe a été envoyé à ${email} (vérifiez Gmail / spams).`,
        'success'
      );
      showToast(`Lien envoyé à ${email}`);
    } catch (err) {
      showPasswordFeedback(formatFirebaseError(err), 'error');
    } finally {
      btnPasswordEmailPerm.disabled = false;
    }
  });

  btnLogout.addEventListener('click', async () => {
    clearInterval(hostingHeartbeatTimer);
    social.setHostingRoom(null);
    p2p.leaveRoom();
    if (firebaseAuth) {
      await firebaseAuth.signOut();
    }
  });

  navHome.addEventListener('click', () => {
    if (!isAuthenticatedSession) return;
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
  btnGoHost.addEventListener('click', () => {
    if (p2p.isAnonymous || !p2p.isEmailVerified) {
      showToast('Compte avec e-mail vérifié requis pour héberger une room.');
      return;
    }
    showView('view-host');
  });

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

      const clicksBadge = document.createElement('span');
      clicksBadge.className = 'room-item-host';
      const savedClicks = Math.max(0, Math.floor(Number(sr.clicks) || 0));
      clicksBadge.textContent = `⚡ ${savedClicks.toLocaleString()} clicks`;

      const meta = document.createElement('span');
      meta.className = 'room-item-host';
      meta.textContent = `Max ${sr.max}`;

      top.appendChild(lvl);
      top.appendChild(title);
      top.appendChild(clicksBadge);
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
          xp: sr.xp,
          clicks: sr.clicks
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

  // 5. Room Chat, Events Bar, Resizable Event Tab & Save Room Stats
  if (btnOpenClickerEvent) {
    btnOpenClickerEvent.addEventListener('click', () => {
      if (activeEventId === 'clicker') {
        closeEventTab();
      } else {
        openEventTab('clicker');
      }
    });
  }

  if (btnCloseEventTab) {
    btnCloseEventTab.addEventListener('click', () => {
      closeEventTab();
    });
  }

  eventScaleBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const ratio = Number(btn.getAttribute('data-scale')) || 0.33;
      applyEventTabWidthByRatio(ratio);
    });
  });

  if (eventResizeHandle && eventTabPanel && roomLayoutEl) {
    let isDraggingResize = false;

    eventResizeHandle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      isDraggingResize = true;
      eventResizeHandle.classList.add('dragging');
      try {
        eventResizeHandle.setPointerCapture(e.pointerId);
      } catch (_) {}
    });

    eventResizeHandle.addEventListener('pointermove', (e) => {
      if (!isDraggingResize) return;
      const roomRect = roomLayoutEl.getBoundingClientRect();
      if (!roomRect.width) return;
      const rawWidth = roomRect.right - e.clientX;
      const maxPx = Math.floor(roomRect.width * (2 / 3));
      const minPx = 260;
      const clampedPx = Math.min(maxPx, Math.max(minPx, Math.round(rawWidth)));
      currentEventScaleRatio = clampedPx / roomRect.width;
      eventTabPanel.style.setProperty('--event-tab-width', `${clampedPx}px`);
      roomLayoutEl.classList.toggle('event-wide', currentEventScaleRatio >= 0.48);

      eventScaleBtns.forEach((btn) => {
        const btnScale = Number(btn.getAttribute('data-scale')) || 0;
        btn.classList.toggle('active', Math.abs(btnScale - currentEventScaleRatio) < 0.045);
      });
    });

    const stopResizeDrag = (e) => {
      if (!isDraggingResize) return;
      isDraggingResize = false;
      eventResizeHandle.classList.remove('dragging');
      try {
        if (e && e.pointerId !== undefined) {
          eventResizeHandle.releasePointerCapture(e.pointerId);
        }
      } catch (_) {}
    };

    eventResizeHandle.addEventListener('pointerup', stopResizeDrag);
    eventResizeHandle.addEventListener('pointercancel', stopResizeDrag);
  }

  window.addEventListener('resize', () => {
    if (activeEventId) {
      applyEventTabWidthByRatio(currentEventScaleRatio);
    }
  });

  if (btnRoomClicker) {
    btnRoomClicker.addEventListener('click', () => {
      if (p2p.isAnonymous) {
        showToast('Spectateur anonyme : impossible de cliquer');
        return;
      }
      p2p.sendClick();
      btnRoomClicker.classList.add('pulse');
      setTimeout(() => btnRoomClicker.classList.remove('pulse'), 90);
    });
  }

  if (btnSaveRoom) {
    btnSaveRoom.addEventListener('click', () => {
      const saved = p2p.saveCurrentRoomStats();
      if (saved) {
        showToast(
          `Saved room "${saved.name}" (Lvl ${saved.level}, ${saved.clicks.toLocaleString()} clicks, Max ${saved.max})`
        );
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
    clearInterval(hostingHeartbeatTimer);
    social.setHostingRoom(null);
    p2p.leaveRoom();
    showView('view-menu');
  });

  window.addEventListener('beforeunload', () => {
    clearInterval(hostingHeartbeatTimer);
    social.setHostingRoom(null);
  });
});
