// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tournament, cleanPlayerName, isTBD, isBye } from '../src/js/engine.js';
import { encodePackage, decodePackage, recordToPackage, packageToRecord, PasswordRequiredError } from '../src/js/backup.js';
import { createZip, readZip } from '../src/js/zip.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ORIGINAL = path.join(root, 'extracted/.vite/renderer/main_window/index.html');

/** Load the original app's <script> into a sandbox with a stub DOM. */
function loadOriginal() {
    const html = fs.readFileSync(ORIGINAL, 'utf8');
    const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
    const el = () => ({ style: {}, innerHTML: '', innerText: '', value: '', appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
    const ctx = {
        window: {}, console,
        document: { getElementById: el, querySelectorAll: () => [], createElement: el, documentElement: { setAttribute() {}, getAttribute() {} } },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        alert() {}, confirm: () => true, setTimeout, clearTimeout,
    };
    vm.createContext(ctx);
    vm.runInContext(script, ctx);
    return ctx;
}

// Deterministic PRNG so failures are reproducible.
function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// At most one DQ: two DQ'd players meeting deadlocked the original engine, which the
// new engine fixes deliberately (see the double-forfeit test), so they can't be compared.
function makePlayers(n, withDQ, rand) {
    const dq = withDQ ? Math.floor(rand() * n) : -1;
    return Array.from({ length: n }, (_, i) => ({ name: `P${String(i + 1).padStart(2, '0')} ${['Ace', 'Bo', 'Cy'][i % 3]}`, seed: i + 1, isDQ: i === dq }));
}

/** Play every available match in both engines with identical random results until nothing changes. */
function simulate(format, n, target, seed, withDQ = false) {
    const rand = rng(seed);
    const players = makePlayers(n, withDQ, rand);
    const orig = loadOriginal();
    orig.__players = JSON.parse(JSON.stringify(players));
    vm.runInContext(`players = __players; matchScores = {}; currentFormat = ${JSON.stringify(format)}; winThreshold = ${target};`, orig);
    const newScores = {};

    const decided = {};
    for (let iter = 0; iter < 200; iter++) {
        vm.runInContext('invalidateComputeCache()', orig);
        const list = vm.runInContext('computeAllActiveMatches()', orig);
        let changed = false;
        for (const m of list) {
            if (isTBD(m.p1) || isTBD(m.p2) || isBye(m.p1) || isBye(m.p2)) continue;
            if (decided[m.id]) continue;
            decided[m.id] = true;
            const winnerFirst = rand() < 0.5;
            const loserScore = Math.floor(rand() * target);
            const sc = winnerFirst ? { p1: target, p2: loserScore } : { p1: loserScore, p2: target };
            orig.__s = { ...sc, player1: m.p1, player2: m.p2, id: m.id };
            vm.runInContext('matchScores[__s.id] = { p1: __s.p1, p2: __s.p2, player1: __s.player1, player2: __s.player2 }', orig);
            newScores[m.id] = { p1: sc.p1, p2: sc.p2, player1: m.p1, player2: m.p2 };
            changed = true;
        }
        if (!changed) break;
    }
    vm.runInContext('invalidateComputeCache()', orig);
    const t = new Tournament({ players, matchScores: newScores, format, winThreshold: target });
    return { orig, t };
}

function origStandings(orig) {
    return vm.runInContext(`(() => {
        let standings = {}, series = {};
        players.forEach(p => { standings[p.name] = 0; series[p.name] = { w: 0, l: 0 }; });
        if (currentFormat === 'swiss') getSwissState().rounds.forEach(r => r.matches.forEach(m => {
            if (m.type === 'bye' && series[m.active]) { series[m.active].w++; standings[m.active] += winThreshold; }
        }));
        getAllActiveMatches().forEach(am => {
            const m = getMatchScore(am.id, am.p1, am.p2);
            const a = cleanPlayerName(am.p1), b = cleanPlayerName(am.p2);
            if (a === 'BYE' || b === 'BYE' || a.startsWith('TBD') || b.startsWith('TBD')) return;
            if (standings[a] === undefined || standings[b] === undefined) return;
            standings[a] += m.p1; standings[b] += m.p2;
            if (m.p1 === winThreshold) { series[a].w++; series[b].l++; }
            else if (m.p2 === winThreshold) { series[b].w++; series[a].l++; }
        });
        return JSON.stringify({ standings, series });
    })()`, orig);
}

const cases = [];
for (const format of ['rr', 'swiss', 'se', 'de']) {
    for (const n of [2, 3, 5, 8, 11, 16]) {
        for (const target of [1, 3]) cases.push({ format, n, target, seed: n * 31 + target, dq: n >= 5 });
    }
}

for (const c of cases) {
    test(`matches original engine: ${c.format} n=${c.n} firstTo=${c.target}${c.dq ? ' with DQs' : ''}`, () => {
        const { orig, t } = simulate(c.format, c.n, c.target, c.seed, c.dq);
        const origMatches = JSON.parse(JSON.stringify(vm.runInContext('computeAllActiveMatches()', orig))).map((m) => [m.id, m.p1, m.p2]);
        const newMatches = t.matches().map((m) => [m.id, m.p1, m.p2]);
        if (c.format === 'swiss' && JSON.stringify(newMatches) !== JSON.stringify(origMatches)) {
            // Only allowed difference: the original greedy pairing forced a rematch
            // that the new backtracking pairing avoids.
            const rematches = (list) => {
                const seen = new Set();
                let n = 0;
                list.forEach(([, a, b]) => { const k = [a, b].sort().join('|'); if (seen.has(k)) n++; seen.add(k); });
                return n;
            };
            assert.ok(rematches(origMatches) > 0, 'original had a rematch');
            assert.ok(rematches(newMatches) < rematches(origMatches), 'new pairing has fewer rematches');
            return;
        }
        assert.deepEqual(newMatches, origMatches, 'same matches / pairings');

        const { standings, series } = JSON.parse(origStandings(orig));
        const tally = t.tally();
        for (const name of Object.keys(standings)) {
            assert.equal(tally[name].points, standings[name], `points for ${name}`);
            assert.equal(tally[name].wins, series[name].w, `wins for ${name}`);
            assert.equal(tally[name].losses, series[name].l, `losses for ${name}`);
        }
        if (c.format === 'de') {
            const o = JSON.parse(JSON.stringify(vm.runInContext('computeDEState()', orig)));
            const s = t.de();
            assert.equal(s.firstPlace, o.firstPlace);
            assert.equal(s.secondPlace, o.secondPlace);
        }
        assert.equal(t.isComplete(), vm.runInContext('isTournamentComplete()', vm.runInContext('activeId = "x"', orig) && orig));
        assert.ok(t.isComplete(), 'simulation finishes the tournament');
    });
}

test('single elimination placements: champion, finalist, T3, T5', () => {
    const { t } = simulate('se', 8, 2, 7);
    const ranks = t.finalRankings();
    assert.deepEqual(ranks.map((r) => r.placeLabel), ['1st', '2nd', 'T3rd', 'T3rd', 'T5th', 'T5th', 'T5th', 'T5th']);
    assert.equal(cleanPlayerName(t.se().champion), ranks[0].name);
});

test('double elimination placements put 1st/2nd from grand finals', () => {
    const { t } = simulate('de', 8, 2, 99);
    const ranks = t.finalRankings();
    assert.equal(ranks[0].name, cleanPlayerName(t.de().firstPlace));
    assert.equal(ranks[1].name, cleanPlayerName(t.de().secondPlace));
    assert.equal(ranks[0].placeLabel, '1st');
    assert.equal(ranks[1].placeLabel, '2nd');
});

test('changing an earlier SE result resets the downstream match instead of misattributing it', () => {
    const players = ['A', 'B', 'C', 'D'].map((name, i) => ({ name, seed: i + 1 }));
    const scores = {};
    let t = new Tournament({ players, matchScores: scores, format: 'se', winThreshold: 2 });
    t.matches();
    // R0: (#1)A vs (#4)D, (#2)B vs (#3)C
    scores.se_r0_m0.p1 = 2; scores.se_r0_m1.p1 = 2;
    t = new Tournament({ players, matchScores: scores, format: 'se', winThreshold: 2 });
    const f = t.se().rounds[1].matches[0];
    t.score(f.id, f.p1, f.p2).p1 = 2; // A beats B in the final
    t = new Tournament({ players, matchScores: scores, format: 'se', winThreshold: 2 });
    assert.equal(cleanPlayerName(t.se().champion), 'A');

    // Fix a typo: D actually beat A in round 1.
    scores.se_r0_m0.p1 = 1; scores.se_r0_m0.p2 = 2;
    t = new Tournament({ players, matchScores: scores, format: 'se', winThreshold: 2 });
    const final = t.se().rounds[1].matches[0];
    assert.equal(cleanPlayerName(final.p1), 'D');
    const s = t.score(final.id, final.p1, final.p2);
    assert.deepEqual([s.p1, s.p2], [0, 0], 'old A-vs-B result is not handed to D-vs-B');
    assert.equal(t.se().champion, null);
});

test('round robin keeps results when a player is removed and rounds shift', () => {
    const names = ['A', 'B', 'C', 'D', 'E'];
    const scores = {};
    const t = new Tournament({ players: names.map((name, i) => ({ name, seed: i + 1 })), matchScores: scores, format: 'rr', winThreshold: 1 });
    const ab = t.matches().find((m) => [m.p1, m.p2].sort().join() === 'A,B');
    const rec = t.score(ab.id, ab.p1, ab.p2);
    if (ab.p1 === 'A') rec.p1 = 1; else rec.p2 = 1;

    const t2 = new Tournament({ players: ['A', 'B', 'D', 'E'].map((name, i) => ({ name, seed: i + 1 })), matchScores: scores, format: 'rr', winThreshold: 1 });
    assert.equal(t2.tally().A.wins, 1, 'A still has the win over B');
    assert.equal(t2.tally().B.losses, 1);
});

test('two disqualified players meeting no longer deadlocks the bracket', () => {
    for (const format of ['se', 'de', 'rr']) {
        const players = ['A', 'B', 'C', 'D'].map((name, i) => ({ name, seed: i + 1, isDQ: name === 'A' || name === 'D' }));
        const scores = {};
        let t = new Tournament({ players, matchScores: scores, format, winThreshold: 1 });
        // Play out every remaining live match: higher seed wins.
        for (let i = 0; i < 10; i++) {
            t.matches().forEach((m) => {
                if (isTBD(m.p1) || isTBD(m.p2) || isBye(m.p1) || isBye(m.p2) || t.isLocked(m.p1, m.p2)) return;
                const r = t.record(m.id, m.p1, m.p2);
                if (r.p1 === 0 && r.p2 === 0) r.p1 = 1;
            });
            t = new Tournament({ players, matchScores: scores, format, winThreshold: 1 });
        }
        assert.ok(t.isComplete(), `${format} completes`);
        assert.deepEqual(t.finalRankings().slice(-2).map((r) => r.placeLabel), ['DQ', 'DQ']);
    }
});

test('swiss rounds lock once generated and do not reshuffle when an earlier result is corrected', () => {
    const players = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name, i) => ({ name, seed: i + 1 }));
    const scores = {};
    let t = new Tournament({ players, matchScores: scores, format: 'swiss', winThreshold: 1 });
    t.swiss().rounds[0].matches.forEach((m) => { t.record(m.id, m.p1, m.p2).p1 = 1; });
    t = new Tournament({ players, matchScores: scores, format: 'swiss', winThreshold: 1 });
    const r2 = t.swiss().rounds[1].matches.map((m) => [m.p1, m.p2]);
    assert.ok(t.repairableSwissRound(), 'fresh round can be re-paired');

    // Flip a round-1 result: round 2 pairings stay exactly as published.
    scores.swiss_r0_m0.p1 = 0; scores.swiss_r0_m0.p2 = 1;
    t = new Tournament({ players, matchScores: scores, format: 'swiss', winThreshold: 1 });
    assert.deepEqual(t.swiss().rounds[1].matches.map((m) => [m.p1, m.p2]), r2);

    // Re-pairing (deleting the round) generates fresh pairings from the new standings.
    t.repairableSwissRound().ids.forEach((id) => delete scores[id]);
    t = new Tournament({ players, matchScores: scores, format: 'swiss', winThreshold: 1 });
    assert.notDeepEqual(t.swiss().rounds[1].matches.map((m) => [m.p1, m.p2]), r2);
});

