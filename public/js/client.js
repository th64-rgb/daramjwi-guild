let socket = null;
let serverAvailable = false;

function initSocket() {
  if (typeof io === 'undefined') return false;
  try {
    socket = io({ reconnection: true, reconnectionAttempts: 20 });
    return true;
  } catch (_) {
    return false;
  }
}

function emitAsync(event, data) {
  return new Promise((resolve) => {
    if (!socket) {
      resolve({ success: false, error: '서버에 연결되지 않았습니다.' });
      return;
    }
    socket.emit(event, data, resolve);
  });
}

function checkServerConnection() {
  const hasSocketLib = typeof io !== 'undefined';
  const isFileProtocol = location.protocol === 'file:';

  if (!hasSocketLib || isFileProtocol) {
    $('#server-warning')?.classList.remove('hidden');
    return false;
  }

  if (!socket) initSocket();
  bindSocketEvents();

  let checked = false;
  const timeout = setTimeout(() => {
    if (!checked && !serverAvailable) {
      $('#server-warning')?.classList.remove('hidden');
    }
  }, 3000);

  socket.on('connect', () => {
    checked = true;
    serverAvailable = true;
    clearTimeout(timeout);
    $('#server-warning')?.classList.add('hidden');
    updateConnStatus(true);
    if (nickname) emitAsync('setNickname', nickname);
  });

  socket.on('disconnect', () => {
    serverAvailable = false;
    updateConnStatus(false);
  });

  if (socket.connected) {
    checked = true;
    serverAvailable = true;
    clearTimeout(timeout);
    updateConnStatus(true);
  }

  return true;
}

const BOARD_SIZE = 15;
const COL_LABELS = 'ABCDEFGHJKLMNO'.split('');

let nickname = localStorage.getItem('omok_nickname') || '';
let currentRoom = null;
let boardEl = null;
let lastMoveCount = 0;
let lastStatus = null;
let timerInterval = null;
let localTurnRemaining = null;

// AI 연습
let practiceBoard = null;
let practiceBoardEl = null;
let practiceCurrent = 'black';
let practiceOver = false;
/** 플레이어가 선택한 돌 색 ('black' | 'white') */
let practicePlayerColor = localStorage.getItem('omok_practice_color') || 'black';
/** 이번 판 보상 지급 여부 (중복 방지) */
let practiceRewardGiven = false;

const SHEET_STORAGE_KEY = 'omok_sheet_music_total';
const DIFF_LABEL = { easy: '쉬움', normal: '보통', hard: '어려움' };
/** 난이도별 승리 악보 보상 (쉬움=연습용 0) */
const SHEET_REWARD = { easy: 0, normal: 1, hard: 2 };

const $ = (sel) => document.querySelector(sel);

const screens = {
  nickname: $('#screen-nickname'),
  lobby: $('#screen-lobby'),
  game: $('#screen-game'),
  practice: $('#screen-practice'),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
  if (name !== 'game') stopLocalTimer();

  // 연습 화면 전용 body 클래스 → 모바일에서 길드 네비/여백 축소, 보드 크기 계산
  document.body.classList.toggle('practice-active', name === 'practice');
  if (name !== 'practice') {
    setPracticeExpanded(false);
  } else {
    // 레이아웃 적용 후 보드 크기 재계산
    requestAnimationFrame(() => updatePracticeBoardSize());
  }
}

/** 연습 보드: board-area 의 실제 가용 영역에서 가능한 최대 정사각형 */
function updatePracticeBoardSize() {
  const area = document.querySelector('#screen-practice .practice-board-area');
  if (!area || !document.body.classList.contains('practice-active')) return;

  const w = area.clientWidth;
  const h = area.clientHeight;
  if (w < 40 || h < 40) return;

  // 15칸 정렬을 위해 15의 배수로 스냅 (서브픽셀 선 어긋남 완화)
  let side = Math.floor(Math.min(w, h));
  side = Math.max(180, Math.floor(side / 15) * 15);
  area.style.setProperty('--board-size', `${side}px`);
}

let practiceResizeObserver = null;
function ensurePracticeResizeObserver() {
  if (practiceResizeObserver || typeof ResizeObserver === 'undefined') return;
  const area = document.querySelector('#screen-practice .practice-board-area');
  if (!area) return;
  practiceResizeObserver = new ResizeObserver(() => updatePracticeBoardSize());
  practiceResizeObserver.observe(area);
  window.addEventListener('resize', updatePracticeBoardSize);
  window.addEventListener('orientationchange', () => {
    setTimeout(updatePracticeBoardSize, 150);
  });
}

