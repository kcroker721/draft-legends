'use strict';

// ── Position → eligible lineup slots (NBA API positions: G/F/C/G-F/F-G/F-C/C-F) ──
const SLOT_ELIGIBLE = {
  'G':   ['PG', 'SG'],
  'F':   ['SF', 'PF'],
  'C':   ['C'],
  'G-F': ['SG', 'SF'],
  'F-G': ['SG', 'SF'],
  'F-C': ['PF', 'C'],
  'C-F': ['PF', 'C'],
};

const POSITIONS    = ['PG', 'SG', 'SF', 'PF', 'C'];
const POS_FULLNAME = {
  PG: 'Point Guard', SG: 'Shooting Guard',
  SF: 'Small Forward', PF: 'Power Forward', C: 'Center'
};
const ALL_DECADES = ['1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s'];

// ── State ─────────────────────────────────────────────────────────────────────
let allPlayers      = {};   // { name: { pos, teamSeasons: { key: {season,team,pts,…} } } }
let teamRosters     = {};   // { "2010s_MIL": [name, …] }
let lineup          = { PG: null, SG: null, SF: null, PF: null, C: null };
let currentRoster   = [];
let selectedPlayer  = null;
let reSpinAvailable = false;
let currentSpinKey  = null;

const pra = p => p.pts * 1.5 + p.reb + p.ast;

// ── Boot ──────────────────────────────────────────────────────────────────────
fetch('data/players.json')
  .then(r => r.json())
  .then(data => {
    teamRosters = data.teamRosters || {};
    const raw   = data.players || {};

    // Support both new dict format {name: {pos, teamSeasons}} and
    // old array format [{name, pos, decades:[]}]
    if (Array.isArray(raw)) {
      for (const p of raw) {
        const teamSeasons = {};
        for (const d of (p.decades || [])) {
          const key = `${d.decade}_${d.team}`;
          teamSeasons[key] = d;
          // Also index by decade alone so roster lookup works
          // (old format didn't split per-team)
        }
        // For old format: build teamSeasons from each decade entry
        // The key matches what teamRosters uses
        allPlayers[p.name] = { pos: p.pos || 'F', teamSeasons };
      }
    } else {
      allPlayers = raw;
    }
  })
  .catch(() => {
    document.querySelector('main').innerHTML =
      '<p style="color:#ef4444;text-align:center;padding:2rem">' +
      'Failed to load data. Serve via <code>npx serve .</code></p>';
  });

// ── Spin ──────────────────────────────────────────────────────────────────────
function spin() {
  if (isLineupFull()) return;
  reSpinAvailable = true;
  document.getElementById('respin-btn').style.display = '';
  doSpin();
}

function reSpin() {
  if (!reSpinAvailable) return;
  reSpinAvailable = false;
  document.getElementById('respin-btn').style.display = 'none';
  doSpin();
}

function continueGame() {
  document.getElementById('continue-btn').style.display = 'none';
  document.getElementById('spin-btn').style.display     = '';
  spin();
}

function doSpin() {
  selectedPlayer = null;
  clearPickTargets();
  document.getElementById('roster-section').style.display = 'none';
  document.querySelectorAll('.roster-card').forEach(c => c.classList.remove('selected'));

  // Equal weight per decade; only spin team-decades with enough players
  const decade     = ALL_DECADES[Math.floor(Math.random() * ALL_DECADES.length)];
  const decadeKeys = Object.keys(teamRosters)
    .filter(k => k.startsWith(decade + '_') && teamRosters[k].length >= 6);
  if (!decadeKeys.length) { doSpin(); return; }

  currentSpinKey   = decadeKeys[Math.floor(Math.random() * decadeKeys.length)];
  const team       = currentSpinKey.slice(decade.length + 1);

  // Animate spin badges
  const badges = document.getElementById('spin-badges');
  document.getElementById('spin-decade').textContent = decade;
  document.getElementById('spin-team').textContent   = team;
  badges.style.display = 'flex';
  badges.classList.remove('pop');
  void badges.offsetWidth;
  badges.classList.add('pop');

  document.getElementById('respin-btn').style.display = reSpinAvailable ? '' : 'none';

  // Build roster: players sorted by PRA using their team-specific stats
  const names = teamRosters[currentSpinKey] || [];
  const cards = names.map(name => {
    const player = allPlayers[name];
    if (!player) return null;
    const stats = player.teamSeasons
      ? player.teamSeasons[currentSpinKey]
      // Fallback for old array-format data: search by decade prefix
      : Object.entries(player).find(([k]) => k.startsWith(decade + '_'))?.[1];
    if (!stats) return null;
    return { name, pos: player.pos || 'F', ...stats };
  }).filter(Boolean);

  cards.sort((a, b) => pra(b) - pra(a));
  currentRoster = cards.slice(0, 12);

  renderRoster();
  document.getElementById('roster-section').style.display = '';
}

