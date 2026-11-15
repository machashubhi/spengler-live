"""
Wisehockey per-period event CSVs -> compact match feed for the widget. Works for any match.

    python tools/prepare_data.py <folder> <match-id> [--home-code USA --home-color "#d93a4e"
                                  --away-code HCD --away-color "#2f7ee6" --away-ink "#ffd84d"
                                  --competition "Spengler Cup 2025 · Final"]

Reads   <folder>/<Home>_<Away>_Game_Events_Periode <n>_<dd>_<mm>_<yyyy>.csv  (Wisehockey's export names;
        never committed: see .gitignore). Team names and the date come from the file names.
Writes  <folder>/<match-id>.json, which you upload to the private R2 bucket (npm run upload -- <match-id>).

Each event keeps what the widget uses: clock, type, team, players, puck coordinates,
shot xG, pass / blue-line / puck-control results, strength, assists, penalty reasons,
and the on-ice snapshot with velocities (StartPlayerCoordinates/Velocity/Direction 1..12).
It also fits the What-If shot xG model on this match's Wisehockey shot xG.
"""
import argparse
import sys
import glob
import json
import math
import os
import re

import numpy as np
import pandas as pd

TYPES = ["Faceoff", "PuckControl", "Pass", "BluelineCrossing", "Dump", "Shot", "Goal",
         "StoppageOfPlay", "Clear", "Penalty"]
STRENGTH = ["FullStrength", "HomePowerplay", "AwayPowerplay", "EqualStrength"]
GOAL_X = 26.03
NAME_FIXES = {"McCartthy": "McCarthy"}  # typo in the source roster


def xy(v):
    if isinstance(v, str) and "," in v:
        a, b = v.split(",")
        return float(a), float(b)
    return None


def nn(v):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else v


def team(name, short, code, color, ink):
    t = {"name": name, "short": short or name, "code": code or re.sub(r"[^A-Za-z0-9]", "", name)[:3].upper()}
    t.update({k: v for k, v in (("color", color), ("ink", ink)) if v})
    return t


