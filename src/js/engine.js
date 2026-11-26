// Tournament engine — pure logic, no DOM. Shared by the desktop app and the
// spectator website. Match IDs are identical to the original app
// (rr_/swiss_/se_/de_) so old saves and backup codes load unchanged.
//
// Refinements over the original:
//   • Positional scores (Swiss/SE/DE) are re-validated against the players in the
//     slot, so corrections upstream never hand an old score to a new matchup.
//   • Swiss pairings are locked once a round is generated, avoid rematches with
//     backtracking, and the number of rounds is configurable.
//   • Proper tiebreaks: Swiss uses Buchholz; ties are split by a head-to-head
//     mini-table (transitive), then points, then seed.
//   • Real elimination placements (1st, 2nd, T3rd…) and an optional
//     third-place match for Single Elimination.
//   • Two disqualified players meeting is a double forfeit instead of a deadlock.
//   • Every bracket match knows where its players come from (src1/src2), which
//     drives the bracket visualiser's connector lines.

export const FORMATS = {
    rr: { short: 'Round Robin', long: 'Round Robin' },
    swiss: { short: 'Swiss', long: 'Swiss System' },
    se: { short: 'Single Elim', long: 'Single Elimination' },
    de: { short: 'Double Elim', long: 'Double Elimination' },
};

export const formatLabel = (f, long = false) => (FORMATS[f] || FORMATS.rr)[long ? 'long' : 'short'];

