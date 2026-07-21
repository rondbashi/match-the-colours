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
  // instead — 3x the tiles, which is what the option actually promises.
  const BASE_PAIR_COUNT = 20;
  const LONG_LIST_MULTIPLIER = 3;
  const DEV_PAIR_COUNT = 1;
  const SET_SIZE = 2;                  // a match is always exactly two swatches
  const MISMATCH_CLEAR_MS = 400;       // keep in sync with the .mismatch shake duration
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
      mismatch() { if (enabled) tone(220, 0, 0.16, 'sine', 0.05); },
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

    // Restarted after every successful match, so the clock is per-pair.
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
   * Round
   * ======================================================================= */

  const round = {
    active: false,
    selected: [],
    nodes: [],
    matched: 0,
    totalPairs: 0,
    startedAt: 0
  };

  /**
   * Shuffling the palette first means a round shorter than the palette draws a
   * random subset rather than always the same leading colours, and a round
   * longer than it reuses colours evenly — each extra cycle simply adds another
   * pair of an existing colour, which stays consistent because any two tiles of
   * one colour are a valid match.
   */
  function buildSwatches(pairCount) {
    const order = shuffle(PALETTE.map((hex, id) => ({ hex, id })));
    const tiles = [];

    for (let pair = 0; pair < pairCount; pair++) {
      const colour = order[pair % order.length];
      for (let copy = 0; copy < SET_SIZE; copy++) tiles.push(colour);
    }
    shuffle(tiles);

    return tiles.map(tile => {
      const node = document.createElement('div');
      node.className = 'swatch';
      node.style.background = tile.hex;
      node.dataset.colorId = tile.id;
      node.dataset.particle = darken(tile.hex, 0.6);
      node.addEventListener('click', onSwatchClick);
      return node;
    });
  }

  /**
   * Pick the column count whose resulting square is largest — the squares are
   * uniform, so filling the board is purely a question of which split of the
   * count wastes the least space in the board's aspect ratio.
   */
  function computeGrid(count, width, height, gap) {
    let best = { cols: count, rows: 1, size: 0 };
    for (let cols = 1; cols <= count; cols++) {
      const rows = Math.ceil(count / cols);
      const size = Math.min(
        (width - gap * (cols - 1)) / cols,
        (height - gap * (rows - 1)) / rows
      );
      if (size > best.size) best = { cols, rows, size };
    }
    return best;
  }

  /**
   * Positions are a pure function of (count, board size), so this is also the
   * resize handler: matched swatches keep their slot, which is what stops the
   * survivors from sliding around mid-round.
   */
  /**
   * The timer and home button float over the board, so the grid has to start
   * below them or the top row sits under a control that both hides a swatch and
   * swallows its clicks. Measured off the button rather than hard-coded so it
   * still clears the safe-area inset on a notched phone.
   */
  function topControlsReserve() {
    const controlsBottom = el.backBtn.offsetTop + el.backBtn.offsetHeight + 8;
    return Math.max(0, controlsBottom - BOARD_PADDING);
  }

  function layoutGrid(nodes) {
    const reserve = topControlsReserve();
    const width = el.board.clientWidth - BOARD_PADDING * 2;
    const height = el.board.clientHeight - BOARD_PADDING * 2 - reserve;
    if (!nodes.length || width <= 0 || height <= 0) return;

    const grid = computeGrid(nodes.length, width, height, GRID_GAP);
    const size = Math.max(1, Math.floor(grid.size));
    const step = size + GRID_GAP;
    const gridHeight = grid.rows * size + GRID_GAP * (grid.rows - 1);
    const top = BOARD_PADDING + reserve + (height - gridHeight) / 2;

    nodes.forEach((node, i) => {
      const row = Math.floor(i / grid.cols);
      const col = i % grid.cols;
      // A short final row is centred rather than left-aligned.
      const inRow = Math.min(grid.cols, nodes.length - row * grid.cols);
      const rowLeft = BOARD_PADDING + (width - (inRow * size + GRID_GAP * (inRow - 1))) / 2;

      node.style.width = size + 'px';
      node.style.height = size + 'px';
      node.style.left = Math.round(rowLeft + col * step) + 'px';
      node.style.top = Math.round(top + row * step) + 'px';
    });
  }

  // A viewport change (resize, rotate) changes the ideal grid, so re-lay-out —
  // coalesced into one frame so dragging a window edge doesn't thrash.
  let relayoutQueued = false;
  function queueRelayout() {
    if (relayoutQueued || !round.nodes.length) return;
    relayoutQueued = true;
    requestAnimationFrame(() => {
      relayoutQueued = false;
      layoutGrid(round.nodes);
    });
  }
  window.addEventListener('resize', queueRelayout);
  window.addEventListener('orientationchange', () => setTimeout(queueRelayout, 60));

  function startRound(pairCount) {
    el.overlay.classList.remove('show');
    el.failOverlay.classList.remove('show');
    el.board.innerHTML = '';

    const nodes = buildSwatches(pairCount);

    round.active = true;
    round.selected = [];
    round.nodes = nodes;
    round.matched = 0;
    round.totalPairs = nodes.length / SET_SIZE;   // trust what was actually built

    el.hardTimer.style.display = countdown.active ? 'flex' : 'none';

    nodes.forEach(node => el.board.appendChild(node));
    layoutGrid(nodes);

    round.startedAt = Date.now();
    countdown.restart(failRound);
  }

  function onSwatchClick(e) {
    if (!round.active) return;

    const node = e.currentTarget;
    if (node.classList.contains('matched')) return;

    sound.click();

    const index = round.selected.indexOf(node);
    if (index !== -1) {                          // tapping a selection clears it
      node.classList.remove('selected');
      round.selected.splice(index, 1);
      return;
    }

    node.classList.add('selected');
    round.selected.push(node);
    if (round.selected.length < SET_SIZE) return;

    const picked = round.selected;
    round.selected = [];

    const isMatch = picked.every(n => n.dataset.colorId === picked[0].dataset.colorId);
    if (isMatch) resolveMatch(picked);
    else resolveMismatch(picked);
  }

  function resolveMatch(picked) {
    picked.forEach(node => {
      burstParticles(node, node.dataset.particle);
      node.classList.remove('selected');
      node.classList.add('matched');
    });
    sound.match();

    round.matched++;
    if (round.matched === round.totalPairs) {
      countdown.stop();
      finishRound();
    } else {
      countdown.restart(failRound);
    }
  }

  function resolveMismatch(picked) {
    sound.mismatch();
    picked.forEach(node => node.classList.add('mismatch'));
    setTimeout(() => {
      picked.forEach(node => node.classList.remove('selected', 'mismatch'));
    }, MISMATCH_CLEAR_MS);
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
    el.failMatchedCount.textContent = round.matched + ' of ' + round.totalPairs + ' matched';
    el.failOverlay.classList.add('show');
  }

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
    round.nodes = [];
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