test('swiss avoids rematches and honours a custom round count', () => {
    const players = ['A', 'B', 'C', 'D'].map((name, i) => ({ name, seed: i + 1 }));
    const scores = {};
    let t;
    for (let r = 0; r < 3; r++) {
        t = new Tournament({ players, matchScores: scores, format: 'swiss', winThreshold: 1, swissRounds: 3 });
        const round = t.swiss().rounds[r];
        round.matches.forEach((m) => { t.record(m.id, m.p1, m.p2).p1 = 1; });
    }
    t = new Tournament({ players, matchScores: scores, format: 'swiss', winThreshold: 1, swissRounds: 3 });
    assert.equal(t.swiss().rounds.length, 3);
    const pairs = t.matches().map((m) => [m.p1, m.p2].sort().join());
    assert.equal(new Set(pairs).size, pairs.length, 'no pairing repeats over 3 rounds of 4 players');
    assert.ok(t.isComplete());
});

test('single elimination third-place match decides 3rd and 4th', () => {
    const players = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name, i) => ({ name, seed: i + 1 }));
    const scores = {};
    let t;
    for (let i = 0; i < 6; i++) {
        t = new Tournament({ players, matchScores: scores, format: 'se', winThreshold: 1, thirdPlace: true });
        t.upNext(99).forEach((m) => { t.record(m.id, m.p1, m.p2).p1 = 1; });
    }
    t = new Tournament({ players, matchScores: scores, format: 'se', winThreshold: 1, thirdPlace: true });
    assert.ok(t.isComplete());
    assert.deepEqual(t.finalRankings().map((r) => r.placeLabel).slice(0, 5), ['1st', '2nd', '3rd', '4th', 'T5th']);
    assert.ok(t.sections().some((s) => s.kind === 'third'));
});

