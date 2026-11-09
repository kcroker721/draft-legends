#!/usr/bin/env python3
"""
Build players.json from NBA Stats API.

Key design:
  - Positions from NBA API only (no stats heuristics)
  - Each player tracks their best season PER TEAM PER DECADE
    so spinning "2010s_SAC" shows Isaiah Thomas's SAC stats, not his BOS career best
  - teamRosters ranked by total minutes with that specific team in that decade

Output:
  players      – { name: { pos, teamSeasons: { "2010s_SAC": {season,team,pts,…} } } }
  teamRosters  – { "2010s_SAC": [name, …] }
"""

import json, time, os
from collections import defaultdict

ROOT      = os.path.expanduser('~/Developer/NBADecadesQuiz/data')
CACHE_DIR = os.path.join(ROOT, 'cache')
OUTPUT    = os.path.join(ROOT, 'players.json')

TOP_N   = 20
MIN_MPG = 8
MIN_GP  = 15

# LeagueLeaders (historical endpoint) for pre-1996 seasons
DECADES_HISTORICAL = {
    '1960s': list(range(1959, 1969)),
    '1970s': list(range(1969, 1979)),
    '1980s': list(range(1979, 1989)),
    '1990s': list(range(1989, 1996)),  # 1989-90 through 1995-96
}
# LeagueDashPlayerStats (modern API, cached) for 1996+
DECADES_API = {
    '1990s': list(range(1996, 1999)),  # 1996-97 through 1998-99 (extend 1990s)
    '2000s': list(range(1999, 2009)),
    '2010s': list(range(2009, 2019)),
    '2020s': list(range(2019, 2025)),
}

# Normalize commonPlayerInfo POSITION strings → short codes
POSITION_MAP = {
    'Guard':          'G',
    'Forward':        'F',
    'Center':         'C',
    'Guard-Forward':  'G-F',
    'Forward-Guard':  'F-G',
    'Forward-Center': 'F-C',
    'Center-Forward': 'C-F',
}

os.makedirs(CACHE_DIR, exist_ok=True)


# ── Helpers ───────────────────────────────────────────────────────────────────

def pra(pts, reb, ast):
    return pts * 1.5 + reb + ast


def season_str(y):
    return f'{y}-{str(y + 1)[-2:]}'


def fetch_season(season):
    cache = os.path.join(CACHE_DIR, f'{season}.json')
    if os.path.exists(cache):
        with open(cache) as f:
            return json.load(f)

    from nba_api.stats.endpoints import leaguedashplayerstats
    for attempt in range(3):
        try:
            df = leaguedashplayerstats.LeagueDashPlayerStats(
                season=season, per_mode_detailed='PerGame', timeout=60,
            ).get_data_frames()[0]
            rows = []
            for _, r in df.iterrows():
                if float(r['MIN']) < MIN_MPG or int(r['GP']) < MIN_GP:
                    continue
                rows.append({
                    'name': r['PLAYER_NAME'],
                    'team': r['TEAM_ABBREVIATION'],
                    'gp':   int(r['GP']),
                    'min':  round(float(r['MIN']), 1),
                    'pts':  round(float(r['PTS']), 1),
                    'reb':  round(float(r['REB']), 1),
                    'ast':  round(float(r['AST']), 1),
                    'stl':  round(float(r['STL']), 1),
                    'blk':  round(float(r['BLK']), 1),
                })
            with open(cache, 'w') as f:
                json.dump(rows, f)
            return rows
        except Exception as e:
            print(f'  Attempt {attempt+1} failed for {season}: {e}')
            if attempt < 2:
                time.sleep(5)
    return []


