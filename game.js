(function () {
  'use strict';

  /* =========================================================================
   * Configuration
   * ======================================================================= */

  const STAGE_W = 840;                 // design width + breathing room, used for scale-to-fit
  const STAGE_H = 640;
  const MOBILE_QUERY = '(max-width:700px)';
  const BOARD_PADDING = 16;            // must match #board padding in styles.css

  // A standard round is 8 pairs / 16 tiles — a gentle 4x4 board. The long-list
  // (hard) option doubles it to 16 pairs / 32 tiles.
  const BASE_PAIR_COUNT = 8;
  const LONG_LIST_MULTIPLIER = 2;
  const TEST_PAIR_COUNT = 2;           // shift+Start: 4 blocks, for testing
  const SET_SIZE = 2;                  // tiles added per pair
  const MAX_SCORES = 10;

  const STORAGE_KEYS = {
    sound: 'matchColoursSound',
    settings: 'matchColoursSettings',
    scores: 'matchColoursScores'
  };

  const GRID_GAP = 6;                  // small, uniform gutter between swatches

  /* =========================================================================
   * Utilities
   * ======================================================================= */

  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** localStorage wrapper — private mode and quota errors degrade to defaults. */
  const storage = {
    read(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    write(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        /* storage unavailable — the game stays fully playable without it */
      }
    }
  };

  /* =========================================================================
   * Palette
   *
   * A fixed, hand-picked set rather than a generated one. Its closest pair
   * (#C5E3A0 / #FBE392) sits at OKLab dE 0.072, so the hardest discrimination
   * the board can ask for is a fair one; the median pair is dE 0.24.
   *
   * Note every colour here would vanish as a board background, so the board is
   * held at a neutral white that is deliberately not one of them.
   * ======================================================================= */

  const PALETTE = [
    '#5EABD6', '#3B7DA3', '#94D3EC', '#43927B', '#88C999',
    '#C5E3A0', '#FEFBC7', '#FBE392', '#F2C48D', '#FF9666',
    '#FFB4B4', '#B8336A', '#E14434', '#B22E22', '#DDA0DD',
    '#8B5E83', '#D1D9E0', '#C68B59', '#8C7A6B', '#2F3E46'
  ];

  // Vivid subset of the palette for confetti — drops the palest tones that
  // would vanish against the white board.
  const CONFETTI = [
    '#5EABD6', '#3B7DA3', '#43927B', '#88C999', '#FBE392',
    '#F2C48D', '#FF9666', '#FFB4B4', '#B8336A', '#E14434',
    '#DDA0DD', '#8B5E83', '#C68B59'
  ];

  /** Flat multiply toward black — keeps the hue, used so a burst stays visible
   *  even for the palest tiles (#FEFBC7, #D1D9E0) against the white board. */
  function darken(hex, factor) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.round(((n >> 16) & 255) * factor);
    const g = Math.round(((n >> 8) & 255) * factor);
    const b = Math.round((n & 255) * factor);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  /* =========================================================================
   * Audio — synthesized via Web Audio, no external assets
   * ======================================================================= */

  const sound = (function () {
    let ctx = null;
    let enabled = storage.read(STORAGE_KEYS.sound, true) !== false;

    function context() {
      if (!ctx) {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (AudioCtor) ctx = new AudioCtor();
      }
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    function tone(freq, startOffset, duration, type, peak) {
      const ac = context();
      if (!ac) return;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const at = ac.currentTime + startOffset;
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, at);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(peak, at + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(at);
      osc.stop(at + duration + 0.02);
    }

    function chord(freqs, step, duration, type, peak) {
      freqs.forEach((f, i) => tone(f, i * step, duration, type, peak));
    }

    return {
      unlock: context,
      get enabled() { return enabled; },
      toggle() {
        enabled = !enabled;
        storage.write(STORAGE_KEYS.sound, enabled);
        if (enabled) { context(); this.click(); }
        return enabled;
      },
      click() { if (enabled) tone(720, 0, 0.07, 'square', 0.05); },
      move() { if (enabled) tone(520, 0, 0.09, 'square', 0.045); },
      split() { if (enabled) { tone(660, 0, 0.06, 'triangle', 0.05); tone(990, 0.05, 0.1, 'triangle', 0.045); } },
      match() { if (enabled) chord([660, 880, 1100, 1320], 0.06, 0.32, 'triangle', 0.045); },
      finish() { if (enabled) chord([523.25, 659.25, 783.99, 1046.5], 0.09, 0.4, 'triangle', 0.05); }
    };
  }());

  /* =========================================================================
   * DOM references
   * ======================================================================= */

  const el = {
    app: document.getElementById('app'),
    titleScreen: document.getElementById('titleScreen'),
    gameScreen: document.getElementById('gameScreen'),
    board: document.getElementById('board'),
    overlay: document.getElementById('overlay'),
    finalTime: document.getElementById('finalTime'),
    scoreList: document.getElementById('scoreList'),
    playClock: document.getElementById('playClock'),
    playClockValue: document.getElementById('playClockValue'),
    hardModeDropdown: document.getElementById('hardModeDropdown'),
    hardModeToggle: document.getElementById('hardModeToggle'),
    hardModePanel: document.getElementById('hardModePanel'),
    hardModeLabel: document.getElementById('hardModeLabel'),
    optLongList: document.getElementById('optLongList'),
    soundToggle: document.getElementById('soundToggle'),
    soundIconOn: document.getElementById('soundIconOn'),
    soundIconOff: document.getElementById('soundIconOff'),
    soundLabel: document.getElementById('soundLabel'),
    startBtn: document.getElementById('startBtn'),
    backBtn: document.getElementById('backBtn'),
    rulesScreen: document.getElementById('rulesScreen'),
    rulesInner: document.querySelector('#rulesScreen .rules-inner'),
    rulesLink: document.getElementById('rulesLink'),
    rulesBackBtn: document.getElementById('rulesBackBtn'),
    rulesStartBtn: document.getElementById('rulesStartBtn')
  };

  /* =========================================================================
   * Responsive stage scaling
   * ======================================================================= */

  const mobile = window.matchMedia(MOBILE_QUERY);

  function fitStage() {
    if (mobile.matches) {
      el.app.style.transform = 'none';
      return;
    }
    const scale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H, 1);
    el.app.style.transform = 'scale(' + scale + ')';
  }

  window.addEventListener('resize', fitStage);
  window.addEventListener('orientationchange', () => setTimeout(fitStage, 50));
  fitStage();

  /* =========================================================================
   * Settings (hard mode)
   * ======================================================================= */

  const settings = {
    longList: false
  };

  function persistSettings() {
    storage.write(STORAGE_KEYS.settings, {
      longList: settings.longList
    });
  }

  function syncHardModeUI() {
    el.optLongList.checked = settings.longList;

    const active = settings.longList;
    el.hardModeToggle.classList.toggle('active', active);
    el.hardModeLabel.textContent = active ? 'Hard mode: On' : 'Hard mode';
  }

  function restoreSettings() {
    const saved = storage.read(STORAGE_KEYS.settings, null);
    if (saved) {
      settings.longList = !!saved.longList;
    }
    syncHardModeUI();
  }

  el.optLongList.addEventListener('change', () => {
    settings.longList = el.optLongList.checked;
    syncHardModeUI();
    persistSettings();
  });

  el.hardModeToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = el.hardModePanel.classList.toggle('open');
    el.hardModeToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  document.addEventListener('click', (e) => {
    if (el.hardModeDropdown.contains(e.target)) return;
    el.hardModePanel.classList.remove('open');
    el.hardModeToggle.setAttribute('aria-expanded', 'false');
  });

  function syncSoundUI() {
    el.soundIconOn.style.display = sound.enabled ? '' : 'none';
    el.soundIconOff.style.display = sound.enabled ? 'none' : '';
    el.soundLabel.textContent = sound.enabled ? 'On' : 'Off';
  }

  el.soundToggle.addEventListener('click', () => {
    sound.toggle();
    syncSoundUI();
  });

  restoreSettings();
  syncSoundUI();

  /* =========================================================================
   * Match effect
   * ======================================================================= */

  // A celebratory confetti burst: lively count, mixed sizes, a spin, and a
  // multicoloured spray drawn from the vivid palette subset, centred on a point
  // within a container.
  function burstAt(container, cx, cy, count, spread) {
    const reach = spread || 54;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
      const distance = 44 + Math.random() * reach;
      const size = 8 + Math.random() * 6;
      p.className = 'particle';
      p.style.setProperty('--px', (Math.cos(angle) * distance).toFixed(1) + 'px');
      p.style.setProperty('--py', (Math.sin(angle) * distance).toFixed(1) + 'px');
      p.style.setProperty('--rot', Math.round(Math.random() * 300 - 150) + 'deg');
      p.style.width = p.style.height = size.toFixed(1) + 'px';
      p.style.left = cx + 'px';
      p.style.top = cy + 'px';
      p.style.background = CONFETTI[Math.floor(Math.random() * CONFETTI.length)];
      container.appendChild(p);
      p.addEventListener('animationend', () => p.remove());
    }
  }

  function burstParticles(swatch) {
    const boardRect = el.board.getBoundingClientRect();
    const rect = swatch.getBoundingClientRect();
    burstAt(el.board, rect.left - boardRect.left + rect.width / 2,
            rect.top - boardRect.top + rect.height / 2, 22);
  }

  // Win celebration: multicoloured confetti raining down the given container
  // (the finish overlay). It falls only in the side gaps either side of the
  // centred content — with drift biased outward — so the message stays clear.
  function launchConfetti(container, count) {
    const w = container.clientWidth || STAGE_W;
    const h = container.clientHeight || STAGE_H;
    count = count || 46;
    const center = w / 2;
    const inner = 150;                    // half-width of the clear content column
    const bandW = 210;                    // confetti band width, hugging each side

    for (let i = 0; i < count; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      const size = 7 + Math.random() * 5;
      const left = Math.random() < 0.5;
      const t = Math.random() * bandW;    // band sits just outside the content
      const x = left ? (center - inner - bandW + t) : (center + inner + t);
      c.style.left = Math.round(Math.max(0, Math.min(w, x))) + 'px';
      c.style.width = size.toFixed(1) + 'px';
      c.style.height = (Math.random() < 0.4 ? size : size * 1.6).toFixed(1) + 'px';
      if (Math.random() < 0.4) c.style.borderRadius = '50%';
      // drift outward (away from the centre) so pieces never wander into the text
      c.style.setProperty('--dx', (left ? Math.round(-30 - Math.random() * 60)
                                        : Math.round(30 + Math.random() * 60)) + 'px');
      c.style.setProperty('--fall', Math.round(h + 60) + 'px');
      c.style.setProperty('--spin', Math.round(Math.random() * 800 - 400) + 'deg');
      c.style.setProperty('--dur', (1.5 + Math.random() * 1.4).toFixed(2) + 's');
      c.style.setProperty('--delay', (Math.random() * 0.6).toFixed(2) + 's');
      c.style.background = CONFETTI[Math.floor(Math.random() * CONFETTI.length)];
      container.appendChild(c);
      c.addEventListener('animationend', () => c.remove());
    }
  }

  // The full finish flourish: a starburst out of the badge, a big opening
  // burst, then a steady emitter that keeps the shower going for a good while.
  // Pieces self-remove (~1.5-2.9s each), so a low, spaced-out spawn rate keeps
  // the live node count small however long the shower runs.
  let confettiTimer = null;
  function celebrateWin() {
    launchConfetti(el.overlay, 26);          // opening wave (down the sides)

    const DURATION = 3200;                   // keep raining for ~3.2s
    const EVERY = 400;                        // a small wave this often
    const startedAt = Date.now();
    clearInterval(confettiTimer);
    confettiTimer = setInterval(() => {
      // Stop when the shower's run its course, or the overlay was dismissed.
      if (!el.overlay.classList.contains('show') || Date.now() - startedAt > DURATION) {
        clearInterval(confettiTimer);
        confettiTimer = null;
        return;
      }
      launchConfetti(el.overlay, 10);
    }, EVERY);
  }

  // Gentle elapsed-time indicator — whole seconds, no sound: a quiet hint that
  // the run is timed, never a pressuring stopwatch.
  let playClockTimer = null;
  function tickPlayClock() {
    const s = Math.floor((Date.now() - round.startedAt) / 1000);
    el.playClockValue.textContent = s + 's';
  }
  function startPlayClock() {
    stopPlayClock();
    el.playClock.style.display = 'flex';
    tickPlayClock();
    playClockTimer = setInterval(tickPlayClock, 250);
  }
  function stopPlayClock() {
    if (playClockTimer) { clearInterval(playClockTimer); playClockTimer = null; }
  }

  /* =========================================================================
   * Scores
   * ======================================================================= */

  function loadScores() {
    const scores = storage.read(STORAGE_KEYS.scores, []);
    return Array.isArray(scores) ? scores : [];
  }

  function saveScore(seconds) {
    const scores = loadScores();
    scores.push({ time: seconds, date: new Date().toLocaleDateString() });
    scores.sort((a, b) => a.time - b.time);
    storage.write(STORAGE_KEYS.scores, scores.slice(0, MAX_SCORES));
  }

  function renderScores() {
    el.scoreList.innerHTML = '';
    loadScores().forEach((score, i) => {
      const li = document.createElement('li');
      const rank = document.createElement('span');
      const time = document.createElement('span');
      const date = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = i + 1;
      time.className = 't';
      time.textContent = score.time.toFixed(2) + 's';
      date.className = 'd';
      date.textContent = score.date;
      li.append(rank, time, date);
      el.scoreList.appendChild(li);
    });
  }

  /* =========================================================================
   * Round state
   *
   * The board is a full cols x rows grid (tile count always factorizes — it
   * is even) and stays full for the whole round; blocks are never removed.
   *
   * Connections are explicit bonds rather than derived adjacency: a bond
   * forms the moment a move brings two same-colour blocks newly side by
   * side, and only the split button breaks it. This distinction is what lets
   * a freshly split pair sit adjacent without instantly re-fusing.
   *
   * All movement is a band rotation: a lone block rotates its own row or
   * column, and a two-block piece may also rotate the two rows (or columns)
   * it spans together, carrying the piece sideways. A move is legal only if
   * no bond crosses the band's edge, which is also what makes bonded pieces
   * blockers for every line they cross perpendicularly.
   * ======================================================================= */

  const round = {
    active: false,
    cols: 0,
    rows: 0,
    grid: [],            // grid[r][c] -> block
    blocks: [],
    selected: null,      // block whose destinations are currently highlighted
    hinted: [],          // blocks carrying the .hint outline
    colourTotal: {},     // colorId -> copies on this board (the join target)
    done: new Set(),     // colorIds currently joined into one group
    totalColours: 0,
    cellSize: 0,
    originX: 0,
    originY: 0,
    startedAt: 0
  };

  /**
   * Shuffling the palette first means a round shorter than the palette draws a
   * random subset rather than always the same leading colours, and a round
   * longer than it reuses colours evenly.
   */
  function buildTiles(pairCount) {
    const order = shuffle(PALETTE.map((hex, id) => ({ hex, id })));
    const tiles = [];
    for (let pair = 0; pair < pairCount; pair++) {
      const colour = order[pair % order.length];
      for (let copy = 0; copy < SET_SIZE; copy++) tiles.push(colour);
    }
    return shuffle(tiles);
  }

  /**
   * Cyclic row/column moves need a full rectangle, so unlike a free grid the
   * column count must divide the tile count exactly; among those, pick the
   * split whose uniform square is largest for the current board.
   */
  function pickGridDims(count, width, height, gap) {
    let best = { cols: count, rows: 1, size: 0 };
    for (let cols = 1; cols <= count; cols++) {
      if (count % cols !== 0) continue;
      const rows = count / cols;
      const size = Math.min(
        (width - gap * (cols - 1)) / cols,
        (height - gap * (rows - 1)) / rows
      );
      if (size > best.size) best = { cols, rows, size };
    }
    return best;
  }

  function countAdjacencyConflicts(tiles, cols) {
    let n = 0;
    for (let i = 0; i < tiles.length; i++) {
      const c = i % cols;
      if (c + 1 < cols && tiles[i].id === tiles[i + 1].id) n++;
      if (i + cols < tiles.length && tiles[i].id === tiles[i + cols].id) n++;
    }
    return n;
  }

  /**
   * Same-colour neighbours bond the moment they touch, so the opening board
   * must not hand any connection out for free. Hill-climb on random swaps
   * until no two same-colour tiles are orthogonal neighbours; the cap is a
   * safety net, in practice it converges in a few hundred swaps even on the
   * 3x board.
   */
  function arrangeTiles(tiles, cols) {
    let conflicts = countAdjacencyConflicts(tiles, cols);
    for (let tries = 0; tries < 6000 && conflicts > 0; tries++) {
      const i = randInt(0, tiles.length - 1);
      const j = randInt(0, tiles.length - 1);
      if (i === j) continue;
      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
      const next = countAdjacencyConflicts(tiles, cols);
      if (next <= conflicts) conflicts = next;
      else [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
    }
    return tiles;
  }

  /* =========================================================================
   * Grid queries
   * ======================================================================= */

  function blockAt(r, c) {
    return (r >= 0 && r < round.rows && c >= 0 && c < round.cols) ? round.grid[r][c] : null;
  }

  function bondedAt(block, r, c) {
    const other = blockAt(r, c);
    return !!other && block.bonds.has(other);
  }

  /** The piece the block belongs to: its connected component in the bond
   *  graph. Bonds only ever link same-colour neighbours, so a piece is
   *  always monochrome. */
  function groupOf(block) {
    const group = [block];
    const seen = new Set([block]);
    for (let i = 0; i < group.length; i++) {
      group[i].bonds.forEach(p => {
        if (!seen.has(p)) {
          seen.add(p);
          group.push(p);
        }
      });
    }
    return group;
  }

  /* =========================================================================
   * Movement legality
   *
   * A horizontal move rotates every row the moving piece spans; vertical
   * moves mirror this with columns. The band is legal when:
   *   - the piece is a single block or a two-block piece (bigger pieces can
   *     only move if they fit inside one line), and
   *   - no bond anywhere in the band crosses the band's edge — a torn bond
   *     is never allowed, which is what turns every piece into a blocker
   *     for the perpendicular lines it crosses.
   * On top of that, a specific destination is rejected if it would park a
   * bonded pair straddling the wrap seam, where the pair would no longer be
   * truly adjacent.
   * ======================================================================= */

  /** Band info for a horizontal move: `rows` is the rotatable band (or null),
   *  and when a bonded piece crossing the band is what forbids the move, its
   *  offending blocks are reported in `blockers` so they can protest. */
  function rowBand(group) {
    const rows = [...new Set(group.map(b => b.r))];
    if (rows.length > 1 && group.length !== 2) return { rows: null, blockers: [] };
    const inBand = new Set(rows);
    const blockers = new Set();
    for (const r of rows) {
      for (let c = 0; c < round.cols; c++) {
        const b = round.grid[r][c];
        for (const p of b.bonds) {
          if (!inBand.has(p.r)) { blockers.add(b); blockers.add(p); }
        }
      }
    }
    return blockers.size ? { rows: null, blockers: [...blockers] } : { rows, blockers: [] };
  }

  function columnBand(group) {
    const cols = [...new Set(group.map(b => b.c))];
    if (cols.length > 1 && group.length !== 2) return { cols: null, blockers: [] };
    const inBand = new Set(cols);
    const blockers = new Set();
    for (const c of cols) {
      for (let r = 0; r < round.rows; r++) {
        const b = round.grid[r][c];
        for (const p of b.bonds) {
          if (!inBand.has(p.c)) { blockers.add(b); blockers.add(p); }
        }
      }
    }
    return blockers.size ? { cols: null, blockers: [...blockers] } : { cols, blockers: [] };
  }

  function rowShiftStraddlesSeam(rows, delta) {
    const cols = round.cols;
    if (cols <= 2) return false;       // on a 2-wide board every cell pair stays adjacent
    for (const r of rows) {
      for (let c = 0; c < cols - 1; c++) {
        if (round.grid[r][c].bonds.has(round.grid[r][c + 1]) &&
            (((c + 1 + delta) % cols) + cols) % cols === 0) return true;
      }
    }
    return false;
  }

  function columnShiftStraddlesSeam(cols, delta) {
    const rows = round.rows;
    if (rows <= 2) return false;
    for (const c of cols) {
      for (let r = 0; r < rows - 1; r++) {
        if (round.grid[r][c].bonds.has(round.grid[r + 1][c]) &&
            (((r + 1 + delta) % rows) + rows) % rows === 0) return true;
      }
    }
    return false;
  }

  // The bonded pair(s) a given shift would carry across the wrap seam — the
  // reason such a move is refused. Mirrors the straddle checks above so the
  // shake lands on exactly the blocks that forbid the slide.
  function rowStraddleBlockers(rows, delta) {
    const cols = round.cols;
    const out = [];
    if (cols <= 2) return out;
    for (const r of rows) {
      for (let c = 0; c < cols - 1; c++) {
        if (round.grid[r][c].bonds.has(round.grid[r][c + 1]) &&
            (((c + 1 + delta) % cols) + cols) % cols === 0) {
          out.push(round.grid[r][c], round.grid[r][c + 1]);
        }
      }
    }
    return out;
  }

  function columnStraddleBlockers(cols, delta) {
    const rows = round.rows;
    const out = [];
    if (rows <= 2) return out;
    for (const c of cols) {
      for (let r = 0; r < rows - 1; r++) {
        if (round.grid[r][c].bonds.has(round.grid[r + 1][c]) &&
            (((r + 1 + delta) % rows) + rows) % rows === 0) {
          out.push(round.grid[r][c], round.grid[r + 1][c]);
        }
      }
    }
    return out;
  }

  /* =========================================================================
   * Selection & movement
   * ======================================================================= */

  const splitBtn = document.createElement('button');
  splitBtn.id = 'splitBtn';
  splitBtn.type = 'button';
  splitBtn.title = 'Split';
  splitBtn.setAttribute('aria-label', 'Split');
  splitBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle>' +
    '<line x1="20" y1="4" x2="8.12" y2="15.88"></line>' +
    '<line x1="14.47" y1="14.48" x2="20" y2="20"></line>' +
    '<line x1="8.12" y1="8.12" x2="12" y2="12"></line></svg>';
  splitBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    splitSelected();
  });

  // A soft lane behind the selected block's whole row and column, marking the
  // directions it can slide. Shown instead of per-destination block outlines;
  // both sit behind the swatches (added to the board before them each round).
  const rowBandEl = document.createElement('div');
  rowBandEl.className = 'move-band';
  const colBandEl = document.createElement('div');
  colBandEl.className = 'move-band';

  function hideMoveBands() {
    rowBandEl.style.display = 'none';
    colBandEl.style.display = 'none';
  }

  function showMoveBand(node, isRow, indices) {
    const size = round.cellSize;
    const step = size + GRID_GAP;
    const gridW = round.cols * size + GRID_GAP * (round.cols - 1);
    const gridH = round.rows * size + GRID_GAP * (round.rows - 1);
    const PAD = 4;
    const lo = Math.min(...indices), hi = Math.max(...indices);
    if (isRow) {
      node.style.left = Math.round(round.originX - PAD) + 'px';
      node.style.top = Math.round(round.originY + lo * step - PAD) + 'px';
      node.style.width = Math.round(gridW + PAD * 2) + 'px';
      node.style.height = Math.round((hi - lo) * step + size + PAD * 2) + 'px';
    } else {
      node.style.left = Math.round(round.originX + lo * step - PAD) + 'px';
      node.style.top = Math.round(round.originY - PAD) + 'px';
      node.style.width = Math.round((hi - lo) * step + size + PAD * 2) + 'px';
      node.style.height = Math.round(gridH + PAD * 2) + 'px';
    }
    node.style.display = 'block';
  }

  let seamNodes = [];
  let outlineNodes = [];
  let raisedNodes = [];

  function hideSplitControls() {
    splitBtn.style.display = 'none';
    seamNodes.forEach(n => n.remove());
    seamNodes = [];
  }

  function hidePieceOutline() {
    outlineNodes.forEach(n => n.remove());
    outlineNodes = [];
  }

  // Lift the selected piece above the other swatches so a neighbouring
  // block's hint outline can't bleed over it or its split seam.
  function raisePiece(group) {
    lowerPiece();
    group.forEach(b => b.node.classList.add('raised'));
    raisedNodes = group.map(b => b.node);
  }

  function lowerPiece() {
    raisedNodes.forEach(n => n.classList.remove('raised'));
    raisedNodes = [];
  }

  /**
   * Selecting a bonded piece outlines the piece as a whole, not the tapped
   * block: one bar per exposed edge, extended past exposed corners so the
   * bars meet, tracing the silhouette of the fused shape.
   */
  function showPieceOutline(group) {
    const size = round.cellSize;
    const step = size + GRID_GAP;
    const off = 2;                     // matches the .selected outline-offset
    const t = 3;                       // matches the .selected outline width

    group.forEach(b => {
      const up = bondedAt(b, b.r - 1, b.c);
      const down = bondedAt(b, b.r + 1, b.c);
      const left = bondedAt(b, b.r, b.c - 1);
      const right = bondedAt(b, b.r, b.c + 1);
      const x = round.originX + b.c * step;
      const y = round.originY + b.r * step;
      const w = size + (right ? GRID_GAP : 0);
      const h = size + (down ? GRID_GAP : 0);

      const bars = [];
      if (!up) bars.push([x - (left ? 0 : off + t), y - off - t,
                          w + (left ? 0 : off + t) + (right ? 0 : off + t), t]);
      if (!down) bars.push([x - (left ? 0 : off + t), y + h + off,
                            w + (left ? 0 : off + t) + (right ? 0 : off + t), t]);
      if (!left) bars.push([x - off - t, y - (up ? 0 : off + t),
                            t, h + (up ? 0 : off + t) + (down ? 0 : off + t)]);
      if (!right) bars.push([x + w + off, y - (up ? 0 : off + t),
                             t, h + (up ? 0 : off + t) + (down ? 0 : off + t)]);

      bars.forEach(([bx, by, bw, bh]) => {
        const bar = document.createElement('div');
        bar.className = 'piece-outline';
        bar.style.left = Math.round(bx) + 'px';
        bar.style.top = Math.round(by) + 'px';
        bar.style.width = Math.round(bw) + 'px';
        bar.style.height = Math.round(bh) + 'px';
        el.board.appendChild(bar);
        outlineNodes.push(bar);
      });
    });
  }

  /**
   * Mark where the piece would come apart: a dotted line over every bond
   * seam (drawn in the block's own darkened tone so it reads on any fill),
   * with the scissors floating at the centre of the piece — for a two-block
   * piece that is exactly the middle of the shared edge.
   */
  function showSplitControls(group) {
    const size = round.cellSize;
    const step = size + GRID_GAP;

    group.forEach(b => {
      b.bonds.forEach(p => {
        const seam = document.createElement('div');
        seam.className = 'seam';
        if (p.c === b.c + 1) {                       // vertical seam, right edge
          seam.classList.add('seam-v');
          seam.style.left = Math.round(round.originX + p.c * step - GRID_GAP / 2) + 'px';
          seam.style.top = Math.round(round.originY + b.r * step) + 'px';
          seam.style.height = size + 'px';
        } else if (p.r === b.r + 1) {                // horizontal seam, bottom edge
          seam.classList.add('seam-h');
          seam.style.left = Math.round(round.originX + b.c * step) + 'px';
          seam.style.top = Math.round(round.originY + p.r * step - GRID_GAP / 2) + 'px';
          seam.style.width = size + 'px';
        } else {
          return;                                    // the partner owns this seam
        }
        seam.style.color = b.particle;
        el.board.appendChild(seam);
        seamNodes.push(seam);
      });
    });

    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    group.forEach(b => {
      minR = Math.min(minR, b.r); maxR = Math.max(maxR, b.r);
      minC = Math.min(minC, b.c); maxC = Math.max(maxC, b.c);
    });
    splitBtn.style.display = 'flex';
    splitBtn.style.left = Math.round(round.originX + ((minC + maxC) / 2) * step + size / 2) + 'px';
    splitBtn.style.top = Math.round(round.originY + ((minR + maxR) / 2) * step + size / 2) + 'px';
  }

  function clearSelection() {
    if (round.selected) round.selected.node.classList.remove('selected');
    round.selected = null;
    round.hinted.forEach(b => b.node.classList.remove('hint'));
    round.hinted = [];
    hideMoveBands();
    hideSplitControls();
    hidePieceOutline();
    lowerPiece();
  }

  function select(block) {
    clearSelection();
    round.selected = block;

    const group = groupOf(block);
    if (group.length === 1) {
      block.node.classList.add('selected');
    } else {
      raisePiece(group);               // lift the piece over neighbouring hint outlines
      showPieceOutline(group);         // the whole piece is selected, not one block
    }

    const horizontal = rowBand(group);
    const vertical = columnBand(group);

    // Light up the whole movable row / column rather than each destination.
    if (horizontal.rows) showMoveBand(rowBandEl, true, horizontal.rows);
    if (vertical.cols) showMoveBand(colBandEl, false, vertical.cols);

    round.blocks.forEach(b => {
      if (b === block) return;
      const viaRow = horizontal.rows && b.r === block.r &&
                     !rowShiftStraddlesSeam(horizontal.rows, b.c - block.c);
      const viaCol = vertical.cols && b.c === block.c &&
                     !columnShiftStraddlesSeam(vertical.cols, b.r - block.r);
      if (viaRow || viaCol) {
        b.node.classList.add('hint');
        round.hinted.push(b);
      }
    });

    if (group.length > 1) showSplitControls(group);

    // Nowhere to go: the bonded pieces standing in the way protest with a
    // little shake (silent), each along the axis it is blocking.
    if (round.hinted.length === 0) {
      const shaken = new Set();
      horizontal.blockers.forEach(b => groupOf(b).forEach(m => {
        if (!shaken.has(m)) { shaken.add(m); flashShake(m.node, 'shake-x'); }
      }));
      vertical.blockers.forEach(b => groupOf(b).forEach(m => {
        if (!shaken.has(m)) { shaken.add(m); flashShake(m.node, 'shake-y'); }
      }));
    }
  }

  function flashShake(node, cls) {
    node.classList.remove('shake-x', 'shake-y');
    void node.offsetWidth;             // reflow so a repeat tap re-triggers the animation
    node.classList.add(cls);
    node.addEventListener('animationend', () => node.classList.remove(cls), { once: true });
  }

  /** Break every bond in the selected piece; the blocks stay where they are
   *  but move independently again. Adjacent-but-split same-colour blocks do
   *  not re-bond until a move separates and rejoins them. */
  function splitSelected() {
    if (!round.active || !round.selected) return;
    const block = round.selected;
    groupOf(block).forEach(b => b.bonds.clear());
    sound.split();
    round.done = completedColours();  // the split colour is no longer joined
    positionAll();
    select(block);                     // re-derive hints for the lone block
  }

  function onBlockClick(block, event) {
    if (!round.active) return;
    event.stopPropagation();          // keep the board's deselect handler out

    if (round.selected === block) {   // tapping the selection clears it
      sound.click();
      clearSelection();
      return;
    }

    if (round.selected && block.node.classList.contains('hint')) {
      moveTo(round.selected, block);
      return;
    }

    // A tap inside the highlighted row/column that isn't a legal landing means
    // the slide would carry a connected pair past the edge (and it can't split
    // itself to allow it). Keep the selection and shake the offending pair so
    // it's clear why the move is refused — rather than re-highlighting a line.
    if (round.selected) {
      const inRowBand = rowBandEl.style.display !== 'none' && block.r === round.selected.r;
      const inColBand = colBandEl.style.display !== 'none' && block.c === round.selected.c;
      if (inRowBand || inColBand) {
        const group = groupOf(round.selected);
        const blockers = inRowBand
          ? rowStraddleBlockers(rowBand(group).rows || [], block.c - round.selected.c)
          : columnStraddleBlockers(columnBand(group).cols || [], block.r - round.selected.r);
        const cls = inRowBand ? 'shake-x' : 'shake-y';
        const shaken = new Set();
        blockers.forEach(b => groupOf(b).forEach(m => {
          if (!shaken.has(m)) { shaken.add(m); flashShake(m.node, cls); }
        }));
        return;
      }
    }

    sound.click();
    select(block);                    // otherwise the tap moves the selection
  }

  /** Rotate the band so `sel` lands exactly on `dest`'s cell; everything in
   *  the band shifts one step and the edge wraps around. */
  function moveTo(sel, dest) {
    const group = groupOf(sel);
    const before = sameColourAdjacencies();

    if (dest.r === sel.r) {
      const band = rowBand(group).rows;
      if (!band) { clearSelection(); return; }
      band.forEach(r => rotateRow(r, dest.c - sel.c));
    } else {
      const band = columnBand(group).cols;
      if (!band) { clearSelection(); return; }
      band.forEach(c => rotateColumn(c, dest.r - sel.r));
    }

    bondNewAdjacencies(before);
    clearSelection();
    sound.move();
    refreshBoard();
  }

  function rotateRow(r, delta) {
    const cols = round.cols;
    const row = round.grid[r];
    const next = new Array(cols);
    for (let c = 0; c < cols; c++) {
      const target = ((c + delta) % cols + cols) % cols;
      next[target] = row[c];
      row[c].c = target;
    }
    round.grid[r] = next;
  }

  function rotateColumn(c, delta) {
    const rows = round.rows;
    const column = round.grid.map(row => row[c]);
    for (let r = 0; r < rows; r++) {
      const target = ((r + delta) % rows + rows) % rows;
      round.grid[target][c] = column[r];
      column[r].r = target;
    }
  }

  /* =========================================================================
   * Bonds
   * ======================================================================= */

  function pairKey(a, b) {
    return a.id < b.id ? a.id + ':' + b.id : b.id + ':' + a.id;
  }

  /** Keys of every same-colour orthogonally adjacent pair, bonded or not. */
  function sameColourAdjacencies() {
    const keys = new Set();
    for (let r = 0; r < round.rows; r++) {
      for (let c = 0; c < round.cols; c++) {
        const b = round.grid[r][c];
        const right = c + 1 < round.cols ? round.grid[r][c + 1] : null;
        const down = r + 1 < round.rows ? round.grid[r + 1][c] : null;
        if (right && right.colorId === b.colorId) keys.add(pairKey(b, right));
        if (down && down.colorId === b.colorId) keys.add(pairKey(b, down));
      }
    }
    return keys;
  }

  /** Bond exactly the pairs the move newly created. Pairs that were already
   *  adjacent before it (like a freshly split piece) stay unbonded. */
  function bondNewAdjacencies(before) {
    for (let r = 0; r < round.rows; r++) {
      for (let c = 0; c < round.cols; c++) {
        const b = round.grid[r][c];
        [c + 1 < round.cols ? round.grid[r][c + 1] : null,
         r + 1 < round.rows ? round.grid[r + 1][c] : null].forEach(n => {
          if (n && n.colorId === b.colorId && !before.has(pairKey(b, n))) {
            b.bonds.add(n);
            n.bonds.add(b);
          }
        });
      }
    }
  }

  /* =========================================================================
   * Board rendering
   *
   * Cell positions are a pure function of (r, c) and the measured cell size.
   * Bonded neighbours are drawn as one shape: a block extends over the
   * gutter toward a bonded right/down neighbour and squares off the shared
   * corners, so a piece reads as a single connected shape while a split pair
   * shows the gutter between its rounded squares again.
   * ======================================================================= */

  const SWATCH_RADIUS = 6;             // must match --radius-sm in styles.css

  function layoutMetrics() {
    const reserve = topControlsReserve();
    const width = el.board.clientWidth - BOARD_PADDING * 2;
    const height = el.board.clientHeight - BOARD_PADDING * 2 - reserve;
    if (width <= 0 || height <= 0 || !round.cols) return;

    const size = Math.max(1, Math.floor(Math.min(
      (width - GRID_GAP * (round.cols - 1)) / round.cols,
      (height - GRID_GAP * (round.rows - 1)) / round.rows
    )));
    const gridW = round.cols * size + GRID_GAP * (round.cols - 1);
    const gridH = round.rows * size + GRID_GAP * (round.rows - 1);

    round.cellSize = size;
    round.originX = BOARD_PADDING + (width - gridW) / 2;
    round.originY = BOARD_PADDING + reserve + (height - gridH) / 2;
  }

  function positionAll() {
    const size = round.cellSize;
    const step = size + GRID_GAP;

    round.blocks.forEach(b => {
      const up = bondedAt(b, b.r - 1, b.c);
      const down = bondedAt(b, b.r + 1, b.c);
      const left = bondedAt(b, b.r, b.c - 1);
      const right = bondedAt(b, b.r, b.c + 1);

      b.node.style.left = Math.round(round.originX + b.c * step) + 'px';
      b.node.style.top = Math.round(round.originY + b.r * step) + 'px';
      b.node.style.width = (size + (right ? GRID_GAP : 0)) + 'px';
      b.node.style.height = (size + (down ? GRID_GAP : 0)) + 'px';
      b.node.style.borderRadius =
        ((left || up) ? 0 : SWATCH_RADIUS) + 'px ' +
        ((right || up) ? 0 : SWATCH_RADIUS) + 'px ' +
        ((right || down) ? 0 : SWATCH_RADIUS) + 'px ' +
        ((left || down) ? 0 : SWATCH_RADIUS) + 'px';
    });
  }

  /**
   * The timer and home button float over the board, so the grid has to start
   * below them or the top row sits under a control that both hides a swatch
   * and swallows its clicks.
   */
  function topControlsReserve() {
    const controlsBottom = el.backBtn.offsetTop + el.backBtn.offsetHeight + 8;
    return Math.max(0, controlsBottom - BOARD_PADDING);
  }

  // A viewport change (resize, rotate) changes the cell size, not the grid —
  // coalesced into one frame so dragging a window edge doesn't thrash.
  let relayoutQueued = false;
  function queueRelayout() {
    if (relayoutQueued || !round.blocks.length) return;
    relayoutQueued = true;
    requestAnimationFrame(() => {
      relayoutQueued = false;
      layoutMetrics();
      positionAll();
      if (round.selected) select(round.selected);   // re-derive outline/seams at the new scale
    });
  }
  window.addEventListener('resize', queueRelayout);
  window.addEventListener('orientationchange', () => setTimeout(queueRelayout, 60));

  /* =========================================================================
   * Round flow
   * ======================================================================= */

  function startRound(pairCount) {
    el.overlay.classList.remove('show');
    clearSelection();
    el.board.innerHTML = '';

    const tiles = buildTiles(pairCount);
    const reserve = topControlsReserve();
    const dims = pickGridDims(
      tiles.length,
      el.board.clientWidth - BOARD_PADDING * 2,
      el.board.clientHeight - BOARD_PADDING * 2 - reserve,
      GRID_GAP
    );
    arrangeTiles(tiles, dims.cols);

    round.active = true;
    round.cols = dims.cols;
    round.rows = dims.rows;
    round.grid = [];
    round.blocks = [];
    round.colourTotal = {};
    round.done = new Set();

    tiles.forEach(tile => {
      round.colourTotal[tile.id] = (round.colourTotal[tile.id] || 0) + 1;
    });
    round.totalColours = Object.keys(round.colourTotal).length;

    for (let r = 0; r < dims.rows; r++) {
      const row = [];
      for (let c = 0; c < dims.cols; c++) {
        const tile = tiles[r * dims.cols + c];
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'swatch';
        node.style.background = tile.hex;
        const block = {
          id: r * dims.cols + c,
          r, c,
          colorId: tile.id,
          hex: tile.hex,
          particle: darken(tile.hex, 0.6),
          bonds: new Set(),
          node
        };
        node.addEventListener('click', (e) => onBlockClick(block, e));
        row.push(block);
        round.blocks.push(block);
      }
      round.grid.push(row);
    }

    layoutMetrics();
    positionAll();                     // styles set before insertion: no slide-in
    el.board.appendChild(rowBandEl);   // behind the swatches: added before them
    el.board.appendChild(colBandEl);
    round.blocks.forEach(b => el.board.appendChild(b.node));
    el.board.appendChild(splitBtn);    // board was wiped, put the button back

    round.startedAt = Date.now();
    startPlayClock();
  }

  /** Every colour whose copies currently form one bonded piece. */
  function completedColours() {
    const done = new Set();
    const seen = new Set();
    round.blocks.forEach(b => {
      if (seen.has(b)) return;
      const group = groupOf(b);
      group.forEach(m => seen.add(m));
      if (group.length === round.colourTotal[b.colorId]) done.add(b.colorId);
    });
    return done;
  }

  /** After every move: redraw bonds, then celebrate any colour whose every
   *  copy has just joined into one piece. The piece stays on the board as a
   *  blocker — and the split button can break it again, so completion is
   *  re-derived rather than latched. */
  function refreshBoard() {
    positionAll();

    const done = completedColours();
    const newlyDone = [...done].filter(id => !round.done.has(id));
    round.done = done;
    if (!newlyDone.length) return;

    const justDone = new Set(newlyDone);
    round.blocks.forEach(b => {
      if (justDone.has(b.colorId)) burstParticles(b.node);
    });

    sound.match();
    if (done.size === round.totalColours) finishRound();
  }

  function finishRound() {
    round.active = false;
    clearSelection();
    stopPlayClock();
    const elapsed = (Date.now() - round.startedAt) / 1000;
    saveScore(elapsed);
    sound.finish();

    el.finalTime.textContent = elapsed.toFixed(2) + 's';
    renderScores();
    el.overlay.classList.add('show');
    celebrateWin();
  }

  // A tap on empty board space drops the current selection.
  el.board.addEventListener('click', () => {
    if (round.active) clearSelection();
  });

  /* =========================================================================
   * Navigation
   * ======================================================================= */

  function showGame(pairCount) {
    sound.unlock();                     // must happen inside the user gesture
    el.titleScreen.style.display = 'none';
    el.gameScreen.style.display = 'flex';
    startRound(pairCount);
  }

  function showTitle() {
    round.active = false;
    round.blocks = [];
    clearSelection();
    stopPlayClock();
    el.overlay.classList.remove('show');
    el.gameScreen.style.display = 'none';
    el.titleScreen.style.display = 'flex';
  }

  // Shift+Start deals a 4-block board for quick rule testing.
  el.startBtn.addEventListener('click', (e) => {
    if (e.shiftKey) showGame(TEST_PAIR_COUNT);
    else showGame(BASE_PAIR_COUNT * (settings.longList ? LONG_LIST_MULTIPLIER : 1));
  });

  el.backBtn.addEventListener('click', showTitle);

  // Rules screen: reachable from the title, returns home, or dives into a game.
  function showRules() {
    el.titleScreen.style.display = 'none';
    el.rulesScreen.style.display = 'flex';
    if (el.rulesInner) el.rulesInner.scrollTop = 0;
  }
  el.rulesLink.addEventListener('click', showRules);
  el.rulesBackBtn.addEventListener('click', () => {
    el.rulesScreen.style.display = 'none';
    el.titleScreen.style.display = 'flex';
  });
  el.rulesStartBtn.addEventListener('click', () => {
    el.rulesScreen.style.display = 'none';
    showGame(BASE_PAIR_COUNT * (settings.longList ? LONG_LIST_MULTIPLIER : 1));
  });

}());
