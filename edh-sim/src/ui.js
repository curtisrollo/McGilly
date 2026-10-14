(function () {
  'use strict';
  const { decks, db, art } = window.POD_DATA;
  const ART_COLOR = { W: 'var(--aW)', U: 'var(--aU)', B: 'var(--aB)', R: 'var(--aR)', G: 'var(--aG)', C: 'var(--aC)' };
  // Pick a generic illustration from the card's creature type or card type (icons from game-icons.net)
  function artName(m, id) {
    const words = String(m.types || '').replace('—', ' ').split(/\s+/);
    const nm = String(m.name || '');
    for (const [sub, icon] of art.map.subtypes) if (words.includes(sub) || nm.startsWith(sub + ' ')) return icon;
    const c = state.game && state.game.cards[id];
    if (m.land) { for (const [t, icon] of art.map.lands) if (words.includes(t)) return icon; return 'mountains'; }
    if (words.includes('Planeswalker')) return 'hooded-figure';
    if (words.includes('Equipment')) return 'broadsword';
    if (words.includes('Aura')) return 'aura';
    if (words.includes('Saga')) return 'scroll-unfurled';
    if (words.includes('Artifact') && c && c.info.mana) return 'gems';
    for (const [t, icon] of art.map.types) if (words.includes(t)) return icon;
    return 'cowled';
  }
  function artColor(colors) {
    const cs = Array.isArray(colors) ? colors : String(colors || '').split(/\s+/).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' }[w])).filter(Boolean);
    if (!cs.length) return ART_COLOR.C;
    if (cs.length > 1) return 'var(--aM)';
    return ART_COLOR[cs[0]];
  }
  function artSvg(m, id) {
    const body = art.icons[artName(m, id)] || '';
    return `<svg class="art" viewBox="0 0 512 512" aria-hidden="true" style="color:${artColor(m.colors)}">${body}</svg>`;
  }
  const { Game } = window.PodSim;
  const $ = (s, el = document) => el.querySelector(s);
  const MANA = { W: 'var(--mW)', U: 'var(--mU)', B: 'var(--mB)', R: 'var(--mR)', G: 'var(--mG)', C: 'var(--mC)' };
  // 2× here is the old 0.5× pace; everything is four times slower than the first version
  const SPEEDS = [0.25, 0.5, 1, 2, 4, 10, 40];
  const PACE = 4;
  const BASE_DELAY = { turn: 1100, attack: 1300, block: 1000, damage: 1200, wipe: 1600, combo: 2200, lose: 1800, win: 0, counter: 1300, start: 700, mulligan: 350, draw: 500, land: 450 };

  const state = {
    seats: [], seed: 0, game: null, events: [], meta: {}, idx: 0, playing: false, speed: 1, timer: null,
    showHands: false, inspect: null,
  };

  function load(key, def) { try { const v = localStorage.getItem('podnight.' + key); return v == null ? def : JSON.parse(v); } catch { return def; } }
  function save(key, v) { try { localStorage.setItem('podnight.' + key, JSON.stringify(v)); } catch { /* storage unavailable */ } }

  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function frameColor(colors) {
    const cs = (Array.isArray(colors) ? colors : String(colors || '').split(/\s+/).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' }[w])).filter(Boolean));
    if (!cs.length) return 'var(--mC)';
    if (cs.length > 1) return 'var(--mM)';
    return MANA[cs[0]];
  }
  // Mana symbols: W U B R G C, plus L for life paid (Phyrexian)
  function manaPips(list, cls = '') {
    return list.map((c) => `<span class="mp mp-${c === 'ANY' ? 'A' : c} ${cls}" title="${({ W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless', L: '2 life', ANY: 'Any color' })[c] || c}">${c === 'ANY' ? '★' : c === 'L' ? '♥' : c}</span>`).join('');
  }
  function poolList(fl) { const out = []; for (const k of ['W', 'U', 'B', 'R', 'G', 'C', 'ANY']) for (let i = 0; i < (fl[k] || 0); i++) out.push(k); return out; }
  function deckColors(d) { return window.PodSim.deckColorIdentity(db[d.commander]); }

  // ---------- setup ----------
  function initControls() {
    const saved = load('seats', null);
    state.seats = saved && saved.length === 4 && saved.every((id) => decks.some((d) => d.id === id)) ? saved : decks.slice(0, 4).map((d) => d.id);
    const wrap = $('#seats');
    wrap.innerHTML = state.seats.map((id, i) => `<label for="seat${i}">Seat ${i + 1}<select id="seat${i}" data-i="${i}">${decks.map((d) => `<option value="${d.id}" ${d.id === id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>`).join('');
    wrap.addEventListener('change', (e) => {
      const i = +e.target.dataset.i; state.seats[i] = e.target.value; save('seats', state.seats); newGame(true);
    });
    $('#seed').addEventListener('change', () => { state.seed = (+$('#seed').value) >>> 0; startGame(); });
    $('#new').addEventListener('click', () => newGame(true));
    $('#play').addEventListener('click', togglePlay);
    $('#back').addEventListener('click', () => { pause(); go(state.idx - 1); });
    $('#fwd').addEventListener('click', () => { pause(); go(state.idx + 1); });
    $('#nextTurn').addEventListener('click', () => { pause(); jumpTurn(1); });
    $('#end').addEventListener('click', () => { pause(); go(state.events.length - 1); });
    $('#scrub').addEventListener('input', (e) => { pause(); go(+e.target.value); });
    $('#hands').checked = state.showHands = load('showHands', true);
    $('#hands').addEventListener('change', (e) => { state.showHands = e.target.checked; save('showHands', state.showHands); render(); });
    state.speed = load('pace', 2);
    if (!SPEEDS.includes(state.speed)) state.speed = 2;
    const sp = $('#speed');
    sp.innerHTML = SPEEDS.map((s) => `<button type="button" data-s="${s}" aria-pressed="${s === state.speed}">${s}×</button>`).join('');
    sp.addEventListener('click', (e) => {
      const s = +e.target.dataset.s; if (!s) return; state.speed = s; save('pace', s);
      sp.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.s === s)));
    });
    $('#log').addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) { pause(); go(+li.dataset.i); } });
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-card]');
      if (el) { state.inspect = +el.dataset.card; renderInspect(); return; }
      if (e.target.closest('.inspect .x')) { state.inspect = null; renderInspect(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select')) return;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      if (e.key === 'ArrowRight') { pause(); go(state.idx + 1); }
      if (e.key === 'ArrowLeft') { pause(); go(state.idx - 1); }
      if (e.key === 'Escape') { state.inspect = null; renderInspect(); $('#more').hidden = true; state.zoneView = null; renderZone(); }
    });
    $('#runStats').addEventListener('click', runStats);
    document.addEventListener('click', (e) => {
      const z = e.target.closest('.zbtn');
      if (z) { state.zoneView = { zone: z.dataset.zone, seat: +z.dataset.seat }; renderZone(); }
      if (e.target.id === 'closeZone' || e.target.id === 'zoneView') { state.zoneView = null; renderZone(); }
    });
    $('#openMore').addEventListener('click', () => { $('#more').hidden = false; });
    $('#closeMore').addEventListener('click', () => { $('#more').hidden = true; });
    $('#more').addEventListener('click', (e) => { if (e.target.id === 'more') $('#more').hidden = true; });
  }

  function seatDecks() { return state.seats.map((id) => decks.find((d) => d.id === id)); }

  function newGame(autoplay) {
    state.seed = Math.floor(Math.random() * 1e9);
    $('#seed').value = state.seed;
    startGame(autoplay);
  }

  function startGame(autoplay = true) {
    pause();
    const g = new Game(seatDecks(), db, state.seed, { record: true });
    g.run();
    state.game = g;
    state.events = g.events;
    state.meta = {};
    for (const id in g.cards) state.meta[id] = (g.metaSeen && g.metaSeen[id]) || g.cardMeta(g.cards[id]);
    state.idx = 0;
    state.inspect = null;
    const scrub = $('#scrub'); scrub.max = state.events.length - 1; scrub.value = 0;
    renderLog();
    render();
    renderInspect();
    if (autoplay) play();
  }

  // ---------- playback ----------
  function togglePlay() { state.playing ? pause() : play(); }
  function play() {
    if (state.idx >= state.events.length - 1) state.idx = 0;
    state.playing = true; updatePlayBtn(); tick();
  }
  function pause() { state.playing = false; clearTimeout(state.timer); updatePlayBtn(); }
  function updatePlayBtn() {
    $('#play').innerHTML = state.playing
      ? '<svg viewBox="0 0 16 16"><rect x="3" y="2" width="3.5" height="12"/><rect x="9.5" y="2" width="3.5" height="12"/></svg>Pause'
      : '<svg viewBox="0 0 16 16"><path d="M3 2l11 6-11 6z"/></svg>Play';
  }
  function tick() {
    clearTimeout(state.timer);
    if (!state.playing) return;
    const ev = state.events[state.idx];
    const d = ((BASE_DELAY[ev.kind] ?? 750) * PACE) / state.speed;
    if (state.idx >= state.events.length - 1) { pause(); return; }
    state.timer = setTimeout(() => { go(state.idx + 1); tick(); }, Math.max(30, d));
  }
  function go(i) {
    const prev = state.idx;
    state.idx = Math.max(0, Math.min(state.events.length - 1, i));
    $('#scrub').value = state.idx;
    render(prev);
    markLog();
    if (state.zoneView) renderZone();
  }
  function jumpTurn(dir) {
    for (let i = state.idx + dir; i >= 0 && i < state.events.length; i += dir) if (state.events[i].kind === 'turn') { go(i); return; }
    go(dir > 0 ? state.events.length - 1 : 0);
  }

  // ---------- rendering ----------
  function cardTile(b, focus, atk, blk, attachName) {
    const m0 = state.meta[b.id];
    if (!m0) return '';
    const m = b.nm ? { ...m0, name: b.nm } : m0;
    const base = m.pt ? m.pt.split('/').map((x) => parseInt(x)) : null;
    let pt = '';
    if (b.l != null) pt = `<span class="pt loy">${b.l}</span>`;
    else if (b.p != null) {
      const cls = base && !isNaN(base[0]) ? (b.p > base[0] || b.t > base[1] ? 'up' : b.p < base[0] || b.t < base[1] ? 'down' : '') : '';
      pt = `<span class="pt ${cls}">${b.p}/${b.t}</span>`;
    }
    const cls = ['c', state.tappedFor && state.tappedFor.has(b.id) ? 'manasrc' : '', b.tp ? 'tapped' : '', m.token ? 'token' : '', m.cmd ? 'cmd' : '', b.sk ? 'sick' : '', focus ? 'focus' : '', atk ? 'atk' : '', blk ? 'blk' : ''].join(' ');
    const ty = m.types.replace(/^Legendary /, '').split(' — ')[0];
    return `<button type="button" class="${cls}" style="--frame:${frameColor(m.colors)}" data-card="${b.id}" title="${esc(m.name)}">
      <span class="n">${esc(m.name)}</span><span class="pic">${artSvg(m, b.id)}</span>${attachName ? `<span class="att">⚲ ${esc(attachName)}</span>` : ''}
      <span class="ty">${esc(ty)}</span>${b.ctr ? `<span class="ctr">+${b.ctr}</span>` : ''}${pt}</button>`;
  }

  function landChips(lands, focus) {
    const groups = new Map();
    for (const b of lands) {
      const m = state.meta[b.id];
      const g = groups.get(m.name) || { n: 0, tapped: 0, id: b.id, focus: false, colors: m };
      g.n++; if (b.tp) g.tapped++; if (focus.has(b.id)) g.focus = true; if (state.tappedFor && state.tappedFor.has(b.id)) g.src = true; groups.set(m.name, g);
    }
    return [...groups.entries()].map(([name, g]) => {
      const untapped = g.n - g.tapped;
      return `<button type="button" class="land ${g.focus ? 'focus' : ''} ${g.src ? 'manasrc' : ''}" data-card="${g.id}"><span class="dot" style="background:${landColor(g.id)}"></span>${esc(name)}${g.n > 1 ? ` <em>×${g.n}</em>` : ''}${g.tapped ? ` <em>${untapped ? `(${untapped} untapped)` : 'tapped'}</em>` : ''}</button>`;
    }).join('');
  }
  function landColor(id) {
    const c = state.game.cards[id];
    const opts = c && c.info.mana ? [...new Set(c.info.mana.opts.flatMap((o) => o.colors))] : [];
    const cs = opts.filter((x) => x !== 'C');
    if (!cs.length) return 'var(--mC)';
    if (cs.length > 1) return 'var(--mM)';
    return MANA[cs[0]];
  }

  function render(prevIdx) {
    const ev = state.events[state.idx];
    if (!ev) return;
    const snap = ev.snap;
    const g = state.game;
    const focus = new Set(ev.cards);
    state.tappedFor = new Set(ev.mana ? ev.mana.sources : []);
    const atk = new Set((snap.attackers || []).map((a) => a.id));
    const blk = new Set((snap.blockers || []).map((b) => b.id));
    const prevSnap = prevIdx != null && state.events[prevIdx] ? state.events[prevIdx].snap : null;
    // now bar
    const now = $('#now');
    now.className = 'now k-' + ev.kind;
    const seatName = ev.seat != null ? g.players[ev.seat].name : '';
    now.innerHTML = `<span class="turn">${ev.turn ? 'Turn ' + ev.turn : 'Setup'}</span>${ev.phase && ev.turn ? `<span class="phase">${esc(g.players[ev.active].name)} · ${esc(ev.phase)}</span>` : ''}<span class="txt">${esc(ev.text)}</span>${ev.mana && ev.mana.spent.length ? `<span class="paid" title="Mana spent">${manaPips(ev.mana.spent)}</span>` : ''}`;
    $("#pos").textContent = `step ${state.idx + 1}`;
    const finalEv = state.events[state.events.length - 1];
    const table = $('#table');
    table.innerHTML = g.players.map((p, i) => {
      const s = snap.players[i];
      const d = seatDecks()[i];
      const colors = deckColors(d);
      const isWinner = ev.kind === 'win' && g.winner === i;
      const cls = ['seat', ev.active === i && ev.turn ? 'active' : '', snap.target === i && (ev.kind === 'attack' || ev.kind === 'block' || ev.kind === 'damage') ? 'targeted' : '', s.lost ? 'dead' : '', isWinner ? 'winner' : ''].join(' ');
      const bf = s.bf.filter((b) => state.meta[b.id]);
      const isCr = (b) => (b.cr != null ? !!b.cr : state.meta[b.id].creature);
      const lands = bf.filter((b) => state.meta[b.id].land && !isCr(b));
      const creatures = bf.filter((b) => isCr(b));
      const others = bf.filter((b) => !state.meta[b.id].land && !isCr(b));
      const byId = Object.fromEntries(bf.map((b) => [b.id, b]));
      const nameOf = (id) => (state.meta[id] ? state.meta[id].name : '');
      const cmdDmg = Object.entries(s.cmdDmg).filter(([, v]) => v > 0).map(([k, v]) => `<span class="cmddmg" title="Commander damage from ${esc(nameOf(k))}">${esc(nameOf(k).split(',')[0])} <b>${v}</b>/21</span>`).join('');
      const lifeCls = ['life', s.life <= 10 ? 'low' : '', prevSnap && prevSnap.players[i].life > s.life ? 'flash-down' : '', prevSnap && prevSnap.players[i].life < s.life ? 'flash-up' : ''].join(' ');
      const tiles = (list) => list.length ? list.map((b) => cardTile(b, focus.has(b.id), atk.has(b.id), blk.has(b.id), b.at && byId[b.at] ? nameOf(b.at) : null)).join('') : '<span class="empty">none</span>';
      const hand = state.showHands ? `<div class="zone hand"><span class="zl">Hand ${s.hand.length}</span>${s.hand.length ? s.hand.map((id) => cardTile({ id }, focus.has(id))).join('') : '<span class="empty">empty</span>'}</div>` : '';
      const cmdTiles = s.command.map((id) => cardTile({ id }, focus.has(id))).join('');
      const status = s.lost ? `<span class="badge out" title="${esc(s.lostReason)}">Out</span>` : isWinner ? '<span class="badge win">Winner</span>' : '';
      return `<section class="${cls} pos${i}" aria-label="${esc(p.name)}">
        <div class="seat-head">
          <div class="pips">${colors.map((c) => `<span class="pip" style="background:${MANA[c]}"></span>`).join('')}</div>
          <div class="seat-name"><b>${esc(d.name)}</b><small>${esc(d.commander)}</small></div>
          <div class="stats"><span>Hand <b>${s.hand.length}</b></span><span>Lib <b>${s.lib}</b></span><button type="button" class="zbtn" data-zone="gy" data-seat="${i}" title="Look through ${esc(d.name)}'s graveyard">GY <b>${s.gy.length}</b></button>${s.ex.length ? `<button type="button" class="zbtn" data-zone="ex" data-seat="${i}" title="Look through ${esc(d.name)}'s exile">Exile <b>${s.ex.length}</b></button>` : ''}${s.tax ? `<span>Tax <b>+${s.tax * 2}</b></span>` : ''}${s.poison ? `<span class="cmddmg">Poison <b>${s.poison}</b></span>` : ''}${cmdDmg}</div>
          ${status}
          <div class="${lifeCls}" aria-label="Life ${s.life}">${s.life}</div>
        </div>
        ${(() => { const paid = ev.mana && ev.mana.seat === i ? ev.mana.spent : []; const fl = poolList(s.fl || {}); return paid.length || fl.length ? `<div class="tray">${paid.length ? `<span class="tl">Paid</span>${manaPips(paid, 'fresh')}` : ''}${fl.length ? `<span class="tl">Floating</span>${manaPips(fl, 'float')}` : ''}</div>` : ''; })()}
        <div class="seat-body">
          <div class="zone">${cmdTiles ? `<span class="zl">Command</span>${cmdTiles}` : ''}<span class="zl">Creatures ${creatures.length}</span>${creatures.length ? tiles(creatures) : '<span class="empty">none</span>'}</div>
          ${others.length ? `<div class="zone"><span class="zl">Other ${others.length}</span>${tiles(others)}</div>` : ''}
          <div class="lands"><span class="zl">Lands ${lands.length}</span>${lands.length ? landChips(lands, focus) : '<span class="empty">none</span>'}</div>
          ${hand}
        </div>
      </section>`;
    }).join('') + `<div class="spin" aria-hidden="true" title="Turn order goes clockwise"><svg viewBox="0 0 48 48"><path d="M24 6a18 18 0 1 1-16.6 11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M3 10l4.6 8.4L16 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
  }

  // The play-by-play only lists what has already happened, so it never spoils the game
  function logItem(e, i) {
    const sw = e.seat != null ? `<span class="sw" style="background:${seatSwatch(e.seat)}"></span>` : '';
    return `<li data-i="${i}" class="k-${e.kind}">${e.kind === 'turn' ? '' : sw}${esc(e.text)}</li>`;
  }
  function renderLog() {
    state.logShown = -1;
    $('#log').innerHTML = '';
    markLog();
  }
  function seatSwatch(i) { const c = deckColors(seatDecks()[i]); return c.length === 1 ? MANA[c[0]] : 'var(--mM)'; }
  function markLog() {
    const log = $('#log');
    if (state.idx < state.logShown) {
      log.querySelectorAll('li').forEach((li) => { if (+li.dataset.i > state.idx) li.remove(); });
      state.logShown = state.idx;
    } else if (state.idx > state.logShown) {
      let html = '';
      for (let i = state.logShown + 1; i <= state.idx; i++) html += logItem(state.events[i], i);
      log.insertAdjacentHTML('beforeend', html);
      state.logShown = state.idx;
    }
    const prev = log.querySelector('li.cur'); if (prev) prev.classList.remove('cur');
    let li = log.querySelector(`li[data-i="${state.idx}"]`);
    for (let i = state.idx; !li && i >= 0; i--) li = log.querySelector(`li[data-i="${i}"]`);
    if (li) {
      li.classList.add('cur');
      log.scrollTop = log.scrollHeight;
    }
  }

  // Graveyard / exile browser; follows the game as it plays
  function renderZone() {
    const el = $('#zoneView');
    const zv = state.zoneView;
    if (!zv || !state.events[state.idx]) { el.hidden = true; return; }
    const sp = state.events[state.idx].snap.players[zv.seat];
    const ids = (zv.zone === 'gy' ? sp.gy : sp.ex || []).slice().reverse();
    const d = seatDecks()[zv.seat];
    el.hidden = false;
    $('#zoneTitle').textContent = `${d.name}'s ${zv.zone === 'gy' ? 'graveyard' : 'exile'} · ${ids.length} card${ids.length === 1 ? '' : 's'}`;
    $('#zoneCards').innerHTML = ids.length ? ids.map((id) => cardTile({ id }, false)).join('') : '<span class="empty">Empty.</span>';
  }

  function renderInspect() {
    const el = $('#inspect');
    let m = state.inspect != null && state.meta[state.inspect];
    if (m) {
      const ev = state.events[state.idx];
      const live = ev && ev.snap.players.flatMap((x) => x.bf).find((b) => b.id === state.inspect);
      if (live && live.nm) m = { ...m, name: live.nm, text: live.tx || m.text };
    }
    if (!m) { el.hidden = true; return; }
    el.hidden = false;
    el.style.setProperty('--frame', frameColor(m.colors));
    const cost = m.cost ? m.cost.split(' ').map((t) => `{${t}}`).join('') : '';
    el.innerHTML = `<button type="button" class="x" aria-label="Close">×</button><div class="ipic">${artSvg(m, state.inspect)}</div><h3>${esc(m.name)}</h3><div class="cost">${esc(cost)}</div><div class="tl">${esc(m.types)}${m.token ? ' · token' : ''}${m.cmd ? ' · commander' : ''}</div><p>${esc(m.text || '')}</p>${m.pt ? `<div class="ptl">${esc(m.pt)}</div>` : ''}`;
  }

  // ---------- batch stats ----------
  function runStats() {
    const N = 100;
    const ds = seatDecks();
    const panel = $('#statsOut');
    const btn = $('#runStats');
    btn.disabled = true;
    const wins = [0, 0, 0, 0]; let draws = 0, rounds = 0, done = 0;
    const base = Math.floor(Math.random() * 1e9);
    panel.innerHTML = `<div class="progress"><div id="prog"></div></div>`;
    const step = () => {
      const t0 = performance.now();
      while (done < N && performance.now() - t0 < 40) {
        // rotate seating so turn order doesn't favour one deck
        const rot = done % 4;
        const order = [0, 1, 2, 3].map((k) => (k + rot) % 4);
        const g = new Game(order.map((k) => ds[k]), db, base + done, { record: false }).run();
        if (g.winner == null) draws++; else wins[order[g.winner]]++;
        rounds += g.round; done++;
      }
      const prog = $('#prog'); if (prog) prog.style.width = (done / N * 100) + '%';
      if (done < N) { setTimeout(step, 0); return; }
      btn.disabled = false;
      const max = Math.max(...wins, 1);
      panel.innerHTML = ds.map((d, i) => `<div class="bar-row"><span>${esc(d.name)}</span><div class="bar"><div style="width:${wins[i] / max * 100}%;background:${seatSwatch(i)}"></div></div><span class="v">${wins[i]} wins · ${Math.round(wins[i] / N * 100)}%</span></div>`).join('')
        + `<p>${N} games, seats rotated each game. Average game length ${(rounds / N).toFixed(1)} rounds${draws ? `, ${draws} hit the 30-round limit` : ''}.</p>`;
    };
    setTimeout(step, 0);
  }

  initControls();
  updatePlayBtn();
  newGame(true);
})();
