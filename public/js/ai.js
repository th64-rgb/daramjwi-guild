const OmokAI = (() => {
  const SIZE = 15;
  const WIN = 5;

  function createBoard() {
    return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  }

  function inBounds(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  function countLine(board, r, c, dr, dc, color) {
    let n = 0;
    for (let i = 0; i < WIN; i++) {
      const nr = r + dr * i;
      const nc = c + dc * i;
      if (!inBounds(nr, nc) || board[nr][nc] !== color) return 0;
      n++;
    }
    return n;
  }

  function evaluatePoint(board, r, c, color) {
    if (board[r][c]) return -1;
    const opp = color === 'black' ? 'white' : 'black';
    let score = 0;
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];

    for (const [dr, dc] of dirs) {
      const mine = countLine(board, r, c, dr, dc, color);
      const theirs = countLine(board, r, c, dr, dc, opp);
      if (mine >= WIN) score += 100000;
      else if (mine === 4) score += 10000;
      else if (mine === 3) score += 1000;
      else if (mine === 2) score += 100;
      if (theirs >= WIN) score += 50000;
      else if (theirs === 4) score += 8000;
      else if (theirs === 3) score += 800;
      else if (theirs === 2) score += 80;
    }

    const center = Math.abs(r - 7) + Math.abs(c - 7);
    score += (14 - center) * 3;
    score += Math.random() * 5;
    return score;
  }

  function findWinMove(board, color) {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c]) continue;
        board[r][c] = color;
        if (checkWin(board, r, c, color)) {
          board[r][c] = null;
          return [r, c];
        }
        board[r][c] = null;
      }
    }
    return null;
  }

  function checkWin(board, row, col, color) {
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of dirs) {
      let count = 1;
      for (let i = 1; i < WIN; i++) {
        const r = row + dr * i, c = col + dc * i;
        if (!inBounds(r, c) || board[r][c] !== color) break;
        count++;
      }
      for (let i = 1; i < WIN; i++) {
        const r = row - dr * i, c = col - dc * i;
        if (!inBounds(r, c) || board[r][c] !== color) break;
        count++;
      }
      if (count >= WIN) return true;
    }
    return false;
  }

  function getCandidates(board) {
    const set = new Set();
    let hasStone = false;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c]) {
          hasStone = true;
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              const nr = r + dr, nc = c + dc;
              if (inBounds(nr, nc) && !board[nr][nc]) set.add(`${nr},${nc}`);
            }
          }
        }
      }
    }
    if (!hasStone) return [[7, 7]];
    return [...set].map((s) => s.split(',').map(Number));
  }

  function getMove(board, color, difficulty = 'normal') {
    const win = findWinMove(board, color);
    if (win) return win;

    const block = findWinMove(board, color === 'black' ? 'white' : 'black');
    if (block) return block;

    if (difficulty === 'easy' && Math.random() < 0.35) {
      const candidates = getCandidates(board);
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    const candidates = getCandidates(board);
    let best = null;
    let bestScore = -Infinity;
    const depth = difficulty === 'hard' ? 1.5 : difficulty === 'easy' ? 0.6 : 1;

    for (const [r, c] of candidates) {
      const score = evaluatePoint(board, r, c, color) * depth;
      if (score > bestScore) {
        bestScore = score;
        best = [r, c];
      }
    }
    return best || [7, 7];
  }

  return { createBoard, checkWin, getMove, SIZE };
})();