def fetch_season_historical(season):
    """Fetch per-game stats via LeagueLeaders (works for all NBA seasons back to 1946)."""
    cache = os.path.join(CACHE_DIR, f'hist_{season}.json')
    if os.path.exists(cache):
        with open(cache) as f:
            return json.load(f)

    from nba_api.stats.endpoints import leagueleaders
    for attempt in range(3):
        try:
            df = leagueleaders.LeagueLeaders(
                season=season,
                stat_category_abbreviation='PTS',
                per_mode48='PerGame',
                season_type_all_star='Regular Season',
                timeout=60,
            ).get_data_frames()[0]

            rows = []
            for _, r in df.iterrows():
                gp  = int(r['GP'])
                mpg = float(r.get('MIN', 0) or 0)   # already per-game
                if mpg < MIN_MPG or gp < MIN_GP:
                    continue
                rows.append({
                    'name': str(r['PLAYER']),
                    'id':   int(r['PLAYER_ID']),
                    'team': str(r['TEAM']),
                    'gp':   gp,
                    'min':  round(mpg, 1),
                    'pts':  round(float(r.get('PTS', 0) or 0), 1),
                    'reb':  round(float(r.get('REB', 0) or 0), 1),
                    'ast':  round(float(r.get('AST', 0) or 0), 1),
                    'stl':  round(float(r.get('STL', 0) or 0), 1),
                    'blk':  round(float(r.get('BLK', 0) or 0), 1),
                })
            with open(cache, 'w') as f:
                json.dump(rows, f)
            return rows
        except Exception as e:
            print(f'  Attempt {attempt+1} failed for {season}: {e}')
            if attempt < 2:
                time.sleep(5)
    return []


def fetch_all_positions(all_names):
    """
    Returns name→pos dict using NBA API only (no stats heuristics).
    Uses PlayerIndex for active players, commonPlayerInfo for everyone else.
    """
    cache = os.path.join(CACHE_DIR, 'positions_full.json')
    if os.path.exists(cache):
        with open(cache) as f:
            return json.load(f)

    pos_map = {}

    # Step 1: PlayerIndex (active players, fast)
    from nba_api.stats.endpoints import playerindex
    print('  Fetching PlayerIndex…', end=' ', flush=True)
    pi_df = playerindex.PlayerIndex(timeout=60).get_data_frames()[0]
    pi_df['FULL_NAME'] = pi_df['PLAYER_FIRST_NAME'] + ' ' + pi_df['PLAYER_LAST_NAME']
    for _, row in pi_df.iterrows():
        pos_map[row['FULL_NAME']] = row['POSITION']
    print(f'{len(pos_map)} from PlayerIndex')
    time.sleep(0.6)

    # Step 2: commonPlayerInfo for everyone else
    from nba_api.stats.static import players as static_players
    from nba_api.stats.endpoints import commonplayerinfo

    all_static = {p['full_name']: p['id'] for p in static_players.get_players()}
    missing    = [n for n in all_names if n not in pos_map]
    print(f'  Fetching commonPlayerInfo for {len(missing)} remaining players…')

    for i, name in enumerate(missing):
        pid = all_static.get(name)
        if not pid:
            # Try partial match (handles Jr./Sr. suffix differences)
            matches = [v for k, v in all_static.items()
                       if k.lower().startswith(name.lower()[:8])]
            pid = matches[0] if len(matches) == 1 else None

        if not pid:
            pos_map[name] = 'F'  # fallback only when truly not found
            continue

        player_cache = os.path.join(CACHE_DIR, f'player_{pid}.json')
        if os.path.exists(player_cache):
            with open(player_cache) as f:
                pos_map[name] = json.load(f)
            continue

        try:
            info = commonplayerinfo.CommonPlayerInfo(
                player_id=pid, timeout=30
            ).get_data_frames()[0]
            raw_pos = info['POSITION'].iloc[0] if len(info) else ''
            pos = POSITION_MAP.get(raw_pos, 'F')
            pos_map[name] = pos
            with open(player_cache, 'w') as f:
                json.dump(pos, f)
            if i % 50 == 0:
                print(f'    {i}/{len(missing)}…')
            time.sleep(0.55)
        except Exception as e:
            print(f'    Warning: could not get position for {name}: {e}')
            pos_map[name] = 'F'
            time.sleep(1)

    with open(cache, 'w') as f:
        json.dump(pos_map, f)
    print(f'  Positions complete: {len(pos_map)} players')
    return pos_map


