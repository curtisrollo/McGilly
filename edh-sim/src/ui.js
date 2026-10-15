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
  // the trained neural network (data/nn.json), if this build has one
  const NN = window.POD_DATA.nn ? Game.loadNN(window.POD_DATA.nn) : null;
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
    $('#openMore').addEventListener('click', () => { $('#more').hidden = false; renderChecks(); renderBrain(); });
    $('#checkFilter').addEventListener('input', renderChecks);
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
    const g = new Game(seatDecks(), db, state.seed, { record: true, nn: NN });
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
    // one step forward: the cards move first, then the play-by-play catches up
    const dur = state.idx === prev + 1 ? animDur() : 0;
    const before = dur ? captureCards() : null;
    render(prev);
    if (before) animateFrom(before, dur, prev);
    clearTimeout(state.logTimer);
    if (dur) state.logTimer = setTimeout(markLog, dur * 0.8); else markLog();
    if (state.zoneView) renderZone();
  }
  // how long the card movements take: a share of the time this step is on screen
  function animDur() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
    const ev = state.events[state.idx];
    const step = state.playing ? ((BASE_DELAY[ev.kind] ?? 750) * PACE) / state.speed : 900;
    return step < 160 ? 0 : Math.min(650, Math.max(180, step * 0.45));
  }

  // ---------- movement ----------
  // Before re-rendering, remember where every card is; afterwards slide each card from where it was
  // (hand → stack → battlefield, battlefield → graveyard, ...) so the table shows what happened.
  function captureCards() {
    const m = new Map();
    document.querySelectorAll('#table [data-card]').forEach((el) => { const id = el.dataset.card; if (!m.has(id)) m.set(id, { r: el.getBoundingClientRect(), html: el.outerHTML, land: el.classList.contains('land') }); });
    return m;
  }
  function anchorRect(seat, zone) { const el = document.querySelector(`#table [data-anchor="${zone}-${seat}"]`); return el ? el.getBoundingClientRect() : null; }
  // where a card is now, for cards that left the table view (graveyard, exile, hand, library, command zone)
  function whereNow(id, snap) {
    for (let i = 0; i < snap.players.length; i++) {
      const s = snap.players[i];
      if (s.gy.includes(+id)) return [i, 'gy'];
      if ((s.ex || []).includes(+id)) return [i, 'ex'];
      if (s.command.includes(+id)) return [i, 'cmd'];
      if (s.hand.includes(+id)) return [i, 'hand'];
    }
    const m = state.meta[id]; return m ? [m.owner, 'lib'] : null;
  }
  function whereBefore(id, snap) { return snap ? whereNow(id, snap) : null; }
  function animateFrom(before, dur, prevIdx) {
    const ev = state.events[state.idx];
    const prevSnap = state.events[prevIdx] && state.events[prevIdx].snap;
    const ease = 'cubic-bezier(.2,.8,.2,1)';
    const seen = new Set();
    document.querySelectorAll('#table [data-card]').forEach((el) => {
      const id = el.dataset.card;
      if (seen.has(id)) return; seen.add(id);
      const r = el.getBoundingClientRect();
      const old = before.get(id);
      let from = old && old.r, fresh = false;
      if (!from) { const w = whereBefore(id, prevSnap); from = w ? anchorRect(w[0], w[1]) : null; fresh = true; }
      if (!from || !r.width) return;
      const dx = from.left + from.width / 2 - (r.left + r.width / 2), dy = from.top + from.height / 2 - (r.top + r.height / 2);
      if (Math.hypot(dx, dy) < 4) return;
      const sc = Math.max(0.35, Math.min(1.6, from.width / r.width));
      el.animate([{ translate: `${dx}px ${dy}px`, scale: fresh ? 0.4 : sc, opacity: fresh ? 0.3 : 1 }, { translate: '0 0', scale: 1, opacity: 1 }], { duration: dur, easing: ease });
    });
    // cards that left: a copy flies from where it was to where it went, then disappears
    for (const [id, o] of before) {
      if (seen.has(id) || o.land) continue;
      const w = whereNow(id, ev.snap); const to = w ? anchorRect(w[0], w[1]) : null;
      const ph = document.createElement('div');
      ph.className = 'phantom'; ph.innerHTML = o.html;
      Object.assign(ph.style, { left: o.r.left + 'px', top: o.r.top + 'px', width: o.r.width + 'px', height: o.r.height + 'px' });
      document.body.appendChild(ph);
      const dx = to ? to.left + to.width / 2 - (o.r.left + o.r.width / 2) : 0, dy = to ? to.top + to.height / 2 - (o.r.top + o.r.height / 2) : 12;
      const a = ph.animate([{ translate: '0 0', scale: 1, opacity: 1 }, { translate: `${dx * 0.3}px ${dy * 0.3}px`, scale: 1.05, opacity: 1, offset: 0.25 }, { translate: `${dx}px ${dy}px`, scale: 0.3, opacity: 0.1 }], { duration: dur * 1.3, easing: 'ease-in' });
      a.onfinish = a.oncancel = () => ph.remove();
    }
    // combat: attackers lunge at the player they attack; blockers step in front of their attacker
    const seatRect = (i) => { const el = document.querySelector(`#table .seat.pos${i}`); return el ? el.getBoundingClientRect() : null; };
    const lunge = (el, tr, k, d) => { const r = el.getBoundingClientRect(); const dx = (tr.left + tr.width / 2 - (r.left + r.width / 2)) * k, dy = (tr.top + tr.height / 2 - (r.top + r.height / 2)) * k; el.animate([{ translate: '0 0' }, { translate: `${dx}px ${dy}px`, offset: 0.45 }, { translate: '0 0' }], { duration: d, easing: 'ease-in-out' }); };
    const tgt = ev.snap.target != null ? seatRect(ev.snap.target) : null;
    if (tgt && (ev.kind === 'attack' || ev.kind === 'damage')) for (const a of ev.snap.attackers || []) { const el = document.querySelector(`#table .c[data-card="${a.id}"]`); if (el) lunge(el, tgt, ev.kind === 'damage' ? 0.35 : 0.12, dur * 1.2); }
    if (ev.kind === 'block') for (const b of ev.snap.blockers || []) { const el = document.querySelector(`#table .c[data-card="${b.id}"]`); const at = document.querySelector(`#table .c[data-card="${b.blocks}"]`); if (el && at) lunge(el, at.getBoundingClientRect(), 0.3, dur * 1.2); }
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
    const fx = state.fx && state.fx.get(b.id);
    const cls = ['c', fx ? fx.cls : '', state.tappedFor && state.tappedFor.has(b.id) ? 'manasrc' : '', b.tp ? 'tapped' : '', m.token ? 'token' : '', m.cmd ? 'cmd' : '', b.sk ? 'sick' : '', focus ? 'focus' : '', atk ? 'atk' : '', blk ? 'blk' : ''].join(' ');
    const ty = m.types.replace(/^Legendary /, '').split(' — ')[0];
    return `<button type="button" class="${cls}" style="--frame:${frameColor(m.colors)}" data-card="${b.id}" title="${esc(m.name)}">
      <span class="n">${esc(m.name)}</span><span class="pic">${artSvg(m, b.id)}</span>${attachName ? `<span class="att">⚲ ${esc(attachName)}</span>` : ''}
      <span class="ty">${esc(ty)}</span>${b.ctr ? `<span class="ctr">+${b.ctr}</span>` : ''}${pt}${fx && fx.label ? `<span class="fxl ${fx.tone}">${esc(fx.label)}</span>` : ''}</button>`;
  }

  function landChips(lands, focus) {
    const groups = new Map();
    for (const b of lands) {
      const m = state.meta[b.id];
      const nm = b.nm || m.name;
      const g = groups.get(nm) || { n: 0, tapped: 0, id: b.id, focus: false, colors: m };
      g.n++; if (b.tp) g.tapped++; if (focus.has(b.id)) g.focus = true; if (state.tappedFor && state.tappedFor.has(b.id)) g.src = true; groups.set(nm, g);
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
    // Visual effects: what changed on each permanent since the previous step (only when stepping forward)
    state.fx = new Map();
    const ghosts = {};
    if (prevSnap && prevIdx === state.idx - 1) {
      const prevAll = new Map(prevSnap.players.flatMap((pl, si) => pl.bf.map((b) => [b.id, { b, si }])));
      const nowAll = new Map(snap.players.flatMap((pl) => pl.bf.map((b) => [b.id, b])));
      for (const [id, b] of nowAll) {
        const o = prevAll.get(id);
        if (!o) { state.fx.set(id, { cls: 'fx-enter' }); continue; }
        const a = o.b; const out = [];
        let tone = '';
        if (b.p != null && a.p != null && (b.p !== a.p || b.t !== a.t)) { const dp = b.p - a.p, dt = b.t - a.t; out.push(`${dp >= 0 ? '+' : ''}${dp}/${dt >= 0 ? '+' : ''}${dt}`); tone = dp + dt >= 0 ? 'up' : 'down'; }
        if ((b.dm || 0) > (a.dm || 0)) { out.push(`−${b.dm - (a.dm || 0)}`); tone = 'down'; }
        if (b.l != null && a.l != null && b.l !== a.l) { out.push(`${b.l > a.l ? '+' : ''}${b.l - a.l}`); tone = b.l > a.l ? 'up' : 'down'; }
        if ((b.ctr || 0) > (a.ctr || 0) && !out.length) { out.push(`+${b.ctr - (a.ctr || 0)} counter`); tone = 'up'; }
        const swapped = (b.nm || '') !== (a.nm || '');
        if (out.length || swapped) state.fx.set(id, { cls: swapped ? 'fx-morph' : tone === 'down' ? 'fx-hurt' : 'fx-buff', label: out.join(' '), tone });
        else if (focus.has(id) && ['removal', 'effect', 'trigger', 'ability', 'response'].includes(ev.kind)) state.fx.set(id, { cls: 'fx-touch' });
      }
      // permanents that just left: show a fading ghost for one step
      for (const [id, o] of prevAll) if (!nowAll.has(id) && state.meta[id]) (ghosts[o.si] = ghosts[o.si] || []).push(o.b);
    }
    // what is happening now, in the middle of the table
    const now = $('#now');
    now.className = 'now k-' + ev.kind;
    now.innerHTML = `<div class="now-top"><span class="turn">${ev.turn ? 'Turn ' + ev.turn : 'Setup'}</span>${ev.phase && ev.turn ? `<span class="phase">${esc(g.players[ev.active].name)} · ${esc(ev.phase)}</span>` : ''}${ev.mana && ev.mana.spent.length ? `<span class="paid" title="Mana spent">${manaPips(ev.mana.spent)}</span>` : ''}</div><div class="txt">${ev.seat != null ? `<span class="sw" style="background:${seatSwatch(ev.seat)}"></span>` : ''}${esc(ev.text)}${nnTag(ev)}</div>${ev.wp ? `<div class="wpbar" title="The neural network's win estimate for each player">${ev.wp.map((w, k) => (w > 0 ? `<i style="flex:${w};background:${seatSwatch(k)}" title="${esc(g.players[k].name)} ${w}%"></i>` : '')).join('')}</div>` : ''}`;
    const stack = snap.stack || [];
    $('#stack').innerHTML = stack.length ? `<span class="zl">Stack</span>${stack.map((id) => cardTile({ id }, true)).join('')}` : '';
    $('#stack').classList.toggle('on', stack.length > 0);
    const pct = state.events.length > 1 ? Math.round((state.idx / (state.events.length - 1)) * 100) : 100;
    $('#pos').textContent = `step ${state.idx + 1}/${state.events.length} · ${pct}%`;
    $('#pos').style.setProperty('--pct', pct + '%');
    const alive = snap.players.filter((x) => !x.lost).length;
    const table = $('#table');
    table.classList.toggle('duel', alive === 2 && g.players.length === 4);
    table.classList.toggle('three', alive === 3);
    $('#seatsHost').innerHTML = g.players.map((p, i) => {
      const s = snap.players[i];
      const d = seatDecks()[i];
      const colors = deckColors(d);
      const isWinner = ev.kind === 'win' && g.winner === i;
      const aliveIdx = snap.players.map((x, k) => (x.lost ? -1 : k)).filter((k) => k >= 0);
      const duelSide = alive === 2 ? (aliveIdx[0] === i ? 'duelL' : aliveIdx[1] === i ? 'duelR' : '') : '';
      const cls = ['seat', duelSide, ev.active === i && ev.turn ? 'active' : '', snap.target === i && (ev.kind === 'attack' || ev.kind === 'block' || ev.kind === 'damage') ? 'targeted' : '', s.lost ? 'dead' : '', isWinner ? 'winner' : ''].join(' ');
      const bf = s.bf.filter((b) => state.meta[b.id]);
      const isCr = (b) => (b.cr != null ? !!b.cr : state.meta[b.id].creature);
      const isLandB = (b) => state.meta[b.id].land || !!b.ld;
      const lands = bf.filter((b) => isLandB(b) && !isCr(b));
      const creatures = bf.filter((b) => isCr(b));
      const others = bf.filter((b) => !isLandB(b) && !isCr(b));
      const byId = Object.fromEntries(bf.map((b) => [b.id, b]));
      const nameOf = (id) => (state.meta[id] ? state.meta[id].name : '');
      const cmdDmg = Object.entries(s.cmdDmg).filter(([, v]) => v > 0).map(([k, v]) => `<span class="cmddmg" title="Commander damage from ${esc(nameOf(k))}">${esc(nameOf(k).split(',')[0])} <b>${v}</b>/21</span>`).join('');
      const lifeCls = ['life', s.life <= 10 ? 'low' : '', prevSnap && prevSnap.players[i].life > s.life ? 'flash-down' : '', prevSnap && prevSnap.players[i].life < s.life ? 'flash-up' : ''].join(' ');
      const tiles = (list) => list.length ? list.map((b) => cardTile(b, focus.has(b.id), atk.has(b.id), blk.has(b.id), b.at && byId[b.at] ? nameOf(b.at) : null)).join('') : '<span class="empty">none</span>';
      const ghostTiles = '';
      const hand = state.showHands ? `<div class="zone hand" data-anchor="hand-${i}"><span class="zl">Hand ${s.hand.length}</span>${s.hand.length ? s.hand.map((id) => cardTile({ id }, focus.has(id))).join('') : '<span class="empty">empty</span>'}</div>` : '';
      // the commander's own slot: in the command zone, or out on the battlefield (or elsewhere)
      const cmdId = Object.keys(state.meta).find((id) => state.meta[id].cmd && state.meta[id].owner === i);
      const cmdWhere = cmdId == null ? '' : s.command.includes(+cmdId) ? 'command' : s.bf.some((b) => b.id === +cmdId) ? 'battlefield' : s.hand.includes(+cmdId) ? 'hand' : s.gy.includes(+cmdId) ? 'graveyard' : (s.ex || []).includes(+cmdId) ? 'exile' : 'library';
      const cmdSlot = cmdId == null ? '' : `<div class="cmdslot ${cmdWhere}" data-anchor="cmd-${i}" title="Commander: ${esc(state.meta[cmdId].name)}"><span class="cl">${cmdWhere === 'command' ? 'Command zone' : cmdWhere === 'battlefield' ? 'Commander out' : 'Commander in ' + cmdWhere}${s.tax ? ` · tax +${s.tax * 2}` : ''}</span>${cmdWhere === 'command' ? cardTile({ id: +cmdId }, focus.has(+cmdId)) : `<span class="cmdname">★ ${esc(state.meta[cmdId].name.split(',')[0])}</span>`}</div>`;
      const status = s.lost ? `<span class="badge out" title="${esc(s.lostReason)}">Out</span>` : isWinner ? '<span class="badge win">Winner</span>' : '';
      return `<section class="${cls} pos${i}" aria-label="${esc(p.name)}">
        <div class="seat-head">
          <div class="pips">${colors.map((c) => `<span class="pip" style="background:${MANA[c]}"></span>`).join('')}</div>
          <div class="seat-name"><b>${esc(d.name)}</b><small>${esc(d.commander)}</small>${ev.wp ? `<span class="wp" title="The neural network's estimate of ${esc(d.name)}'s chance to win from here"><i style="width:${ev.wp[i]}%;background:${seatSwatch(i)}"></i><em>${s.lost ? 'out' : Math.round(ev.wp[i]) + '% to win'}</em></span>` : ''}</div>
          <div class="stats"><span${state.showHands ? '' : ` data-anchor="hand-${i}"`}>Hand <b>${s.hand.length}</b></span><span data-anchor="lib-${i}">Lib <b>${s.lib}</b></span><button type="button" class="zbtn" data-anchor="gy-${i}" data-zone="gy" data-seat="${i}" title="Look through ${esc(d.name)}'s graveyard">GY <b>${s.gy.length}</b></button><button type="button" class="zbtn" data-anchor="ex-${i}" data-zone="ex" data-seat="${i}" title="Look through ${esc(d.name)}'s exile">Exile <b>${s.ex.length}</b></button>${s.poison ? `<span class="cmddmg">Poison <b>${s.poison}</b></span>` : ''}${cmdDmg}</div>
          ${status}
          ${cmdSlot}
          <div class="${lifeCls}" aria-label="Life ${s.life}">${s.life}</div>
        </div>
        ${(() => { const paid = ev.mana && ev.mana.seat === i ? ev.mana.spent : []; const fl = poolList(s.fl || {}); return paid.length || fl.length ? `<div class="tray">${paid.length ? `<span class="tl">Paid</span>${manaPips(paid, 'fresh')}` : ''}${fl.length ? `<span class="tl">Floating</span>${manaPips(fl, 'float')}` : ''}</div>` : ''; })()}
        <div class="seat-body">
          <div class="zone"><span class="zl">Creatures ${creatures.length}</span>${creatures.length ? tiles(creatures) : (ghostTiles ? '' : '<span class="empty">none</span>')}${ghostTiles}</div>
          ${others.length ? `<div class="zone"><span class="zl">Other ${others.length}</span>${tiles(others)}</div>` : ''}
          <div class="lands"><span class="zl" title="untapped / total lands">Lands <b class="lu">${lands.filter((b) => !b.tp).length}</b>/${lands.length}</span>${lands.length ? landChips(lands, focus) : '<span class="empty">none</span>'}</div>
          ${hand}
        </div>
      </section>`;
    }).join('');
  }

  // The play-by-play only lists what has already happened, so it never spoils the game
  function logItem(e, i) {
    const sw = e.seat != null ? `<span class="sw" style="background:${seatSwatch(e.seat)}"></span>` : '';
    return `<li data-i="${i}" class="k-${e.kind}">${e.kind === 'turn' ? '' : sw}${esc(e.text)}${nnTag(e)}</li>`;
  }
  // the network's verdict on a spell when it was cast: how much it moved the caster's chance to win
  function nnTag(e) {
    if (e.na == null) return '';
    const v = e.na; const cls = v >= 1 ? 'good' : v <= -1 ? 'bad' : 'meh';
    return ` <span class="nnv ${cls}" title="Neural network: casting this changed ${esc(state.game.players[e.seat].name)}'s predicted chance to win by ${v >= 0 ? '+' : ''}${v} points">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
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
      for (let i = state.idx; i > state.logShown; i--) html += logItem(state.events[i], i);
      log.insertAdjacentHTML('afterbegin', html);
      state.logShown = state.idx;
    }
    const prev = log.querySelector('li.cur'); if (prev) prev.classList.remove('cur');
    let li = log.querySelector(`li[data-i="${state.idx}"]`);
    for (let i = state.idx; !li && i >= 0; i--) li = log.querySelector(`li[data-i="${i}"]`);
    if (li) {
      li.classList.add('cur');
      log.scrollTop = 0;
    }
  }

  // Results of the effect validator (node validate.mjs), embedded at build time
  function renderChecks() {
    const v = window.POD_DATA.validation;
    if (!v) { $('#checkSummary').textContent = 'No validation results in this build.'; return; }
    $('#checkSummary').innerHTML = `Every card is put into a scripted game and each of its effects and triggers is made to happen; the check passes when the game changes the way the card says. Last run: <b>${v.passed}</b> of <b>${v.checks}</b> checks passed across <b>${v.cards}</b> cards with effects${v.failed ? `, <b class="bad">${v.failed} failed</b>` : ''}. Lands with only mana abilities and vanilla creatures have nothing to check. Run it yourself with <code>node validate.mjs</code>.`;
    const f = ($('#checkFilter').value || '').toLowerCase();
    const by = new Map();
    for (const [card, test, ok] of v.results) if (!f || card.toLowerCase().includes(f)) { if (!by.has(card)) by.set(card, []); by.get(card).push([test, ok]); }
    $('#checkList').innerHTML = [...by.entries()].slice(0, 400).map(([card, tests]) => `<div class="chk-row"><span class="chk-card">${esc(card)}</span><span class="chk-tests">${tests.map(([t, ok]) => `<span class="${ok ? 'pass' : 'fail'}">${ok ? '✓' : '✗'} ${esc(t)}</span>`).join('')}</span></div>`).join('') || '<span class="empty">No matching cards.</span>';
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
      if (live && live.nm) m = { ...m, name: live.nm, text: live.tx || m.text, types: live.ty || m.types };
    }
    if (!m) { el.hidden = true; return; }
    el.hidden = false;
    el.style.setProperty('--frame', frameColor(m.colors));
    const cost = m.cost ? m.cost.split(' ').map((t) => `{${t}}`).join('') : '';
    // what this card has done so far this game (results are credited to the card that caused them)
    const tot = {};
    for (let k = 0; k <= state.idx; k++) for (const [id, stat, n] of state.events[k].cr || []) if (id === state.inspect) tot[stat] = (tot[stat] || 0) + n;
    const LBL = { dmg: 'damage / life lost', cards: 'cards drawn', tokens: 'tokens made', removed: 'permanents removed', life: 'life gained', mana: 'mana made', countered: 'spells countered', tutored: 'cards tutored' };
    const did = Object.entries(tot).filter(([, v]) => v).map(([k, v]) => `<span><b>${Math.round(v * 10) / 10}</b> ${LBL[k] || k}</span>`).join('');
    const learned = NN && state.game && state.meta[state.inspect] ? cardInsight(m.name, state.meta[state.inspect].owner) : '';
    el.innerHTML = `<button type="button" class="x" aria-label="Close">×</button><div class="ipic">${artSvg(m, state.inspect)}</div><h3>${esc(m.name)}</h3><div class="cost">${esc(cost)}</div><div class="tl">${esc(m.types)}${m.token ? ' · token' : ''}${m.cmd ? ' · commander' : ''}</div><p>${esc(m.text || '')}</p>${m.pt ? `<div class="ptl">${esc(m.pt)}</div>` : ''}${did ? `<div class="did"><small>This game so far</small>${did}</div>` : ''}${learned}`;
  }

  // the network's average verdict on a card in this deck, from training
  function cardInsight(name, seat) {
    const nn = window.POD_DATA.nn; const d = seatDecks()[seat];
    const ins = nn && nn.insights && d && nn.insights[d.id];
    if (!ins) return '';
    const hit = ins.best.concat(ins.worst).find((x) => x.name === name);
    if (!hit) return '';
    return `<div class="did"><small>Neural network</small><span>On average casting it moves ${esc(d.name)}'s chance to win by <b>${hit.adv >= 0 ? '+' : ''}${(hit.adv * 100).toFixed(1)}</b> points (${hit.n} casts in training)</span></div>`;
  }
  function renderBrain() {
    const nn = window.POD_DATA.nn; const out = $('#brainOut');
    if (!nn) { out.innerHTML = '<p>No trained network in this build. Run <code>node train.mjs</code>.</p>'; return; }
    const name = (id) => (decks.find((d) => d.id === id) || { name: id }).name;
    const h = nn.history || []; const last = h[h.length - 1] || {};
    const ab = nn.ab;
    const pct = (x) => (x * 100).toFixed(1) + '%';
    out.innerHTML = `<p>A neural network (an MLP with two hidden layers of 48 and 24 units, written in plain JavaScript) trained by self-play: ${nn.games.toLocaleString()} games over ${nn.generation} generations. Every spell cast is recorded with what the board looked like and who went on to win, and the network learns to predict a player's chance to win from the board, with and without the card just played. The difference is how much the card helped. The AI adds that to its scoring when it decides what to cast, what to tutor for and what to discard, and a second network judges opening hands for mulligans. Each generation plays with what the last one learned. The bars on each seat are the network's live estimate.</p>
      ${ab ? `<p><b>Does it help?</b> In ${ab.games} test games one random seat used the network and the other three played on the plain heuristics: the network seat won <b>${pct(ab.on)}</b> of its games against <b>${pct(ab.off)}</b> for the others (an even share is 25%).</p>
      <div class="ab">${Object.entries(ab.decks).map(([id, x]) => `<div class="bar-row"><span>${esc(name(id))}</span><div class="bar ab2"><div style="width:${(x.on || 0) * 100}%;background:var(--brass)" title="with network ${pct(x.on || 0)}"></div><div style="width:${(x.off || 0) * 100}%;background:var(--muted)" title="without ${pct(x.off || 0)}"></div></div><span class="v">${x.on != null ? pct(x.on) : '–'} vs ${x.off != null ? pct(x.off) : '–'}</span></div>`).join('')}</div>` : ''}
      <p><b>Training.</b> ${h.map((x) => `Gen ${x.gen}: prediction loss ${x.qLoss} (guessing the average: ${x.qBase})`).join(' · ')}.</p>
      <div class="ins">${Object.entries(nn.insights || {}).map(([id, x]) => `<div class="ins-deck"><h4>${esc(name(id))}</h4><ol>${x.best.slice(0, 6).map((c) => `<li><span>${esc(c.name)}</span><b class="${c.adv > 0 ? 'good' : c.adv < 0 ? 'bad' : ''}">${c.adv >= 0 ? '+' : ''}${(c.adv * 100).toFixed(1)}</b></li>`).join('')}</ol><small>Least helpful when cast</small><ol>${x.worst.slice(0, 3).map((c) => `<li><span>${esc(c.name)}</span><b class="${c.adv < 0 ? 'bad' : ''}">${c.adv >= 0 ? '+' : ''}${(c.adv * 100).toFixed(1)}</b></li>`).join('')}</ol></div>`).join('')}</div>
      <p class="note">Points are the change in the caster's predicted chance to win when the card is cast, averaged over training games. These are also the tutor targets the AI prefers.</p>`;
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
        const g = new Game(order.map((k) => ds[k]), db, base + done, { record: false, nn: NN }).run();
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