function setPracticeExpanded(on) {
  document.body.classList.toggle('practice-expanded', !!on);
  const btn = document.getElementById('btn-expand-board');
  if (btn) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.textContent = on ? '⛶ 축소' : '⛶ 크게';
    btn.title = on ? '보드 축소' : '보드 크게 보기';
  }
  requestAnimationFrame(() => updatePracticeBoardSize());
}

function showToast(message, duration = 3000) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 300);
  }, duration);
}

function updateConnStatus(connected) {
  ['conn-status', 'conn-status-game'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.toggle('connected', connected);
      el.classList.toggle('disconnected', !connected);
      el.title = connected ? '연결됨' : '연결 끊김';
    }
  });
}

function buildBoardLabels() {
  const top = $('#board-labels-top');
  const left = $('#board-labels-left');
  if (!top || top.children.length) return;
  top.innerHTML = '<span></span>' + COL_LABELS.map((l) => `<span>${l}</span>`).join('');
  left.innerHTML = Array.from({ length: BOARD_SIZE }, (_, i) => `<span>${i + 1}</span>`).join('');
}

function launchConfetti() {
  const canvas = $('#confetti-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const pieces = Array.from({ length: 120 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * 100,
    r: 4 + Math.random() * 6,
    d: 2 + Math.random() * 4,
    color: ['#e8a838', '#5cb85c', '#f0ebe3', '#e74c3c'][Math.floor(Math.random() * 4)],
    tilt: Math.random() * 10,
    tiltAngle: 0,
  }));

  let frame = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach((p) => {
      p.tiltAngle += 0.1;
      p.y += p.d;
      p.x += Math.sin(p.tiltAngle) * 2;
      ctx.beginPath();
      ctx.fillStyle = p.color;
      ctx.ellipse(p.x, p.y, p.r, p.r * 0.6, p.tilt, 0, Math.PI * 2);
      ctx.fill();
    });
    frame++;
    if (frame < 180) requestAnimationFrame(draw);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  draw();
}

// ── 닉네임 ──
const nicknameForm = $('#nickname-form');
const nicknameInput = $('#nickname-input');
if (nickname) nicknameInput.value = nickname;

nicknameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!serverAvailable) {
    $('#server-warning')?.classList.remove('hidden');
    SoundManager.error();
    return;
  }
  const result = await emitAsync('setNickname', nicknameInput.value.trim());
  if (!result.success) {
    $('#nickname-error').textContent = result.error;
    $('#nickname-error').classList.remove('hidden');
    SoundManager.error();
    return;
  }
  nickname = result.nickname;
  localStorage.setItem('omok_nickname', nickname);
  $('#nickname-error').classList.add('hidden');
  $('#lobby-nickname').textContent = nickname;
  showScreen('lobby');
  checkUrlRoom();
});

$('#btn-practice-from-home')?.addEventListener('click', () => {
  nickname = nicknameInput.value.trim() || nickname || '플레이어';
  localStorage.setItem('omok_nickname', nickname);
  openPracticeScreen();
});

$('#btn-dismiss-warning')?.addEventListener('click', () => {
  $('#server-warning')?.classList.add('hidden');
  nickname = nicknameInput.value.trim() || nickname || '플레이어';
  openPracticeScreen();
});

$('#btn-logout').addEventListener('click', () => {
  nickname = '';
  localStorage.removeItem('omok_nickname');
  showScreen('nickname');
});

// ── 로비 ──
$('#btn-create-room').addEventListener('click', async () => {
  const isPrivate = $('#private-room-check').checked;
  const result = await emitAsync('createRoom', { isPrivate });
  if (!result.success) { showToast(result.error); return; }
  enterGame(result.room);
});

$('#btn-join-room').addEventListener('click', () => joinByCode(false));
$('#btn-spectate-room').addEventListener('click', () => joinByCode(true));
$('#join-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinByCode(false); });

async function joinByCode(asSpectator) {
  const code = $('#join-code-input').value.trim().toUpperCase();
  if (!code) { showToast('방 코드를 입력해주세요.'); return; }
  const result = await emitAsync('joinRoom', { code, asSpectator });
  if (!result.success) { showToast(result.error); SoundManager.error(); return; }
  if (result.reconnected) showToast('재접속했습니다!');
  enterGame(result.room);
}

function checkUrlRoom() {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) {
    $('#join-code-input').value = room.toUpperCase();
    history.replaceState({}, '', location.pathname);
  }
}