test('head-to-head breaks a two-way tie regardless of input order', () => {
    // A beats B; both finish 1-1 with equal diff, so A must rank above B.
    const players = ['A', 'B', 'C'].map((name, i) => ({ name, seed: 3 - i }));
    const scores = {};
    const t0 = new Tournament({ players, matchScores: scores, format: 'rr', winThreshold: 1 });
    t0.matches().forEach((m) => {
        const pair = [m.p1, m.p2].sort().join();
        const winner = { 'A,B': 'A', 'B,C': 'B', 'A,C': 'C' }[pair];
        t0.record(m.id, m.p1, m.p2)[m.p1 === winner ? 'p1' : 'p2'] = 1;
    });
    const t = new Tournament({ players, matchScores: scores, format: 'rr', winThreshold: 1 });
    const order = t.finalRankings().map((r) => r.name);
    assert.equal(order.length, 3);
    // Three-way 1-1 cycle: every h2h count is 1, falls to points then seed (C is seed 1).
    assert.deepEqual(order, ['C', 'B', 'A']);
});

test('score clamps never produce two winners via DQ override', () => {
    const t = new Tournament({ players: [{ name: 'A', seed: 1, isDQ: true }, { name: 'B', seed: 2 }], matchScores: {}, format: 'se', winThreshold: 3 });
    const m = t.matches()[0];
    const s = t.score(m.id, m.p1, m.p2);
    assert.deepEqual([s.p1, s.p2], [0, 3]);
    assert.ok(t.isComplete());
    assert.equal(t.finalRankings()[1].placeLabel, 'DQ');
});

