/**
 * OmokAI — Gomoku (Five-in-a-Row) engine for browser play.
 *
 * Difficulty ladder (clear strength gaps):
 *   easy   — greedy 1-ply + intentional mistakes (misses non-forced threats)
 *   normal — pattern eval + alpha-beta (~4–5 ply)
 *   hard   — iterative deepening alpha-beta (target 8+ ply, time-boxed)
 *
 * Public API (stable for client.js):
 *   createBoard(), checkWin(board,r,c,color), getMove(board,color,diff),
 *   getMoveAsync(board,color,diff) → Promise<[r,c]>, SIZE
 */
const OmokAI = (() => {
  const SIZE = 15;
  const WIN = 5;
  const DIRS = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  // ── Pattern weights (attack). Defense uses a high fraction of these. ──
  const W = {
    FIVE: 10_000_000,
    OPEN_FOUR: 1_000_000,
    CLOSED_FOUR: 100_000,
    DOUBLE_THREE: 500_000, // two open-threes (or four+three) = fork
    OPEN_THREE: 50_000,
    CLOSED_THREE: 5_000,
    OPEN_TWO: 2_000,
    CLOSED_TWO: 400,
    ONE: 20,
  };

  /**
   * Per-level search / personality knobs.
   * Depths are "plies" (half-moves). Branching is hard-capped for UI speed.
   */
  const LEVEL = {
    easy: {
      depth: 1, // static ranking only (1 ply after forced win/block)
      branch: 8,
      radius: 2,
      timeMs: 30,
      // Intentional weakness — still always takes win / blocks immediate 5
      randomMoveChance: 0.35,
      missOpenThreeChance: 0.45,
      missClosedFourChance: 0.12,
      pickFromTop: 5,
    },
    normal: {
      depth: 5, // ~4–6 ply window
      branch: 12,
      radius: 2,
      timeMs: 120,
      randomMoveChance: 0,
      missOpenThreeChance: 0,
      missClosedFourChance: 0,
      pickFromTop: 1,
    },
    hard: {
      depth: 8, // iterative deepening target
      branch: 14,
      radius: 2,
      timeMs: 500, // stay snappy in the browser
      randomMoveChance: 0,
      missOpenThreeChance: 0,
      missClosedFourChance: 0,
      pickFromTop: 1,
    },
  };

  function createBoard() {
    return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  }

  function cloneBoard(board) {
    return board.map((row) => row.slice());
  }

  function inBounds(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  function opponent(color) {
    return color === 'black' ? 'white' : 'black';
  }

  function checkWin(board, row, col, color) {
    for (const [dr, dc] of DIRS) {
      let count = 1;
      for (let i = 1; i < WIN; i++) {
        const r = row + dr * i;
        const c = col + dc * i;
        if (!inBounds(r, c) || board[r][c] !== color) break;
        count++;
      }
      for (let i = 1; i < WIN; i++) {
        const r = row - dr * i;
        const c = col - dc * i;
        if (!inBounds(r, c) || board[r][c] !== color) break;
        count++;
      }
      if (count >= WIN) return true;
    }
    return false;
  }

  /** First empty cell that completes five for `color`, or null. */
  function findWinMove(board, color) {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c]) continue;
        board[r][c] = color;
        const win = checkWin(board, r, c, color);
        board[r][c] = null;
        if (win) return [r, c];
      }
    }
    return null;
  }

  /**
   * Scan one direction through a just-placed stone.
   * Returns consecutive count, open ends (0–2), and a pattern weight.
   */
  function analyzeDir(board, r, c, dr, dc, color) {
    let left = 0;
    let right = 0;
    let leftOpen = false;
    let rightOpen = false;

    for (let i = 1; i < WIN; i++) {
      const nr = r - dr * i;
      const nc = c - dc * i;
      if (!inBounds(nr, nc)) break;
      if (board[nr][nc] === color) left++;
      else {
        leftOpen = board[nr][nc] === null;
        break;
      }
    }
    for (let i = 1; i < WIN; i++) {
      const nr = r + dr * i;
      const nc = c + dc * i;
      if (!inBounds(nr, nc)) break;
      if (board[nr][nc] === color) right++;
      else {
        rightOpen = board[nr][nc] === null;
        break;
      }
    }

    const count = 1 + left + right;
    const openEnds = (leftOpen ? 1 : 0) + (rightOpen ? 1 : 0);

    // Broken shapes: stone . stones (one-gap jump) — still tactical
    let jumpW = 0;
    for (const sign of [-1, 1]) {
      const er = r + dr * sign;
      const ec = c + dc * sign;
      if (!inBounds(er, ec) || board[er][ec] !== null) continue;
      let jump = 0;
      for (let i = 2; i <= 4; i++) {
        const nr = r + dr * sign * i;
        const nc = c + dc * sign * i;
        if (!inBounds(nr, nc) || board[nr][nc] !== color) break;
        jump++;
      }
      if (jump === 0) continue;
      const total = count + jump;
      const fr = r + dr * sign * (jump + 2);
      const fc = c + dc * sign * (jump + 2);
      const farOpen = inBounds(fr, fc) && board[fr][fc] === null;
      const ends = openEnds + (farOpen ? 1 : 0);
      if (total >= 4 && ends >= 1) jumpW = Math.max(jumpW, W.CLOSED_FOUR * 0.85);
      else if (total === 3 && ends >= 2) jumpW = Math.max(jumpW, W.OPEN_THREE * 0.65);
      else if (total === 3 && ends >= 1) jumpW = Math.max(jumpW, W.CLOSED_THREE * 0.65);
      else if (total === 2 && ends >= 2) jumpW = Math.max(jumpW, W.OPEN_TWO * 0.5);
    }

    let pattern = 0;
    if (count >= WIN) pattern = W.FIVE;
    else if (count === 4 && openEnds === 2) pattern = W.OPEN_FOUR;
    else if (count === 4 && openEnds === 1) pattern = W.CLOSED_FOUR;
    else if (count === 3 && openEnds === 2) pattern = W.OPEN_THREE;
    else if (count === 3 && openEnds === 1) pattern = W.CLOSED_THREE;
    else if (count === 2 && openEnds === 2) pattern = W.OPEN_TWO;
    else if (count === 2 && openEnds === 1) pattern = W.CLOSED_TWO;
    else if (count === 1) pattern = W.ONE * Math.max(1, openEnds);
    else if (openEnds === 0) pattern = 0;

    pattern = Math.max(pattern, jumpW);

    // Not enough free space in a 9-cell window → shape is nearly dead
    let room = 0;
    for (let i = -4; i <= 4; i++) {
      if (i === 0) continue;
      const nr = r + dr * i;
      const nc = c + dc * i;
      if (!inBounds(nr, nc)) continue;
      if (board[nr][nc] === null || board[nr][nc] === color) room++;
    }
    if (count < WIN && room < 4) pattern = Math.floor(pattern * 0.25);

    return { count, openEnds, pattern };
  }

  /**
   * Score of placing `color` at (r,c): own threats + fork bonus.
   * Mutates board briefly (restored before return).
   */
  function scoreAttack(board, r, c, color) {
    if (board[r][c]) return -Infinity;
    board[r][c] = color;

    let total = 0;
    let openThrees = 0;
    let fours = 0;

    for (const [dr, dc] of DIRS) {
      const { pattern, count, openEnds } = analyzeDir(board, r, c, dr, dc, color);
      total += pattern;
      if (count >= WIN) {
        board[r][c] = null;
        return W.FIVE;
      }
      if (count === 4 && openEnds >= 1) fours++;
      if (count === 3 && openEnds === 2) openThrees++;
      // closed four also pressures
      if (count === 4 && openEnds === 1) fours += 0.5;
    }

    // Forks: two independent threats that can't both be blocked in one move
    if (fours >= 2 || (fours >= 1 && openThrees >= 1) || openThrees >= 2) {
      total += W.DOUBLE_THREE;
    }

    // Central control (early-game gentle bias)
    const dist = Math.abs(r - 7) + Math.abs(c - 7);
    total += (14 - dist) * 8;

    board[r][c] = null;
    return total;
  }

  /**
   * Combined move score: attack + nearly equal defense (block opponent shapes).
   * Hard slightly prefers proactive attack; easy uses noisier blend in caller.
   */
  function evaluateMove(board, r, c, color, defenseWeight = 0.95) {
    if (board[r][c]) return -Infinity;
    const atk = scoreAttack(board, r, c, color);
    const def = scoreAttack(board, r, c, opponent(color));
    return atk + def * defenseWeight;
  }

  /** Empty cells near existing stones (candidate generation). */
  function getCandidates(board, radius = 2) {
    const set = new Set();
    let hasStone = false;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!board[r][c]) continue;
        hasStone = true;
        for (let dr = -radius; dr <= radius; dr++) {
          for (let dc = -radius; dc <= radius; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr;
            const nc = c + dc;
            if (inBounds(nr, nc) && !board[nr][nc]) set.add(nr * SIZE + nc);
          }
        }
      }
    }
    if (!hasStone) return [[7, 7]];
    return [...set].map((k) => [Math.floor(k / SIZE), k % SIZE]);
  }

  /** Rank candidates by static evaluateMove; return top `limit`. */
  function rankCandidates(board, color, limit, radius, defenseWeight) {
    const raw = getCandidates(board, radius);
    const scored = raw.map(([r, c]) => ({
      r,
      c,
      s: evaluateMove(board, r, c, color, defenseWeight),
    }));
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, Math.min(limit, scored.length));
  }

  /**
   * Static whole-board eval for leaves (sum of runs for both colors).
   * Faster / coarser than per-move placement scoring.
   */
  function evaluateBoard(board, aiColor) {
    let score = 0;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const me = board[r][c];
        if (!me) continue;
        const mult = me === aiColor ? 1 : -1;
        for (const [dr, dc] of DIRS) {
          const pr = r - dr;
          const pc = c - dc;
          // Start only at the "head" of a run to avoid double-counting
          if (inBounds(pr, pc) && board[pr][pc] === me) continue;

          let count = 0;
          let i = 0;
          while (inBounds(r + dr * i, c + dc * i) && board[r + dr * i][c + dc * i] === me) {
            count++;
            i++;
          }
          const openRight =
            inBounds(r + dr * i, c + dc * i) && board[r + dr * i][c + dc * i] === null;
          const openLeft =
            inBounds(r - dr, c - dc) && board[r - dr][c - dc] === null;
          const openEnds = (openLeft ? 1 : 0) + (openRight ? 1 : 0);

          let v = 0;
          if (count >= 5) v = W.FIVE;
          else if (count === 4 && openEnds === 2) v = W.OPEN_FOUR;
          else if (count === 4 && openEnds === 1) v = W.CLOSED_FOUR;
          else if (count === 3 && openEnds === 2) v = W.OPEN_THREE;
          else if (count === 3 && openEnds === 1) v = W.CLOSED_THREE;
          else if (count === 2 && openEnds === 2) v = W.OPEN_TWO;
          else if (count === 2 && openEnds === 1) v = W.CLOSED_TWO;
          else if (count === 1 && openEnds > 0) v = W.ONE;

          score += mult * v;
        }
      }
    }
    return score;
  }

  /**
   * Threat classification of a placement (for move ordering / easy mistakes).
   * Returns max severity: 'five' | 'openFour' | 'closedFour' | 'openThree' | 'other'
   */
  function threatType(board, r, c, color) {
    board[r][c] = color;
    let best = 'other';
    let openThrees = 0;
    let fours = 0;
    for (const [dr, dc] of DIRS) {
      const { count, openEnds } = analyzeDir(board, r, c, dr, dc, color);
      if (count >= WIN) {
        board[r][c] = null;
        return 'five';
      }
      if (count === 4 && openEnds === 2) best = 'openFour';
      else if (count === 4 && openEnds === 1) {
        fours++;
        if (best !== 'openFour') best = 'closedFour';
      } else if (count === 3 && openEnds === 2) {
        openThrees++;
        if (best === 'other') best = 'openThree';
      }
    }
    if (fours + openThrees >= 2 && best !== 'openFour') best = 'openFour'; // fork ~ force
    board[r][c] = null;
    return best;
  }

  /** Find moves that create a given threat for color (used by easy miss logic). */
  function findThreatMoves(board, color, types) {
    const hits = [];
    const candidates = getCandidates(board, 2);
    for (const [r, c] of candidates) {
      const t = threatType(board, r, c, color);
      if (types.includes(t)) hits.push([r, c, t]);
    }
    return hits;
  }

  // ── Search state (reused to avoid allocations churn) ──
  let nodes = 0;
  let deadline = 0;
  let timedOut = false;

  function timeUp() {
    if (Date.now() >= deadline) {
      timedOut = true;
      return true;
    }
    return false;
  }

  /**
   * Negamax + alpha-beta.
   * Score is ALWAYS from the perspective of `color` (side to move):
   *   positive = good for the player about to move.
   * Parent calls with:  val = -negamax(..., opponent(color), ...)
   */
  function negamax(board, depth, alpha, beta, color, branch, radius, lastR, lastC) {
    nodes++;
    if ((nodes & 63) === 0 && timeUp()) return 0;

    // Previous player already has five → current side to move has lost
    if (lastR != null && checkWin(board, lastR, lastC, opponent(color))) {
      return -(W.FIVE + depth * 1000); // prefer faster wins / slower losses
    }

    if (depth === 0) {
      // Leaf: static eval for the side that would move next
      return evaluateBoard(board, color);
    }

    const ranked = rankCandidates(board, color, branch, radius, 0.95);
    if (!ranked.length) return 0;

    // Taper branching deeper for browser performance
    const childBranch = Math.max(6, branch - 1);
    let best = -Infinity;

    for (const { r, c } of ranked) {
      if (timedOut) break;
      board[r][c] = color;
      const val = -negamax(
        board,
        depth - 1,
        -beta,
        -alpha,
        opponent(color),
        childBranch,
        radius,
        r,
        c
      );
      board[r][c] = null;

      if (val > best) best = val;
      if (val > alpha) alpha = val;
      if (alpha >= beta) break; // beta cutoff
    }
    return best;
  }

  /**
   * Root search: try top moves, return best [r,c].
   * For hard, uses iterative deepening up to cfg.depth or timeMs.
   */
  function searchBest(board, color, cfg, fixedDepth) {
    nodes = 0;
    timedOut = false;
    deadline = Date.now() + cfg.timeMs;

    // Always resolve forced wins / blocks first (caller may already have)
    const win = findWinMove(board, color);
    if (win) return win;
    const block = findWinMove(board, opponent(color));
    if (block) return block;

    const maxDepth = fixedDepth != null ? fixedDepth : cfg.depth;
    let bestMove = null;
    let bestScore = -Infinity;

    // Seed with static ranking so we always have a legal reply
    const seed = rankCandidates(board, color, cfg.branch, cfg.radius, 0.95);
    if (!seed.length) return [7, 7];
    bestMove = [seed[0].r, seed[0].c];

    // Iterative deepening: depth 1 → maxDepth (or until time)
    const startDepth = maxDepth <= 2 ? maxDepth : 1;
    for (let d = startDepth; d <= maxDepth; d++) {
      if (timeUp() && d > startDepth) break;

      let iterBest = null;
      let iterScore = -Infinity;
      let alpha = -Infinity;
      const beta = Infinity;

      // Re-rank each iteration; put previous best first (move ordering)
      let ordered = rankCandidates(board, color, cfg.branch, cfg.radius, 0.95);
      if (bestMove) {
        ordered = [
          ...ordered.filter((m) => m.r === bestMove[0] && m.c === bestMove[1]),
          ...ordered.filter((m) => !(m.r === bestMove[0] && m.c === bestMove[1])),
        ];
      }

      for (const { r, c, s } of ordered) {
        if (timedOut && iterBest) break;
        board[r][c] = color;
        if (checkWin(board, r, c, color)) {
          board[r][c] = null;
          return [r, c];
        }
        // After our move, opponent to move → negate their score
        let val = -negamax(
          board,
          d - 1,
          -beta,
          -alpha,
          opponent(color),
          Math.max(6, cfg.branch - 1),
          cfg.radius,
          r,
          c
        );
        // Tiny static blend stabilizes shallow iterations / move ties
        val += s * 0.00001;
        board[r][c] = null;

        if (val > iterScore) {
          iterScore = val;
          iterBest = [r, c];
        }
        if (val > alpha) alpha = val;
      }

      if (iterBest && !timedOut) {
        bestMove = iterBest;
        bestScore = iterScore;
      } else if (iterBest && timedOut && d === startDepth) {
        bestMove = iterBest;
      }
      // If we timed out mid-iteration, keep previous completed depth's move
      if (timedOut) break;
    }

    return bestMove || [7, 7];
  }

  function resolveLevel(difficulty) {
    if (difficulty === 'easy') return LEVEL.easy;
    if (difficulty === 'hard') return LEVEL.hard;
    return LEVEL.normal;
  }

  /**
   * Easy path: weak greedy play with deliberate blunders.
   * Still takes instant wins and usually blocks instant losses.
   */
  function getEasyMove(board, color, cfg) {
    // Take win always
    const win = findWinMove(board, color);
    if (win) return win;

    // Block opponent five — almost always (very rare miss would feel broken)
    const opp = opponent(color);
    const mustBlock = findWinMove(board, opp);
    if (mustBlock) return mustBlock;

    // Sometimes ignore closed-four / open-three threats from opponent
    const oppFours = findThreatMoves(board, opp, ['openFour', 'closedFour']);
    const oppThrees = findThreatMoves(board, opp, ['openThree']);

    const shouldMissFour = Math.random() < cfg.missClosedFourChance;
    const shouldMissThree = Math.random() < cfg.missOpenThreeChance;

    // Open four is nearly forced — only miss closed fours occasionally
    const openFourBlock = oppFours.find((m) => m[2] === 'openFour');
    if (openFourBlock) return [openFourBlock[0], openFourBlock[1]];

    if (oppFours.length && !shouldMissFour) {
      return [oppFours[0][0], oppFours[0][1]];
    }
    if (oppThrees.length && !shouldMissThree) {
      return [oppThrees[0][0], oppThrees[0][1]];
    }

    // Pure random nearby move
    if (Math.random() < cfg.randomMoveChance) {
      const cand = getCandidates(board, cfg.radius);
      return cand[Math.floor(Math.random() * cand.length)];
    }

    // Greedy 1-ply among top-N (noisy)
    const ranked = rankCandidates(board, color, cfg.branch, cfg.radius, 0.7);
    if (!ranked.length) return [7, 7];
    const n = Math.min(cfg.pickFromTop, ranked.length);
    const pick = ranked[Math.floor(Math.random() * n)];
    return [pick.r, pick.c];
  }

  /**
   * Main entry: pick a move for `color` at the given difficulty.
   * difficulty: 'easy' | 'normal' | 'hard' (also accepts 'medium' → normal)
   */
  function getMove(board, color, difficulty = 'normal') {
    const key = difficulty === 'medium' ? 'normal' : difficulty;
    const cfg = resolveLevel(key);

    // Work on a clone so caller's board is never corrupted if we throw
    const b = cloneBoard(board);

    if (key === 'easy') {
      return getEasyMove(b, color, cfg);
    }

    if (key === 'normal') {
      // Fixed mid depth — distinct from hard's deeper ID search
      return searchBest(b, color, cfg, cfg.depth);
    }

    // hard: iterative deepening up to depth 8 / time budget
    return searchBest(b, color, cfg, null);
  }

  /**
   * Async wrapper so the UI can paint "AI 생각 중..." before heavy search.
   * Yields to the event loop once, then runs getMove.
   */
  function getMoveAsync(board, color, difficulty = 'normal') {
    return new Promise((resolve) => {
      setTimeout(() => {
        try {
          resolve(getMove(board, color, difficulty));
        } catch (err) {
          console.error('OmokAI error', err);
          // Safe fallback: center-ish empty cell
          const b = board;
          for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
              if (!b[r][c]) {
                resolve([r, c]);
                return;
              }
            }
          }
          resolve([7, 7]);
        }
      }, 0);
    });
  }

  return {
    createBoard,
    checkWin,
    getMove,
    getMoveAsync,
    SIZE,
    // Exposed for debugging / tests
    _evaluateMove: evaluateMove,
    _LEVEL: LEVEL,
  };
})();