function renderRoomList(rooms) {
  const list = $('#room-list');
  $('#room-count').textContent = rooms.length;
  if (!rooms.length) {
    list.innerHTML = '<p class="empty-state">열린 방이 없습니다. 새 방을 만들어보세요!</p>';
    return;
  }
  const labels = { waiting: '대기', ready: '준비', playing: '진행', finished: '종료' };
  list.innerHTML = rooms.map((room) => {
    const canJoin = room.playerCount < 2 && room.status !== 'finished';
    return `
      <div class="room-item">
        <div class="room-item-info">
          <span class="room-item-code">${room.code}</span>
          <span class="room-item-meta">
            ${room.host} · ${room.playerCount}/2 · 관전 ${room.spectatorCount}
            · ${room.moveCount}수
            <span class="status-tag ${room.status}">${labels[room.status] || room.status}</span>
          </span>
        </div>
        <div class="room-item-actions">
          ${canJoin ? `<button class="btn btn-secondary btn-sm btn-join" data-code="${room.code}">참가</button>` : ''}
          <button class="btn btn-ghost btn-sm btn-spectate" data-code="${room.code}">관전</button>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.btn-join').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const r = await emitAsync('joinRoom', { code: btn.dataset.code, asSpectator: false });
      if (!r.success) { showToast(r.error); return; }
      enterGame(r.room);
    });
  });
  list.querySelectorAll('.btn-spectate').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const r = await emitAsync('joinRoom', { code: btn.dataset.code, asSpectator: true });
      if (!r.success) { showToast(r.error); return; }
      enterGame(r.room);
    });
  });
}

let socketEventsBound = false;

function bindSocketEvents() {
  if (!socket || socketEventsBound) return;
  socketEventsBound = true;
  socket.on('roomList', renderRoomList);
  socket.on('onlineCount', (n) => { $('#online-count').textContent = `접속 ${n}명`; });
  socket.on('roomUpdate', (room) => {
    if (currentRoom && room.code === currentRoom.code) renderGame(room);
  });
  socket.on('kicked', ({ reason }) => {
    showToast(reason);
    currentRoom = null;
    boardEl = null;
    showScreen('lobby');
  });
}

// ── 연결 ──
bindSocketEvents();
checkServerConnection();
updateConnStatus(false);

$('#btn-sound-toggle').addEventListener('click', () => {
  const on = SoundManager.toggle();
  $('#btn-sound-toggle').textContent = on ? '🔊' : '🔇';
});
$('#btn-sound-toggle').textContent = SoundManager.isEnabled() ? '🔊' : '🔇';

// ── 게임 입장 ──
function enterGame(room) {
  currentRoom = room;
  lastMoveCount = 0;
  lastStatus = null;
  if (boardEl) boardEl.innerHTML = '';
  boardEl = null;
  $('#game-nickname').textContent = nickname;
  $('#game-room-code').textContent = room.code;
  buildBoardLabels();
  showScreen('game');
  renderGame(room);
}

function buildBoard() {
  boardEl = $('#board');
  boardEl.innerHTML = '';
  const stars = [[3,3],[3,11],[7,7],[11,3],[11,11]];
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.row = row;
      cell.dataset.col = col;
      if (stars.some(([r,c]) => r === row && c === col)) cell.classList.add('star-point');
      cell.addEventListener('click', onCellClick);
      cell.addEventListener('mouseenter', onCellHover);
      cell.addEventListener('mouseleave', onCellLeave);
      boardEl.appendChild(cell);
    }
  }
}

function onCellHover(e) {
  const cell = e.currentTarget;
  if (!currentRoom || cell.classList.contains('occupied') || cell.classList.contains('disabled')) return;
  if (currentRoom.role !== currentRoom.currentPlayer) return;
  const preview = document.createElement('div');
  preview.className = `stone preview ${currentRoom.role}`;
  cell.appendChild(preview);
}

function onCellLeave(e) {
  const prev = e.currentTarget.querySelector('.preview');
  if (prev) prev.remove();
}

function onCellClick(e) {
  const cell = e.currentTarget;
  if (cell.classList.contains('occupied') || cell.classList.contains('disabled')) return;
  if (!currentRoom || (currentRoom.role !== 'black' && currentRoom.role !== 'white')) return;
  if (currentRoom.status !== 'playing' || currentRoom.currentPlayer !== currentRoom.role) return;
  emitAsync('placeStone', {
    row: parseInt(cell.dataset.row, 10),
    col: parseInt(cell.dataset.col, 10),
  }).then((r) => { if (!r.success) { showToast(r.error); SoundManager.error(); } });
}

function stopLocalTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function startLocalTimer(room) {
  stopLocalTimer();
  localTurnRemaining = room.turnRemaining;
  if (room.status !== 'playing' || localTurnRemaining == null) return;
  timerInterval = setInterval(() => {
    if (localTurnRemaining > 0) {
      localTurnRemaining--;
      updateTimerDisplay(room.currentPlayer, localTurnRemaining);
      if (localTurnRemaining <= 5 && localTurnRemaining > 0) SoundManager.tick();
    }
  }, 1000);
}

function updateTimerDisplay(player, sec) {
  ['black', 'white'].forEach((c) => {
    const el = $(`#timer-${c}`);
    if (!el) return;
    if (player === c && sec != null && currentRoom?.status === 'playing') {
      el.textContent = `${sec}초`;
      el.classList.remove('hidden');
      el.classList.toggle('urgent', sec <= 10);
    } else {
      el.classList.add('hidden');
    }
  });
}