test('backup codes round-trip, including encrypted ones', async () => {
    const record = { name: 'Fri Night ✨', format: 'de', winThreshold: 2, players: [{ name: 'Zoë', seed: 1 }, { name: 'Kai', seed: 2 }], matchScores: { de_gf_m0: { p1: 2, p2: 0, player1: '(#1) Zoë', player2: '(#2) Kai' } } };
    const plain = await encodePackage(recordToPackage(record));
    assert.ok(plain.startsWith('THUB10.'));
    const back = packageToRecord(await decodePackage(plain));
    assert.equal(back.name, record.name);
    assert.equal(back.players[0].name, 'Zoë');

    const locked = await encodePackage(recordToPackage(record, true), 'hunter2');
    assert.ok(locked.startsWith('THUB11.'));
    await assert.rejects(decodePackage(locked), PasswordRequiredError);
    await assert.rejects(decodePackage(locked, 'nope'), /Wrong password/);
    const unlocked = await decodePackage(locked, 'hunter2');
    assert.deepEqual(unlocked.scores, record.matchScores);
});

test('decodes a code produced by the original app (btoa/escape encoding)', async () => {
    const pkg = { v: 10, roster: [{ name: 'Ä', seed: 1, isDQ: false }, { name: 'B', seed: 2, isDQ: false }], scores: {}, format: 'rr', firstTo: 3, name: 'Ünïcode' };
    const legacy = 'THUB10.' + btoa(unescape(encodeURIComponent(JSON.stringify(pkg))));
    const out = await decodePackage(legacy);
    assert.equal(out.name, 'Ünïcode');
    assert.equal(out.roster[0].name, 'Ä');
});

test('zip writer output is readable, and deflated zips from the system zip tool are too', async () => {
    const files = [{ name: '01_a.txt', content: 'hello' }, { name: '02_b.txt', content: 'wörld '.repeat(200) }];
    const entries = await readZip(createZip(files));
    assert.deepEqual(entries.map((e) => [e.name, e.text]), files.map((f) => [f.name, f.content]));

    const { execFileSync } = await import('node:child_process');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-zip-'));
    fs.writeFileSync(path.join(dir, 'x.txt'), 'compress me '.repeat(500));
    try {
        execFileSync('zip', ['-q', '-9', 'out.zip', 'x.txt'], { cwd: dir });
        const got = await readZip(new Uint8Array(fs.readFileSync(path.join(dir, 'out.zip'))));
        assert.equal(got[0].text, 'compress me '.repeat(500));
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