export function cleanPlayerName(str) {
    if (!str) return '';
    return String(str).replace(/^\(#\d+\)\s/, '').trim();
}

export const isTBD = (s) => !s || String(s).startsWith('TBD');
export const isBye = (s) => s === 'BYE';
export const isReal = (s) => !isTBD(s) && !isBye(s);

export function normalizePlayers(list) {
    return (Array.isArray(list) ? list : [])
        .map((p, i) => (typeof p === 'string'
            ? { name: p.trim(), seed: i + 1, isDQ: false }
            : { name: String(p?.name ?? '').trim(), seed: Number(p?.seed) || i + 1, isDQ: !!p?.isDQ }))
        .filter((p) => p.name);
}

export function uniqueNames(names) {
    const seen = new Set();
    const out = [];
    for (const raw of names) {
        const n = String(raw ?? '').trim();
        if (!n || seen.has(n.toLowerCase())) continue;
        seen.add(n.toLowerCase());
        out.push(n);
    }
    return out;
}

const slug = (n) => n.replace(/\s+/g, '_');

export function rrMatchId(round, a, b) {
    const [x, y] = [a, b].sort();
    return `rr_r${round}_${slug(x)}_vs_${slug(y)}`;
}

/** Circle-method schedule, identical rotation to the original app. */
export function roundRobinSchedule(names) {
    const list = [...names];
    if (list.length % 2 !== 0) list.push('BYE');
    const rounds = [];
    for (let r = 0; r < list.length - 1; r++) {
        const matches = [];
        for (let m = 0; m < list.length / 2; m++) {
            const p1 = list[m];
            const p2 = list[list.length - 1 - m];
            if (p1 === 'BYE' || p2 === 'BYE') matches.push({ type: 'bye', active: p1 === 'BYE' ? p2 : p1 });
            else matches.push({ type: 'match', id: rrMatchId(r, p1, p2), p1, p2 });
        }
        rounds.push({ index: r, title: `Round ${r + 1}`, matches });
        list.splice(1, 0, list.pop());
    }
    return rounds;
}

/** Recommended Swiss length: enough rounds to separate a single winner. */
export function swissRoundCount(playerCount) {
    return Math.ceil(Math.log2(Math.max(playerCount, 1))) || 1;
}

export function maxSwissRounds(playerCount) {
    return Math.max(1, playerCount % 2 === 0 ? playerCount - 1 : playerCount);
}

export function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Pair a sorted pool top-down, giving each player the highest-ranked opponent
 * they haven't met. Backtracks when that leads to a forced rematch; only if no
 * rematch-free pairing exists does it fall back to the original greedy method.
 * When greedy succeeds without rematches both produce identical pairings.
 */
function pairSwissPool(pool) {
    const n = pool.length;
    const used = new Array(n).fill(false);
    const out = [];
    let budget = 50000;
    const met = (a, b) => a.opponents.includes(b.name);
    const solve = () => {
        const i = used.indexOf(false);
        if (i === -1) return true;
        used[i] = true;
        for (let j = i + 1; j < n; j++) {
            if (used[j] || met(pool[i], pool[j])) continue;
            if (--budget < 0) break;
            used[j] = true;
            out.push([pool[i], pool[j]]);
            if (solve()) return true;
            out.pop();
            used[j] = false;
        }
        used[i] = false;
        return false;
    };
    if (solve()) return out;

    const rest = [...pool];
    const greedy = [];
    while (rest.length > 1) {
        const p1 = rest.shift();
        let j = rest.findIndex((c) => !met(p1, c));
        if (j === -1) j = 0;
        greedy.push([p1, rest.splice(j, 1)[0]]);
    }
    return greedy;
}

export class Tournament {
    /**
     * @param {{players, matchScores, format, winThreshold, swissRounds?, thirdPlace?}} rec
     * `matchScores` is mutated in place (entries are created / re-validated lazily,
     * Swiss rounds are marked as locked) so the caller should persist it afterwards.
     */
    constructor({ players, matchScores, format, winThreshold, swissRounds, thirdPlace }) {
        this.players = normalizePlayers(players);
        this.scores = matchScores || {};
        this.format = FORMATS[format] ? format : 'rr';
        this.target = Number(winThreshold) || 3;
        this.bestOf = this.target * 2 - 1;
        const n = this.players.length;
        this.swissRounds = Math.min(maxSwissRounds(n), Math.max(1, Number(swissRounds) || swissRoundCount(n)));
        this.thirdPlace = !!thirdPlace;
        this.dq = new Set(this.players.filter((p) => p.isDQ).map((p) => p.name));
        this.seedOf = Object.fromEntries(this.players.map((p) => [p.name, p.seed]));
        this._cache = {};
    }

    isDQ(name) {
        return this.dq.has(cleanPlayerName(name));
    }

    /** Stored record for a match, created or re-validated against the current occupants. */
    record(id, p1, p2) {
        let rec = this.scores[id];

        if (!rec && id.startsWith('rr_')) {
            // Pairing may have moved to a different round after a roster change.
            const suffix = id.replace(/^rr_r\d+_/, '');
            const oldKey = Object.keys(this.scores).find((k) => k !== id && k.startsWith('rr_') && k.replace(/^rr_r\d+_/, '') === suffix);
            if (oldKey) {
                rec = this.scores[id] = this.scores[oldKey];
                delete this.scores[oldKey];
            }
        }

        if (!rec) return (this.scores[id] = { p1: 0, p2: 0, player1: p1, player2: p2 });

        if (isReal(p1) && isReal(p2)) {
            const c1 = cleanPlayerName(p1);
            const c2 = cleanPlayerName(p2);
            const s1 = cleanPlayerName(rec.player1);
            const s2 = cleanPlayerName(rec.player2);
            if (isReal(rec.player1) && isReal(rec.player2)) {
                if (c1 === s2 && c2 === s1 && c1 !== c2) {
                    rec = this.scores[id] = { ...rec, p1: rec.p2 || 0, p2: rec.p1 || 0, player1: p1, player2: p2 };
                } else if (c1 !== s1 || c2 !== s2) {
                    rec = this.scores[id] = { p1: 0, p2: 0, player1: p1, player2: p2 };
                }
            } else {
                rec = this.scores[id] = { p1: 0, p2: 0, player1: p1, player2: p2 };
            }
        }
        rec.p1 = Number(rec.p1) || 0;
        rec.p2 = Number(rec.p2) || 0;
        return rec;
    }

    /** Effective score, with disqualification overrides applied. */
    score(id, p1, p2) {
        const rec = this.record(id, p1, p2);
        const d1 = this.isDQ(p1);
        const d2 = this.isDQ(p2);
        if (d1 && d2) return { p1: 0, p2: 0, player1: p1, player2: p2, forced: true };
        if (d1) return { p1: 0, p2: this.target, player1: p1, player2: p2, forced: true };
        if (d2) return { p1: this.target, p2: 0, player1: p1, player2: p2, forced: true };
        return rec;
    }

    /** True when the row is not editable (placeholder, bye, or DQ-forced). */
    isLocked(p1, p2) {
        return !isReal(p1) || !isReal(p2) || this.isDQ(p1) || this.isDQ(p2);
    }

    resolve(id, p1, p2) {
        if (p1 === 'BYE' && p2 === 'BYE') return { w: 'BYE', l: 'BYE' };
        if (p1 === 'BYE') return { w: p2, l: 'BYE' };
        if (p2 === 'BYE') return { w: p1, l: 'BYE' };
        if (isTBD(p1) || isTBD(p2)) {
            const label = id.replace('de_', '').replace('se_', '').toUpperCase();
            return { w: `TBD (Winner ${label})`, l: `TBD (Loser ${label})` };
        }
        if (this.isDQ(p1) && this.isDQ(p2)) return { w: 'BYE', l: 'BYE' };
        const m = this.score(id, p1, p2);
        if (m.p1 === this.target) return { w: p1, l: p2 };
        if (m.p2 === this.target) return { w: p2, l: p1 };
        const a = cleanPlayerName(p1);
        const b = cleanPlayerName(p2);
        return { w: `TBD (${a} vs ${b})`, l: `TBD (${a} vs ${b})` };
    }

    /** Winner/loser of a match if decided, else null. */
    outcome(m) {
        if (!m || m.type === 'bye') return null;
        if (isTBD(m.p1) || isTBD(m.p2)) return null;
        const r = this.resolve(m.id, m.p1, m.p2);
        if (isTBD(r.w)) return null;
        return { winner: isReal(r.w) ? cleanPlayerName(r.w) : null, loser: isReal(r.l) ? cleanPlayerName(r.l) : null };
    }

    seededTree() {
        if (this.players.length === 0) return [];
        const sorted = [...this.players].sort((a, b) => a.seed - b.seed);
        const tree = sorted.map((p) => `(#${p.seed}) ${p.name}`);
        let power = 2;
        while (power < tree.length) power *= 2;
        while (tree.length < power) tree.push('BYE');
        let order = [0, 1];
        while (order.length < power) {
            const next = [];
            const target = order.length * 2 - 1;
            for (const o of order) next.push(o, target - o);
            order = next;
        }
        return order.map((i) => tree[i]);
    }

    // ---- Round Robin --------------------------------------------------------------
    rr() {
        if (!this._cache.rr) this._cache.rr = { rounds: roundRobinSchedule(this.players.map((p) => p.name)) };
        return this._cache.rr;
    }

    // ---- Swiss ----------------------------------------------------------------------

    /** A previously generated round, if it is still a valid partition of the field. */
    lockedSwissRound(r, poolNames) {
        const prefix = `swiss_r${r}_m`;
        const entries = Object.entries(this.scores).filter(([k]) => k.startsWith(prefix));
        if (!entries.length || !entries.every(([, v]) => v && v.paired)) return null;
        const pairs = entries
            .map(([k, v]) => ({ i: Number(k.slice(prefix.length)), id: k, p1: v.player1, p2: v.player2 }))
            .sort((a, b) => a.i - b.i);
        const known = new Set(this.players.map((p) => p.name));
        const used = new Set();
        for (const p of pairs) {
            if (!known.has(p.p1) || !known.has(p.p2) || p.p1 === p.p2 || used.has(p.p1) || used.has(p.p2)) return null;
            used.add(p.p1);
            used.add(p.p2);
        }
        const rest = poolNames.filter((n) => !used.has(n));
        if (rest.length > 1) return null;
        return { pairs, bye: rest[0] || null };
    }

    swiss() {
        if (this._cache.swiss) return this._cache.swiss;
        const totalRounds = this.swissRounds;
        const state = { rounds: [], totalRounds };
        if (this.players.length === 0) return (this._cache.swiss = state);

        const stats = {};
        this.players.forEach((p) => { stats[p.name] = { name: p.name, seed: p.seed, wins: 0, losses: 0, diff: 0, opponents: [], hadBye: false }; });

        for (let r = 0; r < totalRounds; r++) {
            const matches = [];
            let pool = Object.values(stats).map((p) => ({ ...p, opponents: [...p.opponents] })).filter((p) => !this.dq.has(p.name));
            if (pool.length === 0) break;
            const pre = (name) => [stats[name].wins, stats[name].losses];
            const pushBye = (name) => {
                matches.push({ type: 'bye', active: name, rec: pre(name) });
                stats[name].hadBye = true;
                stats[name].wins += 1;
            };

            const locked = this.lockedSwissRound(r, pool.map((p) => p.name));
            if (locked) {
                locked.pairs.forEach((p) => matches.push({ type: 'match', id: p.id, p1: p.p1, p2: p.p2, rec1: pre(p.p1), rec2: pre(p.p2) }));
                if (locked.bye) pushBye(locked.bye);
            } else if (r === 0) {
                pool.sort((a, b) => a.seed - b.seed);
                let bye = null;
                if (pool.length % 2 !== 0) bye = pool.pop().name;
                const half = Math.floor(pool.length / 2);
                for (let i = 0; i < half; i++) {
                    const p1 = pool[i].name;
                    const p2 = pool[i + half].name;
                    matches.push({ type: 'match', p1, p2, id: `swiss_r0_m${i}`, rec1: pre(p1), rec2: pre(p2) });
                }
                if (bye) pushBye(bye);
            } else {
                pool.sort((a, b) => b.wins - a.wins || b.diff - a.diff || a.seed - b.seed);
                let bye = null;
                if (pool.length % 2 !== 0) {
                    let idx = pool.length - 1;
                    for (let i = pool.length - 1; i >= 0; i--) if (!pool[i].hadBye) { idx = i; break; }
                    bye = pool.splice(idx, 1)[0].name;
                }
                pairSwissPool(pool).forEach(([a, b], i) => {
                    matches.push({ type: 'match', p1: a.name, p2: b.name, id: `swiss_r${r}_m${i}`, rec1: pre(a.name), rec2: pre(b.name) });
                });
                if (bye) pushBye(bye);
            }

            // Byes listed first like the original UI; then lock the round in place.
            matches.sort((a, b) => (a.type === 'bye' ? -1 : 0) - (b.type === 'bye' ? -1 : 0));
            state.rounds.push({ title: `Swiss Round ${r + 1}`, matches, index: r });

            let complete = true;
            for (const m of matches) {
                if (m.type === 'bye') continue;
                this.record(m.id, m.p1, m.p2).paired = true;
                const s = this.score(m.id, m.p1, m.p2);
                stats[m.p1].opponents.push(m.p2);
                stats[m.p2].opponents.push(m.p1);
                stats[m.p1].diff += s.p1 - s.p2;
                stats[m.p2].diff += s.p2 - s.p1;
                if (s.p1 === this.target) { stats[m.p1].wins += 1; stats[m.p2].losses += 1; }
                else if (s.p2 === this.target) { stats[m.p2].wins += 1; stats[m.p1].losses += 1; }
                else if (!(this.isDQ(m.p1) && this.isDQ(m.p2))) complete = false;
            }
            if (!complete) break;
        }
        return (this._cache.swiss = state);
    }

    /** IDs of the latest Swiss round if it can be re-paired (no results entered yet). */
    repairableSwissRound() {
        if (this.format !== 'swiss') return null;
        const rounds = this.swiss().rounds;
        const last = rounds[rounds.length - 1];
        if (!last || last.index === 0) return null;
        const real = last.matches.filter((m) => m.type === 'match');
        const untouched = real.every((m) => { const s = this.scores[m.id]; return !s || (s.p1 === 0 && s.p2 === 0); });
        return untouched ? { index: last.index, ids: real.map((m) => m.id) } : null;
    }

    // ---- Single Elimination ------------------------------------------------------------
    se() {
        if (this._cache.se) return this._cache.se;
        const tree = this.seededTree();
        const power = tree.length;
        const state = { rounds: [], third: null, champion: null };
        if (power === 0) return (this._cache.se = state);
        const K = Math.log2(power);
        const name = (rem) => (rem === 1 ? 'Final' : rem === 2 ? 'Semifinals' : rem === 4 ? 'Quarterfinals' : `Round of ${rem * 2}`);

        const r0 = [];
        for (let i = 0; i < power; i += 2) r0.push({ p1: tree[i], p2: tree[i + 1], id: `se_r0_m${i / 2}` });
        state.rounds.push({ title: name(power / 2), matches: r0 });

        for (let r = 1; r < K; r++) {
            const prev = state.rounds[r - 1].matches;
            const curr = [];
            for (let i = 0; i < prev.length; i += 2) {
                const a = this.resolve(prev[i].id, prev[i].p1, prev[i].p2);
                const b = this.resolve(prev[i + 1].id, prev[i + 1].p1, prev[i + 1].p2);
                curr.push({
                    p1: a.w, p2: b.w, id: `se_r${r}_m${i / 2}`,
                    src1: { id: prev[i].id, take: 'w' }, src2: { id: prev[i + 1].id, take: 'w' },
                });
            }
            state.rounds.push({ title: name(power / Math.pow(2, r + 1)), matches: curr });
        }

        if (this.thirdPlace && K >= 2) {
            const [s1, s2] = state.rounds[K - 2].matches;
            const a = this.resolve(s1.id, s1.p1, s1.p2);
            const b = this.resolve(s2.id, s2.p1, s2.p2);
            state.third = { p1: a.l, p2: b.l, id: 'se_3rd', src1: { id: s1.id, take: 'l' }, src2: { id: s2.id, take: 'l' } };
        }

        const final = state.rounds[state.rounds.length - 1].matches[0];
        const res = this.resolve(final.id, final.p1, final.p2);
        state.champion = isReal(res.w) ? res.w : null;
        return (this._cache.se = state);
    }

    // ---- Double Elimination ------------------------------------------------------------
    de() {
        if (this._cache.de) return this._cache.de;
        const tree = this.seededTree();
        const power = tree.length;
        const T = this.target;
        const state = { winners: [], losers: [], gf: [], gfReset: [], triggersReset: false, firstPlace: 'TBD 1st Place', secondPlace: 'TBD 2nd Place', thirdPlace: 'TBD 3rd Place', fourthPlace: 'TBD 4th Place' };
        if (power === 0) return (this._cache.de = state);
        const K = Math.log2(power);
        const W = (id) => ({ id, take: 'w' });
        const L = (id) => ({ id, take: 'l' });

        const settleGrandFinal = (w, l, src1, src2) => {
            state.gf = [{ p1: w, p2: l, id: 'de_gf_m0', src1, src2 }];
            if (isTBD(w) || isTBD(l)) return;
            if (isBye(w) || isBye(l)) {
                const r = this.resolve('de_gf_m0', w, l);
                if (isReal(r.w)) state.firstPlace = r.w;
                return;
            }
            const g = this.score('de_gf_m0', w, l);
            if (g.p1 === T) { state.firstPlace = w; state.secondPlace = l; }
            else if (g.p2 === T) {
                state.triggersReset = true;
                state.gfReset = [{ p1: w, p2: l, id: 'de_gf_reset', src1: W('de_gf_m0'), src2: L('de_gf_m0') }];
                const rs = this.score('de_gf_reset', w, l);
                if (rs.p1 === T) { state.firstPlace = w; state.secondPlace = l; }
                else if (rs.p2 === T) { state.firstPlace = l; state.secondPlace = w; }
            }
        };

        const w0 = [];
        for (let i = 0; i < power; i += 2) w0.push({ p1: tree[i], p2: tree[i + 1], id: `de_w0_m${i / 2}` });
        state.winners.push({ title: K === 1 ? 'Winners Final' : K === 2 ? 'Winners Semifinals' : 'Winners Round 1', matches: w0 });

        if (power === 2) {
            const res = this.resolve(w0[0].id, w0[0].p1, w0[0].p2);
            state.thirdPlace = 'BYE';
            state.fourthPlace = 'BYE';
            settleGrandFinal(res.w, res.l, W(w0[0].id), L(w0[0].id));
            return (this._cache.de = state);
        }

        const w0Res = w0.map((m) => this.resolve(m.id, m.p1, m.p2));
        const l0 = [];
        for (let i = 0; i < w0Res.length; i += 2) {
            l0.push({ p1: w0Res[i].l, p2: w0Res[i + 1].l, id: `de_l0_m${i / 2}`, src1: L(w0[i].id), src2: L(w0[i + 1].id) });
        }
        state.losers.push({ title: 'Losers Round 1', matches: l0 });

        let currW = w0Res;
        let currWMatches = w0;
        let currL = l0.map((m) => this.resolve(m.id, m.p1, m.p2));
        let currLMatches = l0;
        let lIdx = 1;

        for (let r = 1; r < K; r++) {
            const wMatches = [];
            for (let i = 0; i < currW.length; i += 2) {
                wMatches.push({ p1: currW[i].w, p2: currW[i + 1].w, id: `de_w${r}_m${i / 2}`, src1: W(currWMatches[i].id), src2: W(currWMatches[i + 1].id) });
            }
            const remW = power / Math.pow(2, r + 1);
            state.winners.push({ title: remW === 1 ? 'Winners Final' : remW === 2 ? 'Winners Semifinals' : `Winners Round ${r + 1}`, matches: wMatches });
            const wRes = wMatches.map((m) => this.resolve(m.id, m.p1, m.p2));

            const inflow = [];
            for (let i = 0; i < wRes.length; i++) {
                const from = wMatches.length - 1 - i;
                inflow.push({ p1: currL[i].w, p2: wRes[from].l, id: `de_l${lIdx}_m${i}`, src1: W(currLMatches[i].id), src2: L(wMatches[from].id) });
            }
            state.losers.push({ title: `Losers Round ${lIdx + 1}`, matches: inflow });
            lIdx++;
            const inflowRes = inflow.map((m) => this.resolve(m.id, m.p1, m.p2));

            if (r < K - 1) {
                const consol = [];
                for (let i = 0; i < inflowRes.length; i += 2) {
                    consol.push({ p1: inflowRes[i].w, p2: inflowRes[i + 1].w, id: `de_l${lIdx}_m${i / 2}`, src1: W(inflow[i].id), src2: W(inflow[i + 1].id) });
                }
                state.losers.push({ title: `Losers Round ${lIdx + 1}`, matches: consol });
                lIdx++;
                currL = consol.map((m) => this.resolve(m.id, m.p1, m.p2));
                currLMatches = consol;
            } else {
                currL = inflowRes;
                currLMatches = inflow;
            }
            currW = wRes;
            currWMatches = wMatches;
        }

        if (state.losers.length > 0) state.losers[state.losers.length - 1].title = 'Losers Final';
        state.thirdPlace = currL[0].l;
        if (state.losers.length > 1) {
            const prev = state.losers[state.losers.length - 2].matches.map((m) => this.resolve(m.id, m.p1, m.p2));
            state.fourthPlace = prev[0].l;
        }
        settleGrandFinal(currW[0].w, currL[0].w, W(currWMatches[0].id), W(currLMatches[0].id));
        return (this._cache.de = state);
    }

    /** Ordered groups of rounds for display: [{ title, kind, matches }]. */
    sections() {
        if (this._cache.sections) return this._cache.sections;
        let out = [];
        if (this.format === 'rr') out = this.rr().rounds.map((r) => ({ ...r, kind: 'round' }));
        else if (this.format === 'swiss') out = this.swiss().rounds.map((r) => ({ ...r, kind: 'round' }));
        else if (this.format === 'se') {
            const s = this.se();
            out = s.rounds.map((r) => ({ ...r, kind: 'winners' }));
            if (s.third) out.splice(out.length - 1, 0, { title: 'Third-Place Match', kind: 'third', matches: [s.third] });
        } else {
            const s = this.de();
            out = [...s.winners.map((r) => ({ ...r, kind: 'winners' })), ...s.losers.map((r) => ({ ...r, kind: 'losers' }))];
            if (s.gf.length) out.push({ title: 'Grand Final', kind: 'finals', matches: s.gf });
            if (s.triggersReset && s.gfReset.length) out.push({ title: 'Grand Final Reset', kind: 'reset', matches: s.gfReset });
        }
        return (this._cache.sections = out);
    }

    /** Flat list of every non-bye match in play order. */
    matches() {
        if (this._cache.matches) return this._cache.matches;
        const list = [];
        this.sections().forEach((sec) => sec.matches.forEach((m) => {
            if (m.type === 'bye') return;
            list.push({ ...m, round: sec.title, kind: sec.kind });
        }));
        return (this._cache.matches = list);
    }

    findMatch(id) {
        return this.matches().find((m) => m.id === id) || null;
    }

    swissByes() {
        if (this.format !== 'swiss') return [];
        const out = [];
        this.swiss().rounds.forEach((r) => r.matches.forEach((m) => { if (m.type === 'bye') out.push({ name: m.active, round: r.title }); }));
        return out;
    }

    /** Aggregated per-player numbers used by standings and final results. */
    tally() {
        if (this._cache.tally) return this._cache.tally;
        const t = {};
        this.players.forEach((p) => {
            t[p.name] = { name: p.name, seed: p.seed, isDQ: p.isDQ, wins: 0, losses: 0, gameWins: 0, gameLosses: 0, points: 0, beat: new Set(), opponents: [], form: [], buchholz: 0 };
        });
        this.swissByes().forEach(({ name }) => {
            const s = t[name];
            if (!s) return;
            s.wins += 1; s.gameWins += this.target; s.points += this.target; s.form.push('W');
        });
        this.matches().forEach((m) => {
            const n1 = cleanPlayerName(m.p1);
            const n2 = cleanPlayerName(m.p2);
            if (!isReal(m.p1) || !isReal(m.p2) || !t[n1] || !t[n2]) return;
            t[n1].opponents.push(n2);
            t[n2].opponents.push(n1);
            const s = this.score(m.id, m.p1, m.p2);
            t[n1].gameWins += s.p1; t[n1].gameLosses += s.p2; t[n1].points += s.p1;
            t[n2].gameWins += s.p2; t[n2].gameLosses += s.p1; t[n2].points += s.p2;
            if (s.p1 === this.target) { t[n1].wins++; t[n2].losses++; t[n1].beat.add(n2); t[n1].form.push('W'); t[n2].form.push('L'); }
            else if (s.p2 === this.target) { t[n2].wins++; t[n1].losses++; t[n2].beat.add(n1); t[n2].form.push('W'); t[n1].form.push('L'); }
        });
        Object.values(t).forEach((s) => {
            s.diff = s.gameWins - s.gameLosses;
            s.buchholz = s.opponents.reduce((sum, o) => sum + (t[o]?.wins || 0), 0);
        });
        return (this._cache.tally = t);
    }

    /**
     * Sort league-style rows: wins → (Swiss: Buchholz) → game diff → head-to-head
     * mini-table among the tied group → points → seed. Fully transitive.
     */
    rankLeague(rows) {
        const swiss = this.format === 'swiss';
        const key = (r) => `${r.wins}|${swiss ? r.buchholz : ''}|${r.diff}`;
        rows.sort((a, b) => b.wins - a.wins || (swiss ? b.buchholz - a.buchholz : 0) || b.diff - a.diff);
        const out = [];
        for (let i = 0; i < rows.length;) {
            let j = i;
            while (j < rows.length && key(rows[j]) === key(rows[i])) j++;
            const group = rows.slice(i, j);
            if (group.length > 1) {
                const names = new Set(group.map((g) => g.name));
                group.forEach((g) => { g.h2h = [...g.beat].filter((n) => names.has(n)).length; });
                group.sort((a, b) => b.h2h - a.h2h || b.points - a.points || a.seed - b.seed);
            }
            out.push(...group);
            i = j;
        }
        return out;
    }

    pointsTable() {
        return Object.values(this.tally()).map((r) => ({ ...r })).sort((a, b) => b.points - a.points || b.diff - a.diff || a.seed - b.seed);
    }

    /** Elimination stage per player: higher = went further. */
    eliminationStages() {
        const stage = {};
        this.players.forEach((p) => { stage[p.name] = null; });
        if (this.format === 'se') {
            const s = this.se();
            const K = s.rounds.length;
            s.rounds.forEach((round, r) => round.matches.forEach((m) => {
                const o = this.outcome(m);
                if (o?.loser && isReal(m.p1) && isReal(m.p2)) stage[o.loser] = r;
            }));
            if (s.third) {
                const o = this.outcome(s.third);
                if (o?.winner) stage[o.winner] = K - 1.5;
            }
            if (s.champion) stage[cleanPlayerName(s.champion)] = K + 1;
        } else if (this.format === 'de') {
            const s = this.de();
            s.losers.forEach((round, r) => round.matches.forEach((m) => {
                const o = this.outcome(m);
                if (o?.loser && isReal(m.p1) && isReal(m.p2)) stage[o.loser] = r;
            }));
            const L = s.losers.length;
            if (isReal(s.secondPlace)) stage[cleanPlayerName(s.secondPlace)] = L + 1;
            if (isReal(s.firstPlace)) stage[cleanPlayerName(s.firstPlace)] = L + 2;
        }
        return stage;
    }

    /** Standings with placement labels. DQ'd players always rank last. */
    finalRankings() {
        if (this._cache.final) return this._cache.final;
        let rows = Object.values(this.tally()).map((r) => ({ ...r }));
        if (this.format === 'se' || this.format === 'de') {
            const stage = this.eliminationStages();
            const alive = Number.MAX_SAFE_INTEGER - 1;
            rows.forEach((r) => { r.stage = r.isDQ ? -1 : stage[r.name] ?? alive; });
            rows.sort((a, b) => b.stage - a.stage || b.wins - a.wins || b.diff - a.diff || a.seed - b.seed);
            rows.forEach((r) => {
                const better = rows.filter((o) => o.stage > r.stage).length;
                const tied = rows.filter((o) => o.stage === r.stage).length;
                r.place = better + 1;
                r.alive = r.stage === alive;
                r.placeLabel = r.isDQ ? 'DQ' : r.alive ? '–' : `${tied > 1 ? 'T' : ''}${ordinal(r.place)}`;
            });
        } else {
            rows = [...this.rankLeague(rows.filter((r) => !r.isDQ)), ...rows.filter((r) => r.isDQ).sort((a, b) => a.seed - b.seed)];
            rows.forEach((r, i) => { r.place = i + 1; r.placeLabel = r.isDQ ? 'DQ' : ordinal(i + 1); });
        }
        return (this._cache.final = rows);
    }

    isMatchDone(m) {
        if (isBye(m.p1) || isBye(m.p2)) return true;
        if (isTBD(m.p1) || isTBD(m.p2)) return false;
        if (this.isDQ(m.p1) && this.isDQ(m.p2)) return true;
        const s = this.score(m.id, m.p1, m.p2);
        return s.p1 === this.target || s.p2 === this.target;
    }

    /** Matches that can be played right now, in schedule order. */
    upNext(limit = 8) {
        return this.matches().filter((m) => isReal(m.p1) && isReal(m.p2) && !this.isLocked(m.p1, m.p2) && !this.isMatchDone(m)).slice(0, limit);
    }

    progress() {
        const real = this.matches().filter((m) => !isBye(m.p1) && !isBye(m.p2));
        const done = real.filter((m) => this.isMatchDone(m)).length;
        let total = real.length;
        if (this.format === 'swiss') {
            const active = this.players.filter((p) => !p.isDQ).length;
            total += Math.max(0, this.swiss().totalRounds - this.swiss().rounds.length) * Math.floor(active / 2);
        }
        return { done, total };
    }

    isComplete() {
        if (this.players.length < 2) return false;
        const real = this.matches().filter((m) => !isBye(m.p1) && !isBye(m.p2));
        if (real.length === 0) return false;
        if (this.format === 'swiss' && this.swiss().rounds.length < this.swiss().totalRounds) return false;
        return real.every((m) => this.isMatchDone(m));
    }

    playerStats(name) {
        let wins = 0, losses = 0, sweeps = 0, gameWins = 0, gameLosses = 0;
        const history = [];
        const byeRounds = new Set(this.swissByes().filter((b) => b.name === name).map((b) => b.round));

        this.sections().forEach((sec) => {
            if (byeRounds.has(sec.title)) {
                wins++; gameWins += this.target;
                history.push({ round: sec.title, opponent: 'Bye', for: this.target, against: 0, result: 'W' });
            }
            sec.matches.forEach((m) => {
                if (m.type === 'bye') return;
                const n1 = cleanPlayerName(m.p1);
                const n2 = cleanPlayerName(m.p2);
                if (n1 !== name && n2 !== name) return;
                if (!isReal(m.p1) || !isReal(m.p2)) return;
                const s = this.score(m.id, m.p1, m.p2);
                const mine = n1 === name ? s.p1 : s.p2;
                const theirs = n1 === name ? s.p2 : s.p1;
                gameWins += mine; gameLosses += theirs;
                let result = null;
                if (mine === this.target) { wins++; result = 'W'; if (theirs === 0) sweeps++; }
                else if (theirs === this.target) { losses++; result = 'L'; }
                history.push({ round: sec.title, opponent: n1 === name ? n2 : n1, for: mine, against: theirs, result });
            });
        });
        const total = gameWins + gameLosses;
        return {
            wins, losses, sweeps, gameWins, gameLosses, points: gameWins,
            winRate: total ? Math.round((gameWins / total) * 100) : 0,
            history,
            form: history.filter((h) => h.result).map((h) => h.result),
        };
    }
}