// ── Render roster ─────────────────────────────────────────────────────────────
function renderRoster() {
  const grid = document.getElementById('roster-grid');
  grid.innerHTML = '';

  for (const p of currentRoster) {
    const eligible    = SLOT_ELIGIBLE[p.pos] || ['SF', 'PF'];
    const hasOpenSlot = eligible.some(slot => lineup[slot] === null);

    const card = document.createElement('div');
    card.className = 'roster-card' + (hasOpenSlot ? '' : ' unavailable');
    card.innerHTML =
      `<div class="rc-top">` +
        `<span class="rc-name">${p.name}</span>` +
        `<span class="rc-pos">${p.pos}</span>` +
      `</div>` +
      `<span class="rc-stats">${p.pts} PTS &nbsp;·&nbsp; ${p.reb} REB &nbsp;·&nbsp; ${p.ast} AST</span>` +
      `<span class="rc-meta">${p.season}</span>`;

    if (hasOpenSlot) card.onclick = () => selectPlayer(p, card);
    grid.appendChild(card);
  }
}

// ── Select player → highlight eligible lineup slots ───────────────────────────
function selectPlayer(player, cardEl) {
  document.querySelectorAll('.roster-card').forEach(c => c.classList.remove('selected'));
  cardEl.classList.add('selected');
  selectedPlayer = player;

  clearPickTargets();

  const eligible = SLOT_ELIGIBLE[player.pos] || ['SF', 'PF'];
  for (const slot of POSITIONS) {
    const el = document.getElementById(`slot-${slot}`);
    if (eligible.includes(slot) && lineup[slot] === null) {
      el.classList.add('pick-target');
      el.onclick = () => assignPosition(slot);
    } else if (lineup[slot] === null) {
      el.classList.add('pick-disabled');
    }
  }

  // Scroll up so user sees the highlighted slots
  document.getElementById('lineup-grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearPickTargets() {
  for (const slot of POSITIONS) {
    const el = document.getElementById(`slot-${slot}`);
    el.classList.remove('pick-target', 'pick-disabled');
    el.onclick = null;
  }
}

// ── Assign player to lineup slot ──────────────────────────────────────────────
function assignPosition(slot) {
  if (!selectedPlayer || lineup[slot] !== null) return;
  lineup[slot] = selectedPlayer;

  const el = document.getElementById(`slot-${slot}`);
  el.classList.remove('pick-target', 'pick-disabled');
  el.classList.add('filled');
  el.onclick = null;
  el.querySelector('.ls-name').textContent = selectedPlayer.name;
  el.querySelector('.ls-info').textContent =
    `${selectedPlayer.pts} · ${selectedPlayer.reb} · ${selectedPlayer.ast}` +
    `  ·  ${selectedPlayer.decade || currentSpinKey.split('_')[0]} ${selectedPlayer.team}`;

  clearPickTargets();
  document.getElementById('roster-section').style.display = 'none';
  document.getElementById('spin-badges').style.display    = 'none';
  document.getElementById('respin-btn').style.display     = 'none';
  document.getElementById('spin-btn').style.display       = 'none';
  selectedPlayer  = null;
  reSpinAvailable = false;

  if (isLineupFull()) {
    document.getElementById('season-btn').style.display   = '';
  } else {
    document.getElementById('continue-btn').style.display = '';
  }
}

function isLineupFull() {
  return POSITIONS.every(p => lineup[p] !== null);
}

// ── Simulate season ───────────────────────────────────────────────────────────
function showResult() {
  const total = POSITIONS.reduce((s, p) => s + (lineup[p] ? pra(lineup[p]) : 0), 0);
  const { wins, losses, tier, emoji, flavor } = getRecord(total);

  document.getElementById('result-emoji').textContent  = emoji;
  document.getElementById('result-record').textContent = `${wins}–${losses}`;
  document.getElementById('result-tier').textContent   = tier;
  document.getElementById('result-flavor').textContent = flavor;

  const lineupEl = document.getElementById('result-lineup');
  lineupEl.innerHTML = '';
  for (const slot of POSITIONS) {
    const p   = lineup[slot];
    const row = document.createElement('div');
    row.className = 'rr';
    row.innerHTML =
      `<span class="rr-slot">${slot}</span>` +
      `<span class="rr-name">${p.name}</span>` +
      `<span class="rr-meta">${p.team}</span>` +
      `<span class="rr-score">${pra(p).toFixed(1)}</span>`;
    lineupEl.appendChild(row);
  }
  const totRow = document.createElement('div');
  totRow.className = 'rr rr-total';
  totRow.innerHTML =
    `<span class="rr-slot"></span><span class="rr-name">Total</span>` +
    `<span class="rr-meta"></span><span class="rr-score">${total.toFixed(1)}</span>`;
  lineupEl.appendChild(totRow);

  document.getElementById('spin-area').style.display      = 'none';
  document.getElementById('lineup-grid').style.display    = 'none';
  document.getElementById('season-btn').style.display     = 'none';
  document.getElementById('result-section').style.display = '';
}

// ── Record thresholds ─────────────────────────────────────────────────────────
function getRecord(score) {
  if (score >= 275) return { wins: 82, losses:  0, tier: 'Perfect Season',         emoji: '🏆', flavor: 'Undefeated. Undisputed. The greatest team ever assembled.' };
  if (score >= 252) return { wins: 76, losses:  6, tier: 'Dynasty',                emoji: '🔥', flavor: 'Banners get raised for this. A legendary squad.' };
  if (score >= 230) return { wins: 70, losses: 12, tier: 'Elite',                  emoji: '⭐', flavor: 'Top seed in both conferences. This squad runs the league.' };
  if (score >= 210) return { wins: 65, losses: 17, tier: 'Championship Contender', emoji: '💪', flavor: 'Deep playoff run guaranteed. Dark horse for the title.' };
  if (score >= 190) return { wins: 58, losses: 24, tier: 'Playoff Staple',         emoji: '📈', flavor: 'Solid squad. Second round floor, Finals ceiling.' };
  if (score >= 168) return { wins: 50, losses: 32, tier: 'Bubble Team',            emoji: '🏀', flavor: 'On the right side of the play-in. Hope for first-round upsets.' };
  if (score >= 148) return { wins: 42, losses: 40, tier: 'Mediocre',               emoji: '😐', flavor: 'Play-in territory. Might just squeak in.' };
  if (score >= 125) return { wins: 32, losses: 50, tier: 'Rebuilding',             emoji: '📉', flavor: 'Lottery-bound. Tank and trust the process.' };
  if (score >= 100) return { wins: 20, losses: 62, tier: 'Rough Year',             emoji: '😬', flavor: 'At least you got a good draft pick.' };
  return                   { wins: 10, losses: 72, tier: 'All-Time Bad',            emoji: '💀', flavor: 'History will not be kind. Even the refs felt bad for you.' };
}

// ── Reset ─────────────────────────────────────────────────────────────────────
function resetGame() {
  lineup          = { PG: null, SG: null, SF: null, PF: null, C: null };
  currentRoster   = [];
  selectedPlayer  = null;
  reSpinAvailable = false;

  for (const slot of POSITIONS) {
    const el = document.getElementById(`slot-${slot}`);
    el.className = 'lineup-slot';
    el.onclick   = null;
    el.querySelector('.ls-name').textContent = POS_FULLNAME[slot];
    el.querySelector('.ls-info').textContent = '';
  }

  document.getElementById('spin-area').style.display      = '';
  document.getElementById('spin-btn').style.display       = '';
  document.getElementById('lineup-grid').style.display    = '';
  document.getElementById('spin-badges').style.display    = 'none';
  document.getElementById('roster-section').style.display = 'none';
  document.getElementById('continue-btn').style.display   = 'none';
  document.getElementById('season-btn').style.display     = 'none';
  document.getElementById('result-section').style.display = 'none';
}