function renderGame(room) {
  const prevMoves = lastMoveCount;
  const prevStatus = lastStatus;
  currentRoom = room;
  lastMoveCount = room.moves.length;
  lastStatus = room.status;

  if (room.moves.length > prevMoves) SoundManager.place();
  if (room.status === 'finished' && prevStatus === 'playing') {
    SoundManager.win();
    if (room.winner !== 'draw' && (room.role === room.winner || room.role === 'spectator')) {
      launchConfetti();
    }
  }

  // 플레이어 정보
  $('#name-black').textContent = room.players.black?.nickname || '대기 중...';
  $('#name-white').textContent = room.players.white?.nickname || '대기 중...';

  ['black', 'white'].forEach((c) => {
    const p = room.players[c];
    $(`#offline-${c}`).classList.toggle('hidden', !p || p.connected !== false);
    $(`#ready-${c}`).classList.toggle('hidden', !room.ready[c] || room.status === 'playing');
    const card = $(`#player-${c}`);
    card.classList.toggle('active', room.status === 'playing' && room.currentPlayer === c);
    $(`#turn-${c}`).classList.toggle('hidden', !(room.status === 'playing' && room.currentPlayer === c));
  });

  updateTimerDisplay(room.currentPlayer, room.turnRemaining);
  startLocalTimer(room);

  // 상태
  const statusEl = $('#game-status');
  statusEl.classList.remove('win', 'ready-state');
  if (room.status === 'waiting') {
    statusEl.textContent = '상대 플레이어를 기다리는 중...';
  } else if (room.status === 'ready') {
    statusEl.classList.add('ready-state');
    const b = room.ready.black, w = room.ready.white;
    statusEl.textContent = b && w ? '곧 시작합니다...' : `준비 중... (흑 ${b?'✓':'○'} / 백 ${w?'✓':'○'})`;
  } else if (room.status === 'playing') {
    const name = room.currentPlayer === 'black' ? room.players.black?.nickname : room.players.white?.nickname;
    statusEl.textContent = `${name || (room.currentPlayer === 'black' ? '흑' : '백')}의 차례`;
  } else if (room.status === 'finished') {
    statusEl.classList.add('win');
    if (room.winner === 'draw') statusEl.textContent = '무승부!';
    else {
      const name = room.winner === 'black' ? room.players.black?.nickname : room.players.white?.nickname;
      statusEl.textContent = `${name || (room.winner === 'black' ? '흑' : '백')} 승리! 🎉`;
    }
  }

  // 보드
  if (!boardEl || !boardEl.children.length) buildBoard();
  const canPlay = (room.role === 'black' || room.role === 'white') &&
    room.status === 'playing' && room.currentPlayer === room.role;
  const winSet = new Set((room.winLine || []).map(([r,c]) => `${r},${c}`));

  boardEl.querySelectorAll('.cell').forEach((cell) => {
    const row = +cell.dataset.row, col = +cell.dataset.col;
    const stone = room.board[row][col];
    const preview = cell.querySelector('.preview');
    cell.innerHTML = '';
    if (preview && !stone && canPlay) cell.appendChild(preview);
    cell.classList.toggle('occupied', !!stone);
    cell.classList.toggle('disabled', !canPlay || !!stone || room.status !== 'playing');
    if (stone) {
      const el = document.createElement('div');
      el.className = `stone ${stone}`;
      if (room.lastMove?.row === row && room.lastMove?.col === col) el.classList.add('last-move');
      if (winSet.has(`${row},${col}`)) el.classList.add('win-stone');
      cell.appendChild(el);
    }
  });

  // 기보
  $('#move-count').textContent = room.moves.length;
  const hist = $('#move-history');
  if (!room.moves.length) {
    hist.innerHTML = '<li class="empty">아직 수가 없습니다</li>';
  } else {
    hist.innerHTML = room.moves.map((m, i) => {
      const label = COL_LABELS[m.col] + (m.row + 1);
      return `<li><span class="move-num">${i+1}.</span> <span class="move-color ${m.color}">${m.color==='black'?'흑':'백'}</span> ${label}</li>`;
    }).join('');
    hist.scrollTop = hist.scrollHeight;
  }

  // 관전자
  $('#spectator-count').textContent = room.spectators.length;
  const specList = $('#spectator-list');
  if (!room.spectators.length) {
    specList.innerHTML = '<li class="empty">관전자 없음</li>';
  } else {
    specList.innerHTML = room.spectators.map((name) => {
      const kick = room.isHost ? `<button class="kick-btn" data-name="${name}">✕</button>` : '';
      return `<li>${name} ${kick}</li>`;
    }).join('');
    specList.querySelectorAll('.kick-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await emitAsync('kickSpectator', btn.dataset.name);
        if (!r.success) showToast(r.error);
      });
    });
  }

  // 역할
  const roleBadge = $('#role-badge');
  if (room.role === 'black') { roleBadge.textContent = '흑돌 플레이 중'; roleBadge.className = 'role-badge player'; }
  else if (room.role === 'white') { roleBadge.textContent = '백돌 플레이 중'; roleBadge.className = 'role-badge player'; }
  else { roleBadge.textContent = '관전 중'; roleBadge.className = 'role-badge'; }

  // 버튼
  const isPlayer = room.role === 'black' || room.role === 'white';
  $('#btn-ready').classList.toggle('hidden', !isPlayer || room.status === 'playing' || room.status === 'finished');
  $('#btn-ready').textContent = room.ready[room.role] ? '준비 취소' : '준비';
  $('#btn-ready').classList.toggle('btn-ready-active', !!room.ready[room.role]);
  $('#btn-switch-player').classList.toggle('hidden', room.role !== 'spectator' || room.status === 'playing');
  $('#btn-undo').classList.toggle('hidden', !isPlayer || room.status !== 'playing' || !!room.undoRequest);
  $('#btn-resign').classList.toggle('hidden', !isPlayer || room.status !== 'playing');
  $('#btn-draw').classList.toggle('hidden', !isPlayer || room.status !== 'playing' || !!room.drawOffer);
  $('#btn-rematch').classList.toggle('hidden', !isPlayer || room.status !== 'finished');
  $('#btn-rematch').textContent = room.rematchVotes[room.role] ? '재대결 취소' : '재대결';

  // 요청 패널
  const reqPanel = $('#request-panel');
  let reqType = null;
  if (room.undoRequest && room.undoRequest !== room.role) {
    reqType = 'undo';
    $('#request-text').textContent = '상대가 무르기를 요청했습니다.';
  } else if (room.drawOffer && room.drawOffer !== room.role) {
    reqType = 'draw';
    $('#request-text').textContent = '상대가 무승부를 제안했습니다.';
  } else {
    reqPanel.classList.add('hidden');
  }
  if (reqType && isPlayer) {
    reqPanel.classList.remove('hidden');
    reqPanel.dataset.type = reqType;
  }

  // 채팅
  renderChat(room.chat);
}

