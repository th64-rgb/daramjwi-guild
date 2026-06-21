const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const BOARD_SIZE = 15;
const WIN_COUNT = 5;
const TURN_TIME_SEC = 45;
const RECONNECT_GRACE_MS = 120000;
const MAX_CHAT = 100;
const MAX_UNDO = 3;

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
let onlineCount = 0;

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function createEmptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

function createRoom(hostId, hostNickname, isPrivate = false) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId,
    isPrivate,
    board: createEmptyBoard(),
    currentPlayer: 'black',
    status: 'waiting',
    winner: null,
    winLine: null,
    lastMove: null,
    moves: [],
    undoCount: 0,
    undoRequest: null,
    drawOffer: null,
    rematchVotes: { black: false, white: false },
    ready: { black: false, white: false },
    turnDeadline: null,
    chat: [],
    players: {
      black: { id: hostId, nickname: hostNickname, connected: true, disconnectedAt: null },
      white: null,
    },
    spectators: [],
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function getRoomList() {
  return Array.from(rooms.values())
    .filter((room) => !room.isPrivate)
    .map((room) => ({
      code: room.code,
      host: room.players.black?.nickname || '알 수 없음',
      playerCount: (room.players.black ? 1 : 0) + (room.players.white ? 1 : 0),
      spectatorCount: room.spectators.length,
      status: room.status,
      moveCount: room.moves.length,
    }));
}

function sanitizeNickname(nickname) {
  if (!nickname || typeof nickname !== 'string') return null;
  const trimmed = nickname.trim().slice(0, 12);
  return trimmed.length >= 2 ? trimmed : null;
}

function sanitizeChat(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim().slice(0, 200);
  return trimmed.length > 0 ? trimmed : null;
}

function getWinLine(board, row, col, color) {
  const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];

  for (const [dr, dc] of directions) {
    const line = [[row, col]];

    for (let i = 1; i < WIN_COUNT; i++) {
      const r = row + dr * i;
      const c = col + dc * i;
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE || board[r][c] !== color) break;
      line.push([r, c]);
    }

    for (let i = 1; i < WIN_COUNT; i++) {
      const r = row - dr * i;
      const c = col - dc * i;
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE || board[r][c] !== color) break;
      line.unshift([r, c]);
    }

    if (line.length >= WIN_COUNT) {
      const idx = line.findIndex(([r, c]) => r === row && c === col);
      return line.slice(Math.max(0, idx - 2), Math.max(0, idx - 2) + WIN_COUNT);
    }
  }
  return null;
}

function isBoardFull(board) {
  return board.every((row) => row.every((cell) => cell !== null));
}

function getPlayerRole(room, socketId) {
  if (room.players.black?.id === socketId) return 'black';
  if (room.players.white?.id === socketId) return 'white';
  if (room.spectators.some((s) => s.id === socketId)) return 'spectator';
  return null;
}

function findDisconnectedSlot(room, nickname) {
  if (room.players.black?.nickname === nickname && !room.players.black.connected) return 'black';
  if (room.players.white?.nickname === nickname && !room.players.white.connected) return 'white';
  return null;
}

function serializeRoom(room, socketId) {
  const role = getPlayerRole(room, socketId);
  const now = Date.now();
  const turnRemaining = room.turnDeadline
    ? Math.max(0, Math.ceil((room.turnDeadline - now) / 1000))
    : null;

  return {
    code: room.code,
    board: room.board,
    currentPlayer: room.currentPlayer,
    status: room.status,
    winner: room.winner,
    winLine: room.winLine,
    lastMove: room.lastMove,
    moves: room.moves,
    undoCount: room.undoCount,
    undoRequest: room.undoRequest,
    drawOffer: room.drawOffer,
    rematchVotes: room.rematchVotes,
    ready: room.ready,
    turnRemaining,
    turnTimeSec: TURN_TIME_SEC,
    role,
    players: {
      black: room.players.black
        ? { nickname: room.players.black.nickname, connected: room.players.black.connected }
        : null,
      white: room.players.white
        ? { nickname: room.players.white.nickname, connected: room.players.white.connected }
        : null,
    },
    spectators: room.spectators.map((s) => s.nickname),
    chat: room.chat,
    isHost: room.hostId === socketId,
    isPrivate: room.isPrivate,
    maxUndo: MAX_UNDO,
  };
}