def main(a):
    files = sorted(glob.glob(os.path.join(a.folder, "*Game_Events_Periode*.csv")))
    if not files:
        raise SystemExit(f"no *Game_Events_Periode*.csv in {a.folder}")
    m = re.match(r"(.+?)_(.+?)_Game_Events_Periode \d+_(\d\d)_(\d\d)_(\d{4})", os.path.basename(files[0]))
    home_name, away_name = (a.home or m and m.group(1) or "Home team"), (a.away or m and m.group(2) or "Away team")
    date = f"{m.group(5)}-{m.group(4)}-{m.group(3)}" if m else ""
    d = pd.concat([pd.read_csv(f, encoding="utf-8-sig", low_memory=False) for f in files], ignore_index=True)
    d = d.sort_values("Timestamp", kind="stable").reset_index(drop=True)

    # players; each team's goalie is the player who lives nearest a goal line (|x| ~ 26 m)
    seen, depth = {}, {}
    for i in range(1, 13):
        sub = d[[f"StartPlayerId{i}", f"StartPlayerName{i}", f"StartPlayerTeam{i}", f"StartPlayerCoordinates{i}"]].dropna()
        for pid, name, side, c in sub.itertuples(index=False):
            pid = int(pid)
            seen[pid] = (name, side)
            s = depth.setdefault(pid, [0.0, 0])
            s[0] += abs(xy(c)[0])
            s[1] += 1
    goalies = {max((p for p in depth if seen[p][1] == t and depth[p][1] > 200), key=lambda p: depth[p][0] / depth[p][1])
               for t in ("Home", "Away")}
    players, index = [], {}
    for pid, (name, side) in sorted(seen.items(), key=lambda kv: (kv[1][1], kv[0])):
        jersey, full = name.split(" ", 1)
        full = " ".join(NAME_FIXES.get(w, w) for w in full.split(" "))
        index[pid] = len(players)
        players.append({"id": pid, "team": "H" if side == "Home" else "A", "no": int(jersey[1:]),
                        "name": full, "short": full.split(" ")[-1], "goalie": pid in goalies})

    def pi(v):
        v = nn(v)
        return index.get(int(v)) if v is not None else None

    t0 = int(d.Timestamp.min())
    events, last_pos = [], -10 ** 9
    for r in d.to_dict("records"):
        ts = int(r["Timestamp"]) - t0
        typ = r["EventType"]
        pos, vel, has_vel = [], [], False
        for i in range(1, 13):
            pid, c = nn(r[f"StartPlayerId{i}"]), xy(r[f"StartPlayerCoordinates{i}"])
            if pid is None or c is None:
                continue
            pos += [index[int(pid)], round(c[0] * 10), round(c[1] * 10)]
            sp, dr = nn(r[f"StartPlayerVelocity{i}"]), xy(r[f"StartPlayerDirection{i}"])
            if sp is not None and dr is not None:
                has_vel = True
                vel += [round(sp * dr[0] * 10), round(sp * dr[1] * 10)]
            else:
                vel += [0, 0]
        keep = bool(pos) and (has_vel or ts - last_pos >= 100 or typ in ("Goal", "Shot", "Faceoff"))
        if keep:
            last_pos = ts
        fields = {"Shot": {"res": "ShotResult"}, "Pass": {"res": "PassResult"},
                  "BluelineCrossing": {"res": "BluelineCrossingResult", "dir": "BluelineCrossingDirection"},
                  "Penalty": {"why": "PenaltyReason"}, "StoppageOfPlay": {"why": "StoppageOfPlayReason"},
                  "PuckControl": {"st": "PuckControlState"}}.get(typ, {})
        x = {k: r[c] for k, c in fields.items() if isinstance(r[c], str)}
        if typ == "Shot" and nn(r["ShotXG"]) is not None:
            x["xg"] = round(float(r["ShotXG"]), 3)
        if typ == "Goal":
            x["a"] = [a for a in (pi(r["GoalAssist1Id"]), pi(r["GoalAssist2Id"])) if a is not None]
        if typ == "PuckControl" and isinstance(r["PuckControlContestingPlayerIds"], str):
            x["c"] = [index[int(v)] for v in r["PuckControlContestingPlayerIds"].split(",") if int(v) in index]
        s, e = xy(r["EventStartCoordinate"]), xy(r["EventEndCoordinate"])
        side = r["EventPrimaryTeam"]
        events.append([
            ts, int(r["Period"]), int(r["MatchClock"]), TYPES.index(typ),
            {"Home": "H", "Away": "A"}.get(side, "") if isinstance(side, str) else "",
            pi(r["EventPrimaryPlayerId"]), pi(r["EventSecondaryPlayerId"]),
            [round(s[0] * 10), round(s[1] * 10)] if s else 0, [round(e[0] * 10), round(e[1] * 10)] if e else 0,
            STRENGTH.index(r["TeamStrengthType"]) if isinstance(r["TeamStrengthType"], str) else 0,
            r["TeamStrength"] if isinstance(r["TeamStrength"], str) else "",
            int(bool(r["HomeGoalieOnIce"])) + 2 * int(bool(r["AwayGoalieOnIce"])),
            x or 0, pos if keep else 0, vel if keep and has_vel else 0,
        ])

    # What-If shot model: logit(xG) ~ distance + angle, fitted on this match's shots.
    # Which goal each team attacks can change by period: the home goalie's side tells us.
    hg = next(p["id"] for p in players if p["goalie"] and p["team"] == "H")
    hx = {}
    for i in range(1, 13):
        sub = d[d[f"StartPlayerId{i}"] == hg]
        for per, c in zip(sub.Period, sub[f"StartPlayerCoordinates{i}"]):
            hx.setdefault(per, []).append(xy(c)[0])
    attack = {per: (1 if np.mean(v) < 0 else -1) for per, v in hx.items()}  # +1: home attacks +x
    sh = d[(d.EventType == "Shot") & d.ShotXG.notna()]
    c = np.array([xy(v) for v in sh.EventStartCoordinate])
    gx = np.array([GOAL_X * attack.get(per, 1) * (1 if t == "Home" else -1) for per, t in zip(sh.Period, sh.EventPrimaryTeam)])
    dist = np.hypot(gx - c[:, 0], c[:, 1])
    ang = np.degrees(np.arctan2(np.abs(c[:, 1]), np.abs(gx - c[:, 0])))
    y = np.clip(sh.ShotXG.to_numpy(float), 0.005, 0.95)
    X = np.column_stack([np.ones_like(dist), dist, ang])
    coef = np.linalg.lstsq(X, np.log(y / (1 - y)), rcond=None)[0]

    out = {
        "meta": {
            "competition": a.competition, "date": date,
            "home": team(home_name, a.home_short, a.home_code, a.home_color, a.home_ink),
            "away": team(away_name, a.away_short, a.away_code, a.away_color, a.away_ink),
            "t0": t0, "types": TYPES, "strengthTypes": STRENGTH,
            "xg": [round(float(v), 4) for v in coef],
        },
        "players": players,
        "events": events,
    }
    path = os.path.join(a.folder, f"{a.match_id}.json")
    with open(path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"), allow_nan=False)
    print(f"wrote {path}: {os.path.getsize(path):,} bytes, {len(events)} events, {len(players)} players; "
          f"goalies {[p['name'] for p in players if p['goalie']]}; xG fit {out['meta']['xg']} on {len(sh)} shots")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles
    ap = argparse.ArgumentParser(description="Wisehockey event CSVs -> match file for the widget")
    ap.add_argument("folder")
    ap.add_argument("match_id", help="e.g. 2026-12-31-final (letters, digits, dashes)")
    ap.add_argument("--competition", default="")
    for s in ("home", "away"):
        ap.add_argument(f"--{s}", help=f"{s} team name (default: from the file name)")
        ap.add_argument(f"--{s}-short", help="short name for phones")
        ap.add_argument(f"--{s}-code", help="3-4 letter code for the scoreboard")
        ap.add_argument(f"--{s}-color", help="team colour, #rrggbb")
        ap.add_argument(f"--{s}-ink", help="jersey-number colour, #rrggbb")
    args = ap.parse_args()
    if not re.fullmatch(r"[a-z0-9-]+", args.match_id):
        raise SystemExit("match id: lowercase letters, digits and dashes only")
    main(args)