function renderChat(messages) {
  const box = $('#chat-messages');
  if (!messages?.length) { box.innerHTML = ''; return; }
  box.innerHTML = messages.map((m) => {
    const cls = m.type === 'system' ? 'chat-system' : 'chat-user';
    const time = new Date(m.time).toLocaleTimeString('ko', { hour: '2-digit', minute: '2-digit' });
    return `<div class="chat-msg ${cls}"><span class="chat-time">${time}</span> <strong>${m.nickname}</strong> ${escapeHtml(m.text)}</div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── 게임 액션 ──
$('#btn-ready').addEventListener('click', async () => {
  const ready = !currentRoom?.ready[currentRoom.role];
  const r = await emitAsync('setReady', ready);
  if (!r.success) showToast(r.error);
});

$('#btn-switch-player').addEventListener('click', async () => {
  const r = await emitAsync('switchToPlayer');
  if (!r.success) showToast(r.error);
  else if (r.room) renderGame(r.room);
});

$('#btn-undo').addEventListener('click', async () => {
  const r = await emitAsync('requestUndo');
  if (!r.success) showToast(r.error);
  else showToast('무르기를 요청했습니다.');
});

$('#btn-resign').addEventListener('click', async () => {
  if (!confirm('정말 기권하시겠습니까?')) return;
  const r = await emitAsync('resign');
  if (!r.success) showToast(r.error);
});

$('#btn-draw').addEventListener('click', async () => {
  const r = await emitAsync('offerDraw');
  if (!r.success) showToast(r.error);
  else showToast('무승부를 제안했습니다.');
});

$('#btn-rematch').addEventListener('click', async () => {
  const vote = !currentRoom?.rematchVotes[currentRoom.role];
  const r = await emitAsync('voteRematch', vote);
  if (!r.success) showToast(r.error);
});

$('#btn-accept-request').addEventListener('click', async () => {
  const type = $('#request-panel').dataset.type;
  const r = await emitAsync(type === 'undo' ? 'respondUndo' : 'respondDraw', true);
  if (!r.success) showToast(r.error);
});

$('#btn-decline-request').addEventListener('click', async () => {
  const type = $('#request-panel').dataset.type;
  const r = await emitAsync(type === 'undo' ? 'respondUndo' : 'respondDraw', false);
  if (!r.success) showToast(r.error);
});

$('#btn-leave-room').addEventListener('click', async () => {
  await emitAsync('leaveRoom');
  currentRoom = null;
  boardEl = null;
  showScreen('lobby');
});

$('#btn-copy-code').addEventListener('click', () => {
  if (!currentRoom) return;
  navigator.clipboard.writeText(currentRoom.code).then(() => showToast('방 코드가 복사되었습니다!'));
});

$('#btn-share-link').addEventListener('click', () => {
  if (!currentRoom) return;
  const url = `${location.origin}${location.pathname}?room=${currentRoom.code}`;
  navigator.clipboard.writeText(url).then(() => showToast('초대 링크가 복사되었습니다!'));
});

async function sendChat(text) {
  const r = await emitAsync('sendChat', text);
  if (!r.success) showToast(r.error);
  else { $('#chat-input').value = ''; SoundManager.notify(); }
}

$('#btn-send-chat').addEventListener('click', () => {
  const text = $('#chat-input').value.trim();
  if (text) sendChat(text);
});
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const t = $('#chat-input').value.trim(); if (t) sendChat(t); }
});
document.querySelectorAll('.emoji-btn').forEach((btn) => {
  btn.addEventListener('click', () => sendChat(btn.dataset.emoji));
});

// ── AI 연습 ──

function getSheetTotal() {
  const n = parseInt(localStorage.getItem(SHEET_STORAGE_KEY) || '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function setSheetTotal(n) {
  const v = Math.max(0, Math.floor(n));
  localStorage.setItem(SHEET_STORAGE_KEY, String(v));
  refreshSheetBadge();
  return v;
}

function refreshSheetBadge() {
  const el = $('#sheet-total-count');
  if (el) el.textContent = String(getSheetTotal());
}

function practiceAiColor() {
  return practicePlayerColor === 'black' ? 'white' : 'black';
}

function colorKo(color) {
  return color === 'black' ? '흑' : '백';
}

/** 사이드바 라벨·돌 색 표시 갱신 */
function updatePracticePlayerUI() {
  const mine = practicePlayerColor;
  const ai = practiceAiColor();
  const pStone = $('#practice-player-stone');
  const aStone = $('#practice-ai-stone');
  if (pStone) pStone.className = `player-stone ${mine}`;
  if (aStone) aStone.className = `player-stone ${ai}`;
  const pLabel = $('#practice-player-label');
  const aLabel = $('#practice-ai-label');
  if (pLabel) pLabel.textContent = `나 (${colorKo(mine)})`;
  if (aLabel) aLabel.textContent = `AI (${colorKo(ai)})`;
}

function setPracticeColorPick(color) {
  practicePlayerColor = color === 'white' ? 'white' : 'black';
  localStorage.setItem('omok_practice_color', practicePlayerColor);
  document.querySelectorAll('.color-pick-btn').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.color === practicePlayerColor);
  });
}

function showPracticeSetup() {
  $('#practice-setup')?.classList.remove('hidden');
  $('#practice-play')?.classList.add('hidden');
  $('#practice-result')?.classList.add('hidden');
  practiceOver = true; // 보드 입력 차단
  setPracticeExpanded(false);
  refreshSheetBadge();
  setPracticeColorPick(practicePlayerColor);
}

function openPracticeScreen() {
  $('#practice-nickname').textContent = nickname || '플레이어';
  refreshSheetBadge();
  showPracticeSetup();
  showScreen('practice');
  ensurePracticeResizeObserver();
  requestAnimationFrame(() => updatePracticeBoardSize());
}

$('#btn-practice').addEventListener('click', openPracticeScreen);

$('#btn-leave-practice').addEventListener('click', () => {
  setPracticeExpanded(false);
  showPracticeSetup();
  showScreen('lobby');
});

$('#btn-practice-restart').addEventListener('click', () => {
  // 대국 중이면 같은 설정으로 재시작, 설정 화면이면 유지
  if ($('#practice-play') && !$('#practice-play').classList.contains('hidden')) {
    startPractice();
  } else {
    showPracticeSetup();
  }
});

$('#ai-difficulty').addEventListener('change', () => {
  // 대국 중 난이도 변경 시 새 판
  if ($('#practice-play') && !$('#practice-play').classList.contains('hidden') && !practiceOver) {
    startPractice();
  } else if ($('#practice-play') && !$('#practice-play').classList.contains('hidden') && practiceOver) {
    // 종료 후 난이도만 바꿔 둔 경우 — 재시작은 버튼으로
  }
});

$('#btn-expand-board')?.addEventListener('click', () => {
  const next = !document.body.classList.contains('practice-expanded');
  setPracticeExpanded(next);
});

// 돌 색 선택
document.querySelectorAll('.color-pick-btn').forEach((btn) => {
  btn.addEventListener('click', () => setPracticeColorPick(btn.dataset.color));
});

$('#btn-practice-start')?.addEventListener('click', () => startPractice());

$('#btn-result-rematch')?.addEventListener('click', () => startPractice());
$('#btn-result-setup')?.addEventListener('click', () => showPracticeSetup());
$('#btn-result-lobby')?.addEventListener('click', () => {
  showPracticeSetup();
  setPracticeExpanded(false);
  showScreen('lobby');
});

function startPractice() {
  practiceBoard = OmokAI.createBoard();
  practiceCurrent = 'black'; // 오목은 항상 흑 선공
  practiceOver = false;
  practiceRewardGiven = false;

  $('#practice-setup')?.classList.add('hidden');
  $('#practice-result')?.classList.add('hidden');
  $('#practice-play')?.classList.remove('hidden');
  $('#practice-status')?.classList.remove('win', 'lose', 'draw');

  updatePracticePlayerUI();

  practiceBoardEl = $('#practice-board');
  practiceBoardEl.innerHTML = '';
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.row = r;
      cell.dataset.col = c;
      cell.addEventListener('click', onPracticeClick);
      practiceBoardEl.appendChild(cell);
    }
  }

  const mine = practicePlayerColor;
  if (mine === 'black') {
    setPracticeTurnUI(true);
    $('#practice-status').textContent = '당신의 차례입니다 · 흑이 먼저 둡니다';
  } else {
    setPracticeTurnUI(false);
    $('#practice-status').textContent = 'AI(흑)가 먼저 둡니다…';
    // 백 선택 시 AI 선공
    setTimeout(() => runAiTurn(), 280);
  }

  ensurePracticeResizeObserver();
  requestAnimationFrame(() => updatePracticeBoardSize());
}

function setPracticeTurnUI(playerTurn) {
  $('#practice-player')?.classList.toggle('active', playerTurn);
  $('#practice-ai')?.classList.toggle('active', !playerTurn);
}

/** Extra UI delay so "생각 중" is visible; hard relies on search time itself. */
function practiceThinkDelay(diff) {
  if (diff === 'easy') return 180 + Math.random() * 220;
  if (diff === 'hard') return 80 + Math.random() * 120;
  return 250 + Math.random() * 200;
}

function isBoardFull(board) {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (!board[r][c]) return false;
    }
  }
  return true;
}

async function onPracticeClick(e) {
  if (practiceOver) return;
  if (practiceCurrent !== practicePlayerColor) return;

  const cell = e.currentTarget;
  const r = +cell.dataset.row;
  const c = +cell.dataset.col;
  if (practiceBoard[r][c]) return;

  placePracticeStone(r, c, practicePlayerColor);
  if (practiceOver) return;

  await runAiTurn();
}

async function runAiTurn() {
  if (practiceOver) return;
  const ai = practiceAiColor();
  practiceCurrent = ai;
  setPracticeTurnUI(false);
  $('#practice-status').textContent = '🐿️ 오목봇이 수를 고민하는 중…';

  const diff = $('#ai-difficulty').value;
  await new Promise((res) => setTimeout(res, practiceThinkDelay(diff)));
  if (practiceOver) return;

  const [ar, ac] = await OmokAI.getMoveAsync(practiceBoard, ai, diff);
  if (practiceOver) return;

  placePracticeStone(ar, ac, ai);
  if (!practiceOver) {
    practiceCurrent = practicePlayerColor;
    setPracticeTurnUI(true);
    $('#practice-status').textContent = `당신의 차례입니다 · ${colorKo(practicePlayerColor)}돌`;
  }
}

function placePracticeStone(r, c, color) {
  practiceBoard[r][c] = color;
  SoundManager.place();
  const cell = practiceBoardEl.querySelector(`[data-row="${r}"][data-col="${c}"]`);
  if (!cell) return;
  cell.classList.add('occupied');
  const el = document.createElement('div');
  el.className = `stone ${color}`;
  cell.appendChild(el);

  if (OmokAI.checkWin(practiceBoard, r, c, color)) {
    practiceOver = true;
    const playerWon = color === practicePlayerColor;
    finishPractice(playerWon ? 'win' : 'lose');
    return;
  }

  if (isBoardFull(practiceBoard)) {
    practiceOver = true;
    finishPractice('draw');
  }
}

/**
 * 대국 종료 처리 + 난이도별 악보 보상
 * @param {'win'|'lose'|'draw'} outcome
 */
function finishPractice(outcome) {
  const diff = $('#ai-difficulty')?.value || 'normal';
  const diffName = DIFF_LABEL[diff] || diff;
  const status = $('#practice-status');
  const result = $('#practice-result');
  const emoji = $('#practice-result-emoji');
  const title = $('#practice-result-title');
  const msg = $('#practice-result-msg');
  const rewardEl = $('#practice-result-reward');
  const totalEl = $('#practice-result-total');

  status?.classList.remove('win', 'lose', 'draw');

  if (outcome === 'win') {
    SoundManager.win();
    launchConfetti();
    status?.classList.add('win');

    let gained = 0;
    if (!practiceRewardGiven) {
      gained = SHEET_REWARD[diff] ?? 0;
      if (gained > 0) {
        setSheetTotal(getSheetTotal() + gained);
      }
      practiceRewardGiven = true;
    }

    if (gained > 0) {
      status.textContent = `🎉 승리! ${diffName} 클리어 — 악보 ${gained}곡 획득!`;
      if (emoji) emoji.textContent = '🎉🎵';
      if (title) title.textContent = '승리! 다람쥐가 환호해요!';
      if (msg) {
        msg.textContent =
          diff === 'hard'
            ? '어려움 난이도를 뚫어냈습니다. 정말 대단해요!'
            : '멋진 한 판이었어요. 악보가 추가되었습니다!';
      }
      if (rewardEl) {
        rewardEl.classList.remove('hidden');
        rewardEl.innerHTML = `🎵 <strong>악보 ${gained}곡</strong> 획득!`;
      }
    } else {
      // 쉬움: 보상 없음
      status.textContent = '🎉 승리! 연습 판 클리어 — 다음엔 보통·어려움에 도전해 보세요!';
      if (emoji) emoji.textContent = '🎉';
      if (title) title.textContent = '연습 승리!';
      if (msg) {
        msg.textContent =
          '잘했어요! 쉬움은 연습용이라 악보 보상은 없어요. 보통/어려움에서 이기면 악보를 받습니다.';
      }
      if (rewardEl) {
        rewardEl.classList.remove('hidden');
        rewardEl.textContent = '악보 보상 없음 (쉬움 · 연습 모드)';
      }
    }
  } else if (outcome === 'lose') {
    SoundManager.error();
    status?.classList.add('lose');
    status.textContent = '아쉽네요… 오목봇의 승리! 다시 도전해 볼까요?';
    if (emoji) emoji.textContent = '😅';
    if (title) title.textContent = '패배… 하지만 다음엔!';
    if (msg) {
      msg.textContent =
        diff === 'hard'
          ? '어려움은 만만치 않죠. 한 판 더 두며 감각을 익혀 보세요!'
          : '괜찮아요. 막는 수와 만드는 수를 의식하면 금방 늘어요.';
    }
    if (rewardEl) {
      rewardEl.classList.add('hidden');
      rewardEl.textContent = '';
    }
  } else {
    status?.classList.add('draw');
    status.textContent = '무승부! 판이 가득 찼습니다.';
    if (emoji) emoji.textContent = '🤝';
    if (title) title.textContent = '무승부!';
    if (msg) msg.textContent = '치열한 대국이었어요. 한 판 더 두어 볼까요?';
    if (rewardEl) {
      rewardEl.classList.add('hidden');
      rewardEl.textContent = '';
    }
  }

  if (totalEl) {
    totalEl.innerHTML = `보유 악보 합계: <strong>🎵 ${getSheetTotal()}곡</strong>`;
  }

  result?.classList.remove('hidden');
  refreshSheetBadge();
}

// 초기 악보 배지
refreshSheetBadge();
setPracticeColorPick(practicePlayerColor);

// ── 자동 입장 ──
setTimeout(async () => {
  if (nickname && serverAvailable) {
    const result = await emitAsync('setNickname', nickname);
    if (result.success) {
      $('#lobby-nickname').textContent = nickname;
      showScreen('lobby');
      checkUrlRoom();
    }
  }
}, 500);