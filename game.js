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
  // goal per colour: a colour is done when ALL of its copies are joined into
  // one connected group, so long list asks for 6-block chains, not pairs.
  const BASE_PAIR_COUNT = 20;
  const LONG_LIST_MULTIPLIER = 3;
  const TEST_PAIR_COUNT = 2;           // shift+Start: 4 blocks, for testing
  const DEV_PAIR_COUNT = 3;
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
      split() { if (enabled) { tone(600, 0, 0.07, 'square', 0.045); tone(420, 0.06, 0.09, 'square', 0.045); } },
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

    // Restarted after every newly completed colour, so the clock is
    // per-connection rather than for the whole round.
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

  function movableRows(group) {
    const rows = [...new Set(group.map(b => b.r))];
    if (rows.length > 1 && group.length !== 2) return null;
    const inBand = new Set(rows);
    for (const r of rows) {
      for (let c = 0; c < round.cols; c++) {
        for (const p of round.grid[r][c].bonds) {
          if (!inBand.has(p.r)) return null;
        }
      }
    }
    return rows;
  }

  function movableColumns(group) {
    const cols = [...new Set(group.map(b => b.c))];
    if (cols.length > 1 && group.length !== 2) return null;
    const inBand = new Set(cols);
    for (const c of cols) {
      for (let r = 0; r < round.rows; r++) {
        for (const p of round.grid[r][c].bonds) {
          if (!inBand.has(p.c)) return null;
        }
      }
    }
    return cols;
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

  let seamNodes = [];

  function hideSplitControls() {
    splitBtn.style.display = 'none';
    seamNodes.forEach(n => n.remove());
    seamNodes = [];
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
    hideSplitControls();
  }

  function select(block) {
    clearSelection();
    round.selected = block;
    block.node.classList.add('selected');

    const group = groupOf(block);
    const rowBand = movableRows(group);
    const colBand = movableColumns(group);

    round.blocks.forEach(b => {
      if (b === block) return;
      const viaRow = rowBand && b.r === block.r && !rowShiftStraddlesSeam(rowBand, b.c - block.c);
      const viaCol = colBand && b.c === block.c && !columnShiftStraddlesSeam(colBand, b.r - block.r);
      if (viaRow || viaCol) {
        b.node.classList.add('hint');
        round.hinted.push(b);
      }
    });

    if (group.length > 1) showSplitControls(group);
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

    sound.click();
    select(block);                    // otherwise the tap moves the selection
  }

  /** Rotate the band so `sel` lands exactly on `dest`'s cell; everything in
   *  the band shifts one step and the edge wraps around. */
  function moveTo(sel, dest) {
    const group = groupOf(sel);
    const before = sameColourAdjacencies();

    if (dest.r === sel.r) {
      const band = movableRows(group);
      if (!band) { clearSelection(); return; }
      band.forEach(r => rotateRow(r, dest.c - sel.c));
    } else {
      const band = movableColumns(group);
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
      if (round.selected) {
        hideSplitControls();
        const group = groupOf(round.selected);
        if (group.length > 1) showSplitControls(group);
      }
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

    el.hardTimer.style.display = countdown.active ? 'flex' : 'none';

    layoutMetrics();
    positionAll();                     // styles set before insertion: no slide-in
    round.blocks.forEach(b => el.board.appendChild(b.node));
    el.board.appendChild(splitBtn);    // board was wiped, put the button back

    round.startedAt = Date.now();
    countdown.restart(failRound);
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
      if (justDone.has(b.colorId)) burstParticles(b.node, b.particle);
    });

    sound.match();
    if (done.size === round.totalColours) {
      countdown.stop();
      finishRound();
    } else {
      countdown.restart(failRound);
    }
  }

  function finishRound() {
    round.active = false;
    clearSelection();
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
    el.failMatchedCount.textContent = round.done.size + ' of ' + round.totalColours + ' colours connected';
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

  // Shift+Start deals a 4-block board for quick rule testing.
  el.startBtn.addEventListener('click', (e) => {
    if (e.shiftKey) showGame(TEST_PAIR_COUNT);
    else showGame(BASE_PAIR_COUNT * (settings.longList ? LONG_LIST_MULTIPLIER : 1));
  });

  // DEV BUTTON START (remove this block + the #devStartBtn element to strip dev mode)
  if (el.devStartBtn) {
    el.devStartBtn.addEventListener('click', () => showGame(DEV_PAIR_COUNT));
  }
  // DEV BUTTON END

  el.backBtn.addEventListener('click', showTitle);
  el.failHomeBtn.addEventListener('click', showTitle);

}());
