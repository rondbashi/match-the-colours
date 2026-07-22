(function () {
  'use strict';

  /* =========================================================================
   * Configuration
   * ======================================================================= */

  const STAGE_W = 840;                 // design width + breathing room, used for scale-to-fit
  const STAGE_H = 640;
  const MOBILE_QUERY = '(max-width:700px)';
  const BOARD_PADDING = 16;            // must match #board padding in styles.css

  // A standard round is the whole palette, one pair each. The long-list option
  // cannot add new colours (the palette is fixed), so it adds pairs per colour
  // instead — 3x the tiles. With the sliding mechanic that also changes the
  // goal per colour: a colour clears only when ALL of its copies are joined
  // into one connected group, so long list asks for 6-block chains, not pairs.
  const BASE_PAIR_COUNT = 20;
  const LONG_LIST_MULTIPLIER = 3;
  const DEV_PAIR_COUNT = 3;            // 6 tiles — smallest board that still slides
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
      match() { if (enabled) chord([660, 880, 1100, 1320], 0.06, 0.32, 'triangle', 0.045); },
      finish() { if (enabled) chord([523.25, 659.25, 783.99, 1046.5], 0.09, 0.4, 'triangle', 0.05); },
      tick() { if (enabled) tone(880, 0, 0.08, 'square', 0.04); },
      timeout() {
        if (!enabled) return;
        tone(260, 0, 0.18, 'sawtooth', 0.05);
        tone(180, 0.12, 0.28, 'sawtooth', 0.05);
      }
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
    failOverlay: document.getElementById('failOverlay'),
    failMatchedCount: document.getElementById('failMatchedCount'),
    finalTime: document.getElementById('finalTime'),
    scoreList: document.getElementById('scoreList'),
    hardTimer: document.getElementById('hardTimer'),
    hardTimerValue: document.getElementById('hardTimerValue'),
    hardModeDropdown: document.getElementById('hardModeDropdown'),
    hardModeToggle: document.getElementById('hardModeToggle'),
    hardModePanel: document.getElementById('hardModePanel'),
    hardModeLabel: document.getElementById('hardModeLabel'),
    optTimer5: document.getElementById('optCountTimer'),
    optTimer10: document.getElementById('optCountTimer10'),
    optLongList: document.getElementById('optLongList'),
    soundToggle: document.getElementById('soundToggle'),
    soundIconOn: document.getElementById('soundIconOn'),
    soundIconOff: document.getElementById('soundIconOff'),
    soundLabel: document.getElementById('soundLabel'),
    startBtn: document.getElementById('startBtn'),
    devStartBtn: document.getElementById('devStartBtn'),
    backBtn: document.getElementById('backBtn'),
    failHomeBtn: document.getElementById('failHomeBtn')
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
    timerSeconds: 0,      // 0 = countdown off
    longList: false
  };

  function persistSettings() {
    storage.write(STORAGE_KEYS.settings, {
      timerSeconds: settings.timerSeconds,
      longList: settings.longList
    });
  }

  function syncHardModeUI() {
    el.optTimer5.checked = settings.timerSeconds === 5;
    el.optTimer10.checked = settings.timerSeconds === 10;
    el.optLongList.checked = settings.longList;

    const active = settings.timerSeconds > 0 || settings.longList;
    el.hardModeToggle.classList.toggle('active', active);
    el.hardModeLabel.textContent = active ? 'Hard mode: On' : 'Hard mode';
  }

  function restoreSettings() {
    const saved = storage.read(STORAGE_KEYS.settings, null);
    if (saved) {
      settings.timerSeconds = saved.timerSeconds === 5 || saved.timerSeconds === 10 ? saved.timerSeconds : 0;
      settings.longList = !!saved.longList;
    }
    syncHardModeUI();
  }

  // The two countdown lengths are mutually exclusive, so each acts as a radio
  // that can also be switched off.
  function bindTimerOption(input, seconds) {
    input.addEventListener('change', () => {
      settings.timerSeconds = input.checked ? seconds : 0;
      syncHardModeUI();
      persistSettings();
    });
  }

  bindTimerOption(el.optTimer5, 5);
  bindTimerOption(el.optTimer10, 10);

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

  function burstParticles(swatch, color) {
    const boardRect = el.board.getBoundingClientRect();
    const rect = swatch.getBoundingClientRect();
    const cx = rect.left - boardRect.left + rect.width / 2;
    const cy = rect.top - boardRect.top + rect.height / 2;
    const count = 10;

    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const distance = 30 + Math.random() * 26;
      p.className = 'particle';
      p.style.setProperty('--px', (Math.cos(angle) * distance).toFixed(1) + 'px');
      p.style.setProperty('--py', (Math.sin(angle) * distance).toFixed(1) + 'px');
      p.style.left = cx + 'px';
      p.style.top = cy + 'px';
      p.style.background = color;
      el.board.appendChild(p);
      p.addEventListener('animationend', () => p.remove());
    }
  }

  /* =========================================================================
   * Countdown
   * ======================================================================= */

  const countdown = {
    intervalId: null,
    remaining: 0,

    get active() { return settings.timerSeconds > 0; },

    render() {
      el.hardTimerValue.textContent = this.remaining;
      el.hardTimer.classList.toggle('critical', this.remaining <= 2);
    },

    stop() {
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
    },

    // Restarted after every cleared colour, so the clock is per-clear.
    restart(onExpire) {
      if (!this.active) return;
      this.stop();
      this.remaining = settings.timerSeconds;
      this.render();
      this.intervalId = setInterval(() => {
        this.remaining--;
        this.render();
        if (this.remaining <= 0) {
          this.stop();
          sound.timeout();
          onExpire();
          return;
        }
        sound.tick();
      }, 1000);
    }
  };

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
   * The board is a full cols x rows grid (tile count always factorizes — it is
   * even) where every cell holds a block or, after a colour clears, a gap.
   * All movement is a cyclic rotation of one row or column, so the grid stays
   * rectangular for the whole round and gaps simply rotate along with blocks.
   * ======================================================================= */

  const round = {
    active: false,
    cols: 0,
    rows: 0,
    grid: [],            // grid[r][c] -> block | null
    blocks: [],          // live blocks (cleared ones are removed)
    selected: null,      // block whose row/column is currently highlighted
    hinted: [],          // blocks carrying the .hint outline
    colourTotal: {},     // colorId -> copies on this board (the clear target)
    cleared: 0,
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
   * Same-colour neighbours fuse (and a complete colour clears) the moment they
   * touch, so the opening board must not hand any connection out for free.
   * Hill-climb on random swaps until no two same-colour tiles are orthogonal
   * neighbours; the cap is a safety net, in practice it converges in a few
   * hundred swaps even on the 3x board.
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

  /** Fused = same colour and orthogonally adjacent (no wrap: the seam between
   *  the two board edges is not a connection, even though moves wrap). */
  function fusedWith(block, r, c) {
    const other = blockAt(r, c);
    return !!other && other.colorId === block.colorId;
  }

  /** The connected group the block currently belongs to, via flood fill.
   *  Connectivity is always derived from the grid rather than stored, so
   *  groups split and re-fuse naturally as rows slide through each other. */
  function groupOf(block) {
    const group = [block];
    const seen = new Set([block]);
    for (let i = 0; i < group.length; i++) {
      const b = group[i];
      [[b.r - 1, b.c], [b.r + 1, b.c], [b.r, b.c - 1], [b.r, b.c + 1]].forEach(([r, c]) => {
        const n = blockAt(r, c);
        if (n && n.colorId === b.colorId && !seen.has(n)) {
          seen.add(n);
          group.push(n);
        }
      });
    }
    return group;
  }

  /**
   * A lone block moves along its row or its column. A fused group is locked
   * to its longer bounding-box axis — wide groups slide horizontally, tall
   * ones vertically, and a square-bounded group keeps both.
   */
  function allowedAxes(block) {
    const group = groupOf(block);
    if (group.length === 1) return { row: true, col: true };
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    group.forEach(b => {
      minR = Math.min(minR, b.r); maxR = Math.max(maxR, b.r);
      minC = Math.min(minC, b.c); maxC = Math.max(maxC, b.c);
    });
    const w = maxC - minC + 1;
    const h = maxR - minR + 1;
    return { row: w >= h, col: h >= w };
  }

  /* =========================================================================
   * Selection & movement
   * ======================================================================= */

  function clearSelection() {
    if (round.selected) round.selected.node.classList.remove('selected');
    round.selected = null;
    round.hinted.forEach(b => b.node.classList.remove('hint'));
    round.hinted = [];
  }

  function select(block) {
    clearSelection();
    round.selected = block;
    block.node.classList.add('selected');

    const axes = allowedAxes(block);
    round.blocks.forEach(b => {
      if (b === block) return;
      if ((axes.row && b.r === block.r) || (axes.col && b.c === block.c)) {
        b.node.classList.add('hint');
        round.hinted.push(b);
      }
    });
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

    sound.click();
    select(block);                    // otherwise the tap moves the selection
  }

  /** Rotate the shared row/column so `sel` lands exactly on `dest`'s cell;
   *  everything in between shifts one step and the edge wraps around. */
  function moveTo(sel, dest) {
    if (dest.r === sel.r) rotateRow(sel.r, dest.c - sel.c);
    else rotateColumn(sel.c, dest.r - sel.r);

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
      if (row[c]) row[c].c = target;
    }
    round.grid[r] = next;
  }

  function rotateColumn(c, delta) {
    const rows = round.rows;
    const column = round.grid.map(row => row[c]);
    for (let r = 0; r < rows; r++) {
      const target = ((r + delta) % rows + rows) % rows;
      round.grid[target][c] = column[r];
      if (column[r]) column[r].r = target;
    }
  }

  /* =========================================================================
   * Board rendering
   *
   * Cell positions are a pure function of (r, c) and the measured cell size.
   * Fused neighbours are drawn as one shape: a block extends over the gutter
   * toward a fused right/down neighbour and squares off the shared corners,
   * so a chain reads as a single long piece.
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
      const up = fusedWith(b, b.r - 1, b.c);
      const down = fusedWith(b, b.r + 1, b.c);
      const left = fusedWith(b, b.r, b.c - 1);
      const right = fusedWith(b, b.r, b.c + 1);

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
    });
  }
  window.addEventListener('resize', queueRelayout);
  window.addEventListener('orientationchange', () => setTimeout(queueRelayout, 60));

  /* =========================================================================
   * Round flow
   * ======================================================================= */

  function startRound(pairCount) {
    el.overlay.classList.remove('show');
    el.failOverlay.classList.remove('show');
    el.board.innerHTML = '';
    clearSelection();

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
    round.cleared = 0;

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
        const block = { r, c, colorId: tile.id, hex: tile.hex, particle: darken(tile.hex, 0.6), node };
        node.addEventListener('click', (e) => onBlockClick(block, e));
        row.push(block);
        round.blocks.push(block);
      }
      round.grid.push(row);
    }

    el.hardTimer.style.display = countdown.active ? 'flex' : 'none';

    layoutMetrics();
    positionAll();                     // styles set before insertion: no slide-in
    round.blocks.forEach(b => el.board.appendChild(b.node));

    round.startedAt = Date.now();
    countdown.restart(failRound);
  }

  /** After every move: redraw fuses, then clear any colour whose every copy
   *  is now in one connected group. */
  function refreshBoard() {
    positionAll();

    const seen = new Set();
    const complete = [];
    round.blocks.forEach(b => {
      if (seen.has(b)) return;
      const group = groupOf(b);
      group.forEach(m => seen.add(m));
      if (group.length === round.colourTotal[b.colorId]) complete.push(group);
    });

    if (!complete.length) return;

    complete.forEach(group => {
      group.forEach(b => {
        burstParticles(b.node, b.particle);
        b.node.classList.remove('hint', 'selected');
        b.node.classList.add('matched');
        round.grid[b.r][b.c] = null;
      });
      round.cleared++;
    });
    const gone = new Set(complete.flat());
    round.blocks = round.blocks.filter(b => !gone.has(b));

    sound.match();
    if (round.cleared === round.totalColours) {
      countdown.stop();
      finishRound();
    } else {
      countdown.restart(failRound);
    }
  }

  function finishRound() {
    round.active = false;
    const elapsed = (Date.now() - round.startedAt) / 1000;
    saveScore(elapsed);
    sound.finish();

    el.finalTime.textContent = elapsed.toFixed(2) + 's';
    renderScores();
    el.overlay.classList.add('show');
  }

  function failRound() {
    round.active = false;
    clearSelection();
    el.failMatchedCount.textContent = round.cleared + ' of ' + round.totalColours + ' colours cleared';
    el.failOverlay.classList.add('show');
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
    countdown.stop();
    el.overlay.classList.remove('show');
    el.failOverlay.classList.remove('show');
    el.gameScreen.style.display = 'none';
    el.titleScreen.style.display = 'flex';
  }

  el.startBtn.addEventListener('click', () => {
    showGame(BASE_PAIR_COUNT * (settings.longList ? LONG_LIST_MULTIPLIER : 1));
  });

  // DEV BUTTON START (remove this block + the #devStartBtn element to strip dev mode)
  if (el.devStartBtn) {
    el.devStartBtn.addEventListener('click', () => showGame(DEV_PAIR_COUNT));
  }
  // DEV BUTTON END

  el.backBtn.addEventListener('click', showTitle);
  el.failHomeBtn.addEventListener('click', showTitle);

}());