# ── Build ─────────────────────────────────────────────────────────────────────

def build():
    # pdata[name] = {
    #   'team_mins':  { '2010s_SAC': float, … },
    #   'team_best':  { '2010s_SAC': { _score, season, team, pts, reb, ast, stl, blk }, … }
    # }
    pdata = defaultdict(lambda: {
        'team_mins': defaultdict(float),
        'team_best': {},
    })

    all_decades = {}
    for decade, years in DECADES_HISTORICAL.items():
        all_decades.setdefault(decade, []).extend((y, 'hist') for y in years)
    for decade, years in DECADES_API.items():
        all_decades.setdefault(decade, []).extend((y, 'api') for y in years)

    for decade in sorted(all_decades):
        print(f'\n── {decade} ──')
        for y, src in sorted(all_decades[decade]):
            s = season_str(y)
            print(f'  {s}…', end=' ', flush=True)
            rows = fetch_season_historical(s) if src == 'hist' else fetch_season(s)
            print(f'{len(rows)} players')
            time.sleep(0.05)

            for r in rows:
                name, team = r['name'], r['team']
                key        = f'{decade}_{team}'
                total_mins = r['min'] * r['gp']
                score      = pra(r['pts'], r['reb'], r['ast'])

                pdata[name]['team_mins'][key] += total_mins

                cur = pdata[name]['team_best'].get(key)
                if cur is None or score > cur['_score']:
                    pdata[name]['team_best'][key] = {
                        '_score': score,
                        'season': s,
                        'team':   team,
                        'pts':    r['pts'],
                        'reb':    r['reb'],
                        'ast':    r['ast'],
                        'stl':    r['stl'],
                        'blk':    r['blk'],
                    }

    # ── Build teamRosters ─────────────────────────────────────────────────────
    dt = defaultdict(list)  # key → [(name, mins)]
    for name, data in pdata.items():
        for key, mins in data['team_mins'].items():
            dt[key].append((name, mins))

    team_rosters = {}
    for key, entries in dt.items():
        entries.sort(key=lambda x: -x[1])
        team_rosters[key] = [n for n, _ in entries[:TOP_N]]

    # ── Fetch positions (API only, no stats heuristics) ───────────────────────
    all_names = set(pdata.keys())
    # Also include 1980s hand-curated players
    if os.path.exists(OUTPUT):
        try:
            with open(OUTPUT) as f:
                old = json.load(f)
            if isinstance(old.get('players'), list):
                all_names.update(p['name'] for p in old['players'])
            elif isinstance(old.get('players'), dict):
                all_names.update(old['players'].keys())
        except Exception:
            pass

    print('\nFetching positions from NBA API…')
    pos_map = fetch_all_positions(all_names)

    # ── Build players dict ────────────────────────────────────────────────────
    # Include every player who appears in at least one roster
    roster_names = set()
    for names in team_rosters.values():
        roster_names.update(names)

    players = {}
    for name in roster_names:
        team_seasons = {}
        for key, best in pdata[name]['team_best'].items():
            d = {k: v for k, v in best.items() if k != '_score'}
            team_seasons[key] = d
        if team_seasons:
            players[name] = {
                'pos':         pos_map.get(name, 'F'),
                'teamSeasons': team_seasons,
            }

    # (1980s and earlier now fully covered by LeagueLeaders API data)

    return {'players': players, 'teamRosters': team_rosters}


if __name__ == '__main__':
    print('Building NBA decades data…')
    data = build()

    with open(OUTPUT, 'w') as f:
        json.dump(data, f, indent=2)

    total_cards = sum(len(p['teamSeasons']) for p in data['players'].values())
    print(f'\n✓ {len(data["players"])} players · {total_cards} team-seasons · '
          f'{len(data["teamRosters"])} team-decade rosters')

    from collections import Counter
    pos_counts = Counter(p['pos'] for p in data['players'].values())
    print('Position distribution:')
    for pos, n in sorted(pos_counts.items()):
        print(f'  {pos}: {n}')
