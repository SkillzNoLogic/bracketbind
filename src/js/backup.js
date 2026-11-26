// Backup codes — 100% compatible with the original app:
//   THUB10.<base64 JSON>            unlocked
//   THUB11.<base64 envelope JSON>   AES-GCM, PBKDF2-SHA256 key from a password
// Plain base64 JSON (pre-THUB) is also accepted on import.

import { normalizePlayers, FORMATS } from './engine.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

const encodeJson = (data) => bytesToBase64(enc.encode(JSON.stringify(data)));
const decodeJson = (raw) => JSON.parse(dec.decode(base64ToBytes(raw.replace(/\s+/g, ''))));

async function deriveKey(password, salt, iterations) {
    const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

export function recordToPackage(record, encrypted = false) {
    return {
        v: encrypted ? 11 : 10,
        roster: record.players || [],
        scores: record.matchScores || {},
        format: record.format || 'rr',
        firstTo: record.winThreshold || 3,
        name: record.name,
        // Extra fields are ignored by the original app, so codes stay cross-compatible.
        swissRounds: record.swissRounds || undefined,
        thirdPlace: record.thirdPlace || undefined,
        exportedAt: new Date().toISOString(),
    };
}

export async function encodePackage(pkg, password = '') {
    if (!password) return 'THUB10.' + encodeJson(pkg);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const iterations = 150000;
    const key = await deriveKey(password, salt, iterations);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(pkg)));
    return 'THUB11.' + encodeJson({
        v: 11, encrypted: true, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iterations,
        salt: bytesToBase64(salt), iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(cipher)),
    });
}

export class PasswordRequiredError extends Error {
    constructor() { super('This backup is password protected.'); this.name = 'PasswordRequiredError'; }
}

export function isEncryptedCode(raw) {
    const t = raw.trim();
    if (!t.startsWith('THUB11.')) return false;
    try { return !!decodeJson(t.slice(7)).encrypted; } catch { return false; }
}

export async function decodePackage(raw, password = '') {
    const t = raw.trim();
    if (t.startsWith('THUB10.')) return decodeJson(t.slice(7));
    if (t.startsWith('THUB11.')) {
        const env = decodeJson(t.slice(7));
        if (!env.encrypted) return env;
        if (!password) throw new PasswordRequiredError();
        try {
            const key = await deriveKey(password, base64ToBytes(env.salt), env.iterations || 150000);
            const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(env.iv) }, key, base64ToBytes(env.data));
            return JSON.parse(dec.decode(plain));
        } catch {
            throw new Error('Wrong password, or the backup is damaged.');
        }
    }
    try { return decodeJson(t); } catch { throw new Error('That doesn’t look like a tournament backup code.'); }
}

let idCounter = 0;
export function newId() {
    idCounter = (idCounter + 1) % 1000;
    return `t_${Date.now()}_${idCounter}${Math.random().toString(36).slice(2, 6)}`;
}

export function packageToRecord(pkg) {
    const players = normalizePlayers(pkg.roster || pkg.players);
    if (players.length < 2) throw new Error('Backup needs at least two players.');
    const now = new Date();
    return {
        id: newId(),
        name: String(pkg.name || 'Imported Tournament'),
        date: now.toLocaleDateString(),
        createdAt: pkg.exportedAt || now.toISOString(),
        updatedAt: now.toISOString(),
        format: FORMATS[pkg.format] ? pkg.format : 'rr',
        winThreshold: Number(pkg.firstTo || pkg.winThreshold) || 3,
        players,
        matchScores: pkg.scores || pkg.matchScores || {},
        swissRounds: Number(pkg.swissRounds) || undefined,
        thirdPlace: !!pkg.thirdPlace,
    };
}