function broadcastRoomList() {
  io.emit('roomList', getRoomList());
  io.emit('onlineCount', onlineCount);
}

function broadcastRoomUpdate(room) {
  const sockets = io.sockets.adapter.rooms.get(room.code);
  if (!sockets) return;
  for (const socketId of sockets) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('roomUpdate', serializeRoom(room, socketId));
    }
  }
}

function addChatMessage(room, nickname, text, type = 'chat') {
  room.chat.push({ nickname, text, type, time: Date.now() });
  if (room.chat.length > MAX_CHAT) room.chat.shift();
}

function removeFromRoom(room, socketId, markDisconnected = false) {
  let changed = false;

  if (room.players.black?.id === socketId) {
    if (markDisconnected && room.status === 'playing') {
      room.players.black.connected = false;
      room.players.black.disconnectedAt = Date.now();
    } else {
      room.players.black = null;
    }
    changed = true;
  }
  if (room.players.white?.id === socketId) {
    if (markDisconnected && room.status === 'playing') {
      room.players.white.connected = false;
      room.players.white.disconnectedAt = Date.now();
    } else {
      room.players.white = null;
    }
    changed = true;
  }

  const specIndex = room.spectators.findIndex((s) => s.id === socketId);
  if (specIndex !== -1) {
    room.spectators.splice(specIndex, 1);
    changed = true;
  }

  return changed;
}

function clearTimers(room) {
  room.turnDeadline = null;
}

function startTurnTimer(room) {
  if (room.status !== 'playing') {
    clearTimers(room);
    return;
  }
  room.turnDeadline = Date.now() + TURN_TIME_SEC * 1000;
}

function updateRoomStatus(room) {
  const hasBlack = !!room.players.black;
  const hasWhite = !!room.players.white;

  if (!hasBlack || !hasWhite) {
    room.status = 'waiting';
    room.ready = { black: false, white: false };
    clearTimers(room);
    return;
  }

  if (room.status === 'finished') return;

  if (room.ready.black && room.ready.white) {
    if (room.status !== 'playing') {
      room.status = 'playing';
      room.currentPlayer = 'black';
      room.winner = null;
      room.winLine = null;
      startTurnTimer(room);
    }
  } else if (room.status !== 'playing') {
    room.status = 'ready';
    clearTimers(room);
  }
}

function resetGame(room, keepReady = false) {
  room.board = createEmptyBoard();
  room.currentPlayer = 'black';
  room.winner = null;
  room.winLine = null;
  room.lastMove = null;
  room.moves = [];
  room.undoCount = 0;
  room.undoRequest = null;
  room.drawOffer = null;
  room.rematchVotes = { black: false, white: false };
  if (!keepReady) {
    room.ready = { black: false, white: false };
  }
  updateRoomStatus(room);
}

function deleteRoomIfEmpty(room) {
  const hasPlayers = room.players.black || room.players.white;
  const hasSpectators = room.spectators.length > 0;
  if (!hasPlayers && !hasSpectators) {
    rooms.delete(room.code);
    return true;
  }
  return false;
}

function handleTimeout(room) {
  if (room.status !== 'playing' || !room.turnDeadline) return;
  if (Date.now() < room.turnDeadline) return;

  const timedOut = room.currentPlayer;
  room.status = 'finished';
  room.winner = timedOut === 'black' ? 'white' : 'black';
  room.winLine = null;
  clearTimers(room);
  addChatMessage(room, '시스템', `${timedOut === 'black' ? '흑' : '백'} 시간 초과 — 상대 승리`, 'system');
  broadcastRoomUpdate(room);
  broadcastRoomList();
}

function placeStone(room, row, col, role) {
  room.board[row][col] = role;
  room.lastMove = { row, col, color: role };
  room.moves.push({ row, col, color: role });
  room.undoRequest = null;
  room.drawOffer = null;

  const winLine = getWinLine(room.board, row, col, role);
  if (winLine) {
    room.status = 'finished';
    room.winner = role;
    room.winLine = winLine;
    clearTimers(room);
    return;
  }

  if (isBoardFull(room.board)) {
    room.status = 'finished';
    room.winner = 'draw';
    room.winLine = null;
    clearTimers(room);
    return;
  }

  room.currentPlayer = role === 'black' ? 'white' : 'black';
  startTurnTimer(room);
}

function assignHost(room) {
  const newHost =
    (room.players.black?.connected && room.players.black) ||
    (room.players.white?.connected && room.players.white) ||
    room.players.black ||
    room.players.white ||
    room.spectators[0];
  if (newHost) room.hostId = newHost.id;
}

setInterval(() => {
  for (const room of rooms.values()) {
    handleTimeout(room);

    for (const color of ['black', 'white']) {
      const p = room.players[color];
      if (p && !p.connected && p.disconnectedAt) {
        if (Date.now() - p.disconnectedAt > RECONNECT_GRACE_MS) {
          room.players[color] = null;
          addChatMessage(room, '시스템', `${p.nickname} 재접속 시간 초과`, 'system');
          if (room.status === 'playing') {
            room.status = 'finished';
            room.winner = color === 'black' ? 'white' : 'black';
            clearTimers(room);
          } else {
            updateRoomStatus(room);
          }
          broadcastRoomUpdate(room);
          broadcastRoomList();
        }
      }
    }
  }
}, 1000);

io.on('connection', (socket) => {
  let nickname = null;
  let currentRoom = null;
  onlineCount++;
  broadcastRoomList();

  socket.emit('roomList', getRoomList());
  socket.emit('onlineCount', onlineCount);

  socket.on('setNickname', (name, callback) => {
    const valid = sanitizeNickname(name);
    if (!valid) {
      callback?.({ success: false, error: '닉네임은 2~12자여야 합니다.' });
      return;
    }
    nickname = valid;
    callback?.({ success: true, nickname });
  });

  socket.on('createRoom', ({ isPrivate } = {}, callback) => {
    if (!nickname) {
      callback?.({ success: false, error: '닉네임을 먼저 설정해주세요.' });
      return;
    }
    if (currentRoom) {
      callback?.({ success: false, error: '이미 방에 있습니다.' });
      return;
    }

    const room = createRoom(socket.id, nickname, !!isPrivate);
    currentRoom = room.code;
    socket.join(room.code);
    addChatMessage(room, '시스템', `${nickname}님이 방을 만들었습니다.`, 'system');
    callback?.({ success: true, room: serializeRoom(room, socket.id) });
    broadcastRoomList();
  });

  socket.on('joinRoom', ({ code, asSpectator }, callback) => {
    if (!nickname) {
      callback?.({ success: false, error: '닉네임을 먼저 설정해주세요.' });
      return;
    }
    if (currentRoom) {
      callback?.({ success: false, error: '이미 방에 있습니다.' });
      return;
    }

    const room = rooms.get(code?.toUpperCase());
    if (!room) {
      callback?.({ success: false, error: '방을 찾을 수 없습니다.' });
      return;
    }

    const reclaimed = findDisconnectedSlot(room, nickname);
    if (reclaimed) {
      const player = room.players[reclaimed];
      player.id = socket.id;
      player.connected = true;
      player.disconnectedAt = null;
      currentRoom = room.code;
      socket.join(room.code);
      addChatMessage(room, '시스템', `${nickname}님이 재접속했습니다.`, 'system');
      updateRoomStatus(room);
      callback?.({ success: true, room: serializeRoom(room, socket.id), reconnected: true });
      broadcastRoomUpdate(room);
      broadcastRoomList();
      return;
    }

    const alreadyIn =
      room.players.black?.id === socket.id ||
      room.players.white?.id === socket.id ||
      room.spectators.some((s) => s.id === socket.id);

    if (alreadyIn) {
      currentRoom = room.code;
      socket.join(room.code);
      callback?.({ success: true, room: serializeRoom(room, socket.id) });
      return;
    }

    if (asSpectator) {
      room.spectators.push({ id: socket.id, nickname });
      addChatMessage(room, '시스템', `${nickname}님이 관전합니다.`, 'system');
    } else if (!room.players.white) {
      room.players.white = { id: socket.id, nickname, connected: true, disconnectedAt: null };
      addChatMessage(room, '시스템', `${nickname}님이 참가했습니다.`, 'system');
      updateRoomStatus(room);
    } else if (!room.players.black) {
      room.players.black = { id: socket.id, nickname, connected: true, disconnectedAt: null };
      addChatMessage(room, '시스템', `${nickname}님이 참가했습니다.`, 'system');
      updateRoomStatus(room);
    } else {
      room.spectators.push({ id: socket.id, nickname });
      addChatMessage(room, '시스템', `${nickname}님이 관전합니다.`, 'system');
    }

    currentRoom = room.code;
    socket.join(room.code);
    callback?.({ success: true, room: serializeRoom(room, socket.id) });
    broadcastRoomUpdate(room);
    broadcastRoomList();
  });

  socket.on('setReady', (ready, callback) => {
    const room = rooms.get(currentRoom);
    if (!room) {
      callback?.({ success: false, error: '방을 찾을 수 없습니다.' });
      return;
    }

    const role = getPlayerRole(room, socket.id);
    if (role !== 'black' && role !== 'white') {
      callback?.({ success: false, error: '플레이어만 준비할 수 있습니다.' });
      return;
    }

    room.ready[role] = !!ready;
    if (!ready && room.status !== 'playing') {
      room.status = 'ready';
      clearTimers(room);
    }
    updateRoomStatus(room);
    broadcastRoomUpdate(room);
    broadcastRoomList();
    callback?.({ success: true });
  });

  socket.on('placeStone', ({ row, col }, callback) => {
    if (!currentRoom) {
      callback?.({ success: false, error: '방에 있지 않습니다.' });
      return;
    }

    const room = rooms.get(currentRoom);
    if (!room || room.status !== 'playing') {
      callback?.({ success: false, error: '게임이 진행 중이 아닙니다.' });
      return;
    }

    const role = getPlayerRole(room, socket.id);
    if (role !== 'black' && role !== 'white') {
      callback?.({ success: false, error: '플레이어만 돌을 둘 수 있습니다.' });
      return;
    }

    if (role !== room.currentPlayer) {
      callback?.({ success: false, error: '상대방 차례입니다.' });
      return;
    }

    if (
      row < 0 || row >= BOARD_SIZE ||
      col < 0 || col >= BOARD_SIZE ||
      room.board[row][col] !== null
    ) {
      callback?.({ success: false, error: '유효하지 않은 위치입니다.' });
      return;
    }

    placeStone(room, row, col, role);
    broadcastRoomUpdate(room);
    broadcastRoomList();
    callback?.({ success: true });
  });

  socket.on('requestUndo', (callback) => {
    const room = rooms.get(currentRoom);
    if (!room || room.status !== 'playing') {
      callback?.({ success: false, error: '게임 중에만 무르기가 가능합니다.' });
      return;
    }

    const role = getPlayerRole(room, socket.id);
    if (role !== 'black' && role !== 'white') {
      callback?.({ success: false, error: '플레이어만 무르기를 요청할 수 있습니다.' });
      return;
    }

    if (room.moves.length < 2) {
      callback?.({ success: false, error: '무를 수 있는 수가 없습니다.' });
      return;
    }

    if (room.undoCount >= MAX_UNDO) {
      callback?.({ success: false, error: `무르기는 최대 ${MAX_UNDO}회입니다.` });
      return;
    }

    if (room.undoRequest) {
      callback?.({ success: false, error: '이미 무르기 요청이 있습니다.' });
      return;
    }

    room.undoRequest = role;
    broadcastRoomUpdate(room);
    callback?.({ success: true });
  });

  socket.on('respondUndo', (accept, callback) => {
    const room = rooms.get(currentRoom);
    if (!room || !room.undoRequest) {
      callback?.({ success: false, error: '무르기 요청이 없습니다.' });
      return;
    }

    const role = getPlayerRole(room, socket.id);
    const requester = room.undoRequest;
    if (role === requester || role === 'spectator') {
      callback?.({ success: false, error: '상대방만 응답할 수 있습니다.' });
      return;
    }

    if (accept) {
      room.moves.pop();
      room.moves.pop();
      const last = room.moves[room.moves.length - 1];
      room.board = createEmptyBoard();
      for (const m of room.moves) room.board[m.row][m.col] = m.color;
      room.lastMove = last ? { row: last.row, col: last.col, color: last.color } : null;
      room.currentPlayer = requester;
      room.undoCount++;
      room.undoRequest = null;
      startTurnTimer(room);
      addChatMessage(room, '시스템', '무르기가 승인되었습니다.', 'system');
    } else {
      room.undoRequest = null;
      addChatMessage(room, '시스템', '무르기가 거절되었습니다.', 'system');
    }

    broadcastRoomUpdate(room);
    callback?.({ success: true });
  });

  socket.on('resign', (callback) => {
    const room = rooms.get(currentRoom);
    if (!room || room.status !== 'playing') {
      callback?.({ success: false, error: '게임 중에만 기권할 수 있습니다.' });
      return;
    }

    const role = getPlayerRole(room, socket.id);
    if (role !== 'black' && role !== 'white') {
      callback?.({ success: false, error: '플레이어만 기권할 수 있습니다.' });
      return;
    }

    room.status = 'finished';
    room.winner = role === 'black' ? 'white' : 'black';
    room.winLine = null;
    clearTimers(room);
    addChatMessage(room, '시스템', `${nickname}님이 기권했습니다.`, 'system');
    broadcastRoomUpdate(room);
    broadcastRoomList();
    callback?.({ success: true });
  });

  socket.on('offerDraw', (callback) => {
    const room = rooms.get(currentRoom);
    if (!room || room.status !== 'playing') {
      callback?.({ success: false, error: '게임 중에만 무승부를 제안할 수 있습니다.' });
      return;
    }

    const role = getPlayerRole(room, socket.id);
    if (role !== 'black' && role !== 'white') {
      callback?.({ success: false, error: '플레이어만 제안할 수 있습니다.' });
      return;
    }

    room.drawOffer = role;
    broadcastRoomUpdate(room);
    callback?.({ success: true });
  });

  socket.on('respondDraw', (accept, callback) => {
    const room = rooms.get(currentRoom);
    if (!room || !room.drawOffer) {
      callback?.({ success: false, error: '무승부 제안이 없습니다.' });
      return;
    }

    const role = getPlayerRole(room, socket.id);
    if (role === room.drawOffer || role === 'spectator') {
      callback?.({ success: false, error: '상대방만 응답할 수 있습니다.' });
      return;
    }

    if (accept) {
      room.status = 'finished';
      room.winner = 'draw';
      room.winLine = null;
      clearTimers(room);
      addChatMessage(room, '시스템', '무승부로 게임이 종료되었습니다.', 'system');
    } else {
      room.drawOffer = null;
      addChatMessage(room, '시스템', '무승부 제안이 거절되었습니다.', 'system');
    }

    broadcastRoomUpdate(room);
    broadcastRoomList();
    callback?.({ success: true });
  });

  socket.on('voteRematch', (vote, callback) => {
    const room = rooms.get(currentRoom);
    if (!room || room.status !== 'finished') {
      callback?.({ success: false, error: '게임 종료 후에만 가능합니다.' });
      return;
    }

    const role = getPlayerRole(room, socket.id);
    if (role !== 'black' && role !== 'white') {
      callback?.({ success: false, error: '플레이어만 투표할 수 있습니다.' });
      return;
    }

    room.rematchVotes[role] = !!vote;

    if (room.rematchVotes.black && room.rematchVotes.white) {
      resetGame(room, true);
      room.ready = { black: true, white: true };
      updateRoomStatus(room);
      addChatMessage(room, '시스템', '새 게임이 시작됩니다!', 'system');
    }

    broadcastRoomUpdate(room);
    broadcastRoomList();
    callback?.({ success: true });
  });

  socket.on('sendChat', (text, callback) => {
    const room = rooms.get(currentRoom);
    if (!room) {
      callback?.({ success: false, error: '방에 있지 않습니다.' });
      return;
    }

    const valid = sanitizeChat(text);
    if (!valid) {
      callback?.({ success: false, error: '메시지를 입력해주세요.' });
      return;
    }

    addChatMessage(room, nickname, valid);
    broadcastRoomUpdate(room);
    callback?.({ success: true });
  });

  socket.on('switchToPlayer', (callback) => {
    const room = rooms.get(currentRoom);
    if (!room) {
      callback?.({ success: false, error: '방에 있지 않습니다.' });
      return;
    }

    const specIdx = room.spectators.findIndex((s) => s.id === socket.id);
    if (specIdx === -1) {
      callback?.({ success: false, error: '관전자만 전환할 수 있습니다.' });
      return;
    }

    if (room.status === 'playing') {
      callback?.({ success: false, error: '게임 중에는 참가할 수 없습니다.' });
      return;
    }

    let slot = null;
    if (!room.players.white) slot = 'white';
    else if (!room.players.black) slot = 'black';

    if (!slot) {
      callback?.({ success: false, error: '빈 자리가 없습니다.' });
      return;
    }

    room.spectators.splice(specIdx, 1);
    room.players[slot] = { id: socket.id, nickname, connected: true, disconnectedAt: null };
    updateRoomStatus(room);
    addChatMessage(room, '시스템', `${nickname}님이 플레이어로 참가했습니다.`, 'system');
    broadcastRoomUpdate(room);
    broadcastRoomList();
    callback?.({ success: true, room: serializeRoom(room, socket.id) });
  });

  socket.on('kickSpectator', (targetNickname, callback) => {
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) {
      callback?.({ success: false, error: '방장만 추방할 수 있습니다.' });
      return;
    }

    const idx = room.spectators.findIndex((s) => s.nickname === targetNickname);
    if (idx === -1) {
      callback?.({ success: false, error: '관전자를 찾을 수 없습니다.' });
      return;
    }

    const kicked = room.spectators[idx];
    room.spectators.splice(idx, 1);
    const kickedSocket = io.sockets.sockets.get(kicked.id);
    if (kickedSocket) {
      kickedSocket.leave(room.code);
      kickedSocket.emit('kicked', { reason: '방장에 의해 추방되었습니다.' });
    }
    addChatMessage(room, '시스템', `${targetNickname}님이 추방되었습니다.`, 'system');
    broadcastRoomUpdate(room);
    broadcastRoomList();
    callback?.({ success: true });
  });

  socket.on('leaveRoom', (callback) => {
    if (!currentRoom) {
      callback?.({ success: true });
      return;
    }

    const room = rooms.get(currentRoom);
    if (room) {
      const wasPlaying = room.status === 'playing';
      const role = getPlayerRole(room, socket.id);
      removeFromRoom(room, socket.id, false);
      socket.leave(currentRoom);

      if (room.hostId === socket.id) assignHost(room);

      if (wasPlaying && role) {
        room.status = 'finished';
        room.winner = role === 'black' ? 'white' : 'black';
        clearTimers(room);
        addChatMessage(room, '시스템', `${nickname}님이 나갔습니다.`, 'system');
      } else {
        updateRoomStatus(room);
      }

      if (deleteRoomIfEmpty(room)) {
        broadcastRoomList();
      } else {
        broadcastRoomUpdate(room);
        broadcastRoomList();
      }
    }

    currentRoom = null;
    callback?.({ success: true });
  });

  socket.on('disconnect', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastRoomList();

    if (!currentRoom) return;

    const room = rooms.get(currentRoom);
    if (!room) return;

    const wasPlaying = room.status === 'playing';
    removeFromRoom(room, socket.id, wasPlaying);

    if (room.hostId === socket.id) assignHost(room);

    if (wasPlaying) {
      const hasBlack = room.players.black?.connected;
      const hasWhite = room.players.white?.connected;
      if (!hasBlack || !hasWhite) {
        // keep slot for reconnect grace period
      }
    } else {
      updateRoomStatus(room);
    }

    addChatMessage(room, '시스템', `${nickname || '플레이어'}님이 나갔습니다.`, 'system');

    if (deleteRoomIfEmpty(room)) {
      broadcastRoomList();
    } else {
      broadcastRoomUpdate(room);
      broadcastRoomList();
    }
  });
});

server.listen(PORT, () => {
  console.log(`다람쥐구조대 오목 서버 실행 중: http://localhost:${PORT}`);
});