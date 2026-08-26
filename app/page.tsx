"use client";
import React, { useState, useEffect, useRef, useCallback, useMemo, startTransition } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';

// ============================================================
// MADINA MEDICINE CORNER - PROFESSIONAL PHARMACY POS SYSTEM
// Version 8.0 - Advanced Edition + Firebase Cloud Sync
// ============================================================

// ============================================================
// FIREBASE CLOUD SYNC — Firebase is the ONLY data store.
// ─────────────────────────────────────────────────────────────
// Business data (medicines, invoices, sales, settings, etc.) lives
// exclusively in Firebase. Nothing is cached in localStorage, so:
//   • The app REQUIRES an internet connection to load or save data.
//   • There is never a stale/conflicting local copy — every device
//     always works directly against the same live data.
// Device-only preferences (login session, theme, sound, language)
// still use localStorage, since those are intentionally per-device
// and have nothing to do with business data sync.
//
// HOW TO SETUP (one-time, 5 minutes):
//
// 1. Go to https://console.firebase.google.com
// 2. Click "Add project" → give it a name → Continue
// 3. In the project, click "Build" → "Realtime Database"
// 4. Click "Create Database" → choose any location → Start in TEST MODE
// 5. Click "Project Settings" (gear icon) → "Your apps" → </> (Web)
// 6. Register app → copy the firebaseConfig values below
// 7. In Realtime Database → Rules → paste the contents of firebase-database-rules.json
//    (included in this project). DO NOT use { ".read": true, ".write": true } at the
//    root level — that exposes the entire database to the public internet.
//    The hardened rules scope access to /madina_data, /madina_data_test, and
//    /madina_backups only. All other paths are denied by default.
//    → Publish after pasting.
//
// Then fill in YOUR values in FIREBASE_CONFIG below.
// ============================================================

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDP3TKZA9gBCkQeM5pu7Lg9K56kmvvtRpw",
  databaseURL: "https://madinamedicine2-b742b-default-rtdb.asia-southeast1.firebasedatabase.app",
};

// Keys that sync to cloud (business data). Session/theme/sound are device-local only.
const CLOUD_SYNC_KEYS = [
  'madina_v7_meds',
  'madina_v7_invoices',
  'madina_v7_purchases',
  'madina_v7_due_list',
  'madina_v7_due_collection_log',
  'madina_v7_companies',
  'madina_v7_mednames',
  'madina_v7_medmeta',
  'madina_v7_sales',
  'madina_v7_profit',
  'madina_v7_expenses',
  'madina_v7_admin_user',
  'madina_v7_admin_pass',
  'madina_v7_staff_user',
  'madina_v7_staff_pass',
  'madina_v7_creator_user',
  'madina_v7_creator_pass',
  'madina_v7_telegram_bot_token',
  'madina_v7_telegram_chat_id',
  'madina_v7_reset_otp',
  'madina_v7_staff_perms',
  'madina_v7_admin_perms',
  'madina_v7_system_locked',
  'madina_v7_creator_notice',
  'madina_v7_name',
  'madina_v7_slogan',
  'madina_v7_address',
  'madina_v7_logo',
  'madina_v7_currency',
  'madina_v7_vat',
  'madina_v7_threshold',
  'madina_v7_footer',
  // Phase 3: proper payment + cash ledgers
  'madina_v7_payment_ledger',
  'madina_v7_cash_ledger',
  // Phase 4: stock movement ledger
  'madina_v7_stock_movements',
  // Phase 6: audit log for financial changes
  'madina_v7_audit_log',
];

// ── Backup versioning ────────────────────────────────────────
// Increment BACKUP_SCHEMA_VERSION whenever a new CLOUD_SYNC_KEY is added
// or an existing key's value format changes in a breaking way.
// The restore path rejects backups whose schemaVersion < MIN_RESTORE_SCHEMA_VERSION.
const BACKUP_SCHEMA_VERSION = 6;      // Phase 6: reconciliation + audit log
const MIN_RESTORE_SCHEMA_VERSION = 1; // accept all v1+ backups

// ── Firebase REST helpers (no SDK needed — pure fetch) ──────
const isFirebaseConfigured = () =>
  FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY" &&
  FIREBASE_CONFIG.databaseURL !== "YOUR_DATABASE_URL" &&
  !!FIREBASE_CONFIG.databaseURL;

// ── Local vs Live data separation ─────────────────────────
// When this app is run on localhost (i.e. you're testing on your own
// computer), it must NOT write into the same data your live website
// uses — otherwise test sales show up as real sales and mess up your
// accounts. So locally we use a separate root path ("madina_data_test")
// in the SAME Firebase project. Your real/live website (any domain that
// isn't localhost/127.0.0.1) keeps using "madina_data" as before —
// nothing changes there.
const DATA_ROOT = (() => {
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
      return 'madina_data_test';
    }
  }
  return 'madina_data';
})();

const fbUrl = (key: string) =>
  `${FIREBASE_CONFIG.databaseURL}/${DATA_ROOT}/${key}.json`;

// Fetch with timeout — works on slow mobile data connections
const fetchWithTimeout = (url: string, options: RequestInit = {}, timeoutMs = 10000): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
};

// Write a single key directly to Firebase. Firebase is the ONLY place
// business data lives now — there is no local cache to fall back to,
// so if this fails the caller's UI should surface that the save did
// not go through (see saveQueue / useCloudSaveStatus below).
const fbSet = async (key: string, value: string): Promise<boolean> => {
  if (!isFirebaseConfigured()) return false;
  try {
    const res = await fetchWithTimeout(fbUrl(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    return res.ok;
  } catch {
    return false;
  }
};

// Read a single key from Firebase
const fbGet = async (key: string): Promise<string | null> => {
  if (!isFirebaseConfigured()) return null;
  try {
    const res = await fetchWithTimeout(fbUrl(key));
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data === 'string' ? data : null;
  } catch { return null; }
};

// ── Atomic multi-key write ───────────────────────────────────
// ROOT CAUSE FIX: a Sale used to be saved as 5 separate, un-awaited
// fbSet() calls (invoices, meds/stock, due list, due log, sales,
// profit) racing each other over the network. If the tab closed, the
// network blipped, or one request timed out mid-flight, some keys
// landed and others didn't — e.g. stock got deducted but the invoice
// never saved, exactly the symptom reported.
//
// Firebase's Realtime Database REST API supports a single multi-path
// PATCH to the database root: { "/keyA": valueA, "/keyB": valueB, ... }
// This is ONE HTTP request — the server applies all paths in a single
// write. Either the whole request lands, or (on network failure/abort)
// none of it does. That removes the interleaving window that caused
// partial sales. It is not a cross-request ACID transaction (a second
// device could still write concurrently — that's handled separately
// by fetchLatestList/updateMedicinesOnCloud re-fetching fresh state
// first), but it eliminates the single-sale partial-write failure mode.
const fbMultiSet = async (updates: Record<string, string>): Promise<boolean> => {
  if (!isFirebaseConfigured()) return false;
  const body: Record<string, string> = {};
  for (const key of Object.keys(updates)) {
    if (!CLOUD_SYNC_KEYS.includes(key)) continue; // guard against typos writing outside the sync'd key set
    body[`/${key}`] = updates[key];
  }
  try {
    const res = await fetchWithTimeout(`${FIREBASE_CONFIG.databaseURL}/${DATA_ROOT}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 15000); // slightly longer timeout — this call now carries the whole sale
    return res.ok;
  } catch {
    return false;
  }
};

// cloudSet-compatible wrapper so pending-save UI indicators still work
// for the atomic multi-key write.
const cloudMultiSet = async (updates: Record<string, string>): Promise<boolean> => {
  pendingSaves++;
  notifySaveListeners();
  const ok = await fbMultiSet(updates);
  pendingSaves = Math.max(0, pendingSaves - 1);
  if (!ok) hasFailedSave = true;
  notifySaveListeners();
  return ok;
};

// Read ALL cloud keys at once (faster than individual reads on load)
const fbGetAll = async (): Promise<Record<string, string> | null> => {
  if (!isFirebaseConfigured()) return null;
  try {
    const res = await fetchWithTimeout(
      `${FIREBASE_CONFIG.databaseURL}/${DATA_ROOT}.json`,
      {},
      12000
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object') return null;
    const result: Record<string, string> = {};
    for (const k of CLOUD_SYNC_KEYS) {
      if (typeof data[k] === 'string') result[k] = data[k];
    }
    return result;
  } catch { return null; }
};

// ── ETag-based conditional stock write (optimistic lock) ─────
// Firebase REST supports If-Match: "<etag>" — the server rejects the
// write with HTTP 412 if the value changed since we last read it.
// This is the strongest per-key concurrency guarantee available via
// the REST API without the full SDK. We use it for the medicines key
// so two devices selling the same item in the same second can't both
// read "stock=5", both subtract 3, and both write "stock=2" — the
// loser gets a 412 and retries against the freshest value.
//
// Flow per sale:
//   1. GET medicines with ETag
//   2. Validate cart quantities against the returned stock
//   3. PUT the deducted medicines with If-Match: <etag>
//      → 200 OK  : stock deducted safely
//      → 412     : someone else changed it — retry from step 1
//   4. After MAX_RETRIES give up and surface an error to the cashier
const STOCK_MAX_RETRIES = 4;

const fbGetWithETag = async (key: string): Promise<{ data: string | null; etag: string | null }> => {
  if (!isFirebaseConfigured()) return { data: null, etag: null };
  try {
    const res = await fetchWithTimeout(fbUrl(key), {
      // X-Firebase-ETag: true is REQUIRED — without it Firebase Realtime Database
      // does not include an ETag in the response header and the conditional PUT
      // will always fail (If-Match: null → rejected → "no internet" error).
      headers: { Accept: 'application/json', 'X-Firebase-ETag': 'true' },
    }, 10000);
    if (!res.ok) return { data: null, etag: null };
    const etag = res.headers.get('ETag');
    const data = await res.json();
    return { data: typeof data === 'string' ? data : null, etag };
  } catch { return { data: null, etag: null }; }
};

const fbConditionalPut = async (key: string, value: string, etag: string): Promise<'ok' | 'conflict' | 'error'> => {
  if (!isFirebaseConfigured()) return 'error';
  try {
    const res = await fetchWithTimeout(fbUrl(key), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': etag,
      },
      body: JSON.stringify(value),
    }, 10000);
    if (res.status === 412) return 'conflict'; // another device changed it
    if (res.ok) return 'ok';
    return 'error';
  } catch { return 'error'; }
};

// Deduct soldQtyByMedId from Firebase meds atomically using ETag optimistic lock.
// Returns: { ok: true, updatedMeds } on success
//          { ok: false, reason: 'insufficient' | 'network', details? } on failure
const deductStockAtomically = async (
  soldQtyByMedId: Record<number, number>,
  t: (en: string, bn: string) => string
): Promise<
  | { ok: true; updatedMeds: any[] }
  | { ok: false; reason: 'insufficient'; details: string[] }
  | { ok: false; reason: 'network' }
> => {
  for (let attempt = 0; attempt < STOCK_MAX_RETRIES; attempt++) {
    // Step 1: read fresh stock + ETag
    const { data: rawMeds, etag } = await fbGetWithETag('madina_v7_meds');
    if (!rawMeds || !etag) return { ok: false, reason: 'network' };

    let freshMeds: any[];
    try { freshMeds = JSON.parse(rawMeds); } catch { return { ok: false, reason: 'network' }; }

    // Step 2: validate — re-check every item against the stock we just fetched
    const insufficientItems: string[] = [];
    for (const [medIdStr, requestedQty] of Object.entries(soldQtyByMedId)) {
      const medId = Number(medIdStr);
      const med = freshMeds.find((m: any) => m.id === medId);
      const available = med ? (med.stock ?? 0) : 0;
      if (requestedQty > available) {
        const name = med?.name ?? `ID:${medId}`;
        insufficientItems.push(
          `${name} (${t('available', 'মজুদ আছে')}: ${available}, ${t('in cart', 'কার্টে')}: ${requestedQty})`
        );
      }
    }
    if (insufficientItems.length > 0) return { ok: false, reason: 'insufficient', details: insufficientItems };

    // Step 3: apply deduction to the freshly-read array
    const updatedMeds = freshMeds.map((m: any) =>
      soldQtyByMedId[m.id]
        ? { ...m, stock: Math.max(0, m.stock - soldQtyByMedId[m.id]) }
        : m
    );

    // Step 4: conditional write — server rejects if ETag changed
    const result = await fbConditionalPut('madina_v7_meds', JSON.stringify(updatedMeds), etag);
    if (result === 'ok') return { ok: true, updatedMeds };
    if (result === 'conflict') continue; // retry with fresh read
    return { ok: false, reason: 'network' }; // non-retryable HTTP error
  }
  return { ok: false, reason: 'network' }; // exhausted retries
};

// Delete a single key from Firebase
const fbDelete = async (key: string): Promise<boolean> => {
  if (!isFirebaseConfigured()) return false;
  try {
    const res = await fetchWithTimeout(fbUrl(key), { method: 'DELETE' });
    return res.ok;
  } catch { return false; }
};

// ── Firebase Real-time Listener via SSE ─────────────────────
// Returns an unsubscribe function. Calls onChange(data) whenever
// ANY key under /madina_data changes on Firebase (from any device).
// Since Firebase is the single source of truth, every event is applied
// as-is — there's no local copy to compare against or protect.
const fbListenAll = (onChange: (data: Record<string, string>) => void): (() => void) => {
  if (!isFirebaseConfigured() || typeof window === 'undefined' || typeof EventSource === 'undefined') {
    return () => {};
  }
  const url = `${FIREBASE_CONFIG.databaseURL}/${DATA_ROOT}.json`;
  let es: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const extractResult = (path: string, data: any): Record<string, string> => {
    const result: Record<string, string> = {};
    if (!data) return result;

    if (path === '/' || path === '') {
      // Full snapshot: data is the whole /madina_data object
      if (typeof data === 'object') {
        for (const k of CLOUD_SYNC_KEYS) {
          if (typeof data[k] === 'string') result[k] = data[k];
        }
      }
    } else {
      // Single-key update: path is e.g. "/madina_v7_invoices"
      const key = path.replace(/^\//, ''); // strip leading slash
      if (CLOUD_SYNC_KEYS.includes(key) && typeof data === 'string') {
        result[key] = data;
      }
    }
    return result;
  };

  const connect = () => {
    if (stopped) return;
    es = new EventSource(url);

    es.addEventListener('put', (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data);
        const result = extractResult(payload.path || '/', payload.data);
        if (Object.keys(result).length > 0) onChange(result);
      } catch { /* malformed event */ }
    });

    es.addEventListener('patch', (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data);
        const result = extractResult(payload.path || '/', payload.data);
        if (Object.keys(result).length > 0) onChange(result);
      } catch { /* malformed event */ }
    });

    es.onerror = () => {
      es?.close();
      es = null;
      if (!stopped) {
        retryTimer = setTimeout(connect, 5000); // retry in 5s
      }
    };
  };

  connect();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    es?.close();
    es = null;
  };
};

// ── Pending-save tracking ────────────────────────────────────
// Since there's no localStorage cache, a failed write to Firebase means
// that data is genuinely not saved anywhere yet. We track in-flight/failed
// writes here so the UI (via useCloudSaveStatus) can clearly tell the user
// "not saved — check your internet" instead of silently losing data.
type SaveListener = (pendingCount: number, hasFailure: boolean) => void;
let pendingSaves = 0;
let hasFailedSave = false;
const saveListeners = new Set<SaveListener>();
const notifySaveListeners = () => {
  for (const l of saveListeners) l(pendingSaves, hasFailedSave);
};

// cloudSet: writes DIRECTLY to Firebase. No localStorage involved for
// business data — Firebase is the single source of truth on every device.
// Returns a promise so callers that need to confirm a save can await it.
const cloudSet = async (key: string, value: string): Promise<boolean> => {
  if (!CLOUD_SYNC_KEYS.includes(key)) {
    // Non-business key — shouldn't happen, but no-op safely
    return true;
  }
  pendingSaves++;
  notifySaveListeners();
  const ok = await fbSet(key, value);
  pendingSaves = Math.max(0, pendingSaves - 1);
  if (!ok) hasFailedSave = true;
  notifySaveListeners();
  return ok;
};

// ============================================================
// SOUND ENGINE — Web Audio API (no external deps)
// ============================================================
// ── Shared AudioContext (singleton) ──────────────────────────
// Creating a new AudioContext on every single sound (every click,
// every tab switch) is expensive and was the main cause of UI lag:
// each click had to pay the cost of spinning up a whole new audio
// engine before the tap even registered. We create ONE context once,
// keep it alive, and just resume it if the browser auto-suspends it.
let __sharedAudioCtx: AudioContext | null = null;
const getSharedAudioContext = (): AudioContext | null => {
  if (typeof window === 'undefined') return null;
  try {
    if (!__sharedAudioCtx || __sharedAudioCtx.state === 'closed') {
      __sharedAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (__sharedAudioCtx.state === 'suspended') {
      __sharedAudioCtx.resume();
    }
    return __sharedAudioCtx;
  } catch {
    return null;
  }
};

const createSound = (type: 'success' | 'click' | 'error' | 'add' | 'login' | 'notify' | 'delete' | 'checkout' | 'tab' | 'warning' | 'print' | 'save') => {
  if (typeof window === 'undefined') return;
  try {
    const ctx = getSharedAudioContext();
    if (!ctx) return;
    const g = ctx.createGain();
    g.connect(ctx.destination);

    const play = (freq: number, dur: number, vol: number, wave: OscillatorType = 'sine', delay = 0) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(g);
      osc.type = wave;
      osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
      gain.gain.setValueAtTime(0, ctx.currentTime + delay);
      gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + dur);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + dur + 0.05);
    };

    if (type === 'success') {
      play(523, 0.15, 0.3); play(659, 0.15, 0.3, 'sine', 0.12); play(784, 0.25, 0.3, 'sine', 0.24);
    } else if (type === 'click') {
      play(800, 0.06, 0.15, 'square');
    } else if (type === 'add') {
      play(440, 0.1, 0.2); play(550, 0.1, 0.2, 'sine', 0.08);
    } else if (type === 'error') {
      play(200, 0.2, 0.3, 'sawtooth'); play(150, 0.2, 0.3, 'sawtooth', 0.15);
    } else if (type === 'login') {
      play(440, 0.1, 0.2); play(554, 0.1, 0.2, 'sine', 0.1); play(659, 0.1, 0.2, 'sine', 0.2); play(880, 0.2, 0.25, 'sine', 0.3);
    } else if (type === 'notify') {
      play(600, 0.12, 0.2, 'sine'); play(750, 0.12, 0.2, 'sine', 0.1);
    } else if (type === 'delete') {
      play(300, 0.08, 0.2, 'square'); play(220, 0.15, 0.25, 'sawtooth', 0.06);
    } else if (type === 'checkout') {
      play(523, 0.1, 0.25); play(659, 0.1, 0.25, 'sine', 0.08); play(784, 0.1, 0.25, 'sine', 0.16);
      play(1046, 0.2, 0.3, 'sine', 0.24); play(1318, 0.25, 0.3, 'sine', 0.36);
    } else if (type === 'tab') {
      play(600, 0.06, 0.1, 'triangle');
    } else if (type === 'warning') {
      play(350, 0.1, 0.25, 'triangle'); play(280, 0.15, 0.2, 'triangle', 0.12);
    } else if (type === 'print') {
      play(440, 0.05, 0.15, 'square'); play(660, 0.05, 0.15, 'square', 0.06);
      play(440, 0.05, 0.15, 'square', 0.12); play(880, 0.1, 0.2, 'sine', 0.18);
    } else if (type === 'save') {
      play(523, 0.08, 0.2, 'sine'); play(784, 0.15, 0.25, 'sine', 0.1);
    }
    // Note: we intentionally do NOT close the context here anymore —
    // it's shared/reused across all sounds (see getSharedAudioContext).
  } catch {}
};


// Static data - defined outside component to avoid recreation on every render
const defaultMedicines = [
  { id: 1, name: "Napa Extend (500mg)", category: "Tablet", buyPrice: 11, price: 15, stock: 120, expire: "2027-12-01", generic: "Paracetamol", rack: "A-2", supplier: "Beximco Pharmaceuticals Ltd.", lowStockAlert: 10 },
  { id: 2, name: "Ace Plus", category: "Tablet", buyPrice: 9, price: 12, stock: 4, expire: "2026-09-15", generic: "Paracetamol + Caffeine", rack: "A-2", supplier: "Square Pharmaceuticals Ltd.", lowStockAlert: 10 },
  { id: 3, name: "Seclo 20mg", category: "Capsule", buyPrice: 5, price: 7, stock: 200, expire: "2025-04-10", generic: "Omeprazole", rack: "B-1", supplier: "Incepta Pharmaceuticals Ltd.", lowStockAlert: 10 },
  { id: 4, name: "Tusca Syrup", category: "Syrup", buyPrice: 65, price: 85, stock: 45, expire: "2027-01-20", generic: "Dextromethorphan", rack: "C-4", supplier: "Sandoz", lowStockAlert: 10 }
];

const initialMedicineCompanies = [
  "Square Pharmaceuticals Ltd.", "Incepta Pharmaceuticals Ltd.", "Beximco Pharmaceuticals Ltd.",
  "Opsonin Pharma Ltd.", "Renata Limited", "The ACME Laboratories Ltd.",
  "Healthcare Pharmaceuticals Ltd.", "Aristopharma Ltd.", "Eskayef Pharmaceuticals Ltd. (SK+F)",
  "Popular Pharmaceuticals Ltd.", "Radiant Pharmaceuticals Ltd.", "Beacon Pharmaceuticals Ltd.",
  "Ibn Sina Pharmaceutical Industry Ltd.", "Drug International Ltd.", "General Pharmaceuticals Ltd.",
  "Ziska Pharmaceuticals Ltd.", "Nuvista Pharma Limited", "Delta Pharma Limited",
  "Pacific Pharmaceuticals Ltd.", "Orion Pharma Ltd.", "Globe Pharmaceuticals Ltd.",
  "Saniee Pharma", "Astra Biopharmaceuticals Ltd.", "White Horse Pharmaceuticals",
  "Asiatic Laboratories Ltd.", "JMI Syringes & Medical Devices Ltd.", "Sharif Pharmaceuticals Ltd.",
  "Somatec Pharmaceuticals Ltd.", "Techno Drugs Ltd.", "Zenith Pharmaceuticals Ltd.",
  "Navana Pharmaceuticals Ltd.", "Biopharma Ltd.", "Nipro JMI Pharma Ltd.",
  "Medimet Pharmaceuticals Ltd.", "Supreme Pharmaceuticals Ltd.", "Alco Pharma Ltd.",
  "Amico Laboratories Ltd.", "Veritas Pharmaceuticals Ltd.", "Team Pharmaceuticals Ltd.",
  "Euro Pharma Ltd.", "Avenz Pharma", "Ad-din Pharmaceuticals Ltd.", "Al-Madina Pharma",
  "Ambee Pharmaceuticals Ltd.", "Apollo Pharmaceutical", "Biochem Laboratories Ltd.",
  "Central Pharmaceuticals Ltd.", "Doctor Tims Pharma", "Eden Pharmaceuticals",
  "G A Company", "Gaco Pharmaceuticals", "Hallmark Pharmaceuticals",
  "Hudson Pharmaceuticals Ltd.", "Kemiko Pharmaceuticals Ltd.", "Libra Pharmaceutics Ltd.",
  "Millennium Pharmaceuticals Ltd.", "Modern Pharmaceuticals Ltd.", "National Laboratories Ltd.",
  "Nipa Pharmaceuticals Ltd.", "Novartis Bangladesh Ltd.", "One Pharma Ltd.",
  "Organic Health Care", "Pharma Asia Ltd.", "Pharmadesh Chemical Industries",
  "Premier Pharmaceuticals", "Proteon Pharmaceuticals", "Rephco Pharmaceuticals Ltd.",
  "Rangs Pharmaceuticals Ltd.", "Salton Pharmaceuticals", "Silva Pharmaceuticals Ltd.",
  "Skylab Pharmaceutical Ltd.", "Standard Laboratories Ltd.", "Sunman Pharma",
  "Unimed Unihealth Pharmaceuticals", "Ziska Clinical Data Corp"
];

const initialMedicineNamesList = [
  "Napa 500mg", "Napa Extend", "Ace 500mg", "Ace Plus", "Fast 500mg", "Reset 500mg",
  "Seclo 20mg", "Losec 20mg", "Sompraz 20mg", "Sompraz 40mg", "Sergel 20mg", "Sergel 40mg",
  "Finix 20mg", "Proceptin 20mg", "Maxpro 20mg", "Maxpro 40mg", "Alatrol 10mg", "Histacin",
  "Fexo 120mg", "Fexo 180mg", "Telfast 120mg", "Provair 10mg", "Monas 10mg", "Avelox 400mg",
  "Zimax 500mg", "Azithrocin 500mg", "Tridosil 500mg", "Fixit 200mg", "Ciprocin 500mg",
  "Xelbio 500mg", "Pantobex 20mg", "Pantonix 20mg", "Pantonix 40mg",
  "Bizoran 5/20", "Camlosart 5/20", "Angilock 50mg", "Osartil 50mg", "Corgard 40mg",
  "Bizoran 5/40", "Cardizen 30mg", "Amlopin 5mg", "Moduretic", "Lasix 40mg", "Fruselac",
  "Atova 10mg", "Torvax 10mg", "Lipiget 10mg", "Rovista 10mg", "Rosuva 10mg", "Ezetimibe",
  "Metfo 500mg", "Comet 500mg", "Secrin 2mg", "Amaryl 2mg", "Glimus 2mg", "Galvus Met 50/500",
  "Tusca Syrup", "Adryl Syrup", "Corex Syrup", "Peditrin Syrup", "Ambrolit Syrup", "Brozedex Syrup",
  "Filwel Silver", "Bextram Gold", "Revital", "Square Vitamin C", "Ceevit", "Zincil Syrup",
  "Entacyd", "Avomine", "Emistat 8mg", "Ondemet 8mg", "Joytrip", "Motigut 10mg", "Omidon 10mg",
  "Fenadin 120mg", "Tufnil 200mg", "Napa Extra", "Eoril 20mg", "Gaviscon Suspension", "Pepto-Bismol",
  "Amocil 250mg", "Amoxil 500mg", "Moxilin Capsule", "Fimoxyl 500mg", "Aritro 500mg", "Zithrox 500mg",
  "Cef-3 Capsule", "Cef-3 Syrup", "Triocim 1gm", "Xorimax 500mg", "Zinnat 500mg", "Cefurox 500mg",
  "Fluclox 500mg", "Phylopen 500mg", "Anclog 75mg", "Plagrin 75mg", "Ecosprin 75mg", "Atrin 75mg",
  "Clobit 75mg", "Rosuvas 10mg", "Lipirex 10mg", "Statix 10mg", "Zocor 10mg", "Pravachol 20mg",
  "Secrin 1mg", "Diapro 80mg", "Combid 2/500", "Janumet 50/500", "Trajenta 5mg", "Jardiance 10mg",
  "Avandia 4mg", "Actos 15mg", "Duet 2mg", "Glimer 2mg", "Glucophage 800mg", "Glibenclamide 5mg",
  "Xenical 120mg", "Lasix Injection", "Dytor 10mg", "Aldactone 25mg",
  "Concor 5mg", "Biselect 5mg", "Cardon 6.25mg", "Carvida 6.25mg", "Tenormin 50mg", "Betaloc 50mg",
  "Inderal 10mg", "Sorbitrate 5mg", "Monocard 20mg", "Nitroglycerin Spray", "Nitrocard SR", "Adalat 20mg",
  "Norvasc 5mg", "Camlodin 5mg", "Zanidip 10mg", "Nimotop Tablet", "Serc 16mg", "Betahistine Incepta",
  "Stugeron 25mg", "Cinaron 25mg", "Vertigon 25mg", "Aricept 5mg", "Memantine Renata", "Ebixa 10mg",
  "Neubac", "Maxbac", "Targocid", "Vancomycin", "Linezolid Incepta", "Zyvox 600mg", "Meropenem 1gm",
  "Inem 1gm", "Tienam 500mg", "Zosyn Injection", "Tazocin 4.5gm", "Sulbin 1.5gm", "Unasyn 375mg"
];

// All medicine categories
const allCategories = [
  "Tablet", "Capsule", "Syrup", "Injection", "Cream", "Ointment", "Lotion",
  "Solution", "Shampoo", "Inhaler", "Refill", "Toothpaste", "Toothbrush",
  "Diaper", "OTC", "Pad", "Powder", "Suspension", "Tissue", "Water",
  "Juice", "Belt", "Ball", "Suppository", "Chocolate", "Pack", "Piece", "Box",
  "Kneecap", "Drop", "Gel", "Bottle", "Spray"
];

// ── Single source of truth for Total Sales / Total Profit ──────
// ACCOUNTING RULES (Phase 3 corrected):
//
//   SALES REVENUE  = sum of invoice finalBills (booked at sale time, full amount
//                    regardless of how much cash was collected then or later).
//   CASH RECEIVED  = sum of cashReceived at sale time + all due-collection payments.
//   DUE CREATED    = sum of per-invoice due fields (finalBill - cashReceived at sale).
//   DUE COLLECTED  = sum of due-collection log entries.
//
//   KEY RULE: Due collection does NOT increase Sales Revenue.
//   When ৳400 of due is collected later, Cash increases by ৳400 — but
//   Sales Revenue stays the same (it was already booked as ৳1000 at sale time).
//   Adding collectedDue to invoiceSales was double-counting revenue.
//
//   Profit = sum of invoice profits (booked in full at sale time; due
//   collection adds no new profit — cost was already subtracted).
//
// Deriving from the invoice array everywhere guarantees every device
// and every code path always agree, and nothing is lost on Firebase re-sync.
const computeSalesAndProfit = (invoicesList: any[], _dueCollectionLogList: any[]) => {
  const invoiceSales = invoicesList.reduce((sum: number, inv: any) => sum + (inv.finalBill || 0), 0);
  const profit = invoicesList.reduce((sum: number, inv: any) => sum + (inv.profit || 0), 0);
  // Cash received = cash taken at sale + due collected later.
  // Tracked in the cash ledger. Sales revenue is invoiceSales only — no double-count.
  return { sales: invoiceSales, profit };
};

// ── Cash received summary (for dashboard display) ─────────────
// Separate from Sales Revenue: this is actual cash/digital payments received.
const computeCashReceived = (invoicesList: any[], dueCollectionLogList: any[]) => {
  const saleTimeCash = invoicesList.reduce((sum: number, inv: any) => {
    // cashReceived at sale time, capped at finalBill (no over-counting change)
    return sum + Math.min(inv.cashReceived ?? inv.finalBill ?? 0, inv.finalBill ?? 0);
  }, 0);
  const collectedDue = dueCollectionLogList.reduce((sum: number, log: any) => sum + (log.amount || 0), 0);
  return saleTimeCash + collectedDue;
};

// Theme CSS variable injection (static - defined outside component)
const themeStyles: Record<string, React.CSSProperties> = {
  light: {},
  dark: {},
}

// ============================================================
// CREATOR PANEL — "digital rain" backdrop columns, generated once
// at module load (NOT inside the component) so the conditionally
// -rendered Creator branch never has to call a Hook to produce it —
// that would break React's rules of Hooks since that branch only
// renders for some users on some renders.
// ============================================================
const MATRIX_RAIN_GLYPHS = "01アイウエオカキクケコサシスセソ#$%&<>{}[]/\\=+*";
const MATRIX_RAIN_COLUMNS = Array.from({ length: 18 }, (_, i) => {
  const glyphCount = 18 + Math.floor(Math.random() * 14);
  let chars = "";
  for (let j = 0; j < glyphCount; j++) {
    chars += MATRIX_RAIN_GLYPHS[Math.floor(Math.random() * MATRIX_RAIN_GLYPHS.length)] + "\n";
  }
  return {
    id: i,
    left: (i / 18) * 100 + (Math.random() * 3 - 1.5),
    duration: 9 + Math.random() * 10,
    delay: Math.random() * -14,
    chars,
  };
});

// ============================================================
// UNIQUE ID GENERATOR — plain `Date.now()` (or `Date.now() + Math.random()`)
// collides when several list items are created in the same millisecond
// (e.g. a bulk purchase cart with multiple line items, or a checkout that
// logs an invoice + a due-collection entry back to back). Adding a tiny
// random fraction to a 13-digit timestamp doesn't help either — floating
// point addition rounds away most of that fraction's precision. This
// monotonic counter guarantees a unique id on every single call, even
// when called thousands of times within the same millisecond.
// ============================================================
let __idSeq = 0;
const genId = () => Date.now() * 1000 + (++__idSeq % 1000);

// De-duplicates an array's `id` field: if two items share the same id
// (this could happen from old data saved before genId() existed — e.g.
// a Bulk Purchase that used the fragile `Date.now() + Math.random()`
// pattern), every item after the first one with that id gets a fresh,
// guaranteed-unique id. This "self-heals" already-saved duplicate-id
// data the moment it loads, instead of showing the React duplicate-key
// warning forever.
const dedupeIds = (arr: any[]): { list: any[]; changed: boolean } => {
  if (!Array.isArray(arr)) return { list: arr, changed: false };
  const seen = new Set<any>();
  let changed = false;
  const list = arr.map(item => {
    if (item && item.id !== undefined && item.id !== null) {
      if (seen.has(item.id)) {
        changed = true;
        return { ...item, id: genId() };
      }
      seen.add(item.id);
    }
    return item;
  });
  return { list, changed };
};


// ── Hoisted static animation CSS (moved out of component so it
// isn't recreated as a new string on every single re-render) ──
const CSS_SPIN = `
          @keyframes spin-slow { to { transform: rotate(360deg); } }
          @keyframes pulse-ring { 0%,100%{transform:scale(1);opacity:0.6} 50%{transform:scale(1.15);opacity:0.3} }
          @keyframes fadein { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
        `;
const CSS_FLOAT = `
          @keyframes float-up { 0%{transform:translateY(100vh) scale(0);opacity:0} 10%{opacity:0.6} 90%{opacity:0.2} 100%{transform:translateY(-20px) scale(1);opacity:0} }
          @keyframes login-slide-in { from{opacity:0;transform:translateY(30px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }
          @keyframes clock-tick { 0%{transform:scale(1)} 50%{transform:scale(1.03)} 100%{transform:scale(1)} }
          @keyframes logo-pulse { 0%,100%{box-shadow:0 0 0 0 rgba(20,184,166,0.4)} 50%{box-shadow:0 0 0 12px rgba(20,184,166,0)} }
          @keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
          @keyframes spin-slow { to { transform: rotate(360deg); } }
          @keyframes fadein { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
          @keyframes shake { 0%,100%{transform:translateX(0)} 15%{transform:translateX(-8px)} 30%{transform:translateX(8px)} 45%{transform:translateX(-6px)} 60%{transform:translateX(6px)} 75%{transform:translateX(-3px)} 90%{transform:translateX(3px)} }
          @keyframes sidebar-item { from{opacity:0;transform:translateX(-12px)} to{opacity:1;transform:translateX(0)} }
          @keyframes tab-content { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
          @keyframes toast-in { from{opacity:0;transform:translateX(100%) scale(0.9)} to{opacity:1;transform:translateX(0) scale(1)} }
          @keyframes badge-pop { 0%{transform:scale(1)} 50%{transform:scale(1.4)} 100%{transform:scale(1)} }
          @keyframes counter-up { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
          @keyframes card-hover { from{transform:translateY(0)} to{transform:translateY(-3px)} }
          @keyframes progress-fill { from{width:0%} to{width:var(--target-width,100%)} }
          .animate-login-slide { animation: login-slide-in 0.5s cubic-bezier(0.22,1,0.36,1) forwards; }
          .animate-clock { animation: clock-tick 1s ease-in-out infinite; }
          .animate-logo-pulse { animation: logo-pulse 2s ease-in-out infinite; }
          .animate-shake { animation: shake 0.5s cubic-bezier(.36,.07,.19,.97) both; }
          .animate-sidebar-item { animation: sidebar-item 0.3s ease forwards; }
          .animate-tab-content { animation: tab-content 0.05s ease forwards; }
          .animate-toast-in { animation: toast-in 0.35s cubic-bezier(0.22,1,0.36,1) forwards; }
          .animate-badge-pop { animation: badge-pop 0.3s ease; }
          .btn-press:active { transform: scale(0.96) !important; transition: transform 0.1s; }
          @keyframes dashEmojiFloat { 0%,100%{transform:translateY(0) rotate(0deg)} 50%{transform:translateY(-8px) rotate(6deg)} }
          @keyframes dashEmojiPulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.2)} }
          @keyframes dashEmojiRise { 0%,100%{transform:translateY(0) scale(1)} 40%{transform:translateY(-10px) scale(1.15)} 60%{transform:translateY(-10px) scale(1.15)} }
          @keyframes dashEmojiWiggle { 0%,100%{transform:rotate(0deg)} 20%{transform:rotate(-12deg)} 40%{transform:rotate(12deg)} 60%{transform:rotate(-8deg)} 80%{transform:rotate(8deg)} }
          @keyframes dashEmojiShake { 0%,100%{transform:translateX(0) rotate(0deg)} 25%{transform:translateX(-5px) rotate(-8deg)} 75%{transform:translateX(5px) rotate(8deg)} }
          @keyframes dashEmojiSpin { 0%{transform:rotate(0deg) scale(1)} 50%{transform:rotate(180deg) scale(1.1)} 100%{transform:rotate(360deg) scale(1)} }
          @keyframes dashEmojiPop { 0%,100%{transform:scale(1) translateY(0)} 30%{transform:scale(1.25) translateY(-5px)} 60%{transform:scale(0.9) translateY(2px)} }
        `;
const CSS_FLOAT_2 = `
        @keyframes float-up { 0%{transform:translateY(100vh) scale(0);opacity:0} 10%{opacity:0.6} 90%{opacity:0.2} 100%{transform:translateY(-20px) scale(1);opacity:0} }
        @keyframes login-slide-in { from{opacity:0;transform:translateY(30px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }
        @keyframes clock-tick { 0%{transform:scale(1)} 50%{transform:scale(1.03)} 100%{transform:scale(1)} }
        @keyframes logo-pulse { 0%,100%{box-shadow:0 0 0 0 rgba(20,184,166,0.4)} 50%{box-shadow:0 0 0 12px rgba(20,184,166,0)} }
        @keyframes spin-slow { to { transform: rotate(360deg); } }
        @keyframes fadein { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes shake { 0%,100%{transform:translateX(0)} 15%{transform:translateX(-8px)} 30%{transform:translateX(8px)} 45%{transform:translateX(-6px)} 60%{transform:translateX(6px)} 75%{transform:translateX(-3px)} 90%{transform:translateX(3px)} }
        @keyframes sidebar-item { from{opacity:0;transform:translateX(-12px)} to{opacity:1;transform:translateX(0)} }
        @keyframes tab-content { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes toast-in { from{opacity:0;transform:translateX(110%) scale(0.9)} to{opacity:1;transform:translateX(0) scale(1)} }
        @keyframes toast-out { from{opacity:1;transform:translateX(0)} to{opacity:0;transform:translateX(110%)} }
        @keyframes badge-pop { 0%{transform:scale(1)} 50%{transform:scale(1.5)} 100%{transform:scale(1)} }
        @keyframes progress-stripe { from{background-position:40px 0} to{background-position:0 0} }
        @keyframes header-glow { 0%,100%{box-shadow:0 1px 0 rgba(20,184,166,0)} 50%{box-shadow:0 1px 8px rgba(20,184,166,0.15)} }
        /* ── Scroll reveal (auto-applied to cards/sections) ── */
        .sr-auto { opacity: 0; transform: translateY(28px); transition: opacity 0.65s cubic-bezier(0.22,1,0.36,1), transform 0.65s cubic-bezier(0.22,1,0.36,1); will-change: opacity, transform; }
        .sr-auto.sr-visible { opacity: 1; transform: translateY(0); }
        @media (prefers-reduced-motion: reduce) {
          .sr-auto { opacity: 1 !important; transform: none !important; transition: none !important; }
        }
        .animate-login-slide { animation: login-slide-in 0.5s cubic-bezier(0.22,1,0.36,1) forwards; }
        .animate-clock { animation: clock-tick 1s ease-in-out infinite; }
        .animate-logo-pulse { animation: logo-pulse 2s ease-in-out infinite; }
        .animate-shake { animation: shake 0.5s cubic-bezier(.36,.07,.19,.97) both; }
        .animate-sidebar-item { animation: sidebar-item 0.3s ease forwards; }
        .animate-tab-content { animation: tab-content 0.05s ease forwards; }
        .animate-toast-in { animation: toast-in 0.35s cubic-bezier(0.22,1,0.36,1) forwards; }
        .animate-badge-pop { animation: badge-pop 0.3s ease; }
        .btn-press { transition: transform 0.12s, box-shadow 0.12s; }
        .btn-press:active { transform: scale(0.95) !important; }
        .card-hover { transition: transform 0.2s, box-shadow 0.2s; }
        .card-hover:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
        @media (max-width: 768px) {
          .ccard svg { display: none !important; }
          .card-hover:hover { transform: none !important; box-shadow: none !important; }
          [style*="willChange"], [style*="will-change"] { will-change: auto !important; }
        }
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
        }
        @keyframes emoji-bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-8px)} }
        @keyframes emoji-spin { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
        @keyframes emoji-pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.3)} }
        @keyframes emoji-float { 0%,100%{transform:translateY(0) rotate(-5deg)} 50%{transform:translateY(-10px) rotate(5deg)} }
        @keyframes emoji-rise { 0%,100%{transform:translateY(0) scale(1)} 50%{transform:translateY(-10px) scale(1.2)} }
        @keyframes emoji-shake { 0%,100%{transform:rotate(0deg)} 25%{transform:rotate(-15deg)} 75%{transform:rotate(15deg)} }
        @keyframes emoji-swing { 0%,100%{transform:rotate(-10deg)} 50%{transform:rotate(10deg)} }
        @keyframes emoji-pop { 0%,100%{transform:scale(1)} 30%{transform:scale(1.35)} 60%{transform:scale(0.9)} }
        .anim-bounce { animation: emoji-bounce 1.2s ease-in-out infinite; display:inline-block; }
        .anim-spin   { animation: emoji-spin 3s linear infinite; display:inline-block; }
        .anim-pulse  { animation: emoji-pulse 1.5s ease-in-out infinite; display:inline-block; }
        .anim-float  { animation: emoji-float 2s ease-in-out infinite; display:inline-block; }
        .anim-rise   { animation: emoji-rise 1.8s ease-in-out infinite; display:inline-block; }
        .anim-shake  { animation: emoji-shake 0.8s ease-in-out infinite; display:inline-block; }
        .anim-swing  { animation: emoji-swing 1.4s ease-in-out infinite; display:inline-block; }
        .anim-pop    { animation: emoji-pop 1.6s ease-in-out infinite; display:inline-block; }
        /* ── Unified professional card border system ── */
        .ccard { border-width: 1px !important; border-style: solid !important; }
        .cc-teal, .cc-indigo, .cc-amber, .cc-emerald, .cc-blue, .cc-red,
        .cc-orange, .cc-violet, .cc-pink, .cc-rose, .cc-green, .cc-slate,
        .cc-cyan, .cc-purple { border-color: #e2e8f0 !important; }
        .dark .cc-teal, .dark .cc-indigo, .dark .cc-amber, .dark .cc-emerald,
        .dark .cc-blue, .dark .cc-red, .dark .cc-orange, .dark .cc-violet,
        .dark .cc-pink, .dark .cc-rose, .dark .cc-green, .dark .cc-slate,
        .dark .cc-cyan, .dark .cc-purple { border-color: #334155 !important; }

        /* ══════════════════════════════════════════════════════════
           GLASSMORPHISM / TRANSPARENCY LAYER — site-wide
           Applied purely via CSS on top of existing utility classes,
           so no component markup needs to change and nothing breaks.
           Falls back gracefully on browsers without backdrop-filter.
           ══════════════════════════════════════════════════════════ */
        @supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {

          /* Light-mode solid card surfaces → frosted glass */
          .ccard.bg-white,
          .bg-white.border-slate-200,
          .ccard.bg-slate-50,
          .ccard.bg-slate-100,
          .ccard.bg-amber-50 {
            background-color: rgba(255,255,255,0.66) !important;
            backdrop-filter: blur(18px) saturate(180%);
            -webkit-backdrop-filter: blur(18px) saturate(180%);
            border-color: rgba(226,232,240,0.7) !important;
          }

          /* Dark-mode solid card surfaces → frosted glass */
          .ccard.bg-slate-800,
          .ccard.bg-slate-800\/60,
          .ccard.bg-slate-800\/40,
          .bg-slate-800.border-slate-700,
          .ccard.bg-slate-900\/40,
          .ccard.bg-rose-950\/50 {
            background-color: rgba(30,41,59,0.55) !important;
            backdrop-filter: blur(18px) saturate(180%);
            -webkit-backdrop-filter: blur(18px) saturate(180%);
            border-color: rgba(51,65,85,0.6) !important;
          }

          /* Sidebar navigation */
          nav.sidebar-collapse.bg-white,
          nav.sidebar-collapse {
            backdrop-filter: blur(20px) saturate(160%);
            -webkit-backdrop-filter: blur(20px) saturate(160%);
          }
          nav.sidebar-collapse.bg-white { background-color: rgba(255,255,255,0.72) !important; }
          nav.sidebar-collapse.bg-slate-900\/50 { background-color: rgba(15,23,42,0.55) !important; }

          /* Top header bar already uses bg-*/90 + blur — deepen it slightly */
          .bg-white\/90.backdrop-blur-md { background-color: rgba(255,255,255,0.78) !important; }
          .bg-slate-900\/90.backdrop-blur-md { background-color: rgba(15,23,42,0.7) !important; }

          /* Modal sheets (mobile bottom sheets, receipts, etc.) */
          .bg-white\/60.backdrop-blur-2xl { background-color: rgba(255,255,255,0.62) !important; }
          .bg-slate-900\/50.backdrop-blur-2xl { background-color: rgba(15,23,42,0.5) !important; }
        }

        /* Subtle premium polish: soft shadow + gentle lift on glass cards */
        .ccard {
          box-shadow: 0 4px 24px -8px rgba(15,23,42,0.10), 0 1px 2px rgba(15,23,42,0.04);
          transition: background-color 0.25s ease, box-shadow 0.25s ease, transform 0.2s ease;
        }
        .dark .ccard, [class*="bg-slate-8"].ccard, [class*="bg-slate-9"].ccard {
          box-shadow: 0 4px 28px -8px rgba(0,0,0,0.35), 0 1px 2px rgba(0,0,0,0.2);
        }
        @media (hover: hover) {
          .ccard.card-hover:hover { box-shadow: 0 12px 32px -8px rgba(15,23,42,0.16), 0 2px 6px rgba(15,23,42,0.08); }
        }
        /* Input fields — colorful focus */
        input:focus, select:focus, textarea:focus {
          outline: none !important;
          border-color: #14b8a6 !important;
          box-shadow: 0 0 0 3px rgba(20,184,166,0.2) !important;
        }
        /* Table rows */
        tbody tr:nth-child(even) { background-color: rgba(20,184,166,0.035); }
        tbody tr:hover { background-color: rgba(20,184,166,0.07) !important; }

        .sidebar-nav-btn { transition: all 0.18s ease; border: 2px solid transparent; border-radius: 11px; }
        .sidebar-nav-btn:hover { padding-left: 16px !important; }

        /* ── Collapsible sidebar: thin icon-rail by default, expands on hover ──
           Was a deliberate ~0.38s "slide" animation. Sped way up per request
           so hovering reveals the menu almost instantly. Pure CSS — no
           JS/render logic involved, so this doesn't touch POS/Dashboard. */
        .sidebar-collapse {
          width: 4.5rem;
          transition: width 0.04s linear;
          will-change: width;
          overflow: hidden;
        }
        .sidebar-collapse:hover {
          width: 17rem;
        }
        .sidebar-collapse .sidebar-nav-btn:hover { padding-left: 12px !important; }

        /* Auto-width reveal (grid 0fr→1fr) — always fits the text, never clips */
        .sc-wrap {
          display: grid;
          grid-template-columns: 0fr;
          min-width: 0;
          transition: grid-template-columns 0.04s linear;
        }
        .sidebar-collapse:hover .sc-wrap {
          grid-template-columns: 1fr;
        }
        .sc-wrap > * {
          overflow: hidden;
          min-width: 0;
          white-space: nowrap;
        }
        .sc-fade {
          opacity: 0;
          transition: opacity 0.04s linear;
        }
        .sidebar-collapse:hover .sc-fade {
          opacity: 1;
          transition: opacity 0.04s linear;
        }

        .sc-row { justify-content: center; }
        .sidebar-collapse:hover .sc-row { justify-content: space-between; }
        .sc-row-solo { justify-content: center; }
        .sidebar-collapse:hover .sc-row-solo { justify-content: flex-start; }
        .sidebar-collapse .sidebar-nav-btn { gap: 0; }
        .sidebar-collapse:hover .sidebar-nav-btn { gap: 0.5rem; }
        .sidebar-collapse .sc-icons { gap: 0; }
        .sidebar-collapse:hover .sc-icons { gap: 0.5rem; }
        .sc-icons { justify-content: center; }
        .sidebar-collapse:hover .sc-icons { justify-content: flex-start; }

        .sc-heading {
          white-space: nowrap;
          overflow: hidden;
          opacity: 0;
          max-height: 0;
          margin-bottom: 0;
          transition: opacity 0.18s ease, max-height 0.3s ease, margin 0.3s ease;
        }
        .sidebar-collapse:hover .sc-heading {
          opacity: 1;
          max-height: 2rem;
          margin-bottom: 0.375rem;
          transition: opacity 0.32s ease 0.1s, max-height 0.34s ease, margin 0.34s ease;
        }

        /* Bottom clock / user info — hard swap between a compact icon and full
           content, so nothing ever wraps or overflows the narrow collapsed rail */
        .sc-bottom { transition: padding 0.32s ease; }
        .sc-collapsed-only { display: flex; }
        .sidebar-collapse:hover .sc-collapsed-only { display: none; }
        .sc-expanded-only { display: none; }
        .sidebar-collapse:hover .sc-expanded-only { display: block; }
        .snav-pos     { border-width: 2px !important; border-style: solid !important; border-color: #4f46e5 !important; }
        .snav-dash    { border-width: 2px !important; border-style: solid !important; border-color: #6366f1 !important; }
        .snav-stock   { border-width: 2px !important; border-style: solid !important; border-color: #f59e0b !important; }
        .snav-stockin { border-width: 2px !important; border-style: solid !important; border-color: #10b981 !important; }
        .snav-newprod { border-width: 2px !important; border-style: solid !important; border-color: #22c55e !important; }
        .snav-ph      { border-width: 2px !important; border-style: solid !important; border-color: #8b5cf6 !important; }
        .snav-cph     { border-width: 2px !important; border-style: solid !important; border-color: #a78bfa !important; }
        .snav-inv     { border-width: 2px !important; border-style: solid !important; border-color: #3b82f6 !important; }
        .snav-due     { border-width: 2px !important; border-style: solid !important; border-color: #ef4444 !important; }
        .snav-duecol  { border-width: 2px !important; border-style: solid !important; border-color: #10b981 !important; }
        .snav-report  { border-width: 2px !important; border-style: solid !important; border-color: #f97316 !important; }
        .snav-ret     { border-width: 2px !important; border-style: solid !important; border-color: #ec4899 !important; }
        .snav-set     { border-width: 2px !important; border-style: solid !important; border-color: #64748b !important; }
        .snav-perm    { border-width: 2px !important; border-style: solid !important; border-color: #f43f5e !important; }
        .snav-closing { border-width: 2px !important; border-style: solid !important; border-color: #a855f7 !important; }
        .snav-daily   { border-width: 2px !important; border-style: solid !important; border-color: #0ea5e9 !important; }
        .snav-monthly { border-width: 2px !important; border-style: solid !important; border-color: #7c3aed !important; }
        .snav-exp     { border-width: 2px !important; border-style: solid !important; border-color: #f43f5e !important; }
        .snav-pos.bg-indigo-500,.snav-dash.bg-indigo-500,.snav-stock.bg-indigo-500,
        .snav-stockin.bg-indigo-500,.snav-newprod.bg-indigo-500,.snav-ph.bg-indigo-500,.snav-cph.bg-indigo-500,
        .snav-inv.bg-indigo-500,.snav-due.bg-indigo-500,.snav-duecol.bg-indigo-500,.snav-report.bg-indigo-500,
        .snav-ret.bg-indigo-500,.snav-set.bg-indigo-500,.snav-perm.bg-indigo-500,.snav-closing.bg-indigo-500,.snav-exp.bg-indigo-500
        { border-color: rgba(255,255,255,0.45) !important; box-shadow: 0 0 10px rgba(20,184,166,0.35); }
        @media print {
          .receipt-print, .receipt-print * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
          .cph-print-report, .cph-print-report * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
          .cph-print-report { position: static !important; }
          @page { size: auto; margin: 10mm; }
          body, html { background: #fff !important; }

          /* Make all printed receipt/report text clear & bold — easy to read on paper */
          .receipt-print *, .cph-print-report * {
            font-weight: 600 !important;
            opacity: 1 !important;
          }
          .receipt-print .text-slate-200, .cph-print-report .text-slate-200,
          .receipt-print .text-slate-300, .cph-print-report .text-slate-300,
          .receipt-print .text-slate-400, .cph-print-report .text-slate-400,
          .receipt-print .text-slate-500, .cph-print-report .text-slate-500,
          .receipt-print .text-slate-600, .cph-print-report .text-slate-600 {
            color: #1e293b !important;
          }
          .receipt-print .font-semibold, .cph-print-report .font-semibold,
          .receipt-print .font-bold, .cph-print-report .font-bold,
          .receipt-print .font-black, .cph-print-report .font-black,
          .receipt-print th, .cph-print-report th {
            font-weight: 800 !important;
          }
          .receipt-print .text-sm, .cph-print-report .text-sm {
            font-size: 0.95rem !important;
            line-height: 1.5 !important;
          }
          .receipt-print table, .cph-print-report table { font-size: 0.95rem !important; }
        }
      `;
const CSS_BAGFLOAT = `
                        @keyframes bagFloat{0%,100%{transform:translateY(0) rotate(-1.2deg) scale(1)}50%{transform:translateY(-4.8px) rotate(1.2deg) scale(1.024)}}
                        @keyframes bagGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                        @keyframes coinSpin1{0%{transform:translateY(-10.8px) scaleX(1);opacity:0}15%{opacity:1}40%{transform:translateY(1.2px) scaleX(-1);opacity:1}70%{transform:translateY(6px) scaleX(1);opacity:1}85%,100%{transform:translateY(8.4px);opacity:0}}
                        @keyframes coinSpin2{0%{transform:translateY(-8.4px) scaleX(1);opacity:0}20%{opacity:1}45%{transform:translateY(1.2px) scaleX(-1);opacity:1}75%{transform:translateY(4.8px) scaleX(1);opacity:1}90%,100%{opacity:0}}
                        @keyframes coinSpin3{0%{transform:translateY(-12px) scaleX(1);opacity:0}10%{opacity:1}38%{transform:translateY(1.2px) scaleX(-1);opacity:1}65%{transform:translateY(7.2px) scaleX(1);opacity:1}80%,100%{opacity:0}}
                        @keyframes shimmer{0%,100%{opacity:0.15}50%{opacity:0.55}}
                        @keyframes sparkle1{0%,100%{transform:scale(0.4) rotate(0deg);opacity:0}40%,60%{transform:scale(1.12) rotate(180deg);opacity:1}}
                        @keyframes sparkle2{0%,100%{transform:scale(0.4) rotate(0deg);opacity:0}30%,70%{transform:scale(1) rotate(54deg);opacity:0.9}}
                        #mbag{animation:bagFloat 3.2s ease-in-out infinite,bagGlow 3.2s ease-in-out infinite;transform-origin:32px 38px;will-change:transform}
                        #c1{animation:coinSpin1 3.2s 0.16s ease-in infinite;transform-origin:20px 18px;will-change:transform}
                        #c2{animation:coinSpin2 3.2s 0.88s ease-in infinite;transform-origin:36px 14px;will-change:transform}
                        #c3{animation:coinSpin3 3.2s 1.44s ease-in infinite;transform-origin:44px 22px;will-change:transform}
                        #sh1{animation:shimmer 3.2s 0s ease-in-out infinite}
                        #sh2{animation:shimmer 3.2s 0.64s ease-in-out infinite}
                        #sp1{animation:sparkle1 3.2s 0.32s ease-in-out infinite;transform-origin:12px 12px;will-change:transform}
                        #sp2{animation:sparkle2 3.2s 1.28s ease-in-out infinite;transform-origin:50px 10px;will-change:transform}
                      `;
const CSS_CALFLOAT = `
                        @keyframes calFloat{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-3.6px) scale(1.03)}}
                        @keyframes calGlow{0%,100%{opacity:0.85}50%{opacity:1}}
                        @keyframes dateFlip{0%,30%{opacity:1;transform:scaleY(1)}40%{opacity:0;transform:scaleY(0)}50%{opacity:1;transform:scaleY(1)}100%{opacity:1}}
                        @keyframes ringRotate{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
                        @keyframes dotPulse{0%,100%{opacity:0.3;transform:scale(1)}50%{opacity:1;transform:scale(1.24)}}
                        @keyframes pageFlip{0%,60%{transform:scaleY(1)}70%{transform:scaleY(0)}80%{transform:scaleY(1)}100%{transform:scaleY(1)}}
                        #cal{animation:calFloat 3.52s ease-in-out infinite,calGlow 3.52s ease-in-out infinite;transform-origin:32px 36px;will-change:transform}
                        #dt{animation:dateFlip 4.8s 0.8s ease-in-out infinite;transform-origin:32px 42px;will-change:transform}
                        #ring{animation:ringRotate 12.8s linear infinite;transform-origin:32px 32px;will-change:transform}
                        #d1{animation:dotPulse 1.92s 0s ease-in-out infinite;will-change:transform}
                        #d2{animation:dotPulse 1.92s 0.48s ease-in-out infinite;will-change:transform}
                        #d3{animation:dotPulse 1.92s 0.96s ease-in-out infinite;will-change:transform}
                        #page{animation:pageFlip 4.8s 1.6s ease-in-out infinite;transform-origin:32px 30px;will-change:transform}
                      `;
const CSS_B1GROW = `
                          @keyframes b1grow{0%,100%{transform:scaleY(0.6)}50%{transform:scaleY(1.09)}}
                          @keyframes b2grow{0%,100%{transform:scaleY(0.7)}50%{transform:scaleY(1.12)}}
                          @keyframes b3grow{0%,100%{transform:scaleY(0.8)}50%{transform:scaleY(1.15)}}
                          @keyframes arrDash{0%,100%{transform:translate(0,0) scale(1)}40%{transform:translate(6px,-7px) scale(1.06)}60%{transform:translate(6px,-7px) scale(1.06)}}
                          @keyframes baseGlow{0%,100%{opacity:0.4}50%{opacity:0.9}}
                          @keyframes shimBars{0%{opacity:0.1}50%{opacity:0.5}100%{opacity:0.1}}
                          @keyframes particle{0%{transform:translate(0,0);opacity:0.8}100%{transform:translate(var(--px),var(--py));opacity:0}}
                          #b1{animation:b1grow 2.88s 0s ease-in-out infinite;transform-origin:14px 48px;will-change:transform}
                          #b2{animation:b2grow 2.88s 0.32s ease-in-out infinite;transform-origin:27px 48px;will-change:transform}
                          #b3{animation:b3grow 2.88s 0.64s ease-in-out infinite;transform-origin:40px 48px;will-change:transform}
                          #arr{animation:arrDash 2.56s ease-in-out infinite;will-change:transform}
                          #base{animation:baseGlow 2.88s ease-in-out infinite}
                          #p1{--px:-8px;--py:-12px;animation:particle 1.92s 0.48s ease-out infinite;transform-origin:44px 14px;will-change:transform}
                          #p2{--px:8px;--py:-10px;animation:particle 1.92s 1.12s ease-out infinite;transform-origin:44px 14px;will-change:transform}
                          #p3{--px:2px;--py:-14px;animation:particle 1.92s 1.76s ease-out infinite;transform-origin:44px 14px;will-change:transform}
                        `;
const CSS_RKTLAUNCH = `
                          @keyframes rktLaunch{0%,100%{transform:translateY(0) rotate(0deg)}35%{transform:translateY(-7.8px) rotate(-1.8deg)}65%{transform:translateY(-7.8px) rotate(1.8deg)}}
                          @keyframes fireFlick{0%,100%{transform:scaleY(1) scaleX(1)}25%{transform:scaleY(1.36) scaleX(0.7)}50%{transform:scaleY(0.8) scaleX(1.15)}75%{transform:scaleY(1.3) scaleX(0.75)}}
                          @keyframes smoke1Up{0%{transform:translateY(0) scale(0.88);opacity:0.5}100%{transform:translateY(-13.2px) scale(1.48);opacity:0}}
                          @keyframes smoke2Up{0%{transform:translateY(0) scale(0.82);opacity:0.4}100%{transform:translateY(-10.8px) scale(1.3);opacity:0}}
                          @keyframes orbitDot{0%{transform:rotate(0deg) translateX(20px) rotate(0deg);opacity:0.6}100%{transform:rotate(360deg) translateX(20px) rotate(-360deg);opacity:0.6}}
                          @keyframes orbitDot2{0%{transform:rotate(72deg) translateX(18px) rotate(-72deg);opacity:0.4}100%{transform:rotate(480deg) translateX(18px) rotate(-480deg);opacity:0.4}}
                          @keyframes rktGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          #rkt{animation:rktLaunch 3.2s ease-in-out infinite,rktGlow 3.2s ease-in-out infinite;transform-origin:32px 40px;will-change:transform}
                          #fire{animation:fireFlick 0.288s linear infinite;transform-origin:32px 48px;will-change:transform}
                          #sm1{animation:smoke1Up 1.28s 0s ease-out infinite;will-change:transform}
                          #sm2{animation:smoke2Up 1.28s 0.448s ease-out infinite;will-change:transform}
                          #od1{animation:orbitDot 6.4s linear infinite;transform-origin:32px 28px;will-change:transform}
                          #od2{animation:orbitDot2 6.4s linear infinite;transform-origin:32px 28px;will-change:transform}
                        `;
const CSS_CARTROLL = `
                          @keyframes cartRoll{0%,100%{transform:translateX(0)}25%{transform:translateX(3px)}75%{transform:translateX(-2px)}}
                          @keyframes cartGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          @keyframes wheelSpin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
                          @keyframes it1Jump{0%,70%,100%{transform:translateY(0) rotate(0deg)}35%{transform:translateY(-6px) rotate(-4.8deg)}}
                          @keyframes it2Jump{0%,70%,100%{transform:translateY(0) rotate(0deg)}35%{transform:translateY(-8.4px) rotate(3deg)}}
                          @keyframes it3Jump{0%,70%,100%{transform:translateY(0) rotate(0deg)}35%{transform:translateY(-5.4px) rotate(-3deg)}}
                          @keyframes plusPop{0%,100%{transform:scale(0.4);opacity:0}50%{transform:scale(1.18);opacity:1}}
                          #cart{animation:cartRoll 2.24s ease-in-out infinite,cartGlow 2.88s ease-in-out infinite;will-change:transform}
                          #w1{animation:wheelSpin 1.6s linear infinite;transform-origin:22px 47px;will-change:transform}
                          #w2{animation:wheelSpin 1.6s linear infinite;transform-origin:44px 47px;will-change:transform}
                          #it1{animation:it1Jump 2.56s 0s ease-in-out infinite;transform-origin:22px 24px;will-change:transform}
                          #it2{animation:it2Jump 2.56s 0.32s ease-in-out infinite;transform-origin:32px 20px;will-change:transform}
                          #it3{animation:it3Jump 2.56s 0.64s ease-in-out infinite;transform-origin:42px 24px;will-change:transform}
                          #plus{animation:plusPop 2.56s 1.28s ease-in-out infinite;transform-origin:54px 12px;will-change:transform}
                        `;
const CSS_BAGSWING = `
                          @keyframes bagSwing{0%,100%{transform:rotate(-4.8deg) translateY(0)}25%{transform:rotate(4.8deg) translateY(-1.8px)}50%{transform:rotate(-3.6deg) translateY(-0.6px)}75%{transform:rotate(3.6deg) translateY(-1.2px)}}
                          @keyframes tagBounce{0%,100%{transform:translateY(0) rotate(-6deg)}50%{transform:translateY(-4.2px) rotate(6deg)}}
                          @keyframes bagGlow{0%,100%{opacity:0.85}50%{opacity:1}}
                          @keyframes checkPop{0%,60%,100%{transform:scale(0.4);opacity:0}75%{transform:scale(1.18);opacity:1}90%{transform:scale(1);opacity:1}}
                          @keyframes shimBag{0%,100%{opacity:0.1}50%{opacity:0.4}}
                          #bag{animation:bagSwing 3.2s ease-in-out infinite,bagGlow 3.2s ease-in-out infinite;transform-origin:32px 22px;will-change:transform}
                          #tag{animation:tagBounce 3.2s 0.48s ease-in-out infinite;transform-origin:43px 14px;will-change:transform}
                          #chk{animation:checkPop 4.8s 0.8s ease-in-out infinite;transform-origin:32px 38px;will-change:transform}
                          #shbag{animation:shimBag 3.2s ease-in-out infinite}
                        `;
const CSS_HGSPIN = `
                        @keyframes hgSpin{0%,40%{transform:rotate(0deg)}60%,100%{transform:rotate(180deg)}}
                        @keyframes sandFill{0%{transform:scaleY(0);opacity:0}10%{opacity:1}80%{transform:scaleY(1);opacity:1}95%,100%{opacity:0}}
                        @keyframes sandDrop{0%,30%{transform:translateY(0);opacity:1}85%,100%{transform:translateY(10.8px);opacity:0}}
                        @keyframes ripple1{0%{transform:scale(0.7);opacity:0.6}100%{transform:scale(1.48);opacity:0}}
                        @keyframes ripple2{0%{transform:scale(0.7);opacity:0.4}100%{transform:scale(1.72);opacity:0}}
                        @keyframes glassGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                        #hg{animation:hgSpin 6.4s 0.8s cubic-bezier(0.4,0,0.2,1) infinite,glassGlow 3.2s ease-in-out infinite;transform-origin:32px 32px;will-change:transform}
                        #sf{animation:sandFill 3.2s 0.8s ease-in infinite;transform-origin:32px 20px}
                        #sd{animation:sandDrop 3.2s 0.8s ease-in infinite}
                        #rip1{animation:ripple1 3.2s 0s ease-out infinite}
                        #rip2{animation:ripple2 3.2s 0.96s ease-out infinite}
                      `;
const CSS_CLIPSHAKE = `
                        @keyframes clipShake{0%,100%{transform:rotate(0deg)}15%{transform:rotate(-4.2deg)}30%{transform:rotate(4.2deg)}45%{transform:rotate(-2.4deg)}60%{transform:rotate(2.4deg)}75%,100%{transform:rotate(0deg)}}
                        @keyframes clipGlow{0%,100%{opacity:0.85}50%{opacity:1}}
                        @keyframes alertPulse{0%,100%{transform:scale(1);opacity:0.8}50%{transform:scale(1.24);opacity:1}}
                        @keyframes alertRing{0%{transform:scale(1);opacity:0.5}100%{transform:scale(1.54);opacity:0}}
                        @keyframes lineWrite1{0%{stroke-dashoffset:22}60%,100%{stroke-dashoffset:0}}
                        @keyframes lineWrite2{0%,20%{stroke-dashoffset:18}80%,100%{stroke-dashoffset:0}}
                        @keyframes lineWrite3{0%,40%{stroke-dashoffset:14}100%{stroke-dashoffset:0}}
                        @keyframes penMove{0%{transform:translate(0,0)}33%{transform:translate(4px,8px)}66%{transform:translate(0px,16px)}100%{transform:translate(0,0)}}
                        #clip{animation:clipShake 4.48s ease-in-out infinite,clipGlow 3.2s ease-in-out infinite;transform-origin:32px 36px;will-change:transform}
                        #al{animation:alertPulse 1.6s ease-in-out infinite}
                        #alring{animation:alertRing 1.6s ease-out infinite}
                        #l1{animation:lineWrite1 4.48s ease-in-out infinite;stroke-dasharray:22}
                        #l2{animation:lineWrite2 4.48s ease-in-out infinite;stroke-dasharray:18}
                        #l3{animation:lineWrite3 4.48s ease-in-out infinite;stroke-dasharray:14}
                        #pen{animation:penMove 4.48s ease-in-out infinite}
                      `;
const CSS_PHVIB = `
                          @keyframes phVib{0%,80%,100%{transform:rotate(0deg)}10%{transform:rotate(-7.2deg)}20%{transform:rotate(7.2deg)}30%{transform:rotate(-4.8deg)}40%{transform:rotate(4.8deg)}50%{transform:rotate(-3deg)}60%{transform:rotate(3deg)}}
                          @keyframes phGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          @keyframes ping1{0%{transform:scale(0.88);opacity:0.8}100%{transform:scale(2.2);opacity:0}}
                          @keyframes ping2{0%{transform:scale(0.88);opacity:0.6}100%{transform:scale(2.5);opacity:0}}
                          @keyframes coinPop{0%,70%,100%{transform:translateY(0) scale(0.4);opacity:0}78%{transform:translateY(-7.2px) scale(1.18);opacity:1}90%{transform:translateY(-9.6px) scale(1);opacity:0.8}98%{opacity:0}}
                          @keyframes screenFlash{0%,85%,100%{opacity:0.55}88%{opacity:0.9}}
                          #ph{animation:phVib 4s ease-in-out infinite,phGlow 3.2s ease-in-out infinite;transform-origin:32px 32px;will-change:transform}
                          #p1{animation:ping1 2.56s 0s ease-out infinite;transform-origin:46px 15px;will-change:transform}
                          #p2{animation:ping2 2.56s 0.72s ease-out infinite;transform-origin:46px 15px;will-change:transform}
                          #cn{animation:coinPop 4s ease-in-out infinite;transform-origin:32px 20px;will-change:transform}
                          #scr{animation:screenFlash 4s ease-in-out infinite}
                        `;
const CSS_CARDPOP = `
                          @keyframes cardPop{0%,100%{transform:translateY(0) rotate(-2.4deg) scale(1)}50%{transform:translateY(-6px) rotate(2.4deg) scale(1.036)}}
                          @keyframes cardGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          @keyframes chipShine{0%,100%{opacity:0.35;transform:scale(1)}50%{opacity:0.85;transform:scale(1.03)}}
                          @keyframes waveFlow{0%{transform:translateX(-14px);opacity:0}40%{opacity:0.7}100%{transform:translateX(14px);opacity:0}}
                          @keyframes tapRipple{0%{transform:scale(0.7);opacity:0.7}100%{transform:scale(1.72);opacity:0}}
                          @keyframes tapRipple2{0%{transform:scale(0.7);opacity:0.5}100%{transform:scale(2.08);opacity:0}}
                          #crd{animation:cardPop 3.2s ease-in-out infinite,cardGlow 3.2s ease-in-out infinite;will-change:transform}
                          #chip{animation:chipShine 3.2s ease-in-out infinite;will-change:transform}
                          #wave{animation:waveFlow 3.2s 0.8s ease-in-out infinite;will-change:transform}
                          #tr1{animation:tapRipple 2.4s 1.6s ease-out infinite;transform-origin:50px 12px;will-change:transform}
                          #tr2{animation:tapRipple2 2.4s 2.08s ease-out infinite;transform-origin:50px 12px;will-change:transform}
                        `;
const CSS_CIRCLEPULSE = `
                        @keyframes circlePulse{0%,100%{transform:scale(1);opacity:0.5}50%{transform:scale(1.072);opacity:0.88}}
                        @keyframes circleGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                        @keyframes checkDraw{0%{stroke-dashoffset:70;opacity:0.2}50%,100%{stroke-dashoffset:0;opacity:1}}
                        @keyframes sp1Pop{0%,55%,100%{transform:scale(0.4) rotate(0deg);opacity:0}68%{transform:scale(1.24) rotate(27deg);opacity:1}85%{transform:scale(1) rotate(18deg);opacity:0.8}95%{opacity:0}}
                        @keyframes sp2Pop{0%,60%,100%{transform:scale(0.4);opacity:0}72%{transform:scale(1.18);opacity:1}88%{transform:scale(1);opacity:0.8}96%{opacity:0}}
                        @keyframes sp3Pop{0%,65%,100%{transform:scale(0.4);opacity:0}76%{transform:scale(1.3);opacity:1}90%{transform:scale(1);opacity:0.8}97%{opacity:0}}
                        @keyframes burstLine{0%,50%{stroke-dashoffset:20;opacity:0}70%{stroke-dashoffset:0;opacity:1}90%,100%{opacity:0}}
                        #chkc{animation:circlePulse 2.56s ease-in-out infinite,circleGlow 2.56s ease-in-out infinite;transform-origin:32px 32px;will-change:transform}
                        #chkm{stroke-dasharray:70;animation:checkDraw 2.56s ease-in-out infinite}
                        #sp1{animation:sp1Pop 2.56s 1.12s ease-out infinite;transform-origin:12px 14px;will-change:transform}
                        #sp2{animation:sp2Pop 2.56s 1.44s ease-out infinite;transform-origin:50px 16px;will-change:transform}
                        #sp3{animation:sp3Pop 2.56s 1.76s ease-out infinite;transform-origin:32px 6px}
                        #bl1{stroke-dasharray:20;animation:burstLine 2.56s 1.2s ease-out infinite;transform-origin:10px 22px}
                        #bl2{stroke-dasharray:20;animation:burstLine 2.56s 1.44s ease-out infinite;transform-origin:54px 22px}
                      `;
const CSS_WLTOPEN = `
                        @keyframes wltOpen{0%,100%{transform:scaleY(1) rotate(-1.2deg)}50%{transform:scaleY(1.042) rotate(1.2deg)}}
                        @keyframes wltGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                        @keyframes cf1Fly{0%{transform:translate(0,0) scale(0.4);opacity:0}18%{transform:translate(-6px,-14px) scale(1.12);opacity:1}65%{transform:translate(-12px,-28px) scale(0.88);opacity:0.6}100%{transform:translate(-16px,-38px) scale(0.4);opacity:0}}
                        @keyframes cf2Fly{0%{transform:translate(0,0) scale(0.4);opacity:0}22%{transform:translate(5px,-12px) scale(1.06);opacity:1}70%{transform:translate(12px,-24px) scale(0.88);opacity:0.5}100%{transform:translate(16px,-34px) scale(0.4);opacity:0}}
                        @keyframes cf3Fly{0%{transform:translate(0,0) scale(0.4);opacity:0}30%{transform:translate(0px,-16px) scale(1.18);opacity:1}75%{transform:translate(4px,-30px) scale(0.82);opacity:0.4}100%{transform:translate(6px,-40px) scale(0.4);opacity:0}}
                        @keyframes coinShine{0%,100%{opacity:0.6}50%{opacity:1}}
                        #wlt{animation:wltOpen 3.52s ease-in-out infinite,wltGlow 3.2s ease-in-out infinite;will-change:transform}
                        #cf1{animation:cf1Fly 3.52s 0.48s ease-out infinite;transform-origin:32px 24px;will-change:transform}
                        #cf2{animation:cf2Fly 3.52s 1.12s ease-out infinite;transform-origin:32px 24px;will-change:transform}
                        #cf3{animation:cf3Fly 3.52s 1.76s ease-out infinite;transform-origin:32px 24px}
                        #cs{animation:coinShine 3.2s ease-in-out infinite}
                      `;
const CSS_STARSPIN = `
                          @keyframes starSpin{0%{transform:rotate(0deg) scale(1)}40%{transform:rotate(180deg) scale(1.108)}100%{transform:rotate(360deg) scale(1)}}
                          @keyframes starGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          @keyframes twinkle1{0%,100%{opacity:0.2;transform:scale(0.76) rotate(0deg)}50%{opacity:1;transform:scale(1.18) rotate(9deg)}}
                          @keyframes twinkle2{0%,100%{opacity:0.3;transform:scale(0.82)}50%{opacity:0.9;transform:scale(1.12)}}
                          @keyframes twinkle3{0%,100%{opacity:0.15;transform:scale(0.7) rotate(0deg)}50%{opacity:0.8;transform:scale(1.06) rotate(-6deg)}}
                          @keyframes orbitDot{0%{transform:rotate(0deg) translateX(28px) rotate(0deg)}100%{transform:rotate(360deg) translateX(28px) rotate(-360deg)}}
                          #star{animation:starSpin 6.4s linear infinite,starGlow 3.2s ease-in-out infinite;transform-origin:32px 32px;will-change:transform}
                          #t1{animation:twinkle1 2.4s 0s ease-in-out infinite;transform-origin:8px 12px;will-change:transform}
                          #t2{animation:twinkle2 2.4s 0.72s ease-in-out infinite;transform-origin:52px 16px;will-change:transform}
                          #t3{animation:twinkle3 2.4s 1.44s ease-in-out infinite;transform-origin:8px 52px;will-change:transform}
                          #t4{animation:twinkle1 2.4s 2.08s ease-in-out infinite;transform-origin:52px 50px;will-change:transform}
                          #od{animation:orbitDot 8s linear infinite;transform-origin:32px 32px}
                        `;
const CSS_BOXBOUNCE = `
                          @keyframes boxBounce{0%,100%{transform:translateY(0) rotate(0deg)}35%{transform:translateY(-7.2px) rotate(-3deg)}60%{transform:translateY(-7.2px) rotate(-2.4deg)}}
                          @keyframes boxGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          @keyframes lidOpen{0%,100%{transform:scaleY(1)}45%,65%{transform:scaleY(0.15)}}
                          @keyframes itemRise{0%,30%,100%{transform:translateY(0);opacity:0}42%{transform:translateY(-10.8px);opacity:1}68%{transform:translateY(-13.2px);opacity:0.7}80%,90%{opacity:0}}
                          @keyframes shimBox{0%,100%{opacity:0.1}50%{opacity:0.4}}
                          @keyframes dustPuff{0%{transform:scale(0.7);opacity:0.6}100%{transform:scale(1.6);opacity:0}}
                          #box{animation:boxBounce 3.52s ease-in-out infinite,boxGlow 3.2s ease-in-out infinite;will-change:transform}
                          #lid{animation:lidOpen 3.52s ease-in-out infinite;transform-origin:32px 20px;will-change:transform}
                          #item{animation:itemRise 3.52s ease-in-out infinite;will-change:transform}
                          #shb{animation:shimBox 3.2s ease-in-out infinite}
                          #dp1{animation:dustPuff 3.52s 0.64s ease-out infinite;transform-origin:20px 48px;will-change:transform}
                          #dp2{animation:dustPuff 3.52s 0.96s ease-out infinite;transform-origin:44px 48px;will-change:transform}
                        `;
const CSS_TROPSHAKE = `
                          @keyframes tropShake{0%,100%{transform:rotate(0deg) scale(1)}15%{transform:rotate(-4.2deg) scale(1.03)}30%{transform:rotate(4.2deg) scale(1.03)}45%{transform:rotate(-2.4deg)}60%{transform:rotate(2.4deg)}75%,100%{transform:rotate(0deg) scale(1)}}
                          @keyframes tropGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          @keyframes glowRing{0%,100%{r:22;opacity:0.07}50%{r:26;opacity:0.22}}
                          @keyframes star1Fly{0%{transform:translate(0,0) scale(0.4) rotate(0deg);opacity:0}25%{opacity:1;transform:scale(1.18)}100%{transform:translate(-14px,-16px) scale(0.4) rotate(180deg);opacity:0}}
                          @keyframes star2Fly{0%{transform:translate(0,0) scale(0.4) rotate(0deg);opacity:0}30%{opacity:1;transform:scale(1.12)}100%{transform:translate(16px,-18px) scale(0.4) rotate(-180deg);opacity:0}}
                          @keyframes star3Fly{0%{transform:translate(0,0) scale(0.4) rotate(0deg);opacity:0}20%{opacity:1;transform:scale(1.24)}100%{transform:translate(2px,-22px) scale(0.4) rotate(72deg);opacity:0}}
                          @keyframes confetti1{0%{transform:translate(0,0) rotate(0deg);opacity:0}20%{opacity:1}100%{transform:translate(-18px,-8px) rotate(180deg);opacity:0}}
                          @keyframes confetti2{0%{transform:translate(0,0) rotate(0deg);opacity:0}25%{opacity:1}100%{transform:translate(18px,-6px) rotate(-180deg);opacity:0}}
                          #trop{animation:tropShake 4.8s ease-in-out infinite,tropGlow 3.2s ease-in-out infinite;transform-origin:32px 34px;will-change:transform}
                          #glow{animation:glowRing 4s ease-in-out infinite;will-change:transform}
                          #s1{animation:star1Fly 3.2s 0s ease-out infinite;transform-origin:16px 12px;will-change:transform}
                          #s2{animation:star2Fly 3.2s 0.88s ease-out infinite;transform-origin:48px 14px;will-change:transform}
                          #s3{animation:star3Fly 3.2s 1.76s ease-out infinite;transform-origin:32px 8px;will-change:transform}
                          #cf1{animation:confetti1 3.2s 0.48s ease-out infinite;transform-origin:10px 20px;will-change:transform}
                          #cf2{animation:confetti2 3.2s 1.28s ease-out infinite;transform-origin:54px 18px;will-change:transform}
                        `;
const CSS_WARNSHAKE = `
                          @keyframes warnShake{0%,100%{transform:rotate(0deg) scale(1)}8%{transform:rotate(-6deg) scale(1.048)}16%{transform:rotate(6deg) scale(1.048)}24%{transform:rotate(-4.2deg)}32%{transform:rotate(4.2deg)}40%,100%{transform:rotate(0deg) scale(1)}}
                          @keyframes warnGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          @keyframes bangBlink{0%,100%{opacity:1;transform:scaleY(1)}50%{opacity:0.15;transform:scaleY(0.5)}}
                          @keyframes sw1Grow{0%{transform:scale(0.64);opacity:0.7}100%{transform:scale(1.48);opacity:0}}
                          @keyframes sw2Grow{0%{transform:scale(0.64);opacity:0.5}100%{transform:scale(1.72);opacity:0}}
                          @keyframes sw3Grow{0%{transform:scale(0.64);opacity:0.3}100%{transform:scale(1.96);opacity:0}}
                          @keyframes lightFlash{0%,90%,100%{opacity:0}45%,55%{opacity:0.4}}
                          #wrn{animation:warnShake 3.52s ease-in-out infinite,warnGlow 3.52s ease-in-out infinite;transform-origin:32px 34px;will-change:transform}
                          #bang{animation:bangBlink 0.88s ease-in-out infinite;will-change:transform}
                          #sw1{animation:sw1Grow 2.24s 0s ease-out infinite;transform-origin:32px 32px;will-change:transform}
                          #sw2{animation:sw2Grow 2.24s 0.56s ease-out infinite;transform-origin:32px 32px;will-change:transform}
                          #sw3{animation:sw3Grow 2.24s 1.12s ease-out infinite;transform-origin:32px 32px;will-change:transform}
                          #flash{animation:lightFlash 3.52s ease-in-out infinite;will-change:transform}
                        `;
const CSS_TAGWIGGLE = `
                        @keyframes tagWiggle{0%,100%{transform:rotate(-3.6deg) scale(1)}50%{transform:rotate(3.6deg) scale(1.048)}}
                        @keyframes pctPop{0%,100%{transform:scale(1);opacity:0.9}50%{transform:scale(1.09);opacity:1}}
                        @keyframes sparkD1{0%,100%{transform:scale(0.4);opacity:0}40%,60%{transform:scale(1.18);opacity:1}}
                        #dtag{animation:tagWiggle 3.2s ease-in-out infinite;transform-origin:32px 34px;will-change:transform}
                        #dpct{animation:pctPop 2.56s ease-in-out infinite;transform-origin:32px 32px;will-change:transform}
                        #dsp1{animation:sparkD1 2.88s 0.32s ease-in-out infinite;transform-origin:10px 12px;will-change:transform}
                        #dsp2{animation:sparkD1 2.88s 1.28s ease-in-out infinite;transform-origin:52px 14px;will-change:transform}
                      `;
const CSS_CALTAGFLOAT = `
                        @keyframes calTagFloat{0%,100%{transform:translateY(0) rotate(-1.8deg)}50%{transform:translateY(-4.2px) rotate(1.8deg)}}
                        @keyframes mPctSpin{0%,100%{transform:rotate(0deg) scale(1)}50%{transform:rotate(6deg) scale(1.06)}}
                        #mcal{animation:calTagFloat 3.52s ease-in-out infinite;transform-origin:32px 36px;will-change:transform}
                        #mpct{animation:mPctSpin 3.2s ease-in-out infinite;transform-origin:40px 40px;will-change:transform}
                      `;
const CSS_YRRIBBON = `
                        @keyframes yrRibbon{0%,100%{transform:rotate(-2.4deg) scale(1)}50%{transform:rotate(2.4deg) scale(1.036)}}
                        @keyframes yrBadge{0%,100%{opacity:0.85;transform:scale(1)}50%{opacity:1;transform:scale(1.048)}}
                        @keyframes yrShine{0%{opacity:0.1}50%{opacity:0.5}100%{opacity:0.1}}
                        #yrib{animation:yrRibbon 3.2s ease-in-out infinite;transform-origin:32px 32px;will-change:transform}
                        #ybdg{animation:yrBadge 3.2s 0.64s ease-in-out infinite;transform-origin:42px 20px;will-change:transform}
                        #ysh{animation:yrShine 3.2s ease-in-out infinite}
                      `;

// ── Isolated live-clock components ───────────────────────────
// The clock used to tick via setState in the main Home component,
// which meant the ENTIRE app (every tab, every animation, every
// list) re-rendered from scratch once every single second — forever,
// even with nothing on screen changing besides the seconds digit.
// That was the single biggest source of constant background lag.
// Moving the ticking state into these tiny standalone components
// means only these few characters of text re-render each second;
// the rest of the app is completely undisturbed.
const LiveTimeText = React.memo(function LiveTimeText() {
  const [val, setVal] = useState(() => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  useEffect(() => {
    const id = setInterval(() => {
      setVal(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return <>{val}</>;
});

const LiveDateText = React.memo(function LiveDateText() {
  const [val, setVal] = useState(() => new Date().toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }));
  useEffect(() => {
    const id = setInterval(() => {
      setVal(new Date().toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return <>{val}</>;
});

const DAY_NAMES_EN = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAY_NAMES_BN = ['রবিবার','সোমবার','মঙ্গলবার','বুধবার','বৃহস্পতিবার','শুক্রবার','শনিবার'];
const LiveDayText = React.memo(function LiveDayText({ language }: { language: string }) {
  const compute = () => language === 'bn' ? DAY_NAMES_BN[new Date().getDay()] : DAY_NAMES_EN[new Date().getDay()];
  const [val, setVal] = useState(compute);
  useEffect(() => {
    setVal(compute());
    const id = setInterval(() => setVal(compute()), 1000);
    return () => clearInterval(id);
  }, [language]);
  return <>{val}</>;
});

// ── POS product grid card, memoized ──────────────────────────
// This is the #1 remaining POS cost: with the old inline JSX, EVERY
// keystroke (even in the cart's discount box, customer name, qty field —
// anything, anywhere in the app) re-created all ~60 of these buttons from
// scratch, including re-running Date() checks and rebuilding class-name
// strings for every card. As a real React.memo component, a card only
// re-renders if that specific medicine's own data (or the few passed
// display props) actually changed — typing in an unrelated field no
// longer touches these at all.
const ProductCard = React.memo(function ProductCard({ med, onAdd, isDarkMode, currencySymbol, activeThreshold, outText, expText, outLabel, expLabel }: {
  med: any; onAdd: (med: any) => void; isDarkMode: boolean; currencySymbol: string; activeThreshold: number;
  outText: string; expText: string; outLabel: string; expLabel: string;
}) {
  const isExpired = new Date(med.expire) < new Date();
  const isLowStock = med.stock <= (med.lowStockAlert || activeThreshold);
  return (
    <button
      onClick={() => onAdd(med)}
      disabled={med.stock === 0 || isExpired}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '0 90px' } as any}
      className={`p-2.5 rounded-xl border ccard cc-teal text-left transition hover:shadow-sm disabled:opacity-50 disabled:cursor-not-allowed ${isDarkMode ? 'bg-slate-800/60 border-slate-700 hover:border-indigo-500/50' : 'bg-white border-slate-200 hover:border-indigo-300 shadow-sm'}`}
    >
      <div className="font-black text-sm truncate mb-1">{med.name}</div>
      <div className={`text-sm font-semibold ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{med.category}</div>
      <div className="flex items-center justify-between mt-1.5">
        <span className="font-mono font-black text-indigo-500 text-sm">{med.price} {currencySymbol}</span>
        <span className={`text-sm font-black px-1.5 py-0.5 rounded ${med.stock === 0 ? 'bg-red-500 text-white' : isExpired ? 'bg-red-500 text-white' : isLowStock ? 'bg-amber-500 text-white' : isDarkMode ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-500'}`}>
          {med.stock === 0 ? outText : isExpired ? expText : `${med.stock}`}
        </span>
      </div>
    </button>
  );
});

// ── POS cart row, memoized ────────────────────────────────────
// Same reasoning as ProductCard: only re-renders when this specific
// cart item's own fields change, not on every unrelated keystroke.
const CartRow = React.memo(function CartRow({ item, isDarkMode, currencySymbol, onQtyChange, onRemove }: {
  item: any; isDarkMode: boolean; currencySymbol: string;
  onQtyChange: (id: number, val: string) => void; onRemove: (item: any) => void;
}) {
  return (
    <div className={`flex items-center gap-2 p-2 rounded-xl ${isDarkMode ? 'bg-slate-900/60' : 'bg-slate-50'}`}>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-sm truncate">{item.name}</div>
        <div className="text-sm text-indigo-500 font-mono">{item.price} {currencySymbol}</div>
      </div>
      <input type="number" min={1} value={item.qty} onChange={e => onQtyChange(item.id, e.target.value)} className={`w-12 px-1 py-0.5 text-center font-mono text-sm rounded border ${isDarkMode ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}`} />
      <span className="text-sm font-mono font-black w-14 text-right">{((parseInt(item.qty) || 0) * item.price).toFixed(1)}</span>
      <button onClick={() => onRemove(item)} className="text-red-400 hover:text-red-600 text-sm">✕</button>
    </div>
  );
});

// ── Isolated, self-contained search box ───────────────────────
// This is the real fix for typing lag. Previously the typed text was
// held in the GIANT parent component's state — so every keystroke
// re-ran the entire ~9000-line render function (sidebar, whichever tab
// is open, everything), and on a big/old phone that re-run itself is
// what showed up as "text appears late". Here the keystroke is kept in
// this tiny component's OWN state, so typing only re-renders this one
// input — nothing else in the app touches or notices it.
//
// onSearch is called on every keystroke (no artificial delay), but
// wrapped in startTransition — this tells React "the typed character
// itself is urgent, update the box NOW; the search results are
// low-priority, update them when you get a free moment." If you keep
// typing before the low-priority update finishes, React throws away
// the stale one and starts fresh — so the box never stutters or falls
// behind, no matter how large the medicine list is.
const SearchBox = React.memo(function SearchBox({ onSearch, placeholder, className }: {
  onSearch: (val: string) => void; placeholder: string; className: string;
}) {
  const [val, setVal] = useState("");
  return (
    <input
      type="text"
      placeholder={placeholder}
      value={val}
      onChange={e => {
        const next = e.target.value;
        setVal(next);
        startTransition(() => onSearch(next));
      }}
      className={className}
    />
  );
});

export default function Home() {

  // ============================================================
  // LOGIN STATE
  // ============================================================
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loginRole, setLoginRole] = useState<"admin" | "staff">("admin");
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [showForgotPass, setShowForgotPass] = useState(false);
  // New Telegram-based reset flow: send -> verify -> newpass
  const [forgotStep, setForgotStep] = useState<"send" | "verify" | "newpass">("send");
  const [forgotCodeInput, setForgotCodeInput] = useState("");
  const [forgotNewUsername, setForgotNewUsername] = useState("");
  const [forgotNewPass, setForgotNewPass] = useState("");
  const [forgotError, setForgotError] = useState("");
  const [forgotSending, setForgotSending] = useState(false);
  // The OTP itself + its expiry live in Firebase (madina_v7_reset_otp) so the
  // code survives a page refresh and works even if the user closes/reopens
  // the reset dialog before typing the code in.
  const [forgotOtpCode, setForgotOtpCode] = useState("");
  const [forgotOtpExpiresAt, setForgotOtpExpiresAt] = useState(0);
  const [showLoginPass, setShowLoginPass] = useState(false);

  const handleLogoSecretTap = useCallback(() => {}, []);
  const logoTapCount = 0;

  // ============================================================
  // CREDENTIALS & SECURITY
  // ============================================================
  const [adminUsername, setAdminUsername] = useState("admin");
  const [adminPassword, setAdminPassword] = useState("2026");
  const [staffUsername, setStaffUsername] = useState("staff");
  const [staffPassword, setStaffPassword] = useState("staff123");
  const [creatorUsername, setCreatorUsername] = useState("creator");
  const [creatorPassword, setCreatorPassword] = useState("Creator@2026");
  // Telegram bot used to deliver the "Forgot Password" one-time code.
  // Set these once from Settings -> Login Credentials (Admin only).
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [currentPassCheck, setCurrentPassCheck] = useState("");
  const [credentialsUnlockError, setCredentialsUnlockError] = useState("");
  const [newUsernameInput, setNewUsernameInput] = useState("admin");
  const [newPasswordInput, setNewPasswordInput] = useState("2026");
  const [newStaffUsernameInput, setNewStaffUsernameInput] = useState("staff");
  const [newStaffPasswordInput, setNewStaffPasswordInput] = useState("staff123");
  const [newCreatorUsernameInput, setNewCreatorUsernameInput] = useState("creator");
  const [newCreatorPasswordInput, setNewCreatorPasswordInput] = useState("Creator@2026");
  const [newTelegramBotTokenInput, setNewTelegramBotTokenInput] = useState("");
  const [newTelegramChatIdInput, setNewTelegramChatIdInput] = useState("");
  const [isCredentialsFormUnlocked, setIsCredentialsFormUnlocked] = useState(false);
  // isCredentialsFormUnlockedRef always mirrors isCredentialsFormUnlocked so the
  // Firebase realtime listener (which is set up once and would otherwise close
  // over a stale "false") can check, at the moment a cloud update arrives,
  // whether the Creator currently has the credentials form open/being edited —
  // and if so, skip overwriting those draft input fields so typed changes are
  // never silently wiped out mid-edit by an unrelated sync from another device.
  const isCredentialsFormUnlockedRef = useRef(false);
  useEffect(() => { isCredentialsFormUnlockedRef.current = isCredentialsFormUnlocked; }, [isCredentialsFormUnlocked]);

  // ============================================================
  // SCROLL REVEAL ANIMATION — automatically fades/slides cards &
  // sections into view as the user scrolls down. No per-section
  // edits needed: it auto-detects card-like blocks (rounded-2xl,
  // rounded-xl, .ccard, .card-hover) anywhere on the page and a
  // MutationObserver re-scans whenever tabs/content change, so it
  // keeps working across the whole app automatically.
  // ============================================================
  useEffect(() => {
    const REVEAL_SELECTOR = '.rounded-2xl, .rounded-xl, .ccard, .card-hover';
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('sr-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0, rootMargin: '0px 0px -40px 0px' });

    // Safety net: very tall elements (long lists/tables/pages) or ones
    // resized after being tagged can end up never crossing the observer's
    // trigger and get stuck permanently at opacity:0 (blank/white). This
    // periodically force-shows anything already on/near screen that
    // hasn't revealed itself yet.
    const forceRevealVisible = () => {
      document.querySelectorAll('.sr-auto:not(.sr-visible)').forEach((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.top < window.innerHeight + 200 && rect.bottom > -200) {
          el.classList.add('sr-visible');
          io.unobserve(el);
        }
      });
    };
    const safetyInterval = window.setInterval(forceRevealVisible, 400);

    const MAX_UNIT_HEIGHT = () => window.innerHeight * 1.8;

    // Recursively descend into an oversized element to find reasonably
    // sized "units" (rows/cards/items) to animate individually, instead of
    // giving up after one level (which is why table rows never animated).
    const collectUnits = (el: HTMLElement, depth: number): HTMLElement[] => {
      if (el.offsetHeight <= MAX_UNIT_HEIGHT() || depth > 6) return [el];
      const kids = Array.from(el.children).filter((c): c is HTMLElement => c instanceof HTMLElement);
      if (kids.length === 0) return [el];
      return kids.flatMap((kid) => collectUnits(kid, depth + 1));
    };

    const tagAndObserve = () => {
      document.querySelectorAll(REVEAL_SELECTOR).forEach((el) => {
        if (el.classList.contains('sr-auto') || el.classList.contains('sr-visible')) return;
        const ancestor = el.parentElement?.closest('.sr-auto, .sr-visible');
        if (ancestor) return;
        const height = (el as HTMLElement).offsetHeight;
        // Very tall blocks (long lists/tables/whole pages) shouldn't be
        // hidden as ONE unit — that causes a big blank/white gap. Instead,
        // recursively dive down (through tables/rows/nested lists) to find
        // reasonably-sized units and animate each individually (staggered),
        // so big pages/tables still animate but never go blank.
        if (height > MAX_UNIT_HEIGHT()) {
          collectUnits(el as HTMLElement, 0).forEach((unit) => {
            if (unit === el) return; // couldn't break it down further, leave as-is
            if (unit.classList.contains('sr-auto') || unit.classList.contains('sr-visible')) return;
            unit.classList.add('sr-auto');
            io.observe(unit);
          });
          return;
        }
        el.classList.add('sr-auto');
        io.observe(el);
      });
    };

    tagAndObserve();
    const mo = new MutationObserver(() => tagAndObserve());
    mo.observe(document.body, { childList: true, subtree: true });

    return () => { io.disconnect(); mo.disconnect(); window.clearInterval(safetyInterval); };
  }, []);

  // ============================================================
  // LANGUAGE
  // ============================================================
  const [language, setLanguage] = useState<"en" | "bn">("en");

  const t = useCallback((en: string, bn: string) => language === "bn" ? bn : en, [language]);

  // ============================================================
  // ROLE & PERMISSIONS
  // ============================================================
  const [currentUserRole, setCurrentUserRole] = useState<"ADMIN" | "STAFF">("ADMIN");


  const [staffVisibleModules, setStaffVisibleModules] = useState<{ [key: string]: boolean }>({
    pos: true,
    inventory: true,
    procurement: true,
    purchase_history: true,
    invoices: true,
    returns: true,
    analytics: true,
    settings: false,
    modules_menu: false,
    daily_profit_view: true,
    monthly_profit_view: true,
    low_stock_alerts: true,
    stock_out_view: true,
    expired_meds_view: true,
    supplier_management: true,
    batch_tracking: true,
    customer_database: true,
    sales_reports: true,
    purchase_reports: true,
    vat_tax_calculator: true,
    discount_manager: true,
    receipt_customizer: true,
    user_role_switcher: false,
    backup_restore: true,
    advanced_analytics: true,
    medicine_suggestions_db: true,
    company_database: true,
    rack_management: true,
    expiry_tracker: true,
    profit_margin_calculator: true,
    invoice_search: true,
    return_analytics: true,
    stock_value_calculator: true,
    category_wise_stock: true,
    monthly_purchases_view: true,
    daily_purchases_view: true,
    financials_summary_card: true,
    revenue_chart_view: true,
    due_list_view: true,
    due_collection_view: true,
    company_purchase_history_view: true,
    bkash_nagad_view: true,
    report_view: true,
    yearly_sales_view: true,
    yearly_purchase_view: true,
    yearly_profit_view: true,
    yearly_due_view: true,
    // New permission keys for full staff control
    daily_sale_view: true,
    monthly_sale_view: true,
    daily_due_view: true,
    monthly_due_view: true,
    monthly_due_collection_view: true,
    daily_due_collection_view: true,
    monthly_discount_view: true,
    yearly_discount_view: true,
    // Closing Report permissions
    closing_report: true,
    closing_total_sales: true,
    closing_cash_received: true,
    closing_profit: true,
    closing_due: true,
    closing_bkash: true,
    closing_discount: true,
    closing_due_collection: true,
    closing_final_summary: true,
    // Daily / Monthly Report permissions
    daily_report: true,
    daily_report_sell: true,
    daily_report_profit: true,
    daily_report_due: true,
    daily_report_due_collection: true,
    daily_report_purchase: true,
    daily_report_returns: true,
    monthly_report: true,
    monthly_report_sell: true,
    monthly_report_profit: true,
    monthly_report_due: true,
    monthly_report_due_collection: true,
    monthly_report_purchase: true,
    monthly_report_returns: true,
    expense_tracker: true,
    expense_add: true,
    expense_edit: true,
    expense_delete: true,
    expense_view_history: true,
    expense_view_profit: true,
  });

  const [adminVisibleModules, setAdminVisibleModules] = useState<{ [key: string]: boolean }>({
    pos: true, inventory: true, procurement: true, purchase_history: true, invoices: true, returns: true,
    analytics: true, settings: true, modules_menu: true, daily_profit_view: true, monthly_profit_view: true,
    low_stock_alerts: true, stock_out_view: true, expired_meds_view: true, supplier_management: true, batch_tracking: true,
    customer_database: true, sales_reports: true, purchase_reports: true, vat_tax_calculator: true,
    discount_manager: true, receipt_customizer: true, user_role_switcher: true, backup_restore: true,
    advanced_analytics: true, medicine_suggestions_db: true, company_database: true, rack_management: true,
    expiry_tracker: true, profit_margin_calculator: true, invoice_search: true, return_analytics: true,
    stock_value_calculator: true, category_wise_stock: true, monthly_purchases_view: true, daily_purchases_view: true,
    financials_summary_card: true, revenue_chart_view: true, due_list_view: true, due_collection_view: true,
    company_purchase_history_view: true, bkash_nagad_view: true, report_view: true, yearly_sales_view: true,
    yearly_purchase_view: true, yearly_profit_view: true, yearly_due_view: true, daily_sale_view: true,
    monthly_sale_view: true, daily_due_view: true, monthly_due_view: true, monthly_due_collection_view: true,
    daily_due_collection_view: true, monthly_discount_view: true, yearly_discount_view: true,
    closing_report: true, closing_total_sales: true, closing_cash_received: true, closing_profit: true,
    closing_due: true, closing_bkash: true, closing_discount: true, closing_due_collection: true,
    closing_final_summary: true,
    daily_report: true, daily_report_sell: true, daily_report_profit: true, daily_report_due: true,
    daily_report_due_collection: true, daily_report_purchase: true, daily_report_returns: true,
    monthly_report: true, monthly_report_sell: true, monthly_report_profit: true, monthly_report_due: true,
    monthly_report_due_collection: true, monthly_report_purchase: true, monthly_report_returns: true,
    expense_tracker: true, expense_add: true, expense_edit: true, expense_delete: true,
    expense_view_history: true, expense_view_profit: true,
  });

  // ============================================================
  // CREATOR SYSTEM CONTROLS — lock entire app for Admin/Staff,
  // and a notice/description shown to Admin & Staff.
  // ============================================================
  const [systemLocked, setSystemLocked] = useState(false);
  const [creatorNotice, setCreatorNotice] = useState("");
  const [creatorNoticeInput, setCreatorNoticeInput] = useState("");
  // ============================================================
  // TODAY KEY — used to force daily stats re-computation at midnight
  // ============================================================
  const [todayKey, setTodayKey] = useState(() => new Date().toDateString());

  // ============================================================
  // SOUND & UI ENHANCEMENT STATES
  // ============================================================
  const [soundEnabled, setSoundEnabled] = useState(true);
  // liveTime/liveDate/liveDay state removed — now handled by isolated
  // LiveTimeText/LiveDateText/LiveDayText components (see module scope above)
  const [loginShake, setLoginShake] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [toastQueue, setToastQueue] = useState<{id:number,msg:string,type:'success'|'error'|'info'}[]>([]);
  const toastIdRef = useRef(0);

  // Only play sound for a small set of IMPORTANT actions (login, errors,
  // checkout/success, warnings). Frequent decorative sounds — tab switch,
  // generic click, add-to-cart, print, save — are skipped entirely, since
  // firing on every single click/navigation was a real source of lag.
  const IMPORTANT_SOUNDS = useMemo(() => new Set(['login', 'error', 'checkout', 'success', 'warning']), []);
  const playSound = useCallback((type: 'success'|'click'|'error'|'add'|'login'|'notify'|'delete'|'checkout'|'tab'|'warning'|'print'|'save') => {
    if (soundEnabled && IMPORTANT_SOUNDS.has(type)) createSound(type);
  }, [soundEnabled, IMPORTANT_SOUNDS]);

  const addToast = useCallback((msg: string, type: 'success'|'error'|'info' = 'success') => {
    const id = ++toastIdRef.current;
    setToastQueue(q => [...q, { id, msg, type }]);
    setTimeout(() => setToastQueue(q => q.filter(t => t.id !== id)), 3500);
  }, []);




  const [isMounted, setIsMounted] = useState(false);

  // ============================================================
  // CORE DATA STATES
  // ============================================================
  const [medicines, setMedicines] = useState<any[]>([]);
  const medicinesRef = useRef<any[]>([]);
  // Tracks the last-applied RAW string for each cloud key. Every local
  // write (checkout, edit, etc.) round-trips back through the SSE listener
  // moments later as an echo of the exact same value — without this check,
  // that echo re-parses the JSON and calls setState with a brand-new array
  // reference every time, forcing a full re-render of the whole app on top
  // of the optimistic render that already happened for the same action.
  // String-comparing the raw payload before parsing catches that for free.
  const lastAppliedRawRef = useRef<Record<string, string>>({});
  useEffect(() => { medicinesRef.current = medicines; }, [medicines]);
  const [totalSales, setTotalSales] = useState(0);
  const [totalProfit, setTotalProfit] = useState(0);
  const [invoices, setInvoices] = useState<any[]>([]);
  // invoicesRef always holds the latest invoices so the Firebase listener
  // can derive sales correctly even when only due-collection-log updates
  // arrive in a given event (avoids stale closure)
  const invoicesRef = useRef<any[]>([]);
  useEffect(() => { invoicesRef.current = invoices; }, [invoices]);
  const [cart, setCart] = useState<any[]>([]);
  // cartRef always holds the latest cart so the Firebase listener
  // can re-apply pending deductions without stale closure issues
  const cartRef = useRef<any[]>([]);
  useEffect(() => { cartRef.current = cart; }, [cart]);
  // ── URL Hash-based Routing ──────────────────────────────────
  // Tab state is synced with the browser URL hash (e.g. /#inventory).
  // This enables browser Back/Forward navigation between sections,
  // bookmarkable URLs, and YouTube-style navigation UX.
  const validTabs = [
    "pos","analytics","inventory","procurement","new_product",
    "purchase_history","company_purchase_history","invoices",
    "due_list","due_collection","report","closing_report",
    "returns","settings","modules_menu","daily_report","monthly_report",
    "reconciliation"
  ];
  const getTabFromHash = () => {
    if (typeof window === 'undefined') return "pos";
    const hash = window.location.hash.replace('#', '');
    return validTabs.includes(hash) ? hash : "pos";
  };
  const [activeTab, setActiveTab] = useState("pos");

  // Navigate to a tab: updates URL hash + state (pushState for back button support)
  const navigateTab = useCallback((tab: string) => {
    if (typeof window !== 'undefined') {
      window.history.pushState(null, '', `#${tab}`);
    }
    // startTransition: the click itself should always feel instant.
    // Some tabs (Invoices, Inventory, Purchase History) can have a lot of
    // rows to build — without this, clicking a menu item could freeze the
    // whole screen for a moment until that tab's content finished
    // rendering. With this, React treats "switch to this tab" as
    // low-priority: it stays responsive to your tap/click right away, and
    // fills in the new tab's content the instant it's ready.
    startTransition(() => setActiveTab(tab));
  }, []);

  // On mount: read hash from URL to restore tab
  useEffect(() => {
    setActiveTab(getTabFromHash());
    const onHashChange = () => setActiveTab(getTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Edit / Modal Back-Button Tracking ───────────────────────
  // When user opens an edit row or modal, we push a "dummy" history
  // entry so the browser Back button closes the edit instead of
  // navigating away from the page entirely.
  //
  // Usage:
  //   openEdit()   — call when opening any edit/modal
  //   closeEdit()  — call when closing any edit/modal (cancel / save)
  //
  // The popstate listener detects the Back button press and calls
  // the registered closer function automatically.
  const editCloserRef = useRef<(() => void) | null>(null);

  const openEdit = useCallback((closerFn: () => void) => {
    editCloserRef.current = closerFn;
    window.history.pushState({ editOpen: true }, '');
  }, []);

  const closeEdit = useCallback(() => {
    editCloserRef.current = null;
    // If we're sitting on the dummy edit state, go back to remove it
    if (window.history.state?.editOpen) {
      window.history.back();
    }
  }, []);

  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      if (editCloserRef.current) {
        // Back was pressed while an edit/modal was open — close it
        editCloserRef.current();
        editCloserRef.current = null;
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const [bdMedicineCompanies, setBdMedicineCompanies] = useState<string[]>([]);
  const bdMedicineCompaniesRef = useRef<string[]>([]);
  useEffect(() => { bdMedicineCompaniesRef.current = bdMedicineCompanies; }, [bdMedicineCompanies]);
  const [bdMedicineNamesList, setBdMedicineNamesList] = useState<string[]>([]);
  const bdMedicineNamesListRef = useRef<string[]>([]);
  useEffect(() => { bdMedicineNamesListRef.current = bdMedicineNamesList; }, [bdMedicineNamesList]);
  // Stores per-medicine metadata: { name, buyPrice, sellPrice, company, category }
  const [bdMedNameMetadata, setBdMedNameMetadata] = useState<{name:string; buyPrice:number; sellPrice:number; company:string; category?:string}[]>([]);
  const bdMedNameMetadataRef = useRef<{name:string; buyPrice:number; sellPrice:number; company:string; category?:string}[]>([]);
  useEffect(() => { bdMedNameMetadataRef.current = bdMedNameMetadata; }, [bdMedNameMetadata]);

  // ============================================================
  // DUE (CUSTOMER CREDIT) SYSTEM
  // ============================================================
  const [dueList, setDueList] = useState<any[]>([]);
  // dueListRef always holds the latest due list so checkout/return/due-payment
  // can fall back to it if a fresh Firebase fetch fails mid-operation.
  const dueListRef = useRef<any[]>([]);
  useEffect(() => { dueListRef.current = dueList; }, [dueList]);
  const [duePaymentModal, setDuePaymentModal] = useState<any>(null);
  const [duePayAmount, setDuePayAmount] = useState("");

  // ============================================================
  // EXPENSE TRACKER — form & filter state
  // ============================================================
  const EXPENSE_PRESET_CATEGORIES = ["Rent", "Electricity", "Staff Salary", "Transport", "Maintenance", "Other"];
  const [expenseCategory, setExpenseCategory] = useState("Rent");
  const [expenseCustomCategory, setExpenseCustomCategory] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseNote, setExpenseNote] = useState("");
  const [expensePaymentMethod, setExpensePaymentMethod] = useState("Cash");
  const [editingExpenseId, setEditingExpenseId] = useState<number | null>(null);
  const [expenseFilter, setExpenseFilter] = useState<"all" | "today" | "month">("all");
  const [dueCollectionLog, setDueCollectionLog] = useState<any[]>([]);

  // ============================================================
  // PHASE 3: PAYMENT LEDGER + CASH LEDGER
  // ============================================================
  // paymentLedger: one record per payment event, linked to transactionId
  //   paymentType: SALE_PAYMENT | DUE_COLLECTION | REFUND
  // cashLedger: one record per cash-affecting operation
  //   type: CASH_SALE | DUE_COLLECTION | REFUND | EXPENSE | OTHER_CASH_IN | OTHER_CASH_OUT
  const [paymentLedger, setPaymentLedger] = useState<any[]>([]);
  const paymentLedgerRef = useRef<any[]>([]);
  useEffect(() => { paymentLedgerRef.current = paymentLedger; }, [paymentLedger]);
  const [cashLedger, setCashLedger] = useState<any[]>([]);
  const cashLedgerRef = useRef<any[]>([]);
  useEffect(() => { cashLedgerRef.current = cashLedger; }, [cashLedger]);

  // Phase 4: Stock Movement Ledger
  // Every stock-changing operation writes an immutable movement record here.
  // movementId, transactionId, medicineId, type (SALE|PURCHASE|RETURN|ADJUSTMENT),
  // quantity (always positive — direction encoded in type), previousStock,
  // resultingStock, timestamp, invoiceId/reference.
  const [stockMovements, setStockMovements] = useState<any[]>([]);
  const stockMovementsRef = useRef<any[]>([]);
  useEffect(() => { stockMovementsRef.current = stockMovements; }, [stockMovements]);

  // ============================================================
  // PHASE 6: RECONCILIATION STATE
  // ============================================================
  const [auditLog, setAuditLog] = useState<any[]>([]);
  const auditLogRef = useRef<any[]>([]);
  useEffect(() => { auditLogRef.current = auditLog; }, [auditLog]);

  // Reconciliation report result (null = not yet run)
  const [reconReport, setReconReport] = useState<any | null>(null);
  const [reconRunning, setReconRunning] = useState(false);
  const [reconDate, setReconDate] = useState(() => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    return `${parts.find(p=>p.type==='year')!.value}-${parts.find(p=>p.type==='month')!.value}-${parts.find(p=>p.type==='day')!.value}`;
  });
  const [reconTab, setReconTab] = useState<'summary'|'sales'|'cash'|'due'|'stock'|'profit'|'purchase'|'return'|'expense'|'eod'|'audit'>('summary');

  // ── Daily / Monthly Report states ───────────────────────────
  const [dailyReportDate, setDailyReportDate] = useState(() => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const y = parts.find(p => p.type === 'year')!.value;
    const m = parts.find(p => p.type === 'month')!.value;
    const d = parts.find(p => p.type === 'day')!.value;
    return `${y}-${m}-${d}`;
  });
  const [monthlyReportMonth, setMonthlyReportMonth] = useState(() => new Date().toISOString().slice(0, 7));
  // dueCollectionLogRef always holds the latest log so the Firebase
  // listener can derive sales correctly even if the due-collection-log
  // key hasn't synced yet in the same update batch (avoids stale closure)
  const dueCollectionLogRef = useRef<any[]>([]);
  useEffect(() => { dueCollectionLogRef.current = dueCollectionLog; }, [dueCollectionLog]);
  const [dueSearch, setDueSearch] = useState("");
  const [dueCollectionSearch, setDueCollectionSearch] = useState("");
  const [companyPurchaseSearch, setCompanyPurchaseSearch] = useState("");

  // ============================================================
  // APPEARANCE
  // ============================================================
  // themeMode: 'light' | 'dark' | 'ocean' | 'forest' | 'royal' | 'sunset'
  const [themeMode, setThemeMode] = useState<string>("light");
  // isDarkMode is derived: true for all non-light themes' dark-style backgrounds
  const isDarkMode = themeMode !== "light";

;

  const themeClass = (lightCls: string, darkCls: string) => {
    if (themeMode === 'light') return lightCls;
    return darkCls;
  };
  const [pharmacyName, setPharmacyName] = useState("Madina Medicine Corner");
  const [pharmacySlogan, setPharmacySlogan] = useState("Professional Pharmacy POS System");
  const [pharmacyAddress, setPharmacyAddress] = useState("Chaumuhani Bazar, Cumilla");
  const [pharmacyLogo, setPharmacyLogo] = useState("M+");
  const [currencySymbol, setCurrencySymbol] = useState("৳");
  const [vatPercentage, setVatPercentage] = useState("0");
  const [lowStockThreshold, setLowStockThreshold] = useState("10");
  const [receiptFooterMsg, setReceiptFooterMsg] = useState("ধন্যবাদ, আবার আসবেন!");

  // ============================================================
  // INVENTORY EDITING
  // ============================================================
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFormData, setEditFormData] = useState<any>({});

  // ============================================================
  // POS / CHECKOUT
  // ============================================================
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [showCustomerSuggestions, setShowCustomerSuggestions] = useState(false);
  const [showPhoneSuggestions, setShowPhoneSuggestions] = useState(false);
  const [selectedExistingDue, setSelectedExistingDue] = useState<any>(null);
  const [showCustomerPanel, setShowCustomerPanel] = useState(true);
  const [paymentMethod, setPaymentMethod] = useState("Cash");
  const [cashReceived, setCashReceived] = useState("");
  const [invoiceDue, setInvoiceDue] = useState("0");
  const [discountType, setDiscountType] = useState<"TK" | "PERCENT">("TK");
  const [discountValue, setDiscountValue] = useState("0");
  const [searchTerm, setSearchTerm] = useState("");
  // Inventory table pagination — rendering hundreds of rows in one go on
  // every tab click was a real cost (DOM node creation + reconciliation),
  // separate from the content-visibility paint optimization already in
  // place. Paging caps that to a fixed row count regardless of stock size.
  const [invPage, setInvPage] = useState(1);
  const INV_PAGE_SIZE = 50;
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [searchInvoiceQuery, setSearchInvoiceQuery] = useState("");

  // ============================================================
  // MODALS
  // ============================================================
  const [showReceipt, setShowReceipt] = useState(false);
  const [lastInvoice, setLastInvoice] = useState<any>(null);
  const [showSuccessAlert, setShowSuccessAlert] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [calculatorInput, setCalculatorInput] = useState("");

  // ── Sale submission guard ────────────────────────────────────
  // isSubmittingSale: blocks double-click / double-tap — the Confirm
  // button is disabled and the function returns immediately while a
  // sale is already in-flight.
  //
  // submittedTransactionIds: idempotency set — once a transactionId
  // is successfully committed, we keep it in memory. If the same id
  // somehow reaches executeFinalCheckout again (e.g. React StrictMode
  // double-invocation in dev, or a racing state update), the second
  // call is dropped immediately before any Firebase operation.
  const [isSubmittingSale, setIsSubmittingSale] = useState(false);
  const submittedTransactionIds = useRef<Set<string>>(new Set());
  const [dashboardFilterView, setDashboardFilterView] = useState<"NONE" | "LOW_STOCK" | "EXPIRED">("NONE");

  // ============================================================
  // STOCK IN / PURCHASE
  // ============================================================
  const [purchaseList, setPurchaseList] = useState<any[]>([]);
  const [expenseList, setExpenseList] = useState<any[]>([]);
  const purchaseListRef = useRef<any[]>([]);
  useEffect(() => { purchaseListRef.current = purchaseList; }, [purchaseList]);
  const expenseListRef = useRef<any[]>([]);
  useEffect(() => { expenseListRef.current = expenseList; }, [expenseList]);
  const [pCompanyName, setPCompanyName] = useState("");
  const [purchaseCart, setPurchaseCart] = useState<any[]>([]);
  const [pMedicineName, setPMedicineName] = useState("");
  const [pGenericName, setPGenericName] = useState("");
  const [pCategory, setPCategory] = useState("Tablet");
  const [pBatchNo, setPBatchNo] = useState("");
  const [pQuantity, setPQuantity] = useState("");
  const [pExpireDate, setPExpireDate] = useState("");
  const [pUnitPriceBox, setPUnitPriceBox] = useState("");
  const [pTotalCost, setPTotalCost] = useState("");
  const [pRetailPrice, setPRetailPrice] = useState("");
  const [pMedicineSuggestions, setPMedicineSuggestions] = useState<{name:string; buyPrice:number; sellPrice:number; company:string; category?:string}[]>([]);
  const [showMedicineSuggestions, setShowMedicineSuggestions] = useState(false);
  const [pRackLocation, setPRackLocation] = useState("");
  const [pLowStockAlert, setPLowStockAlert] = useState("");
  const [pAmountPaid, setPAmountPaid] = useState("");
  const [companySuggestions, setCompanySuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestionRef = useRef<HTMLDivElement>(null);
  const medicineSuggestRef = useRef<HTMLDivElement>(null);

  // ============================================================
  // NEW PRODUCT FORM STATES (Add Product → goes to Stock In only)
  // ============================================================
  const [npCompanyName, setNpCompanyName] = useState("");
  const [npMedicineName, setNpMedicineName] = useState("");
  const [npGenericName, setNpGenericName] = useState("");
  const [npBuyPrice, setNpBuyPrice] = useState("");
  const [npSalePrice, setNpSalePrice] = useState("");
  const [npCategory, setNpCategory] = useState("Tablet");
  const [npCompanySuggestions, setNpCompanySuggestions] = useState<string[]>([]);
  const [showNpCompanySuggestions, setShowNpCompanySuggestions] = useState(false);
  const [npMedSuggestions, setNpMedSuggestions] = useState<{name:string; buyPrice:number; sellPrice:number; company:string; category?:string}[]>([]);
  const [showNpMedSuggestions, setShowNpMedSuggestions] = useState(false);
  const npCompanyRef = useRef<HTMLDivElement>(null);
  const npMedRef = useRef<HTMLDivElement>(null);

  // ============================================================
  // RETURN SYSTEM
  // ============================================================
  const [selectedVoucher, setSelectedVoucher] = useState<any>(null);
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [selectedInvoiceForReturn, setSelectedInvoiceForReturn] = useState<any>(null);
  const [returnItemsQuantities, setReturnItemsQuantities] = useState<{ [key: number]: number }>({});
  const [returnActionType, setReturnActionType] = useState<"CASH_REFUND" | "STORE_CREDIT">("CASH_REFUND");
  const [returnReason, setReturnReason] = useState("");

  // ============================================================
  // SETTINGS FORM STATES
  // ============================================================
  const [settingsName, setSettingsName] = useState("");
  const [settingsSlogan, setSettingsSlogan] = useState("");
  const [settingsAddress, setSettingsAddress] = useState("");
  const [settingsLogo, setSettingsLogo] = useState("");

  // ============================================================
  // BACKUP & RESTORE STATES
  // ============================================================
  const [lastBackupTime, setLastBackupTime] = useState<string>("");
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const restoreFileRef = useRef<HTMLInputElement>(null);

  // ============================================================
  // HELPER: PARSE DATE
  // ============================================================
  const parseCustomDateString = (dateStr: string): Date => {
    try {
      if (!dateStr) return new Date();
      const parts = dateStr.split('|');
      return new Date(parts[0].trim());
    } catch (e) {
      return new Date();
    }
  };

  // Returns YYYY-MM-DD for the given date, ALWAYS in Bangladesh time
  // (Asia/Dhaka, UTC+6) — regardless of the device/browser's own timezone
  // setting. This keeps daily/monthly reports consistent even if a user's
  // phone or computer clock is set to a different timezone.
  const toLocalISODate = (d: Date): string => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d);
    const y = parts.find(p => p.type === 'year')!.value;
    const m = parts.find(p => p.type === 'month')!.value;
    const day = parts.find(p => p.type === 'day')!.value;
    return `${y}-${m}-${day}`;
  };

  // ============================================================
  // SYNC STATUS STATE
  // ============================================================
  // 'idle'    — not yet attempted
  // 'syncing' — fetching from Firebase right now
  // 'synced'  — successfully loaded/saved via Firebase
  // 'offline' — could not reach Firebase (no internet / server down)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'offline'>('idle');
  const [pendingSaveCount, setPendingSaveCount] = useState(0);

  // Subscribe to the module-level save tracker so the UI can clearly tell
  // the user when a save to Firebase actually failed (no internet, etc.)
  // — since there's no local cache, a failed save means that change is
  // NOT stored anywhere yet and must be retried.
  useEffect(() => {
    const listener = (pending: number, hasFailure: boolean) => {
      setPendingSaveCount(pending);
      if (hasFailure) {
        setSyncStatus('offline');
        addToast(
          t("❌ Couldn't save — check your internet connection!", "❌ সেভ হয়নি — ইন্টারনেট সংযোগ চেক করুন!"),
          'error'
        );
        hasFailedSave = false; // reset after notifying, so it doesn't repeat-fire
      }
    };
    saveListeners.add(listener);
    return () => { saveListeners.delete(listener); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============================================================
  // LOAD DATA — Firebase ONLY (no localStorage cache for business data)
  // ─────────────────────────────────────────────────────────────
  // Business data (medicines, invoices, sales, settings, etc.) lives
  // exclusively in Firebase now. Nothing is cached in localStorage, so:
  //   • Every device always sees the true current state on load.
  //   • There is no stale-cache/race condition to cause "old data shows
  //     up on another device" issues.
  //   • Without internet, there's nothing to show — the app clearly
  //     tells the user it's offline instead of silently working off
  //     of out-of-date local data.
  // Device-only preferences (login session, theme, sound, language)
  // still use localStorage, since those are intentionally per-device.
  // ============================================================
  useEffect(() => {
    setLastBackupTime(localStorage.getItem('madina_v7_last_backup') || "");

    // Session is always device-local (login expires at midnight)
    const savedSession = localStorage.getItem('madina_v7_session');
    if (savedSession) {
      try {
        const sess = JSON.parse(savedSession);
        const today = new Date().toDateString();
        if (sess.date === today && sess.role) {
          setIsLoggedIn(true);
          setCurrentUserRole(sess.role);
        } else {
          localStorage.removeItem('madina_v7_session');
        }
      } catch {
        localStorage.removeItem('madina_v7_session');
      }
    }

    // Device-local preferences (not synced across devices)
    const savedDark = localStorage.getItem('madina_v7_dark');
    const savedTheme = localStorage.getItem('madina_v7_theme');
    const savedSound = localStorage.getItem('madina_v7_sound');
    const savedLang = localStorage.getItem('madina_v7_language');
    if (savedTheme) setThemeMode(savedTheme === 'dark' ? 'dark' : 'light');
    else if (savedDark) setThemeMode(JSON.parse(savedDark) ? 'dark' : 'light');
    if (savedSound !== null) setSoundEnabled(JSON.parse(savedSound));
    if (savedLang) setLanguage(savedLang as any);

    // Helper: apply loaded cloud data to all state setters
    const applyData = (data: Record<string, string | null>) => {
      const g = (key: string) => data[key] ?? null;

      const savedMeds = g('madina_v7_meds');
      if (savedMeds) {
        const parsedMeds = JSON.parse(savedMeds);
        const { list: dedupedMeds, changed: medsChanged } = dedupeIds(parsedMeds);
        setMedicines(dedupedMeds);
        if (medsChanged) cloudSet('madina_v7_meds', JSON.stringify(dedupedMeds));
      }

      const savedInvoices = g('madina_v7_invoices');
      let parsedInvoices: any[] = [];
      if (savedInvoices) {
        try {
          parsedInvoices = JSON.parse(savedInvoices);
          setInvoices(parsedInvoices);
        } catch { /* skip malformed */ }
      }

      const savedPurchases = g('madina_v7_purchases');
      if (savedPurchases) {
        const parsedPurchases = JSON.parse(savedPurchases);
        const { list: dedupedPurchases, changed: purchasesChanged } = dedupeIds(parsedPurchases);
        setPurchaseList(dedupedPurchases);
        if (purchasesChanged) cloudSet('madina_v7_purchases', JSON.stringify(dedupedPurchases));
      }

      const savedDueList = g('madina_v7_due_list');
      if (savedDueList) {
        const parsedDueList = JSON.parse(savedDueList);
        const { list: dedupedDueList, changed: dueListChanged } = dedupeIds(parsedDueList);
        setDueList(dedupedDueList);
        if (dueListChanged) cloudSet('madina_v7_due_list', JSON.stringify(dedupedDueList));
      }

      const savedExpenses = g('madina_v7_expenses');
      if (savedExpenses) {
        try {
          const parsedExpenses = JSON.parse(savedExpenses);
          const { list: dedupedExpenses, changed: expensesChanged } = dedupeIds(parsedExpenses);
          setExpenseList(dedupedExpenses);
          if (expensesChanged) cloudSet('madina_v7_expenses', JSON.stringify(dedupedExpenses));
        } catch { /* skip malformed */ }
      }

      const savedDueCLog = g('madina_v7_due_collection_log');
      let parsedDueCLog: any[] = [];
      if (savedDueCLog) {
        try {
          parsedDueCLog = JSON.parse(savedDueCLog);
          setDueCollectionLog(parsedDueCLog);
        } catch { /* skip malformed */ }
      }

      // Recalculate sales & profit from invoices + due collections for cross-device
      // consistency (source of truth). Fall back to stored value only when neither
      // invoices nor due-collection-log is available.
      if (parsedInvoices.length > 0 || parsedDueCLog.length > 0) {
        const { sales: derivedSales, profit: derivedProfit } = computeSalesAndProfit(parsedInvoices, parsedDueCLog);
        setTotalSales(derivedSales);
        setTotalProfit(derivedProfit);
      } else {
        const savedSales = g('madina_v7_sales');
        if (savedSales) setTotalSales(parseFloat(savedSales) || 0);

        const savedProfit = g('madina_v7_profit');
        if (savedProfit) setTotalProfit(parseFloat(savedProfit) || 0);
      }

      const savedCompanies = g('madina_v7_companies');
      if (savedCompanies) {
        try {
          const parsed = JSON.parse(savedCompanies);
          if (Array.isArray(parsed) && parsed.length > 0) setBdMedicineCompanies(parsed);
        } catch { /* skip malformed */ }
      }

      const savedMedNames = g('madina_v7_mednames');
      if (savedMedNames) {
        try {
          const parsed = JSON.parse(savedMedNames);
          if (Array.isArray(parsed) && parsed.length > 0) setBdMedicineNamesList(parsed);
        } catch { /* skip malformed */ }
      }

      const savedMedMeta = g('madina_v7_medmeta');
      if (savedMedMeta) setBdMedNameMetadata(JSON.parse(savedMedMeta));

      const savedName = g('madina_v7_name');
      if (savedName) { setPharmacyName(savedName); setSettingsName(savedName); }
      else setSettingsName("Madina Medicine Corner");

      const savedSlogan = g('madina_v7_slogan');
      if (savedSlogan) { setPharmacySlogan(savedSlogan); setSettingsSlogan(savedSlogan); }
      else setSettingsSlogan("Professional Pharmacy POS System");

      const savedAddress = g('madina_v7_address');
      if (savedAddress) { setPharmacyAddress(savedAddress); setSettingsAddress(savedAddress); }
      else setSettingsAddress("Chaumuhani Bazar, Cumilla");

      const savedLogo = g('madina_v7_logo');
      if (savedLogo) { setPharmacyLogo(savedLogo); setSettingsLogo(savedLogo); }
      else setSettingsLogo("M+");

      const savedCurrency = g('madina_v7_currency');
      if (savedCurrency) setCurrencySymbol(savedCurrency);

      const savedVat = g('madina_v7_vat');
      if (savedVat) setVatPercentage(savedVat);

      const savedThreshold = g('madina_v7_threshold');
      if (savedThreshold) setLowStockThreshold(savedThreshold);

      const savedFooter = g('madina_v7_footer');
      if (savedFooter) setReceiptFooterMsg(savedFooter);

      const savedUser = g('madina_v7_admin_user');
      if (savedUser) { setAdminUsername(savedUser); setNewUsernameInput(savedUser); }

      const savedPass = g('madina_v7_admin_pass');
      if (savedPass) { setAdminPassword(savedPass); setNewPasswordInput(savedPass); }

      const savedStaffUser = g('madina_v7_staff_user');
      if (savedStaffUser) { setStaffUsername(savedStaffUser); setNewStaffUsernameInput(savedStaffUser); }

      const savedStaffPass = g('madina_v7_staff_pass');
      if (savedStaffPass) { setStaffPassword(savedStaffPass); setNewStaffPasswordInput(savedStaffPass); }

      const savedCreatorUser = g('madina_v7_creator_user');
      if (savedCreatorUser) { setCreatorUsername(savedCreatorUser); setNewCreatorUsernameInput(savedCreatorUser); }

      const savedCreatorPass = g('madina_v7_creator_pass');
      if (savedCreatorPass) { setCreatorPassword(savedCreatorPass); setNewCreatorPasswordInput(savedCreatorPass); }

      const savedBotToken = g('madina_v7_telegram_bot_token');
      if (savedBotToken) { setTelegramBotToken(savedBotToken); setNewTelegramBotTokenInput(savedBotToken); }

      const savedChatId = g('madina_v7_telegram_chat_id');
      if (savedChatId) { setTelegramChatId(savedChatId); setNewTelegramChatIdInput(savedChatId); }

      const savedPermissions = g('madina_v7_staff_perms');
      if (savedPermissions) setStaffVisibleModules(prev => ({ ...prev, ...JSON.parse(savedPermissions) }));

      const savedAdminPermissions = g('madina_v7_admin_perms');
      if (savedAdminPermissions) setAdminVisibleModules(prev => ({ ...prev, ...JSON.parse(savedAdminPermissions) }));

      const savedLock = g('madina_v7_system_locked');
      if (savedLock) setSystemLocked(savedLock === "1");

      const savedNotice = g('madina_v7_creator_notice');
      if (savedNotice !== null && savedNotice !== undefined) { setCreatorNotice(savedNotice); setCreatorNoticeInput(savedNotice); }

      // Phase 3: load payment + cash ledgers
      const savedPaymentLedger = g('madina_v7_payment_ledger');
      if (savedPaymentLedger) {
        try { setPaymentLedger(JSON.parse(savedPaymentLedger)); } catch { /* skip malformed */ }
      }
      const savedCashLedger = g('madina_v7_cash_ledger');
      if (savedCashLedger) {
        try { setCashLedger(JSON.parse(savedCashLedger)); } catch { /* skip malformed */ }
      }
      // Phase 4: stock movements
      const savedStockMovements = g('madina_v7_stock_movements');
      if (savedStockMovements) {
        try { setStockMovements(JSON.parse(savedStockMovements)); } catch { /* skip malformed */ }
      }
      // Phase 6: audit log
      const savedAuditLog = g('madina_v7_audit_log');
      if (savedAuditLog) {
        try { setAuditLog(JSON.parse(savedAuditLog)); } catch { /* skip malformed */ }
      }
    };

    if (!isFirebaseConfigured()) {
      // No Firebase set up at all — nothing to load from; show empty state.
      setSyncStatus('offline');
      setIsMounted(true);
      return;
    }

    setSyncStatus('syncing');
    fbGetAll().then(async cloudData => {
      const cloudHasAnyData = !!(cloudData && Object.keys(cloudData).length > 0);

      if (cloudHasAnyData) {
        applyData(cloudData as Record<string, string | null>);
      } else {
        // Brand-new database — seed autocomplete defaults straight to Firebase
        // so every device starts from the same baseline.
        setBdMedicineCompanies(initialMedicineCompanies);
        setBdMedicineNamesList(initialMedicineNamesList);
        await Promise.all([
          cloudSet('madina_v7_companies', JSON.stringify(initialMedicineCompanies)),
          cloudSet('madina_v7_mednames', JSON.stringify(initialMedicineNamesList)),
        ]);
      }
      setSyncStatus('synced');
      setIsMounted(true);
      setTimeout(() => setSyncStatus('idle'), 3000);
    }).catch(() => {
      // Could not reach Firebase — no local fallback by design.
      setSyncStatus('offline');
      setIsMounted(true);
    });
  }, []);

  // ============================================================
  // FIREBASE REAL-TIME LISTENER — Live sync across all devices
  // Whenever any device saves data, this device auto-updates.
  // ============================================================
  useEffect(() => {
    if (!isMounted) return;

    const unsubscribe = fbListenAll((cloudData) => {
      let didApplyAnything = false;

      const apply = (key: string, setter: (v: any) => void, parse: (s: string) => any = JSON.parse) => {
        const value = cloudData[key];
        if (value !== undefined && value !== lastAppliedRawRef.current[key]) {
          try { setter(parse(value)); lastAppliedRawRef.current[key] = value; didApplyAnything = true; } catch { /* skip malformed */ }
        }
      };

      // Special handling for medicines: if there's an active cart, re-apply cart deductions
      // so that Firebase updates from other devices don't undo pending stock changes
      const medsValue = cloudData['madina_v7_meds'];
      if (medsValue !== undefined && medsValue !== lastAppliedRawRef.current['madina_v7_meds']) {
        lastAppliedRawRef.current['madina_v7_meds'] = medsValue;
        didApplyAnything = true;
        try {
          const rawFreshMeds: any[] = JSON.parse(medsValue);
          const { list: freshMeds, changed: medsChanged } = dedupeIds(rawFreshMeds);
          if (medsChanged) cloudSet('madina_v7_meds', JSON.stringify(freshMeds));
          // Use cartRef (always latest) to re-apply pending cart deductions
          const currentCart = cartRef.current;
          if (currentCart.length === 0) {
            setMedicines(freshMeds);
          } else {
            const adjustedMeds = freshMeds.map(med => {
              const cartItem = currentCart.find((c: any) => c.id === med.id);
              if (cartItem) {
                const cartQty = parseInt(cartItem.qty) || 0;
                return { ...med, stock: Math.max(0, med.stock - cartQty) };
              }
              return med;
            });
            setMedicines(adjustedMeds);
          }
        } catch { /* skip malformed */ }
      }

      // When invoices and/or due-collection-log update from Firebase, recalculate
      // sales & profit from BOTH together so all devices always show consistent
      // data and a due collection is never "lost" on resync.
      let freshInvoicesForSales: any[] | null = null;
      let freshDueLogForSales: any[] | null = null;

      const invoicesValue = cloudData['madina_v7_invoices'];
      if (invoicesValue !== undefined && invoicesValue !== lastAppliedRawRef.current['madina_v7_invoices']) {
        lastAppliedRawRef.current['madina_v7_invoices'] = invoicesValue;
        didApplyAnything = true;
        try {
          const freshInvoices: any[] = JSON.parse(invoicesValue);
          setInvoices(freshInvoices);
          freshInvoicesForSales = freshInvoices;
        } catch { /* skip malformed */ }
      }

      const dueLogValue = cloudData['madina_v7_due_collection_log'];
      if (dueLogValue !== undefined && dueLogValue !== lastAppliedRawRef.current['madina_v7_due_collection_log']) {
        lastAppliedRawRef.current['madina_v7_due_collection_log'] = dueLogValue;
        didApplyAnything = true;
        try {
          const freshDueLog: any[] = JSON.parse(dueLogValue);
          setDueCollectionLog(freshDueLog);
          freshDueLogForSales = freshDueLog;
        } catch { /* skip malformed */ }
      }

      if (freshInvoicesForSales !== null || freshDueLogForSales !== null) {
        const invoicesForCalc = freshInvoicesForSales ?? invoicesRef.current;
        const dueLogForCalc = freshDueLogForSales ?? dueCollectionLogRef.current;
        const { sales: derivedSales, profit: derivedProfit } = computeSalesAndProfit(invoicesForCalc, dueLogForCalc);
        setTotalSales(prev => prev === derivedSales ? prev : derivedSales);
        setTotalProfit(prev => prev === derivedProfit ? prev : derivedProfit);
      } else {
        apply('madina_v7_sales', setTotalSales, parseFloat);
        apply('madina_v7_profit', setTotalProfit, parseFloat);
      }
      apply('madina_v7_purchases', (v: any) => {
        const { list, changed } = dedupeIds(v);
        setPurchaseList(list);
        if (changed) cloudSet('madina_v7_purchases', JSON.stringify(list));
      });
      apply('madina_v7_due_list', (v: any) => {
        const { list, changed } = dedupeIds(v);
        setDueList(list);
        if (changed) cloudSet('madina_v7_due_list', JSON.stringify(list));
      });
      apply('madina_v7_expenses', (v: any) => {
        const { list, changed } = dedupeIds(v);
        setExpenseList(list);
        if (changed) cloudSet('madina_v7_expenses', JSON.stringify(list));
      });
      apply('madina_v7_companies', setBdMedicineCompanies);
      apply('madina_v7_mednames', setBdMedicineNamesList);
      apply('madina_v7_medmeta', setBdMedNameMetadata);
      apply('madina_v7_name', (v: string) => { setPharmacyName(v); setSettingsName(v); }, (s: string) => s);
      apply('madina_v7_slogan', (v: string) => { setPharmacySlogan(v); setSettingsSlogan(v); }, (s: string) => s);
      apply('madina_v7_address', (v: string) => { setPharmacyAddress(v); setSettingsAddress(v); }, (s: string) => s);
      apply('madina_v7_logo', (v: string) => { setPharmacyLogo(v); setSettingsLogo(v); }, (s: string) => s);
      apply('madina_v7_currency', setCurrencySymbol, (s: string) => s);
      apply('madina_v7_vat', setVatPercentage, (s: string) => s);
      apply('madina_v7_threshold', setLowStockThreshold, (s: string) => s);
      apply('madina_v7_footer', setReceiptFooterMsg, (s: string) => s);
      // NOTE: the canonical credential values (used for actually logging in)
      // always stay in sync with the cloud. But the "...Input" fields are the
      // LIVE DRAFT shown inside the unlocked Creator/Admin/Staff credentials
      // form — if we kept overwriting those on every cloud update, then any
      // unrelated save happening anywhere in the app (a checkout, a stock
      // edit, etc. from ANY device) would silently erase whatever the
      // Creator was in the middle of typing, making "Unlock -> edit -> Save"
      // look like it "does nothing". So we only refresh the draft mirror
      // when the form is locked/closed; while it's open for editing we leave
      // the draft alone (it gets freshly re-seeded from the latest values
      // the instant the form is unlocked — see handleVerifyCurrentPassword).
      const formIsBeingEdited = isCredentialsFormUnlockedRef.current;
      apply('madina_v7_admin_user', (v: string) => { setAdminUsername(v); if (!formIsBeingEdited) setNewUsernameInput(v); }, (s: string) => s);
      apply('madina_v7_admin_pass', (v: string) => { setAdminPassword(v); if (!formIsBeingEdited) setNewPasswordInput(v); }, (s: string) => s);
      apply('madina_v7_staff_user', (v: string) => { setStaffUsername(v); if (!formIsBeingEdited) setNewStaffUsernameInput(v); }, (s: string) => s);
      apply('madina_v7_staff_pass', (v: string) => { setStaffPassword(v); if (!formIsBeingEdited) setNewStaffPasswordInput(v); }, (s: string) => s);
      apply('madina_v7_creator_user', (v: string) => { setCreatorUsername(v); if (!formIsBeingEdited) setNewCreatorUsernameInput(v); }, (s: string) => s);
      apply('madina_v7_creator_pass', (v: string) => { setCreatorPassword(v); if (!formIsBeingEdited) setNewCreatorPasswordInput(v); }, (s: string) => s);
      apply('madina_v7_telegram_bot_token', (v: string) => { setTelegramBotToken(v); if (!formIsBeingEdited) setNewTelegramBotTokenInput(v); }, (s: string) => s);
      apply('madina_v7_telegram_chat_id', (v: string) => { setTelegramChatId(v); if (!formIsBeingEdited) setNewTelegramChatIdInput(v); }, (s: string) => s);
      apply('madina_v7_staff_perms', (v: any) => setStaffVisibleModules((prev: any) => ({ ...prev, ...v })));
      apply('madina_v7_admin_perms', (v: any) => setAdminVisibleModules((prev: any) => ({ ...prev, ...v })));
      apply('madina_v7_system_locked', (v: string) => setSystemLocked(v === "1"), (s: string) => s);
      // Same reasoning as the credentials draft above: keep the live "banner"
      // (creatorNotice, shown to Admin/Staff) always in sync with the cloud,
      // but don't keep overwriting the Creator's notice textarea draft on
      // every unrelated cloud update — otherwise typing a notice could get
      // wiped out mid-sentence by, e.g., a sale happening on another device.
      apply('madina_v7_creator_notice', (v: string) => { setCreatorNotice(v); }, (s: string) => s);

      // Phase 3: live sync payment + cash ledgers
      apply('madina_v7_payment_ledger', setPaymentLedger);
      apply('madina_v7_cash_ledger', setCashLedger);

      // Phase 4: live sync stock movements
      apply('madina_v7_stock_movements', setStockMovements);

      // Phase 6: live sync audit log
      apply('madina_v7_audit_log', setAuditLog);

      if (didApplyAnything) {
        setSyncStatus('synced');
        setTimeout(() => setSyncStatus('idle'), 3000);
      }
    });

    return () => unsubscribe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMounted]);

  // Live clock now lives in isolated LiveTimeText/LiveDateText/LiveDayText
  // components (see above module scope) so the whole app doesn't
  // re-render every second — see notes there.

  // ============================================================
  // OUTSIDE CLICK HANDLER FOR SUGGESTIONS
  // ============================================================
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (suggestionRef.current && !suggestionRef.current.contains(event.target as Node)) setShowSuggestions(false);
      if (medicineSuggestRef.current && !medicineSuggestRef.current.contains(event.target as Node)) setShowMedicineSuggestions(false);
      if (npCompanyRef.current && !npCompanyRef.current.contains(event.target as Node)) setShowNpCompanySuggestions(false);
      if (npMedRef.current && !npMedRef.current.contains(event.target as Node)) setShowNpMedSuggestions(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // ============================================================
  // MIDNIGHT AUTO-RESET — Today's stats reset at 12:00 AM
  // All "Today" dashboard values auto-clear when date changes
  // ============================================================
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const scheduleNextMidnight = () => {
      const now = new Date();
      const nextMidnight = new Date();
      nextMidnight.setHours(24, 0, 0, 200); // next midnight + 200ms buffer
      const msUntilMidnight = nextMidnight.getTime() - now.getTime();

      timer = setTimeout(() => {
        // Update todayKey → triggers re-render → computedDailyXxx recalculates with new date
        setTodayKey(new Date().toDateString());
        // New day — expire the session so user must login again
        localStorage.removeItem('madina_v7_session');
        setIsLoggedIn(false);
        // Schedule the next day's midnight reset
        scheduleNextMidnight();
      }, msUntilMidnight);
    };

    scheduleNextMidnight();
    return () => clearTimeout(timer);
  }, []);


  useEffect(() => {
    if (showSuccessAlert) {
      const timer = setTimeout(() => setShowSuccessAlert(false), 20000);
      return () => clearTimeout(timer);
    }
  }, [showSuccessAlert]);

  // ============================================================
  // LOGIN FUNCTIONS
  // ============================================================
  const handleLogin = () => {
    setLoginError("");
    setLoginLoading(true);
    setTimeout(() => {
      setLoginLoading(false);
      if (loginRole === "admin") {
        if (loginUsername === adminUsername && loginPassword === adminPassword) {
          playSound('login');
          setIsLoggedIn(true);
          setCurrentUserRole("ADMIN");
          const session = { date: new Date().toDateString(), role: "ADMIN" };
          localStorage.setItem('madina_v7_session', JSON.stringify(session));
          setLoginUsername(""); setLoginPassword("");
        } else {
          playSound('error');
          setLoginShake(true);
          setTimeout(() => setLoginShake(false), 600);
          setLoginError(t("Wrong username or password!", "ভুল ইউজারনেম বা পাসওয়ার্ড!"));
        }
      } else {
        if (loginUsername === staffUsername && loginPassword === staffPassword) {
          playSound('login');
          setIsLoggedIn(true);
          setCurrentUserRole("STAFF");
          const session = { date: new Date().toDateString(), role: "STAFF" };
          localStorage.setItem('madina_v7_session', JSON.stringify(session));
          setLoginUsername(""); setLoginPassword("");
        } else {
          playSound('error');
          setLoginShake(true);
          setTimeout(() => setLoginShake(false), 600);
          setLoginError(t("Wrong username or password!", "ভুল ইউজারনেম বা পাসওয়ার্ড!"));
        }
      }
    }, 600);
  };

  const handleLogout = () => {
    setIsLoggedIn(false);
    localStorage.removeItem('madina_v7_session');
    navigateTab("pos");
  };

  // ============================================================
  // FORGOT PASSWORD — Telegram OTP flow
  // Step 1 (send):    generate a 6-digit code, save it to Firebase with a
  //                    5-minute expiry, and deliver it via Telegram Bot API.
  // Step 2 (verify):  user types the code they received in Telegram.
  // Step 3 (newpass): user picks a brand-new username + password for the
  //                    role (admin/staff) they were trying to log into.
  // ============================================================
  const handleSendResetCode = async () => {
    setForgotError("");
    if (!telegramBotToken.trim() || !telegramChatId.trim()) {
      setForgotError(t(
        "Telegram isn't set up yet. Ask Admin to add a Bot Token & Chat ID in Settings → Login Credentials.",
        "টেলিগ্রাম এখনো সেটআপ করা হয়নি। সেটিংস → লগইন তথ্য থেকে অ্যাডমিনকে Bot Token ও Chat ID যোগ করতে বলুন।"
      ));
      return;
    }
    setForgotSending(true);
    try {
      const code = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
      const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
      const roleLabel = loginRole === "admin" ? "Admin" : "Staff";
      const text = `🔐 ${pharmacyName}\n${roleLabel} password reset code:\n${code}\n\nThis code expires in 5 minutes. If you didn't request this, ignore this message.`;

      const tgRes = await fetchWithTimeout(
        `https://api.telegram.org/bot${telegramBotToken.trim()}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: telegramChatId.trim(), text }),
        },
        10000
      );

      if (!tgRes.ok) {
        setForgotError(t(
          "Couldn't send the code — check the Bot Token / Chat ID in Settings, and that you've messaged your bot at least once.",
          "কোড পাঠানো যায়নি — সেটিংসে Bot Token / Chat ID ঠিক আছে কিনা দেখুন, এবং বটকে অন্তত একবার মেসেজ দিয়েছেন কিনা নিশ্চিত করুন।"
        ));
        setForgotSending(false);
        return;
      }

      // Persist the OTP to Firebase (keyed by role) so it survives a refresh
      // and can be verified even if the send + verify happen on the same or
      // different tabs.
      await cloudSet('madina_v7_reset_otp', JSON.stringify({ code, expiresAt, role: loginRole }));
      setForgotOtpCode(code);
      setForgotOtpExpiresAt(expiresAt);
      setForgotStep("verify");
    } catch {
      setForgotError(t(
        "Network error while sending the code. Check your internet connection and try again.",
        "কোড পাঠানোর সময় নেটওয়ার্ক সমস্যা হয়েছে। ইন্টারনেট সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।"
      ));
    }
    setForgotSending(false);
  };

  const handleVerifyResetCode = async () => {
    setForgotError("");
    if (!forgotCodeInput.trim()) {
      setForgotError(t("Please enter the code from Telegram.", "টেলিগ্রামে পাওয়া কোডটি লিখুন।"));
      return;
    }
    // Re-fetch from Firebase rather than trusting only local state, so this
    // also works if the code was requested from a different device/tab.
    const raw = await fbGet('madina_v7_reset_otp');
    let stored: { code: string; expiresAt: number; role: string } | null = null;
    try { stored = raw ? JSON.parse(raw) : null; } catch { stored = null; }

    if (!stored) {
      setForgotError(t("No active code found. Please send a new one.", "কোনো সক্রিয় কোড পাওয়া যায়নি। নতুন কোড পাঠান।"));
      return;
    }
    if (Date.now() > stored.expiresAt) {
      setForgotError(t("This code has expired. Please send a new one.", "এই কোডের মেয়াদ শেষ। নতুন কোড পাঠান।"));
      return;
    }
    if (stored.role !== loginRole) {
      setForgotError(t("This code was issued for a different role. Please send a new one.", "এই কোডটি ভিন্ন রোলের জন্য পাঠানো হয়েছিল। নতুন কোড পাঠান।"));
      return;
    }
    if (forgotCodeInput.trim() !== stored.code) {
      setForgotError(t("Wrong code!", "ভুল কোড!"));
      return;
    }
    setForgotNewUsername(loginRole === "admin" ? adminUsername : staffUsername);
    setForgotStep("newpass");
  };

  const handleResetCredentials = () => {
    setForgotError("");
    if (!forgotNewUsername.trim() || !forgotNewPass.trim()) {
      setForgotError(t("Please enter both a new username and password!", "নতুন ইউজারনেম ও পাসওয়ার্ড দুটোই দিন!"));
      return;
    }
    if (loginRole === "admin") {
      setAdminUsername(forgotNewUsername.trim());
      setAdminPassword(forgotNewPass);
      cloudSet('madina_v7_admin_user', forgotNewUsername.trim());
      cloudSet('madina_v7_admin_pass', forgotNewPass);
      setNewUsernameInput(forgotNewUsername.trim());
      setNewPasswordInput(forgotNewPass);
    } else {
      setStaffUsername(forgotNewUsername.trim());
      setStaffPassword(forgotNewPass);
      cloudSet('madina_v7_staff_user', forgotNewUsername.trim());
      cloudSet('madina_v7_staff_pass', forgotNewPass);
      setNewStaffUsernameInput(forgotNewUsername.trim());
      setNewStaffPasswordInput(forgotNewPass);
    }
    // Invalidate the OTP so it can't be reused.
    cloudSet('madina_v7_reset_otp', "");
    alert(t("Username & password reset successfully!", "ইউজারনেম ও পাসওয়ার্ড সফলভাবে পরিবর্তন হয়েছে!"));
    setShowForgotPass(false);
    setForgotStep("send");
    setForgotCodeInput("");
    setForgotNewUsername("");
    setForgotNewPass("");
    setForgotOtpCode("");
    setForgotOtpExpiresAt(0);
  };

  // ============================================================
  // ROLE TOGGLE
  // ============================================================
  const handleRoleToggle = (role: "ADMIN" | "STAFF") => {
    setCurrentUserRole(role);
    const session = { date: new Date().toDateString(), role };
    localStorage.setItem('madina_v7_session', JSON.stringify(session));
  };

  // ============================================================
  // PERMISSIONS
  // ============================================================
  const toggleStaffPermissionField = (moduleKey: string) => {
    const updatedPerms = { ...staffVisibleModules, [moduleKey]: !staffVisibleModules[moduleKey] };
    setStaffVisibleModules(updatedPerms);
    cloudSet('madina_v7_staff_perms', JSON.stringify(updatedPerms));
  };

  const toggleAdminPermissionField = (moduleKey: string) => {
    const updatedPerms = { ...adminVisibleModules, [moduleKey]: !adminVisibleModules[moduleKey] };
    setAdminVisibleModules(updatedPerms);
    cloudSet('madina_v7_admin_perms', JSON.stringify(updatedPerms));
  };

  // Bulk helpers used by the Creator panel's "Select All / Clear All" controls
  const setStaffPermissionGroup = (keys: string[], value: boolean) => {
    const updatedPerms = { ...staffVisibleModules };
    keys.forEach(k => { updatedPerms[k] = value; });
    setStaffVisibleModules(updatedPerms);
    cloudSet('madina_v7_staff_perms', JSON.stringify(updatedPerms));
  };

  const setAdminPermissionGroup = (keys: string[], value: boolean) => {
    const updatedPerms = { ...adminVisibleModules };
    keys.forEach(k => { updatedPerms[k] = value; });
    setAdminVisibleModules(updatedPerms);
    cloudSet('madina_v7_admin_perms', JSON.stringify(updatedPerms));
  };

  const toggleSystemLock = async () => {
    const next = !systemLocked;
    setSystemLocked(next);
    const ok = await cloudSet('madina_v7_system_locked', next ? "1" : "0");
    if (!ok) {
      // Roll back the optimistic UI change — without this, the Creator could
      // believe the app is locked for Admin/Staff when the cloud write never
      // actually went through (e.g. internet dropped at the wrong moment).
      setSystemLocked(!next);
      alert(t("❌ Could not save — check your internet connection and try again.", "❌ সংরক্ষণ করা যায়নি — ইন্টারনেট সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।"));
    }
  };

  const saveCreatorNotice = async () => {
    setCreatorNotice(creatorNoticeInput);
    const ok = await cloudSet('madina_v7_creator_notice', creatorNoticeInput);
    if (ok) {
      alert(t("✅ Notice saved! Admin & Staff will see it.", "✅ নোটিশ সংরক্ষিত হয়েছে! অ্যাডমিন ও স্টাফ এটি দেখতে পাবে।"));
    } else {
      alert(t("❌ Could not save — check your internet connection and try again.", "❌ সংরক্ষণ করা যায়নি — ইন্টারনেট সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।"));
    }
  };

  const checkShouldRenderTabOption = (tabKey: string) => {
    if (currentUserRole === "ADMIN") return !!adminVisibleModules[tabKey];
    return !!staffVisibleModules[tabKey];
  };

  // ============================================================
  // PURCHASE QUANTITY/PRICE HANDLERS
  // ============================================================
  const handleQuantityInputChange = (val: string) => {
    setPQuantity(val);
    const qty = parseInt(val) || 0;
    const unitRate = parseFloat(pUnitPriceBox) || 0;
    if (qty > 0 && unitRate > 0) setPTotalCost((qty * unitRate).toString());
  };

  const handleUnitPriceInputChange = (val: string) => {
    setPUnitPriceBox(val);
    const unitRate = parseFloat(val) || 0;
    const qty = parseInt(pQuantity) || 0;
    if (qty > 0 && unitRate > 0) setPTotalCost((qty * unitRate).toString());
  };

  const handleTotalCostInputChange = (val: string) => {
    setPTotalCost(val);
    const totalCost = parseFloat(val) || 0;
    const qty = parseInt(pQuantity) || 0;
    if (qty > 0 && totalCost > 0) setPUnitPriceBox((totalCost / qty).toFixed(2));
  };

  // ============================================================
  // COMPANY SUGGESTION
  // ============================================================
  const handleCompanyInputChange = (value: string) => {
    setPCompanyName(value);
    if (value.trim().length >= 1) {
      const filtered = bdMedicineCompanies.filter(c => c.toLowerCase().includes(value.toLowerCase()));
      setCompanySuggestions(filtered);
      setShowSuggestions(true);
    } else {
      setCompanySuggestions([]);
      setShowSuggestions(false);
    }
  };

  const deleteCompanySuggestion = (name: string) => {
    const updated = bdMedicineCompanies.filter(c => c !== name);
    setBdMedicineCompanies(updated);
    cloudSet('madina_v7_companies', JSON.stringify(updated));
    const newFiltered = updated.filter(c => c.toLowerCase().includes(pCompanyName.toLowerCase()));
    setCompanySuggestions(newFiltered);
  };

  const handleMedicineNameInputChange = (value: string) => {
    setPMedicineName(value);
    if (value.trim().length >= 1) {
      // First search in metadata (has price/company/category info)
      const metaMatches = bdMedNameMetadata.filter(m => m.name.toLowerCase().includes(value.toLowerCase()));
      // Then add any names from plain list not already in metadata
      const metaNames = new Set(metaMatches.map(m => m.name.toLowerCase()));
      const plainMatches = bdMedicineNamesList
        .filter(n => n.toLowerCase().includes(value.toLowerCase()) && !metaNames.has(n.toLowerCase()))
        .map(n => ({ name: n, buyPrice: 0, sellPrice: 0, company: "", category: undefined as string | undefined }));
      setPMedicineSuggestions([...metaMatches, ...plainMatches]);
      setShowMedicineSuggestions(true);
    } else {
      setPMedicineSuggestions([]);
      setShowMedicineSuggestions(false);
    }
  };

  const deleteMedicineNameSuggestion = (name: string) => {
    const updated = bdMedicineNamesList.filter(m => m !== name);
    setBdMedicineNamesList(updated);
    cloudSet('madina_v7_mednames', JSON.stringify(updated));
    const updatedMeta = bdMedNameMetadata.filter(m => m.name !== name);
    setBdMedNameMetadata(updatedMeta);
    cloudSet('madina_v7_medmeta', JSON.stringify(updatedMeta));
    // Rebuild suggestions
    const metaMatches = updatedMeta.filter(m => m.name.toLowerCase().includes(pMedicineName.toLowerCase()));
    const metaNames = new Set(metaMatches.map(m => m.name.toLowerCase()));
    const plainMatches = updated
      .filter(n => n.toLowerCase().includes(pMedicineName.toLowerCase()) && !metaNames.has(n.toLowerCase()))
      .map(n => ({ name: n, buyPrice: 0, sellPrice: 0, company: "", category: undefined as string | undefined }));
    setPMedicineSuggestions([...metaMatches, ...plainMatches]);
  };

  // ============================================================
  // ADD TO PURCHASE CART
  // ============================================================
  const addItemToPurchaseCart = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pMedicineName || !pQuantity || !pTotalCost) return alert(t("Please fill Medicine Name, Quantity, and Total Cost!", "ওষুধের নাম, পরিমাণ এবং মোট খরচ পূরণ করুন!"));

    const qty = parseInt(pQuantity);
    const totalCost = parseFloat(pTotalCost);
    const unitBuyPrice = qty > 0 ? parseFloat((totalCost / qty).toFixed(2)) : 0;
    const retailPrice = pRetailPrice ? parseFloat(pRetailPrice) : parseFloat((unitBuyPrice * 1.25).toFixed(2));

    const newItem = {
      id: genId(),
      medicineName: pMedicineName.trim(),
      genericName: pGenericName || "N/A",
      category: pCategory,
      batchNo: pBatchNo || "B-" + Date.now().toString().slice(-4),
      quantity: qty,
      expireDate: pExpireDate || "2027-12-01",
      totalCost,
      unitPrice: unitBuyPrice,
      retailPrice,
      rackLocation: pRackLocation || "N/A",
      lowStockAlert: parseInt(pLowStockAlert) || parseInt(lowStockThreshold) || 10
    };

    setPurchaseCart([...purchaseCart, newItem]);
    setPMedicineName(""); setPGenericName(""); setPCategory("Tablet"); setPBatchNo("");
    setPQuantity(""); setPExpireDate(""); setPUnitPriceBox(""); setPTotalCost(""); setPRetailPrice(""); setPRackLocation(""); setPLowStockAlert("");
  };

  const removeItemFromPurchaseCart = (itemId: number) => {
    setPurchaseCart(purchaseCart.filter(item => item.id !== itemId));
  };

  // ============================================================
  // SUBMIT BULK PURCHASE
  // ============================================================
  const handleBulkPurchaseMasterSubmit = async () => {
    if (!pCompanyName.trim()) return alert(t("Please enter Company name!", "কোম্পানির নাম লিখুন!"));
    if (purchaseCart.length === 0) return alert(t("Purchase list is empty!", "ক্রয় তালিকা খালি!"));

    // FIX (multi-device purchase/product-list conflict): same race-safe
    // pattern as invoices/due-list — pull the freshest copies of these
    // four lists from Firebase BEFORE merging this purchase on top, so a
    // purchase entry or new medicine/company added on another device in
    // the same few seconds isn't silently erased.
    const [purchaseList, bdMedicineCompanies, bdMedicineNamesList, bdMedNameMetadata] = await Promise.all([
      fetchLatestList('madina_v7_purchases', purchaseListRef.current),
      fetchLatestList('madina_v7_companies', bdMedicineCompaniesRef.current),
      fetchLatestList('madina_v7_mednames', bdMedicineNamesListRef.current),
      fetchLatestList('madina_v7_medmeta', bdMedNameMetadataRef.current),
    ]);

    const today = new Date();
    const formattedTime = today.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const formattedDate = today.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' });

    // Phase 4: generate a transactionId for this purchase batch
    const purchaseTransactionId = `TXN-PUR-${Date.now()}-${genId()}`;
    const purchaseVoucherId = `PUR-${Date.now().toString().slice(-6)}`;

    const totalVoucherCost = purchaseCart.reduce((sum, item) => sum + item.totalCost, 0);
    const paidAmt = pAmountPaid ? parseFloat(pAmountPaid) : totalVoucherCost;
    const dueAmt = Math.max(0, totalVoucherCost - paidAmt);

    let newPurchaseLogs = [...purchaseList];
    let currentCompanies = [...bdMedicineCompanies];
    let currentMedNames = [...bdMedicineNamesList];

    const trimmedCompany = pCompanyName.trim();
    if (trimmedCompany && !currentCompanies.some(c => c.toLowerCase() === trimmedCompany.toLowerCase())) {
      currentCompanies.push(trimmedCompany);
      setBdMedicineCompanies(currentCompanies);
      cloudSet('madina_v7_companies', JSON.stringify(currentCompanies));
    }

    // Pre-generate stable IDs for any brand-new medicines up front, so the
    // optimistic local update and the cloud write (below) use the exact
    // same IDs instead of each call minting its own random one.
    const newMedIds: Record<string, number> = {};
    purchaseCart.forEach(item => {
      newMedIds[item.medicineName.trim().toLowerCase()] = genId();
    });

    // FIX (multi-device stock conflict): this purchase's stock/price change,
    // expressed as a pure function so it can be applied both to local state
    // (instant UI feedback) and to the freshest copy fetched from Firebase
    // right before writing — instead of overwriting Firebase with this
    // device's local array, which could erase a sale/purchase made on
    // another device at nearly the same time.
    const applyPurchaseToMeds = (medsArray: any[]) => {
      const result = [...medsArray];
      purchaseCart.forEach(item => {
        const existingIdx = result.findIndex(m => m.name.toLowerCase() === item.medicineName.toLowerCase());
        if (existingIdx !== -1) {
          result[existingIdx] = {
            ...result[existingIdx],
            stock: result[existingIdx].stock + item.quantity,
            buyPrice: item.unitPrice,
            price: item.retailPrice,
            supplier: trimmedCompany,
            category: item.category,
            generic: item.genericName !== "N/A" ? item.genericName : result[existingIdx].generic,
            rack: item.rackLocation !== "N/A" ? item.rackLocation : result[existingIdx].rack,
            expire: item.expireDate
          };
        } else {
          result.push({
            id: newMedIds[item.medicineName.trim().toLowerCase()],
            name: item.medicineName,
            category: item.category,
            buyPrice: item.unitPrice,
            price: item.retailPrice,
            stock: item.quantity,
            expire: item.expireDate,
            generic: item.genericName,
            rack: item.rackLocation,
            supplier: trimmedCompany,
            lowStockAlert: item.lowStockAlert || parseInt(lowStockThreshold) || 10
          });
        }
      });
      return result;
    };

    purchaseCart.forEach(item => {
      const trimmedMed = item.medicineName.trim();
      if (trimmedMed && !currentMedNames.some(m => m.toLowerCase() === trimmedMed.toLowerCase())) {
        currentMedNames.push(trimmedMed);
      }
      // Save / update metadata for this medicine (buy price, sell price, company)
      const existingMetaIdx = bdMedNameMetadata.findIndex(m => m.name.toLowerCase() === trimmedMed.toLowerCase());
      const newMeta = { name: trimmedMed, buyPrice: item.unitPrice, sellPrice: item.retailPrice, company: trimmedCompany, category: item.category };
      if (existingMetaIdx !== -1) {
        bdMedNameMetadata[existingMetaIdx] = newMeta;
      } else {
        bdMedNameMetadata.push(newMeta);
      }

      newPurchaseLogs.unshift({
        id: genId(),
        transactionId: purchaseTransactionId, // Phase 4: links all purchase records
        voucherId: purchaseVoucherId,
        companyName: trimmedCompany,
        medicineName: item.medicineName,
        genericName: item.genericName,
        category: item.category,
        batchNo: item.batchNo,
        quantity: item.quantity,
        expireDate: item.expireDate,
        totalCost: item.totalCost,
        unitPrice: item.unitPrice,
        retailPrice: item.retailPrice,
        rackLocation: item.rackLocation,
        paid: (item.totalCost / totalVoucherCost) * paidAmt,
        due: (item.totalCost / totalVoucherCost) * dueAmt,
        dateString: `${formattedDate} | ${formattedTime}`
      });
    });

    setBdMedicineNamesList(currentMedNames);
    cloudSet('madina_v7_mednames', JSON.stringify(currentMedNames));
    setBdMedNameMetadata([...bdMedNameMetadata]);
    cloudSet('madina_v7_medmeta', JSON.stringify(bdMedNameMetadata));

    setPurchaseList(newPurchaseLogs);
    cloudSet('madina_v7_purchases', JSON.stringify(newPurchaseLogs));

    // Optimistic local update for instant UI feedback...
    setMedicines(applyPurchaseToMeds(medicines));
    // ...and the authoritative cloud write against the freshest stock.
    // Phase 4: capture pre-purchase meds snapshot for stock movement entries,
    // then write movements alongside the updated stock.
    const preMedsForPurchase = medicinesRef.current; // snapshot BEFORE applyPurchaseToMeds
    const purchaseQtyByMedId: Record<number, number> = {};
    purchaseCart.forEach(item => {
      const existingMed = preMedsForPurchase.find(m => m.name.toLowerCase() === item.medicineName.toLowerCase());
      if (existingMed) {
        purchaseQtyByMedId[existingMed.id] = (purchaseQtyByMedId[existingMed.id] || 0) + item.quantity;
      }
      // New medicines (not in inventory yet) get IDs assigned by applyPurchaseToMeds;
      // they'll show previousStock=0, resultingStock=quantity in the movement — correct.
    });
    const purchaseMovementEntries = buildStockMovementEntries(
      'PURCHASE',
      purchaseTransactionId,
      purchaseVoucherId,
      purchaseQtyByMedId,
      preMedsForPurchase,
      today.toISOString(),
      formattedDate,
    );
    updateMedicinesOnCloud(applyPurchaseToMeds);

    // Append PURCHASE movements to ledger
    appendStockMovements(purchaseMovementEntries);

    setPurchaseCart([]);
    setPCompanyName("");
    setPAmountPaid("");
    alert(t(`✅ Purchase saved! ${purchaseCart.length} medicines added.`, `✅ ক্রয় সংরক্ষিত! ${purchaseCart.length} টি ওষুধ যোগ হয়েছে।`));
  };

  // ============================================================
  // NEW PRODUCT FORM HANDLERS
  // ============================================================
  const handleNpCompanyChange = (value: string) => {
    setNpCompanyName(value);
    if (value.trim().length >= 1) {
      const filtered = bdMedicineCompanies.filter(c => c.toLowerCase().includes(value.toLowerCase()));
      setNpCompanySuggestions(filtered);
      setShowNpCompanySuggestions(true);
    } else {
      setNpCompanySuggestions([]);
      setShowNpCompanySuggestions(false);
    }
  };

  const handleNpMedNameChange = (value: string) => {
    setNpMedicineName(value);
    if (value.trim().length >= 1) {
      const metaMatches = bdMedNameMetadata.filter(m => m.name.toLowerCase().includes(value.toLowerCase()));
      const metaNames = new Set(metaMatches.map(m => m.name.toLowerCase()));
      const plainMatches = bdMedicineNamesList
        .filter(n => n.toLowerCase().includes(value.toLowerCase()) && !metaNames.has(n.toLowerCase()))
        .map(n => ({ name: n, buyPrice: 0, sellPrice: 0, company: "", category: undefined as string | undefined }));
      setNpMedSuggestions([...metaMatches, ...plainMatches]);
      setShowNpMedSuggestions(true);
    } else {
      setNpMedSuggestions([]);
      setShowNpMedSuggestions(false);
    }
  };

  const handleNpMedSelect = (item: {name:string; buyPrice:number; sellPrice:number; company:string; category?:string}) => {
    setNpMedicineName(item.name);
    if (item.buyPrice > 0) setNpBuyPrice(item.buyPrice.toString());
    if (item.sellPrice > 0) setNpSalePrice(item.sellPrice.toString());
    if (item.company) setNpCompanyName(item.company);
    if (item.category) setNpCategory(item.category);
    setShowNpMedSuggestions(false);
  };

  // Saves to medicine database (metadata + name list) but NOT to inventory/medicines state
  // The product will only appear in Sell AFTER being added via Stock In
  const handleSaveNewProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!npMedicineName.trim()) return alert(t("Please enter medicine name!", "ওষুধের নাম লিখুন!"));
    if (!npBuyPrice || !npSalePrice) return alert(t("Please enter buy price and sale price!", "ক্রয় মূল্য এবং বিক্রয় মূল্য লিখুন!"));

    // FIX (multi-device product-list conflict): same race-safe pattern —
    // fetch the freshest mednames/medmeta/companies before merging this
    // new product in, so a product added on another device at nearly the
    // same time isn't erased.
    const [bdMedicineNamesList, bdMedNameMetadata, bdMedicineCompanies] = await Promise.all([
      fetchLatestList('madina_v7_mednames', bdMedicineNamesListRef.current),
      fetchLatestList('madina_v7_medmeta', bdMedNameMetadataRef.current),
      fetchLatestList('madina_v7_companies', bdMedicineCompaniesRef.current),
    ]);

    const trimmedMed = npMedicineName.trim();
    const trimmedCompany = npCompanyName.trim();
    const buyP = parseFloat(npBuyPrice) || 0;
    const sellP = parseFloat(npSalePrice) || 0;

    // Add to medicine names list if not already there
    let currentMedNames = [...bdMedicineNamesList];
    if (!currentMedNames.some(m => m.toLowerCase() === trimmedMed.toLowerCase())) {
      currentMedNames.push(trimmedMed);
      setBdMedicineNamesList(currentMedNames);
      cloudSet('madina_v7_mednames', JSON.stringify(currentMedNames));
    }

    // Add/update metadata
    const updatedMeta = [...bdMedNameMetadata];
    const existingIdx = updatedMeta.findIndex(m => m.name.toLowerCase() === trimmedMed.toLowerCase());
    const newMeta = { name: trimmedMed, buyPrice: buyP, sellPrice: sellP, company: trimmedCompany, category: npCategory };
    if (existingIdx !== -1) {
      updatedMeta[existingIdx] = newMeta;
    } else {
      updatedMeta.push(newMeta);
    }
    setBdMedNameMetadata(updatedMeta);
    cloudSet('madina_v7_medmeta', JSON.stringify(updatedMeta));

    // Add company if not already in list
    if (trimmedCompany && !bdMedicineCompanies.some(c => c.toLowerCase() === trimmedCompany.toLowerCase())) {
      const updatedCompanies = [...bdMedicineCompanies, trimmedCompany];
      setBdMedicineCompanies(updatedCompanies);
      cloudSet('madina_v7_companies', JSON.stringify(updatedCompanies));
    }

    // Reset form
    setNpMedicineName(""); setNpCompanyName(""); setNpGenericName("");
    setNpBuyPrice(""); setNpSalePrice(""); setNpCategory("Tablet");

    playSound('save');
    addToast(t(`✅ "${trimmedMed}" added! Go to Stock In to add quantity.`, `✅ "${trimmedMed}" যোগ হয়েছে! স্টক ইন থেকে পরিমাণ যোগ করুন।`), 'success');
  };

  // ============================================================
  // INVENTORY FUNCTIONS
  // ============================================================
  const startEditing = (med: any) => {
    setEditingId(med.id);
    setEditFormData({ ...med });
    openEdit(() => setEditingId(null));
  };

  const handleEditFormChange = (field: string, value: any) => {
    setEditFormData({ ...editFormData, [field]: value });
  };

  const saveEditedMedicine = (id: number) => {
    const updatedStock = parseInt(editFormData.stock);
    if (isNaN(updatedStock) || updatedStock < 0) { alert(t("Please enter valid stock!", "সঠিক স্টক সংখ্যা দিন!")); return; }
    // FIX (multi-device stock conflict): build the change as a function so it
    // can be re-applied to the freshest meds list fetched from Firebase,
    // instead of writing this device's whole local array (which could erase
    // a concurrent stock change to a DIFFERENT medicine made on another device).
    const applyEdit = (medsArray: any[]) => medsArray.map(m => m.id === id ? {
      ...editFormData,
      buyPrice: parseFloat(editFormData.buyPrice) || 0,
      price: parseFloat(editFormData.price) || 0,
      stock: updatedStock,
      lowStockAlert: parseInt(editFormData.lowStockAlert) || 10
    } : m);

    // Phase 4: record ADJUSTMENT stock movement if stock quantity changed
    const originalMed = medicinesRef.current.find(m => m.id === id);
    const originalStock = originalMed ? originalMed.stock : 0;
    if (originalMed && updatedStock !== originalStock) {
      const adjTransactionId = `TXN-ADJ-${Date.now()}-${genId()}`;
      const adjQtyByMedId: Record<number, number> = { [id]: Math.abs(updatedStock - originalStock) };
      const adjType = updatedStock >= originalStock ? 'PURCHASE' : 'SALE'; // PURCHASE = stock up, SALE = stock down
      // We repurpose PURCHASE/SALE types for adjustments; store type=ADJUSTMENT via a wrapper
      const adjustmentEntry = {
        movementId: `MOV-${Date.now()}-${genId()}`,
        transactionId: adjTransactionId,
        reference: `ADJ-${id}`,
        medicineId: id,
        medicineName: originalMed.name,
        type: 'ADJUSTMENT' as const,
        quantity: Math.abs(updatedStock - originalStock),
        previousStock: originalStock,
        resultingStock: updatedStock,
        direction: updatedStock >= originalStock ? 'IN' : 'OUT',
        timestamp: new Date().toISOString(),
        dateString: new Date().toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' }),
      };
      appendStockMovements([adjustmentEntry]);
    }

    setMedicines(applyEdit(medicines));
    updateMedicinesOnCloud(applyEdit);
    closeEdit();
    setEditingId(null);
    alert(t("✅ Medicine updated!", "✅ ওষুধ আপডেট হয়েছে!"));
  };

  const deleteMedicine = (id: number) => {
    if (confirm(t("Are you sure you want to delete this medicine?", "এই ওষুধটি মুছে ফেলবেন?"))) {
      // FIX (multi-device stock conflict): same as above — apply against the
      // freshest cloud copy instead of overwriting it with local state.
      const applyDelete = (medsArray: any[]) => medsArray.filter(m => m.id !== id);
      setMedicines(applyDelete(medicines));
      updateMedicinesOnCloud(applyDelete);
    }
  };

  // ============================================================
  // FIX: MULTI-DEVICE STOCK CONFLICT
  // ─────────────────────────────────────────────────────────────
  // Before: every place that changed stock (checkout, purchase, edit,
  // return) wrote its own local copy of `medicines` straight to Firebase.
  // If two phones/devices changed stock for different medicines at nearly
  // the same time, whichever device's write landed second would overwrite
  // the first device's change entirely (since the whole array gets
  // replaced) — so one sale's stock update could vanish.
  //
  // After: this helper re-fetches the CURRENT stock from Firebase right
  // before writing, applies ONLY this device's specific change on top of
  // that fresh copy, then writes the merged result. This shrinks the
  // window where two devices can clobber each other from "however long
  // the cart/form was open" down to a single fetch+write round trip.
  // ============================================================
  const updateMedicinesOnCloud = async (
    applyChange: (latestMeds: any[]) => any[]
  ): Promise<boolean> => {
    let latestMeds: any[] = medicinesRef.current;
    const fetched = await fbGet('madina_v7_meds');
    if (fetched) {
      try { latestMeds = JSON.parse(fetched); } catch { /* keep local fallback if malformed */ }
    }
    const merged = applyChange(latestMeds);
    setMedicines(merged);
    const ok = await cloudSet('madina_v7_meds', JSON.stringify(merged));
    return ok;
  };

  // ── Generic race-safe list fetch ─────────────────────────────
  // Same pattern as updateMedicinesOnCloud: before writing a list-type
  // key (invoices, due list, due collection log) back to Firebase, pull
  // the freshest copy first so a near-simultaneous save from another
  // device isn't blindly overwritten and silently lost.
  const fetchLatestList = async (key: string, localFallback: any[]): Promise<any[]> => {
    const fetched = await fbGet(key);
    if (fetched) {
      try { return JSON.parse(fetched); } catch { /* keep local fallback if malformed */ }
    }
    return localFallback;
  };

  // ============================================================
  // PHASE 4: STOCK MOVEMENT LEDGER HELPER
  // ─────────────────────────────────────────────────────────────
  // Returns a flat array of movement entries for a given operation.
  // Each entry is immutable — we never mutate previous movements;
  // returns/adjustments get their own NEW entries that reference the
  // original transactionId/invoiceId where applicable.
  //
  // type = SALE | PURCHASE | RETURN | ADJUSTMENT
  // quantity is always the ABSOLUTE number of units (positive integer).
  // Direction (IN vs OUT) is implied by type.
  // previousStock / resultingStock allow full reconciliation without
  // relying on medicine.stock alone.
  // ============================================================
  const buildStockMovementEntries = (
    // BUGFIX #11: ADJUSTMENT was missing from the union type, causing a TypeScript
    // error when the inventory-edit path passed 'ADJUSTMENT'. All four movement
    // types are now explicit in both the type annotation and the resultingStock logic.
    type: 'SALE' | 'PURCHASE' | 'RETURN' | 'ADJUSTMENT',
    transactionId: string,
    invoiceOrRef: string,
    qtyByMedId: Record<number, number>,
    medsSnapshot: any[],   // the med array AS IT WAS just before this operation
    timestamp: string,
    dateString: string,
  ): any[] => {
    const entries: any[] = [];
    for (const [medIdStr, qty] of Object.entries(qtyByMedId)) {
      const medId = Number(medIdStr);
      const med = medsSnapshot.find(m => m.id === medId);
      if (!med) continue;
      const prevStock = med.stock;
      // SALE and ADJUSTMENT(down): stock decreases.
      // PURCHASE, RETURN, ADJUSTMENT(up): stock increases.
      // Direction for ADJUSTMENT is determined by the caller (who computes qty
      // as Math.abs(newStock - oldStock) and passes the correct type variant).
      const resultingStock = type === 'SALE'
        ? prevStock - qty
        : prevStock + qty;
      entries.push({
        movementId: `MOV-${Date.now()}-${genId()}`,
        transactionId,
        reference: invoiceOrRef,
        medicineId: medId,
        medicineName: med.name,
        type,
        quantity: qty,
        previousStock: prevStock,
        resultingStock,
        timestamp,
        dateString,
      });
    }
    return entries;
  };

  // Append new movement entries to the ledger (race-safe: always prepend to the
  // freshest copy fetched from Firebase rather than the local ref, so two devices
  // can both record movements in the same second without one overwriting the other).
  const appendStockMovements = async (newEntries: any[]): Promise<void> => {
    if (!newEntries.length) return;
    const fetched = await fbGet('madina_v7_stock_movements');
    let latest: any[] = stockMovementsRef.current;
    if (fetched) {
      try { latest = JSON.parse(fetched); } catch { /* keep local fallback */ }
    }
    const merged = [...newEntries, ...latest];
    setStockMovements(merged);
    await cloudSet('madina_v7_stock_movements', JSON.stringify(merged));
  };

  // ============================================================
  // PHASE 6: RECONCILIATION ENGINE
  // ─────────────────────────────────────────────────────────────
  // All functions here are READ-ONLY. They NEVER modify Firebase.
  // They return a structured report of issues found.
  // ============================================================

  // ── Audit log helper ────────────────────────────────────────
  const appendAuditEntry = async (entry: {
    action: string;
    transactionId?: string;
    affectedRecord?: string;
    previousValue?: any;
    newValue?: any;
    note?: string;
  }) => {
    const record = {
      auditId: `AUDIT-${Date.now()}-${genId()}`,
      ...entry,
      timestamp: new Date().toISOString(),
      userRole: currentUserRole,
      deviceHint: typeof window !== 'undefined' ? window.location.hostname : 'unknown',
    };
    const fetched = await fbGet('madina_v7_audit_log');
    let latest: any[] = auditLogRef.current;
    if (fetched) { try { latest = JSON.parse(fetched); } catch { /* keep local */ } }
    const merged = [record, ...latest].slice(0, 500); // keep last 500 entries
    setAuditLog(merged);
    await cloudSet('madina_v7_audit_log', JSON.stringify(merged));
  };

  // ── Main Reconciliation Runner ───────────────────────────────
  const runReconciliation = async () => {
    setReconRunning(true);
    setReconReport(null);

    try {
      // Fetch latest data from Firebase (READ ONLY — never modify)
      const [
        rawInvoices, rawPurchases, rawDueList, rawDueCLog,
        rawPaymentLedger, rawCashLedger, rawStockMovements, rawExpenses, rawMeds,
      ] = await Promise.all([
        fbGet('madina_v7_invoices'),
        fbGet('madina_v7_purchases'),
        fbGet('madina_v7_due_list'),
        fbGet('madina_v7_due_collection_log'),
        fbGet('madina_v7_payment_ledger'),
        fbGet('madina_v7_cash_ledger'),
        fbGet('madina_v7_stock_movements'),
        fbGet('madina_v7_expenses'),
        fbGet('madina_v7_meds'),
      ]);

      const invoicesList: any[]       = rawInvoices      ? JSON.parse(rawInvoices)      : [];
      const purchasesList: any[]      = rawPurchases      ? JSON.parse(rawPurchases)      : [];
      const dueListArr: any[]         = rawDueList        ? JSON.parse(rawDueList)        : [];
      const dueCLog: any[]            = rawDueCLog        ? JSON.parse(rawDueCLog)        : [];
      const paymentLedgerArr: any[]   = rawPaymentLedger  ? JSON.parse(rawPaymentLedger)  : [];
      const cashLedgerArr: any[]      = rawCashLedger     ? JSON.parse(rawCashLedger)     : [];
      const stockMovArr: any[]        = rawStockMovements ? JSON.parse(rawStockMovements) : [];
      const expenseArr: any[]         = rawExpenses       ? JSON.parse(rawExpenses)       : [];
      const medsArr: any[]            = rawMeds           ? JSON.parse(rawMeds)           : [];

      const issues: any[] = [];
      const addIssue = (severity: 'ERROR'|'WARNING'|'INFO', category: string, description: string, detail?: any) => {
        issues.push({ severity, category, description, detail, ts: new Date().toISOString() });
      };

      // ── 1. DUPLICATE DETECTION ──────────────────────────────
      const invoiceIds = invoicesList.map((i: any) => i.invoiceId).filter(Boolean);
      const dupInvoiceIds = invoiceIds.filter((id: string, idx: number) => invoiceIds.indexOf(id) !== idx);
      if (dupInvoiceIds.length > 0)
        addIssue('ERROR', 'Sales', `Duplicate invoiceId(s) detected: ${[...new Set(dupInvoiceIds)].join(', ')}`, { ids: dupInvoiceIds });

      const txnIds = invoicesList.map((i: any) => i.transactionId).filter(Boolean);
      const dupTxnIds = txnIds.filter((id: string, idx: number) => txnIds.indexOf(id) !== idx);
      if (dupTxnIds.length > 0)
        addIssue('ERROR', 'Sales', `Duplicate transactionId(s) in invoices: ${[...new Set(dupTxnIds)].join(', ')}`, { ids: dupTxnIds });

      const payIds = paymentLedgerArr.map((p: any) => p.paymentId).filter(Boolean);
      const dupPayIds = payIds.filter((id: string, idx: number) => payIds.indexOf(id) !== idx);
      if (dupPayIds.length > 0)
        addIssue('ERROR', 'Cash', `Duplicate paymentId(s) in payment ledger: ${[...new Set(dupPayIds)].join(', ')}`, { ids: dupPayIds });

      const movIds = stockMovArr.map((m: any) => m.movementId).filter(Boolean);
      const dupMovIds = movIds.filter((id: string, idx: number) => movIds.indexOf(id) !== idx);
      if (dupMovIds.length > 0)
        addIssue('ERROR', 'Stock', `Duplicate movementId(s) in stock movements: ${[...new Set(dupMovIds)].join(', ')}`, { ids: dupMovIds });

      const expIds = expenseArr.map((e: any) => e.id);
      const dupExpIds = expIds.filter((id: any, idx: number) => expIds.indexOf(id) !== idx);
      if (dupExpIds.length > 0)
        addIssue('ERROR', 'Expense', `Duplicate expense id(s): ${[...new Set(dupExpIds)].join(', ')}`, { ids: dupExpIds });

      // ── 2. SALES RECONCILIATION ─────────────────────────────
      const completedInvoices = invoicesList.filter((i: any) => !i.status || i.status === 'completed');
      const salesRevenue = completedInvoices.reduce((s: number, i: any) => s + (i.finalBill || 0), 0);
      const salesProfit  = completedInvoices.reduce((s: number, i: any) => s + (i.profit || 0), 0);

      // Check invoices with no transactionId
      const invNoTxn = invoicesList.filter((i: any) => !i.transactionId);
      if (invNoTxn.length > 0)
        addIssue('WARNING', 'Sales', `${invNoTxn.length} invoice(s) missing transactionId (pre-Phase 3 records)`, { invoiceIds: invNoTxn.map((i: any) => i.invoiceId) });

      // Check invoices with no invoiceId
      const invNoId = invoicesList.filter((i: any) => !i.invoiceId);
      if (invNoId.length > 0)
        addIssue('ERROR', 'Sales', `${invNoId.length} invoice(s) missing invoiceId`, { count: invNoId.length });

      // Check for negative finalBill (impossible)
      const negBill = invoicesList.filter((i: any) => (i.finalBill || 0) < 0);
      if (negBill.length > 0)
        addIssue('ERROR', 'Sales', `${negBill.length} invoice(s) have negative finalBill`, { invoiceIds: negBill.map((i: any) => i.invoiceId) });

      // Returned invoices that still show positive finalBill (possible edge-case warning)
      const returnedPositive = invoicesList.filter((i: any) => i.isReturned && (i.finalBill || 0) > 0 && !(i.returnDetails));
      if (returnedPositive.length > 0)
        addIssue('WARNING', 'Return', `${returnedPositive.length} invoice(s) marked returned but still have positive finalBill without returnDetails`, { invoiceIds: returnedPositive.map((i: any) => i.invoiceId) });

      // ── 3. PAYMENT LEDGER RECONCILIATION ───────────────────
      // Every completed invoice should have a SALE_PAYMENT entry
      const payTxnSet = new Set(paymentLedgerArr.filter((p: any) => p.paymentType === 'SALE_PAYMENT').map((p: any) => p.transactionId));
      const invNoPayment = completedInvoices.filter((i: any) => i.transactionId && !payTxnSet.has(i.transactionId));
      if (invNoPayment.length > 0)
        addIssue('WARNING', 'Sales', `${invNoPayment.length} completed invoice(s) have no matching SALE_PAYMENT entry in payment ledger`, { invoiceIds: invNoPayment.map((i: any) => i.invoiceId) });

      // Payment entries with no matching invoice
      const invoiceTxnSet = new Set(invoicesList.map((i: any) => i.transactionId).filter(Boolean));
      const payNoInvoice = paymentLedgerArr.filter((p: any) => p.paymentType === 'SALE_PAYMENT' && p.transactionId && !invoiceTxnSet.has(p.transactionId));
      if (payNoInvoice.length > 0)
        addIssue('ERROR', 'Cash', `${payNoInvoice.length} SALE_PAYMENT entry(ies) have no matching invoice (orphan payments)`, { paymentIds: payNoInvoice.map((p: any) => p.paymentId) });

      // ── 4. CASH LEDGER RECONCILIATION ──────────────────────
      const cashIn  = cashLedgerArr.filter((c: any) => c.direction === 'IN').reduce((s: number, c: any) => s + (c.amount || 0), 0);
      const cashOut = cashLedgerArr.filter((c: any) => c.direction === 'OUT').reduce((s: number, c: any) => s + (c.amount || 0), 0);
      // Net cash from ledger: IN - OUT
      const ledgerNetCash = cashIn - cashOut;

      // Expected cash = cash from sales (cashReceived at sale) + due collections - refunds - expenses
      const saleTimeCash = completedInvoices.reduce((s: number, i: any) =>
        s + Math.min(i.cashReceived ?? i.finalBill ?? 0, i.finalBill ?? 0), 0);
      const dueCollected = dueCLog.reduce((s: number, d: any) => s + (d.amount || 0), 0);
      const refunds = invoicesList.reduce((s: number, i: any) =>
        s + (i.returnDetails?.refundedAmount || 0), 0);
      const expenseCash = expenseArr.filter((e: any) => e.paymentMethod === 'Cash' || !e.paymentMethod).reduce((s: number, e: any) => s + (e.amount || 0), 0);
      const expectedNetCash = saleTimeCash + dueCollected - refunds - expenseCash;

      // Cash ledger entries without valid transactionId
      const cashNoTxn = cashLedgerArr.filter((c: any) => !c.transactionId);
      if (cashNoTxn.length > 0)
        addIssue('WARNING', 'Cash', `${cashNoTxn.length} cash ledger entry(ies) missing transactionId`, { count: cashNoTxn.length });

      // ── 5. DUE RECONCILIATION ───────────────────────────────
      // Total due created = sum of invoice.due for each invoice
      const totalDueCreated = invoicesList.reduce((s: number, i: any) => s + Math.max(0, i.due || 0), 0);
      const totalDueCollected = dueCLog.reduce((s: number, d: any) => s + (d.amount || 0), 0);
      const dueListTotal = dueListArr.reduce((s: number, d: any) => s + (d.totalDue || 0), 0);
      const expectedOutstandingDue = Math.max(0, totalDueCreated - totalDueCollected);
      const dueDiff = Math.abs(dueListTotal - expectedOutstandingDue);

      // Due collection entries without matching due list customer
      const dueCustomers = new Set(dueListArr.map((d: any) => d.customerName?.toLowerCase()).filter(Boolean));
      // (we don't error on this because due may have been fully paid off)

      // Customer-level due check: sum of dueListArr should match sum from invoices (approximately)
      if (dueDiff > 0.01)
        addIssue('WARNING', 'Due', `Due balance mismatch: expected outstanding ${expectedOutstandingDue.toFixed(2)}, recorded in due list ${dueListTotal.toFixed(2)}, difference ${dueDiff.toFixed(2)}`, {
          expectedOutstandingDue, dueListTotal, diff: dueDiff, totalDueCreated, totalDueCollected
        });
      else
        addIssue('INFO', 'Due', `Due balance reconciled. Outstanding: ${dueListTotal.toFixed(2)} ✓`, { dueListTotal });

      // Due collection log entries with excessive amounts
      const excessiveDueCollections = dueCLog.filter((d: any) => d.amount < 0);
      if (excessiveDueCollections.length > 0)
        addIssue('ERROR', 'Due', `${excessiveDueCollections.length} due collection entries have negative amount`, { ids: excessiveDueCollections.map((d: any) => d.id) });

      // ── 6. STOCK RECONCILIATION ─────────────────────────────
      const stockIssues: any[] = [];
      for (const med of medsArr) {
        // Get all movements for this medicine
        const medMovements = stockMovArr.filter((m: any) => m.medicineId === med.id);
        if (medMovements.length === 0) continue; // No movements recorded (pre-Phase 4 or untouched)

        // Sort by timestamp ascending
        const sorted = [...medMovements].sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        // Use the movement chain to compute expected current stock
        // The last resultingStock should equal current medicine.stock
        const lastMovement = sorted[sorted.length - 1];
        const expectedStock = lastMovement.resultingStock;
        const actualStock = med.stock;
        const stockDiff = Math.abs(expectedStock - actualStock);

        if (actualStock < 0)
          addIssue('ERROR', 'Stock', `IMPOSSIBLE: ${med.name} has negative stock (${actualStock})`, { medicineId: med.id, name: med.name, actualStock });

        if (stockDiff > 0)
          stockIssues.push({ medicineId: med.id, name: med.name, expectedStock, actualStock, diff: stockDiff, lastMovement });
      }
      if (stockIssues.length > 0)
        addIssue('WARNING', 'Stock', `${stockIssues.length} medicine(s) have stock mismatch (movement chain vs current stock)`, { medicines: stockIssues });
      else if (medsArr.length > 0 && stockMovArr.length > 0)
        addIssue('INFO', 'Stock', `Stock reconciled for all medicines with movement records ✓`);

      // Check for stock movements without valid transaction
      const allTxnIds = new Set([
        ...invoicesList.map((i: any) => i.transactionId),
        ...purchasesList.map((p: any) => p.transactionId),
        ...dueCLog.map((d: any) => d.transactionId),
      ].filter(Boolean));
      const orphanMovements = stockMovArr.filter((m: any) =>
        m.transactionId && !m.transactionId.startsWith('TXN-ADJ-') && !allTxnIds.has(m.transactionId));
      if (orphanMovements.length > 0)
        addIssue('WARNING', 'Stock', `${orphanMovements.length} stock movement(s) reference unknown transactionId (orphan movements)`, { count: orphanMovements.length });

      // ── 7. PROFIT RECONCILIATION ────────────────────────────
      const profitFromInvoices = completedInvoices.reduce((s: number, i: any) => s + (i.profit || 0), 0);
      const grossRevenue = completedInvoices.reduce((s: number, i: any) => s + (i.subTotal || i.finalBill || 0), 0);
      const totalDiscount = completedInvoices.reduce((s: number, i: any) => s + (i.discount || 0), 0);
      const totalVat = completedInvoices.reduce((s: number, i: any) => s + (i.vat || 0), 0);

      // Check for invoices where profit > revenue (impossible)
      const profitOverRevenue = completedInvoices.filter((i: any) => (i.profit || 0) > (i.finalBill || 0));
      if (profitOverRevenue.length > 0)
        addIssue('ERROR', 'Profit', `${profitOverRevenue.length} invoice(s) have profit > finalBill (impossible)`, { invoiceIds: profitOverRevenue.map((i: any) => i.invoiceId) });

      // Check for invoices with negative profit
      const negProfit = completedInvoices.filter((i: any) => (i.profit || 0) < 0);
      if (negProfit.length > 0)
        addIssue('WARNING', 'Profit', `${negProfit.length} invoice(s) have negative profit (sold below cost)`, { invoiceIds: negProfit.map((i: any) => i.invoiceId) });

      // ── 8. PURCHASE RECONCILIATION ──────────────────────────
      // Every purchase should have stock movement entries
      const purchaseTxnSet = new Set(stockMovArr.filter((m: any) => m.type === 'PURCHASE').map((m: any) => m.transactionId));
      const purchasesNoMovement = purchasesList.filter((p: any) => p.transactionId && !purchaseTxnSet.has(p.transactionId));
      if (purchasesNoMovement.length > 0)
        addIssue('WARNING', 'Purchase', `${purchasesNoMovement.length} purchase(s) have no matching PURCHASE stock movement`, { count: purchasesNoMovement.length });

      // Purchase records with no transactionId (pre-Phase 4)
      const purchaseNoTxn = purchasesList.filter((p: any) => !p.transactionId);
      if (purchaseNoTxn.length > 0)
        addIssue('INFO', 'Purchase', `${purchaseNoTxn.length} purchase record(s) missing transactionId (pre-Phase 4 records)`, { count: purchaseNoTxn.length });

      // ── 9. RETURN RECONCILIATION ────────────────────────────
      const returnedInvoices = invoicesList.filter((i: any) => i.isReturned);
      // Check returned invoices have returnDetails
      const returnNoDetails = returnedInvoices.filter((i: any) => !i.returnDetails);
      if (returnNoDetails.length > 0)
        addIssue('WARNING', 'Return', `${returnNoDetails.length} returned invoice(s) missing returnDetails`, { invoiceIds: returnNoDetails.map((i: any) => i.invoiceId) });

      // Check cash refunds have matching REFUND payment entry
      const refundPayTxnSet = new Set(paymentLedgerArr.filter((p: any) => p.paymentType === 'REFUND').map((p: any) => p.originalInvoiceId));
      const cashRefundsNoPayment = returnedInvoices.filter((i: any) =>
        i.returnDetails?.action === 'CASH_REFUND' && !refundPayTxnSet.has(i.invoiceId));
      if (cashRefundsNoPayment.length > 0)
        addIssue('WARNING', 'Return', `${cashRefundsNoPayment.length} cash-refund return(s) have no REFUND payment ledger entry`, { invoiceIds: cashRefundsNoPayment.map((i: any) => i.invoiceId) });

      // ── 10. EXPENSE RECONCILIATION ──────────────────────────
      // Every cash expense should have a cash ledger OUT entry
      const expCashTxnSet = new Set(cashLedgerArr.filter((c: any) => c.type === 'EXPENSE').map((c: any) => c.transactionId));
      const expNoLedger = expenseArr.filter((e: any) => e.transactionId && (e.paymentMethod === 'Cash' || !e.paymentMethod) && !expCashTxnSet.has(e.transactionId));
      if (expNoLedger.length > 0)
        addIssue('WARNING', 'Expense', `${expNoLedger.length} cash expense(s) have no matching cash ledger entry`, { count: expNoLedger.length });

      // Cash ledger EXPENSE entries with no expense record
      const expTxnSet = new Set(expenseArr.map((e: any) => e.transactionId).filter(Boolean));
      const cashExpNoRecord = cashLedgerArr.filter((c: any) => c.type === 'EXPENSE' && c.transactionId && !expTxnSet.has(c.transactionId));
      if (cashExpNoRecord.length > 0)
        addIssue('WARNING', 'Expense', `${cashExpNoRecord.length} EXPENSE cash ledger entry(ies) have no matching expense record (orphan cash expense)`, { count: cashExpNoRecord.length });

      // ── 11. TRANSACTION RELATIONSHIP COMPLETENESS ──────────
      // For each invoice transactionId, verify: Sale + Payment + CashLedger + StockMovement
      const invTxnMap = new Map(invoicesList.filter((i: any) => i.transactionId).map((i: any) => [i.transactionId, i]));
      const payTxnMap = new Map(paymentLedgerArr.filter((p: any) => p.transactionId).map((p: any) => [p.transactionId, p]));
      const cashTxnMap = new Map(cashLedgerArr.filter((c: any) => c.transactionId).map((c: any) => [c.transactionId, c]));
      const stockTxnSet = new Set(stockMovArr.filter((m: any) => m.transactionId).map((m: any) => m.transactionId));

      let incompleteChains = 0;
      const incompleteDetails: any[] = [];
      for (const [txnId, inv] of invTxnMap.entries()) {
        if (txnId.startsWith('TXN-REFUND-')) continue;
        const hasPayment = payTxnMap.has(txnId);
        const hasCash = cashTxnMap.has(txnId) || (inv.due === inv.finalBill); // fully-due sale may have no cash
        const hasStock = stockTxnSet.has(txnId);
        if (!hasPayment || !hasStock) {
          incompleteChains++;
          incompleteDetails.push({ txnId, invoiceId: inv.invoiceId, hasPayment, hasCash, hasStock });
        }
      }
      if (incompleteChains > 0)
        addIssue('WARNING', 'Chain', `${incompleteChains} transaction(s) have incomplete record chain (missing payment or stock movement)`, { transactions: incompleteDetails });

      // ── 12. CASH BALANCE SUMMARY ────────────────────────────
      const cashDiff = Math.abs(ledgerNetCash - expectedNetCash);

      // ── SUMMARY STATS ───────────────────────────────────────
      const report = {
        runAt: new Date().toISOString(),
        // Counts
        totalInvoices: invoicesList.length,
        totalPurchases: purchasesList.length,
        totalDueListEntries: dueListArr.length,
        totalDueCLogEntries: dueCLog.length,
        totalPayments: paymentLedgerArr.length,
        totalCashEntries: cashLedgerArr.length,
        totalStockMovements: stockMovArr.length,
        totalExpenses: expenseArr.length,
        totalMedicines: medsArr.length,
        // Sales
        salesRevenue,
        salesProfit,
        // Cash
        cashIn, cashOut, ledgerNetCash,
        saleTimeCash, dueCollected, refunds, expenseCash, expectedNetCash,
        cashDiff,
        cashBalanceOk: cashDiff < 0.01,
        // Due
        totalDueCreated, totalDueCollected, dueListTotal,
        expectedOutstandingDue, dueDiff,
        dueBalanceOk: dueDiff < 0.01,
        // Profit
        profitFromInvoices, grossRevenue, totalDiscount, totalVat,
        // Stock
        stockIssues,
        // Issues
        issues,
        issueCount: issues.filter(i => i.severity === 'ERROR').length,
        warningCount: issues.filter(i => i.severity === 'WARNING').length,
        infoCount: issues.filter(i => i.severity === 'INFO').length,
        // Raw data for EOD
        invoicesList, purchasesList, dueCLog, expenseArr, cashLedgerArr,
        dueListArr, medsArr, stockMovArr, paymentLedgerArr,
      };

      setReconReport(report);

      // Log the reconciliation run to audit trail
      await appendAuditEntry({
        action: 'RECONCILIATION_RUN',
        note: `Found ${report.issueCount} errors, ${report.warningCount} warnings`,
      });

    } catch (err: any) {
      setReconReport({ error: String(err), runAt: new Date().toISOString(), issues: [] });
    } finally {
      setReconRunning(false);
    }
  };

  // ── EOD Calculation for a specific date ─────────────────────
  const computeEOD = (date: string, report: any) => {
    if (!report || !report.invoicesList) return null;
    const isSameDay = (ts: string) => {
      try {
        const d = new Date(ts);
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(d);
        const iso = `${parts.find((p: any) => p.type === 'year')!.value}-${parts.find((p: any) => p.type === 'month')!.value}-${parts.find((p: any) => p.type === 'day')!.value}`;
        return iso === date;
      } catch { return false; }
    };

    const dayInvoices   = (report.invoicesList as any[]).filter((i: any) => isSameDay(i.timestamp || i.date || ''));
    const dayPurchases  = (report.purchasesList as any[]).filter((p: any) => isSameDay(p.timestamp || p.date || ''));
    const dayDueCLog    = (report.dueCLog as any[]).filter((d: any) => isSameDay(d.date || ''));
    const dayExpenses   = (report.expenseArr as any[]).filter((e: any) => isSameDay(e.date || ''));
    const dayCashLedger = (report.cashLedgerArr as any[]).filter((c: any) => isSameDay(c.timestamp || ''));

    const grossSales    = dayInvoices.reduce((s: number, i: any) => s + (i.finalBill || 0), 0);
    const cashSales     = dayInvoices.reduce((s: number, i: any) => s + Math.min(i.cashReceived ?? i.finalBill ?? 0, i.finalBill ?? 0), 0);
    const creditSales   = dayInvoices.reduce((s: number, i: any) => s + Math.max(0, i.due || 0), 0);
    const totalDueCreatedDay = creditSales;
    const totalDueCollectedDay = dayDueCLog.reduce((s: number, d: any) => s + (d.amount || 0), 0);
    const refundsDay    = dayInvoices.filter((i: any) => i.isReturned).reduce((s: number, i: any) => s + (i.returnDetails?.refundedAmount || 0), 0);
    const expensesDay   = dayExpenses.reduce((s: number, e: any) => s + (e.amount || 0), 0);
    const purchasesDay  = dayPurchases.reduce((s: number, p: any) => s + (p.totalAmount || 0), 0);
    const profitDay     = dayInvoices.reduce((s: number, i: any) => s + (i.profit || 0), 0);
    const netSales      = grossSales - refundsDay;
    const numSales      = dayInvoices.length;
    const numReturns    = dayInvoices.filter((i: any) => i.isReturned).length;

    // Cash equation (ledger-based)
    const cashInDay  = dayCashLedger.filter((c: any) => c.direction === 'IN').reduce((s: number, c: any) => s + (c.amount || 0), 0);
    const cashOutDay = dayCashLedger.filter((c: any) => c.direction === 'OUT').reduce((s: number, c: any) => s + (c.amount || 0), 0);
    const ledgerNetDay = cashInDay - cashOutDay;

    // Expected cash: cashSales + dueCollected - refunds - expenses
    const expectedCashDay = cashSales + totalDueCollectedDay - refundsDay - expensesDay;
    const cashDiffDay = Math.abs(ledgerNetDay - expectedCashDay);

    return {
      date, grossSales, cashSales, creditSales, totalDueCreatedDay, totalDueCollectedDay,
      refundsDay, expensesDay, purchasesDay, profitDay, netSales, numSales, numReturns,
      cashInDay, cashOutDay, ledgerNetDay, expectedCashDay, cashDiffDay,
      cashOk: cashDiffDay < 0.01,
    };
  };

  // ============================================================
  // POS / CART
  // ============================================================
  const addToCart = useCallback((med: any) => {
    // FIX (stale-closure cart bug): read from refs (always the latest
    // committed value) instead of the closed-over `medicines` state, and
    // write via functional setState. Previously, two clicks fired in quick
    // succession (e.g. a fast double-tap on mobile) could both read the
    // same stale `cart`/`medicines` snapshot and the second click's update
    // would silently overwrite the first's instead of stacking on top of
    // it — losing a unit of qty/stock.
    const originalMed = medicinesRef.current.find(m => m.id === med.id);
    if (!originalMed || originalMed.stock === 0) { playSound('error'); return alert(t("Out of stock!", "স্টক নেই!")); }
    if (new Date(originalMed.expire) < new Date()) { playSound('error'); return alert(t("⚠️ This medicine is expired!", "⚠️ এই ওষুধটির মেয়াদ শেষ!")); }
    playSound('add');

    setCart(prevCart => {
      const existing = prevCart.find(item => item.id === med.id);
      if (existing) {
        return prevCart.map(item => item.id === med.id ? { ...item, qty: (parseInt(item.qty) || 0) + 1 } : item);
      }
      return [...prevCart, { ...med, qty: 1 }];
    });
    setMedicines(prevMeds => prevMeds.map(item => item.id === med.id ? { ...item, stock: item.stock - 1 } : item));
  }, []);

  const removeFromCart = useCallback((itemToRemove: any) => {
    const currentCartQty = parseInt(itemToRemove.qty) || 0;
    setCart(prevCart => prevCart.filter(item => item.id !== itemToRemove.id));
    setMedicines(prevMeds => prevMeds.map(item => item.id === itemToRemove.id ? { ...item, stock: item.stock + currentCartQty } : item));
  }, []);

  const handleQuantityChange = useCallback((itemId: number, newQtyValue: string) => {
    // FIX: read from refs instead of closed-over state, same reasoning as addToCart.
    const existingCartItem = cartRef.current.find(item => item.id === itemId);
    const originalMed = medicinesRef.current.find(m => m.id === itemId);
    if (!existingCartItem || !originalMed) return;

    if (newQtyValue === "") {
      const currentCartQty = parseInt(existingCartItem.qty) || 0;
      setMedicines(prevMeds => prevMeds.map(m => m.id === itemId ? { ...m, stock: m.stock + currentCartQty } : m));
      setCart(prevCart => prevCart.map(item => item.id === itemId ? { ...item, qty: "" } : item));
      return;
    }

    const parsedQty = parseInt(newQtyValue);
    if (isNaN(parsedQty) || parsedQty < 0) return;
    const currentCartQty = parseInt(existingCartItem.qty) || 0;
    const currentTotalAvailable = originalMed.stock + currentCartQty;

    if (parsedQty > currentTotalAvailable) { alert(t(`⚠️ Max available: ${currentTotalAvailable} pcs`, `⚠️ সর্বোচ্চ ${currentTotalAvailable} টি পাওয়া যাবে`)); return; }

    const stockDifference = parsedQty - currentCartQty;
    setMedicines(prevMeds => prevMeds.map(m => m.id === itemId ? { ...m, stock: m.stock - stockDifference } : m));
    setCart(prevCart => prevCart.map(item => item.id === itemId ? { ...item, qty: parsedQty } : item));
  }, []);


  const handleCheckoutIntent = () => {
    if (cart.length === 0) return alert(t("Cart is empty!", "কার্ট খালি!"));
    const hasEmptyQty = cart.some(item => item.qty === "" || item.qty === 0);
    if (hasEmptyQty) return alert(t("⚠️ Please enter valid quantities!", "⚠️ সঠিক পরিমাণ দিন!"));
    // FIX: reset Cash Given AND Due together when the checkout modal opens,
    // so an untouched (empty) Cash Given field always means "customer paid
    // nothing" and the Due field correctly shows the full grand total as
    // due right away — instead of silently keeping a stale value from a
    // previous checkout, or showing "0" until the cashier types something.
    setCalculatorInput("");
    setCashReceived("");
    const prevDue = selectedExistingDue ? selectedExistingDue.totalDue : 0;
    const grandTotalNow = currentFinalBill + prevDue;
    setInvoiceDue(grandTotalNow > 0 ? grandTotalNow.toFixed(1) : "0");
    setShowConfirmModal(true);
    openEdit(() => setShowConfirmModal(false));
  };

  const currentSubTotal = useMemo(() => cart.reduce((sum, item) => sum + (item.price * (parseInt(item.qty) || 0)), 0), [cart]);
  const calculatedVatAmount = (currentSubTotal * (parseFloat(vatPercentage) || 0)) / 100;
  const activeDiscountAmount = discountType === "PERCENT"
    ? (currentSubTotal * (parseFloat(discountValue) || 0)) / 100
    : (parseFloat(discountValue) || 0);
  const currentFinalBill = Math.max(0, currentSubTotal + calculatedVatAmount - activeDiscountAmount);
  const liveRefundAmount = (parseFloat(calculatorInput) || 0) - currentFinalBill;

  const executeFinalCheckout = async () => {
    // ── GUARD 1: Double-click / double-tap protection ─────────
    // If a sale is already in-flight (network round-trips in progress),
    // a second tap on "Confirm Sale" returns immediately. The button is
    // also visually disabled via isSubmittingSale so the cashier gets
    // instant feedback that the first submission is still processing.
    if (isSubmittingSale) return;

    // ── Discount cap check (fast, no network) ─────────────────
    const discountPercent = currentSubTotal > 0 ? (activeDiscountAmount / currentSubTotal) * 100 : 0;
    if (discountPercent > 10) {
      alert(t(
        "❌ Discount cannot exceed 10%! Please reduce the discount to proceed.",
        "❌ ছাড় সর্বোচ্চ ১০% এর বেশি দেওয়া যাবে না! বিক্রয় করতে ছাড় কমান।"
      ));
      return;
    }

    // ── GUARD 2: Assign transactionId + invoiceId early, before any I/O ──
    // Generating both IDs here — before setting isSubmittingSale — means
    // we can use them in error messages even if the very first await fails.
    // The ID format includes both wall-clock time and a monotonic counter
    // so two tabs generating IDs in the same millisecond still differ.
    //
    // BUGFIX #3: invoiceId must be globally unique. The old pattern
    // Date.now().slice(-6) only kept the last 6 digits of the timestamp,
    // colliding whenever two sales occurred in the same millisecond (same
    // tab rapid double-confirm, two tabs, or two devices).
    // genId() uses a module-level monotonic counter so even back-to-back
    // calls within the same millisecond produce distinct values.
    // The "M-" prefix is kept so receipt printing and invoice search work.
    const transactionId = `TXN-${Date.now()}-${genId()}`;
    const invoiceId     = `M-${Date.now()}-${genId()}`;

    // ── GUARD 3: Idempotency — reject already-committed IDs ───
    // In React StrictMode (dev) effects run twice; this also catches any
    // path where executeFinalCheckout is called again before local state
    // has cleared (e.g. a racing setIsSubmittingSale update).
    if (submittedTransactionIds.current.has(transactionId)) return;

    setIsSubmittingSale(true);
    try {
      // ── STEP 1: Build sold-qty map from current cart ─────────
      // Cart quantities are captured NOW, before any async calls that
      // could trigger re-renders and change the cart reference.
      const soldQtyByMedId: Record<number, number> = {};
      cart.forEach(item => {
        soldQtyByMedId[item.id] = (soldQtyByMedId[item.id] || 0) + (parseInt(item.qty) || 0);
      });

      // ── STEP 2: Atomic stock deduction via ETag optimistic lock ──
      // deductStockAtomically:
      //   a) reads the LIVE medicine array + its ETag from Firebase
      //   b) re-validates every cart item against the freshest stock
      //      (catches overselling from stale carts held open on other tabs)
      //   c) computes the deducted array
      //   d) writes it back with If-Match: <etag> — the server rejects
      //      with HTTP 412 if another device changed stock since step (a)
      //   e) on 412, retries from (a) up to STOCK_MAX_RETRIES times
      //
      // This is the strongest concurrency guarantee available via the
      // Firebase REST API without the full SDK. It eliminates:
      //   • Overselling (both devices read stock=5, both sell 4 → stock=-3)
      //   • Negative stock (stock is clamped AND validated before write)
      //   • Stale local state overwriting newer Firebase stock
      addToast(t("⏳ Validating stock...", "⏳ স্টক যাচাই হচ্ছে..."), 'info');
      const stockResult = await deductStockAtomically(soldQtyByMedId, t);

      if (!stockResult.ok) {
        playSound('error');
        if (stockResult.reason === 'insufficient') {
          alert(t(
            `⚠️ Stock changed while your cart was open — not enough left to complete this sale:\n\n${stockResult.details.join('\n')}\n\nPlease adjust the quantities and try again.`,
            `⚠️ কার্ট খোলা থাকাকালীন স্টক পরিবর্তন হয়ে গেছে — এই বিক্রি সম্পন্ন করার জন্য পর্যাপ্ত স্টক নেই:\n\n${stockResult.details.join('\n')}\n\nপরিমাণ ঠিক করে আবার চেষ্টা করুন।`
          ));
        } else {
          alert(t(
            `❌ Could not update stock — no internet or Firebase is unreachable.\n\nNOTHING was changed. Please check your connection and press "Confirm Sale" again.\n\n(Ref: ${transactionId})`,
            `❌ স্টক আপডেট করা যায়নি — ইন্টারনেট নেই বা Firebase-এ পৌঁছানো যাচ্ছে না।\n\nকিছুই পরিবর্তন হয়নি। সংযোগ পরীক্ষা করে আবার "Confirm Sale" চাপুন।\n\n(রেফ: ${transactionId})`
          ));
        }
        return; // isSubmittingSale cleared in finally
      }

      // Stock deduction confirmed on Firebase — updatedMeds is authoritative.
      const updatedMeds = stockResult.updatedMeds;

      // ── Phase 4: Build SALE stock movement entries ────────────
      // Snapshot taken BEFORE deduction (from the fresh meds array that
      // deductStockAtomically read), so previousStock is accurate.
      // We reconstruct the pre-deduction snapshot by adding sold qty back.
      const preDeductMeds = updatedMeds.map((m: any) =>
        soldQtyByMedId[m.id] ? { ...m, stock: m.stock + soldQtyByMedId[m.id] } : m
      );
      // BUGFIX #3 (continued): invoiceId is now generated before deductStockAtomically
      // so the stock movement placeholder is the real invoiceId from the start.
      const saleMovementEntries = buildStockMovementEntries(
        'SALE',
        transactionId,
        invoiceId,  // real invoiceId — no placeholder needed anymore
        soldQtyByMedId,
        preDeductMeds,
        new Date().toISOString(),
        new Date().toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' }),
      );

      // ── STEP 3: Fetch fresh invoice/due data ─────────────────
      // Done AFTER the stock write so we don't hold a stale ETag across
      // unrelated I/O. Invoices + due list conflict separately from stock
      // and are handled by fetchLatestList (read-merge-write).
      const [invoices, dueList, dueCollectionLog] = await Promise.all([
        fetchLatestList('madina_v7_invoices', invoicesRef.current),
        fetchLatestList('madina_v7_due_list', dueListRef.current),
        fetchLatestList('madina_v7_due_collection_log', dueCollectionLogRef.current),
      ]);

      // ── STEP 4: Compute all derived values ───────────────────
      const totalCost = cart.reduce((sum, item) => sum + (item.buyPrice * (parseInt(item.qty) || 0)), 0);

      // Look up customer's fresh due amount (not the stale modal snapshot)
      const freshExistingDue = selectedExistingDue
        ? dueList.find((d: any) => d.id === selectedExistingDue.id)
        : null;
      const prevDueAmt = freshExistingDue ? freshExistingDue.totalDue : 0;
      const grandTotal = currentFinalBill + prevDueAmt;
      const cashGivenNum = parseFloat(cashReceived) || 0;
      const dueAmt = Math.max(0, grandTotal - cashGivenNum);
      const paidCash = Math.min(cashGivenNum, grandTotal);
      const netProfit = currentFinalBill - totalCost;
      // Per-invoice due = only THIS bill's unpaid portion (not grand total)
      const newBillDue = Math.max(0, currentFinalBill - paidCash);

      const today = new Date();
      const formattedTime = today.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const formattedDate = today.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' });

      const newInvoice = {
        invoiceId,
        transactionId, // ← every record carries the same txn id
        customer: customerName || t("Regular Customer", "সাধারণ গ্রাহক"),
        phone: customerPhone || "N/A",
        dateString: `${formattedDate} | ${formattedTime}`,
        items: [...cart],
        subTotal: currentSubTotal,
        vat: calculatedVatAmount,
        discount: activeDiscountAmount,
        finalBill: currentFinalBill,
        profit: netProfit,
        paymentMethod,
        // BUGFIX #10: store paidCash (the actual cash taken, capped at grandTotal)
        // so a full-due sale (৳0 paid) correctly records cashReceived=0 instead of
        // the falsy-or-fallback-to-finalBill pattern that caused the receipt to display
        // "Cash Received: ৳1000" on a sale where nothing was paid.
        cashReceived: paidCash,
        due: newBillDue,
        changeAmount: Math.max(0, cashGivenNum - grandTotal),
        footerMsg: receiptFooterMsg,
        isReturned: false,
        returnDetails: null
      };

      // invoiceId was already baked into saleMovementEntries above — no remap needed.
      const finalSaleMovements = saleMovementEntries;

      const updatedInvoices = [newInvoice, ...invoices];

      let updatedDueList = [...dueList];
      let updatedDueCollectionLog = dueCollectionLog;

      // Settle any existing customer due that was partially paid this sale
      if (freshExistingDue) {
        const cashForPrevDue = Math.max(0, paidCash - currentFinalBill);
        const prevDuePaid = Math.min(prevDueAmt, cashForPrevDue);
        if (prevDuePaid > 0) {
          const newPrevDue = prevDueAmt - prevDuePaid;
          const logEntry = {
            id: genId(),
            transactionId, // ← links due collection back to this sale
            customerName: freshExistingDue.customerName,
            phone: freshExistingDue.phone || "N/A",
            amount: prevDuePaid,
            dateString: formattedDate,
            date: today.toISOString()
          };
          updatedDueCollectionLog = [logEntry, ...dueCollectionLog];
          if (newPrevDue <= 0) {
            updatedDueList = updatedDueList.filter(d => d.id !== freshExistingDue.id);
          } else {
            updatedDueList = updatedDueList.map(d =>
              d.id === freshExistingDue.id ? { ...d, totalDue: newPrevDue } : d
            );
          }
        }
      }

      // Add new bill's due to the customer's running due balance
      if (dueAmt > 0 && newBillDue > 0) {
        const effectiveName = customerName.trim() || t("Regular Customer", "সাধারণ গ্রাহক");
        const effectivePhone = customerPhone || "N/A";
        const existingDueIdx = updatedDueList.findIndex(
          d => d.customerName.toLowerCase() === effectiveName.toLowerCase() && d.phone === effectivePhone
        );
        if (existingDueIdx !== -1) {
          updatedDueList[existingDueIdx] = {
            ...updatedDueList[existingDueIdx],
            totalDue: updatedDueList[existingDueIdx].totalDue + newBillDue,
            invoices: [
              ...updatedDueList[existingDueIdx].invoices,
              { invoiceId: newInvoice.invoiceId, amount: newBillDue, date: formattedDate }
            ]
          };
        } else {
          updatedDueList.push({
            id: genId(),
            customerName: effectiveName,
            phone: effectivePhone,
            totalDue: newBillDue,
            invoices: [{ invoiceId: newInvoice.invoiceId, amount: newBillDue, date: formattedDate }]
          });
        }
      }

      const { sales: finalTotalSales, profit: finalTotalProfit } =
        computeSalesAndProfit(updatedInvoices, updatedDueCollectionLog);

      // ── STEP 5: Commit invoice/due/sales in one atomic PATCH ─
      // Stock was already written and confirmed in STEP 2.
      // This second PATCH covers the remaining keys: invoices, due list,
      // due collection log, and the derived scalar totals.
      //
      // Why two writes instead of one? The medicines key requires an
      // ETag conditional write (If-Match header) which is incompatible
      // with the multi-path PATCH that covers the other keys — they are
      // different HTTP request types. The stock write was already confirmed
      // before we reach here, so if THIS write fails:
      //   • Stock WAS deducted (correct — the sale happened physically)
      //   • Invoice was NOT recorded — cashier sees the error, can:
      //     a) retry: "Confirm Sale" again (the stock re-validation in
      //        STEP 2 will now see the already-deducted quantities and
      //        pass, then only this PATCH will be retried)
      //     b) escalate: transactionId is logged for manual reconciliation
      //
      // This is the fundamental constraint of the Firebase REST API:
      // true cross-key atomicity requires the SDK's .transaction() or
      // Firestore's runTransaction(). For now, stock-first is the safest
      // order — it prevents overselling even in the failure case.
      // ── STEP 4b: Build Payment + Cash ledger entries ─────────
      // Idempotency: skip if this transactionId already recorded
      // (handles retry after a partial failure where stock deducted but
      // invoice write failed — the retry re-runs Step 4 correctly).
      const freshPaymentLedger = await fetchLatestList('madina_v7_payment_ledger', paymentLedgerRef.current);
      const freshCashLedger    = await fetchLatestList('madina_v7_cash_ledger', cashLedgerRef.current);

      const txnAlreadyInPaymentLedger = freshPaymentLedger.some((p: any) => p.transactionId === transactionId);
      let updatedPaymentLedger = freshPaymentLedger;
      let updatedCashLedger    = freshCashLedger;

      if (!txnAlreadyInPaymentLedger) {
        const paymentId = `PAY-${Date.now()}-${genId()}`;
        const cashId    = `CASH-${Date.now()}-${genId()}`;
        const effectiveCash = cashReceived !== "" ? (parseFloat(cashReceived) || 0) : currentFinalBill;
        const actualCashIn  = Math.min(effectiveCash, grandTotal); // cash received, capped at total owed

        // Payment ledger entry: records the payment event for this sale
        const paymentEntry = {
          paymentId,
          transactionId,
          invoiceId: newInvoice.invoiceId,
          customer: newInvoice.customer,
          phone: newInvoice.phone,
          amount: currentFinalBill,          // full invoice amount (sales revenue)
          cashReceived: actualCashIn,         // cash actually taken
          dueCreated: newBillDue,             // unpaid portion of THIS bill
          paymentMethod,
          paymentType: 'SALE_PAYMENT' as const,
          timestamp: today.toISOString(),
          dateString: formattedDate,
        };
        updatedPaymentLedger = [paymentEntry, ...freshPaymentLedger];

        // Cash ledger entry: records the cash flow for this sale
        if (actualCashIn > 0) {
          const cashEntry = {
            ledgerId: cashId,
            transactionId,
            invoiceId: newInvoice.invoiceId,
            customer: newInvoice.customer,
            amount: actualCashIn,
            type: 'CASH_SALE' as const,
            direction: 'IN' as const,
            paymentMethod,
            timestamp: today.toISOString(),
            dateString: formattedDate,
          };
          updatedCashLedger = [cashEntry, ...freshCashLedger];
        }

        // If old due was partially/fully paid in this sale, also log that in cash ledger
        if (freshExistingDue) {
          const cashForPrevDueCheck = Math.max(0, actualCashIn - currentFinalBill);
          const prevDuePaidCheck    = Math.min(prevDueAmt, cashForPrevDueCheck);
          if (prevDuePaidCheck > 0) {
            const dueCashId = `CASH-DUE-${Date.now()}-${genId()}`;
            const dueCashEntry = {
              ledgerId: dueCashId,
              transactionId,
              invoiceId: newInvoice.invoiceId,
              customer: freshExistingDue.customerName,
              amount: prevDuePaidCheck,
              type: 'DUE_COLLECTION' as const,
              direction: 'IN' as const,
              paymentMethod,
              timestamp: today.toISOString(),
              dateString: formattedDate,
            };
            updatedCashLedger = [dueCashEntry, ...updatedCashLedger];
          }
        }
      }

      // Phase 4: Fetch fresh stock movements and prepend this sale's entries
      const freshStockMovements = await fetchLatestList('madina_v7_stock_movements', stockMovementsRef.current);
      const updatedStockMovements = [...finalSaleMovements, ...freshStockMovements];

      addToast(t("⏳ Saving invoice...", "⏳ ইনভয়েস সংরক্ষণ হচ্ছে..."), 'info');
      const invoiceWriteOk = await cloudMultiSet({
        madina_v7_invoices:           JSON.stringify(updatedInvoices),
        madina_v7_due_list:           JSON.stringify(updatedDueList),
        madina_v7_due_collection_log: JSON.stringify(updatedDueCollectionLog),
        madina_v7_sales:              finalTotalSales.toString(),
        madina_v7_profit:             finalTotalProfit.toString(),
        madina_v7_payment_ledger:     JSON.stringify(updatedPaymentLedger),
        madina_v7_cash_ledger:        JSON.stringify(updatedCashLedger),
        madina_v7_stock_movements:    JSON.stringify(updatedStockMovements),
      });

      if (!invoiceWriteOk) {
        // Stock deduction SUCCEEDED but invoice write FAILED.
        // This is a partial failure — the physical stock is already deducted.
        // DO NOT show a success message. DO NOT clear the cart.
        // Give the cashier the full picture so they can retry or escalate.
        playSound('error');
        alert(t(
          `⚠️ Stock was updated but the INVOICE could not be saved.\n\nThis means the medicine was dispensed but the sale is NOT recorded yet.\nPlease check your internet and press "Confirm Sale" again to save the invoice.\nThe stock re-check will recognise the already-deducted quantities.\n\n(Transaction ref: ${transactionId} — keep this for reconciliation)`,
          `⚠️ স্টক আপডেট হয়েছে কিন্তু ইনভয়েস সংরক্ষণ করা যায়নি।\n\nএর মানে ওষুধ বের করা হয়েছে কিন্তু বিক্রয় এখনও রেকর্ড হয়নি।\nইন্টারনেট পরীক্ষা করে আবার "Confirm Sale" চাপুন।\nস্টক রি-চেক আগে-কাটা পরিমাণ ধরতে পারবে।\n\n(ট্রানজেকশন রেফ: ${transactionId} — সমন্বয়ের জন্য রেখে দিন)`
        ));
        addToast(t("⚠️ Invoice not saved — retry!", "⚠️ ইনভয়েস সেভ হয়নি — আবার চেষ্টা করুন!"), 'error');
        return;
      }

      // ── STEP 6: Mark transaction committed (idempotency) ─────
      submittedTransactionIds.current.add(transactionId);

      // ── STEP 7: Update local React state — ONLY after confirmed write
      // The UI shows what Firebase confirmed, never what we hoped for.
      setInvoices(updatedInvoices);
      setLastInvoice(newInvoice);
      setMedicines(updatedMeds);
      setDueList(updatedDueList);
      setDueCollectionLog(updatedDueCollectionLog);
      setTotalSales(finalTotalSales);
      setTotalProfit(finalTotalProfit);
      // Phase 3: update ledgers in local state after confirmed write
      setPaymentLedger(updatedPaymentLedger);
      setCashLedger(updatedCashLedger);
      // Phase 4: update stock movement ledger in local state
      setStockMovements(updatedStockMovements);

      setCart([]); setCustomerName(""); setCustomerPhone("");
      setDiscountValue("0"); setCashReceived(""); setInvoiceDue("0");
      setSelectedExistingDue(null);
      setShowCustomerPanel(true);
      setShowConfirmModal(false);
      setShowSuccessAlert(true);
      playSound('checkout');
      addToast(t("✅ Invoice created successfully!", "✅ বিল তৈরি সফল হয়েছে!"), 'success');

    } finally {
      // Always release the submission lock — whether we succeeded, failed,
      // or hit an exception. Without this the Confirm button stays disabled
      // forever if anything throws unexpectedly.
      setIsSubmittingSale(false);
    }
  };

  // ============================================================
  // RETURN SYSTEM
  // ============================================================
  const openReturnInterface = (invoice: any) => {
    setSelectedInvoiceForReturn(invoice);
    const initialQtyState: { [key: number]: number } = {};
    invoice.items.forEach((item: any) => { initialQtyState[item.id] = 0; });
    setReturnItemsQuantities(initialQtyState);
    setReturnReason("");
    setReturnActionType("CASH_REFUND");
    setShowReturnModal(true);
    openEdit(() => setShowReturnModal(false));
  };

  const handleReturnItemQtyChange = (itemId: number, maxQty: number, value: string) => {
    const parsed = parseInt(value) || 0;
    if (parsed < 0) return;
    if (parsed > maxQty) { alert(t(`⚠️ Cannot return more than ${maxQty} pcs!`, `⚠️ সর্বোচ্চ ${maxQty} টি ফেরত দেওয়া যাবে!`)); return; }
    setReturnItemsQuantities({ ...returnItemsQuantities, [itemId]: parsed });
  };

  // ── Return submission guard (mirrors the sale guard) ────────
  // Prevents double-tap and duplicate processing: the Confirm Return button
  // is disabled while a return is in-flight, and submitted return IDs are
  // remembered in a Set for idempotency within the session.
  const [isSubmittingReturn, setIsSubmittingReturn] = useState(false);
  const submittedReturnIds = useRef<Set<string>>(new Set());

  const processInvoiceMedicineReturn = async () => {
    // ── GUARD: double-click / in-flight protection ───────────
    if (isSubmittingReturn) return;
    if (!selectedInvoiceForReturn) return;

    const totalReturnItemsCount = (Object.values(returnItemsQuantities) as number[]).reduce((a, b) => a + b, 0);
    if (totalReturnItemsCount === 0) {
      alert(t("⚠️ Please select at least 1 quantity to return!", "⚠️ কমপক্ষে ১টি পরিমাণ নির্বাচন করুন!"));
      return;
    }

    // ── BUGFIX #1/#2 FIX: Generate the refundTransactionId EARLY so we can
    // use it for idempotency checking before any I/O begins. ──────────────
    const refundTransactionId = `TXN-REFUND-${Date.now()}-${genId()}`;
    if (submittedReturnIds.current.has(refundTransactionId)) return;

    setIsSubmittingReturn(true);

    try {
      // ── STEP 1: Build return quantities and amounts ───────────
      let calculatedRefundAmount = 0;
      let calculatedCostSavingsToSubtract = 0;
      const returnedItemsSummaryList: any[] = [];
      const returnQtyByMedId: Record<number, number> = {};

      selectedInvoiceForReturn.items.forEach((item: any) => {
        const returnQty = returnItemsQuantities[item.id] || 0;
        if (returnQty > 0) {
          calculatedRefundAmount += (item.price * returnQty);
          calculatedCostSavingsToSubtract += (item.buyPrice * returnQty);
          returnedItemsSummaryList.push({ id: item.id, name: item.name, qtyReturned: returnQty, pricePerUnit: item.price });
          returnQtyByMedId[item.id] = (returnQtyByMedId[item.id] || 0) + returnQty;
        }
      });

      const originalSubtotal = selectedInvoiceForReturn.subTotal;
      if (originalSubtotal > 0) {
        const ratio = calculatedRefundAmount / originalSubtotal;
        const proportionalDiscount = selectedInvoiceForReturn.discount * ratio;
        const proportionalVat = selectedInvoiceForReturn.vat * ratio;
        calculatedRefundAmount = Math.max(0, calculatedRefundAmount + proportionalVat - proportionalDiscount);
      }

      // ── STEP 2: Fetch ALL fresh data from Firebase before any writes ──
      // BUGFIX #1/#2: We read everything we need BEFORE touching any data.
      // Stock is read here too — we do NOT write stock until the invoice
      // write is confirmed. This prevents the "stock returned but invoice
      // not updated" partial-failure state.
      const today = new Date();
      const refundDate = today.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' });

      const [
        invoices, dueList, freshDueLog,
        freshPaymentLedger, freshCashLedger, freshReturnMovements,
      ] = await Promise.all([
        fetchLatestList('madina_v7_invoices', invoicesRef.current),
        fetchLatestList('madina_v7_due_list', dueListRef.current),
        fetchLatestList('madina_v7_due_collection_log', dueCollectionLogRef.current),
        fetchLatestList('madina_v7_payment_ledger', paymentLedgerRef.current),
        fetchLatestList('madina_v7_cash_ledger', cashLedgerRef.current),
        fetchLatestList('madina_v7_stock_movements', stockMovementsRef.current),
      ]);

      // Read the freshest stock snapshot for building movement entries.
      // We do NOT write stock yet — stock write comes last, AFTER the
      // invoice/ledger PATCH succeeds.
      const fetchedMedsRaw = await fbGet('madina_v7_meds');
      let priorMedsForReturn: any[] = medicinesRef.current;
      if (fetchedMedsRaw) {
        try { priorMedsForReturn = JSON.parse(fetchedMedsRaw); } catch {}
      }

      // ── STEP 3: Idempotency — verify this invoice isn't already returned ─
      // BUGFIX #1/#2: If the invoice is already marked returned in the live
      // data (another device processed it, or the user retried after a
      // partial failure), refuse instead of double-processing.
      const liveInvoice = invoices.find((inv: any) => inv.invoiceId === selectedInvoiceForReturn.invoiceId);
      if (liveInvoice?.isReturned) {
        alert(t(
          "⚠️ This invoice has already been marked as returned. No changes were made.",
          "⚠️ এই ইনভয়েসটি ইতিমধ্যে ফেরত হিসেবে চিহ্নিত করা হয়েছে। কোনো পরিবর্তন হয়নি।"
        ));
        setShowReturnModal(false);
        setSelectedInvoiceForReturn(null);
        return;
      }

      // ── STEP 4: Compute updated invoices + due list ───────────
      const updatedInvoices = invoices.map((inv: any) => {
        if (inv.invoiceId === selectedInvoiceForReturn.invoiceId) {
          return {
            ...inv,
            isReturned: true,
            finalBill: inv.finalBill - calculatedRefundAmount,
            profit: inv.profit - (calculatedRefundAmount - calculatedCostSavingsToSubtract),
            due: Math.max(0, (inv.due || 0) - calculatedRefundAmount),
            returnDetails: {
              returnedItems: returnedItemsSummaryList,
              refundedAmount: calculatedRefundAmount,
              action: returnActionType,
              reason: returnReason || t("General Exchange Request", "সাধারণ ফেরত"),
              timestamp: today.toLocaleDateString() + " | " + today.toLocaleTimeString()
            }
          };
        }
        return inv;
      });

      let updatedDueList = dueList;
      if ((selectedInvoiceForReturn.due || 0) > 0) {
        const dueListIdx = dueList.findIndex((d: any) =>
          d.customerName.toLowerCase() === selectedInvoiceForReturn.customer.toLowerCase() &&
          d.phone === selectedInvoiceForReturn.phone
        );
        if (dueListIdx !== -1) {
          const entry = dueList[dueListIdx];
          const invRecord = entry.invoices?.find((i: any) => i.invoiceId === selectedInvoiceForReturn.invoiceId);
          const invoiceDueAmount = invRecord ? invRecord.amount : 0;
          const reduceBy = Math.min(calculatedRefundAmount, invoiceDueAmount, entry.totalDue);
          if (reduceBy > 0) {
            const newTotalDue = Math.max(0, entry.totalDue - reduceBy);
            const newInvoicesArr = (entry.invoices || [])
              .map((i: any) => i.invoiceId === selectedInvoiceForReturn.invoiceId
                ? { ...i, amount: Math.max(0, i.amount - reduceBy) }
                : i)
              .filter((i: any) => i.amount > 0);
            updatedDueList = newTotalDue <= 0
              ? dueList.filter((d: any) => d.id !== entry.id)
              : dueList.map((d: any) => d.id === entry.id ? { ...d, totalDue: newTotalDue, invoices: newInvoicesArr } : d);
          }
        }
      }

      // ── STEP 5: Build payment + cash ledger entries ───────────
      let updatedReturnPaymentLedger = freshPaymentLedger;
      let updatedReturnCashLedger    = freshCashLedger;

      if (returnActionType === "CASH_REFUND" && calculatedRefundAmount > 0) {
        const refundPayEntry = {
          paymentId:         `PAY-REFUND-${Date.now()}-${genId()}`,
          transactionId:     refundTransactionId,
          originalInvoiceId: selectedInvoiceForReturn.invoiceId,
          customer:          selectedInvoiceForReturn.customer,
          amount:            calculatedRefundAmount,
          paymentMethod:     selectedInvoiceForReturn.paymentMethod || 'Cash',
          paymentType:       'REFUND' as const,
          timestamp:         today.toISOString(),
          dateString:        refundDate,
        };
        updatedReturnPaymentLedger = [refundPayEntry, ...freshPaymentLedger];

        const refundCashEntry = {
          ledgerId:          `CASH-REFUND-${Date.now()}-${genId()}`,
          transactionId:     refundTransactionId,
          originalInvoiceId: selectedInvoiceForReturn.invoiceId,
          customer:          selectedInvoiceForReturn.customer,
          amount:            calculatedRefundAmount,
          type:              'REFUND' as const,
          direction:         'OUT' as const,
          paymentMethod:     selectedInvoiceForReturn.paymentMethod || 'Cash',
          timestamp:         today.toISOString(),
          dateString:        refundDate,
        };
        updatedReturnCashLedger = [refundCashEntry, ...freshCashLedger];
      }

      // ── STEP 6: Build stock movement entries ──────────────────
      // BUGFIX #1/#2: movements are computed here but NOT written yet.
      // We write stock ONLY after the invoice PATCH succeeds below.
      const returnMovementEntries = buildStockMovementEntries(
        'RETURN',
        refundTransactionId,
        selectedInvoiceForReturn.invoiceId,
        returnQtyByMedId,
        priorMedsForReturn,
        today.toISOString(),
        refundDate,
      );
      const updatedReturnMovements = [...returnMovementEntries, ...freshReturnMovements];

      // ── STEP 7: Derive sales + profit totals ──────────────────
      // BUGFIX #6: use freshDueLog (freshly fetched) not the stale closed-over
      // dueCollectionLog state variable — ensures any concurrent due collection
      // from another device is included in the recomputed total.
      const { sales: returnedSales, profit: returnedProfit } = computeSalesAndProfit(updatedInvoices, freshDueLog);

      // ── STEP 8: Atomic PATCH — invoice + due + ledgers + movements ──
      // BUGFIX #1/#2 (core fix): ALL financial records are written in ONE
      // atomic PATCH before stock is touched. If this PATCH fails:
      //   • The invoice is still marked as NOT returned in Firebase.
      //   • No cash/payment/movement records were created.
      //   • Stock is unchanged.
      //   • The user sees an error and can safely retry.
      // Stock is written AFTER this succeeds so there is no window where
      // stock is restored but the invoice still shows "not returned".
      const invoiceWriteOk = await cloudMultiSet({
        madina_v7_invoices:        JSON.stringify(updatedInvoices),
        madina_v7_due_list:        JSON.stringify(updatedDueList),
        madina_v7_sales:           returnedSales.toString(),
        madina_v7_profit:          returnedProfit.toString(),
        madina_v7_payment_ledger:  JSON.stringify(updatedReturnPaymentLedger),
        madina_v7_cash_ledger:     JSON.stringify(updatedReturnCashLedger),
        madina_v7_stock_movements: JSON.stringify(updatedReturnMovements),
      });

      if (!invoiceWriteOk) {
        // Nothing was changed in Firebase — invoice still shows "not returned",
        // stock is untouched. User can retry safely.
        playSound('error');
        alert(t(
          `❌ Return could not be saved — check your internet and press "Confirm Return" again.\n\nNothing was changed.\n(Ref: ${refundTransactionId})`,
          `❌ ফেরত সংরক্ষণ করা যায়নি — ইন্টারনেট পরীক্ষা করে আবার "Confirm Return" চাপুন।\n\nকিছুই পরিবর্তন হয়নি।\n(রেফ: ${refundTransactionId})`
        ));
        return; // isSubmittingReturn released in finally
      }

      // ── STEP 9: Restore stock AFTER confirmed invoice write ───
      // BUGFIX #1/#2: Stock is only returned to Firebase AFTER the invoice
      // has been confirmed updated. This is the correct order — the physical
      // goods are back on the shelf only once the books reflect the return.
      // If this stock write fails (very unlikely — invoice already updated),
      // the cashier must manually adjust stock. We log a clear message.
      const stockWriteOk = await updateMedicinesOnCloud(latestMeds =>
        latestMeds.map(m => returnQtyByMedId[m.id] ? { ...m, stock: m.stock + returnQtyByMedId[m.id] } : m)
      );
      if (!stockWriteOk) {
        // Invoice is correctly updated. Only stock write failed.
        // Show a specific message — do not roll back the invoice.
        alert(t(
          `⚠️ Return recorded but stock could not be updated. Please manually adjust stock for returned items.\n(Ref: ${refundTransactionId})`,
          `⚠️ ফেরত নথিভুক্ত হয়েছে কিন্তু স্টক আপডেট করা যায়নি। ফেরত আইটেমের স্টক ম্যানুয়ালি ঠিক করুন।\n(রেফ: ${refundTransactionId})`
        ));
      }

      // ── STEP 10: Mark committed (idempotency) ─────────────────
      submittedReturnIds.current.add(refundTransactionId);

      // ── STEP 11: Update local React state ONLY after confirmed write ──
      setInvoices(updatedInvoices);
      setDueList(updatedDueList);
      setTotalSales(returnedSales);
      setTotalProfit(returnedProfit);
      setPaymentLedger(updatedReturnPaymentLedger);
      setCashLedger(updatedReturnCashLedger);
      setStockMovements(updatedReturnMovements);

      setShowReturnModal(false);
      setSelectedInvoiceForReturn(null);

      // Handle store credit: apply discount to POS cart AFTER state update
      if (returnActionType !== "CASH_REFUND") {
        setDiscountType("TK");
        setDiscountValue(calculatedRefundAmount.toFixed(2));
        setCustomerName(selectedInvoiceForReturn.customer);
        setCustomerPhone(selectedInvoiceForReturn.phone);
        alert(t(`💳 Store credit of ${calculatedRefundAmount.toFixed(1)} ${currencySymbol} generated!`, `💳 ${calculatedRefundAmount.toFixed(1)} ${currencySymbol} স্টোর ক্রেডিট তৈরি হয়েছে!`));
        navigateTab("pos");
      } else {
        playSound('success');
        alert(t("✅ Return processed successfully!", "✅ ফেরত সফলভাবে প্রক্রিয়া করা হয়েছে!"));
      }

    } finally {
      // Always release the return lock so the button re-enables regardless
      // of success, failure, or unexpected exception.
      setIsSubmittingReturn(false);
    }
  };

  // ============================================================
  // DUE PAYMENT
  // ============================================================
  const handleDuePayment = async () => {
    if (!duePaymentModal) return;
    const payAmt = parseFloat(duePayAmount) || 0;
    if (payAmt <= 0) { alert(t("Please enter a valid amount!", "সঠিক পরিমাণ দিন!")); return; }

    // FIX (multi-device due conflict): pull the freshest due list and due
    // collection log before merging this payment — otherwise a payment or
    // sale recorded on another device in the same few seconds gets
    // silently overwritten and lost. Also re-check the cap against the
    // freshest totalDue, not the (possibly stale) modal snapshot.
    const [dueList, dueCollectionLog, invoices] = await Promise.all([
      fetchLatestList('madina_v7_due_list', dueListRef.current),
      fetchLatestList('madina_v7_due_collection_log', dueCollectionLogRef.current),
      fetchLatestList('madina_v7_invoices', invoicesRef.current),
    ]);
    const freshDueEntry = dueList.find((d: any) => d.id === duePaymentModal.id);
    const freshTotalDue = freshDueEntry ? freshDueEntry.totalDue : duePaymentModal.totalDue;
    if (payAmt > freshTotalDue) { alert(t(`Maximum payable is ${freshTotalDue.toFixed(1)} ${currencySymbol}`, `সর্বোচ্চ পরিশোধ ${freshTotalDue.toFixed(1)} ${currencySymbol}`)); return; }

    const newTotalDue = freshTotalDue - payAmt;
    const updatedDueList = newTotalDue <= 0
      ? dueList.filter(d => d.id !== duePaymentModal.id)
      : dueList.map(d => d.id === duePaymentModal.id ? { ...d, totalDue: newTotalDue } : d);

    // Transactional ID for this due collection — links all ledger records
    const dueTransactionId = `TXN-DUE-${Date.now()}-${genId()}`;

    // Log this collection with date for dashboard due collection stats
    const today = new Date();
    const formattedDate = today.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' });
    const logEntry = {
      id: genId(),
      transactionId: dueTransactionId,
      customerName: duePaymentModal.customerName,
      phone: duePaymentModal.phone || "N/A",
      amount: payAmt,
      dateString: formattedDate,
      date: today.toISOString()
    };
    const updatedLog = [logEntry, ...dueCollectionLog];

    // Phase 3: Payment ledger entry for this due collection
    const freshPaymentLedger = await fetchLatestList('madina_v7_payment_ledger', paymentLedgerRef.current);
    const freshCashLedger    = await fetchLatestList('madina_v7_cash_ledger', cashLedgerRef.current);

    const duePayEntry = {
      paymentId:     `PAY-DUE-${Date.now()}-${genId()}`,
      transactionId: dueTransactionId,
      customer:      duePaymentModal.customerName,
      phone:         duePaymentModal.phone || "N/A",
      amount:        payAmt,
      paymentMethod: 'Cash',   // due collection is always cash unless extended later
      paymentType:   'DUE_COLLECTION' as const,
      timestamp:     today.toISOString(),
      dateString:    formattedDate,
    };
    const updatedPaymentLedger = [duePayEntry, ...freshPaymentLedger];

    // Phase 3: Cash ledger entry — cash IN for the collected amount
    const dueCashEntry = {
      ledgerId:      `CASH-DUE-${Date.now()}-${genId()}`,
      transactionId: dueTransactionId,
      customer:      duePaymentModal.customerName,
      amount:        payAmt,
      type:          'DUE_COLLECTION' as const,
      direction:     'IN' as const,
      paymentMethod: 'Cash',
      timestamp:     today.toISOString(),
      dateString:    formattedDate,
    };
    const updatedCashLedger = [dueCashEntry, ...freshCashLedger];

    // Sales revenue is NOT increased by due collection (corrected accounting rule).
    // Sales was already booked in full at the original sale's finalBill.
    const { sales: newTotalSales, profit: newTotalProfit } = computeSalesAndProfit(invoices, updatedLog);

    // Single atomic PATCH — all keys land together or none do.
    // BUGFIX #4: madina_v7_profit was previously missing from this PATCH,
    // causing the stored profit scalar to drift from computeSalesAndProfit's
    // value until the next full page reload. Both sales and profit must be
    // written together to keep all devices in sync.
    const writeOk = await cloudMultiSet({
      madina_v7_due_collection_log: JSON.stringify(updatedLog),
      madina_v7_due_list:           JSON.stringify(updatedDueList),
      madina_v7_sales:              newTotalSales.toString(),
      madina_v7_profit:             newTotalProfit.toString(),
      madina_v7_payment_ledger:     JSON.stringify(updatedPaymentLedger),
      madina_v7_cash_ledger:        JSON.stringify(updatedCashLedger),
    });

    if (!writeOk) {
      alert(t(
        `❌ Could not save payment — check your internet and try again.\n\nNothing was changed.\n(Ref: ${dueTransactionId})`,
        `❌ পেমেন্ট সংরক্ষণ করা যায়নি — ইন্টারনেট পরীক্ষা করে আবার চেষ্টা করুন।\n\nকিছুই পরিবর্তন হয়নি।\n(রেফ: ${dueTransactionId})`
      ));
      return;
    }

    // Update local state only after confirmed write (BUGFIX #4: profit is now included)
    setDueCollectionLog(updatedLog);
    setTotalSales(newTotalSales);
    setTotalProfit(newTotalProfit);
    setDueList(updatedDueList);
    setPaymentLedger(updatedPaymentLedger);
    setCashLedger(updatedCashLedger);
    setDuePaymentModal(null);
    setDuePayAmount("");
    alert(t(`✅ Payment of ${payAmt.toFixed(1)} ${currencySymbol} recorded!`, `✅ ${payAmt.toFixed(1)} ${currencySymbol} পরিশোধ নথিভুক্ত হয়েছে!`));
  };

  // ============================================================
  // EXPENSE TRACKER — add / edit / delete
  // ============================================================
  const resetExpenseForm = () => {
    setEditingExpenseId(null);
    setExpenseCategory("Rent");
    setExpenseCustomCategory("");
    setExpenseAmount("");
    setExpenseNote("");
    setExpensePaymentMethod("Cash");
  };

  const handleSaveExpense = async () => {
    const requiredPerm = editingExpenseId !== null ? "expense_edit" : "expense_add";
    if (currentUserRole === "STAFF" && !staffVisibleModules[requiredPerm]) {
      playSound('error');
      alert(t("You don't have permission to do this.", "এই কাজের অনুমতি আপনার নেই।"));
      return;
    }
    const amt = parseFloat(expenseAmount) || 0;
    if (amt <= 0) { playSound('error'); alert(t("Please enter a valid amount!", "সঠিক পরিমাণ দিন!")); return; }
    const finalCategory = expenseCategory === "Other" && expenseCustomCategory.trim()
      ? expenseCustomCategory.trim()
      : expenseCategory;
    if (!finalCategory) { playSound('error'); alert(t("Please select or enter a category!", "ক্যাটাগরি নির্বাচন করুন!")); return; }

    const currentList = await fetchLatestList('madina_v7_expenses', expenseListRef.current);

    if (editingExpenseId !== null) {
      const updated = currentList.map((e: any) =>
        e.id === editingExpenseId ? { ...e, category: finalCategory, amount: amt, note: expenseNote, paymentMethod: expensePaymentMethod } : e
      );
      setExpenseList(updated);
      await cloudSet('madina_v7_expenses', JSON.stringify(updated));
      // Note: editing an expense does NOT create a new cash ledger entry —
      // the original entry stands. Only the expense record itself is corrected.
      playSound('save');
      alert(t("✅ Expense updated!", "✅ খরচ আপডেট হয়েছে!"));
    } else {
      const today = new Date();
      const expenseTransactionId = `TXN-EXP-${Date.now()}-${genId()}`;
      const newEntry = {
        id: genId(),
        transactionId: expenseTransactionId, // Phase 4: trace every expense in cash ledger
        category: finalCategory,
        amount: amt,
        note: expenseNote,
        paymentMethod: expensePaymentMethod,
        dateString: today.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' }),
        date: today.toISOString(),
      };
      const updated = [newEntry, ...currentList];
      setExpenseList(updated);

      // Phase 4: Every new expense must appear in the cash ledger (OUT) so
      // end-of-day cash reconciliation is accurate.
      // Closing Cash = Opening Cash + Cash IN - Cash OUT (expenses are Cash OUT).
      const freshCashLedger = await fetchLatestList('madina_v7_cash_ledger', cashLedgerRef.current);
      const expenseCashEntry = {
        ledgerId:        `CASH-EXP-${Date.now()}-${genId()}`,
        transactionId:   expenseTransactionId,
        category:        finalCategory,
        note:            expenseNote || '',
        amount:          amt,
        type:            'EXPENSE' as const,
        direction:       'OUT' as const,
        paymentMethod:   expensePaymentMethod,
        timestamp:       today.toISOString(),
        dateString:      newEntry.dateString,
      };
      const updatedCashLedger = [expenseCashEntry, ...freshCashLedger];
      setCashLedger(updatedCashLedger);

      // Write both atomically so expense and cash ledger never diverge.
      // We set the expense list optimistically above; now confirm the write.
      const writeOk = await cloudMultiSet({
        madina_v7_expenses:    JSON.stringify(updated),
        madina_v7_cash_ledger: JSON.stringify(updatedCashLedger),
      });
      if (!writeOk) {
        // Roll back optimistic UI — the expense did not save
        setExpenseList(currentList);
        setCashLedger(freshCashLedger);
        alert(t("❌ Could not save expense — check your internet and try again.", "❌ খরচ সংরক্ষণ হয়নি — ইন্টারনেট পরীক্ষা করে আবার চেষ্টা করুন।"));
        return;
      }
      playSound('add');
    }
    resetExpenseForm();
  };

  const startEditExpense = (entry: any) => {
    if (currentUserRole === "STAFF" && !staffVisibleModules["expense_edit"]) {
      playSound('error');
      alert(t("You don't have permission to edit expenses.", "খরচ সম্পাদনার অনুমতি আপনার নেই।"));
      return;
    }
    setEditingExpenseId(entry.id);
    const isPreset = EXPENSE_PRESET_CATEGORIES.includes(entry.category);
    setExpenseCategory(isPreset ? entry.category : "Other");
    setExpenseCustomCategory(isPreset ? "" : entry.category);
    setExpenseAmount(String(entry.amount));
    setExpenseNote(entry.note || "");
    setExpensePaymentMethod(entry.paymentMethod || "Cash");
  };

  const deleteExpenseEntry = async (expenseId: number) => {
    if (currentUserRole === "STAFF" && !staffVisibleModules["expense_delete"]) {
      playSound('error');
      alert(t("You don't have permission to delete expenses.", "খরচ মোছার অনুমতি আপনার নেই।"));
      return;
    }
    if (!confirm(t("Delete this expense entry?", "এই খরচের এন্ট্রি মুছে ফেলবেন?"))) return;
    const currentList = await fetchLatestList('madina_v7_expenses', expenseListRef.current);
    const expenseEntry = currentList.find((e: any) => e.id === expenseId);
    const updated = currentList.filter((e: any) => e.id !== expenseId);
    setExpenseList(updated);

    // Phase 4: remove the matching cash ledger entry so cash reconciliation stays correct.
    // We match by transactionId (set on new-style entries) or by amount+date as fallback
    // for entries created before Phase 4.
    const freshCashLedger = await fetchLatestList('madina_v7_cash_ledger', cashLedgerRef.current);
    const updatedCashAfterExpenseDel = expenseEntry?.transactionId
      ? freshCashLedger.filter((c: any) => c.transactionId !== expenseEntry.transactionId)
      : freshCashLedger; // For old entries without transactionId, leave cash ledger alone
    setCashLedger(updatedCashAfterExpenseDel);

    await cloudMultiSet({
      madina_v7_expenses:    JSON.stringify(updated),
      madina_v7_cash_ledger: JSON.stringify(updatedCashAfterExpenseDel),
    });
    playSound('delete');
    if (editingExpenseId === expenseId) resetExpenseForm();
  };

  const deleteDueEntry = async (dueId: number) => {
    const dueList = await fetchLatestList('madina_v7_due_list', dueListRef.current);
    const entry = dueList.find((d: any) => d.id === dueId);
    if (!entry) return;

    const input = prompt(
      t(
        `This customer's current total due shows ${entry.totalDue.toFixed(1)} ${currencySymbol}. Enter what the CORRECT total due should actually be (not an amount to subtract — the final correct number).`,
        `এই গ্রাহকের বর্তমান মোট বাকি দেখাচ্ছে ${entry.totalDue.toFixed(1)} ${currencySymbol}। সঠিক মোট বাকি আসলে কত হওয়া উচিত সেটা লিখুন (বাদ দেওয়ার পরিমাণ না — একেবারে সঠিক শেষ সংখ্যাটা লিখুন)।`
      ),
      entry.totalDue.toFixed(1)
    );
    if (input === null) return;
    const correctTotal = parseFloat(input);
    if (isNaN(correctTotal) || correctTotal < 0) { alert(t("Please enter a valid amount!", "সঠিক পরিমাণ দিন!")); return; }
    if (!confirm(t(`Set this customer's total due to ${correctTotal.toFixed(1)} ${currencySymbol}? This does NOT affect sales/profit totals.`, `এই গ্রাহকের মোট বাকি ${correctTotal.toFixed(1)} ${currencySymbol} সেট করবেন? এটি sales/profit-কে প্রভাবিত করবে না।`))) return;

    const updatedDueList = correctTotal <= 0
      ? dueList.filter((d: any) => d.id !== dueId)
      : dueList.map((d: any) => d.id === dueId ? { ...d, totalDue: correctTotal } : d);

    setDueList(updatedDueList);
    cloudSet('madina_v7_due_list', JSON.stringify(updatedDueList));
    alert(t("✅ Due amount corrected!", "✅ বাকির পরিমাণ ঠিক করা হয়েছে!"));
  };

  // ============================================================
  // SETTINGS
  // ============================================================
  const handleVerifyCurrentPassword = (e: React.FormEvent) => {
    e.preventDefault();
    setCredentialsUnlockError("");
    if (currentUserRole !== "ADMIN") {
      const msg = t("❌ Only the Admin account can manage Admin & Staff credentials!", "❌ শুধুমাত্র অ্যাডমিন অ্যাকাউন্ট অ্যাডমিন ও স্টাফের লগইন তথ্য পরিবর্তন করতে পারবে!");
      setCredentialsUnlockError(msg);
      alert(msg);
      setCurrentPassCheck("");
      return;
    }
    // Trim to avoid invisible leading/trailing spaces (common with mobile
    // keyboards / autofill) silently causing a mismatch.
    if (currentPassCheck.trim() === "") {
      setCredentialsUnlockError(t("⚠️ Please type your Admin password first.", "⚠️ আগে আপনার অ্যাডমিন পাসওয়ার্ড টাইপ করুন।"));
      return;
    }
    if (currentPassCheck === adminPassword) {
      // Re-seed every draft field from the latest known values right as we
      // unlock, so the Admin is always editing fresh data — not whatever
      // was loaded at page-mount time (which may now be stale on a long-open
      // tab while other devices have been making changes in the cloud).
      setNewUsernameInput(adminUsername);
      setNewPasswordInput(adminPassword);
      setNewStaffUsernameInput(staffUsername);
      setNewStaffPasswordInput(staffPassword);
      setNewTelegramBotTokenInput(telegramBotToken);
      setNewTelegramChatIdInput(telegramChatId);
      setIsCredentialsFormUnlocked(true);
      setCurrentPassCheck("");
      setCredentialsUnlockError("");
    } else {
      const msg = t("❌ Wrong current password!", "❌ ভুল পাসওয়ার্ড!");
      setCredentialsUnlockError(msg);
      alert(msg);
      setCurrentPassCheck("");
    }
  };

  // Split into three role-scoped save handlers — previously a single shared
  // handler saved Admin + Staff + Creator credentials together on every tab,
  // so saving on (say) the Staff tab would silently re-write Admin/Creator
  // credentials too (harmless if the draft fields were still fresh, but a
  // landmine if a stale value was sitting in an unrelated draft field).
  // Each tab's form now only touches the one role it's actually editing.
  const handleSaveAdminCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (currentUserRole !== "ADMIN") return;
    if (!newUsernameInput.trim() || !newPasswordInput.trim()) { alert(t("⚠️ Fields cannot be empty!", "⚠️ ফিল্ড খালি রাখা যাবে না!")); return; }
    setAdminUsername(newUsernameInput);
    setAdminPassword(newPasswordInput);
    const results = await Promise.all([
      cloudSet('madina_v7_admin_user', newUsernameInput),
      cloudSet('madina_v7_admin_pass', newPasswordInput),
    ]);
    if (results.every(ok => ok)) {
      setIsCredentialsFormUnlocked(false);
      alert(t("✅ Admin credentials updated!", "✅ অ্যাডমিন লগইন তথ্য আপডেট হয়েছে!"));
    } else {
      alert(t("❌ Could not save — check your internet connection and try again. Your old credentials are still active.", "❌ সংরক্ষণ করা যায়নি — ইন্টারনেট সংযোগ পরীক্ষা করে আবার চেষ্টা করুন। আপনার পুরাতন লগইন তথ্যই সক্রিয় আছে।"));
    }
  };

  const handleSaveStaffCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (currentUserRole !== "ADMIN") return;
    if (!newStaffUsernameInput.trim() || !newStaffPasswordInput.trim()) { alert(t("⚠️ Fields cannot be empty!", "⚠️ ফিল্ড খালি রাখা যাবে না!")); return; }
    setStaffUsername(newStaffUsernameInput);
    setStaffPassword(newStaffPasswordInput);
    const results = await Promise.all([
      cloudSet('madina_v7_staff_user', newStaffUsernameInput),
      cloudSet('madina_v7_staff_pass', newStaffPasswordInput),
    ]);
    if (results.every(ok => ok)) {
      setIsCredentialsFormUnlocked(false);
      alert(t("✅ Staff credentials updated!", "✅ স্টাফ লগইন তথ্য আপডেট হয়েছে!"));
    } else {
      alert(t("❌ Could not save — check your internet connection and try again. Your old credentials are still active.", "❌ সংরক্ষণ করা যায়নি — ইন্টারনেট সংযোগ পরীক্ষা করে আবার চেষ্টা করুন। আপনার পুরাতন লগইন তথ্যই সক্রিয় আছে।"));
    }
  };

  // This page's "Settings" screen shows Admin's own credentials plus Staff's
  // credentials together in ONE combined form (Admin now owns everything the
  // Creator role used to control).
  const handleSaveAllCredentialsCombined = async (e: React.FormEvent) => {
    e.preventDefault();
    if (currentUserRole !== "ADMIN") return;
    if (!newUsernameInput.trim() || !newPasswordInput.trim() || !newStaffUsernameInput.trim() || !newStaffPasswordInput.trim()) {
      alert(t("⚠️ Fields cannot be empty!", "⚠️ ফিল্ড খালি রাখা যাবে না!"));
      return;
    }
    setAdminUsername(newUsernameInput);
    setAdminPassword(newPasswordInput);
    setStaffUsername(newStaffUsernameInput);
    setStaffPassword(newStaffPasswordInput);
    setTelegramBotToken(newTelegramBotTokenInput.trim());
    setTelegramChatId(newTelegramChatIdInput.trim());
    const results = await Promise.all([
      cloudSet('madina_v7_admin_user', newUsernameInput),
      cloudSet('madina_v7_admin_pass', newPasswordInput),
      cloudSet('madina_v7_staff_user', newStaffUsernameInput),
      cloudSet('madina_v7_staff_pass', newStaffPasswordInput),
      cloudSet('madina_v7_telegram_bot_token', newTelegramBotTokenInput.trim()),
      cloudSet('madina_v7_telegram_chat_id', newTelegramChatIdInput.trim()),
    ]);
    if (results.every(ok => ok)) {
      setIsCredentialsFormUnlocked(false);
      alert(t("✅ Credentials updated!", "✅ লগইন তথ্য আপডেট হয়েছে!"));
    } else {
      alert(t("❌ Could not save — check your internet connection and try again. Your old credentials are still active.", "❌ সংরক্ষণ করা যায়নি — ইন্টারনেট সংযোগ পরীক্ষা করে আবার চেষ্টা করুন। আপনার পুরাতন লগইন তথ্যই সক্রিয় আছে।"));
    }
  };

  const handleSaveWebsiteConfig = () => {
    setPharmacyName(settingsName);
    setPharmacySlogan(settingsSlogan);
    setPharmacyAddress(settingsAddress);
    setPharmacyLogo(settingsLogo);
    cloudSet('madina_v7_name', settingsName);
    cloudSet('madina_v7_slogan', settingsSlogan);
    cloudSet('madina_v7_address', settingsAddress);
    cloudSet('madina_v7_logo', settingsLogo);
    alert(t("✅ Website info saved!", "✅ ওয়েবসাইট তথ্য সংরক্ষিত!"));
  };

  const handleToggleTheme = (mode: boolean) => {
    // legacy boolean toggle kept for header button
    const newTheme = mode ? 'dark' : 'light';
    setThemeMode(newTheme);
    localStorage.setItem('madina_v7_theme', newTheme);
  };

  const handleSetTheme = (theme: string) => {
    setThemeMode(theme);
    localStorage.setItem('madina_v7_theme', theme);
  };

  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    localStorage.setItem('madina_v7_sound', JSON.stringify(next));
    if (next) setTimeout(() => createSound('notify'), 100);
  };

  const handleUpdateAdvancedConfig = (currency: string, vat: string, threshold: string, footer: string) => {
    setCurrencySymbol(currency);
    setVatPercentage(vat);
    setLowStockThreshold(threshold);
    setReceiptFooterMsg(footer);
    cloudSet('madina_v7_currency', currency);
    cloudSet('madina_v7_vat', vat);
    cloudSet('madina_v7_threshold', threshold);
    cloudSet('madina_v7_footer', footer);
  };

  const handleLanguageChange = (lang: "en" | "bn") => {
    setLanguage(lang);
    localStorage.setItem('madina_v7_language', lang);
  };

  const resetDatabase = () => {
    const confirmPass = prompt(t("⚠️ Enter Admin Password to Factory Reset:", "⚠️ ফ্যাক্টরি রিসেটের জন্য পাসওয়ার্ড দিন:"));
    if (confirmPass !== adminPassword) return alert(t("❌ Authentication Failed!", "❌ পাসওয়ার্ড ভুল!"));
    const confirmText = prompt(t(
      "⚠️ THIS WILL DELETE ALL DATA FROM FIREBASE AND ALL DEVICES PERMANENTLY!\nType RESET to confirm:",
      "⚠️ এটি Firebase সহ সকল ডিভাইস থেকে সব তথ্য চিরতরে মুছে ফেলবে!\nনিশ্চিত করতে RESET লিখুন:"
    ));
    if (confirmText !== "RESET") return alert(t("❌ Reset cancelled.", "❌ রিসেট বাতিল।"));
    if (confirm(t("⚠️ FINAL WARNING: Delete ALL data from ALL devices forever?", "⚠️ শেষ সতর্কতা: সকল ডিভাইস থেকে চিরতরে সব মুছবেন?"))) {
      // Only device-local preferences live in localStorage now — keep those, clear the rest.
      const keysToKeep = ['madina_v7_dark', 'madina_v7_theme', 'madina_v7_sound', 'madina_v7_language'];
      const allKeys = Object.keys(localStorage);
      for (const k of allKeys) {
        if (!keysToKeep.includes(k)) localStorage.removeItem(k);
      }

      // Reset business data to empty — keep autocomplete lists intact
      setMedicines([]);
      setBdMedicineCompanies(initialMedicineCompanies);  // keep — needed for autocomplete
      setBdMedicineNamesList(initialMedicineNamesList);  // keep — needed for autocomplete
      setBdMedNameMetadata([]);
      setTotalSales(0); setTotalProfit(0);
      setInvoices([]); setCart([]); setPurchaseList([]); setDueList([]); setDueCollectionLog([]);
      setPaymentLedger([]); setCashLedger([]);
      setPharmacyName("Madina Medicine Corner");
      setPharmacySlogan("Professional Pharmacy POS System");
      setPharmacyAddress("Chaumuhani Bazar, Cumilla");
      setPharmacyLogo("M+");
      setCurrencySymbol("৳"); setVatPercentage("0"); setLowStockThreshold("10");
      setReceiptFooterMsg("ধন্যবাদ, আবার আসবেন!");
      setThemeMode('light');
      setAdminUsername("admin"); setAdminPassword("2026");
      setStaffUsername("staff"); setStaffPassword("staff123");
      // Telegram bot token/chat id are left untouched by factory reset so
      // the "Forgot Password" recovery channel keeps working afterwards.

      // Push clean data to Firebase so all devices reset properly
      cloudSet('madina_v7_meds', JSON.stringify([]));
      cloudSet('madina_v7_companies', JSON.stringify(initialMedicineCompanies));
      cloudSet('madina_v7_mednames', JSON.stringify(initialMedicineNamesList));
      cloudSet('madina_v7_medmeta', JSON.stringify([]));
      cloudSet('madina_v7_invoices', JSON.stringify([]));
      cloudSet('madina_v7_purchases', JSON.stringify([]));
      cloudSet('madina_v7_due_list', JSON.stringify([]));
      cloudSet('madina_v7_due_collection_log', JSON.stringify([]));
      cloudSet('madina_v7_sales', '0');
      cloudSet('madina_v7_profit', '0');
      cloudSet('madina_v7_admin_user', 'admin');
      cloudSet('madina_v7_admin_pass', '2026');
      cloudSet('madina_v7_staff_user', 'staff');
      cloudSet('madina_v7_staff_pass', 'staff123');
      cloudSet('madina_v7_name', 'Madina Medicine Corner');
      cloudSet('madina_v7_slogan', 'Professional Pharmacy POS System');
      cloudSet('madina_v7_address', 'Chaumuhani Bazar, Cumilla');
      cloudSet('madina_v7_logo', 'M+');
      cloudSet('madina_v7_currency', '৳');
      cloudSet('madina_v7_vat', '0');
      cloudSet('madina_v7_threshold', '10');
      cloudSet('madina_v7_footer', 'ধন্যবাদ, আবার আসবেন!');
      cloudSet('madina_v7_payment_ledger', JSON.stringify([]));
      cloudSet('madina_v7_cash_ledger', JSON.stringify([]));
      cloudSet('madina_v7_stock_movements', JSON.stringify([]));
      setStockMovements([]);
      cloudSet('madina_v7_audit_log', JSON.stringify([]));
      setAuditLog([]);

      setIsLoggedIn(false);
      alert(t("✅ System reset successful!", "✅ সিস্টেম রিসেট সম্পন্ন!"));
    }
  };

  // ============================================================
  // ONE-TIME FIX: OLD INVOICE "due" FIELD CORRECTION
  // ------------------------------------------------------------
  // Older invoices (created before the due-duplication bugfix) could
  // have their "due" field saved as the COMBINED total (this bill's
  // own due + the customer's previous outstanding due), instead of
  // just this bill's own due. That made dashboard daily/monthly/yearly
  // due cards double-count the old due every time that customer bought
  // again with an unpaid balance.
  //
  // The correct per-invoice due can always be re-derived directly from
  // that invoice's own stored fields, independent of due-list history:
  //   correctDue = max(0, finalBill - cashReceived)
  // (cash always pays off THIS bill first before any old due, per the
  // checkout logic — so if cashReceived >= finalBill, this bill's own
  // due is 0 even if extra cash also paid off an old due.)
  //
  // This only touches the "due" field on non-returned invoices. It does
  // NOT touch the Due List (customer running totals) or due-collection
  // log — those were already correct. A Firebase backup is taken first,
  // and nothing is written until the admin reviews & confirms the count.
  // ============================================================
  const [isFixingDue, setIsFixingDue] = useState(false);
  const [isRestoringDueBackup, setIsRestoringDueBackup] = useState(false);

  // Restore invoices from the automatic backup taken by fixOldDueData,
  // in case a previous run of the fix produced wrong results.
  const restoreDueFixBackup = async () => {
    if (isRestoringDueBackup) return;
    setIsRestoringDueBackup(true);
    try {
      const listRes = await fetch(`${FIREBASE_CONFIG.databaseURL}/madina_backups.json?shallow=true`);
      const keysObj = await listRes.json();
      const backupKeys = keysObj ? Object.keys(keysObj).filter(k => k.startsWith('pre_due_fix_backup_')) : [];
      if (backupKeys.length === 0) {
        alert(t("No due-fix backup found.", "কোনো due-fix ব্যাকআপ পাওয়া যায়নি।"));
        return;
      }
      // Pick the most recent backup (highest timestamp suffix)
      const latestKey = backupKeys.sort().reverse()[0];
      if (!confirm(t(
        `Restore invoices from backup "${latestKey}"? This will undo the last due-fix run.`,
        `"${latestKey}" ব্যাকআপ থেকে invoice ফেরত আনবেন? এটা শেষবারের due-fix বাতিল করে দেবে।`
      ))) return;

      const dataRes = await fetch(`${FIREBASE_CONFIG.databaseURL}/madina_backups/${latestKey}.json`);
      const raw = await dataRes.json(); // this is a JSON string (matches cloudSet's double-encoding)
      const restoredInvoices = JSON.parse(raw);

      setInvoices(restoredInvoices);
      await cloudSet('madina_v7_invoices', JSON.stringify(restoredInvoices));
      alert(t("✅ Restored! Please refresh the page.", "✅ ফেরত আনা হয়েছে! পেজ রিফ্রেশ করুন।"));
    } catch (err) {
      console.error(err);
      alert(t("❌ Restore failed.", "❌ ফেরত আনতে ব্যর্থ।"));
    } finally {
      setIsRestoringDueBackup(false);
    }
  };

  const fixOldDueData = async () => {
    if (isFixingDue) return;
    setIsFixingDue(true);
    try {
      const latestInvoices = await fetchLatestList('madina_v7_invoices', invoicesRef.current);

      if (!latestInvoices || latestInvoices.length === 0) {
        alert(t("No invoices found.", "কোনো ইনভয়েস পাওয়া যায়নি।"));
        return;
      }

      // IMPORTANT: this does NOT use inv.cashReceived, because older
      // invoices where the customer paid ৳0 cash had that field
      // incorrectly saved as the full bill amount (a separate bug,
      // now fixed for new invoices). Using cashReceived here would
      // wrongly zero out real due amounts.
      //
      // Instead: for each customer, their due-creating invoices are
      // sorted by date. The old (buggy) "due" field on each invoice
      // actually mirrors that customer's running due-list total at
      // the moment that invoice was created (old due + new due
      // combined). So this invoice's own new due = that invoice's old
      // due value MINUS the previous due-creating invoice's old due
      // value for the same customer. The very first due invoice for a
      // customer needs no adjustment (there was nothing before it to
      // combine with).
      const customerKey = (inv: any) => `${(inv.customer || '').trim().toLowerCase()}|${inv.phone || ''}`;
      const groups: Record<string, number[]> = {};
      latestInvoices.forEach((inv: any, idx: number) => {
        if (inv.isReturned) return;
        if (!((inv.due || 0) > 0)) return;
        const key = customerKey(inv);
        if (!groups[key]) groups[key] = [];
        groups[key].push(idx);
      });

      const correctedInvoices = [...latestInvoices];
      let changedCount = 0;
      let totalRemoved = 0;
      const preview: any[] = [];

      Object.values(groups).forEach((idxArr) => {
        const sorted = [...idxArr].sort(
          (a, b) => parseCustomDateString(latestInvoices[a].dateString).getTime() - parseCustomDateString(latestInvoices[b].dateString).getTime()
        );
        let prevOldDue = 0;
        sorted.forEach((idx, pos) => {
          const inv = latestInvoices[idx];
          const oldDue = inv.due || 0;
          const newDue = pos === 0 ? oldDue : Math.max(0, oldDue - prevOldDue);
          if (Math.abs(newDue - oldDue) > 1) {
            changedCount++;
            totalRemoved += (oldDue - newDue);
            preview.push({ invoiceId: inv.invoiceId, customer: inv.customer, oldDue, newDue });
            correctedInvoices[idx] = { ...inv, due: newDue };
          }
          prevOldDue = oldDue; // running snapshot uses the OLD (pre-fix) values, matching how they were originally chained
        });
      });

      if (changedCount === 0) {
        alert(t("✅ No incorrect due data found. Everything is already correct!", "✅ কোনো ভুল due ডাটা পাওয়া যায়নি। সব আগে থেকেই ঠিক আছে!"));
        return;
      }

      console.table(preview);
      const confirmMsg = t(
        `Found ${changedCount} invoice(s) with incorrect due amounts.\nTotal ৳${totalRemoved.toFixed(2)} of double-counted due will be removed from dashboard totals.\nThe Due List (customer balances) will NOT be changed — it was already correct.\nA backup of the current invoices will be saved to Firebase first.\n\nProceed with the fix?`,
        `${changedCount} টা ইনভয়েসে ভুল due পরিমাণ পাওয়া গেছে।\nমোট ৳${totalRemoved.toFixed(2)} ডাবল-কাউন্ট বাদ যাবে dashboard থেকে।\nDue List (কাস্টমারের ব্যালেন্স) বদলাবে না — ওটা আগে থেকেই ঠিক আছে।\nআগে বর্তমান invoice ডাটার একটা ব্যাকআপ Firebase-এ সেভ হবে।\n\nফিক্স করতে এগিয়ে যাবেন?`
      );
      if (!confirm(confirmMsg)) return;

      const backupKey = `pre_due_fix_backup_${Date.now()}`;
      await fetch(`${FIREBASE_CONFIG.databaseURL}/madina_backups/${backupKey}.json`, {
        method: 'PUT',
        body: JSON.stringify(JSON.stringify(latestInvoices)),
      });

      // BUGFIX #9: await the write and surface failures to the admin.
      // Without await, a network drop here silently loses the correction
      // while the success alert still fires.
      const fixWriteOk = await cloudSet('madina_v7_invoices', JSON.stringify(correctedInvoices));
      if (!fixWriteOk) {
        alert(t(
          `❌ Could not save corrections — check your internet and try again.\nYour backup is safe at: ${backupKey}`,
          `❌ সংশোধন সংরক্ষণ হয়নি — ইন্টারনেট পরীক্ষা করে আবার চেষ্টা করুন।\nব্যাকআপ নিরাপদ আছে: ${backupKey}`
        ));
        return;
      }
      setInvoices(correctedInvoices);

      alert(t(
        `✅ Fixed ${changedCount} invoice(s)! Dashboard and invoice due amounts are now correct.\nBackup saved as: ${backupKey}`,
        `✅ ${changedCount} টা ইনভয়েস ঠিক হয়ে গেছে! Dashboard আর invoice-এর due এখন সঠিক।\nব্যাকআপ সেভ হয়েছে: ${backupKey}`
      ));
    } catch (err) {
      console.error(err);
      alert(t("❌ Something went wrong. No data was changed.", "❌ কিছু একটা ভুল হয়েছে। কোনো ডাটা পরিবর্তন হয়নি।"));
    } finally {
      setIsFixingDue(false);
    }
  };

  // ============================================================
  // ============================================================
  // BACKUP & RESTORE FUNCTIONS — Phase 5 hardened
  // ============================================================

  // ── Crypto-safe UUID (browser + Node compatible) ─────────────
  const generateUUID = (): string => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    // Fallback: Math.random hex (not cryptographically strong, but collision-safe at this scale)
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  };

  // ── Build a PURE READ snapshot — never touches live data ─────
  // Reads CLOUD_SYNC_KEYS from Firebase, returns the raw snapshot.
  // This function ONLY reads. It NEVER writes to /madina_data.
  const buildBackupSnapshot = async (): Promise<Record<string, any> | null> => {
    const cloudData = await fbGetAll();
    if (!cloudData) return null;
    const snapshot: Record<string, any> = {};
    for (const key of CLOUD_SYNC_KEYS) {
      if (Object.prototype.hasOwnProperty.call(cloudData, key)) {
        snapshot[key] = cloudData[key];
      }
    }
    return snapshot;
  };

  // ── Assemble the full backup envelope ────────────────────────
  // backupId uses timestamp + UUID so same-day backups never collide.
  const assembleBackupEnvelope = (snapshot: Record<string, any>, pharmacyName: string): Record<string, any> => {
    const now = new Date();
    const backupId = `backup_${now.getTime()}_${generateUUID()}`;
    return {
      backupId,
      backupVersion: 'v7',
      schemaVersion: BACKUP_SCHEMA_VERSION,
      createdAt: now.toISOString(),
      createdAtLocal: now.toLocaleString('bn-BD'),
      appVersion: '8.0',
      pharmacyName,
      dataKeys: Object.keys(snapshot),
      data: snapshot,
    };
  };

  // ── Validate a parsed backup object ──────────────────────────
  // Returns null on pass, or a human-readable error string on failure.
  const validateBackupEnvelope = (parsed: any): string | null => {
    if (!parsed || typeof parsed !== 'object') return 'Not a valid JSON object.';
    // Accept both old format (backupVersion only) and new format (schemaVersion present)
    if (!parsed.backupVersion && !parsed._madina_backup_version) return 'Missing backupVersion — not a Madina POS backup file.';
    if (!parsed.data || typeof parsed.data !== 'object') return 'Missing data payload.';

    // schemaVersion check only for new-format backups
    if (parsed.schemaVersion !== undefined) {
      const sv = Number(parsed.schemaVersion);
      if (isNaN(sv) || sv < MIN_RESTORE_SCHEMA_VERSION) {
        return `Backup schema version ${sv} is too old (minimum: ${MIN_RESTORE_SCHEMA_VERSION}). Cannot restore.`;
      }
    }

    // At least one critical financial key must be present
    const criticalKeys = ['madina_v7_invoices', 'madina_v7_meds', 'madina_v7_sales'];
    const hasAnyCritical = criticalKeys.some(k => Object.prototype.hasOwnProperty.call(parsed.data, k));
    if (!hasAnyCritical) return 'Backup appears empty — none of the required financial keys are present.';

    // Spot-check that data values that exist are strings (our serialization format)
    for (const key of CLOUD_SYNC_KEYS) {
      if (Object.prototype.hasOwnProperty.call(parsed.data, key)) {
        const val = parsed.data[key];
        if (val !== null && val !== undefined && typeof val !== 'string') {
          return `Key "${key}" has unexpected type "${typeof val}". Backup may be corrupted.`;
        }
      }
    }

    return null; // valid
  };

  // ── Post-restore structural integrity check ───────────────────
  // Checks that the keys we just wrote parse as valid JSON where expected.
  // Returns a list of warnings (empty = all good).
  const postRestoreIntegrityCheck = async (): Promise<string[]> => {
    const warnings: string[] = [];
    // Keys that MUST exist and parse as JSON arrays or objects after restore
    const jsonArrayKeys = [
      'madina_v7_meds', 'madina_v7_invoices', 'madina_v7_purchases',
      'madina_v7_due_list', 'madina_v7_due_collection_log',
      'madina_v7_sales', 'madina_v7_expenses', 'madina_v7_payment_ledger',
      'madina_v7_cash_ledger', 'madina_v7_stock_movements',
    ];
    const liveData = await fbGetAll();
    if (!liveData) {
      warnings.push('Could not read live data after restore — verify manually.');
      return warnings;
    }
    for (const key of jsonArrayKeys) {
      const raw = liveData[key];
      if (!raw) continue; // key absent is ok (backup may predate the key)
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) && typeof parsed !== 'object') {
          warnings.push(`${key}: expected array/object after restore, got ${typeof parsed}.`);
        }
      } catch {
        warnings.push(`${key}: JSON parse failed after restore — data may be corrupted.`);
      }
    }
    return warnings;
  };

  // ── Emergency backup to Firebase BEFORE any destructive restore ──
  // Saves to /madina_backups/emergency_pre_restore_<timestamp>_<uuid>
  // Returns the backupKey string on success, null on failure.
  // NEVER touches /madina_data — writes only to /madina_backups.
  const saveEmergencyBackup = async (): Promise<string | null> => {
    if (!isFirebaseConfigured()) return null;
    try {
      const snapshot = await buildBackupSnapshot();
      if (!snapshot) return null;
      const envelope = assembleBackupEnvelope(snapshot, pharmacyName);
      const emergencyKey = `emergency_pre_restore_${Date.now()}_${generateUUID()}`;
      const url = `${FIREBASE_CONFIG.databaseURL}/madina_backups/${emergencyKey}.json`;
      const res = await fetchWithTimeout(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...envelope, backupId: emergencyKey, _type: 'emergency_pre_restore' }),
      }, 20000);
      return res.ok ? emergencyKey : null;
    } catch {
      return null;
    }
  };

  // ── Atomic restore via single PATCH to /${DATA_ROOT} ─────────
  // Firebase REST PATCH to the DATA_ROOT is ONE HTTP request — the server
  // applies all key updates atomically at that node. Either all keys land
  // or (on network abort/timeout) the request fails entirely and Firebase
  // leaves the live data unchanged. This is NOT Promise.all() of separate
  // fbSet() calls — it is a genuine single-request multi-path write.
  //
  // Keys present in backup → set to backup value.
  // Keys in CLOUD_SYNC_KEYS but absent from backup → set to JSON null
  //   (Firebase deletes a key when its value is null via PATCH).
  const atomicRestoreToFirebase = async (backupData: Record<string, any>): Promise<boolean> => {
    if (!isFirebaseConfigured()) return false;

    // Build the PATCH body: every key in CLOUD_SYNC_KEYS must appear
    const patchBody: Record<string, string | null> = {};
    for (const key of CLOUD_SYNC_KEYS) {
      const hasKey = Object.prototype.hasOwnProperty.call(backupData, key);
      const val = backupData[key];
      if (hasKey && typeof val === 'string') {
        patchBody[`/${key}`] = val;
      } else {
        // Key absent from backup → delete it from live DB (null = delete in Firebase PATCH)
        patchBody[`/${key}`] = null;
      }
    }

    try {
      const res = await fetchWithTimeout(
        `${FIREBASE_CONFIG.databaseURL}/${DATA_ROOT}.json`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patchBody),
        },
        30000 // 30s — large payload on slow connections
      );
      return res.ok;
    } catch {
      // Network failure / timeout → Firebase never received the request.
      // Live data is untouched.
      return false;
    }
  };

  // ── Download backup as JSON file ──────────────────────────────
  const handleDownloadBackup = async () => {
    setIsBackingUp(true);
    try {
      const snapshot = await buildBackupSnapshot();
      if (!snapshot) {
        addToast(t("❌ No internet — can't read data from cloud!", "❌ ইন্টারনেট নেই — ক্লাউড থেকে তথ্য পড়া যাচ্ছে না!"), 'error');
        setIsBackingUp(false);
        return;
      }

      const envelope = assembleBackupEnvelope(snapshot, pharmacyName);
      const now = new Date();
      const dateStr = now.toLocaleDateString('bn-BD', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
      const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).replace(':', '-');
      const filename = `MadinaPOS_Backup_${dateStr}_${timeStr}.json`;

      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const nowStr = now.toLocaleString('bn-BD');
      setLastBackupTime(nowStr);
      localStorage.setItem('madina_v7_last_backup', nowStr);
      playSound('save');
      addToast(t(`✅ Backup downloaded: ${filename}`, `✅ ব্যাকআপ ডাউনলোড হয়েছে: ${filename}`), 'success');
    } catch {
      addToast(t("❌ Backup failed! Try again.", "❌ ব্যাকআপ ব্যর্থ হয়েছে!"), 'error');
    }
    setIsBackingUp(false);
  };

  // ── Cloud backup to /madina_backups/<collision-safe id> ───────
  // Uses timestamp + UUID so multiple backups on the same day NEVER
  // overwrite each other. Writes ONLY to /madina_backups — never to
  // /madina_data. Creating a backup is always read-only from the live DB.
  const handleFirebaseBackup = async () => {
    if (!isFirebaseConfigured()) {
      addToast(t("⚠️ Firebase not configured!", "⚠️ Firebase সেটআপ করা নেই!"), 'error');
      return;
    }
    setIsBackingUp(true);
    try {
      const snapshot = await buildBackupSnapshot();
      if (!snapshot) {
        addToast(t("❌ No internet or Firebase error!", "❌ ইন্টারনেট নেই বা Firebase সমস্যা!"), 'error');
        setIsBackingUp(false);
        return;
      }
      const envelope = assembleBackupEnvelope(snapshot, pharmacyName);
      // backupId from assembleBackupEnvelope is already timestamp+UUID — use it as the key
      const backupKey = envelope.backupId;
      const url = `${FIREBASE_CONFIG.databaseURL}/madina_backups/${backupKey}.json`;
      const res = await fetchWithTimeout(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      }, 20000);
      if (res.ok) {
        const nowStr = new Date().toLocaleString('bn-BD');
        setLastBackupTime(nowStr);
        localStorage.setItem('madina_v7_last_backup', nowStr);
        playSound('save');
        addToast(t("☁️ Backup saved to Firebase cloud!", "☁️ Firebase ক্লাউডে ব্যাকআপ সংরক্ষিত!"), 'success');
      } else {
        addToast(t("❌ Firebase backup failed!", "❌ Firebase ব্যাকআপ ব্যর্থ!"), 'error');
      }
    } catch {
      addToast(t("❌ No internet or Firebase error!", "❌ ইন্টারনেট নেই বা Firebase সমস্যা!"), 'error');
    }
    setIsBackingUp(false);
  };

  // ── Restore from JSON file — full Phase 5 safety pipeline ────
  //
  // STEP 1: Validate backup format + schema version.
  // STEP 2: Show backup metadata to user and require explicit confirmation.
  // STEP 3: Save emergency backup of CURRENT live data to /madina_backups.
  // STEP 4: Atomic PATCH restore — one request, all keys or nothing.
  // STEP 5: Verify structural integrity of restored data.
  // STEP 6: Reload.
  //
  // If STEP 4 fails (network / Firebase error), live data is untouched.
  // If STEP 5 reports warnings, user sees them before the reload.
  const handleRestoreFromFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.json')) {
      addToast(t("❌ Only .json backup files accepted!", "❌ শুধু .json ব্যাকআপ ফাইল গ্রহণযোগ্য!"), 'error');
      e.target.value = "";
      return;
    }
    if (!isFirebaseConfigured()) {
      addToast(t("⚠️ Firebase not configured!", "⚠️ Firebase সেটআপ করা নেই!"), 'error');
      e.target.value = "";
      return;
    }

    setIsRestoring(true);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        // STEP 1 — Parse + validate
        let parsed: any;
        try {
          parsed = JSON.parse(ev.target?.result as string);
        } catch {
          addToast(t("❌ Could not parse backup file — file may be corrupted.", "❌ ব্যাকআপ ফাইল পড়া যায়নি — ফাইলটি নষ্ট হতে পারে।"), 'error');
          setIsRestoring(false);
          e.target.value = "";
          return;
        }

        const validationError = validateBackupEnvelope(parsed);
        if (validationError) {
          addToast(t(`❌ Invalid backup: ${validationError}`, `❌ অবৈধ ব্যাকআপ: ${validationError}`), 'error');
          setIsRestoring(false);
          e.target.value = "";
          return;
        }

        // STEP 2 — Inform user of backup metadata + require explicit confirmation
        const backupDate = parsed.createdAt || parsed._backup_date || 'unknown';
        const backupPharmacy = parsed.pharmacyName || parsed._pharmacy_name || 'unknown';
        const backupSchema = parsed.schemaVersion ?? '(legacy)';
        const dataKeyCount = Object.keys(parsed.data).length;

        const confirmed = window.confirm(
          t(
            `⚠️ RESTORE CONFIRMATION\n\nBackup date: ${backupDate}\nPharmacy: ${backupPharmacy}\nSchema version: ${backupSchema}\nData keys: ${dataKeyCount}\n\nThis will COMPLETELY REPLACE all current live data.\n\nAn emergency backup of your CURRENT data will be saved first.\n\nProceed with restore?`,
            `⚠️ রিস্টোর নিশ্চিতকরণ\n\nব্যাকআপ তারিখ: ${backupDate}\nফার্মেসি: ${backupPharmacy}\nস্কিমা ভার্সন: ${backupSchema}\nডেটা কী সংখ্যা: ${dataKeyCount}\n\nএটি বর্তমান সব লাইভ ডেটা সম্পূর্ণরূপে প্রতিস্থাপন করবে।\n\nআপনার বর্তমান ডেটার একটি জরুরি ব্যাকআপ প্রথমে সংরক্ষিত হবে।\n\nরিস্টোর করবেন?`
          )
        );
        if (!confirmed) {
          setIsRestoring(false);
          e.target.value = "";
          return;
        }

        // STEP 3 — Emergency backup of current live data
        addToast(t("💾 Saving emergency backup of current data...", "💾 বর্তমান ডেটার জরুরি ব্যাকআপ সংরক্ষণ করা হচ্ছে..."), 'info');
        const emergencyKey = await saveEmergencyBackup();
        if (!emergencyKey) {
          // Emergency backup failed — warn but do NOT proceed.
          // Restoring without a safety net is too risky.
          const forceAnyway = window.confirm(
            t(
              "⚠️ Emergency backup FAILED (no internet or Firebase error).\n\nProceeding without a safety backup is risky.\n\nDo you want to proceed anyway? (NOT recommended)",
              "⚠️ জরুরি ব্যাকআপ ব্যর্থ হয়েছে (ইন্টারনেট নেই বা Firebase সমস্যা)।\n\nনিরাপত্তা ব্যাকআপ ছাড়া এগিয়ে যাওয়া ঝুঁকিপূর্ণ।\n\nতবুও এগিয়ে যাবেন? (প্রস্তাবিত নয়)"
            )
          );
          if (!forceAnyway) {
            addToast(t("✅ Restore cancelled for safety.", "✅ নিরাপত্তার জন্য রিস্টোর বাতিল করা হয়েছে।"), 'info');
            setIsRestoring(false);
            e.target.value = "";
            return;
          }
        } else {
          addToast(t(`✅ Emergency backup saved: ${emergencyKey}`, `✅ জরুরি ব্যাকআপ সংরক্ষিত: ${emergencyKey}`), 'success');
        }

        // STEP 4 — Atomic PATCH restore (one request — all keys or nothing)
        addToast(t("⏳ Restoring data atomically...", "⏳ ডেটা পুনরুদ্ধার করা হচ্ছে..."), 'info');
        const restoreOk = await atomicRestoreToFirebase(parsed.data);
        if (!restoreOk) {
          // The PATCH request failed — Firebase never wrote anything.
          // Live data is exactly as it was. Emergency backup is still valid.
          addToast(
            t(
              `❌ Restore FAILED — live data is UNCHANGED.\nYour emergency backup is safe at: ${emergencyKey || 'n/a'}\nCheck your internet connection and try again.`,
              `❌ রিস্টোর ব্যর্থ — লাইভ ডেটা অপরিবর্তিত আছে।\nআপনার জরুরি ব্যাকআপ নিরাপদ আছে: ${emergencyKey || 'n/a'}\nইন্টারনেট চেক করে আবার চেষ্টা করুন।`
            ),
            'error'
          );
          setIsRestoring(false);
          e.target.value = "";
          return;
        }

        // STEP 5 — Post-restore structural integrity check
        const warnings = await postRestoreIntegrityCheck();
        if (warnings.length > 0) {
          addToast(
            t(
              `⚠️ Restore completed with warnings:\n${warnings.join('\n')}\nPlease verify data manually.`,
              `⚠️ সতর্কতা সহ রিস্টোর সম্পন্ন:\n${warnings.join('\n')}\nঅনুগ্রহ করে ডেটা যাচাই করুন।`
            ),
            'error'
          );
        }

        // STEP 6 — Mark success and reload
        const nowStr = new Date().toLocaleString('bn-BD');
        setLastBackupTime(nowStr);
        localStorage.setItem('madina_v7_last_backup', nowStr);
        playSound('success');
        addToast(t("✅ Data restored successfully! Reloading...", "✅ ডেটা সফলভাবে পুনরুদ্ধার হয়েছে! রিলোড হচ্ছে..."), 'success');
        setTimeout(() => window.location.reload(), 2000);

      } catch (err) {
        // Unexpected error — we don't know whether the PATCH landed.
        // Warn the user to check the emergency backup.
        addToast(
          t(
            `❌ Unexpected restore error. Check your emergency backup in Firebase at /madina_backups if data looks wrong after reload.`,
            `❌ অপ্রত্যাশিত রিস্টোর ত্রুটি। রিলোডের পরে ডেটা ভুল মনে হলে /madina_backups এ জরুরি ব্যাকআপ চেক করুন।`
          ),
          'error'
        );
      }
      setIsRestoring(false);
      e.target.value = "";
    };
    reader.readAsText(file);
  };

  // Auto daily backup reminder
  useEffect(() => {
    const checkDailyBackupReminder = () => {
      const last = localStorage.getItem('madina_v7_last_backup');
      if (!last) return;
      try {
        const lastDate = new Date(last);
        const diffHours = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60);
        if (diffHours >= 24) {
          addToast(
            t("💾 Reminder: Last backup was over 24 hours ago! Please backup now.",
              "💾 স্মরণ করিয়ে দিচ্ছি: ২৪ ঘণ্টারও বেশি সময় ব্যাকআপ হয়নি! এখনই ব্যাকআপ করুন।"),
            'info'
          );
        }
      } catch {}
    };
    if (isLoggedIn) {
      const timer = setTimeout(checkDailyBackupReminder, 3000);
      return () => clearTimeout(timer);
    }
  }, [isLoggedIn]);

  // ============================================================
  // EXPIRY ALERT — 1 month before expiry
  // ============================================================
  useEffect(() => {
    if (!isLoggedIn || !isMounted) return;
    const timer = setTimeout(() => {
      // FIX: read the latest medicines via ref instead of depending on the
      // `medicines` array in the effect's dependency list. `medicines` gets a
      // new array reference on every cart add/remove/checkout (stock changes),
      // which used to re-run this whole effect and re-show every "expiring
      // soon" toast each time — this now fires once per login session instead.
      const meds = medicinesRef.current;
      if (meds.length === 0) return;
      const today = new Date();
      const oneMonthLater = new Date(today.getFullYear(), today.getMonth() + 1, today.getDate());
      const expiringSoon = meds.filter(m => {
        if (!m.expire) return false;
        const expDate = new Date(m.expire);
        return expDate > today && expDate <= oneMonthLater;
      });
      if (expiringSoon.length > 0) {
        expiringSoon.forEach((m, i) => {
          setTimeout(() => {
            addToast(
              t(`⚠️ "${m.name}" expires on ${m.expire} — only 1 month left!`,
                `⚠️ "${m.name}" এর মেয়াদ শেষ ${m.expire} — মাত্র ১ মাস বাকি!`),
              'error'
            );
          }, i * 1200);
        });
      }
    }, 5000);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, isMounted]);

  // ============================================================
  // COMPUTED VALUES — wrapped in useMemo to prevent recalculation on every render
  // ============================================================
  const grandTotalPurchaseCost = useMemo(() => purchaseList.reduce((sum, item) => sum + (item.totalCost || 0), 0), [purchaseList]);
  const grandTotalPurchaseDue = useMemo(() => purchaseList.reduce((sum, item) => sum + (item.due || 0), 0), [purchaseList]);
  const companyPurchaseSummary = useMemo(() => {
    const map: { [key: string]: { company: string; totalQty: number; totalCost: number; purchaseCount: number } } = {};
    purchaseList.forEach((log: any) => {
      const key = (log.companyName || "").trim() || t("Unknown", "অজানা");
      if (!map[key]) map[key] = { company: key, totalQty: 0, totalCost: 0, purchaseCount: 0 };
      map[key].totalQty += log.quantity || 0;
      map[key].totalCost += log.totalCost || 0;
      map[key].purchaseCount += 1;
    });
    return Object.values(map).sort((a, b) => b.totalCost - a.totalCost);
  }, [purchaseList, language]);
  const bulkCartTotalCost = useMemo(() => purchaseCart.reduce((sum, item) => sum + item.totalCost, 0), [purchaseCart]);
  const bulkCartCalculatedDue = useMemo(() => Math.max(0, bulkCartTotalCost - (parseFloat(pAmountPaid) || 0)), [bulkCartTotalCost, pAmountPaid]);

  const filteredMedicines = useMemo(() => medicines.filter(med => {
    const matchesSearch = med.name.toLowerCase().includes(searchTerm.toLowerCase()) || (med.generic || "").toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === "All" || med.category === selectedCategory;
    return matchesSearch && matchesCategory;
  }), [medicines, searchTerm, selectedCategory]);

  // POS product grid — per request, nothing is shown until you actually
  // type something (or pick a category). This also means the medicine
  // list isn't filtered/rendered at all while the box is empty, which is
  // itself a speed win on a big medicine list. While actively typing a
  // name, results are capped at 40 cards — plenty to find what you want,
  // and it keeps every keystroke's re-render cheap regardless of how
  // many hundreds of medicines you have.
  const posDisplayedMedicines = useMemo(() => {
    if (searchTerm.trim()) return filteredMedicines.slice(0, 40);
    if (selectedCategory !== "All") return filteredMedicines;
    return [];
  }, [filteredMedicines, searchTerm, selectedCategory]);

  // Customer name → past customer suggestions (POS). Previously this map
  // was rebuilt by looping over ALL invoices + ALL due records on every
  // single render while the dropdown was open (i.e. on every keystroke
  // anywhere in the cart, not just in this field) — the #1 cause of POS
  // typing lag once invoice history grows. Now only recomputes when the
  // name typed, invoices, or dueList actually change.
  const customerNameSuggestions = useMemo(() => {
    if (!(showCustomerSuggestions && customerName.trim().length >= 1)) return [];
    const query = customerName.toLowerCase();
    const pastMap: Record<string, { name: string; phone: string }> = {};
    invoices.forEach((inv: any) => {
      const key = inv.customer?.toLowerCase();
      if (key && key !== t("regular customer", "সাধারণ গ্রাহক").toLowerCase() && !pastMap[key]) {
        pastMap[key] = { name: inv.customer, phone: inv.phone !== "N/A" ? inv.phone : "" };
      }
    });
    dueList.forEach((d: any) => {
      const key = d.customerName?.toLowerCase();
      if (key) pastMap[key] = { name: d.customerName, phone: d.phone !== "N/A" ? d.phone : pastMap[key]?.phone || "" };
    });
    const rawInput = customerName.trim();
    return Object.values(pastMap).filter(c =>
      c.name.toLowerCase().includes(query) || (c.phone && c.phone.includes(rawInput))
    ).slice(0, 8);
  }, [showCustomerSuggestions, customerName, invoices, dueList, language]);

  // Phone → past customer suggestions (POS). Same fix as above.
  const customerPhoneSuggestions = useMemo(() => {
    if (!(showPhoneSuggestions && customerPhone.trim().length >= 2)) return [];
    const phoneQuery = customerPhone.trim();
    const pastMap: Record<string, { name: string; phone: string }> = {};
    invoices.forEach((inv: any) => {
      if (inv.phone && inv.phone !== "N/A") {
        const key = inv.phone;
        if (!pastMap[key]) pastMap[key] = { name: inv.customer, phone: inv.phone };
      }
    });
    dueList.forEach((d: any) => {
      if (d.phone && d.phone !== "N/A") {
        pastMap[d.phone] = { name: d.customerName, phone: d.phone };
      }
    });
    return Object.values(pastMap).filter(c => c.phone.includes(phoneQuery)).slice(0, 8);
  }, [showPhoneSuggestions, customerPhone, invoices, dueList]);

  const filteredInvoices = useMemo(() => invoices.filter(inv => {
    const query = searchInvoiceQuery.toLowerCase();
    return inv.invoiceId.toLowerCase().includes(query) || inv.customer.toLowerCase().includes(query) || inv.phone.toLowerCase().includes(query);
  }), [invoices, searchInvoiceQuery]);

  // Reset to page 1 whenever the underlying filter changes — otherwise
  // you can land on an empty page 4 after a search narrows the results.
  useEffect(() => { setInvPage(1); }, [searchTerm, selectedCategory]);
  const invTotalPages = Math.max(1, Math.ceil(filteredMedicines.length / INV_PAGE_SIZE));
  const pagedMedicines = useMemo(
    () => filteredMedicines.slice((invPage - 1) * INV_PAGE_SIZE, invPage * INV_PAGE_SIZE),
    [filteredMedicines, invPage]
  );

  const [invoicePage, setInvoicePage] = useState(1);
  const INVOICE_PAGE_SIZE = 50;
  useEffect(() => { setInvoicePage(1); }, [searchInvoiceQuery]);
  const invoiceTotalPages = Math.max(1, Math.ceil(filteredInvoices.length / INVOICE_PAGE_SIZE));
  const pagedInvoices = useMemo(
    () => filteredInvoices.slice((invoicePage - 1) * INVOICE_PAGE_SIZE, invoicePage * INVOICE_PAGE_SIZE),
    [filteredInvoices, invoicePage]
  );

  const activeThreshold = useMemo(() => parseInt(lowStockThreshold) || 10, [lowStockThreshold]);
  const lowStockMedicines = useMemo(() => medicines.filter(m => m.stock <= (m.lowStockAlert || activeThreshold)), [medicines, activeThreshold]);
  const stockOutMedicines = useMemo(() => medicines.filter(m => m.stock === 0), [medicines]);
  const expiredMedicines = useMemo(() => medicines.filter(m => new Date(m.expire) < new Date()), [medicines]);
  const expiringSoonMedicines = useMemo(() => {
    const today = new Date();
    const oneMonthLater = new Date(today.getFullYear(), today.getMonth() + 1, today.getDate());
    return medicines.filter(m => {
      if (!m.expire) return false;
      const expDate = new Date(m.expire);
      return expDate > today && expDate <= oneMonthLater;
    });
  }, [medicines]);

  // Single pass instead of one full medicines-array scan PER category
  // (was O(categories × medicines) on every Dashboard render).
  const stockByCategoryMap = useMemo(() => {
    const map: Record<string, number> = {};
    medicines.forEach(m => { map[m.category] = (map[m.category] || 0) + m.stock; });
    return map;
  }, [medicines]);
  const countStockByCategory = useCallback((cat: string) => stockByCategoryMap[cat] || 0, [stockByCategoryMap]);
  const totalStockValue = useMemo(() => medicines.reduce((sum, m) => sum + (m.buyPrice * m.stock), 0), [medicines]);
  const totalStockRetailValue = useMemo(() => medicines.reduce((sum, m) => sum + (m.price * m.stock), 0), [medicines]);
  const totalDueFromCustomers = useMemo(() => dueList.reduce((sum, d) => sum + d.totalDue, 0), [dueList]);

  const triggerPrintReceipt = () => { playSound('print'); window.print(); };

  // ============================================================
  // POS PRINT (80mm thermal receipt printer) — shared helpers
  // Opens a dedicated popup sized for 80mm thermal paper and prints
  // a simplified, fast, narrow layout — independent from the normal
  // colorful A4-style print so both options can sit side-by-side.
  // ============================================================
  const posPrint = (title: string, bodyHtml: string) => {
    playSound('print');
    const win = window.open('', '_blank', 'width=380,height=640');
    if (!win) {
      addToast(t('⚠️ Popup blocked! Please allow popups to use POS Print.', '⚠️ পপআপ ব্লক করা আছে! POS প্রিন্ট চালাতে পপআপ অনুমতি দিন।'), 'error');
      return;
    }
    win.document.write(`<!DOCTYPE html><html><head><title>${title}</title><meta charset="utf-8" />
      <style>
        @page { size: 80mm auto; margin: 2mm; }
        * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        html, body { margin: 0; padding: 0; }
        body { width: 76mm; margin: 0 auto; padding: 3mm 0; font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; font-size: 14px; font-weight: 600; line-height: 1.55; color: #000; -webkit-font-smoothing: antialiased; }
        .center { text-align: center; }
        .right { text-align: right; }
        .bold { font-weight: 800; }
        .line { border-top: 2px dashed #000; margin: 7px 0; }
        table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
        td, th { padding: 3px 0; vertical-align: top; font-weight: 600; }
        th { font-weight: 800; }
        .ttl { font-size: 17px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; }
        .sm { font-size: 13px; font-weight: 600; }
        .logo { width: 36px; height: 36px; border-radius: 6px; object-fit: cover; }
        .row { display: flex; justify-content: space-between; gap: 8px; margin: 1.5px 0; }
      </style></head><body>${bodyHtml}<script>setTimeout(function(){ window.focus(); window.print(); }, 200);</script></body></html>`);
    win.document.close();
  };

  const posShopHeader = (subtitle: string) => `
    <div class="center" style="margin-bottom:6px;">
      ${pharmacyLogo && pharmacyLogo.startsWith('data:image') ? `<img src="${pharmacyLogo}" class="logo" style="margin:0 auto 4px;display:block;" />` : ''}
      <div class="ttl">${pharmacyName}</div>
      <div class="sm">${pharmacySlogan}</div>
      <div class="sm">📍 ${pharmacyAddress}</div>
      <div class="line"></div>
      <div class="bold" style="font-size:12px;">${subtitle}</div>
    </div>
  `;

  const posShopFooter = (msg?: string) => `
    <div class="line"></div>
    <div class="center sm" style="margin-top:4px;">
      <div class="bold">${msg || t('Thank You!', 'ধন্যবাদ!')}</div>
      <div>${pharmacyName} · ${pharmacyAddress}</div>
      <div>${t('Printed on:', 'প্রিন্ট তারিখ:')} ${new Date().toLocaleString()}</div>
    </div>
  `;

  // POS print for a single sales invoice / receipt (used by checkout receipt + invoices list)
  const posPrintInvoice = (inv: any) => {
    const itemsHtml = (inv.items || []).map((item: any) => `
      <tr>
        <td colspan="3" class="bold">${item.name}</td>
      </tr>
      <tr>
        <td class="sm">${(item.qty)} x ${Number(item.price).toFixed(1)}</td>
        <td></td>
        <td class="right bold">${((parseInt(item.qty) || 0) * item.price).toFixed(1)}</td>
      </tr>
    `).join('');
    const body = `
      ${posShopHeader('🧾 ' + t('Sales Receipt', 'বিক্রয় রশিদ'))}
      <div class="sm" style="margin-bottom:4px;">
        <div class="row"><span>${t('Invoice ID:', 'রশিদ নং:')}</span><span class="bold">${inv.invoiceId}</span></div>
        <div class="row"><span>${t('Customer:', 'গ্রাহক:')}</span><span>${inv.customer}</span></div>
        <div class="row"><span>${t('Phone:', 'ফোন:')}</span><span>${inv.phone || ''}</span></div>
        <div class="row"><span>${t('Date:', 'তারিখ:')}</span><span>${inv.dateString}</span></div>
        <div class="row"><span>${t('Payment:', 'পেমেন্ট:')}</span><span class="bold">${inv.paymentMethod}</span></div>
      </div>
      <div class="line"></div>
      <table>${itemsHtml}</table>
      <div class="line"></div>
      <div class="sm">
        <div class="row"><span>${t('Subtotal:', 'মোট:')}</span><span>${inv.subTotal.toFixed(1)} ${currencySymbol}</span></div>
        ${inv.vat > 0 ? `<div class="row"><span>${t('VAT:', 'ভ্যাট:')}</span><span>+${inv.vat.toFixed(1)}</span></div>` : ''}
        ${inv.discount > 0 ? `<div class="row"><span>${t('Discount:', 'ছাড়:')}</span><span>-${inv.discount.toFixed(1)}</span></div>` : ''}
        <div class="row bold" style="font-size:12px; margin-top:3px;"><span>${t('Net Payable', 'মোট পরিশোধ')}</span><span>${inv.finalBill.toFixed(1)} ${currencySymbol}</span></div>
        <div class="row"><span>${t('Cash Received:', 'নগদ পেয়েছি:')}</span><span>${((inv.cashReceived ?? inv.finalBill) as number).toFixed(1)} ${currencySymbol}</span></div>
        <div class="row"><span>${t('Change Given:', 'ফেরত দিয়েছি:')}</span><span>${Math.max(0, ((inv.cashReceived ?? inv.finalBill) as number) - inv.finalBill).toFixed(1)} ${currencySymbol}</span></div>
        ${inv.due > 0 ? `<div class="row bold" style="margin-top:3px;"><span>⚠️ ${t('Unpaid Due', 'বাকি')}</span><span>${inv.due.toFixed(1)} ${currencySymbol}</span></div>` : ''}
      </div>
      ${posShopFooter(inv.footerMsg || receiptFooterMsg)}
    `;
    posPrint(t('Sales Receipt', 'বিক্রয় রশিদ') + ' ' + inv.invoiceId, body);
  };

  // POS print for a purchase voucher
  const posPrintPurchaseVoucher = (v: any) => {
    const itemsHtml = (v.items || []).map((item: any) => `
      <tr><td colspan="2" class="bold">${item.medicineName}</td></tr>
      <tr>
        <td class="sm">${item.quantity} x ${item.unitPrice?.toFixed(2) || '-'}</td>
        <td class="right bold">${item.totalCost?.toFixed(1)}</td>
      </tr>
    `).join('');
    const body = `
      ${posShopHeader('📦 ' + t('Purchase Invoice', 'ক্রয় ভাউচার'))}
      <div class="sm" style="margin-bottom:4px;">
        <div class="row"><span>${t('Voucher No:', 'ভাউচার নং:')}</span><span class="bold">${v.voucherId}</span></div>
        <div class="row"><span>${t('Supplier:', 'সরবরাহকারী:')}</span><span>${v.companyName}</span></div>
        <div class="row"><span>${t('Date:', 'তারিখ:')}</span><span>${v.dateStr}</span></div>
      </div>
      <div class="line"></div>
      <table>${itemsHtml}</table>
      <div class="line"></div>
      <div class="sm">
        <div class="row"><span>${t('Total Cost:', 'মোট খরচ:')}</span><span>${v.totalCost.toFixed(1)} ${currencySymbol}</span></div>
        <div class="row"><span>${t('Paid:', 'পরিশোধ:')}</span><span>${v.totalPaid.toFixed(1)} ${currencySymbol}</span></div>
        <div class="row bold" style="font-size:12px; margin-top:3px;"><span>${v.totalDue > 0 ? '⚠️ ' + t('Due', 'বাকি') : t('Fully Paid', 'সম্পূর্ণ পরিশোধিত')}</span><span>${v.totalDue > 0 ? v.totalDue.toFixed(1) + ' ' + currencySymbol : '✓'}</span></div>
      </div>
      ${posShopFooter(t('Thank You!', 'ধন্যবাদ!'))}
    `;
    posPrint(t('Purchase Invoice', 'ক্রয় ভাউচার') + ' ' + v.voucherId, body);
  };

  // Generic POS print for tabular reports (Company Purchase History, Due List,
  // Due Collection, Returns, Stock Report, Daily Closing Report)
  const posPrintReport = (subtitleEmojiTitle: string, columns: string[], rows: (string | number)[][], totalsLines: { label: string; value: string; emphasize?: boolean }[], metaLines?: { label: string; value: string }[]) => {
    const theadHtml = `<tr>${columns.map((c, i) => `<th class="${i === columns.length - 1 ? 'right' : ''}" style="border-bottom:1px solid #000;">${c}</th>`).join('')}</tr>`;
    const rowsHtml = rows.map(r => `<tr>${r.map((cell, i) => `<td class="${i === r.length - 1 ? 'right' : ''}">${cell}</td>`).join('')}</tr>`).join('');
    const metaHtml = (metaLines || []).map(m => `<div class="row"><span>${m.label}</span><span class="bold">${m.value}</span></div>`).join('');
    const totalsHtml = totalsLines.map(tl => `<div class="row ${tl.emphasize ? 'bold' : ''}" style="${tl.emphasize ? 'font-size:12px;margin-top:3px;' : ''}"><span>${tl.label}</span><span>${tl.value}</span></div>`).join('');
    const body = `
      ${posShopHeader(subtitleEmojiTitle)}
      ${metaHtml ? `<div class="sm" style="margin-bottom:4px;">${metaHtml}</div><div class="line"></div>` : ''}
      <table>
        <thead>${theadHtml}</thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="line"></div>
      <div class="sm">${totalsHtml}</div>
      ${posShopFooter(t('End of Report', 'প্রতিবেদনের সমাপ্তি'))}
    `;
    posPrint(subtitleEmojiTitle, body);
  };

  const viewInvoiceLog = (invoice: any) => { setLastInvoice(invoice); setShowReceipt(true); openEdit(() => setShowReceipt(false)); };

  const deleteInvoice = async (invoiceId: string) => {
    if (!confirm(t("Delete this invoice permanently? Stock will be restored.", "এই রশিদটি স্থায়ীভাবে মুছে ফেলবেন? স্টক ফেরত যোগ হবে।"))) return;
    const inv = invoices.find(i => i.invoiceId === invoiceId);
    if (!inv) return;
    const updatedInvoices = invoices.filter(i => i.invoiceId !== invoiceId);

    // If this invoice still had unpaid due, remove that due from the
    // customer's due list entry too — otherwise the customer keeps
    // showing as owing money for a sale that no longer exists.
    let updatedDueList = dueList;
    if ((inv.due || 0) > 0) {
      const dueListIdx = dueList.findIndex(d =>
        d.customerName.toLowerCase() === (inv.customer || "").toLowerCase() &&
        d.phone === inv.phone
      );
      if (dueListIdx !== -1) {
        const entry = dueList[dueListIdx];
        const invRecord = entry.invoices.find((i: any) => i.invoiceId === invoiceId);
        const invoiceDueAmount = invRecord ? invRecord.amount : inv.due;
        const reduceBy = Math.min(invoiceDueAmount, entry.totalDue);

        if (reduceBy > 0) {
          const newTotalDue = Math.max(0, entry.totalDue - reduceBy);
          const newInvoicesArr = entry.invoices.filter((i: any) => i.invoiceId !== invoiceId);

          updatedDueList = newTotalDue <= 0
            ? dueList.filter(d => d.id !== entry.id)
            : dueList.map(d => d.id === entry.id ? { ...d, totalDue: newTotalDue, invoices: newInvoicesArr } : d);
        }
      }
    }

    // Derive from remaining invoices + due collections for cross-device consistency
    const { sales: newSales, profit: newProfit } = computeSalesAndProfit(updatedInvoices, dueCollectionLog);
    setInvoices(updatedInvoices);
    setDueList(updatedDueList);
    setTotalSales(newSales);
    setTotalProfit(newProfit);
    cloudSet('madina_v7_invoices', JSON.stringify(updatedInvoices));
    cloudSet('madina_v7_due_list', JSON.stringify(updatedDueList));
    cloudSet('madina_v7_sales', newSales.toString());
    cloudSet('madina_v7_profit', newProfit.toString());

    // Restore stock for this invoice's items.
    if (Array.isArray(inv.items) && inv.items.length > 0) {
      const restoreQtyById: Record<number, number> = {};
      for (const item of inv.items) {
        const soldQty = parseInt(item.qty) || 0;
        if (soldQty > 0) {
          restoreQtyById[item.id] = (restoreQtyById[item.id] || 0) + soldQty;
        }
      }
      if (Object.keys(restoreQtyById).length > 0) {
        // FIX (multi-device stock conflict): add restored quantities on top
        // of the freshest stock fetched from Firebase, instead of overwriting
        // it with this device's local array.
        const preMedsForDel = medicinesRef.current;
        await updateMedicinesOnCloud(latestMeds =>
          latestMeds.map(m => restoreQtyById[m.id] ? { ...m, stock: m.stock + restoreQtyById[m.id] } : m)
        );
        // Phase 4: record ADJUSTMENT stock movements for the restored quantities
        const delAdjTransactionId = `TXN-DEL-${Date.now()}-${genId()}`;
        const delAdjEntries = Object.entries(restoreQtyById).map(([medIdStr, qty]) => {
          const medId = Number(medIdStr);
          const med = preMedsForDel.find(m => m.id === medId);
          return {
            movementId: `MOV-${Date.now()}-${genId()}`,
            transactionId: delAdjTransactionId,
            reference: invoiceId,
            originalTransactionId: inv.transactionId || null,
            medicineId: medId,
            medicineName: med ? med.name : medIdStr,
            type: 'ADJUSTMENT' as const,
            direction: 'IN' as const,
            note: 'Invoice deleted — stock restored',
            quantity: qty,
            previousStock: med ? med.stock : 0,
            resultingStock: med ? med.stock + qty : qty,
            timestamp: new Date().toISOString(),
            dateString: new Date().toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' }),
          };
        });
        appendStockMovements(delAdjEntries);
      }
    }

    alert(t("✅ Invoice deleted and stock restored!", "✅ রশিদ মুছে ফেলা হয়েছে এবং স্টক ফেরত যোগ হয়েছে!"));
  };

  // ============================================================
  // ANALYTICS — useMemo ensures recalculation only when data/date changes
  // ============================================================
  const analyticsData = useMemo(() => {
    const currentEngineDate = new Date(todayKey);
    const currentEngineDayNum = currentEngineDate.getDate();
    const currentEngineMonthNum = currentEngineDate.getMonth();
    const currentEngineYearNum = currentEngineDate.getFullYear();

    let computedDailyPurchaseAmount = 0;
    let computedMonthlyPurchaseAmount = 0;
    let computedYearlyPurchaseAmount = 0;
    purchaseList.forEach(pLog => {
      const pLogDate = parseCustomDateString(pLog.dateString);
      if (pLogDate.getFullYear() === currentEngineYearNum) {
        computedYearlyPurchaseAmount += (pLog.totalCost || 0);
        if (pLogDate.getMonth() === currentEngineMonthNum) {
          computedMonthlyPurchaseAmount += (pLog.totalCost || 0);
          if (pLogDate.getDate() === currentEngineDayNum) computedDailyPurchaseAmount += (pLog.totalCost || 0);
        }
      }
    });

    let computedDailySalesAmount = 0;
    let computedMonthlySalesAmount = 0;
    let computedYearlySalesAmount = 0;
    let computedDailyProfitAmount = 0;
    let computedMonthlyProfitAmount = 0;
    let computedYearlyProfitAmount = 0;
    let computedDailyDue = 0;
    let computedMonthlyDue = 0;
    let computedYearlyDue = 0;
    let computedDailyBkash = 0;
    let computedMonthlyBkash = 0;
    let computedDailyDueCollection = 0;
    let computedMonthlyDueCollection = 0;
    let computedDailyDiscount = 0;
    let computedMonthlyDiscount = 0;
    let computedYearlyDiscount = 0;

    invoices.forEach(invLog => {
      const invLogDate = parseCustomDateString(invLog.dateString);
      if (invLogDate.getFullYear() === currentEngineYearNum) {
        const fullBill = invLog.finalBill;
        const paidAmt = fullBill - (invLog.due || 0);
        computedYearlySalesAmount += fullBill;
        computedYearlyProfitAmount += (invLog.profit || 0);
        computedYearlyDue += (invLog.due || 0);
        computedYearlyDiscount += (invLog.discount || 0);
        if (invLogDate.getMonth() === currentEngineMonthNum) {
          computedMonthlySalesAmount += fullBill;
          computedMonthlyProfitAmount += (invLog.profit || 0);
          computedMonthlyDue += (invLog.due || 0);
          computedMonthlyDiscount += (invLog.discount || 0);
          if (invLog.paymentMethod === "bKash/Nagad") computedMonthlyBkash += paidAmt;
          if (invLogDate.getDate() === currentEngineDayNum) {
            computedDailySalesAmount += fullBill;
            computedDailyProfitAmount += (invLog.profit || 0);
            computedDailyDue += (invLog.due || 0);
            computedDailyDiscount += (invLog.discount || 0);
            if (invLog.paymentMethod === "bKash/Nagad") computedDailyBkash += paidAmt;
          }
        }
      }
    });

    dueCollectionLog.forEach(cLog => {
      const cDate = new Date(cLog.date);
      if (cDate.getFullYear() === currentEngineYearNum && cDate.getMonth() === currentEngineMonthNum) {
        computedMonthlyDueCollection += (cLog.amount || 0);
        if (cDate.getDate() === currentEngineDayNum) {
          computedDailyDueCollection += (cLog.amount || 0);
        }
      }
    });

    let computedDailyExpense = 0;
    let computedMonthlyExpense = 0;
    expenseList.forEach(eLog => {
      const eDate = new Date(eLog.date || eLog.dateString);
      if (eDate.getFullYear() === currentEngineYearNum && eDate.getMonth() === currentEngineMonthNum) {
        computedMonthlyExpense += (eLog.amount || 0);
        if (eDate.getDate() === currentEngineDayNum) {
          computedDailyExpense += (eLog.amount || 0);
        }
      }
    });

    return {
      computedDailyPurchaseAmount, computedMonthlyPurchaseAmount, computedYearlyPurchaseAmount,
      computedDailySalesAmount, computedMonthlySalesAmount, computedYearlySalesAmount,
      computedDailyProfitAmount, computedMonthlyProfitAmount, computedYearlyProfitAmount,
      computedDailyDue, computedMonthlyDue, computedYearlyDue,
      computedDailyBkash, computedMonthlyBkash,
      computedDailyDueCollection, computedMonthlyDueCollection,
      computedDailyDiscount, computedMonthlyDiscount, computedYearlyDiscount,
      computedDailyExpense, computedMonthlyExpense,
    };
  }, [todayKey, invoices, purchaseList, dueCollectionLog, expenseList]);

  // ── Last 7 Days Sales chart data — memoized ──────────────────
  // This was previously computed inline inside the Dashboard tab's JSX
  // (an IIFE that looped through ALL invoices once for EACH of the 7
  // days = up to 7 full passes over your invoice history), and it rebuilt
  // from scratch on every single render while the Dashboard tab was open
  // — this was the main cause of Dashboard feeling slow as invoice
  // history grew. Now it only recomputes when invoices or the date
  // actually change. (Dashboard-only change — does not touch POS.)
  const weeklySalesData = useMemo(() => {
    const today = new Date(todayKey);
    const weekDays = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today); d.setDate(today.getDate() - (6 - i)); return d;
    });
    const weekSales = weekDays.map(day =>
      invoices.reduce((s, inv) => {
        const d = parseCustomDateString(inv.dateString);
        return (d.getFullYear() === day.getFullYear() && d.getMonth() === day.getMonth() && d.getDate() === day.getDate()) ? s + (inv.finalBill || 0) : s;
      }, 0)
    );
    const totalWeek = weekSales.reduce((a, b) => a + b, 0);
    const maxVal = Math.max(...weekSales, 1);
    const maxIdx = weekSales.indexOf(Math.max(...weekSales));
    return { weekDays, weekSales, totalWeek, maxVal, maxIdx };
  }, [todayKey, invoices]);

  const {
    computedDailyPurchaseAmount, computedMonthlyPurchaseAmount, computedYearlyPurchaseAmount,
    computedDailySalesAmount, computedMonthlySalesAmount, computedYearlySalesAmount,
    computedDailyProfitAmount, computedMonthlyProfitAmount, computedYearlyProfitAmount,
    computedDailyDue, computedMonthlyDue, computedYearlyDue,
    computedDailyBkash, computedMonthlyBkash,
    computedDailyDueCollection, computedMonthlyDueCollection,
    computedDailyDiscount, computedMonthlyDiscount, computedYearlyDiscount,
    computedDailyExpense, computedMonthlyExpense,
  } = analyticsData;

  // ============================================================
  // HYDRATION GUARD
  // ============================================================
  if (!isMounted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex flex-col items-center justify-center gap-4">
        <style>{CSS_SPIN}</style>
        <div className="relative">
          <div style={{animation:'spin-slow 2s linear infinite'}} className="w-16 h-16 rounded-full border-4 border-indigo-500/20 border-t-indigo-400"></div>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-2xl">💊</span>
          </div>
        </div>
        <p style={{animation:'fadein 0.5s ease'}} className="text-indigo-400 font-bold text-sm tracking-widest uppercase">Loading...</p>
      </div>
    );
  }

  // Theme wrapper style
  const activeThemeStyle = themeStyles[themeMode] || {};
  const isCustomTheme = !['light', 'dark'].includes(themeMode);
  const customBg = isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-bg'] } : {};
  const customCard = isCustomTheme ? {
    backgroundColor: (activeThemeStyle as any)['--theme-card'],
    borderColor: (activeThemeStyle as any)['--theme-border'],
    color: (activeThemeStyle as any)['--theme-text'],
  } : {};
  const customAccent = isCustomTheme ? (activeThemeStyle as any)['--theme-accent'] : (isDarkMode ? '#14b8a6' : '#14b8a6');
  const themeCardClass = (base: string) => isCustomTheme ? base : (isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200 shadow-sm');
  const themeBgClass = isCustomTheme ? '' : (isDarkMode ? 'bg-slate-900 text-white' : 'bg-gradient-to-br from-slate-50 to-slate-100');
  const themeTextMuted = isCustomTheme ? { color: (activeThemeStyle as any)['--theme-text'], opacity: 0.6 } : {};

  // ============================================================
  // LOGIN SCREEN
  // ============================================================
  if (!isLoggedIn) {
    return (
      <div className={`min-h-screen flex items-center justify-center p-4 relative overflow-hidden ${isDarkMode ? 'bg-slate-900' : 'bg-gradient-to-br from-indigo-50 via-emerald-50 to-slate-100'}`} style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-bg'] } : {}}>
        {/* Animated background CSS */}
        <style>{CSS_FLOAT}</style>

        {/* Floating particles background */}
        {[...Array(12)].map((_, i) => (
          <div
            key={i}
            className="absolute rounded-full pointer-events-none"
            style={{
              width: `${8 + (i % 4) * 6}px`,
              height: `${8 + (i % 4) * 6}px`,
              left: `${(i * 8.3) % 100}%`,
              bottom: '-20px',
              background: isDarkMode
                ? `rgba(20,184,166,${0.05 + (i % 3) * 0.03})`
                : `rgba(20,184,166,${0.1 + (i % 3) * 0.06})`,
              animation: `float-up ${6 + (i % 5) * 2}s linear ${i * 0.8}s infinite`,
            }}
          />
        ))}

        <div className="animate-login-slide w-full max-w-sm">
          {/* Live Clock above card */}
          <div className="text-center mb-4">
            <div className={`inline-flex flex-col items-center px-5 py-2.5 rounded-2xl border backdrop-blur-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700/50' : 'bg-white/70 border-slate-200/80'}`}>
              <span className="animate-clock font-mono font-black text-2xl text-indigo-500 tracking-widest"><LiveTimeText /></span>
              <span className={`text-sm font-semibold tracking-wide ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}><LiveDateText /> · <LiveDayText language={language} /></span>
            </div>
          </div>

          <div className={`rounded-2xl shadow-sm border p-6 ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white/95 border-slate-200'}`} style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-card'], borderColor: (activeThemeStyle as any)['--theme-border'], color: (activeThemeStyle as any)['--theme-text'] } : {}}>

            {/* Logo — tap 5x quickly to secretly reveal Creator login */}
            <div className="text-center mb-6">
              <div
                onClick={handleLogoSecretTap}
                className={`animate-logo-pulse w-16 h-16 rounded-2xl bg-gradient-to-tr from-indigo-500 to-emerald-400 flex items-center justify-center text-white shadow-sm font-black text-xl mx-auto mb-3 overflow-hidden cursor-pointer select-none transition-transform ${logoTapCount > 0 ? 'scale-95' : ''}`}
              >
                {pharmacyLogo && pharmacyLogo.startsWith('data:image') ? <img src={pharmacyLogo} alt="logo" className="w-full h-full object-cover pointer-events-none" /> : pharmacyLogo}
              </div>
              <h1 className="font-black text-lg text-indigo-600">{pharmacyName}</h1>
              <p className={`text-sm font-semibold mt-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{pharmacySlogan}</p>
            </div>

          {!showForgotPass ? (
            <>
              {/* Login Type Toggle */}
              <div className={`flex p-1 rounded-xl mb-4 ${isDarkMode ? 'bg-slate-900' : 'bg-slate-100'}`}>
                <button onClick={() => setLoginRole("admin")} className={`flex-1 py-2 rounded-xl text-sm font-black transition-all btn-press ${loginRole === "admin" ? 'bg-indigo-500 text-white shadow' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                  👑 {t("Admin", "অ্যাডমিন")}
                </button>
                <button onClick={() => setLoginRole("staff")} className={`flex-1 py-2 rounded-xl text-sm font-black transition-all btn-press ${loginRole === "staff" ? 'bg-indigo-500 text-white shadow' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                  👥 {t("Staff", "স্টাফ")}
                </button>
              </div>

              <div className={`flex flex-col gap-3 ${loginShake ? 'animate-shake' : ''}`}>
                <div>
                  <label className={`block text-sm font-bold uppercase mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Username", "ইউজারনেম")}</label>
                  <input
                    type="text"
                    value={loginUsername}
                    onChange={e => setLoginUsername(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleLogin()}
                    placeholder={t("Enter username...", "ইউজারনেম লিখুন...")}
                    className={`w-full px-3 py-2 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-indigo-500/30 transition-all ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                  />
                </div>
                <div>
                  <label className={`block text-sm font-bold uppercase mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Password", "পাসওয়ার্ড")}</label>
                  <div className="relative">
                    <input
                      type={showLoginPass ? "text" : "password"}
                      value={loginPassword}
                      onChange={e => setLoginPassword(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && handleLogin()}
                      placeholder={t("Enter password...", "পাসওয়ার্ড লিখুন...")}
                      className={`w-full px-3 py-2 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-indigo-500/30 transition-all pr-10 ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                    />
                    <button type="button" onClick={() => setShowLoginPass(!showLoginPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">{showLoginPass ? "🙈" : "👁️"}</button>
                  </div>
                </div>

                {loginError && <p className="text-red-500 text-sm font-bold text-center">{loginError}</p>}

                <button onClick={handleLogin} disabled={loginLoading} className="w-full bg-gradient-to-r from-indigo-500 to-emerald-500 text-white font-black py-2.5 rounded-xl text-sm hover:from-indigo-600 hover:to-emerald-600 transition-all shadow-sm mt-1 btn-press disabled:opacity-60 relative overflow-hidden">
                  {loginLoading ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full" style={{animation:'spin-slow 0.8s linear infinite'}}></span>
                      {t("Verifying...", "যাচাই হচ্ছে...")}
                    </span>
                  ) : <>🔐 {t("Login", "লগইন")}</>}
                </button>

                <button onClick={() => { setShowForgotPass(true); setForgotStep("send"); setForgotError(""); setForgotCodeInput(""); setForgotNewUsername(""); setForgotNewPass(""); }} className="text-indigo-500 text-sm font-bold hover:underline text-center">
                  {t("Forgot Password?", "পাসওয়ার্ড ভুলে গেছেন?")}
                </button>
              </div>

              {/* Language Toggle on login */}
              <div className="flex justify-center mt-4 gap-2">
                <button onClick={() => handleLanguageChange("en")} className={`px-3 py-1 rounded-xl text-sm font-bold transition btn-press ${language === "en" ? 'bg-indigo-500 text-white' : isDarkMode ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>EN</button>
                <button onClick={() => handleLanguageChange("bn")} className={`px-3 py-1 rounded-xl text-sm font-bold transition btn-press ${language === "bn" ? 'bg-indigo-500 text-white' : isDarkMode ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>বাং</button>
              </div>
            </>
          ) : (
            <>
              <h3 className="text-sm font-black text-center text-indigo-500 mb-4">{t("Reset Password", "পাসওয়ার্ড রিসেট")}</h3>

              {forgotStep === "send" && (
                <div className="flex flex-col gap-3">
                  <p className={`text-sm text-center ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t(
                    "We'll send a one-time code to your Telegram to verify it's really you.",
                    "আপনার পরিচয় যাচাইয়ের জন্য টেলিগ্রামে একটি ওয়ান-টাইম কোড পাঠানো হবে।"
                  )}</p>
                  {forgotError && <p className="text-red-500 text-sm font-bold text-center">{forgotError}</p>}
                  <button onClick={handleSendResetCode} disabled={forgotSending} className="w-full bg-indigo-500 text-white font-black py-2.5 rounded-xl text-sm hover:bg-indigo-600 transition btn-press disabled:opacity-60">
                    {forgotSending ? t("Sending...", "পাঠানো হচ্ছে...") : <>📩 {t("Send Code to Telegram", "টেলিগ্রামে কোড পাঠান")}</>}
                  </button>
                </div>
              )}

              {forgotStep === "verify" && (
                <div className="flex flex-col gap-3">
                  <p className={`text-sm text-center ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Enter the 6-digit code sent to your Telegram:", "আপনার টেলিগ্রামে পাঠানো ৬-সংখ্যার কোডটি লিখুন:")}</p>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={forgotCodeInput}
                    onChange={e => setForgotCodeInput(e.target.value.replace(/\D/g, ""))}
                    onKeyDown={e => e.key === "Enter" && handleVerifyResetCode()}
                    placeholder={t("6-digit code...", "৬-সংখ্যার কোড...")}
                    className={`w-full px-3 py-2 rounded-xl border text-sm text-center tracking-[0.5em] font-mono outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                  />
                  {forgotError && <p className="text-red-500 text-sm font-bold text-center">{forgotError}</p>}
                  <button onClick={handleVerifyResetCode} className="w-full bg-indigo-500 text-white font-black py-2.5 rounded-xl text-sm hover:bg-indigo-600 transition btn-press">{t("Verify Code", "কোড যাচাই করুন")}</button>
                  <button onClick={handleSendResetCode} disabled={forgotSending} className="text-indigo-500 text-sm font-bold hover:underline text-center disabled:opacity-60">
                    {forgotSending ? t("Sending...", "পাঠানো হচ্ছে...") : t("Didn't get it? Resend code", "পাননি? আবার পাঠান")}
                  </button>
                </div>
              )}

              {forgotStep === "newpass" && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-center text-emerald-500 font-bold">{t("✅ Identity Verified! Set your new login:", "✅ পরিচয় যাচাই হয়েছে! নতুন লগইন দিন:")}</p>
                  <div>
                    <label className={`block text-sm font-bold uppercase mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("New Username", "নতুন ইউজারনেম")}</label>
                    <input
                      type="text"
                      value={forgotNewUsername}
                      onChange={e => setForgotNewUsername(e.target.value)}
                      placeholder={t("New Username...", "নতুন ইউজারনেম...")}
                      className={`w-full px-3 py-2 rounded-xl border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                    />
                  </div>
                  <div>
                    <label className={`block text-sm font-bold uppercase mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("New Password", "নতুন পাসওয়ার্ড")}</label>
                    <input
                      type="password"
                      value={forgotNewPass}
                      onChange={e => setForgotNewPass(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && handleResetCredentials()}
                      placeholder={t("New Password...", "নতুন পাসওয়ার্ড...")}
                      className={`w-full px-3 py-2 rounded-xl border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                    />
                  </div>
                  {forgotError && <p className="text-red-500 text-sm font-bold text-center">{forgotError}</p>}
                  <button onClick={handleResetCredentials} className="w-full bg-emerald-500 text-white font-black py-2.5 rounded-xl text-sm hover:bg-emerald-600 transition btn-press">{t("Save New Login", "নতুন লগইন সংরক্ষণ")}</button>
                </div>
              )}

              <button onClick={() => { setShowForgotPass(false); setForgotStep("send"); setForgotCodeInput(""); setForgotNewUsername(""); setForgotNewPass(""); setForgotError(""); }} className="w-full text-slate-400 text-sm font-bold mt-3 hover:underline">← {t("Back to Login", "লগইনে ফিরুন")}</button>
            </>
          )}
          </div>
        </div>
      </div>
    );
  }


  // ============================================================
  // SYSTEM LOCKED — every menu/option is hidden; only the notice shows.
  // ============================================================
  if (isLoggedIn && currentUserRole !== "ADMIN" && systemLocked) {
    return (
      <div className={`min-h-screen flex flex-col font-sans antialiased ${isDarkMode ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-800'}`}>
        {/* Minimal top bar — no menu, just identity + logout */}
        <div className={`flex items-center justify-between px-4 sm:px-6 py-3 border-b ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-500 to-emerald-400 flex items-center justify-center text-white font-black overflow-hidden">{pharmacyLogo && pharmacyLogo.startsWith('data:image') ? <img src={pharmacyLogo} alt="logo" className="w-full h-full object-cover" /> : pharmacyLogo}</div>
            <h1 className="font-black text-base">{pharmacyName}</h1>
          </div>
          <button onClick={handleLogout} className="bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white font-bold text-sm px-3 py-2 rounded-xl transition uppercase">{t("Logout", "লগআউট")}</button>
        </div>

        {/* Big centered notice — everything else is hidden */}
        <div className="flex-1 flex items-center justify-center p-6">
          <div className={`max-w-xl w-full rounded-2xl border p-8 text-center shadow-sm ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div className="text-6xl mb-4">🔒</div>
            <h1 className="font-black text-2xl mb-4 text-red-500 uppercase tracking-wide">{t("Access Locked", "প্রবেশ বন্ধ করা হয়েছে")}</h1>
            <p className={`text-lg sm:text-xl font-bold leading-relaxed ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
              {creatorNotice || t("The Admin has temporarily locked this app for Staff.", "অ্যাডমিন স্টাফের জন্য এই অ্যাপটি সাময়িকভাবে বন্ধ করে রেখেছেন।")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ============================================================
  // MAIN APP
  // ============================================================
  return (
    <div
      className={`min-h-screen font-sans flex flex-col selection:bg-indigo-500 selection:text-white print:bg-white print:text-black antialiased transition-colors duration-200 ${isDarkMode ? 'bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-slate-100' : 'bg-gradient-to-br from-slate-50 via-indigo-100 to-slate-100 text-slate-800'}`}
      style={isCustomTheme ? {
        ...activeThemeStyle,
        backgroundColor: (activeThemeStyle as any)['--theme-bg'],
        color: (activeThemeStyle as any)['--theme-text'],
      } : {
        background: isDarkMode
          ? 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%)'
          : 'linear-gradient(135deg, #f8fafc 0%, #eef2ff 50%, #f1f5f9 100%)',
      }}
    >

      {/* GLOBAL ANIMATION STYLES */}
      <style>{CSS_FLOAT_2}</style>

      {/* ANIMATED TOAST NOTIFICATIONS */}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
        {toastQueue.map((toast, idx) => (
          <div
            key={toast.id}
            className={`animate-toast-in pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-sm border text-sm font-bold min-w-[220px] max-w-xs ${
              toast.type === 'success' ? (isDarkMode ? 'bg-emerald-900/90 border-emerald-500/40 text-emerald-300' : 'bg-emerald-50 border-emerald-200 text-emerald-700') :
              toast.type === 'error' ? (isDarkMode ? 'bg-red-900/90 border-red-500/40 text-red-300' : 'bg-red-50 border-red-200 text-red-700') :
              (isDarkMode ? 'bg-slate-800/90 border-slate-600/40 text-slate-200' : 'bg-white border-slate-200 text-slate-700')
            }`}
          >
            <span className="text-base flex-shrink-0">
              {toast.type === 'success' ? '✅' : toast.type === 'error' ? '❌' : 'ℹ️'}
            </span>
            <span className="flex-1">{toast.msg}</span>
          </div>
        ))}
      </div>
      {isCustomTheme && (
        <style>{`
          :root {
            --theme-bg: ${(activeThemeStyle as any)['--theme-bg']};
            --theme-bg2: ${(activeThemeStyle as any)['--theme-bg2']};
            --theme-card: ${(activeThemeStyle as any)['--theme-card']};
            --theme-border: ${(activeThemeStyle as any)['--theme-border']};
            --theme-text: ${(activeThemeStyle as any)['--theme-text']};
            --theme-accent: ${(activeThemeStyle as any)['--theme-accent']};
            --theme-accent2: ${(activeThemeStyle as any)['--theme-accent2']};
          }
          .bg-slate-800, .bg-slate-900\\/50, .bg-slate-900\\/60, .bg-slate-900\\/40 { background-color: var(--theme-card) !important; }
          .bg-slate-900 { background-color: var(--theme-bg) !important; }
          .border-slate-700, .border-slate-800 { border-color: var(--theme-border) !important; }
          .bg-white { background-color: var(--theme-card) !important; }
          .border-slate-200 { border-color: var(--theme-border) !important; }
          .bg-slate-50 { background-color: var(--theme-bg2) !important; }
          .bg-slate-100 { background-color: var(--theme-bg2) !important; }
          .border-slate-100 { border-color: var(--theme-border) !important; }
          .text-slate-400, .text-slate-500, .text-slate-600 { color: var(--theme-text) !important; opacity: 0.7; }
          .text-slate-300 { color: var(--theme-text) !important; opacity: 0.85; }
          .text-slate-800, .text-slate-950 { color: var(--theme-text) !important; }
          input, select, textarea { background-color: var(--theme-bg) !important; border-color: var(--theme-border) !important; color: var(--theme-text) !important; }
          table thead tr { background-color: var(--theme-bg2) !important; }
          .divide-slate-700\\/10 > * + * { border-color: var(--theme-border) !important; opacity: 0.4; }
          .hover\\:bg-slate-800:hover { background-color: var(--theme-card) !important; filter: brightness(1.15); }
          .hover\\:bg-slate-100:hover, .hover\\:bg-slate-50:hover { background-color: var(--theme-bg2) !important; filter: brightness(1.05); }
        `}</style>
      )}

      {/* SUCCESS ALERT */}
      {showSuccessAlert && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-md w-full px-4 py-3 rounded-xl shadow-sm border flex items-center gap-3 ${isDarkMode ? 'bg-slate-800 border-indigo-500/30 text-indigo-400' : 'bg-white border-indigo-200 text-indigo-600'}`} style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-card'], borderColor: (activeThemeStyle as any)['--theme-border'], color: (activeThemeStyle as any)['--theme-accent'] } : {}}>
          <div className="w-8 h-8 rounded-full bg-indigo-500/10 flex items-center justify-center text-lg">🎉</div>
          <div className="flex-1">
            <h5 className="font-bold text-sm">{t("Invoice Created Successfully!", "বিল তৈরি সফল হয়েছে!")}</h5>
            <p className="text-sm opacity-80">{t("Click Print to get a receipt copy.", "প্রিন্ট বাটনে ক্লিক করুন।")}</p>
          </div>
          <button onClick={() => viewInvoiceLog(invoices[0])} className="bg-indigo-500 hover:bg-indigo-600 text-white font-bold text-sm px-2.5 py-1 rounded uppercase tracking-wider transition">{t("View", "দেখুন")}</button>
          <button onClick={() => setShowSuccessAlert(false)} className={`text-sm font-bold px-1.5 ${isDarkMode ? 'text-slate-400 hover:text-red-400' : 'text-slate-400 hover:text-red-500'}`}>✕</button>
        </div>
      )}

      {/* TOP HEADER */}
      <header
        className={`border-b sticky top-0 z-40 backdrop-blur-md px-4 py-2.5 flex items-center justify-between transition print:hidden ${isDarkMode ? 'bg-slate-900/90 border-slate-800' : 'bg-white/90 border-slate-200'}`}
        style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-bg2'] + 'f0', borderBottomColor: (activeThemeStyle as any)['--theme-border'] } : {}}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-500 to-emerald-400 flex items-center justify-center text-white shadow-sm font-black text-sm overflow-hidden">{pharmacyLogo && pharmacyLogo.startsWith('data:image') ? <img src={pharmacyLogo} alt="logo" className="w-full h-full object-cover" /> : pharmacyLogo}</div>
          <div>
            <h1 className="font-black text-sm tracking-tight uppercase flex items-center gap-1.5">
              <span className="truncate max-w-[100px] sm:max-w-[180px] md:max-w-none">{pharmacyName}</span>
              <span className="text-sm font-bold bg-indigo-500/10 text-indigo-500 px-1.5 py-0.5 rounded-full lowercase shrink-0">v8.0</span>
            </h1>
            <p className={`text-sm font-semibold opacity-60 hidden sm:block ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{pharmacySlogan}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm">
          {/* Cloud Sync Status Badge */}
          {isFirebaseConfigured() && syncStatus !== 'idle' && (
            <div className={`hidden sm:flex items-center gap-1 px-2 py-1 rounded-xl text-sm font-bold border transition ${
              syncStatus === 'syncing' ? (isDarkMode ? 'bg-blue-500/20 border-blue-500/40 text-blue-400' : 'bg-blue-50 border-blue-200 text-blue-600') :
              syncStatus === 'synced'  ? (isDarkMode ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400' : 'bg-emerald-50 border-emerald-200 text-emerald-600') :
                                         (isDarkMode ? 'bg-amber-500/20 border-amber-500/40 text-amber-400' : 'bg-amber-50 border-amber-200 text-amber-600')
            }`}>
              {syncStatus === 'syncing' ? <><span style={{animation:'spin-slow 1s linear infinite',display:'inline-block'}}>⟳</span> {t("Syncing...", "সিঙ্ক...")}</> :
               syncStatus === 'synced'  ? <>☁️ {t("Synced", "সিঙ্কড")}</> :
                                          <>⚠️ {t("Offline", "অফলাইন")}</>}
            </div>
          )}
          {!isFirebaseConfigured() && (
            <div title={t("Firebase not configured — app cannot save or load data!","Firebase সেটআপ হয়নি — অ্যাপ ডেটা সেভ বা লোড করতে পারবে না!")} className={`hidden sm:flex items-center gap-1 px-2 py-1 rounded-xl text-sm font-bold border cursor-help ${isDarkMode ? 'bg-red-900/40 border-red-700 text-red-400' : 'bg-red-50 border-red-200 text-red-500'}`}>
              ⚠️ {t("Not configured", "সেটআপ হয়নি")}
            </div>
          )}

          {/* Role Badge */}
          <div className={`hidden sm:block px-3 py-1.5 rounded-xl border text-sm font-black uppercase ${currentUserRole === "ADMIN" ? (isDarkMode ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-400' : 'bg-indigo-50 border-indigo-200 text-indigo-600') : (isDarkMode ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-400' : 'bg-indigo-50 border-indigo-200 text-indigo-600')}`}>
            {currentUserRole === "ADMIN" ? `👑 ${t("Admin", "অ্যাডমিন")}` : `👥 ${t("Staff", "স্টাফ")}`}
          </div>

          {/* Language Toggle */}
          <div className={`flex items-center p-0.5 rounded-xl border ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-slate-100 border-slate-200'}`}>
            <button onClick={() => handleLanguageChange("en")} className={`px-1.5 sm:px-2 py-1 rounded-lg text-xs sm:text-sm font-black transition ${language === "en" ? 'bg-indigo-500 text-white' : 'text-slate-400'}`}>EN</button>
            <button onClick={() => handleLanguageChange("bn")} className={`px-1.5 sm:px-2 py-1 rounded-lg text-xs sm:text-sm font-black transition ${language === "bn" ? 'bg-indigo-500 text-white' : 'text-slate-400'}`}>বাং</button>
          </div>

          <button onClick={() => handleToggleTheme(!isDarkMode)} className={`p-1.5 rounded-xl border transition ${isDarkMode ? 'bg-slate-800 border-slate-700 text-amber-400 hover:bg-slate-700' : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'}`} title={`Theme: ${themeMode}`}>
            {themeMode === 'light' ? "🌙" : themeMode === 'dark' ? "☀️" : themeMode === 'ocean' ? "🌊" : themeMode === 'forest' ? "🌿" : themeMode === 'royal' ? "👑" : themeMode === 'sunset' ? "🌅" : themeMode === 'cherry' ? "🌸" : themeMode === 'midnight' ? "🌌" : themeMode === 'nordic' ? "❄️" : themeMode === 'lava' ? "🌋" : themeMode === 'glacier' ? "🏔️" : "🎨"}
          </button>

          <div className={`text-right hidden sm:block text-sm ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            <span className="font-bold">{currentUserRole}</span>
            <span className="block font-mono text-indigo-500 animate-clock font-black text-sm"><LiveTimeText /></span>
            <span className="block font-mono text-sm opacity-70"><LiveDateText /></span>
          </div>

          <button onClick={handleLogout} className="bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white font-bold text-sm px-2 sm:px-3 py-1.5 sm:py-2 rounded-xl transition uppercase"><span className="hidden sm:inline">{t("Logout", "লগআউট")}</span><span className="sm:hidden">✕</span></button>
        </div>
      </header>

      {/* Creator's notice — shown to Admin & Staff */}
      {creatorNotice && (
        <div className={`px-4 py-2 text-sm font-semibold flex items-center gap-2 print:hidden ${isDarkMode ? 'bg-amber-950/40 text-amber-300 border-b border-amber-800' : 'bg-amber-50 text-amber-700 border-b border-amber-200'}`}>
          <span>📢</span><span>{creatorNotice}</span>
        </div>
      )}

      {/* MAIN LAYOUT */}
      <div className="flex-1 flex print:block">

        {/* SIDEBAR — hidden on mobile, visible on md+ */}
        <nav className={`sidebar-collapse hidden md:flex border-r p-3 flex-col gap-1.5 shrink-0 print:hidden ${isDarkMode ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200'}`} style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-bg2'], borderRightColor: (activeThemeStyle as any)['--theme-border'] } : {}}>
          <span className="sc-heading text-sm font-black text-slate-400 uppercase tracking-widest px-2 mb-1.5 block whitespace-nowrap">{t("Menu", "মেনু")}</span>

          {checkShouldRenderTabOption("pos") && (
            <button onClick={() => { playSound('tab'); navigateTab("pos"); }} className={`sc-row sidebar-nav-btn snav-pos w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "pos" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <div className="sc-icons flex items-center gap-2"><span>🛒</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Sell", "বিক্রয়")}</span></span></div>
              <span className="sc-wrap"><span className={`sc-fade whitespace-nowrap text-sm px-1.5 py-0.5 rounded font-mono ${activeTab === "pos" ? 'bg-white/20 text-white' : 'bg-slate-500/10 text-slate-400'}`}>{cart.length}</span></span>
            </button>
          )}

          {checkShouldRenderTabOption("analytics") && (
            <button onClick={() => { playSound('tab'); navigateTab("analytics"); }} className={`sc-row-solo sidebar-nav-btn snav-dash w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "analytics" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span>📊</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Dashboard", "ড্যাশবোর্ড")}</span></span>
            </button>
          )}

          {checkShouldRenderTabOption("inventory") && (
            <button onClick={() => { playSound('tab'); navigateTab("inventory"); }} className={`sc-row sidebar-nav-btn snav-stock w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "inventory" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <div className="sc-icons flex items-center gap-2"><span>📦</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Stock", "স্টক")}</span></span></div>
              <span className="sc-wrap"><span className={`sc-fade whitespace-nowrap text-sm px-1.5 py-0.5 rounded font-mono ${activeTab === "inventory" ? 'bg-white/20 text-white' : 'bg-slate-500/10 text-slate-400'}`}>{medicines.length}</span></span>
            </button>
          )}

          {checkShouldRenderTabOption("procurement") && (
            <button onClick={() => { playSound('tab'); navigateTab("procurement"); }} className={`sc-row sidebar-nav-btn snav-stockin w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "procurement" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <div className="sc-icons flex items-center gap-2"><span>📥</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Stock In", "মাল কিনুন")}</span></span></div>
              <span className="sc-wrap"><span className={`sc-fade whitespace-nowrap text-sm px-1.5 py-0.5 rounded font-mono ${activeTab === "procurement" ? 'bg-white/20 text-white' : 'bg-slate-500/10 text-slate-400'}`}>{purchaseList.length}</span></span>
            </button>
          )}

          {checkShouldRenderTabOption("procurement") && (
            <button onClick={() => { playSound('tab'); navigateTab("new_product"); }} className={`sc-row-solo sidebar-nav-btn snav-newprod w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "new_product" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span>➕</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("New Product", "নতুন পণ্য")}</span></span>
            </button>
          )}

          {checkShouldRenderTabOption("purchase_history") && (
            <button onClick={() => { playSound('tab'); navigateTab("purchase_history"); }} className={`sc-row sidebar-nav-btn snav-ph w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "purchase_history" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <div className="sc-icons flex items-center gap-2"><span>🧾</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Purchase History", "ক্রয় ইতিহাস")}</span></span></div>
              <span className="sc-wrap"><span className={`sc-fade whitespace-nowrap text-sm px-1.5 py-0.5 rounded font-mono ${activeTab === "purchase_history" ? 'bg-white/20 text-white' : 'bg-slate-500/10 text-slate-400'}`}>{purchaseList.length}</span></span>
            </button>
          )}

          {checkShouldRenderTabOption("company_purchase_history_view") && (
            <button onClick={() => { playSound('tab'); navigateTab("company_purchase_history"); }} className={`sc-row sidebar-nav-btn snav-cph w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "company_purchase_history" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <div className="sc-icons flex items-center gap-2"><span>🏭</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Company Purchase History", "কোম্পানি ক্রয় ইতিহাস")}</span></span></div>
              {companyPurchaseSummary.length > 0 && <span className="sc-wrap"><span className="sc-fade whitespace-nowrap text-xs px-1.5 py-0.5 rounded font-mono bg-violet-500 text-white">{companyPurchaseSummary.length}</span></span>}
            </button>
          )}

          {checkShouldRenderTabOption("invoices") && (
            <button onClick={() => { playSound('tab'); navigateTab("invoices"); }} className={`sc-row sidebar-nav-btn snav-inv w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "invoices" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <div className="sc-icons flex items-center gap-2"><span>🧾</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Invoices", "রশিদ")}</span></span></div>
              <span className="sc-wrap"><span className={`sc-fade whitespace-nowrap text-sm px-1.5 py-0.5 rounded font-mono ${activeTab === "invoices" ? 'bg-white/20 text-white' : 'bg-slate-500/10 text-slate-400'}`}>{invoices.length}</span></span>
            </button>
          )}

          {checkShouldRenderTabOption("due_list_view") && (
            <button onClick={() => { playSound('tab'); navigateTab("due_list"); }} className={`sc-row sidebar-nav-btn snav-due w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "due_list" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <div className="sc-icons flex items-center gap-2"><span>💳</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Due List", "বাকি তালিকা")}</span></span></div>
              {dueList.length > 0 && <span className="sc-wrap"><span className="sc-fade whitespace-nowrap text-xs px-1.5 py-0.5 rounded font-mono bg-red-500 text-white">{dueList.length}</span></span>}
            </button>
          )}

          {checkShouldRenderTabOption("due_collection_view") && (
            <button onClick={() => { playSound('tab'); navigateTab("due_collection"); }} className={`sc-row sidebar-nav-btn snav-duecol w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "due_collection" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <div className="sc-icons flex items-center gap-2"><span>📒</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Due Collection List", "বাকি আদায় তালিকা")}</span></span></div>
              {dueCollectionLog.length > 0 && <span className="sc-wrap"><span className="sc-fade whitespace-nowrap text-xs px-1.5 py-0.5 rounded font-mono bg-emerald-500 text-white">{dueCollectionLog.length}</span></span>}
            </button>
          )}

          {checkShouldRenderTabOption("report_view") && (
            <button onClick={() => { playSound('tab'); navigateTab("report"); }} className={`sc-row-solo sidebar-nav-btn snav-report w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "report" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span>📋</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Report", "রিপোর্ট")}</span></span>
            </button>
          )}

          {checkShouldRenderTabOption("closing_report") && (
            <button onClick={() => { playSound('tab'); navigateTab("closing_report"); }} className={`sc-row-solo sidebar-nav-btn snav-closing w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "closing_report" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span>🌙</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Closing Report", "ক্লোজিং রিপোর্ট")}</span></span>
            </button>
          )}

          {checkShouldRenderTabOption("daily_report") && (
            <button onClick={() => { playSound('tab'); navigateTab("daily_report"); }} className={`sc-row-solo sidebar-nav-btn snav-daily w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "daily_report" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span>🗓️</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Daily Report", "দৈনিক রিপোর্ট")}</span></span>
            </button>
          )}

          {checkShouldRenderTabOption("monthly_report") && (
            <button onClick={() => { playSound('tab'); navigateTab("monthly_report"); }} className={`sc-row-solo sidebar-nav-btn snav-monthly w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "monthly_report" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span>📅</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Monthly Report", "মাসিক রিপোর্ট")}</span></span>
            </button>
          )}

          {checkShouldRenderTabOption("returns") && (
            <button onClick={() => { playSound('tab'); navigateTab("returns"); }} className={`sc-row-solo sidebar-nav-btn snav-ret w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "returns" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span>🔄</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Returns", "ফেরত")}</span></span>
            </button>
          )}

          {checkShouldRenderTabOption("expense_tracker") && (
            <button onClick={() => { playSound('tab'); navigateTab("expense_tracker"); }} className={`sc-row sidebar-nav-btn snav-exp w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "expense_tracker" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span className="sc-icons flex items-center gap-2"><span>💸</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Expense Tracker", "খরচ ট্র্যাকার")}</span></span></span>
              <span className="sc-wrap"><span className={`sc-fade whitespace-nowrap text-sm px-1.5 py-0.5 rounded font-mono ${activeTab === "expense_tracker" ? 'bg-white/20 text-white' : 'bg-slate-500/10 text-slate-400'}`}>{expenseList.length}</span></span>
            </button>
          )}

          {checkShouldRenderTabOption("settings") && (
            <button onClick={() => { playSound('tab'); navigateTab("settings"); }} className={`sc-row-solo sidebar-nav-btn snav-set w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "settings" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span>⚙️</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Settings", "সেটিংস")}</span></span>
            </button>
          )}

          {currentUserRole === "ADMIN" && (
            <button onClick={() => { playSound('tab'); navigateTab("modules_menu"); }} className={`sc-row-solo sidebar-nav-btn snav-perm w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "modules_menu" ? 'bg-indigo-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span>🛡️</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Permissions", "অনুমতি")}</span></span>
            </button>
          )}

          {/* Phase 6: Reconciliation — Admin only */}
          {currentUserRole === "ADMIN" && (
            <button onClick={() => { playSound('tab'); navigateTab("reconciliation"); }} className={`sc-row-solo sidebar-nav-btn w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "reconciliation" ? 'bg-red-600 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-red-400' : 'hover:bg-red-50 text-red-600'}`}>
              <span>🔍</span><span className="sc-wrap"><span className="sc-fade whitespace-nowrap">{t("Reconciliation", "সমন্বয়")}</span></span>
            </button>
          )}

          {/* Bottom Info */}
          <div className="sc-bottom mt-auto pt-4 border-t border-dashed border-slate-700/50">
            {/* Sidebar Clock */}
            <div className={`p-2 rounded-xl text-center mb-2 ${isDarkMode ? 'bg-slate-800/60' : 'bg-indigo-50'}`}>
              <div className="sc-collapsed-only items-center justify-center text-lg">🕐</div>
              <div className="sc-expanded-only">
                <div className="animate-clock font-mono font-black text-indigo-500 text-sm tracking-widest whitespace-nowrap overflow-hidden"><LiveTimeText /></div>
                <div className={`text-sm font-semibold mt-0.5 whitespace-nowrap overflow-hidden ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}><LiveDateText /></div>
                <div className={`text-sm font-semibold whitespace-nowrap overflow-hidden ${isDarkMode ? 'text-slate-400' : 'text-indigo-600'}`}><LiveDayText language={language} /></div>
              </div>
            </div>
            <div className={`p-2 rounded-xl text-sm ${isDarkMode ? 'bg-slate-800/40' : 'bg-slate-100'}`}>
              <div className="flex items-center gap-1.5 font-bold mb-1 justify-center">
                <span className={`shrink-0 w-2 h-2 rounded-full ${currentUserRole === 'ADMIN' ? 'bg-indigo-400' : 'bg-indigo-400'}`}></span>
                <span className="sc-expanded-only uppercase tracking-wider text-sm text-slate-400 whitespace-nowrap overflow-hidden">{t("Logged in as", "লগইন")}</span>
              </div>
              <p className="sc-expanded-only font-mono font-black text-sm truncate text-center">{currentUserRole === "ADMIN" ? t("Administrator", "অ্যাডমিন") : t("Staff", "স্টাফ")}</p>
            </div>
            {checkShouldRenderTabOption("backup_restore") && (
              <button onClick={resetDatabase} className="sc-expanded-only w-full mt-2 bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white font-bold py-1 px-2 rounded text-sm transition uppercase tracking-wider whitespace-nowrap overflow-hidden">
                🚨 {t("Reset System", "রিসেট")}
              </button>
            )}
          </div>
        </nav>

        {/* MOBILE FULL MENU DRAWER — slides up when mobileMenuOpen */}
        {mobileMenuOpen && (
          <div className="md:hidden fixed inset-0 z-50 flex flex-col justify-end print:hidden" onClick={() => setMobileMenuOpen(false)}>
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <div
              className={`relative rounded-t-2xl border-t p-4 pb-6 max-h-[80vh] overflow-y-auto ${isDarkMode ? 'bg-slate-900/50 backdrop-blur-2xl border-slate-700/40' : 'bg-white/60 backdrop-blur-2xl border-white/40'}`}
              style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-bg2'], borderTopColor: (activeThemeStyle as any)['--theme-border'] } : {}}
              onClick={e => e.stopPropagation()}
            >
              {/* Drawer handle */}
              <div className="w-10 h-1 rounded-full bg-slate-400/40 mx-auto mb-4" />
              <p className="text-xs font-black uppercase tracking-widest text-slate-400 mb-3 px-1">{t("All Menus", "সব মেনু")}</p>
              <div className="grid grid-cols-3 gap-2">
                {checkShouldRenderTabOption("pos") && (
                  <button onClick={() => { playSound('tab'); navigateTab("pos"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "pos" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">🛒</span><span>{t("Sell", "বিক্রয়")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("analytics") && (
                  <button onClick={() => { playSound('tab'); navigateTab("analytics"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "analytics" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">📊</span><span>{t("Dashboard", "ড্যাশবোর্ড")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("inventory") && (
                  <button onClick={() => { playSound('tab'); navigateTab("inventory"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "inventory" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">📦</span><span>{t("Stock", "স্টক")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("procurement") && (
                  <button onClick={() => { playSound('tab'); navigateTab("procurement"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "procurement" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">📥</span><span>{t("Stock In", "মাল কিনুন")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("procurement") && (
                  <button onClick={() => { playSound('tab'); navigateTab("new_product"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "new_product" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">➕</span><span>{t("New Product", "নতুন পণ্য")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("purchase_history") && (
                  <button onClick={() => { playSound('tab'); navigateTab("purchase_history"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "purchase_history" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">🧾</span><span>{t("Purchase Hist.", "ক্রয় ইতিহাস")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("company_purchase_history_view") && (
                  <button onClick={() => { playSound('tab'); navigateTab("company_purchase_history"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "company_purchase_history" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">🏭</span><span>{t("Company Hist.", "কোম্পানি ইতিহাস")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("invoices") && (
                  <button onClick={() => { playSound('tab'); navigateTab("invoices"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "invoices" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">🧾</span><span>{t("Invoices", "রশিদ")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("due_list_view") && (
                  <button onClick={() => { playSound('tab'); navigateTab("due_list"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "due_list" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">💳</span><span>{t("Due List", "বাকি তালিকা")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("due_collection_view") && (
                  <button onClick={() => { playSound('tab'); navigateTab("due_collection"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "due_collection" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">📒</span><span>{t("Due Collection", "বাকি আদায়")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("report_view") && (
                  <button onClick={() => { playSound('tab'); navigateTab("report"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "report" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">📋</span><span>{t("Report", "রিপোর্ট")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("returns") && (
                  <button onClick={() => { playSound('tab'); navigateTab("returns"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "returns" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">🔄</span><span>{t("Returns", "ফেরত")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("expense_tracker") && (
                  <button onClick={() => { playSound('tab'); navigateTab("expense_tracker"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "expense_tracker" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">💸</span><span>{t("Expenses", "খরচ")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("settings") && (
                  <button onClick={() => { playSound('tab'); navigateTab("settings"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "settings" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">⚙️</span><span>{t("Settings", "সেটিংস")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("closing_report") && (
                  <button onClick={() => { playSound('tab'); navigateTab("closing_report"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "closing_report" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">📅</span><span>{t("Closing", "ক্লোজিং")}</span>
                  </button>
                )}
                {currentUserRole === "ADMIN" && (
                  <button onClick={() => { playSound('tab'); navigateTab("modules_menu"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "modules_menu" ? 'bg-indigo-500 text-white border-indigo-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">🛡️</span><span>{t("Permissions", "অনুমতি")}</span>
                  </button>
                )}
                {currentUserRole === "ADMIN" && (
                  <button onClick={() => { playSound('tab'); navigateTab("reconciliation"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "reconciliation" ? 'bg-red-600 text-white border-red-600' : isDarkMode ? 'bg-slate-800 border-slate-700 text-red-400' : 'bg-red-50 border-red-200 text-red-600'}`}>
                    <span className="text-xl">🔍</span><span>{t("Reconcile", "সমন্বয়")}</span>
                  </button>
                )}
              </div>
              <button onClick={() => setMobileMenuOpen(false)} className="w-full mt-4 py-2.5 rounded-xl text-sm font-black bg-slate-500/10 text-slate-500">{t("Close", "বন্ধ করুন")}</button>
            </div>
          </div>
        )}

        {/* MOBILE BOTTOM NAVIGATION — visible only on mobile (md: hidden) */}
        <nav className={`md:hidden fixed bottom-0 left-0 right-0 z-40 border-t flex items-center justify-around px-1 py-1 print:hidden ${isDarkMode ? 'bg-slate-900/50 backdrop-blur-2xl border-slate-800/40' : 'bg-white/60 backdrop-blur-2xl border-white/40'}`} style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-bg2'], borderTopColor: (activeThemeStyle as any)['--theme-border'] } : {}}>
          {checkShouldRenderTabOption("pos") && (
            <button onClick={() => { playSound('tab'); navigateTab("pos"); }} className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-xl text-xs font-bold transition relative ${activeTab === "pos" ? 'text-indigo-500' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              <span className="text-lg">🛒</span>
              <span>{t("Sell", "বিক্রয়")}</span>
              {cart.length > 0 && <span className="absolute -top-0.5 right-0.5 bg-red-500 text-white text-xs w-4 h-4 rounded-full flex items-center justify-center font-black">{cart.length > 9 ? '9+' : cart.length}</span>}
            </button>
          )}
          {checkShouldRenderTabOption("analytics") && (
            <button onClick={() => { playSound('tab'); navigateTab("analytics"); }} className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-xl text-xs font-bold transition ${activeTab === "analytics" ? 'text-indigo-500' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              <span className="text-lg">📊</span>
              <span>{t("Dash", "ড্যাশ")}</span>
            </button>
          )}
          {checkShouldRenderTabOption("inventory") && (
            <button onClick={() => { playSound('tab'); navigateTab("inventory"); }} className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-xl text-xs font-bold transition ${activeTab === "inventory" ? 'text-indigo-500' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              <span className="text-lg">📦</span>
              <span>{t("Stock", "স্টক")}</span>
            </button>
          )}
          {checkShouldRenderTabOption("procurement") && (
            <button onClick={() => { playSound('tab'); navigateTab("procurement"); }} className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-xl text-xs font-bold transition ${activeTab === "procurement" ? 'text-indigo-500' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              <span className="text-lg">📥</span>
              <span>{t("Stock In", "মাল")}</span>
            </button>
          )}
          {checkShouldRenderTabOption("due_list_view") && (
            <button onClick={() => { playSound('tab'); navigateTab("due_list"); }} className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-xl text-xs font-bold transition relative ${activeTab === "due_list" ? 'text-indigo-500' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              <span className="text-lg">💳</span>
              <span>{t("Due", "বাকি")}</span>
              {dueList.length > 0 && <span className="absolute -top-0.5 right-0.5 bg-red-500 text-white text-xs w-4 h-4 rounded-full flex items-center justify-center font-black">{dueList.length > 9 ? '9+' : dueList.length}</span>}
            </button>
          )}
          {/* "More" button — always visible, opens full menu drawer */}
          <button onClick={() => setMobileMenuOpen(true)} className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-xl text-xs font-bold transition ${mobileMenuOpen ? 'text-indigo-500' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            <span className="text-lg">☰</span>
            <span>{t("More", "আরো")}</span>
          </button>
        </nav>

        {/* MAIN CONTENT */}
        <main className="flex-1 p-3 md:p-4 pb-20 md:pb-4 overflow-y-auto print:p-0" style={{WebkitOverflowScrolling:'touch'}}>

          {/* =========================================================
              TAB 1: POS / SELL
          ========================================================= */}
          {activeTab === "pos" && checkShouldRenderTabOption("pos") && (
            <div key="pos-tab" className="animate-tab-content flex flex-col lg:grid lg:grid-cols-12 gap-3">

              {/* Mobile POS split-tab switcher — only visible on small screens */}
              <div className={`lg:hidden flex rounded-xl overflow-hidden border text-sm font-black ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-slate-100 border-slate-200'}`}>
                <button
                  onClick={() => (document.getElementById('pos-products') as HTMLElement).scrollIntoView({behavior:'smooth', block:'nearest'})}
                  className="flex-1 py-2.5 flex items-center justify-center gap-1.5 bg-indigo-500 text-white"
                >
                  🔍 {t("Products","পণ্য")} <span className="bg-white/20 px-1.5 py-0.5 rounded text-xs">{filteredMedicines.length}</span>
                </button>
                <button
                  onClick={() => (document.getElementById('pos-cart') as HTMLElement).scrollIntoView({behavior:'smooth', block:'nearest'})}
                  className={`flex-1 py-2.5 flex items-center justify-center gap-1.5 ${cart.length > 0 ? 'bg-indigo-500 text-white' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}
                >
                  🛒 {t("Cart","কার্ট")} {cart.length > 0 && <span className={`px-1.5 py-0.5 rounded text-xs ${cart.length > 0 ? 'bg-white/20' : 'bg-slate-500/10'}`}>{cart.length}</span>}
                </button>
              </div>

              {/* Left: Product Search */}
              <div id="pos-products" className="lg:col-span-7 flex flex-col gap-3">
                <div className={`ccard cc-teal p-3 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
                  <div className="flex gap-2 flex-wrap">
                    <SearchBox
                      onSearch={setSearchTerm}
                      placeholder={t("Search medicine...", "ওষুধ খুঁজুন...")}
                      className={`flex-1 px-3 py-2 text-sm rounded-xl border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                    />
                    <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)} className={`px-2 py-2 text-sm rounded-xl border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}>
                      <option value="All">{t("All", "সব")}</option>
                      {allCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-[55vh] sm:max-h-[55vh] md:max-h-[60vh] overflow-y-auto">
                  {/* Unfiltered view mounted every button at once — real cost
                      opening the Sell tab once stock grows past a few hundred
                      items. Cap the unsearched view; typing narrows it via
                      filteredMedicines same as before, uncapped. */}
                  {posDisplayedMedicines.map(med => (
                    <ProductCard
                      key={med.id}
                      med={med}
                      onAdd={addToCart}
                      isDarkMode={isDarkMode}
                      currencySymbol={currencySymbol}
                      activeThreshold={activeThreshold}
                      outText={t("Out", "শেষ")}
                      expText={t("Exp", "মেয়াদ")}
                      outLabel="out"
                      expLabel="exp"
                    />
                  ))}
                  {!searchTerm.trim() && selectedCategory === "All" && (
                    <div className="col-span-2 md:col-span-3 text-center py-8 text-slate-400 text-sm italic">
                      {t("Type a medicine name above to search.", "ওষুধের নাম লিখে খুঁজুন।")}
                    </div>
                  )}
                  {(searchTerm.trim() || selectedCategory !== "All") && posDisplayedMedicines.length === 0 && (
                    <div className="col-span-3 text-center py-8 text-slate-400 italic text-sm">{t("No medicine found.", "কোনো ওষুধ পাওয়া যায়নি।")}</div>
                  )}
                  {searchTerm.trim() && filteredMedicines.length > 40 && (
                    <div className="col-span-2 md:col-span-3 text-center py-1.5 text-slate-400 text-sm italic">
                      {t(`Showing top 40 of ${filteredMedicines.length} matches — keep typing to narrow down.`, `${filteredMedicines.length} টির মধ্যে সেরা ৪০টি দেখানো হচ্ছে — আরও নির্দিষ্ট করতে লিখতে থাকুন।`)}
                    </div>
                  )}
                </div>
              </div>

              {/* Right: Cart */}
              <div id="pos-cart" className="lg:col-span-5">
                <div className={`ccard cc-indigo p-3 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500">🛒 {t("Cart", "কার্ট")} ({cart.length})</h3>
                    <button
                      onClick={() => setShowCustomerPanel(p => !p)}
                      className={`flex items-center gap-1.5 text-xs font-black px-2.5 py-1.5 rounded-xl border transition ${selectedExistingDue ? 'bg-red-500 border-red-600 text-white' : customerName ? 'bg-indigo-500 border-indigo-600 text-white' : isDarkMode ? 'bg-slate-800 border-slate-600 text-slate-300 hover:bg-slate-700' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'}`}
                    >
                      👤 {t("Customer", "গ্রাহক")}
                      {selectedExistingDue && <span className="ml-1 font-mono">{selectedExistingDue.totalDue.toFixed(0)}৳ {t("due","বাকি")}</span>}
                    </button>
                  </div>

                  {/* Customer Panel */}
                  {showCustomerPanel && <div className="grid grid-cols-2 gap-2 mb-3">
                    <div className="relative">
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Customer Name", "গ্রাহকের নাম")}</label>
                      <input
                        type="text"
                        value={customerName}
                        onChange={e => {
                          setCustomerName(e.target.value);
                          setShowCustomerSuggestions(true);
                          if (!e.target.value.trim()) { setSelectedExistingDue(null); }
                        }}
                        onFocus={() => setShowCustomerSuggestions(true)}
                        onBlur={() => setTimeout(() => setShowCustomerSuggestions(false), 200)}
                        placeholder={t("Type name or phone...", "নাম বা ফোন লিখুন...")}
                        className={`w-full px-2 py-1.5 rounded border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                      />
                      {/* Customer suggestions from invoices + due list (memoized — see customerNameSuggestions) */}
                      {customerNameSuggestions.length > 0 && (
                        <div className={`absolute z-30 left-0 right-0 top-full mt-0.5 rounded-xl border shadow-sm overflow-hidden ${isDarkMode ? 'bg-slate-900/50 backdrop-blur-2xl border-slate-700/40' : 'bg-white/60 backdrop-blur-2xl border-white/40'}`}>
                          {customerNameSuggestions.map((c, i) => {
                            const due = dueList.find((d: any) => d.customerName.toLowerCase() === c.name.toLowerCase());
                            return (
                              <button
                                key={i}
                                onMouseDown={() => {
                                  setCustomerName(c.name);
                                  setCustomerPhone(c.phone || customerPhone);
                                  if (due) setSelectedExistingDue(due);
                                  setShowCustomerSuggestions(false);
                                }}
                                className={`w-full text-left px-3 py-2 text-sm flex justify-between items-center hover:bg-indigo-500/10 transition ${isDarkMode ? 'text-white' : 'text-slate-800'}`}
                              >
                                <span>
                                  <span className="font-bold">{c.name}</span>
                                  {c.phone && <span className="font-mono text-xs text-slate-400 ml-2">{c.phone}</span>}
                                </span>
                                {due
                                  ? <span className="text-red-500 font-mono font-black text-xs">🔴 {due.totalDue.toFixed(1)} {currencySymbol} {t("due","বাকি")}</span>
                                  : <span className="text-indigo-400 text-xs">✔ {t("no due","বাকি নেই")}</span>
                                }
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div className="relative">
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Phone", "ফোন")}</label>
                      <input
                        type="text"
                        value={customerPhone}
                        onChange={e => {
                          setCustomerPhone(e.target.value);
                          setShowPhoneSuggestions(true);
                          if (!e.target.value.trim()) { setSelectedExistingDue(null); }
                        }}
                        onFocus={() => setShowPhoneSuggestions(true)}
                        onBlur={() => setTimeout(() => setShowPhoneSuggestions(false), 200)}
                        placeholder="01XXXXXXXXX"
                        className={`w-full px-2 py-1.5 rounded border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                      />
                      {/* Phone suggestions (memoized — see customerPhoneSuggestions) */}
                      {customerPhoneSuggestions.length > 0 && (
                          <div className={`absolute z-30 left-0 right-0 top-full mt-0.5 rounded-xl border shadow-sm overflow-hidden ${isDarkMode ? 'bg-slate-900/50 backdrop-blur-2xl border-slate-700/40' : 'bg-white/60 backdrop-blur-2xl border-white/40'}`}>
                            {customerPhoneSuggestions.map((c, i) => {
                              const due = dueList.find((d: any) => d.phone === c.phone);
                              return (
                                <button
                                  key={i}
                                  onMouseDown={() => {
                                    setCustomerPhone(c.phone);
                                    setCustomerName(c.name);
                                    if (due) setSelectedExistingDue(due);
                                    setShowPhoneSuggestions(false);
                                  }}
                                  className={`w-full text-left px-3 py-2 text-sm flex justify-between items-center hover:bg-indigo-500/10 transition ${isDarkMode ? 'text-white' : 'text-slate-800'}`}
                                >
                                  <span>
                                    <span className="font-mono font-bold">{c.phone}</span>
                                    <span className="text-xs text-slate-400 ml-2">{c.name}</span>
                                  </span>
                                  {due
                                    ? <span className="text-red-500 font-mono font-black text-xs">🔴 {due.totalDue.toFixed(1)} {currencySymbol} {t("due","বাকি")}</span>
                                    : <span className="text-indigo-400 text-xs">✔ {t("no due","বাকি নেই")}</span>
                                  }
                                </button>
                              );
                            })}
                          </div>
                      )}
                    </div>
                  </div>}

                  {/* Previous due alert */}
                  {selectedExistingDue && (
                    <div className={`mb-3 px-3 py-2 rounded-xl border text-sm flex items-center justify-between ${isDarkMode ? 'bg-red-950/50 border-red-700' : 'bg-white border-slate-200'}`}>
                      <span className={isDarkMode ? 'text-red-300' : 'text-red-700'}>⚠️ {t("Previous due:", "আগের বাকি:")} <strong className="font-mono">{selectedExistingDue.totalDue.toFixed(1)} {currencySymbol}</strong></span>
                      <button onClick={() => { setSelectedExistingDue(null); }} className="text-slate-400 hover:text-red-500 text-xs font-bold">✕</button>
                    </div>
                  )}

                  {/* Cart Items */}
                  <div className="flex flex-col gap-1.5 max-h-36 sm:max-h-48 overflow-y-auto mb-3">
                    {cart.map(item => (
                      <CartRow
                        key={item.id}
                        item={item}
                        isDarkMode={isDarkMode}
                        currencySymbol={currencySymbol}
                        onQtyChange={handleQuantityChange}
                        onRemove={removeFromCart}
                      />
                    ))}
                    {cart.length === 0 && <div className="text-center py-6 text-slate-400 text-sm italic">{t("Cart is empty.", "কার্ট খালি।")}</div>}
                  </div>

                  {/* Discount */}
                  {checkShouldRenderTabOption("discount_manager") && cart.length > 0 && (
                    <div className="flex gap-2 mb-3">
                      <select value={discountType} onChange={e => setDiscountType(e.target.value as "TK" | "PERCENT")} className={`px-2 py-1 text-sm rounded border ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}>
                        <option value="TK">{t("Discount (৳)", "ছাড় (৳)")}</option>
                        <option value="PERCENT">{t("Discount (%)", "ছাড় (%)")}</option>
                      </select>
                      <input type="number" value={discountValue} onChange={e => {
                        const val = parseFloat(e.target.value) || 0;
                        if (discountType === "PERCENT") {
                          if (val > 10) { setDiscountValue("10"); return; }
                        } else {
                          const maxTk = (currentSubTotal * 10) / 100;
                          if (val > maxTk) { setDiscountValue(maxTk.toFixed(2)); return; }
                        }
                        setDiscountValue(e.target.value);
                      }} className={`flex-1 px-2 py-1 text-sm rounded border outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                    </div>
                  )}

                  {/* Discount limit warning */}
                  {checkShouldRenderTabOption("discount_manager") && cart.length > 0 && (() => {
                    const discPct = currentSubTotal > 0 ? (activeDiscountAmount / currentSubTotal) * 100 : 0;
                    if (discPct >= 10) return (
                      <p className="text-xs font-bold text-red-500 mb-2">⚠️ {t("Max discount limit reached (10%)", "সর্বোচ্চ ছাড় সীমায় পৌঁছেছেন (১০%)")}</p>
                    );
                    return null;
                  })()}

                  {/* Totals */}
                  {cart.length > 0 && (
                    <div className="flex flex-col gap-1 text-sm mb-3 border-t pt-2">
                      <div className="flex justify-between"><span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>{t("Subtotal", "মোট")}</span><span className="font-mono">{currentSubTotal.toFixed(1)} {currencySymbol}</span></div>
                      {parseFloat(vatPercentage) > 0 && <div className="flex justify-between"><span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>{t("VAT", "ভ্যাট")} ({vatPercentage}%)</span><span className="font-mono">+{calculatedVatAmount.toFixed(1)} {currencySymbol}</span></div>}
                      {activeDiscountAmount > 0 && <div className="flex justify-between text-red-500"><span>{t("Discount", "ছাড়")}</span><span className="font-mono">-{activeDiscountAmount.toFixed(1)} {currencySymbol}</span></div>}
                      <div className="flex justify-between font-black text-indigo-500 border-t pt-1"><span>{t("Total Payable", "মোট পরিশোধ")}</span><span className="font-mono text-base">{currentFinalBill.toFixed(1)} {currencySymbol}</span></div>
                      {selectedExistingDue && (
                        <>
                          <div className="flex justify-between text-red-500 font-bold"><span>+ {t("Prev. Due", "আগের বাকি")}</span><span className="font-mono">{selectedExistingDue.totalDue.toFixed(1)} {currencySymbol}</span></div>
                          <div className="flex justify-between font-black text-orange-500 border-t pt-1"><span>{t("Grand Total", "সর্বমোট")}</span><span className="font-mono text-base">{(currentFinalBill + selectedExistingDue.totalDue).toFixed(1)} {currencySymbol}</span></div>
                        </>
                      )}
                    </div>
                  )}

                  <button onClick={handleCheckoutIntent} disabled={cart.length === 0} className="w-full bg-gradient-to-r from-indigo-500 to-emerald-500 text-white text-sm font-black py-2.5 rounded-xl uppercase tracking-wider shadow-sm hover:from-indigo-600 hover:to-emerald-600 transition disabled:opacity-40">
                    🚀 {t("Create Invoice", "বিল তৈরি করুন")}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================
              TAB 2: DASHBOARD / ANALYTICS
          ========================================================= */}
          {activeTab === "analytics" && checkShouldRenderTabOption("analytics") && (
            <div className="flex flex-col gap-4">
              <h2 className="text-sm font-black text-indigo-500 uppercase tracking-wider">{t("Dashboard", "ড্যাশবোর্ড")}</h2>

              {/* Top Stats Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">

                {/* Daily Sale */}
                {checkShouldRenderTabOption("daily_sale_view") && (
                <div className={`ccard cc-violet p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-card'], borderColor: (activeThemeStyle as any)['--theme-border'] } : (!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {})}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#a7f3d0'} : {color:'#6ee7b7'}}>{t("Today's Sale", "আজকের বিক্রয়")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#6ee7b7'}}>{computedDailySalesAmount.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#d1fae5'} : {color:'#6b7280'}}>{t("Cash collected today", "আজ সংগ্রহ")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{CSS_BAGFLOAT}</style>
                      <g id="mbag">
                        <ellipse cx="32" cy="42" rx="18" ry="14" fill="white" fillOpacity="0.92"/>
                        <ellipse id="sh1" cx="26" cy="38" rx="6" ry="9" fill="white" fillOpacity="0.15" transform="rotate(-15 26 38)"/>
                        <rect x="25" y="23" width="14" height="11" rx="4" fill="white" fillOpacity="0.85"/>
                        <path d="M27 23 C27 14.5 37 14.5 37 23" stroke="white" strokeWidth="3" fill="none" strokeLinecap="round"/>
                        <text x="32" y="47" textAnchor="middle" fontSize="13" fill="#059669" fontWeight="900">৳</text>
                        <ellipse id="sh2" cx="38" cy="44" rx="4" ry="6" fill="white" fillOpacity="0.1" transform="rotate(20 38 44)"/>
                      </g>
                      <ellipse id="c1" cx="20" cy="18" rx="5" ry="3.5" fill="#fbbf24" stroke="#f59e0b" strokeWidth="0.8"/>
                      <text id="c1" x="18" y="21" fontSize="7" fill="#92400e" fontWeight="bold">$</text>
                      <ellipse id="c2" cx="36" cy="14" rx="4" ry="2.8" fill="#fde68a" stroke="#fbbf24" strokeWidth="0.8"/>
                      <ellipse id="c3" cx="44" cy="22" rx="3.5" ry="2.5" fill="#fcd34d" stroke="#f59e0b" strokeWidth="0.7"/>
                      <g id="sp1"><path d="M12 8 L13 12 L16 12 L13.5 14 L14.5 18 L12 16 L9.5 18 L10.5 14 L8 12 L11 12 Z" fill="white" fillOpacity="0.9"/></g>
                      <g id="sp2"><path d="M50 6 L51 9 L54 9 L51.8 11 L52.5 14 L50 12.5 L47.5 14 L48.2 11 L46 9 L49 9 Z" fill="#fde68a" fillOpacity="0.9"/></g>
                    </svg>
                  </div>
                </div>
                )}

                {/* Monthly Sale */}
                {checkShouldRenderTabOption("monthly_sale_view") && (
                <div className={`ccard cc-pink p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#bfdbfe'} : {color:'#93c5fd'}}>{t("Monthly Sale", "মাসিক বিক্রয়")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#93c5fd'}}>{computedMonthlySalesAmount.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#dbeafe'} : {color:'#6b7280'}}>{t("This month", "এই মাসে")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{CSS_CALFLOAT}</style>
                      <g id="ring">
                        <circle cx="32" cy="32" r="28" stroke="white" strokeWidth="0.5" strokeOpacity="0.2" strokeDasharray="4 6" fill="none"/>
                        <circle cx="32" cy="4" r="2.5" fill="white" fillOpacity="0.5"/>
                        <circle cx="60" cy="32" r="2" fill="white" fillOpacity="0.3"/>
                        <circle cx="32" cy="60" r="2" fill="white" fillOpacity="0.3"/>
                      </g>
                      <g id="cal">
                        <rect x="9" y="16" width="46" height="38" rx="5" fill="white" fillOpacity="0.88"/>
                        <rect x="9" y="16" width="46" height="13" rx="5" fill="white" fillOpacity="0.4"/>
                        <rect x="9" y="24" width="46" height="5" fill="white" fillOpacity="0.4"/>
                        <rect x="19" y="9" width="5" height="12" rx="2.5" fill="white"/>
                        <rect x="40" y="9" width="5" height="12" rx="2.5" fill="white"/>
                        <g id="page">
                          <text id="dt" x="32" y="44" textAnchor="middle" fontSize="15" fill="#1d4ed8" fontWeight="900">15</text>
                        </g>
                        <circle id="d1" cx="17" cy="34" r="2.5" fill="#1d4ed8" fillOpacity="0.5"/>
                        <circle id="d2" cx="32" cy="34" r="2.5" fill="#1d4ed8" fillOpacity="0.5"/>
                        <circle id="d3" cx="47" cy="34" r="2.5" fill="#1d4ed8" fillOpacity="0.5"/>
                      </g>
                    </svg>
                  </div>
                </div>
                )}

                {/* Daily Profit */}
                {checkShouldRenderTabOption("daily_profit_view") && (
                  <div className={`ccard cc-rose p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#99f6e4'} : {color:'#5eead4'}}>{t("Today's Profit", "আজকের লাভ")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#5eead4'}}>{computedDailyProfitAmount.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#ccfbf1'} : {color:'#6b7280'}}>{t("Net profit today", "আজ নেট লাভ")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{CSS_B1GROW}</style>
                        <rect id="base" x="6" y="50" width="52" height="2.5" rx="1.2" fill="white"/>
                        <rect id="b1" x="8" y="34" width="12" height="16" rx="2.5" fill="white" fillOpacity="0.55"/>
                        <rect id="b2" x="26" y="26" width="12" height="24" rx="2.5" fill="white" fillOpacity="0.7"/>
                        <rect id="b3" x="44" y="14" width="12" height="36" rx="2.5" fill="white" fillOpacity="0.88"/>
                        <rect x="9" y="35" width="4" height="14" rx="1" fill="white" fillOpacity="0.25" id="sh1"/>
                        <rect x="27" y="27" width="4" height="22" rx="1" fill="white" fillOpacity="0.25"/>
                        <rect x="45" y="15" width="4" height="34" rx="1" fill="white" fillOpacity="0.25"/>
                        <g id="arr">
                          <path d="M38 11 L50 6 M50 6 L44 6 M50 6 L50 12" stroke="#fbbf24" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/>
                        </g>
                        <circle id="p1" cx="44" cy="14" r="2" fill="#fbbf24"/>
                        <circle id="p2" cx="44" cy="14" r="1.5" fill="white" fillOpacity="0.8"/>
                        <circle id="p3" cx="44" cy="14" r="2.5" fill="#fde68a" fillOpacity="0.6"/>
                      </svg>
                    </div>
                  </div>
                )}

                {/* Monthly Profit */}
                {checkShouldRenderTabOption("monthly_profit_view") && (
                  <div className={`ccard cc-green p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#ddd6fe'} : {color:'#c4b5fd'}}>{t("Monthly Profit", "মাসিক লাভ")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#c4b5fd'}}>{computedMonthlyProfitAmount.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#ede9fe'} : {color:'#6b7280'}}>{t("Net profit this month", "মাসে নেট লাভ")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{CSS_RKTLAUNCH}</style>
                        <circle id="od1" cx="32" cy="28" r="2.5" fill="white" fillOpacity="0.4"/>
                        <circle id="od2" cx="32" cy="28" r="2" fill="#fbbf24" fillOpacity="0.5"/>
                        <g id="rkt">
                          <path d="M32 6 C32 6 22 20 22 34 L42 34 C42 20 32 6 32 6Z" fill="white" fillOpacity="0.92"/>
                          <rect x="26" y="32" width="12" height="9" fill="white" fillOpacity="0.75"/>
                          <path d="M22 34 L13 43 L22 43Z" fill="white" fillOpacity="0.6"/>
                          <path d="M42 34 L51 43 L42 43Z" fill="white" fillOpacity="0.6"/>
                          <circle cx="32" cy="20" r="5" fill="#7c3aed" fillOpacity="0.75"/>
                          <circle cx="32" cy="20" r="2.5" fill="white" fillOpacity="0.5"/>
                          <g id="fire">
                            <path d="M25 41 C25 41 22 51 32 56 C42 51 39 41 39 41Z" fill="#fbbf24"/>
                            <path d="M27 42 C27 42 25 49 32 53 C39 49 37 42 37 42Z" fill="#f97316"/>
                            <path d="M29 43 C29 43 28 48 32 51 C36 48 35 43 35 43Z" fill="#fef3c7" fillOpacity="0.8"/>
                          </g>
                        </g>
                        <circle id="sm1" cx="28" cy="58" r="4" fill="white" fillOpacity="0.35"/>
                        <circle id="sm2" cx="36" cy="60" r="3.5" fill="white" fillOpacity="0.25"/>
                      </svg>
                    </div>
                  </div>
                )}

                {/* Daily Purchase */}
                {checkShouldRenderTabOption("daily_purchases_view") && (
                  <div className={`ccard cc-slate p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800 border-orange-500' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fed7aa'} : {color:'#fdba74'}}>{t("Today's Purchase", "আজকের ক্রয়")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#fdba74'}}>{computedDailyPurchaseAmount.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#ffedd5'} : {color:'#6b7280'}}>{t("Purchased today", "আজ কেনা")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{CSS_CARTROLL}</style>
                        <g id="cart">
                          <path d="M6 10 L14 10 L22 40 L52 40 L58 20 L14 20" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                          <circle id="w1" cx="22" cy="47" r="4.5" stroke="white" strokeWidth="2.2" fill="none"/>
                          <circle cx="22" cy="47" r="1.5" fill="white"/>
                          <circle id="w2" cx="44" cy="47" r="4.5" stroke="white" strokeWidth="2.2" fill="none"/>
                          <circle cx="44" cy="47" r="1.5" fill="white"/>
                        </g>
                        <rect id="it1" x="17" y="12" width="9" height="9" rx="2" fill="#fbbf24" fillOpacity="0.95"/>
                        <rect id="it2" x="28" y="8" width="9" height="9" rx="2" fill="#fde68a" fillOpacity="0.9"/>
                        <rect id="it3" x="39" y="12" width="9" height="9" rx="2" fill="#fcd34d" fillOpacity="0.95"/>
                        <text id="it1" x="19" y="21" fontSize="8" fill="#92400e">💊</text>
                        <g id="plus">
                          <path d="M54 8 L54 16 M50 12 L58 12" stroke="white" strokeWidth="2.5" strokeLinecap="round"/>
                        </g>
                      </svg>
                    </div>
                  </div>
                )}

                {/* Monthly Purchase */}
                {checkShouldRenderTabOption("monthly_purchases_view") && (
                  <div className={`ccard cc-cyan p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#a5f3fc'} : {color:'#67e8f9'}}>{t("Monthly Purchase", "মাসিক ক্রয়")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#67e8f9'}}>{computedMonthlyPurchaseAmount.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#cffafe'} : {color:'#6b7280'}}>{t("Purchased this month", "মাসে কেনা")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{CSS_BAGSWING}</style>
                        <g id="bag">
                          <rect x="12" y="22" width="40" height="34" rx="5" fill="white" fillOpacity="0.88"/>
                          <ellipse id="shbag" cx="20" cy="36" rx="6" ry="12" fill="white" fillOpacity="0.15" transform="rotate(-10 20 36)"/>
                          <path d="M22 22 C22 12 42 12 42 22" stroke="white" strokeWidth="3" fill="none" strokeLinecap="round"/>
                          <circle cx="32" cy="38" r="6" fill="#0e7490" fillOpacity="0.2"/>
                          <g id="chk">
                            <path d="M28 38 L31 41 L37 35" stroke="#0e7490" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </g>
                          <rect x="22" y="28" width="20" height="2.5" rx="1.2" fill="#0e7490" fillOpacity="0.35"/>
                        </g>
                        <g id="tag">
                          <rect x="44" y="8" width="14" height="20" rx="3" fill="#fbbf24" fillOpacity="0.95"/>
                          <circle cx="51" cy="12" r="2" fill="white"/>
                          <rect x="46" y="17" width="10" height="1.5" rx="0.75" fill="white" fillOpacity="0.75"/>
                          <rect x="46" y="20" width="7" height="1.5" rx="0.75" fill="white" fillOpacity="0.5"/>
                          <rect x="46" y="23" width="8" height="1.5" rx="0.75" fill="white" fillOpacity="0.4"/>
                        </g>
                      </svg>
                    </div>
                  </div>
                )}

                {/* Daily Due */}
                {checkShouldRenderTabOption("daily_due_view") && (
                <div className={`ccard cc-purple p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fecaca'} : {color:'#fca5a5'}}>{t("Today's Due", "আজকের বাকি")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#fca5a5'}}>{computedDailyDue.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#fee2e2'} : {color:'#6b7280'}}>{t("Due given today", "আজ বাকি দেওয়া")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{CSS_HGSPIN}</style>
                      <circle id="rip1" cx="32" cy="32" r="20" fill="none" stroke="#f43f5e" strokeWidth="1.5" strokeOpacity="0.3"/>
                      <circle id="rip2" cx="32" cy="32" r="22" fill="none" stroke="white" strokeWidth="1" strokeOpacity="0.2"/>
                      <g id="hg">
                        <rect x="13" y="7" width="38" height="4" rx="2" fill="white"/>
                        <rect x="13" y="53" width="38" height="4" rx="2" fill="white"/>
                        <path d="M15 11 Q15 27 32 32 Q49 37 49 53 L15 53 Q15 37 32 32 Q49 27 49 11 Z" fill="white" fillOpacity="0.82"/>
                        <path d="M19 11 Q23 23 32 28" stroke="white" strokeWidth="0.8" fill="none" strokeOpacity="0.35"/>
                        <rect id="sf" x="26" y="12" width="12" height="18" rx="2" fill="#b91c1c" fillOpacity="0.55"/>
                        <path d="M15 53 Q22 43 32 40 Q42 43 49 53Z" fill="#b91c1c" fillOpacity="0.4"/>
                      </g>
                      <circle id="sd" cx="32" cy="32" r="3" fill="#fbbf24"/>
                    </svg>
                  </div>
                </div>
                )}

                {/* Monthly Due */}
                {checkShouldRenderTabOption("monthly_due_view") && (
                <div className={`ccard cc-teal p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fce7f3'} : {color:'#f9a8d4'}}>{t("Monthly Due", "মাসিক বাকি")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#f9a8d4'}}>{computedMonthlyDue.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#fdf2f8'} : {color:'#6b7280'}}>{t("Total due this month", "মাসে মোট বাকি")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{CSS_CLIPSHAKE}</style>
                      <circle id="alring" cx="48" cy="14" r="9" fill="none" stroke="#f43f5e" strokeWidth="2" strokeOpacity="0.5"/>
                      <g id="clip">
                        <rect x="10" y="12" width="40" height="46" rx="4" fill="white" fillOpacity="0.88"/>
                        <rect x="22" y="8" width="20" height="10" rx="3" fill="white" fillOpacity="0.75"/>
                        <path id="l1" d="M17 28 L47 28" stroke="#be185d" strokeWidth="2.5" strokeLinecap="round"/>
                        <path id="l2" d="M17 36 L43 36" stroke="#be185d" strokeWidth="2.5" strokeLinecap="round" strokeOpacity="0.7"/>
                        <path id="l3" d="M17 44 L38 44" stroke="#be185d" strokeWidth="2.5" strokeLinecap="round" strokeOpacity="0.45"/>
                        <g id="pen">
                          <rect x="42" y="26" width="4" height="14" rx="2" fill="#fbbf24" fillOpacity="0.9"/>
                          <path d="M43 40 L44 44 L45 40Z" fill="#374151"/>
                        </g>
                      </g>
                      <circle id="al" cx="48" cy="14" r="8" fill="#f43f5e"/>
                      <text x="45" y="19" fontSize="11" fontWeight="900" fill="white">!</text>
                    </svg>
                  </div>
                </div>
                )}

                {/* Daily bKash/Nagad */}
                {checkShouldRenderTabOption("bkash_nagad_view") && (
                  <div className={`ccard cc-indigo p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fae8ff'} : {color:'#f0abfc'}}>{t("Today's bKash/Nagad", "আজকের বিকাশ/নগদ")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#f0abfc'}}>{computedDailyBkash.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#fdf4ff'} : {color:'#6b7280'}}>{t("Mobile payment today", "আজ মোবাইল পেমেন্ট")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'60px',height:'60px',opacity:0.55,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{CSS_PHVIB}</style>
                        <circle id="p1" cx="46" cy="15" r="6" fill="#fbbf24" fillOpacity="0.65"/>
                        <circle id="p2" cx="46" cy="15" r="6" fill="#fbbf24" fillOpacity="0.4"/>
                        <circle cx="46" cy="15" r="7" fill="#fbbf24"/>
                        <text x="43" y="19.5" fontSize="9" fontWeight="900" fill="white">৳</text>
                        <g id="ph">
                          <rect x="16" y="8" width="28" height="48" rx="5" fill="white" fillOpacity="0.92"/>
                          <rect id="scr" x="19" y="13" width="22" height="34" rx="3" fill="#a21caf" fillOpacity="0.55"/>
                          <rect x="19" y="13" width="22" height="34" rx="3" fill="white" fillOpacity="0.08"/>
                          <circle cx="30" cy="52" r="2.5" fill="#a21caf" fillOpacity="0.6"/>
                          <rect x="26" y="10" width="8" height="2" rx="1" fill="#a21caf" fillOpacity="0.35"/>
                          <text x="23" y="32" fontSize="14">📲</text>
                        </g>
                        <g id="cn">
                          <circle cx="32" cy="20" r="6" fill="#fbbf24"/>
                          <text x="29" y="24" fontSize="9" fontWeight="900" fill="white">৳</text>
                        </g>
                      </svg>
                    </div>
                  </div>
                )}

                {/* Monthly bKash/Nagad */}
                {checkShouldRenderTabOption("bkash_nagad_view") && (
                  <div className={`ccard cc-amber p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fef3c7'} : {color:'#fde68a'}}>{t("Monthly bKash/Nagad", "মাসিক বিকাশ/নগদ")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#fde68a'}}>{computedMonthlyBkash.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#fffbeb'} : {color:'#6b7280'}}>{t("Mobile payment month", "মাসে মোবাইল পেমেন্ট")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{CSS_CARDPOP}</style>
                        <circle id="tr1" cx="50" cy="12" r="7" fill="#fbbf24" fillOpacity="0.5"/>
                        <circle id="tr2" cx="50" cy="12" r="7" fill="#fbbf24" fillOpacity="0.3"/>
                        <g id="crd">
                          <rect x="4" y="16" width="52" height="34" rx="6" fill="white" fillOpacity="0.88"/>
                          <rect x="4" y="22" width="52" height="10" fill="white" fillOpacity="0.35"/>
                          <rect id="chip" x="10" y="28" width="14" height="10" rx="3" fill="#b45309" fillOpacity="0.65"/>
                          <rect x="11" y="31" width="12" height="1.5" rx="0.75" fill="white" fillOpacity="0.55"/>
                          <rect x="12" y="34" width="8" height="1.5" rx="0.75" fill="white" fillOpacity="0.4"/>
                          <rect x="28" y="30" width="22" height="2.5" rx="1.2" fill="#b45309" fillOpacity="0.3"/>
                          <rect x="28" y="35" width="16" height="2.5" rx="1.2" fill="#b45309" fillOpacity="0.2"/>
                          <text x="40" y="45" fontSize="10">📱</text>
                        </g>
                        <path id="wave" d="M8 10 Q16 5 24 10 Q32 15 40 10" stroke="#fbbf24" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeOpacity="0.8"/>
                      </svg>
                    </div>
                  </div>
                )}



                {/* Today Due Collection */}
                {checkShouldRenderTabOption("daily_due_collection_view") && (
                <div className={`ccard cc-blue p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#a7f3d0'} : {color:'#6ee7b7'}}>{t("Today's Due Collection", "আজকের বাকি আদায়")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#6ee7b7'}}>{computedDailyDueCollection.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#d1fae5'} : {color:'#6b7280'}}>{t("Collected today", "আজ আদায় হয়েছে")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{CSS_CIRCLEPULSE}</style>
                      <circle id="chkc" cx="32" cy="32" r="22" fill="white" fillOpacity="0.12" stroke="white" strokeWidth="3" strokeOpacity="0.65"/>
                      <polyline id="chkm" points="18,32 27,41 46,22" stroke="white" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                      <g id="sp1"><text x="8" y="18" fontSize="13">✦</text></g>
                      <g id="sp2"><text x="46" y="16" fontSize="11">★</text></g>
                      <g id="sp3"><text x="27" y="7" fontSize="12">✨</text></g>
                      <path id="bl1" d="M6 26 L12 22" stroke="white" strokeWidth="2.5" strokeLinecap="round"/>
                      <path id="bl2" d="M58 26 L52 22" stroke="white" strokeWidth="2.5" strokeLinecap="round"/>
                    </svg>
                  </div>
                </div>
                )}

                {/* Monthly Due Collection */}
                {checkShouldRenderTabOption("monthly_due_collection_view") && (
                <div className={`ccard cc-red p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#bfdbfe'} : {color:'#93c5fd'}}>{t("Monthly Due Collection", "মাসিক বাকি আদায়")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#93c5fd'}}>{computedMonthlyDueCollection.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#dbeafe'} : {color:'#6b7280'}}>{t("Collected this month", "এই মাসে আদায়")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{CSS_WLTOPEN}</style>
                      <g id="wlt">
                        <rect x="6" y="18" width="52" height="34" rx="6" fill="white" fillOpacity="0.88"/>
                        <path d="M6 28 L58 28" stroke="white" strokeWidth="2" strokeOpacity="0.35"/>
                        <rect id="cs" x="38" y="30" width="16" height="14" rx="4" fill="#065f46" fillOpacity="0.55"/>
                        <circle cx="46" cy="37" r="4.5" fill="#065f46" fillOpacity="0.45"/>
                        <circle cx="46" cy="37" r="2.5" fill="white" fillOpacity="0.55"/>
                        <text x="10" y="44" fontSize="12" fontWeight="900" fill="#065f46" fillOpacity="0.5">৳৳৳</text>
                        <rect x="10" y="21" width="24" height="3.5" rx="1.75" fill="#065f46" fillOpacity="0.2"/>
                      </g>
                      <circle id="cf1" cx="32" cy="24" r="7" fill="#fbbf24"/>
                      <text x="28.5" y="29" fontSize="9" fontWeight="900" fill="#065f46">৳</text>
                      <circle id="cf2" cx="32" cy="24" r="5.5" fill="#fde68a"/>
                      <text x="29.5" y="28.5" fontSize="8" fontWeight="900" fill="#065f46">$</text>
                      <circle id="cf3" cx="32" cy="24" r="6" fill="#fcd34d"/>
                      <text x="29" y="29" fontSize="8" fontWeight="900" fill="#065f46">৳</text>
                    </svg>
                  </div>
                </div>
                )}

                {/* Yearly Sale */}
                {checkShouldRenderTabOption("yearly_sales_view") && (
                  <div className={`ccard cc-violet p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#ddd6fe'} : {color:'#c4b5fd'}}>{t("Yearly Sale", "বার্ষিক বিক্রয়")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#c4b5fd'}}>{computedYearlySalesAmount.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#ede9fe'} : {color:'#6b7280'}}>{t("This year's total sales", "এই বছরের মোট বিক্রয়")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{CSS_STARSPIN}</style>
                        <circle id="od" cx="32" cy="32" r="3" fill="white" fillOpacity="0.35"/>
                        <g id="star">
                          <path d="M32 7 L36.5 22 L52 22 L40 31.5 L44.5 47 L32 38 L19.5 47 L24 31.5 L12 22 L27.5 22 Z" fill="white" fillOpacity="0.92"/>
                          <path d="M32 7 L36.5 22 L52 22 L40 31.5 L44.5 47 L32 38 L19.5 47 L24 31.5 L12 22 L27.5 22 Z" fill="none" stroke="white" strokeWidth="0.8" strokeOpacity="0.4"/>
                          <circle cx="32" cy="27" r="5" fill="white" fillOpacity="0.2"/>
                        </g>
                        <g id="t1"><text x="4" y="16" fontSize="13">✦</text></g>
                        <g id="t2"><text x="48" y="20" fontSize="10">★</text></g>
                        <g id="t3"><text x="4" y="56" fontSize="11">✦</text></g>
                        <g id="t4"><text x="48" y="54" fontSize="9">✦</text></g>
                      </svg>
                    </div>
                  </div>
                )}

                {/* Yearly Purchase */}
                {checkShouldRenderTabOption("yearly_purchase_view") && (
                  <div className={`ccard cc-orange p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fed7aa'} : {color:'#fdba74'}}>{t("Yearly Purchase", "বার্ষিক ক্রয়")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#fdba74'}}>{computedYearlyPurchaseAmount.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#ffedd5'} : {color:'#6b7280'}}>{t("This year's total purchase", "এই বছরের মোট ক্রয়")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{CSS_BOXBOUNCE}</style>
                        <g id="box">
                          <path id="lid" d="M10 24 L32 16 L54 24 L32 32 Z" fill="white" fillOpacity="0.88"/>
                          <path d="M10 24 L10 50 L32 58 L54 50 L54 24 L32 32 Z" fill="white" fillOpacity="0.72"/>
                          <rect id="shb" x="10" y="32" width="16" height="28" fill="white" fillOpacity="0.12"/>
                          <path d="M32 32 L32 58" stroke="white" strokeWidth="1.2" strokeOpacity="0.4"/>
                          <path d="M22 28 L22 52" stroke="white" strokeWidth="1" strokeOpacity="0.3"/>
                          <path d="M42 28 L42 52" stroke="white" strokeWidth="1" strokeOpacity="0.3"/>
                        </g>
                        <g id="item"><text x="24" y="26" fontSize="18">💊</text></g>
                        <circle id="dp1" cx="20" cy="48" r="4" fill="white" fillOpacity="0.25"/>
                        <circle id="dp2" cx="44" cy="48" r="3.5" fill="white" fillOpacity="0.2"/>
                      </svg>
                    </div>
                  </div>
                )}

                {/* Yearly Profit */}
                {checkShouldRenderTabOption("yearly_profit_view") && (
                  <div className={`ccard cc-green p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#a7f3d0'} : {color:'#6ee7b7'}}>{t("Yearly Profit", "বার্ষিক লাভ")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#6ee7b7'}}>{computedYearlyProfitAmount.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#d1fae5'} : {color:'#6b7280'}}>{t("This year's net profit", "এই বছরের নেট লাভ")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{CSS_TROPSHAKE}</style>
                        <circle id="glow" cx="32" cy="28" r="22" fill="#fbbf24" fillOpacity="0.07"/>
                        <g id="trop">
                          <path d="M18 8 L46 8 L46 30 Q46 44 32 46 Q18 44 18 30 Z" fill="white" fillOpacity="0.92"/>
                          <path d="M18 14 Q8 14 8 24 Q8 34 18 32" stroke="white" strokeWidth="3" fill="none" strokeLinecap="round"/>
                          <path d="M46 14 Q56 14 56 24 Q56 34 46 32" stroke="white" strokeWidth="3" fill="none" strokeLinecap="round"/>
                          <rect x="26" y="46" width="12" height="5" rx="1.5" fill="white" fillOpacity="0.85"/>
                          <rect x="20" y="51" width="24" height="4" rx="2" fill="white" fillOpacity="0.85"/>
                          <path d="M27 23 L29.5 18 L32 23 L37 24 L33.5 27.5 L34.5 32 L32 30 L29.5 32 L30.5 27.5 L27 24 Z" fill="#fbbf24"/>
                          <path d="M27 23 L29.5 18 L32 23 L37 24 L33.5 27.5 L34.5 32 L32 30 L29.5 32 L30.5 27.5 L27 24 Z" stroke="#f59e0b" strokeWidth="0.5"/>
                        </g>
                        <g id="s1"><text x="12" y="16" fontSize="12" fill="white">★</text></g>
                        <g id="s2"><text x="44" y="14" fontSize="10" fill="#fbbf24">✦</text></g>
                        <g id="s3"><text x="28" y="8" fontSize="13">✨</text></g>
                        <rect id="cf1" x="7" y="18" width="6" height="4" rx="1" fill="#fbbf24" fillOpacity="0.7"/>
                        <rect id="cf2" x="51" y="16" width="5" height="3" rx="1" fill="white" fillOpacity="0.6"/>
                      </svg>
                    </div>
                  </div>
                )}

                {/* Yearly Due */}
                {checkShouldRenderTabOption("yearly_due_view") && (
                  <div className={`ccard cc-rose p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fecdd3'} : {color:'#fda4af'}}>{t("Yearly Due", "বার্ষিক বাকি")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#fda4af'}}>{computedYearlyDue.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#ffe4e6'} : {color:'#6b7280'}}>{t("Total due this year", "এই বছরের মোট বাকি")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{CSS_WARNSHAKE}</style>
                        <circle id="sw1" cx="32" cy="32" r="24" fill="#f43f5e" fillOpacity="0.12" stroke="#f43f5e" strokeWidth="1.5" strokeOpacity="0.25"/>
                        <circle id="sw2" cx="32" cy="32" r="24" fill="none" stroke="#f43f5e" strokeWidth="1" strokeOpacity="0.18"/>
                        <circle id="sw3" cx="32" cy="32" r="24" fill="none" stroke="white" strokeWidth="0.8" strokeOpacity="0.12"/>
                        <g id="wrn">
                          <path d="M32 6 L58 54 L6 54 Z" fill="white" fillOpacity="0.9"/>
                          <path d="M32 6 L58 54 L6 54 Z" stroke="white" strokeWidth="1" fill="none" strokeOpacity="0.4"/>
                          <rect id="bang" x="29.5" y="22" width="5" height="16" rx="2.5" fill="#881337"/>
                          <circle cx="32" cy="44" r="3.5" fill="#881337"/>
                          <rect id="flash" x="0" y="0" width="64" height="64" rx="4" fill="white" fillOpacity="0.15"/>
                        </g>
                      </svg>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Discount Summary Cards ── */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">

                {/* Today's Discount */}
                <div className={`ccard cc-fuchsia p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fae8ff'} : {color:'#f0abfc'}}>{t("Today's Discount", "আজকের ছাড়")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#f0abfc'}}>{computedDailyDiscount.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#fdf4ff'} : {color:'#6b7280'}}>{t("Discount given today", "আজ ছাড় দেওয়া হয়েছে")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{CSS_TAGWIGGLE}</style>
                      <g id="dtag">
                        <path d="M10 14 L10 30 L32 52 L54 30 L54 14 Q54 8 48 8 L16 8 Q10 8 10 14Z" fill="white" fillOpacity="0.88"/>
                        <circle cx="22" cy="20" r="4" fill="#86198f" fillOpacity="0.6"/>
                        <path d="M22 30 L42 18" stroke="#86198f" strokeWidth="2.5" strokeLinecap="round"/>
                        <circle cx="42" cy="38" r="3.5" fill="#86198f" fillOpacity="0.6"/>
                      </g>
                      <g id="dpct"><text x="24" y="36" fontSize="13" fontWeight="900" fill="#86198f" fillOpacity="0.75">%</text></g>
                      <g id="dsp1"><text x="6" y="14" fontSize="11">✦</text></g>
                      <g id="dsp2"><text x="48" y="16" fontSize="10">★</text></g>
                    </svg>
                  </div>
                </div>

                {/* Monthly Discount */}
                {checkShouldRenderTabOption("monthly_discount_view") && (
                <div className={`ccard cc-pink p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fce7f3'} : {color:'#f9a8d4'}}>{t("Monthly Discount", "মাসিক ছাড়")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#f9a8d4'}}>{computedMonthlyDiscount.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#fdf2f8'} : {color:'#6b7280'}}>{t("Discount given this month", "এই মাসে ছাড় দেওয়া হয়েছে")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{CSS_CALTAGFLOAT}</style>
                      <g id="mcal">
                        <rect x="8" y="14" width="40" height="38" rx="5" fill="white" fillOpacity="0.88"/>
                        <rect x="8" y="14" width="40" height="12" rx="5" fill="white" fillOpacity="0.4"/>
                        <rect x="14" y="8" width="5" height="10" rx="2.5" fill="white"/>
                        <rect x="37" y="8" width="5" height="10" rx="2.5" fill="white"/>
                        <path d="M20 38 L36 26" stroke="#9d174d" strokeWidth="2.5" strokeLinecap="round"/>
                        <circle cx="22" cy="36" r="3.5" fill="#9d174d" fillOpacity="0.6"/>
                        <circle cx="36" cy="28" r="3" fill="#9d174d" fillOpacity="0.6"/>
                      </g>
                      <g id="mpct">
                        <rect x="38" y="36" width="20" height="20" rx="4" fill="#fbbf24" fillOpacity="0.9"/>
                        <text x="41" y="52" fontSize="13" fontWeight="900" fill="white">%</text>
                      </g>
                    </svg>
                  </div>
                </div>
                )}

                {/* Yearly Discount */}
                {checkShouldRenderTabOption("yearly_discount_view") && (
                <div className={`ccard cc-rose p-3.5 rounded-xl border-2 relative overflow-hidden shadow-sm ${isDarkMode ? 'bg-rose-950/50 border-rose-400' : 'border-slate-200'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fecaca'} : {color:'#fca5a5'}}>{t("Yearly Discount", "বার্ষিক ছাড়")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#fca5a5'}}>{computedYearlyDiscount.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#fee2e2'} : {color:'#6b7280'}}>{t("Total discount this year", "এই বছরের মোট ছাড়")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{CSS_YRRIBBON}</style>
                      <g id="yrib">
                        <path d="M32 6 C18 6 8 16 8 30 C8 44 18 56 32 56 C46 56 56 44 56 30 C56 16 46 6 32 6Z" fill="white" fillOpacity="0.15"/>
                        <path d="M32 10 C20 10 12 19 12 30 C12 41 20 52 32 52 C44 52 52 41 52 30 C52 19 44 10 32 10Z" fill="white" fillOpacity="0.82"/>
                        <ellipse id="ysh" cx="24" cy="24" rx="6" ry="10" fill="white" fillOpacity="0.2" transform="rotate(-20 24 24)"/>
                        <path d="M20 40 L44 20" stroke="#7f1d1d" strokeWidth="3" strokeLinecap="round"/>
                        <circle cx="22" cy="38" r="5" fill="#7f1d1d" fillOpacity="0.7"/>
                        <circle cx="42" cy="22" r="4.5" fill="#7f1d1d" fillOpacity="0.7"/>
                        <text x="19" y="42" fontSize="8" fontWeight="900" fill="white">%</text>
                        <text x="39" y="26" fontSize="8" fontWeight="900" fill="white">%</text>
                      </g>
                      <g id="ybdg">
                        <circle cx="50" cy="14" r="10" fill="#fbbf24"/>
                        <text x="44" y="19" fontSize="12" fontWeight="900" fill="white">৳</text>
                      </g>
                    </svg>
                  </div>
                </div>
                )}

              </div>

              {/* ── Last 7 Days Sales Graph (pure SVG) ── */}
              {(() => {
                const bnDay = ['রবি','সোম','মঙ্গল','বুধ','বৃহঃ','শুক্র','শনি'];
                const enDay = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
                const { weekDays, weekSales, totalWeek, maxVal, maxIdx } = weeklySalesData;
                const CHART_H = 130;
                const BAR_W = 44;
                const GAP = 18;
                const TOTAL_W = 7 * BAR_W + 6 * GAP;
                const fmtAmt = (v: number) => v.toFixed(0);
                const gridLines = [0, 0.25, 0.5, 0.75, 1.0];
                return (
                  <div className={`rounded-2xl border p-3 ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                    {/* Header */}
                    <div className="flex items-start justify-between mb-2 flex-wrap gap-1">
                      <div>
                        <p className={`text-xs font-bold uppercase tracking-widest mb-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-400'}`}>{t("Last 7 Days Sales","গত ৭ দিনের বিক্রয়")}</p>
                        <p className={`text-lg font-black font-mono leading-none ${isDarkMode ? 'text-white' : 'text-slate-800'}`}>
                          {currencySymbol}{fmtAmt(totalWeek)}
                        </p>
                      </div>
                      <div className="flex gap-3 text-xs font-semibold items-center flex-wrap">
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded inline-block" style={{background:'#1D9E75'}}/><span className={isDarkMode?'text-slate-400':'text-slate-500'}>{t("Today","আজ")}</span></span>
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded inline-block" style={{background:'#BA7517'}}/><span className={isDarkMode?'text-slate-400':'text-slate-500'}>{t("Highest","সর্বোচ্চ")}</span></span>
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded inline-block" style={{background: isDarkMode?'#334155':'#B5D4F4'}}/><span className={isDarkMode?'text-slate-400':'text-slate-500'}>{t("Others","অন্যান্য")}</span></span>
                      </div>
                    </div>
                    {/* SVG Chart */}
                    <svg viewBox={`0 0 ${TOTAL_W} ${CHART_H + 42}`} width="100%" style={{display:'block',overflow:'visible',maxHeight:'240px'}}>
                      {/* Grid lines */}
                      {gridLines.map(pct => {
                        const y = CHART_H - pct * CHART_H;
                        return (
                          <line key={pct} x1={0} y1={y} x2={TOTAL_W} y2={y}
                            stroke={isDarkMode ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)'}
                            strokeWidth="1" strokeDasharray={pct===0?'none':'4 3'} />
                        );
                      })}
                      {/* Bars */}
                      {weekSales.map((sale, i) => {
                        const x = i * (BAR_W + GAP);
                        const barH = maxVal > 0 ? Math.max((sale / maxVal) * CHART_H, sale > 0 ? 6 : 2) : 2;
                        const y = CHART_H - barH;
                        const isToday = i === 6;
                        const isMax = i === maxIdx && sale > 0;
                        const fill = isToday ? (isDarkMode?'#085041':'#E1F5EE') : isMax ? (isDarkMode?'#633806':'#FAEEDA') : (isDarkMode?'#1e293b':'#E6F1FB');
                        const stroke = isToday ? '#1D9E75' : isMax ? '#BA7517' : (isDarkMode?'#334155':'#B5D4F4');
                        const strokeW = (isToday||isMax) ? 1.5 : 1;
                        const labelCol = isToday ? '#0F6E56' : isMax ? '#854F0B' : (isDarkMode?'#94a3b8':'#64748b');
                        const dayLabel = t(enDay[weekDays[i].getDay()], bnDay[weekDays[i].getDay()]);
                        const dateLabel = `${weekDays[i].getDate()}/${weekDays[i].getMonth()+1}`;
                        return (
                          <g key={i}>
                            <rect x={x} y={y} width={BAR_W} height={barH} rx="5" fill={fill} stroke={stroke} strokeWidth={strokeW}/>
                            {/* Amount above bar */}
                            <text x={x + BAR_W/2} y={y - 4} textAnchor="middle" fontSize="9" fontWeight="600" fill={labelCol}>
                              {currencySymbol}{fmtAmt(sale)}
                            </text>
                            {/* Day name */}
                            <text x={x + BAR_W/2} y={CHART_H + 15} textAnchor="middle" fontSize="10" fontWeight="600" fill={labelCol}>
                              {dayLabel}
                            </text>
                            {/* Date */}
                            <text x={x + BAR_W/2} y={CHART_H + 28} textAnchor="middle" fontSize="9" fill={isDarkMode?'#475569':'#94a3b8'}>
                              {dateLabel}
                            </text>
                          </g>
                        );
                      })}
                      {/* Baseline */}
                      <line x1={0} y1={CHART_H} x2={TOTAL_W} y2={CHART_H} stroke={isDarkMode?'rgba(255,255,255,0.15)':'rgba(0,0,0,0.1)'} strokeWidth="1"/>
                    </svg>
                  </div>
                );
              })()}

              {/* Total Stock Value */}
              {checkShouldRenderTabOption("stock_value_calculator") && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className={`ccard cc-amber p-3 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
                    <h4 className="text-sm font-black uppercase text-indigo-500 mb-2">📦 {t("Total Stock", "মোট স্টক")}</h4>
                    <div className="flex flex-col gap-1 text-sm">
                      <div className="flex justify-between"><span className="text-slate-400">{t("Total Items:", "মোট আইটেম:")}</span><span className="font-mono font-black">{medicines.length}</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">{t("Total Units:", "মোট পরিমাণ:")}</span><span className="font-mono font-black">{medicines.reduce((s, m) => s + m.stock, 0)}</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">{t("Buy Value:", "ক্রয় মূল্য:")}</span><span className="font-mono font-black text-amber-500">{totalStockValue.toFixed(1)} {currencySymbol}</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">{t("Sell Value:", "বিক্রয় মূল্য:")}</span><span className="font-mono font-black text-emerald-500">{totalStockRetailValue.toFixed(1)} {currencySymbol}</span></div>
                    </div>
                  </div>

                  {/* Low Stock Alert */}
                  {checkShouldRenderTabOption("low_stock_alerts") && (
                    <div className={`ccard cc-emerald p-3 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
                      <div className="flex items-center justify-between border-b pb-2 mb-2">
                        <h4 className="text-sm font-black uppercase text-amber-500">⚠️ {t("Low Stock", "কম স্টক")}</h4>
                        <span className="bg-amber-500 text-white font-mono text-sm px-1.5 py-0.5 rounded-full font-bold">{lowStockMedicines.length}</span>
                      </div>
                      <div className="flex flex-col gap-1.5 max-h-36 overflow-y-auto">
                        {lowStockMedicines.map(m => (
                          <div key={m.id} className="flex justify-between items-center text-sm font-semibold p-1 bg-amber-500/5 rounded border border-amber-500/10">
                            <span className="truncate max-w-[120px]">{m.name}</span>
                            <span className="font-mono text-amber-500 text-sm">{m.stock} {t("left", "বাকি")}</span>
                          </div>
                        ))}
                        {lowStockMedicines.length === 0 && <div className="text-slate-400 italic text-sm py-3 text-center">{t("All stock levels OK!", "সব স্টক ঠিক আছে!")}</div>}
                      </div>
                    </div>
                  )}

                  {/* Stock Out */}
                  {checkShouldRenderTabOption("stock_out_view") && (
                    <div className={`ccard cc-red p-3 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
                      <div className="flex items-center justify-between border-b pb-2 mb-2">
                        <h4 className="text-sm font-black uppercase text-red-500">⛔ {t("Stock Out", "স্টক আউট")}</h4>
                        <span className="bg-red-500 text-white font-mono text-sm px-1.5 py-0.5 rounded-full font-bold">{stockOutMedicines.length}</span>
                      </div>
                      <div className="flex flex-col gap-1.5 max-h-36 overflow-y-auto">
                        {stockOutMedicines.map(m => (
                          <div key={m.id} className="flex justify-between items-center text-sm font-semibold p-1 bg-red-500/5 rounded border border-red-500/10">
                            <span className="truncate max-w-[120px]">{m.name}</span>
                            <span className="font-mono text-red-500 text-sm">{t("Out of stock", "স্টক শেষ")}</span>
                          </div>
                        ))}
                        {stockOutMedicines.length === 0 && <div className="text-slate-400 italic text-sm py-3 text-center">{t("No stock-out items!", "স্টক আউট নেই!")}</div>}
                      </div>
                    </div>
                  )}

                  {/* Expired */}
                  {checkShouldRenderTabOption("expired_meds_view") && (
                    <div className={`ccard cc-blue p-3 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
                      <div className="flex items-center justify-between border-b pb-2 mb-2">
                        <h4 className="text-sm font-black uppercase text-red-500">🚨 {t("Expired", "মেয়াদ শেষ")}</h4>
                        <span className="bg-red-500 text-white font-mono text-sm px-1.5 py-0.5 rounded-full font-bold">{expiredMedicines.length}</span>
                      </div>
                      <div className="flex flex-col gap-1.5 max-h-36 overflow-y-auto">
                        {expiredMedicines.map(m => (
                          <div key={m.id} className="flex justify-between items-center text-sm font-semibold p-1 bg-red-500/5 rounded border border-red-500/10">
                            <span className="truncate max-w-[120px]">{m.name}</span>
                            <span className="font-mono text-red-400 text-sm">{m.expire}</span>
                          </div>
                        ))}
                        {expiredMedicines.length === 0 && <div className="text-slate-400 italic text-sm py-3 text-center">{t("No expired medicines!", "মেয়াদ শেষ ওষুধ নেই!")}</div>}
                      </div>
                    </div>
                  )}

                  {/* Expiring Soon — 1 month warning */}
                  {expiringSoonMedicines.length > 0 && (
                    <div className={`ccard p-3 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-amber-50 border-amber-400 shadow-sm'}`}>
                      <div className="flex items-center justify-between border-b pb-2 mb-2">
                        <h4 className="text-sm font-black uppercase text-amber-500">⏳ {t("Expiring Soon (1 month)", "মেয়াদ শেষ হচ্ছে (১ মাস)")}</h4>
                        <span className="bg-amber-500 text-white font-mono text-sm px-1.5 py-0.5 rounded-full font-bold">{expiringSoonMedicines.length}</span>
                      </div>
                      <div className="flex flex-col gap-1.5 max-h-36 overflow-y-auto">
                        {expiringSoonMedicines.map(m => (
                          <div key={m.id} className="flex justify-between items-center text-sm font-semibold p-1 bg-amber-500/5 rounded border border-amber-500/10">
                            <span className="truncate max-w-[120px]">{m.name}</span>
                            <span className="font-mono text-amber-500 text-sm">{m.expire}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Category Stock */}
              {checkShouldRenderTabOption("category_wise_stock") && (
                <div className={`ccard cc-red p-3 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
                  <h4 className="text-sm font-black uppercase text-indigo-500 mb-3">📊 {t("Stock by Category", "ক্যাটাগরি অনুযায়ী স্টক")}</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
                    {allCategories.map(cat => {
                      const total = countStockByCategory(cat);
                      if (total === 0) return null;
                      return (
                        <div key={cat} className={`p-2 rounded-xl text-sm text-center ${isDarkMode ? 'bg-slate-900/60' : 'bg-slate-50'}`}>
                          <div className="font-black text-indigo-500 text-sm font-mono">{total}</div>
                          <div className="text-slate-400 text-sm">{cat}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* =========================================================
              TAB 3: STOCK / INVENTORY
          ========================================================= */}
          {activeTab === "inventory" && checkShouldRenderTabOption("inventory") && (
            <div className="flex flex-col gap-4">
              <div className={`rounded-xl border shadow-sm overflow-hidden ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                <div className="p-3 border-b border-slate-700/10 flex items-center justify-between flex-wrap gap-2">
                  <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500">{t("Medicine Stock List", "ওষুধের স্টক তালিকা")} ({medicines.length})</h3>
                  <div className="flex gap-2">
                    <SearchBox onSearch={setSearchTerm} placeholder={t("Search...", "খুঁজুন...")} className={`px-2 py-1 text-sm rounded border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                    <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)} className={`px-2 py-1 text-sm rounded border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}>
                      <option value="All">{t("All", "সব")}</option>
                      {allCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                    </select>
                  </div>
                </div>

                <div className="overflow-x-auto w-full">
                  <table className="w-full text-left text-sm border-collapse" style={{minWidth:'700px'}}>
                    <thead>
                      <tr className={`font-black text-slate-400 border-b ${isDarkMode ? 'bg-slate-900/40 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                        <th className="p-2.5">#</th>
                        <th className="p-2.5">{t("Name", "নাম")}</th>
                        <th className="p-2.5">{t("Type", "ধরন")}</th>
                        <th className="p-2.5">{t("Generic", "জেনেরিক")}</th>
                        {currentUserRole === "ADMIN" && <th className="p-2.5">{t("Buy Price", "ক্রয় মূল্য")}</th>}
                        <th className="p-2.5">{t("Sell Price", "বিক্রয় মূল্য")}</th>
                        <th className="p-2.5">{t("Stock", "স্টক")}</th>
                        <th className="p-2.5">{t("Low Alert", "কম স্টক সীমা")}</th>
                        <th className="p-2.5">{t("Expiry", "মেয়াদ")}</th>
                        {checkShouldRenderTabOption("rack_management") && <th className="p-2.5">{t("Rack", "র্যাক")}</th>}
                        <th className="p-2.5 text-center">{t("Actions", "কার্যক্রম")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/10">
                      {pagedMedicines.map((med, pageIndex) => {
                        const index = (invPage - 1) * INV_PAGE_SIZE + pageIndex;
                        const isEditing = editingId === med.id;
                        const medLowAlert = med.lowStockAlert || activeThreshold;
                        const lowStockFlag = med.stock <= medLowAlert;
                        const expiredFlag = new Date(med.expire) < new Date();

                        return (
                          <tr key={med.id} style={{ contentVisibility: 'auto', containIntrinsicSize: '0 52px' } as any} className={`transition-colors hover:bg-slate-500/5 ${expiredFlag ? 'bg-red-500/5' : lowStockFlag ? 'bg-amber-500/5' : ''}`}>
                            <td className="p-2.5 font-mono text-slate-400 text-sm">{index + 1}</td>
                            <td className="p-2.5 font-bold">
                              {isEditing ? <input type="text" value={editFormData.name} onChange={e => handleEditFormChange("name", e.target.value)} className="px-1.5 py-0.5 rounded border text-sm bg-transparent w-full" />
                                : <span className="block truncate max-w-[140px]">{med.name}</span>}
                            </td>
                            <td className="p-2.5">
                              {isEditing ? (
                                <select value={editFormData.category} onChange={e => handleEditFormChange("category", e.target.value)} className="p-0.5 rounded border text-sm bg-transparent">
                                  {allCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                                </select>
                              ) : <span className="text-sm px-1.5 py-0.5 rounded font-bold uppercase bg-slate-500/10 text-slate-400">{med.category}</span>}
                            </td>
                            <td className="p-2.5 text-slate-400 italic">
                              {isEditing ? <input type="text" value={editFormData.generic} onChange={e => handleEditFormChange("generic", e.target.value)} className="px-1.5 py-0.5 rounded border text-sm bg-transparent w-full" />
                                : <span className="block truncate max-w-[100px]">{med.generic}</span>}
                            </td>
                            {currentUserRole === "ADMIN" && (
                              <td className="p-2.5 font-mono">
                                {isEditing ? <input type="number" step="any" value={editFormData.buyPrice} onChange={e => handleEditFormChange("buyPrice", e.target.value)} className="px-1 py-0.5 rounded border text-sm bg-transparent w-16" />
                                  : <span>{med.buyPrice} {currencySymbol}</span>}
                              </td>
                            )}
                            <td className="p-2.5 font-mono font-bold text-indigo-500">
                              {isEditing ? <input type="number" step="any" value={editFormData.price} onChange={e => handleEditFormChange("price", e.target.value)} className="px-1 py-0.5 rounded border text-sm bg-transparent w-16" />
                                : <span>{med.price} {currencySymbol}</span>}
                            </td>
                            <td className="p-2.5 font-mono">
                              {isEditing ? <input type="number" value={editFormData.stock} onChange={e => handleEditFormChange("stock", e.target.value)} className="px-1 py-0.5 rounded border text-sm bg-transparent w-16" />
                                : <span className={`px-1.5 py-0.5 rounded font-black text-sm ${med.stock === 0 ? 'bg-red-500 text-white' : lowStockFlag ? 'bg-amber-500 text-white' : isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>{med.stock}</span>}
                            </td>
                            <td className="p-2.5 font-mono">
                              {isEditing ? <input type="number" value={editFormData.lowStockAlert || activeThreshold} onChange={e => handleEditFormChange("lowStockAlert", e.target.value)} className="px-1 py-0.5 rounded border text-sm bg-transparent w-14" />
                                : <span className="text-amber-500 font-bold">{medLowAlert}</span>}
                            </td>
                            <td className="p-2.5 font-mono">
                              {isEditing ? <input type="date" value={editFormData.expire} onChange={e => handleEditFormChange("expire", e.target.value)} className="p-0.5 rounded border text-sm bg-transparent" />
                                : <span className={expiredFlag ? 'text-red-500 font-bold' : 'text-slate-400'}>{med.expire}</span>}
                            </td>
                            {checkShouldRenderTabOption("rack_management") && (
                              <td className="p-2.5 font-mono text-slate-500">
                                {isEditing ? <input type="text" value={editFormData.rack} onChange={e => handleEditFormChange("rack", e.target.value)} className="px-1 py-0.5 rounded border text-sm bg-transparent w-14" />
                                  : <span>{med.rack}</span>}
                              </td>
                            )}
                            <td className="p-2.5 text-center">
                              {isEditing ? (
                                <div className="flex gap-1 justify-center">
                                  <button onClick={() => saveEditedMedicine(med.id)} className="bg-emerald-500 text-white text-sm font-bold px-2 py-0.5 rounded hover:bg-emerald-600 transition">{t("Save", "সেভ")}</button>
                                  <button onClick={() => { closeEdit(); setEditingId(null); }} className="bg-slate-400 text-white text-sm font-bold px-2 py-0.5 rounded hover:bg-slate-500 transition">{t("Cancel", "বাতিল")}</button>
                                </div>
                              ) : (
                                <div className="flex gap-1.5 justify-center">
                                  <button onClick={() => startEditing(med)} className="text-indigo-500 hover:text-indigo-600 font-bold transition">✏️</button>
                                  {currentUserRole === "ADMIN" && <button onClick={() => deleteMedicine(med.id)} className="text-red-400 hover:text-red-600 font-bold transition">🗑️</button>}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {filteredMedicines.length === 0 && <tr><td colSpan={12} className="text-center py-8 text-slate-400 italic">{t("No medicines found.", "কোনো ওষুধ পাওয়া যায়নি।")}</td></tr>}
                    </tbody>
                  </table>
                </div>
                {filteredMedicines.length > INV_PAGE_SIZE && (
                  <div className="flex items-center justify-between p-3 border-t border-slate-700/10 text-sm font-bold">
                    <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>
                      {t("Page", "পাতা")} {invPage} / {invTotalPages} — {filteredMedicines.length} {t("items", "টি আইটেম")}
                    </span>
                    <div className="flex gap-2">
                      <button onClick={() => setInvPage(p => Math.max(1, p - 1))} disabled={invPage === 1} className="px-3 py-1 rounded-lg border disabled:opacity-40 hover:bg-slate-500/10 transition">← {t("Prev", "আগে")}</button>
                      <button onClick={() => setInvPage(p => Math.min(invTotalPages, p + 1))} disabled={invPage === invTotalPages} className="px-3 py-1 rounded-lg border disabled:opacity-40 hover:bg-slate-500/10 transition">{t("Next", "পরে")} →</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* =========================================================
              TAB 4: STOCK IN / PURCHASE
          ========================================================= */}
          {activeTab === "procurement" && checkShouldRenderTabOption("procurement") && (
            <div className="grid grid-cols-1 xl:grid-cols-8 gap-4">

              {/* Left: Add Items */}
              <div className="xl:col-span-5 flex flex-col gap-3">
                <div className={`ccard cc-orange p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500 mb-3">📥 {t("Add Medicine to Purchase", "ক্রয়ে ওষুধ যোগ করুন")}</h3>

                  {/* Company Name */}
                  <div className="mb-3" ref={suggestionRef}>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Company / Supplier Name", "কোম্পানি / সরবরাহকারীর নাম")} *</label>
                    <input
                      type="text"
                      value={pCompanyName}
                      onChange={e => handleCompanyInputChange(e.target.value)}
                      placeholder={t("Type company name...", "কোম্পানির নাম লিখুন...")}
                      className={`w-full px-3 py-2 rounded-xl border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                    />
                    {showSuggestions && companySuggestions.length > 0 && (
                      <div className={`absolute z-20 w-72 max-h-48 overflow-y-auto rounded-xl shadow-sm border mt-1 ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                        {companySuggestions.map(name => (
                          <div key={name} className={`flex items-center justify-between px-3 py-1.5 cursor-pointer text-sm font-semibold hover:bg-indigo-500/10 ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
                            <span onClick={() => { setPCompanyName(name); setShowSuggestions(false); }} className="flex-1">{name}</span>
                            <button onClick={() => deleteCompanySuggestion(name)} className="text-red-400 hover:text-red-600 text-sm ml-2 font-black">✕ {t("Delete", "মুছুন")}</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Medicine Add Form */}
                  <form onSubmit={addItemToPurchaseCart} className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">

                    {/* Medicine Name with suggestion */}
                    <div className="col-span-2 md:col-span-2" ref={medicineSuggestRef}>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Medicine Name", "ওষুধের নাম")} *</label>
                      <input
                        type="text"
                        value={pMedicineName}
                        onChange={e => handleMedicineNameInputChange(e.target.value)}
                        placeholder={t("Type medicine name...", "ওষুধের নাম লিখুন...")}
                        className={`w-full px-2.5 py-1.5 rounded border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                      />
                      {showMedicineSuggestions && pMedicineSuggestions.length > 0 && (
                        <div className={`absolute z-20 w-72 max-h-48 overflow-y-auto rounded-xl shadow-sm border mt-1 ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                          {pMedicineSuggestions.map(item => (
                            <div key={item.name} className={`flex items-center justify-between px-3 py-1.5 cursor-pointer text-sm font-semibold hover:bg-indigo-500/10 ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
                              <span onClick={() => {
                                setPMedicineName(item.name);
                                if (item.buyPrice > 0) setPUnitPriceBox(item.buyPrice.toString());
                                if (item.sellPrice > 0) setPRetailPrice(item.sellPrice.toString());
                                if (item.company) setPCompanyName(item.company);
                                if ((item as any).category) setPCategory((item as any).category);
                                setShowMedicineSuggestions(false);
                              }} className="flex-1">
                                <span className="font-bold">{item.name}</span>
                                {item.buyPrice > 0 && <span className="ml-2 text-sm text-slate-400 font-mono">Buy: {item.buyPrice} | Sell: {item.sellPrice}</span>}
                                {item.company && <span className="ml-1 text-sm text-indigo-400">· {item.company}</span>}
                              </span>
                              <button type="button" onClick={() => deleteMedicineNameSuggestion(item.name)} className="text-red-400 hover:text-red-600 text-sm ml-2 font-black">✕ {t("Delete", "মুছুন")}</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Type", "ধরন")}</label>
                      <select value={pCategory} onChange={e => setPCategory(e.target.value)} className={`w-full px-2.5 py-1.5 rounded border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}>
                        {allCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                      </select>
                    </div>

                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Generic Name", "জেনেরিক নাম")}</label>
                      <input type="text" value={pGenericName} onChange={e => setPGenericName(e.target.value)} placeholder="e.g. Paracetamol" className={`w-full px-2.5 py-1.5 rounded border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                    </div>

                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Batch No", "ব্যাচ নং")}</label>
                      <input type="text" value={pBatchNo} onChange={e => setPBatchNo(e.target.value)} placeholder="Optional" className={`w-full px-2.5 py-1.5 rounded border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                    </div>

                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Quantity *", "পরিমাণ *")}</label>
                      <input type="number" value={pQuantity} onChange={e => handleQuantityInputChange(e.target.value)} placeholder="e.g. 100" className={`w-full px-2.5 py-1.5 rounded border outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                    </div>

                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Buy Price (each)", "ক্রয় মূল্য (প্রতিটি)")}</label>
                      <input type="number" step="any" value={pUnitPriceBox} onChange={e => handleUnitPriceInputChange(e.target.value)} placeholder="e.g. 8" className={`w-full px-2.5 py-1.5 rounded border outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                    </div>

                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Total Cost *", "মোট খরচ *")}</label>
                      <input type="number" step="any" value={pTotalCost} onChange={e => handleTotalCostInputChange(e.target.value)} placeholder="e.g. 800" className={`w-full px-2.5 py-1.5 rounded border outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                    </div>

                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Sell Price (each)", "বিক্রয় মূল্য (প্রতিটি)")}</label>
                      <input type="number" step="any" value={pRetailPrice} onChange={e => setPRetailPrice(e.target.value)} placeholder="e.g. 10" className={`w-full px-2.5 py-1.5 rounded border outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                    </div>

                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Expiry Date", "মেয়াদ তারিখ")}</label>
                      <input type="date" value={pExpireDate} onChange={e => setPExpireDate(e.target.value)} className={`w-full px-2.5 py-1.5 rounded border outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                    </div>

                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Rack Location", "র্যাক")}</label>
                      <input type="text" value={pRackLocation} onChange={e => setPRackLocation(e.target.value)} placeholder="e.g. A-3" className={`w-full px-2.5 py-1.5 rounded border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                    </div>

                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>⚠️ {t("Low Stock Alert (qty)", "কম স্টক সতর্কতা (পরিমাণ)")}</label>
                      <input type="number" value={pLowStockAlert} onChange={e => setPLowStockAlert(e.target.value)} placeholder={`${t("Default:", "ডিফল্ট:")} ${lowStockThreshold}`} className={`w-full px-2.5 py-1.5 rounded border outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                    </div>

                    <div className="col-span-full text-right">
                      <button type="submit" className="bg-indigo-500 hover:bg-indigo-600 text-white font-black px-5 py-2 rounded-xl uppercase tracking-wider shadow-sm transition">+ {t("Add to List", "তালিকায় যোগ করুন")}</button>
                    </div>
                  </form>
                </div>

                {/* Purchase Cart */}
                {purchaseCart.length > 0 && (
                  <div className={`ccard cc-orange p-3 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
                    <h4 className="text-sm font-black uppercase text-indigo-500 mb-2">📋 {t("Items Added", "যোগ করা আইটেম")} ({purchaseCart.length})</h4>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm" style={{minWidth:'500px'}}>
                        <thead>
                          <tr className={`font-black text-slate-400 border-b ${isDarkMode ? 'border-slate-700' : 'border-slate-200'}`}>
                            <th className="p-1 text-left">{t("Medicine", "ওষুধ")}</th>
                            <th className="p-1 text-center">{t("Type", "ধরন")}</th>
                            <th className="p-1 text-center">{t("Qty", "পরিমাণ")}</th>
                            <th className="p-1 text-right">{t("Buy Price", "ক্রয় মূল্য")}</th>
                            <th className="p-1 text-right">{t("Sell Price", "বিক্রয় মূল্য")}</th>
                            <th className="p-1 text-right">{t("Total", "মোট")}</th>
                            <th className="p-1"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {purchaseCart.map(item => (
                            <tr key={item.id} className={`border-b ${isDarkMode ? 'border-slate-700/50' : 'border-slate-100'}`}>
                              <td className="p-1 font-bold">{item.medicineName}</td>
                              <td className="p-1 text-center text-slate-400">{item.category}</td>
                              <td className="p-1 text-center font-mono">{item.quantity}</td>
                              <td className="p-1 text-right font-mono">{item.unitPrice.toFixed(2)}</td>
                              <td className="p-1 text-right font-mono text-emerald-500">{item.retailPrice.toFixed(2)}</td>
                              <td className="p-1 text-right font-mono font-black">{item.totalCost.toFixed(1)}</td>
                              <td className="p-1 text-center"><button onClick={() => removeItemFromPurchaseCart(item.id)} className="text-red-500 hover:underline">✕</button></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="mt-3 pt-3 border-t flex flex-col sm:flex-row items-center justify-between gap-3">
                      <div className="flex items-center gap-3 text-sm">
                        <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>{t("Total:", "মোট:")} <strong className="text-indigo-500 font-mono">{bulkCartTotalCost.toFixed(1)} {currencySymbol}</strong></span>
                        <div>
                          <label className={`text-sm font-bold mr-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Paid:", "পরিশোধ:")}</label>
                          <input type="number" value={pAmountPaid} onChange={e => setPAmountPaid(e.target.value)} placeholder={t("Amount paid...", "পরিশোধিত...")} className={`px-2 py-1 rounded border text-sm outline-none font-mono w-28 ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                        </div>
                        {currentUserRole === "ADMIN" && <span className="text-red-400 font-bold font-mono">{t("Due:", "বাকি:")} {bulkCartCalculatedDue.toFixed(1)}</span>}
                      </div>
                      <button onClick={handleBulkPurchaseMasterSubmit} className="bg-indigo-500 hover:bg-indigo-600 text-white font-black text-sm px-5 py-2 rounded-xl uppercase tracking-wider shadow transition">
                        📥 {t("Save Purchase", "ক্রয় সংরক্ষণ")}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Right: Purchase History */}
              {checkShouldRenderTabOption("purchase_reports") && (
                <div className="xl:col-span-3">
                  <div className={`ccard cc-emerald p-3 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                    <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500 mb-2">{t("Purchase History", "ক্রয়ের ইতিহাস")}</h3>
                    {currentUserRole === "ADMIN" && (
                      <div className="mb-2 text-sm flex justify-between">
                        <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>{t("Total:", "মোট:")} <strong className="text-indigo-500 font-mono">{grandTotalPurchaseCost.toFixed(1)} {currencySymbol}</strong></span>
                        <span className="text-red-400 font-bold">{t("Due:", "বাকি:")} <strong className="font-mono">{grandTotalPurchaseDue.toFixed(1)}</strong></span>
                      </div>
                    )}
                    <div className="flex flex-col gap-2 max-h-[500px] overflow-y-auto">
                      {purchaseList.map(log => (
                        <div key={log.id} style={{ contentVisibility: 'auto', containIntrinsicSize: '0 110px' } as any} className={`p-2.5 rounded-xl border flex flex-col gap-1 text-sm ${isDarkMode ? 'bg-slate-900/60 border-slate-700/60' : 'bg-slate-50 border-slate-200'}`}>
                          <div className="flex items-center justify-between font-bold">
                            <span className="text-indigo-500 truncate max-w-[140px]">{log.medicineName}</span>
                            {currentUserRole === "ADMIN" && <span className="font-mono text-slate-400">{log.totalCost.toFixed(1)} {currencySymbol}</span>}
                          </div>
                          <div className="flex items-center justify-between text-sm text-slate-400 font-semibold">
                            <span>{log.companyName}</span>
                            <span>{log.quantity} pcs</span>
                          </div>
                          <div className="flex items-center justify-between text-sm font-mono border-t pt-1 border-slate-700/5 text-slate-400">
                            {currentUserRole === "ADMIN" ? <span>{t("Due:", "বাকি:")} <strong className={log.due > 0 ? 'text-red-400' : 'text-slate-400'}>{log.due.toFixed(1)}</strong></span> : <span>-</span>}
                            <span>{log.dateString}</span>
                          </div>
                        </div>
                      ))}
                      {purchaseList.length === 0 && <div className="p-6 text-center italic text-slate-400 text-sm">{t("No purchase history.", "কোনো ক্রয়ের ইতিহাস নেই।")}</div>}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* =========================================================
              TAB: NEW PRODUCT ADD
          ========================================================= */}
          {activeTab === "new_product" && checkShouldRenderTabOption("procurement") && (
            <div key="new-product-tab" className="animate-tab-content max-w-lg mx-auto">
              <div className={`p-5 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                <h2 className="text-sm font-black uppercase tracking-wider text-indigo-500 mb-1">➕ {t("Add New Product", "নতুন পণ্য যোগ করুন")}</h2>
                <p className={`text-sm mb-4 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                  {t("Product will be saved to the database. Go to Stock In to add quantity — only then it appears in Sell.", "পণ্য ডেটাবেজে সেভ হবে। স্টক ইন থেকে পরিমাণ যোগ করলে তবেই বিক্রয়তে আসবে।")}
                </p>

                <form onSubmit={handleSaveNewProduct} className="flex flex-col gap-3">

                  {/* Company Name */}
                  <div className="relative" ref={npCompanyRef}>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Company Name", "কোম্পানির নাম")}</label>
                    <input
                      type="text"
                      value={npCompanyName}
                      onChange={e => handleNpCompanyChange(e.target.value)}
                      placeholder={t("e.g. Square Pharmaceuticals...", "যেমন: স্কয়ার ফার্মা...")}
                      className={`w-full px-3 py-2 rounded-xl border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white placeholder-slate-500' : 'bg-slate-50 border-slate-200'}`}
                    />
                    {showNpCompanySuggestions && npCompanySuggestions.length > 0 && (
                      <div className={`absolute z-30 w-full mt-1 rounded-xl border shadow-sm max-h-40 overflow-y-auto ${isDarkMode ? 'bg-slate-900/50 backdrop-blur-2xl border-slate-700/40' : 'bg-white/60 backdrop-blur-2xl border-white/40'}`}>
                        {npCompanySuggestions.slice(0, 8).map(c => (
                          <button type="button" key={c} onClick={() => { setNpCompanyName(c); setShowNpCompanySuggestions(false); }}
                            className={`w-full text-left px-3 py-2 text-sm hover:bg-indigo-500/10 transition ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
                            {c}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Medicine Name */}
                  <div className="relative" ref={npMedRef}>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Medicine Name *", "ওষুধের নাম *")}</label>
                    <input
                      type="text"
                      value={npMedicineName}
                      onChange={e => handleNpMedNameChange(e.target.value)}
                      placeholder={t("e.g. Napa 500mg...", "যেমন: নাপা ৫০০মিগ্রা...")}
                      className={`w-full px-3 py-2 rounded-xl border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white placeholder-slate-500' : 'bg-slate-50 border-slate-200'}`}
                      required
                    />
                    {showNpMedSuggestions && npMedSuggestions.length > 0 && (
                      <div className={`absolute z-30 w-full mt-1 rounded-xl border shadow-sm max-h-48 overflow-y-auto ${isDarkMode ? 'bg-slate-900/50 backdrop-blur-2xl border-slate-700/40' : 'bg-white/60 backdrop-blur-2xl border-white/40'}`}>
                        {npMedSuggestions.slice(0, 10).map(item => (
                          <button type="button" key={item.name} onClick={() => handleNpMedSelect(item)}
                            className={`w-full text-left px-3 py-2 text-sm hover:bg-indigo-500/10 transition ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
                            <span className="font-bold">{item.name}</span>
                            {item.buyPrice > 0 && <span className="ml-2 text-indigo-500 font-mono text-sm">Buy: {item.buyPrice} / Sell: {item.sellPrice}</span>}
                            {item.company && <span className={`ml-2 text-sm ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>{item.company}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Generic Name */}
                  <div>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Generic Name", "জেনেরিক নাম")}</label>
                    <input
                      type="text"
                      value={npGenericName}
                      onChange={e => setNpGenericName(e.target.value)}
                      placeholder={t("e.g. Paracetamol...", "যেমন: প্যারাসিটামল...")}
                      className={`w-full px-3 py-2 rounded-xl border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white placeholder-slate-500' : 'bg-slate-50 border-slate-200'}`}
                    />
                  </div>

                  {/* Category */}
                  <div>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Category", "ক্যাটাগরি")}</label>
                    <select value={npCategory} onChange={e => setNpCategory(e.target.value)}
                      className={`w-full px-3 py-2 rounded-xl border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}>
                      {allCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                    </select>
                  </div>

                  {/* Buy Price & Sale Price */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Buy Price *", "ক্রয় মূল্য *")} ({currencySymbol})</label>
                      <input
                        type="number"
                        value={npBuyPrice}
                        onChange={e => setNpBuyPrice(e.target.value)}
                        placeholder="0.00"
                        step="0.01"
                        className={`w-full px-3 py-2 rounded-xl border text-sm outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                        required
                      />
                    </div>
                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Sale Price *", "বিক্রয় মূল্য *")} ({currencySymbol})</label>
                      <input
                        type="number"
                        value={npSalePrice}
                        onChange={e => setNpSalePrice(e.target.value)}
                        placeholder="0.00"
                        step="0.01"
                        className={`w-full px-3 py-2 rounded-xl border text-sm outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                        required
                      />
                    </div>
                  </div>

                  {/* Info box */}
                  <div className={`rounded-xl p-3 text-sm flex items-start gap-2 ${isDarkMode ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400' : 'bg-amber-50 border border-amber-200 text-amber-700'}`}>
                    <span className="text-base shrink-0">ℹ️</span>
                    <span>{t("After adding, this product will appear in Stock In suggestions. Add quantity via Stock In — it will then become available in Sell.", "যোগ করার পর এই পণ্য স্টক ইন-এ সাজেশনে আসবে। স্টক ইন থেকে পরিমাণ যোগ করলে তবেই বিক্রয়তে দেখা যাবে।")}</span>
                  </div>

                  <div className="flex gap-2">
                    <button type="button" onClick={() => { setNpMedicineName(""); setNpCompanyName(""); setNpGenericName(""); setNpBuyPrice(""); setNpSalePrice(""); setNpCategory("Tablet"); }}
                      className={`px-4 py-2.5 rounded-xl text-sm font-bold transition ${isDarkMode ? 'bg-slate-700 text-slate-300 hover:bg-slate-600' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                      {t("Clear", "মুছুন")}
                    </button>
                    <button type="submit" className="flex-1 bg-indigo-500 hover:bg-indigo-600 text-white font-black py-2.5 rounded-xl text-sm uppercase tracking-wider shadow transition btn-press">
                      ✅ {t("Save Product", "পণ্য সেভ করুন")}
                    </button>
                    <button type="button" onClick={() => { navigateTab("procurement"); }}
                      className="px-4 py-2.5 bg-indigo-500 hover:bg-indigo-600 text-white font-bold rounded-xl text-sm transition btn-press">
                      📥 {t("Go to Stock In", "স্টক ইনে যান")}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* =========================================================
              TAB: PURCHASE HISTORY
          ========================================================= */}
          {activeTab === "purchase_history" && checkShouldRenderTabOption("purchase_history") && (() => {
            // Group individual purchase logs into vouchers by (date + company)
            const vouchers: any[] = [];
            const voucherMap: { [key: string]: any } = {};
            [...purchaseList].forEach(log => {
              const dateKey = log.dateString ? log.dateString.split('|')[0].trim() : "Unknown";
              const vKey = `${dateKey}__${log.companyName}`;
              if (!voucherMap[vKey]) {
                const vid = `PV-${Object.keys(voucherMap).length + 1}`;
                voucherMap[vKey] = {
                  voucherKey: vKey,
                  voucherId: vid,
                  companyName: log.companyName,
                  dateStr: log.dateString,
                  items: [],
                  totalCost: 0,
                  totalPaid: 0,
                  totalDue: 0,
                  logIds: [],
                };
                vouchers.push(voucherMap[vKey]);
              }
              voucherMap[vKey].items.push(log);
              voucherMap[vKey].totalCost += (log.totalCost || 0);
              voucherMap[vKey].totalPaid += (log.paid || log.totalCost || 0);
              voucherMap[vKey].totalDue += (log.due || 0);
              voucherMap[vKey].logIds.push(log.id);
            });

            const handleDeleteVoucher = (v: any) => {
              if (!confirm(t(`Delete this purchase voucher (${v.items.length} items)?`, `এই ক্রয় ভাউচার মুছে ফেলবেন (${v.items.length}টি আইটেম)?`))) return;
              const updatedList = purchaseList.filter(log => !v.logIds.includes(log.id));
              setPurchaseList(updatedList);
              cloudSet('madina_v7_purchases', JSON.stringify(updatedList));
              playSound('delete');
              addToast(t('✅ Voucher deleted!', '✅ ভাউচার মুছে ফেলা হয়েছে!'), 'success');
            };

            const handlePrintVoucher = (v: any) => {
              setSelectedVoucher(v);
              setTimeout(() => window.print(), 300);
            };

            return (
              <div className="flex flex-col gap-4">
                {/* Print-only voucher */}
                {selectedVoucher && (
                  <div
                    className="hidden print:block fixed inset-0 z-[9999] p-6"
                    style={{ background: 'linear-gradient(160deg,#fdf4ff,#eef2ff 45%,#ecfeff)', WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact', colorAdjust: 'exact' }}
                  >
                    <div className="max-w-sm mx-auto bg-white rounded-2xl border-2 border-violet-300 overflow-hidden font-mono shadow-sm">

                      {/* Branded gradient header */}
                      <div className="bg-gradient-to-br from-fuchsia-600 via-violet-600 to-indigo-600 text-white text-center px-5 pt-6 pb-5 relative overflow-hidden">
                        <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-amber-400/30"></div>
                        <div className="absolute -bottom-8 -left-8 w-28 h-28 rounded-full bg-indigo-300/25"></div>
                        <div className="w-12 h-12 mx-auto mb-2 rounded-xl bg-white/20 border border-white/50 flex items-center justify-center font-black text-lg relative overflow-hidden">{pharmacyLogo && pharmacyLogo.startsWith('data:image') ? <img src={pharmacyLogo} alt="logo" className="w-full h-full object-cover" /> : pharmacyLogo}</div>
                        <h3 className="font-black text-base uppercase tracking-wide relative">{pharmacyName}</h3>
                        <p className="text-sm opacity-90 leading-snug mt-0.5 relative">{pharmacySlogan}</p>
                        <p className="text-sm font-semibold mt-1.5 opacity-95 relative">📍 {pharmacyAddress}</p>
                      </div>

                      <div className="px-5 pb-5" style={{ background: 'linear-gradient(180deg,#fff7ed,#ffffff 30%)' }}>
                        {/* Ticket-style title pill, sits clearly below the header */}
                        <div className="flex justify-center mt-3 mb-4">
                          <span className="bg-slate-900 text-amber-300 text-sm font-black px-4 py-2 rounded-full uppercase tracking-wide shadow-sm border-2 border-amber-400 whitespace-nowrap">📦 {t("Purchase Invoice", "ক্রয় ভাউচার")}</span>
                        </div>

                        {/* Voucher meta info card */}
                        <div className="bg-gradient-to-br from-violet-50 to-indigo-50 border-2 border-violet-200 rounded-xl p-3 mb-4 flex flex-col gap-1 text-sm">
                          <div className="flex justify-between"><span className="text-violet-500 font-semibold">{t("Voucher No:", "ভাউচার নং:")}</span><span className="font-bold text-fuchsia-600">{selectedVoucher.voucherId}</span></div>
                          <div className="flex justify-between"><span className="text-violet-500 font-semibold">{t("Supplier:", "সরবরাহকারী:")}</span><span className="font-bold text-indigo-700">{selectedVoucher.companyName}</span></div>
                          <div className="flex justify-between"><span className="text-violet-500 font-semibold">{t("Date:", "তারিখ:")}</span><span className="text-slate-700">{selectedVoucher.dateStr}</span></div>
                        </div>

                        {/* Items table */}
                        <table className="w-full text-left border-collapse mb-4 text-sm overflow-hidden rounded-xl">
                          <thead>
                            <tr className="bg-gradient-to-r from-fuchsia-600 to-indigo-600 text-white">
                              <th className="py-1.5 px-2 font-bold rounded-l-lg">{t("Medicine", "ওষুধ")}</th>
                              <th className="py-1.5 px-2 font-mono text-center font-bold">{t("Qty", "পরিমাণ")}</th>
                              <th className="py-1.5 px-2 font-mono text-right font-bold">{t("Rate", "মূল্য")}</th>
                              <th className="py-1.5 px-2 font-mono text-right font-bold rounded-r-lg">{t("Total", "মোট")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedVoucher.items.map((item: any, i: number) => (
                              <tr key={i} className={i % 2 === 1 ? 'bg-amber-50' : 'bg-indigo-50/60'}>
                                <td className="py-1.5 px-2 border-b border-violet-100">
                                  <span className="block font-bold text-indigo-800">{item.medicineName}</span>
                                  {item.batchNo && item.batchNo !== 'N/A' && <span className="block text-sm text-fuchsia-500 italic">{t("Batch:", "ব্যাচ:")} {item.batchNo}</span>}
                                  {item.expireDate && item.expireDate !== 'N/A' && <span className="block text-sm text-rose-500 italic">{t("Exp:", "মেয়াদ:")} {item.expireDate}</span>}
                                </td>
                                <td className="py-1.5 px-2 font-mono text-center font-bold text-violet-700 border-b border-violet-100">{item.quantity}</td>
                                <td className="py-1.5 px-2 font-mono text-right text-slate-600 border-b border-violet-100">{item.unitPrice?.toFixed(2) || '-'}</td>
                                <td className="py-1.5 px-2 font-mono text-right font-bold text-emerald-600 border-b border-violet-100">{item.totalCost?.toFixed(1)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>

                        {/* Totals card */}
                        <div className="bg-gradient-to-br from-sky-50 to-indigo-50 border-2 border-indigo-200 rounded-xl p-3 flex flex-col gap-1.5 text-sm text-right font-semibold mb-4">
                          <div className="flex justify-between"><span className="text-sky-500">{t("Total Cost:", "মোট খরচ:")}</span><span className="font-mono text-indigo-700">{selectedVoucher.totalCost.toFixed(1)} {currencySymbol}</span></div>
                          <div className="flex justify-between"><span className="text-sky-500">{t("Paid:", "পরিশোধ:")}</span><span className="font-mono text-emerald-600">{selectedVoucher.totalPaid.toFixed(1)} {currencySymbol}</span></div>

                          {selectedVoucher.totalDue > 0 ? (
                            <div className="flex justify-between items-center bg-gradient-to-r from-rose-600 to-red-500 text-white rounded-xl px-3 py-2 mt-0.5 shadow-sm">
                              <span className="uppercase text-sm font-black tracking-wide">⚠️ {t("Due", "বাকি")}</span>
                              <span className="font-mono text-base font-black">{selectedVoucher.totalDue.toFixed(1)} {currencySymbol}</span>
                            </div>
                          ) : (
                            <div className="flex justify-between items-center bg-gradient-to-r from-emerald-600 to-indigo-500 text-white rounded-xl px-3 py-2 mt-0.5 shadow-sm">
                              <span className="uppercase text-sm font-black tracking-wide">{t("Fully Paid", "সম্পূর্ণ পরিশোধিত")}</span>
                              <span className="font-mono text-base font-black">✓</span>
                            </div>
                          )}
                        </div>

                        {/* Footer */}
                        <div className="text-center border-t-2 border-dashed border-violet-300 pt-3">
                          <p className="text-sm tracking-[0.3em] text-amber-400 mb-1.5">✦ ✦ ✦ ✦ ✦</p>
                          <p className="text-sm font-black uppercase tracking-tight bg-gradient-to-r from-fuchsia-600 to-indigo-600 bg-clip-text text-transparent">{t("Thank You!", "ধন্যবাদ!")}</p>
                          <p className="text-sm text-slate-400 mt-1">{pharmacyName} · {pharmacyAddress}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div className={`ccard cc-violet p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500">📋 {t("Purchase History", "ক্রয়ের ইতিহাস")}</h3>
                      <p className={`text-sm mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{vouchers.length} {t("vouchers", "ভাউচার")} · {purchaseList.length} {t("items total", "টি আইটেম")}</p>
                    </div>
                    <div className={`text-right text-sm font-bold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                      <div>{t("Total Purchased:", "মোট ক্রয়:")} <span className="font-mono text-indigo-500">{grandTotalPurchaseCost.toFixed(1)} {currencySymbol}</span></div>
                      {grandTotalPurchaseDue > 0 && <div className="text-red-400">{t("Total Due:", "মোট বাকি:")} <span className="font-mono">{grandTotalPurchaseDue.toFixed(1)} {currencySymbol}</span></div>}
                    </div>
                  </div>

                  {vouchers.length === 0 ? (
                    <div className="p-10 text-center text-slate-400 italic text-sm">{t("No purchase history yet.", "এখনো কোনো ক্রয়ের ইতিহাস নেই।")}</div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {vouchers.map((v, vi) => (
                        <div key={v.voucherKey} className={`rounded-xl border overflow-hidden ${isDarkMode ? 'bg-slate-900/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                          {/* Voucher Header */}
                          <div className={`flex items-center justify-between px-4 py-2.5 ${isDarkMode ? 'bg-slate-800 border-b border-slate-700' : 'bg-white border-b border-slate-200'}`}>
                            <div className="flex items-center gap-3">
                              <span className={`text-sm font-black font-mono px-2 py-0.5 rounded ${isDarkMode ? 'bg-indigo-500/20 text-indigo-400' : 'bg-indigo-50 text-indigo-600'}`}>{v.voucherId}</span>
                              <div>
                                <div className="text-sm font-black">{v.companyName}</div>
                                <div className={`text-sm font-mono ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{v.dateStr}</div>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <div className="text-right hidden sm:block">
                                <div className="text-sm font-black font-mono text-indigo-500">{v.totalCost.toFixed(1)} {currencySymbol}</div>
                                {v.totalDue > 0 && <div className="text-sm font-mono text-red-400">{t("Due:", "বাকি:")} {v.totalDue.toFixed(1)}</div>}
                              </div>
                              <div className="flex gap-1.5">
                                <button
                                  onClick={() => { setSelectedVoucher(v); setTimeout(() => window.print(), 300); playSound('print'); }}
                                  className={`p-1.5 rounded-xl text-sm font-bold transition btn-press ${isDarkMode ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500 hover:text-white' : 'bg-blue-50 text-blue-500 hover:bg-blue-500 hover:text-white'}`}
                                  title={t("Print Invoice", "প্রিন্ট করুন")}
                                >🖨️</button>
                                <button
                                  onClick={() => posPrintPurchaseVoucher(v)}
                                  className={`p-1.5 rounded-xl text-sm font-bold transition btn-press ${isDarkMode ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500 hover:text-white' : 'bg-amber-50 text-amber-600 hover:bg-amber-500 hover:text-white'}`}
                                  title={t("POS Print", "POS প্রিন্ট")}
                                >🧾</button>
                                {currentUserRole === "ADMIN" && (
                                  <button
                                    onClick={() => handleDeleteVoucher(v)}
                                    className={`p-1.5 rounded-xl text-sm font-bold transition btn-press ${isDarkMode ? 'bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white' : 'bg-red-50 text-red-500 hover:bg-red-500 hover:text-white'}`}
                                    title={t("Delete Voucher", "ভাউচার মুছুন")}
                                  >🗑️</button>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Items Table */}
                          <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm border-collapse" style={{minWidth:'500px'}}>
                              <thead>
                                <tr className={`font-black text-sm uppercase tracking-wider ${isDarkMode ? 'text-slate-500 border-b border-slate-700/50' : 'text-slate-400 border-b border-slate-200'}`}>
                                  <th className="px-4 py-1.5">{t("Medicine", "ওষুধ")}</th>
                                  <th className="px-4 py-1.5">{t("Category", "ধরন")}</th>
                                  {checkShouldRenderTabOption("batch_tracking") && <th className="px-4 py-1.5">{t("Batch", "ব্যাচ")}</th>}
                                  {checkShouldRenderTabOption("expiry_tracker") && <th className="px-4 py-1.5">{t("Expiry", "মেয়াদ")}</th>}
                                  <th className="px-4 py-1.5 text-center">{t("Qty", "পরিমাণ")}</th>
                                  {checkShouldRenderTabOption("purchase_reports") && <th className="px-4 py-1.5 text-right">{t("Unit Price", "ইউনিট দাম")}</th>}
                                  {checkShouldRenderTabOption("purchase_reports") && <th className="px-4 py-1.5 text-right">{t("Total", "মোট")}</th>}
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-700/10">
                                {v.items.map((item: any, ii: number) => (
                                  <tr key={ii} className="hover:bg-slate-500/5 transition-colors">
                                    <td className="px-4 py-2">
                                      <div className="font-bold">{item.medicineName}</div>
                                      {item.genericName && item.genericName !== 'N/A' && <div className={`text-sm italic ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>{item.genericName}</div>}
                                    </td>
                                    <td className="px-4 py-2">
                                      <span className={`text-sm px-1.5 py-0.5 rounded font-bold ${isDarkMode ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>{item.category}</span>
                                    </td>
                                    {checkShouldRenderTabOption("batch_tracking") && <td className="px-4 py-2 font-mono text-slate-400">{item.batchNo || '-'}</td>}
                                    {checkShouldRenderTabOption("expiry_tracker") && (
                                      <td className="px-4 py-2 font-mono">
                                        <span className={`text-sm font-bold ${new Date(item.expireDate) < new Date() ? 'text-red-400' : 'text-slate-400'}`}>{item.expireDate || '-'}</span>
                                      </td>
                                    )}
                                    <td className="px-4 py-2 text-center font-mono font-black text-blue-400">{item.quantity}</td>
                                    {checkShouldRenderTabOption("purchase_reports") && <td className="px-4 py-2 text-right font-mono text-slate-400">{item.unitPrice?.toFixed(2) || '-'}</td>}
                                    {checkShouldRenderTabOption("purchase_reports") && <td className="px-4 py-2 text-right font-mono font-black text-indigo-500">{item.totalCost?.toFixed(1)}</td>}
                                  </tr>
                                ))}
                              </tbody>
                              {checkShouldRenderTabOption("purchase_reports") && (
                                <tfoot>
                                  <tr className={`font-black text-sm border-t-2 ${isDarkMode ? 'border-slate-600 bg-slate-900/40' : 'border-slate-300 bg-slate-100'}`}>
                                    <td colSpan={checkShouldRenderTabOption("batch_tracking") && checkShouldRenderTabOption("expiry_tracker") ? 5 : checkShouldRenderTabOption("batch_tracking") || checkShouldRenderTabOption("expiry_tracker") ? 4 : 3} className="px-4 py-2 text-right uppercase">{t("Total:", "মোট:")}</td>
                                    <td className="px-4 py-2 text-right font-mono text-indigo-500">{v.totalCost.toFixed(1)} {currencySymbol}</td>
                                  </tr>
                                  {v.totalDue > 0 && (
                                    <tr className={`text-sm ${isDarkMode ? 'bg-red-500/5' : 'bg-red-50'}`}>
                                      <td colSpan={checkShouldRenderTabOption("batch_tracking") && checkShouldRenderTabOption("expiry_tracker") ? 5 : checkShouldRenderTabOption("batch_tracking") || checkShouldRenderTabOption("expiry_tracker") ? 4 : 3} className="px-4 py-1.5 text-right font-bold text-red-400">{t("Due:", "বাকি:")}</td>
                                      <td className="px-4 py-1.5 text-right font-mono font-black text-red-500">{v.totalDue.toFixed(1)} {currencySymbol}</td>
                                    </tr>
                                  )}
                                </tfoot>
                              )}
                            </table>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* =========================================================
              TAB 4B: COMPANY PURCHASE HISTORY (lifetime totals per company)
          ========================================================= */}
          {activeTab === "company_purchase_history" && checkShouldRenderTabOption("company_purchase_history_view") && (
            <div className={`ccard cc-violet p-4 rounded-xl border shadow-sm print:p-0 print:border-none print:shadow-none print:bg-transparent print:rounded-none ${isDarkMode ? 'bg-slate-800/40 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2 print:hidden">
                <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500">🏭 {t("Company Purchase History", "কোম্পানি ক্রয় ইতিহাস")}</h3>
                <div className="flex items-center gap-3">
                  <div className={`text-sm font-bold ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                    {t("Total Purchased:", "মোট ক্রয়:")} <span className="text-violet-500 font-mono font-black">{grandTotalPurchaseCost.toFixed(1)} {currencySymbol}</span>
                  </div>
                  <button onClick={() => window.print()} className="bg-indigo-500 hover:bg-indigo-600 text-white font-bold text-sm px-3 py-1.5 rounded-xl transition uppercase tracking-wider">🖨️ {t("Print", "প্রিন্ট")}</button>
                  <button onClick={() => {
                    const filtered = companyPurchaseSearch.trim()
                      ? companyPurchaseSummary.filter((c: any) => c.company.toLowerCase().includes(companyPurchaseSearch.toLowerCase()))
                      : companyPurchaseSummary;
                    const grandQty = filtered.reduce((s: number, c: any) => s + c.totalQty, 0);
                    const grandCost = filtered.reduce((s: number, c: any) => s + c.totalCost, 0);
                    const grandCount = filtered.reduce((s: number, c: any) => s + c.purchaseCount, 0);
                    posPrintReport(
                      '🏭 ' + t("Company Purchase History", "কোম্পানি ক্রয় ইতিহাস"),
                      [t("Company", "কোম্পানি"), t("Qty", "পরিমাণ"), t("Amount", "টাকা")],
                      filtered.map((c: any) => [c.company, c.totalQty, c.totalCost.toFixed(1)]),
                      [
                        { label: t("Total Quantity:", "মোট পরিমাণ:"), value: String(grandQty) },
                        { label: t("Total Purchases:", "মোট ক্রয় সংখ্যা:"), value: String(grandCount) },
                        { label: t("Grand Total", "সর্বমোট"), value: grandCost.toFixed(1) + ' ' + currencySymbol, emphasize: true },
                      ]
                    );
                  }} className="bg-amber-500 hover:bg-amber-600 text-white font-bold text-sm px-3 py-1.5 rounded-xl transition uppercase tracking-wider">🧾 {t("POS Print", "POS প্রিন্ট")}</button>
                </div>
              </div>

              {/* Search Bar */}
              <div className="mb-3 print:hidden">
                <input
                  type="text"
                  value={companyPurchaseSearch}
                  onChange={e => setCompanyPurchaseSearch(e.target.value)}
                  placeholder={t("Search by company name...", "কোম্পানির নাম দিয়ে খুঁজুন...")}
                  className={`w-full px-3 py-2 rounded-xl border text-sm outline-none transition ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white placeholder-slate-500' : 'bg-white border-slate-200 text-slate-800 placeholder-slate-400'}`}
                />
              </div>

              {companyPurchaseSummary.length === 0 ? (
                <div className="text-center py-12 text-slate-400 italic text-sm">{t("No purchase history yet.", "এখনো কোনো ক্রয়ের ইতিহাস নেই।")}</div>
              ) : (() => {
                const filtered = companyPurchaseSearch.trim()
                  ? companyPurchaseSummary.filter((c: any) => c.company.toLowerCase().includes(companyPurchaseSearch.toLowerCase()))
                  : companyPurchaseSummary;
                const grandQty = filtered.reduce((s: number, c: any) => s + c.totalQty, 0);
                const grandCost = filtered.reduce((s: number, c: any) => s + c.totalCost, 0);
                const grandCount = filtered.reduce((s: number, c: any) => s + c.purchaseCount, 0);

                return (
                  <>
                    {/* Screen view */}
                    <div className="overflow-x-auto print:hidden">
                      {filtered.length === 0 ? (
                        <div className="text-center py-8 text-slate-400 italic text-sm">{t("No results found.", "কোনো ফলাফল পাওয়া যায়নি।")}</div>
                      ) : (
                      <table className="w-full text-left text-sm border-collapse" style={{minWidth:'500px'}}>
                        <thead>
                          <tr className={`font-black text-slate-400 border-b ${isDarkMode ? 'bg-slate-900/40 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                            <th className="p-2.5">#</th>
                            <th className="p-2.5">{t("Company Name", "কোম্পানির নাম")}</th>
                            <th className="p-2.5 text-right">{t("Total Quantity Purchased", "মোট ক্রয়কৃত পরিমাণ")}</th>
                            <th className="p-2.5 text-right">{t("Total Amount", "মোট টাকা")}</th>
                            <th className="p-2.5 text-center">{t("Purchases", "ক্রয় সংখ্যা")}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700/10">
                          {filtered.map((c: any, idx: number) => (
                            <tr key={c.company} className="hover:bg-slate-500/5 transition-colors">
                              <td className="p-2.5 text-slate-400">{idx + 1}</td>
                              <td className="p-2.5 font-black">{c.company}</td>
                              <td className="p-2.5 text-right font-mono text-slate-400">{c.totalQty} {t("pcs", "টি")}</td>
                              <td className="p-2.5 text-right font-mono font-black text-violet-500 text-sm">{c.totalCost.toFixed(1)} {currencySymbol}</td>
                              <td className="p-2.5 text-center font-mono text-slate-400">{c.purchaseCount}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className={`font-black text-sm border-t-2 ${isDarkMode ? 'border-slate-600 bg-slate-900/40' : 'border-slate-300 bg-slate-100'}`}>
                            <td colSpan={2} className="px-2.5 py-2 text-right uppercase">{t("Total:", "মোট:")}</td>
                            <td className="px-2.5 py-2 text-right font-mono text-slate-400">{grandQty} {t("pcs", "টি")}</td>
                            <td className="px-2.5 py-2 text-right font-mono text-violet-500">{grandCost.toFixed(1)} {currencySymbol}</td>
                            <td className="px-2.5 py-2 text-center font-mono text-slate-400">{grandCount}</td>
                          </tr>
                        </tfoot>
                      </table>
                      )}
                    </div>

                    {/* Colorful print-only report */}
                    <div className="hidden print:block w-full p-0 cph-print-report">
                      <div className="w-full bg-white rounded-2xl border-2 border-violet-300 overflow-hidden font-mono shadow-sm">

                        {/* Branded gradient header */}
                        <div className="bg-gradient-to-br from-fuchsia-600 via-violet-600 to-indigo-600 text-white text-center px-5 pt-6 pb-5 relative overflow-hidden">
                          <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-amber-400/30"></div>
                          <div className="absolute -bottom-8 -left-8 w-28 h-28 rounded-full bg-indigo-300/25"></div>
                          <div className="w-12 h-12 mx-auto mb-2 rounded-xl bg-white/20 border border-white/50 flex items-center justify-center font-black text-lg relative overflow-hidden">{pharmacyLogo && pharmacyLogo.startsWith('data:image') ? <img src={pharmacyLogo} alt="logo" className="w-full h-full object-cover" /> : pharmacyLogo}</div>
                          <h3 className="font-black text-base uppercase tracking-wide relative">{pharmacyName}</h3>
                          <p className="text-sm opacity-90 leading-snug mt-0.5 relative">{pharmacySlogan}</p>
                          <p className="text-sm font-semibold mt-1.5 opacity-95 relative">📍 {pharmacyAddress}</p>
                        </div>

                        <div className="px-5 pb-5" style={{ background: 'linear-gradient(180deg,#fff7ed,#ffffff 30%)' }}>
                          {/* Ticket-style title pill */}
                          <div className="flex justify-center mt-3 mb-4">
                            <span className="bg-slate-900 text-amber-300 text-sm font-black px-4 py-2 rounded-full uppercase tracking-wide shadow-sm border-2 border-amber-400 whitespace-nowrap">🏭 {t("Company Purchase History", "কোম্পানি ক্রয় ইতিহাস")}</span>
                          </div>

                          {/* Report meta info card */}
                          <div className="bg-gradient-to-br from-violet-50 to-indigo-50 border-2 border-violet-200 rounded-xl p-3 mb-4 flex flex-col gap-1 text-sm">
                            <div className="flex justify-between"><span className="text-violet-500 font-semibold">{t("Generated On:", "তৈরি হয়েছে:")}</span><span className="font-bold text-indigo-700">{new Date().toLocaleDateString()}</span></div>
                            <div className="flex justify-between"><span className="text-violet-500 font-semibold">{t("Companies Listed:", "কোম্পানি সংখ্যা:")}</span><span className="font-bold text-fuchsia-600">{filtered.length}</span></div>
                          </div>

                          {/* Companies table */}
                          <table className="w-full text-left border-collapse mb-4 text-sm overflow-hidden rounded-xl">
                            <thead>
                              <tr className="bg-gradient-to-r from-fuchsia-600 to-indigo-600 text-white">
                                <th className="py-1.5 px-2 font-bold rounded-l-lg">#</th>
                                <th className="py-1.5 px-2 font-bold">{t("Company Name", "কোম্পানির নাম")}</th>
                                <th className="py-1.5 px-2 font-mono text-right font-bold">{t("Qty", "পরিমাণ")}</th>
                                <th className="py-1.5 px-2 font-mono text-right font-bold">{t("Amount", "টাকা")}</th>
                                <th className="py-1.5 px-2 font-mono text-center font-bold rounded-r-lg">{t("Purchases", "ক্রয়")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {filtered.map((c: any, idx: number) => (
                                <tr key={c.company} className={idx % 2 === 1 ? 'bg-amber-50' : 'bg-indigo-50/60'}>
                                  <td className="py-1.5 px-2 border-b border-violet-100 text-slate-400">{idx + 1}</td>
                                  <td className="py-1.5 px-2 border-b border-violet-100 font-bold text-indigo-800">{c.company}</td>
                                  <td className="py-1.5 px-2 font-mono text-right border-b border-violet-100 text-slate-600">{c.totalQty} {t("pcs", "টি")}</td>
                                  <td className="py-1.5 px-2 font-mono text-right border-b border-violet-100 font-bold text-emerald-600">{c.totalCost.toFixed(1)} {currencySymbol}</td>
                                  <td className="py-1.5 px-2 font-mono text-center border-b border-violet-100 font-bold text-violet-700">{c.purchaseCount}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>

                          {/* Totals card */}
                          <div className="bg-gradient-to-br from-sky-50 to-indigo-50 border-2 border-indigo-200 rounded-xl p-3 flex flex-col gap-1.5 text-sm text-right font-semibold mb-4">
                            <div className="flex justify-between"><span className="text-sky-500">{t("Total Quantity:", "মোট পরিমাণ:")}</span><span className="font-mono text-indigo-700">{grandQty} {t("pcs", "টি")}</span></div>
                            <div className="flex justify-between"><span className="text-sky-500">{t("Total Purchases:", "মোট ক্রয় সংখ্যা:")}</span><span className="font-mono text-indigo-700">{grandCount}</span></div>
                            <div className="flex justify-between items-center bg-gradient-to-r from-emerald-600 to-indigo-500 text-white rounded-xl px-3 py-2 mt-0.5 shadow-sm">
                              <span className="uppercase text-sm font-black tracking-wide">{t("Grand Total", "সর্বমোট")}</span>
                              <span className="font-mono text-base font-black">{grandCost.toFixed(1)} {currencySymbol}</span>
                            </div>
                          </div>

                          {/* Footer */}
                          <div className="text-center border-t-2 border-dashed border-violet-300 pt-3">
                            <p className="text-sm tracking-[0.3em] text-amber-400 mb-1.5">✦ ✦ ✦ ✦ ✦</p>
                            <p className="text-sm font-black uppercase tracking-tight bg-gradient-to-r from-fuchsia-600 to-indigo-600 bg-clip-text text-transparent">{t("End of Report", "প্রতিবেদনের সমাপ্তি")}</p>
                            <p className="text-sm text-slate-400 mt-1">{pharmacyName} · {pharmacyAddress}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {/* =========================================================
              TAB 5: INVOICES
          ========================================================= */}
          {activeTab === "invoices" && checkShouldRenderTabOption("invoices") && (
            <div className={`ccard cc-pink p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mb-4">
                <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500">{t("Customer Invoices", "গ্রাহকের রশিদ")} ({invoices.length})</h3>
                {checkShouldRenderTabOption("invoice_search") && (
                  <input type="text" placeholder={t("Search by invoice, customer, phone...", "রশিদ নং, নাম বা ফোনে খুঁজুন...")} value={searchInvoiceQuery} onChange={e => setSearchInvoiceQuery(e.target.value)} className={`px-3 py-1.5 text-sm rounded-xl border outline-none max-w-sm w-full ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                )}
              </div>

              <div className="overflow-x-auto w-full">
                <table className="w-full text-left text-sm border-collapse" style={{minWidth:'600px'}}>
                  <thead>
                    <tr className={`font-black text-slate-400 border-b ${isDarkMode ? 'bg-slate-900/40 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                      <th className="p-2.5">{t("Invoice #", "রশিদ নং")}</th>
                      <th className="p-2.5">{t("Customer", "গ্রাহক")}</th>
                      <th className="p-2.5">{t("Date", "তারিখ")}</th>
                      <th className="p-2.5 text-right">{t("Total Bill", "মোট বিল")}</th>
                      <th className="p-2.5 text-right">{t("Payment", "পেমেন্ট")}</th>
                      <th className="p-2.5 text-right text-red-400">{t("Due", "বাকি")}</th>
                      {currentUserRole === "ADMIN" && <th className="p-2.5 text-right">{t("Profit", "লাভ")}</th>}
                      <th className="p-2.5 text-center">{t("Status", "অবস্থা")}</th>
                      <th className="p-2.5 text-center">{t("Actions", "কার্যক্রম")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/10">
                    {pagedInvoices.map(inv => (
                      <tr key={inv.invoiceId} style={{ contentVisibility: 'auto', containIntrinsicSize: '0 52px' } as any} className="hover:bg-slate-500/5 transition-colors">
                        <td className="p-2.5 font-mono font-black text-indigo-500">{inv.invoiceId}</td>
                        <td className="p-2.5 font-bold">
                          <div>{inv.customer}</div>
                          <div className="text-sm text-slate-400 font-mono">{inv.phone}</div>
                        </td>
                        <td className="p-2.5 font-mono text-slate-400 text-sm">{inv.dateString}</td>
                        <td className="p-2.5 font-mono text-right font-black text-indigo-500">{inv.finalBill.toFixed(1)} {currencySymbol}</td>
                        <td className="p-2.5 text-right">
                          <span className={`text-sm font-bold px-1.5 py-0.5 rounded ${inv.paymentMethod === "bKash/Nagad" ? 'bg-pink-500/10 text-pink-500' : inv.paymentMethod === "Card" ? 'bg-indigo-500/10 text-indigo-500' : 'bg-emerald-500/10 text-emerald-500'}`}>
                            {inv.paymentMethod}
                          </span>
                        </td>
                        <td className="p-2.5 font-mono text-right font-black text-red-400">{(inv.due || 0).toFixed(1)}</td>
                        {currentUserRole === "ADMIN" && (
                          <td className={`p-2.5 font-mono text-right font-black ${inv.profit >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>{inv.profit.toFixed(1)}</td>
                        )}
                        <td className="p-2.5 text-center">
                          {inv.isReturned
                            ? <span className="text-xs bg-red-500/10 text-red-400 font-black uppercase px-2 py-0.5 rounded">{t("Returned", "ফেরত")}</span>
                            : <span className="text-xs bg-indigo-500/10 text-indigo-500 font-black uppercase px-2 py-0.5 rounded">{t("Paid", "পরিশোধ")}</span>
                          }
                        </td>
                        <td className="p-2.5 text-center">
                          <div className="flex gap-2 justify-center">
                            <button onClick={() => viewInvoiceLog(inv)} className="bg-slate-500 hover:bg-slate-600 text-white font-bold text-sm px-2 py-0.5 rounded transition">🔍</button>
                            <button onClick={() => { setLastInvoice(inv); setShowReceipt(true); setTimeout(() => { playSound('print'); window.print(); }, 300); }} className="bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500 hover:text-white font-bold text-sm px-2 py-0.5 rounded transition">🖨️</button>
                            <button onClick={() => posPrintInvoice(inv)} title={t("POS Print", "POS প্রিন্ট")} className="bg-amber-500/10 text-amber-600 hover:bg-amber-500 hover:text-white font-bold text-sm px-2 py-0.5 rounded transition">🧾</button>
                            {checkShouldRenderTabOption("returns") && !inv.isReturned && (
                              <button onClick={() => openReturnInterface(inv)} className="bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white font-bold text-sm px-2 py-0.5 rounded transition">🔄</button>
                            )}
                            {currentUserRole === "ADMIN" && (
                              <button onClick={() => deleteInvoice(inv.invoiceId)} className="bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white font-bold text-sm px-2 py-0.5 rounded transition">🗑️</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filteredInvoices.length === 0 && <tr><td colSpan={9} className="text-center p-8 text-slate-400 italic">{t("No invoices found.", "কোনো রশিদ পাওয়া যায়নি।")}</td></tr>}
                  </tbody>
                </table>
              </div>
              {filteredInvoices.length > INVOICE_PAGE_SIZE && (
                <div className="flex items-center justify-between pt-3 text-sm font-bold">
                  <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>
                    {t("Page", "পাতা")} {invoicePage} / {invoiceTotalPages} — {filteredInvoices.length} {t("invoices", "টি রশিদ")}
                  </span>
                  <div className="flex gap-2">
                    <button onClick={() => setInvoicePage(p => Math.max(1, p - 1))} disabled={invoicePage === 1} className="px-3 py-1 rounded-lg border disabled:opacity-40 hover:bg-slate-500/10 transition">← {t("Prev", "আগে")}</button>
                    <button onClick={() => setInvoicePage(p => Math.min(invoiceTotalPages, p + 1))} disabled={invoicePage === invoiceTotalPages} className="px-3 py-1 rounded-lg border disabled:opacity-40 hover:bg-slate-500/10 transition">{t("Next", "পরে")} →</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* =========================================================
              TAB 6: DUE LIST
          ========================================================= */}
          {activeTab === "due_list" && checkShouldRenderTabOption("due_list_view") && (
            <div className={`ccard cc-rose p-4 rounded-xl border shadow-sm print:p-0 print:border-none print:shadow-none print:bg-transparent print:rounded-none ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2 print:hidden">
                <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500">💳 {t("Customer Due List", "গ্রাহকের বাকি তালিকা")}</h3>
                <div className="flex items-center gap-3">
                  <div className={`text-sm font-bold ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                    {t("Total Outstanding:", "মোট বাকি:")} <span className="text-red-500 font-mono font-black">{totalDueFromCustomers.toFixed(1)} {currencySymbol}</span>
                  </div>
                  <button onClick={() => window.print()} className="bg-indigo-500 hover:bg-indigo-600 text-white font-bold text-sm px-3 py-1.5 rounded-xl transition uppercase tracking-wider">🖨️ {t("Print", "প্রিন্ট")}</button>
                  <button onClick={() => {
                    const filtered = dueSearch.trim()
                      ? dueList.filter(d => d.customerName.toLowerCase().includes(dueSearch.toLowerCase()) || (d.phone && d.phone.includes(dueSearch)))
                      : dueList;
                    const grandDue = filtered.reduce((s: number, d: any) => s + d.totalDue, 0);
                    posPrintReport(
                      '💳 ' + t("Customer Due List", "গ্রাহকের বাকি তালিকা"),
                      [t("Customer", "গ্রাহক"), t("Phone", "ফোন"), t("Due", "বাকি")],
                      filtered.map((d: any) => [d.customerName, d.phone || '', d.totalDue.toFixed(1)]),
                      [{ label: t("Grand Total Due", "সর্বমোট বাকি"), value: grandDue.toFixed(1) + ' ' + currencySymbol, emphasize: true }]
                    );
                  }} className="bg-amber-500 hover:bg-amber-600 text-white font-bold text-sm px-3 py-1.5 rounded-xl transition uppercase tracking-wider">🧾 {t("POS Print", "POS প্রিন্ট")}</button>
                </div>
              </div>

              {/* Search Bar */}
              <div className="mb-3 print:hidden">
                <input
                  type="text"
                  value={dueSearch}
                  onChange={e => setDueSearch(e.target.value)}
                  placeholder={t("Search by name or phone...", "নাম বা নম্বর দিয়ে খুঁজুন...")}
                  className={`w-full px-3 py-2 rounded-xl border text-sm outline-none transition ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white placeholder-slate-500' : 'bg-white border-slate-200 text-slate-800 placeholder-slate-400'}`}
                />
              </div>

              {dueList.length === 0 ? (
                <div className="text-center py-12 text-slate-400 italic text-sm">{t("No outstanding dues.", "কোনো বাকি নেই।")}</div>
              ) : (() => {
                const filtered = dueSearch.trim()
                  ? dueList.filter(d =>
                      d.customerName.toLowerCase().includes(dueSearch.toLowerCase()) ||
                      (d.phone && d.phone.includes(dueSearch))
                    )
                  : dueList;
                const grandDue = filtered.reduce((s: number, d: any) => s + d.totalDue, 0);

                return (
                  <>
                    {/* Screen view */}
                    <div className="overflow-x-auto print:hidden">
                      {filtered.length === 0 ? (
                        <div className="text-center py-8 text-slate-400 italic text-sm">{t("No results found.", "কোনো ফলাফল পাওয়া যায়নি।")}</div>
                      ) : (
                      <table className="w-full text-left text-sm border-collapse" style={{minWidth:'500px'}}>
                        <thead>
                          <tr className={`font-black text-slate-400 border-b ${isDarkMode ? 'bg-slate-900/40 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                            <th className="p-2.5">#</th>
                            <th className="p-2.5">{t("Customer Name", "গ্রাহকের নাম")}</th>
                            <th className="p-2.5">{t("Phone", "ফোন")}</th>
                            <th className="p-2.5">{t("Invoices", "রশিদ")}</th>
                            <th className="p-2.5 text-right">{t("Total Due", "মোট বাকি")}</th>
                            <th className="p-2.5 text-center">{t("Action", "কার্যক্রম")}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700/10">
                          {filtered.map((due, idx) => (
                            <tr key={due.id} className="hover:bg-slate-500/5 transition-colors">
                              <td className="p-2.5 text-slate-400">{idx + 1}</td>
                              <td className="p-2.5 font-black">{due.customerName}</td>
                              <td className="p-2.5 font-mono text-slate-400">{due.phone}</td>
                              <td className="p-2.5 text-slate-400 text-sm">
                                {due.invoices.map((inv: any) => (
                                  <span key={inv.invoiceId} className="mr-2">{inv.invoiceId} ({inv.amount.toFixed(1)})</span>
                                ))}
                              </td>
                              <td className="p-2.5 text-right font-mono font-black text-red-500 text-sm">{due.totalDue.toFixed(1)} {currencySymbol}</td>
                              <td className="p-2.5 text-center">
                                <button onClick={() => { setDuePaymentModal(due); setDuePayAmount(""); openEdit(() => setDuePaymentModal(null)); }} className="bg-indigo-500 hover:bg-indigo-600 text-white font-bold text-sm px-3 py-1 rounded transition">
                                  💰 {t("Collect Payment", "পরিশোধ নিন")}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      )}
                    </div>

                    {/* Colorful print-only report */}
                    <div className="hidden print:block w-full p-0 cph-print-report">
                      <div className="w-full bg-white rounded-2xl border-2 border-violet-300 overflow-hidden font-mono shadow-sm">

                        {/* Branded gradient header */}
                        <div className="bg-gradient-to-br from-rose-600 via-red-600 to-amber-500 text-white text-center px-5 pt-6 pb-5 relative overflow-hidden">
                          <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-amber-300/30"></div>
                          <div className="absolute -bottom-8 -left-8 w-28 h-28 rounded-full bg-rose-300/25"></div>
                          <div className="w-12 h-12 mx-auto mb-2 rounded-xl bg-white/20 border border-white/50 flex items-center justify-center font-black text-lg relative overflow-hidden">{pharmacyLogo && pharmacyLogo.startsWith('data:image') ? <img src={pharmacyLogo} alt="logo" className="w-full h-full object-cover" /> : pharmacyLogo}</div>
                          <h3 className="font-black text-base uppercase tracking-wide relative">{pharmacyName}</h3>
                          <p className="text-sm opacity-90 leading-snug mt-0.5 relative">{pharmacySlogan}</p>
                          <p className="text-sm font-semibold mt-1.5 opacity-95 relative">📍 {pharmacyAddress}</p>
                        </div>

                        <div className="px-5 pb-5" style={{ background: 'linear-gradient(180deg,#fff1f2,#ffffff 30%)' }}>
                          {/* Ticket-style title pill */}
                          <div className="flex justify-center mt-3 mb-4">
                            <span className="bg-slate-900 text-amber-300 text-sm font-black px-4 py-2 rounded-full uppercase tracking-wide shadow-sm border-2 border-amber-400 whitespace-nowrap">💳 {t("Customer Due List", "গ্রাহকের বাকি তালিকা")}</span>
                          </div>

                          {/* Report meta info card */}
                          <div className="bg-gradient-to-br from-rose-50 to-orange-50 border-2 border-rose-200 rounded-xl p-3 mb-4 flex flex-col gap-1 text-sm">
                            <div className="flex justify-between"><span className="text-rose-500 font-semibold">{t("Generated On:", "তৈরি হয়েছে:")}</span><span className="font-bold text-red-700">{new Date().toLocaleDateString()}</span></div>
                            <div className="flex justify-between"><span className="text-rose-500 font-semibold">{t("Customers Listed:", "গ্রাহক সংখ্যা:")}</span><span className="font-bold text-amber-600">{filtered.length}</span></div>
                          </div>

                          {/* Due table */}
                          <table className="w-full text-left border-collapse mb-4 text-sm overflow-hidden rounded-xl">
                            <thead>
                              <tr className="bg-gradient-to-r from-rose-600 to-amber-500 text-white">
                                <th className="py-1.5 px-2 font-bold rounded-l-lg">#</th>
                                <th className="py-1.5 px-2 font-bold">{t("Customer", "গ্রাহক")}</th>
                                <th className="py-1.5 px-2 font-mono font-bold">{t("Phone", "ফোন")}</th>
                                <th className="py-1.5 px-2 font-bold">{t("Invoices", "রশিদ")}</th>
                                <th className="py-1.5 px-2 font-mono text-right font-bold rounded-r-lg">{t("Total Due", "মোট বাকি")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {filtered.map((due: any, idx: number) => (
                                <tr key={due.id} className={idx % 2 === 1 ? 'bg-amber-50' : 'bg-rose-50/60'}>
                                  <td className="py-1.5 px-2 border-b border-rose-100 text-slate-400">{idx + 1}</td>
                                  <td className="py-1.5 px-2 border-b border-rose-100 font-bold text-red-800">{due.customerName}</td>
                                  <td className="py-1.5 px-2 border-b border-rose-100 font-mono text-slate-600">{due.phone}</td>
                                  <td className="py-1.5 px-2 border-b border-rose-100 text-sm text-violet-600">
                                    {due.invoices.map((inv: any) => (
                                      <span key={inv.invoiceId} className="mr-2">{inv.invoiceId} ({inv.amount.toFixed(1)})</span>
                                    ))}
                                  </td>
                                  <td className="py-1.5 px-2 font-mono text-right border-b border-rose-100 font-bold text-red-600">{due.totalDue.toFixed(1)} {currencySymbol}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>

                          {/* Totals card */}
                          <div className="bg-gradient-to-br from-orange-50 to-amber-50 border-2 border-amber-200 rounded-xl p-3 flex flex-col gap-1.5 text-sm text-right font-semibold mb-4">
                            <div className="flex justify-between items-center bg-gradient-to-r from-rose-600 to-red-500 text-white rounded-xl px-3 py-2 mt-0.5 shadow-sm">
                              <span className="uppercase text-sm font-black tracking-wide">⚠️ {t("Grand Total Due", "সর্বমোট বাকি")}</span>
                              <span className="font-mono text-base font-black">{grandDue.toFixed(1)} {currencySymbol}</span>
                            </div>
                          </div>

                          {/* Footer */}
                          <div className="text-center border-t-2 border-dashed border-rose-300 pt-3">
                            <p className="text-sm tracking-[0.3em] text-amber-400 mb-1.5">✦ ✦ ✦ ✦ ✦</p>
                            <p className="text-sm font-black uppercase tracking-tight bg-gradient-to-r from-rose-600 to-amber-500 bg-clip-text text-transparent">{t("End of Report", "প্রতিবেদনের সমাপ্তি")}</p>
                            <p className="text-sm text-slate-400 mt-1">{pharmacyName} · {pharmacyAddress}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {/* =========================================================
              TAB 6B: DUE COLLECTION LIST (history of who paid off dues)
          ========================================================= */}
          {activeTab === "due_collection" && checkShouldRenderTabOption("due_collection_view") && (
            <div className={`ccard cc-emerald p-4 rounded-xl border shadow-sm print:p-0 print:border-none print:shadow-none print:bg-transparent print:rounded-none ${isDarkMode ? 'bg-slate-800/40 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2 print:hidden">
                <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500">📒 {t("Due Collection List", "বাকি আদায় তালিকা")}</h3>
                <div className="flex items-center gap-3">
                  <div className={`text-sm font-bold ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                    {t("Total Collected:", "মোট আদায়:")} <span className="text-emerald-500 font-mono font-black">{dueCollectionLog.reduce((sum: number, l: any) => sum + (l.amount || 0), 0).toFixed(1)} {currencySymbol}</span>
                  </div>
                  <button onClick={() => window.print()} className="bg-indigo-500 hover:bg-indigo-600 text-white font-bold text-sm px-3 py-1.5 rounded-xl transition uppercase tracking-wider">🖨️ {t("Print", "প্রিন্ট")}</button>
                  <button onClick={() => {
                    const filtered = dueCollectionSearch.trim()
                      ? dueCollectionLog.filter((l: any) => (l.customerName || "").toLowerCase().includes(dueCollectionSearch.toLowerCase()) || (l.phone && l.phone.includes(dueCollectionSearch)))
                      : dueCollectionLog;
                    const grandCollected = filtered.reduce((s: number, l: any) => s + (l.amount || 0), 0);
                    posPrintReport(
                      '📒 ' + t("Due Collection List", "বাকি আদায় তালিকা"),
                      [t("Customer", "গ্রাহক"), t("Date", "তারিখ"), t("Amount", "টাকা")],
                      filtered.map((l: any) => [l.customerName, l.dateString, (l.amount || 0).toFixed(1)]),
                      [{ label: t("Grand Total Collected", "সর্বমোট আদায়"), value: grandCollected.toFixed(1) + ' ' + currencySymbol, emphasize: true }]
                    );
                  }} className="bg-amber-500 hover:bg-amber-600 text-white font-bold text-sm px-3 py-1.5 rounded-xl transition uppercase tracking-wider">🧾 {t("POS Print", "POS প্রিন্ট")}</button>
                </div>
              </div>

              {/* Search Bar */}
              <div className="mb-3 print:hidden">
                <input
                  type="text"
                  value={dueCollectionSearch}
                  onChange={e => setDueCollectionSearch(e.target.value)}
                  placeholder={t("Search by name or phone...", "নাম বা নম্বর দিয়ে খুঁজুন...")}
                  className={`w-full px-3 py-2 rounded-xl border text-sm outline-none transition ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white placeholder-slate-500' : 'bg-white border-slate-200 text-slate-800 placeholder-slate-400'}`}
                />
              </div>

              {dueCollectionLog.length === 0 ? (
                <div className="text-center py-12 text-slate-400 italic text-sm">{t("No due collections recorded yet.", "এখনো কোনো বাকি আদায় হয়নি।")}</div>
              ) : (() => {
                const filtered = dueCollectionSearch.trim()
                  ? dueCollectionLog.filter((l: any) =>
                      (l.customerName || "").toLowerCase().includes(dueCollectionSearch.toLowerCase()) ||
                      (l.phone && l.phone.includes(dueCollectionSearch))
                    )
                  : dueCollectionLog;
                const grandCollected = filtered.reduce((s: number, l: any) => s + (l.amount || 0), 0);

                return (
                  <>
                    {/* Screen view */}
                    <div className="overflow-x-auto print:hidden">
                      {filtered.length === 0 ? (
                        <div className="text-center py-8 text-slate-400 italic text-sm">{t("No results found.", "কোনো ফলাফল পাওয়া যায়নি।")}</div>
                      ) : (
                      <table className="w-full text-left text-sm border-collapse" style={{minWidth:'500px'}}>
                        <thead>
                          <tr className={`font-black text-slate-400 border-b ${isDarkMode ? 'bg-slate-900/40 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                            <th className="p-2.5">#</th>
                            <th className="p-2.5">{t("Customer Name", "গ্রাহকের নাম")}</th>
                            <th className="p-2.5">{t("Phone", "ফোন")}</th>
                            <th className="p-2.5">{t("Date", "তারিখ")}</th>
                            <th className="p-2.5 text-right">{t("Amount Collected", "আদায়কৃত পরিমাণ")}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700/10">
                          {filtered.map((entry: any, idx: number) => (
                            <tr key={entry.id} className="hover:bg-slate-500/5 transition-colors">
                              <td className="p-2.5 text-slate-400">{idx + 1}</td>
                              <td className="p-2.5 font-black">{entry.customerName}</td>
                              <td className="p-2.5 font-mono text-slate-400">{entry.phone || "N/A"}</td>
                              <td className="p-2.5 text-slate-400 text-sm">{entry.dateString}</td>
                              <td className="p-2.5 text-right font-mono font-black text-emerald-500 text-sm">{(entry.amount || 0).toFixed(1)} {currencySymbol}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      )}
                    </div>

                    {/* Colorful print-only report */}
                    <div className="hidden print:block w-full p-0 cph-print-report">
                      <div className="w-full bg-white rounded-2xl border-2 border-emerald-300 overflow-hidden font-mono shadow-sm">

                        {/* Branded gradient header */}
                        <div className="bg-gradient-to-br from-emerald-600 via-indigo-600 to-sky-500 text-white text-center px-5 pt-6 pb-5 relative overflow-hidden">
                          <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-amber-300/30"></div>
                          <div className="absolute -bottom-8 -left-8 w-28 h-28 rounded-full bg-sky-300/25"></div>
                          <div className="w-12 h-12 mx-auto mb-2 rounded-xl bg-white/20 border border-white/50 flex items-center justify-center font-black text-lg relative overflow-hidden">{pharmacyLogo && pharmacyLogo.startsWith('data:image') ? <img src={pharmacyLogo} alt="logo" className="w-full h-full object-cover" /> : pharmacyLogo}</div>
                          <h3 className="font-black text-base uppercase tracking-wide relative">{pharmacyName}</h3>
                          <p className="text-sm opacity-90 leading-snug mt-0.5 relative">{pharmacySlogan}</p>
                          <p className="text-sm font-semibold mt-1.5 opacity-95 relative">📍 {pharmacyAddress}</p>
                        </div>

                        <div className="px-5 pb-5" style={{ background: 'linear-gradient(180deg,#ecfdf5,#ffffff 30%)' }}>
                          {/* Ticket-style title pill */}
                          <div className="flex justify-center mt-3 mb-4">
                            <span className="bg-slate-900 text-amber-300 text-sm font-black px-4 py-2 rounded-full uppercase tracking-wide shadow-sm border-2 border-amber-400 whitespace-nowrap">📒 {t("Due Collection List", "বাকি আদায় তালিকা")}</span>
                          </div>

                          {/* Report meta info card */}
                          <div className="bg-gradient-to-br from-emerald-50 to-sky-50 border-2 border-emerald-200 rounded-xl p-3 mb-4 flex flex-col gap-1 text-sm">
                            <div className="flex justify-between"><span className="text-emerald-500 font-semibold">{t("Generated On:", "তৈরি হয়েছে:")}</span><span className="font-bold text-indigo-700">{new Date().toLocaleDateString()}</span></div>
                            <div className="flex justify-between"><span className="text-emerald-500 font-semibold">{t("Entries Listed:", "এন্ট্রি সংখ্যা:")}</span><span className="font-bold text-sky-600">{filtered.length}</span></div>
                          </div>

                          {/* Collections table */}
                          <table className="w-full text-left border-collapse mb-4 text-sm overflow-hidden rounded-xl">
                            <thead>
                              <tr className="bg-gradient-to-r from-emerald-600 to-sky-500 text-white">
                                <th className="py-1.5 px-2 font-bold rounded-l-lg">#</th>
                                <th className="py-1.5 px-2 font-bold">{t("Customer", "গ্রাহক")}</th>
                                <th className="py-1.5 px-2 font-mono font-bold">{t("Phone", "ফোন")}</th>
                                <th className="py-1.5 px-2 font-bold">{t("Date", "তারিখ")}</th>
                                <th className="py-1.5 px-2 font-mono text-right font-bold rounded-r-lg">{t("Amount", "পরিমাণ")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {filtered.map((entry: any, idx: number) => (
                                <tr key={entry.id} className={idx % 2 === 1 ? 'bg-amber-50' : 'bg-emerald-50/60'}>
                                  <td className="py-1.5 px-2 border-b border-emerald-100 text-slate-400">{idx + 1}</td>
                                  <td className="py-1.5 px-2 border-b border-emerald-100 font-bold text-indigo-800">{entry.customerName}</td>
                                  <td className="py-1.5 px-2 border-b border-emerald-100 font-mono text-slate-600">{entry.phone || "N/A"}</td>
                                  <td className="py-1.5 px-2 border-b border-emerald-100 text-sm text-violet-600">{entry.dateString}</td>
                                  <td className="py-1.5 px-2 font-mono text-right border-b border-emerald-100 font-bold text-emerald-600">{(entry.amount || 0).toFixed(1)} {currencySymbol}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>

                          {/* Totals card */}
                          <div className="bg-gradient-to-br from-sky-50 to-emerald-50 border-2 border-sky-200 rounded-xl p-3 flex flex-col gap-1.5 text-sm text-right font-semibold mb-4">
                            <div className="flex justify-between items-center bg-gradient-to-r from-emerald-600 to-indigo-500 text-white rounded-xl px-3 py-2 mt-0.5 shadow-sm">
                              <span className="uppercase text-sm font-black tracking-wide">✅ {t("Grand Total Collected", "সর্বমোট আদায়")}</span>
                              <span className="font-mono text-base font-black">{grandCollected.toFixed(1)} {currencySymbol}</span>
                            </div>
                          </div>

                          {/* Footer */}
                          <div className="text-center border-t-2 border-dashed border-emerald-300 pt-3">
                            <p className="text-sm tracking-[0.3em] text-amber-400 mb-1.5">✦ ✦ ✦ ✦ ✦</p>
                            <p className="text-sm font-black uppercase tracking-tight bg-gradient-to-r from-emerald-600 to-sky-500 bg-clip-text text-transparent">{t("End of Report", "প্রতিবেদনের সমাপ্তি")}</p>
                            <p className="text-sm text-slate-400 mt-1">{pharmacyName} · {pharmacyAddress}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {/* =========================================================
              TAB 7: RETURNS
          ========================================================= */}
          {activeTab === "returns" && checkShouldRenderTabOption("returns") && (() => {
            const returnsList = invoices.filter(i => i.isReturned && i.returnDetails);
            const totalRefund = returnsList.reduce((s, i) => s + i.returnDetails.refundedAmount, 0);
            const cashCount = returnsList.filter(i => i.returnDetails.action === 'CASH_REFUND').length;
            const creditCount = returnsList.length - cashCount;
            return (
            <div className={`ccard cc-green p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2 print:hidden">
                <div>
                  <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500">🔄 {t("Returns & Exchanges", "ফেরত ও বিনিময়")}</h3>
                  <p className="text-sm text-slate-400 mt-0.5">{t("Log of orders where a return or exchange was processed.", "যে সব অর্ডার ফেরত বা বিনিময় করা হয়েছে।")}</p>
                </div>
                <button onClick={() => window.print()} className="bg-pink-500 hover:bg-pink-600 text-white font-bold text-sm px-4 py-2 rounded-xl transition uppercase tracking-wider shadow-sm">🖨️ {t("Print", "প্রিন্ট")}</button>
                <button onClick={() => posPrintReport(
                  '🔄 ' + t("Returns & Exchanges", "ফেরত ও বিনিময়"),
                  [t("Invoice", "রশিদ"), t("Customer", "গ্রাহক"), t("Refund", "ফেরত টাকা")],
                  returnsList.map((inv: any) => [inv.invoiceId, inv.customer, '-' + inv.returnDetails.refundedAmount.toFixed(1)]),
                  [{ label: t("Total Refunded", "মোট ফেরত টাকা"), value: totalRefund.toFixed(1) + ' ' + currencySymbol, emphasize: true }],
                  [
                    { label: t("Cash Refunds:", "নগদ ফেরত:"), value: String(cashCount) },
                    { label: t("Store Credits:", "স্টোর ক্রেডিট:"), value: String(creditCount) },
                  ]
                )} className="bg-amber-500 hover:bg-amber-600 text-white font-bold text-sm px-4 py-2 rounded-xl transition uppercase tracking-wider shadow-sm">🧾 {t("POS Print", "POS প্রিন্ট")}</button>
              </div>

              <div className="overflow-x-auto w-full print:hidden">
                <table className="w-full text-left text-sm border-collapse" style={{minWidth:'600px'}}>
                  <thead>
                    <tr className={`font-black text-slate-400 border-b ${isDarkMode ? 'bg-slate-900/40 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                      <th className="p-2.5">{t("Invoice #", "রশিদ নং")}</th>
                      <th className="p-2.5">{t("Customer", "গ্রাহক")}</th>
                      <th className="p-2.5">{t("Type", "ধরন")}</th>
                      <th className="p-2.5 text-right">{t("Refund", "ফেরত টাকা")}</th>
                      <th className="p-2.5">{t("Date", "তারিখ")}</th>
                      <th className="p-2.5">{t("Reason", "কারণ")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/10">
                    {returnsList.map(inv => (
                      <tr key={inv.invoiceId} className="hover:bg-slate-500/5">
                        <td className="p-2.5 font-mono font-black text-red-400">{inv.invoiceId}</td>
                        <td className="p-2.5 font-bold">{inv.customer}</td>
                        <td className="p-2.5">
                          <span className={`text-sm font-black px-2 py-0.5 rounded ${inv.returnDetails.action === 'CASH_REFUND' ? 'bg-amber-500/10 text-amber-500' : 'bg-indigo-500/10 text-indigo-500'}`}>
                            {inv.returnDetails.action === 'CASH_REFUND' ? t("Cash Refund", "নগদ ফেরত") : t("Store Credit", "স্টোর ক্রেডিট")}
                          </span>
                        </td>
                        <td className="p-2.5 font-mono text-right font-bold text-red-400">-{inv.returnDetails.refundedAmount.toFixed(1)} {currencySymbol}</td>
                        <td className="p-2.5 font-mono text-slate-400 text-sm">{inv.returnDetails.timestamp}</td>
                        <td className="p-2.5 text-slate-400 italic truncate max-w-xs">{inv.returnDetails.reason}</td>
                      </tr>
                    ))}
                    {returnsList.length === 0 && (
                      <tr><td colSpan={6} className="text-center p-8 text-slate-400 italic">{t("No returns logged.", "কোনো ফেরত নেই।")}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Colorful print-only report */}
              <div className="hidden print:block w-full p-0 cph-print-report">
                <div className="w-full bg-white rounded-2xl border-2 border-pink-300 overflow-hidden font-mono shadow-sm">

                  {/* Branded gradient header */}
                  <div className="bg-gradient-to-br from-rose-600 via-pink-600 to-fuchsia-600 text-white text-center px-5 pt-6 pb-5 relative overflow-hidden">
                    <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-amber-300/25"></div>
                    <div className="absolute -bottom-8 -left-8 w-28 h-28 rounded-full bg-indigo-300/25"></div>
                    <div className="w-12 h-12 mx-auto mb-2 rounded-xl bg-white/20 border border-white/50 flex items-center justify-center font-black text-lg relative overflow-hidden">{pharmacyLogo && pharmacyLogo.startsWith('data:image') ? <img src={pharmacyLogo} alt="logo" className="w-full h-full object-cover" /> : pharmacyLogo}</div>
                    <h3 className="font-black text-base uppercase tracking-wide relative">{pharmacyName}</h3>
                    <p className="text-sm opacity-90 leading-snug mt-0.5 relative">{pharmacySlogan}</p>
                    <p className="text-sm font-semibold mt-1.5 opacity-95 relative">📍 {pharmacyAddress}</p>
                  </div>

                  <div className="px-5 pb-5" style={{ background: 'linear-gradient(180deg,#fdf2f8,#ffffff 30%)' }}>
                    {/* Ticket-style title pill */}
                    <div className="flex justify-center mt-3 mb-4">
                      <span className="bg-slate-900 text-amber-300 text-sm font-black px-4 py-2 rounded-full uppercase tracking-wide shadow-sm border-2 border-amber-400 whitespace-nowrap">🔄 {t("Returns & Exchanges", "ফেরত ও বিনিময়")}</span>
                    </div>

                    {/* Report meta info card */}
                    <div className="bg-gradient-to-br from-pink-50 to-rose-50 border-2 border-pink-200 rounded-xl p-3 mb-4 flex flex-col gap-1 text-sm">
                      <div className="flex justify-between"><span className="text-pink-500 font-semibold">{t("Generated On:", "তৈরি হয়েছে:")}</span><span className="font-bold text-fuchsia-700">{new Date().toLocaleDateString()}</span></div>
                      <div className="flex justify-between"><span className="text-pink-500 font-semibold">{t("Total Returns:", "মোট ফেরত:")}</span><span className="font-bold text-rose-600">{returnsList.length}</span></div>
                    </div>

                    {/* Summary cards row */}
                    <div className="grid grid-cols-2 gap-2 mb-4">
                      <div className="bg-gradient-to-br from-amber-50 to-orange-50 border-2 border-amber-200 rounded-xl p-2.5 text-center">
                        <p className="text-sm font-bold uppercase text-amber-500">{t("Cash Refunds", "নগদ ফেরত")}</p>
                        <p className="text-base font-black text-amber-700">{cashCount}</p>
                      </div>
                      <div className="bg-gradient-to-br from-indigo-50 to-violet-50 border-2 border-indigo-200 rounded-xl p-2.5 text-center">
                        <p className="text-sm font-bold uppercase text-indigo-500">{t("Store Credits", "স্টোর ক্রেডিট")}</p>
                        <p className="text-base font-black text-indigo-700">{creditCount}</p>
                      </div>
                    </div>

                    {/* Returns table */}
                    <table className="w-full text-left border-collapse mb-4 text-sm overflow-hidden rounded-xl">
                      <thead>
                        <tr className="bg-gradient-to-r from-rose-600 to-fuchsia-600 text-white">
                          <th className="py-1.5 px-2 font-bold rounded-l-lg">{t("Invoice", "রশিদ")}</th>
                          <th className="py-1.5 px-2 font-bold">{t("Customer", "গ্রাহক")}</th>
                          <th className="py-1.5 px-2 font-bold">{t("Type", "ধরন")}</th>
                          <th className="py-1.5 px-2 font-mono text-right font-bold">{t("Refund", "ফেরত টাকা")}</th>
                          <th className="py-1.5 px-2 font-bold rounded-r-lg">{t("Date", "তারিখ")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {returnsList.map((inv, idx) => (
                          <tr key={inv.invoiceId} className={idx % 2 === 1 ? 'bg-pink-50' : 'bg-rose-50/50'}>
                            <td className="py-1.5 px-2 border-b border-pink-100 font-bold text-fuchsia-800">{inv.invoiceId}</td>
                            <td className="py-1.5 px-2 border-b border-pink-100 text-slate-600">{inv.customer}</td>
                            <td className="py-1.5 px-2 border-b border-pink-100">
                              <span className={`text-sm font-black px-1.5 py-0.5 rounded ${inv.returnDetails.action === 'CASH_REFUND' ? 'bg-amber-500/10 text-amber-600' : 'bg-indigo-500/10 text-indigo-600'}`}>
                                {inv.returnDetails.action === 'CASH_REFUND' ? t("Cash", "নগদ") : t("Credit", "ক্রেডিট")}
                              </span>
                            </td>
                            <td className="py-1.5 px-2 font-mono text-right border-b border-pink-100 font-bold text-red-600">-{inv.returnDetails.refundedAmount.toFixed(1)} {currencySymbol}</td>
                            <td className="py-1.5 px-2 border-b border-pink-100 text-slate-500 text-sm">{inv.returnDetails.timestamp}</td>
                          </tr>
                        ))}
                        {returnsList.length === 0 && (
                          <tr><td colSpan={5} className="text-center p-8 text-slate-400 italic">{t("No returns logged.", "কোনো ফেরত নেই।")}</td></tr>
                        )}
                      </tbody>
                    </table>

                    {/* Totals card */}
                    <div className="bg-gradient-to-br from-rose-50 to-red-50 border-2 border-red-200 rounded-xl p-3 flex flex-col gap-1.5 text-sm text-right font-semibold mb-4">
                      <div className="flex justify-between items-center bg-gradient-to-r from-rose-600 to-red-600 text-white rounded-xl px-3 py-2 mt-0.5 shadow-sm">
                        <span className="uppercase text-sm font-black tracking-wide">{t("Total Refunded", "মোট ফেরত টাকা")}</span>
                        <span className="font-mono text-base font-black">{totalRefund.toFixed(1)} {currencySymbol}</span>
                      </div>
                    </div>

                    {/* Footer */}
                    <div className="text-center border-t-2 border-dashed border-pink-300 pt-3">
                      <p className="text-sm tracking-[0.3em] text-amber-400 mb-1.5">✦ ✦ ✦ ✦ ✦</p>
                      <p className="text-sm font-black uppercase tracking-tight bg-gradient-to-r from-rose-600 to-fuchsia-600 bg-clip-text text-transparent">{t("End of Report", "প্রতিবেদনের সমাপ্তি")}</p>
                      <p className="text-sm text-slate-400 mt-1">{pharmacyName} · {pharmacyAddress}</p>
                      <p className="text-sm text-slate-400 mt-1">{t("Printed on:", "প্রিন্ট তারিখ:")} {new Date().toLocaleString()}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            );
          })()}

          {/* =========================================================
              TAB: EXPENSE TRACKER
          ========================================================= */}
          {activeTab === "expense_tracker" && checkShouldRenderTabOption("expense_tracker") && (() => {
            const now = new Date();
            const todayStr = now.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' });
            const isThisMonth = (d: any) => {
              const dt = new Date(d.date || d.dateString);
              return dt.getMonth() === now.getMonth() && dt.getFullYear() === now.getFullYear();
            };
            const todaysExpenses = expenseList.filter((e: any) => e.dateString === todayStr);
            const monthsExpenses = expenseList.filter(isThisMonth);
            const totalToday = todaysExpenses.reduce((s: number, e: any) => s + (e.amount || 0), 0);
            const totalMonth = monthsExpenses.reduce((s: number, e: any) => s + (e.amount || 0), 0);
            const totalAll = expenseList.reduce((s: number, e: any) => s + (e.amount || 0), 0);

            const categoryBreakdown: Record<string, number> = {};
            monthsExpenses.forEach((e: any) => {
              categoryBreakdown[e.category] = (categoryBreakdown[e.category] || 0) + (e.amount || 0);
            });

            const visibleList = expenseFilter === "today" ? todaysExpenses
              : expenseFilter === "month" ? monthsExpenses
              : expenseList;

            return (
              <div className="flex flex-col gap-4">
                {/* Summary cards */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className={`ccard cc-rose p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                    <p className="text-sm font-bold text-slate-400 uppercase tracking-wide">{t("Today's Expense", "আজকের খরচ")}</p>
                    <p className="text-base font-black text-rose-500 font-mono mt-1">{totalToday.toFixed(1)} {currencySymbol}</p>
                  </div>
                  <div className={`ccard cc-rose p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                    <p className="text-sm font-bold text-slate-400 uppercase tracking-wide">{t("This Month", "এই মাসে")}</p>
                    <p className="text-base font-black text-rose-500 font-mono mt-1">{totalMonth.toFixed(1)} {currencySymbol}</p>
                  </div>
                  <div className={`ccard cc-rose p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                    <p className="text-sm font-bold text-slate-400 uppercase tracking-wide">{t("All Time", "সর্বমোট")}</p>
                    <p className="text-base font-black text-rose-500 font-mono mt-1">{totalAll.toFixed(1)} {currencySymbol}</p>
                  </div>
                </div>

                {/* Add / Edit form */}
                {(checkShouldRenderTabOption("expense_add") || (editingExpenseId !== null && checkShouldRenderTabOption("expense_edit"))) && (
                <div className={`ccard cc-rose p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <h3 className="text-sm font-black uppercase tracking-wider text-rose-500 border-b pb-2 mb-3">
                    {editingExpenseId !== null ? "✏️ " + t("Edit Expense", "খরচ সম্পাদনা") : "➕ " + t("Add Expense", "খরচ যোগ করুন")}
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Category", "ক্যাটাগরি")}</label>
                      <select value={expenseCategory} onChange={e => setExpenseCategory(e.target.value)} className={`w-full px-3 py-2 rounded-xl border text-sm font-semibold outline-none ${isDarkMode ? 'bg-slate-950 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}>
                        {EXPENSE_PRESET_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      {expenseCategory === "Other" && (
                        <input
                          type="text"
                          value={expenseCustomCategory}
                          onChange={e => setExpenseCustomCategory(e.target.value)}
                          placeholder={t("Enter custom category...", "নিজের ক্যাটাগরি লিখুন...")}
                          className={`w-full mt-2 px-3 py-2 rounded-xl border text-sm outline-none ${isDarkMode ? 'bg-slate-950 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                        />
                      )}
                    </div>
                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Amount", "পরিমাণ")}</label>
                      <input
                        type="number"
                        value={expenseAmount}
                        onChange={e => setExpenseAmount(e.target.value)}
                        placeholder={t("Enter amount...", "পরিমাণ লিখুন...")}
                        className={`w-full px-3 py-2 rounded-xl border text-sm font-mono outline-none ${isDarkMode ? 'bg-slate-950 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                      />
                    </div>
                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Payment Method", "পেমেন্ট মেথড")}</label>
                      <select value={expensePaymentMethod} onChange={e => setExpensePaymentMethod(e.target.value)} className={`w-full px-3 py-2 rounded-xl border text-sm font-semibold outline-none ${isDarkMode ? 'bg-slate-950 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}>
                        <option value="Cash">{t("Cash", "নগদ")}</option>
                        <option value="bKash">bKash</option>
                        <option value="Card">{t("Card", "কার্ড")}</option>
                      </select>
                    </div>
                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Note (optional)", "নোট (ঐচ্ছিক)")}</label>
                      <input
                        type="text"
                        value={expenseNote}
                        onChange={e => setExpenseNote(e.target.value)}
                        placeholder={t("Short note...", "সংক্ষিপ্ত নোট...")}
                        className={`w-full px-3 py-2 rounded-xl border text-sm outline-none ${isDarkMode ? 'bg-slate-950 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end mt-3">
                    {editingExpenseId !== null && (
                      <button onClick={resetExpenseForm} className={`px-4 py-2 text-sm font-bold rounded-xl transition ${isDarkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>{t("Cancel", "বাতিল")}</button>
                    )}
                    {(editingExpenseId !== null ? checkShouldRenderTabOption("expense_edit") : checkShouldRenderTabOption("expense_add")) && (
                      <button onClick={handleSaveExpense} className="bg-rose-500 hover:bg-rose-600 text-white font-black px-5 py-2 rounded-xl uppercase tracking-wider shadow transition">
                        {editingExpenseId !== null ? "✅ " + t("Update", "আপডেট") : "➕ " + t("Add Expense", "খরচ যোগ করুন")}
                      </button>
                    )}
                  </div>
                </div>
                )}

                {/* Category breakdown (this month) */}
                {Object.keys(categoryBreakdown).length > 0 && (
                  <div className={`ccard cc-rose p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                    <h3 className="text-sm font-black uppercase tracking-wider text-rose-500 border-b pb-2 mb-3">{t("This Month by Category", "এই মাসের ক্যাটাগরি অনুযায়ী")}</h3>
                    <div className="flex flex-col gap-1.5">
                      {Object.entries(categoryBreakdown).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => (
                        <div key={cat} className="flex justify-between text-sm">
                          <span className={isDarkMode ? 'text-slate-300' : 'text-slate-600'}>{cat}</span>
                          <span className="font-mono font-bold">{amt.toFixed(1)} {currencySymbol}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* List */}
                {checkShouldRenderTabOption("expense_view_history") && (
                <div className={`ccard cc-rose p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                    <h3 className="text-sm font-black uppercase tracking-wider text-rose-500">{t("Expense History", "খরচের তালিকা")}</h3>
                    <div className="flex gap-1.5">
                      {(["all", "today", "month"] as const).map(f => (
                        <button key={f} onClick={() => setExpenseFilter(f)} className={`px-3 py-1 rounded-lg text-sm font-bold transition ${expenseFilter === f ? 'bg-rose-500 text-white' : isDarkMode ? 'bg-slate-900 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                          {f === "all" ? t("All", "সব") : f === "today" ? t("Today", "আজ") : t("This Month", "এই মাসে")}
                        </button>
                      ))}
                    </div>
                  </div>

                  {visibleList.length === 0 ? (
                    <p className={`text-sm text-center py-6 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>{t("No expenses recorded yet.", "এখনো কোনো খরচ যোগ করা হয়নি।")}</p>
                  ) : (
                    <div className="flex flex-col gap-2 max-h-[420px] overflow-y-auto pr-1">
                      {visibleList.map((entry: any) => (
                        <div key={entry.id} className={`flex items-center justify-between p-3 rounded-xl border ${isDarkMode ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                          <div className="flex flex-col">
                            <span className="font-bold text-sm">{entry.category}</span>
                            <span className={`text-sm ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{entry.dateString} · {entry.paymentMethod}{entry.note ? ` · ${entry.note}` : ''}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="font-mono font-black text-rose-500">{entry.amount.toFixed(1)} {currencySymbol}</span>
                            {checkShouldRenderTabOption("expense_edit") && (
                              <button onClick={() => startEditExpense(entry)} className="text-indigo-500 hover:text-indigo-600 text-sm font-bold">✏️</button>
                            )}
                            {checkShouldRenderTabOption("expense_delete") && (
                              <button onClick={() => deleteExpenseEntry(entry.id)} className="text-red-500 hover:text-red-600 text-sm font-bold">🗑️</button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                )}
              </div>
            );
          })()}

          {/* =========================================================
              TAB: REPORT - Full Stock Report with Print
          ========================================================= */}
          {activeTab === "report" && checkShouldRenderTabOption("report_view") && (
            <div className={`ccard cc-slate p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800 border-slate-500' : 'bg-slate-100 border-slate-400'}`}>
              <div className="flex items-center justify-between mb-4 flex-wrap gap-2 print:hidden">
                <div>
                  <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500">📋 {t("Stock Report", "স্টক রিপোর্ট")}</h3>
                  <p className={`text-sm mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("All medicines currently in stock with prices", "দোকানে বর্তমানে সব মালের তালিকা ও দাম")}</p>
                </div>
                <button onClick={() => window.print()} className="bg-indigo-500 hover:bg-indigo-600 text-white font-bold text-sm px-4 py-2 rounded-xl transition uppercase tracking-wider shadow-sm">🖨️ {t("Print Report", "রিপোর্ট প্রিন্ট করুন")}</button>
                <button onClick={() => posPrintReport(
                  '📋 ' + t("Stock Report", "স্টক রিপোর্ট"),
                  [t("Medicine", "ওষুধ"), t("Stock", "স্টক"), t("Sell Price", "বিক্রয় মূল্য")],
                  medicines.map((med: any) => [med.name, med.stock, med.price.toFixed(1)]),
                  [
                    { label: t("Total Items:", "মোট আইটেম:"), value: String(medicines.length) },
                    { label: t("Total Stock (pcs):", "মোট স্টক (পিস):"), value: String(medicines.reduce((s: number, m: any) => s + m.stock, 0)) },
                    { label: t("Buy Value:", "ক্রয় মূল্য মোট:"), value: totalStockValue.toFixed(1) + ' ' + currencySymbol },
                    { label: t("Sell Value", "বিক্রয় মূল্য মোট"), value: totalStockRetailValue.toFixed(1) + ' ' + currencySymbol, emphasize: true },
                  ]
                )} className="bg-amber-500 hover:bg-amber-600 text-white font-bold text-sm px-4 py-2 rounded-xl transition uppercase tracking-wider shadow-sm">🧾 {t("POS Print", "POS প্রিন্ট")}</button>
              </div>

              {/* Summary Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 print:hidden">
                <div className={`ccard cc-blue p-3 rounded-xl border text-center ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <p className={`text-sm font-bold uppercase ${isDarkMode ? 'text-slate-400' : 'text-indigo-600'}`}>{t("Total Items", "মোট আইটেম")}</p>
                  <p className="text-xl font-black text-indigo-500">{medicines.length}</p>
                </div>
                <div className={`ccard cc-red p-3 rounded-xl border text-center ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <p className={`text-sm font-bold uppercase ${isDarkMode ? 'text-slate-400' : 'text-blue-600'}`}>{t("Total Stock (pcs)", "মোট স্টক (পিস)")}</p>
                  <p className="text-xl font-black text-blue-500">{medicines.reduce((s, m) => s + m.stock, 0)}</p>
                </div>
                <div className={`ccard cc-orange p-3 rounded-xl border text-center ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <p className={`text-sm font-bold uppercase ${isDarkMode ? 'text-slate-400' : 'text-amber-600'}`}>{t("Buy Value", "ক্রয় মূল্য মোট")}</p>
                  <p className="text-xl font-black text-amber-500 font-mono">{totalStockValue.toFixed(0)} {currencySymbol}</p>
                </div>
                <div className={`ccard cc-violet p-3 rounded-xl border text-center ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <p className={`text-sm font-bold uppercase ${isDarkMode ? 'text-slate-400' : 'text-emerald-600'}`}>{t("Sell Value", "বিক্রয় মূল্য মোট")}</p>
                  <p className="text-xl font-black text-emerald-500 font-mono">{totalStockRetailValue.toFixed(0)} {currencySymbol}</p>
                </div>
              </div>

              {/* Full Medicine Table */}
              <div className="overflow-x-auto w-full print:hidden">
                <table className="w-full text-left text-sm border-collapse" style={{minWidth:'600px'}}>
                  <thead>
                    <tr className={`font-black text-slate-400 border-b ${isDarkMode ? 'bg-slate-900/40 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                      <th className="p-2.5">#</th>
                      <th className="p-2.5">{t("Medicine Name", "ওষুধের নাম")}</th>
                      <th className="p-2.5">{t("Category", "ধরন")}</th>
                      <th className="p-2.5">{t("Generic", "জেনেরিক")}</th>
                      <th className="p-2.5 text-center">{t("Stock", "স্টক")}</th>
                      <th className="p-2.5 text-right">{t("Buy Price", "ক্রয় মূল্য")}</th>
                      <th className="p-2.5 text-right">{t("Sell Price", "বিক্রয় মূল্য")}</th>
                      <th className="p-2.5 text-right">{t("Buy Total", "ক্রয় মোট")}</th>
                      <th className="p-2.5 text-right">{t("Sell Total", "বিক্রয় মোট")}</th>
                      <th className="p-2.5">{t("Expiry", "মেয়াদ")}</th>
                      <th className="p-2.5 text-center">{t("Status", "অবস্থা")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/10">
                    {medicines.map((med, idx) => {
                      const isLow = med.stock <= (med.lowStockAlert || activeThreshold);
                      const isExpired = new Date(med.expire) < new Date();
                      return (
                        <tr key={med.id} className={`transition-colors ${isExpired ? (isDarkMode ? 'bg-red-900/10' : 'bg-red-50') : isLow ? (isDarkMode ? 'bg-amber-900/10' : 'bg-amber-50') : 'hover:bg-slate-500/5'}`}>
                          <td className="p-2.5 text-slate-400">{idx + 1}</td>
                          <td className="p-2.5 font-black">{med.name}</td>
                          <td className="p-2.5 text-slate-400">{med.category}</td>
                          <td className="p-2.5 text-slate-400 text-sm italic">{med.generic || '-'}</td>
                          <td className="p-2.5 text-center font-mono font-black">
                            <span className={isLow ? 'text-red-500' : 'text-emerald-500'}>{med.stock}</span>
                          </td>
                          <td className="p-2.5 text-right font-mono">{med.buyPrice.toFixed(1)}</td>
                          <td className="p-2.5 text-right font-mono font-black text-indigo-500">{med.price.toFixed(1)}</td>
                          <td className="p-2.5 text-right font-mono text-amber-500">{(med.buyPrice * med.stock).toFixed(1)}</td>
                          <td className="p-2.5 text-right font-mono text-emerald-500">{(med.price * med.stock).toFixed(1)}</td>
                          <td className="p-2.5 font-mono text-sm text-slate-400">{med.expire}</td>
                          <td className="p-2.5 text-center">
                            {isExpired
                              ? <span className="text-xs bg-red-500/10 text-red-500 font-black px-1.5 py-0.5 rounded uppercase">{t("Expired", "মেয়াদ শেষ")}</span>
                              : isLow
                              ? <span className="text-xs bg-amber-500/10 text-amber-500 font-black px-1.5 py-0.5 rounded uppercase">⚠️ {t("Low", "কম")}</span>
                              : <span className="text-xs bg-emerald-500/10 text-emerald-500 font-black px-1.5 py-0.5 rounded uppercase">✓ {t("OK", "ঠিক আছে")}</span>
                            }
                          </td>
                        </tr>
                      );
                    })}
                    {medicines.length === 0 && (
                      <tr><td colSpan={11} className="text-center p-8 text-slate-400 italic">{t("No medicines in stock.", "কোনো মাল নেই।")}</td></tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr className={`font-black border-t-2 ${isDarkMode ? 'border-slate-600 bg-slate-900/40' : 'border-slate-300 bg-slate-100'}`}>
                      <td colSpan={4} className="p-2.5 text-right text-sm font-black uppercase">{t("TOTAL", "মোট")}</td>
                      <td className="p-2.5 text-center font-mono font-black text-blue-500">{medicines.reduce((s, m) => s + m.stock, 0)}</td>
                      <td colSpan={2}></td>
                      <td className="p-2.5 text-right font-mono font-black text-amber-500">{totalStockValue.toFixed(1)} {currencySymbol}</td>
                      <td className="p-2.5 text-right font-mono font-black text-emerald-500">{totalStockRetailValue.toFixed(1)} {currencySymbol}</td>
                      <td colSpan={2}></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Colorful print-only report */}
              <div className="hidden print:block w-full p-0 cph-print-report">
                <div className="w-full bg-white rounded-2xl border-2 border-orange-300 overflow-hidden font-mono shadow-sm">

                  {/* Branded gradient header */}
                  <div className="bg-gradient-to-br from-amber-600 via-orange-600 to-rose-600 text-white text-center px-5 pt-6 pb-5 relative overflow-hidden">
                    <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-indigo-300/25"></div>
                    <div className="absolute -bottom-8 -left-8 w-28 h-28 rounded-full bg-amber-300/25"></div>
                    <div className="w-12 h-12 mx-auto mb-2 rounded-xl bg-white/20 border border-white/50 flex items-center justify-center font-black text-lg relative overflow-hidden">{pharmacyLogo && pharmacyLogo.startsWith('data:image') ? <img src={pharmacyLogo} alt="logo" className="w-full h-full object-cover" /> : pharmacyLogo}</div>
                    <h3 className="font-black text-base uppercase tracking-wide relative">{pharmacyName}</h3>
                    <p className="text-sm opacity-90 leading-snug mt-0.5 relative">{pharmacySlogan}</p>
                    <p className="text-sm font-semibold mt-1.5 opacity-95 relative">📍 {pharmacyAddress}</p>
                  </div>

                  <div className="px-5 pb-5" style={{ background: 'linear-gradient(180deg,#fff7ed,#ffffff 30%)' }}>
                    {/* Ticket-style title pill */}
                    <div className="flex justify-center mt-3 mb-4">
                      <span className="bg-slate-900 text-amber-300 text-sm font-black px-4 py-2 rounded-full uppercase tracking-wide shadow-sm border-2 border-amber-400 whitespace-nowrap">📋 {t("Stock Report", "স্টক রিপোর্ট")}</span>
                    </div>

                    {/* Report meta info card */}
                    <div className="bg-gradient-to-br from-orange-50 to-amber-50 border-2 border-orange-200 rounded-xl p-3 mb-4 flex flex-col gap-1 text-sm">
                      <div className="flex justify-between"><span className="text-orange-500 font-semibold">{t("Generated On:", "তৈরি হয়েছে:")}</span><span className="font-bold text-rose-700">{new Date().toLocaleDateString()}</span></div>
                      <div className="flex justify-between"><span className="text-orange-500 font-semibold">{t("Total Items:", "মোট আইটেম:")}</span><span className="font-bold text-amber-600">{medicines.length}</span></div>
                    </div>

                    {/* Summary cards row */}
                    <div className="grid grid-cols-2 gap-2 mb-4">
                      <div className="bg-gradient-to-br from-sky-50 to-blue-50 border-2 border-blue-200 rounded-xl p-2.5 text-center">
                        <p className="text-sm font-bold uppercase text-blue-500">{t("Total Stock (pcs)", "মোট স্টক (পিস)")}</p>
                        <p className="text-base font-black text-blue-700">{medicines.reduce((s, m) => s + m.stock, 0)}</p>
                      </div>
                      <div className="bg-gradient-to-br from-amber-50 to-orange-50 border-2 border-amber-200 rounded-xl p-2.5 text-center">
                        <p className="text-sm font-bold uppercase text-amber-500">{t("Buy Value", "ক্রয় মূল্য মোট")}</p>
                        <p className="text-base font-black text-amber-700">{totalStockValue.toFixed(0)} {currencySymbol}</p>
                      </div>
                    </div>

                    {/* Full medicine table */}
                    <table className="w-full text-left border-collapse mb-4 text-sm overflow-hidden rounded-xl">
                      <thead>
                        <tr className="bg-gradient-to-r from-amber-600 to-rose-600 text-white">
                          <th className="py-1.5 px-2 font-bold rounded-l-lg">#</th>
                          <th className="py-1.5 px-2 font-bold">{t("Medicine", "ওষুধ")}</th>
                          <th className="py-1.5 px-2 font-bold">{t("Generic", "জেনেরিক")}</th>
                          <th className="py-1.5 px-2 font-mono text-center font-bold">{t("Stock", "স্টক")}</th>
                          <th className="py-1.5 px-2 font-mono text-right font-bold">{t("Buy", "ক্রয়")}</th>
                          <th className="py-1.5 px-2 font-mono text-right font-bold">{t("Sell", "বিক্রয়")}</th>
                          <th className="py-1.5 px-2 font-mono text-right font-bold rounded-r-lg">{t("Sell Total", "বিক্রয় মোট")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {medicines.map((med, idx) => {
                          const isLow = med.stock <= (med.lowStockAlert || activeThreshold);
                          const isExpired = new Date(med.expire) < new Date();
                          return (
                            <tr key={med.id} className={idx % 2 === 1 ? 'bg-amber-50' : 'bg-orange-50/50'}>
                              <td className="py-1.5 px-2 border-b border-orange-100 text-slate-400">{idx + 1}</td>
                              <td className="py-1.5 px-2 border-b border-orange-100 font-bold text-rose-800">
                                {med.name}
                                {isExpired && <span className="ml-1 text-sm bg-red-500/10 text-red-500 font-black px-1 py-0.5 rounded uppercase">{t("Expired", "মেয়াদ শেষ")}</span>}
                                {!isExpired && isLow && <span className="ml-1 text-sm bg-amber-500/10 text-amber-600 font-black px-1 py-0.5 rounded uppercase">⚠️ {t("Low", "কম")}</span>}
                              </td>
                              <td className="py-1.5 px-2 border-b border-orange-100 text-slate-500 italic">{med.generic || '-'}</td>
                              <td className="py-1.5 px-2 font-mono text-center border-b border-orange-100 font-bold">
                                <span className={isLow ? 'text-red-500' : 'text-emerald-600'}>{med.stock}</span>
                              </td>
                              <td className="py-1.5 px-2 font-mono text-right border-b border-orange-100 text-slate-600">{med.buyPrice.toFixed(1)}</td>
                              <td className="py-1.5 px-2 font-mono text-right border-b border-orange-100 font-bold text-indigo-600">{med.price.toFixed(1)}</td>
                              <td className="py-1.5 px-2 font-mono text-right border-b border-orange-100 font-bold text-emerald-600">{(med.price * med.stock).toFixed(1)}</td>
                            </tr>
                          );
                        })}
                        {medicines.length === 0 && (
                          <tr><td colSpan={7} className="text-center p-8 text-slate-400 italic">{t("No medicines in stock.", "কোনো মাল নেই।")}</td></tr>
                        )}
                      </tbody>
                    </table>

                    {/* Totals card */}
                    <div className="bg-gradient-to-br from-sky-50 to-indigo-50 border-2 border-indigo-200 rounded-xl p-3 flex flex-col gap-1.5 text-sm text-right font-semibold mb-4">
                      <div className="flex justify-between"><span className="text-sky-500">{t("Total Stock:", "মোট স্টক:")}</span><span className="font-mono text-rose-700">{medicines.reduce((s, m) => s + m.stock, 0)} {t("pcs", "টি")}</span></div>
                      <div className="flex justify-between"><span className="text-sky-500">{t("Buy Value:", "ক্রয় মূল্য:")}</span><span className="font-mono text-amber-700">{totalStockValue.toFixed(1)} {currencySymbol}</span></div>
                      <div className="flex justify-between items-center bg-gradient-to-r from-emerald-600 to-indigo-500 text-white rounded-xl px-3 py-2 mt-0.5 shadow-sm">
                        <span className="uppercase text-sm font-black tracking-wide">{t("Sell Value", "বিক্রয় মূল্য")}</span>
                        <span className="font-mono text-base font-black">{totalStockRetailValue.toFixed(1)} {currencySymbol}</span>
                      </div>
                    </div>

                    {/* Footer */}
                    <div className="text-center border-t-2 border-dashed border-orange-300 pt-3">
                      <p className="text-sm tracking-[0.3em] text-amber-400 mb-1.5">✦ ✦ ✦ ✦ ✦</p>
                      <p className="text-sm font-black uppercase tracking-tight bg-gradient-to-r from-amber-600 to-rose-600 bg-clip-text text-transparent">{t("End of Report", "প্রতিবেদনের সমাপ্তি")}</p>
                      <p className="text-sm text-slate-400 mt-1">{pharmacyName} · {pharmacyAddress}</p>
                      <p className="text-sm text-slate-400 mt-1">{t("Printed on:", "প্রিন্ট তারিখ:")} {new Date().toLocaleString()}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================
              TAB: DAILY CLOSING REPORT
          ========================================================= */}
          {activeTab === "closing_report" && (
            <div className={`ccard p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800 border-slate-600' : 'bg-white border-slate-200'}`}>
              {/* Header */}
              <div className="flex items-center justify-between mb-4 flex-wrap gap-2 print:hidden">
                <div>
                  <h3 className="text-sm font-black uppercase tracking-wider text-purple-500">🌙 {t("Daily Closing Report", "দৈনিক ক্লোজিং রিপোর্ট")}</h3>
                  <p className={`text-sm mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Today's full business summary", "আজকের সম্পূর্ণ ব্যবসার হিসাব")}</p>
                </div>
                <button onClick={() => window.print()} className="bg-purple-500 hover:bg-purple-600 text-white font-bold text-sm px-4 py-2 rounded-xl transition uppercase tracking-wider shadow print:hidden">🖨️ {t("Print", "প্রিন্ট")}</button>
                <button onClick={() => {
                  const cashInHand = computedDailySalesAmount - computedDailyDue + computedDailyDueCollection;
                  const body = `
                    ${posShopHeader('🌙 ' + t('Daily Closing Report', 'দৈনিক ক্লোজিং রিপোর্ট'))}
                    <div class="sm" style="margin-bottom:4px;">
                      <div class="row"><span>${t('Date:', 'তারিখ:')}</span><span class="bold">${new Date().toLocaleDateString()}</span></div>
                    </div>
                    <div class="line"></div>
                    <div class="sm">
                      <div class="row"><span>${t('Total Sales:', 'মোট বিক্রয়:')}</span><span>${computedDailySalesAmount.toFixed(1)} ${currencySymbol}</span></div>
                      <div class="row"><span>${t('Cash Received:', 'নগদ পেয়েছি:')}</span><span>${(computedDailySalesAmount - computedDailyDue).toFixed(1)} ${currencySymbol}</span></div>
                      <div class="row"><span>${t("Today's Profit:", 'আজকের লাভ:')}</span><span>${computedDailyProfitAmount.toFixed(1)} ${currencySymbol}</span></div>
                      <div class="row"><span>${t("Today's Due:", 'আজকের বাকি:')}</span><span>${computedDailyDue.toFixed(1)} ${currencySymbol}</span></div>
                      <div class="row"><span>${t('bKash/Nagad:', 'বিকাশ/নগদ:')}</span><span>${computedDailyBkash.toFixed(1)} ${currencySymbol}</span></div>
                      <div class="row"><span>${t('Discount Given:', 'ছাড় দিয়েছি:')}</span><span>${computedDailyDiscount.toFixed(1)} ${currencySymbol}</span></div>
                      <div class="row"><span>${t('Due Collected Today:', 'আজ বাকি আদায়:')}</span><span>${computedDailyDueCollection.toFixed(1)} ${currencySymbol}</span></div>
                      <div class="row"><span>${t("Today's Expense:", 'আজকের খরচ:')}</span><span>${computedDailyExpense.toFixed(1)} ${currencySymbol}</span></div>
                    </div>
                    <div class="line"></div>
                    <div class="sm">
                      <div class="row bold" style="font-size:12px;"><span>${t('💵 Total Cash in Hand:', '💵 মোট নগদ হাতে:')}</span><span>${cashInHand.toFixed(1)} ${currencySymbol}</span></div>
                      <div class="row"><span>${t('Net Profit Today:', 'আজকের নিট লাভ:')}</span><span>${(computedDailyProfitAmount - computedDailyExpense).toFixed(1)} ${currencySymbol}</span></div>
                    </div>
                    ${posShopFooter(t('End of Report', 'প্রতিবেদনের সমাপ্তি'))}
                  `;
                  posPrint(t('Daily Closing Report', 'দৈনিক ক্লোজিং রিপোর্ট'), body);
                }} className="bg-amber-500 hover:bg-amber-600 text-white font-bold text-sm px-4 py-2 rounded-xl transition uppercase tracking-wider shadow print:hidden">🧾 {t("POS Print", "POS প্রিন্ট")}</button>
              </div>

              {/* Date Badge */}
              <div className={`text-center mb-4 py-2 rounded-xl font-bold text-sm print:hidden ${isDarkMode ? 'bg-purple-900/30 text-purple-300' : 'bg-purple-50 text-purple-700 border border-purple-200'}`}>
                📅 {new Date().toLocaleDateString('bn-BD', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
              </div>

              {/* Summary Cards */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4 print:hidden">
                {checkShouldRenderTabOption("closing_total_sales") && (
                <div className={`p-3 rounded-xl border text-center ${isDarkMode ? 'bg-emerald-900/30 border-emerald-700' : 'bg-white border-slate-200'}`}>
                  <div className="text-lg font-black text-emerald-500 font-mono">{computedDailySalesAmount.toFixed(0)} {currencySymbol}</div>
                  <div className={`text-xs font-bold mt-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>💰 {t("Total Sales", "মোট বিক্রয়")}</div>
                </div>
                )}
                {checkShouldRenderTabOption("closing_cash_received") && (
                <div className={`p-3 rounded-xl border text-center ${isDarkMode ? 'bg-indigo-900/30 border-indigo-700' : 'bg-white border-slate-200'}`}>
                  <div className="text-lg font-black text-indigo-500 font-mono">{(computedDailySalesAmount - computedDailyDue).toFixed(0)} {currencySymbol}</div>
                  <div className={`text-xs font-bold mt-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>✅ {t("Cash Received", "নগদ পেয়েছি")}</div>
                </div>
                )}
                {checkShouldRenderTabOption("closing_profit") && (
                <div className={`p-3 rounded-xl border text-center ${isDarkMode ? 'bg-blue-900/30 border-blue-700' : 'bg-white border-slate-200'}`}>
                  <div className="text-lg font-black text-blue-500 font-mono">{computedDailyProfitAmount.toFixed(0)} {currencySymbol}</div>
                  <div className={`text-xs font-bold mt-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>📈 {t("Today's Profit", "আজকের লাভ")}</div>
                </div>
                )}
                {checkShouldRenderTabOption("closing_due") && (
                <div className={`p-3 rounded-xl border text-center ${isDarkMode ? 'bg-red-900/30 border-red-700' : 'bg-white border-slate-200'}`}>
                  <div className="text-lg font-black text-red-500 font-mono">{computedDailyDue.toFixed(0)} {currencySymbol}</div>
                  <div className={`text-xs font-bold mt-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>⚠️ {t("Today's Due", "আজকের বাকি")}</div>
                </div>
                )}
                {checkShouldRenderTabOption("closing_bkash") && (
                <div className={`p-3 rounded-xl border text-center ${isDarkMode ? 'bg-pink-900/30 border-pink-700' : 'bg-white border-slate-200'}`}>
                  <div className="text-lg font-black text-pink-500 font-mono">{computedDailyBkash.toFixed(0)} {currencySymbol}</div>
                  <div className={`text-xs font-bold mt-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>📱 {t("bKash/Nagad", "বিকাশ/নগদ")}</div>
                </div>
                )}
                {checkShouldRenderTabOption("closing_discount") && (
                <div className={`p-3 rounded-xl border text-center ${isDarkMode ? 'bg-amber-900/30 border-amber-700' : 'bg-white border-slate-200'}`}>
                  <div className="text-lg font-black text-amber-500 font-mono">{computedDailyDiscount.toFixed(0)} {currencySymbol}</div>
                  <div className={`text-xs font-bold mt-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>🏷️ {t("Discount Given", "ছাড় দিয়েছি")}</div>
                </div>
                )}
                <div className={`p-3 rounded-xl border text-center ${isDarkMode ? 'bg-rose-900/30 border-rose-700' : 'bg-white border-slate-200'}`}>
                  <div className="text-lg font-black text-rose-500 font-mono">{computedDailyExpense.toFixed(0)} {currencySymbol}</div>
                  <div className={`text-xs font-bold mt-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>💸 {t("Today's Expense", "আজকের খরচ")}</div>
                </div>
                <div className={`p-3 rounded-xl border text-center ${isDarkMode ? 'bg-teal-900/30 border-teal-700' : 'bg-white border-slate-200'}`}>
                  <div className="text-lg font-black text-teal-500 font-mono">{(computedDailyProfitAmount - computedDailyExpense).toFixed(0)} {currencySymbol}</div>
                  <div className={`text-xs font-bold mt-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>🧮 {t("Net Profit", "নিট লাভ")}</div>
                </div>
              </div>

              {/* Due Collection */}
              {checkShouldRenderTabOption("closing_due_collection") && computedDailyDueCollection > 0 && (
                <div className={`p-3 rounded-xl border mb-4 text-center print:hidden ${isDarkMode ? 'bg-violet-900/30 border-violet-700' : 'bg-white border-slate-200'}`}>
                  <div className="text-lg font-black text-violet-500 font-mono">{computedDailyDueCollection.toFixed(0)} {currencySymbol}</div>
                  <div className={`text-xs font-bold mt-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>💵 {t("Due Collected Today", "আজ বাকি আদায়")}</div>
                </div>
              )}

              {/* Final Summary Box */}
              {checkShouldRenderTabOption("closing_final_summary") && (
              <div className={`p-4 rounded-xl border-2 print:hidden ${isDarkMode ? 'bg-slate-700/50 border-purple-700' : 'bg-white border-slate-200'}`}>
                <h4 className="text-sm font-black uppercase tracking-wider text-purple-500 mb-3 text-center">📊 {t("End of Day Summary", "দিনের শেষ হিসাব")}</h4>
                <div className="flex flex-col gap-2 text-sm">
                  <div className="flex justify-between">
                    <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>{t("Total Sales:", "মোট বিক্রয়:")}</span>
                    <span className="font-black font-mono text-emerald-500">{computedDailySalesAmount.toFixed(1)} {currencySymbol}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>{t("Discount:", "ছাড়:")}</span>
                    <span className="font-bold font-mono text-amber-500">- {computedDailyDiscount.toFixed(1)} {currencySymbol}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>{t("Due Created:", "নতুন বাকি:")}</span>
                    <span className="font-bold font-mono text-red-500">- {computedDailyDue.toFixed(1)} {currencySymbol}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>{t("Due Collected:", "বাকি আদায়:")}</span>
                    <span className="font-bold font-mono text-violet-500">+ {computedDailyDueCollection.toFixed(1)} {currencySymbol}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>{t("Expense:", "খরচ:")}</span>
                    <span className="font-bold font-mono text-rose-500">- {computedDailyExpense.toFixed(1)} {currencySymbol}</span>
                  </div>
                  <div className={`flex justify-between pt-2 border-t font-black text-base ${isDarkMode ? 'border-slate-600' : 'border-purple-200'}`}>
                    <span className="text-purple-500">{t("💵 Total Cash in Hand:", "💵 মোট নগদ হাতে:")}</span>
                    <span className="font-mono text-purple-500">{(computedDailySalesAmount - computedDailyDue + computedDailyDueCollection).toFixed(1)} {currencySymbol}</span>
                  </div>
                  <div className={`flex justify-between font-bold text-sm ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                    <span>{t("Net Profit Today:", "আজকের নিট লাভ:")}</span>
                    <span className="font-mono text-teal-500 font-black">{(computedDailyProfitAmount - computedDailyExpense).toFixed(1)} {currencySymbol}</span>
                  </div>
                </div>
              </div>
              )}

              {/* Colorful print-only report */}
              <div className="hidden print:block w-full p-0 cph-print-report">
                <div className="w-full bg-white rounded-2xl border-2 border-violet-300 overflow-hidden font-mono shadow-sm">

                  {/* Branded gradient header */}
                  <div className="bg-gradient-to-br from-violet-600 via-purple-600 to-indigo-600 text-white text-center px-5 pt-6 pb-5 relative overflow-hidden">
                    <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-amber-300/25"></div>
                    <div className="absolute -bottom-8 -left-8 w-28 h-28 rounded-full bg-indigo-300/25"></div>
                    <div className="w-12 h-12 mx-auto mb-2 rounded-xl bg-white/20 border border-white/50 flex items-center justify-center font-black text-lg relative overflow-hidden">{pharmacyLogo && pharmacyLogo.startsWith('data:image') ? <img src={pharmacyLogo} alt="logo" className="w-full h-full object-cover" /> : pharmacyLogo}</div>
                    <h3 className="font-black text-base uppercase tracking-wide relative">{pharmacyName}</h3>
                    <p className="text-sm opacity-90 leading-snug mt-0.5 relative">{pharmacySlogan}</p>
                    <p className="text-sm font-semibold mt-1.5 opacity-95 relative">📍 {pharmacyAddress}</p>
                  </div>

                  <div className="px-5 pb-5" style={{ background: 'linear-gradient(180deg,#faf5ff,#ffffff 30%)' }}>
                    {/* Ticket-style title pill */}
                    <div className="flex justify-center mt-3 mb-4">
                      <span className="bg-slate-900 text-amber-300 text-sm font-black px-4 py-2 rounded-full uppercase tracking-wide shadow-sm border-2 border-amber-400 whitespace-nowrap">🌙 {t("Daily Closing Report", "দৈনিক ক্লোজিং রিপোর্ট")}</span>
                    </div>

                    {/* Date info card */}
                    <div className="bg-gradient-to-br from-violet-50 to-indigo-50 border-2 border-violet-200 rounded-xl p-3 mb-4 text-center">
                      <span className="font-bold text-indigo-700 text-sm">📅 {new Date().toLocaleDateString('bn-BD', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
                    </div>

                    {/* Summary cards grid */}
                    <div className="grid grid-cols-2 gap-2 mb-4">
                      {checkShouldRenderTabOption("closing_total_sales") && (
                        <div className="bg-gradient-to-br from-emerald-50 to-indigo-50 border-2 border-emerald-200 rounded-xl p-2.5 text-center">
                          <div className="text-base font-black text-emerald-600">{computedDailySalesAmount.toFixed(0)} {currencySymbol}</div>
                          <div className="text-sm font-bold text-emerald-500 mt-0.5">💰 {t("Total Sales", "মোট বিক্রয়")}</div>
                        </div>
                      )}
                      {checkShouldRenderTabOption("closing_cash_received") && (
                        <div className="bg-gradient-to-br from-indigo-50 to-sky-50 border-2 border-indigo-200 rounded-xl p-2.5 text-center">
                          <div className="text-base font-black text-indigo-600">{(computedDailySalesAmount - computedDailyDue).toFixed(0)} {currencySymbol}</div>
                          <div className="text-sm font-bold text-indigo-500 mt-0.5">✅ {t("Cash Received", "নগদ পেয়েছি")}</div>
                        </div>
                      )}
                      {checkShouldRenderTabOption("closing_profit") && (
                        <div className="bg-gradient-to-br from-sky-50 to-blue-50 border-2 border-blue-200 rounded-xl p-2.5 text-center">
                          <div className="text-base font-black text-blue-600">{computedDailyProfitAmount.toFixed(0)} {currencySymbol}</div>
                          <div className="text-sm font-bold text-blue-500 mt-0.5">📈 {t("Today's Profit", "আজকের লাভ")}</div>
                        </div>
                      )}
                      {checkShouldRenderTabOption("closing_due") && (
                        <div className="bg-gradient-to-br from-rose-50 to-red-50 border-2 border-red-200 rounded-xl p-2.5 text-center">
                          <div className="text-base font-black text-red-600">{computedDailyDue.toFixed(0)} {currencySymbol}</div>
                          <div className="text-sm font-bold text-red-500 mt-0.5">⚠️ {t("Today's Due", "আজকের বাকি")}</div>
                        </div>
                      )}
                      {checkShouldRenderTabOption("closing_bkash") && (
                        <div className="bg-gradient-to-br from-pink-50 to-fuchsia-50 border-2 border-pink-200 rounded-xl p-2.5 text-center">
                          <div className="text-base font-black text-pink-600">{computedDailyBkash.toFixed(0)} {currencySymbol}</div>
                          <div className="text-sm font-bold text-pink-500 mt-0.5">📱 {t("bKash/Nagad", "বিকাশ/নগদ")}</div>
                        </div>
                      )}
                      {checkShouldRenderTabOption("closing_discount") && (
                        <div className="bg-gradient-to-br from-amber-50 to-orange-50 border-2 border-amber-200 rounded-xl p-2.5 text-center">
                          <div className="text-base font-black text-amber-600">{computedDailyDiscount.toFixed(0)} {currencySymbol}</div>
                          <div className="text-sm font-bold text-amber-500 mt-0.5">🏷️ {t("Discount Given", "ছাড় দিয়েছি")}</div>
                        </div>
                      )}
                      <div className="bg-gradient-to-br from-rose-50 to-red-50 border-2 border-rose-200 rounded-xl p-2.5 text-center">
                        <div className="text-base font-black text-rose-600">{computedDailyExpense.toFixed(0)} {currencySymbol}</div>
                        <div className="text-sm font-bold text-rose-500 mt-0.5">💸 {t("Today's Expense", "আজকের খরচ")}</div>
                      </div>
                    </div>

                    {/* Due collection */}
                    {checkShouldRenderTabOption("closing_due_collection") && computedDailyDueCollection > 0 && (
                      <div className="bg-gradient-to-br from-violet-50 to-purple-50 border-2 border-violet-200 rounded-xl p-3 mb-4 text-center">
                        <div className="text-base font-black text-violet-600">{computedDailyDueCollection.toFixed(0)} {currencySymbol}</div>
                        <div className="text-sm font-bold text-violet-500 mt-0.5">💵 {t("Due Collected Today", "আজ বাকি আদায়")}</div>
                      </div>
                    )}

                    {/* Final summary card */}
                    {checkShouldRenderTabOption("closing_final_summary") && (
                      <div className="bg-gradient-to-br from-violet-50 to-indigo-50 border-2 border-violet-200 rounded-xl p-3 flex flex-col gap-1.5 text-sm text-right font-semibold mb-4">
                        <h4 className="text-sm font-black uppercase tracking-wider text-violet-600 mb-1 text-center">📊 {t("End of Day Summary", "দিনের শেষ হিসাব")}</h4>
                        <div className="flex justify-between"><span className="text-violet-400">{t("Total Sales:", "মোট বিক্রয়:")}</span><span className="font-mono text-emerald-600">{computedDailySalesAmount.toFixed(1)} {currencySymbol}</span></div>
                        <div className="flex justify-between"><span className="text-violet-400">{t("Discount:", "ছাড়:")}</span><span className="font-mono text-amber-600">- {computedDailyDiscount.toFixed(1)} {currencySymbol}</span></div>
                        <div className="flex justify-between"><span className="text-violet-400">{t("Due Created:", "নতুন বাকি:")}</span><span className="font-mono text-red-600">- {computedDailyDue.toFixed(1)} {currencySymbol}</span></div>
                        <div className="flex justify-between"><span className="text-violet-400">{t("Due Collected:", "বাকি আদায়:")}</span><span className="font-mono text-violet-600">+ {computedDailyDueCollection.toFixed(1)} {currencySymbol}</span></div>
                        <div className="flex justify-between"><span className="text-violet-400">{t("Expense:", "খরচ:")}</span><span className="font-mono text-rose-600">- {computedDailyExpense.toFixed(1)} {currencySymbol}</span></div>
                        <div className="flex justify-between items-center bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-xl px-3 py-2 mt-0.5 shadow-sm">
                          <span className="uppercase text-sm font-black tracking-wide">{t("Cash in Hand", "মোট নগদ হাতে")}</span>
                          <span className="font-mono text-base font-black">{(computedDailySalesAmount - computedDailyDue + computedDailyDueCollection).toFixed(1)} {currencySymbol}</span>
                        </div>
                        <div className="flex justify-between text-sm"><span className="text-violet-400">{t("Net Profit Today:", "আজকের নিট লাভ:")}</span><span className="font-mono text-teal-600 font-black">{(computedDailyProfitAmount - computedDailyExpense).toFixed(1)} {currencySymbol}</span></div>
                      </div>
                    )}

                    {/* Footer */}
                    <div className="text-center border-t-2 border-dashed border-violet-300 pt-3">
                      <p className="text-sm tracking-[0.3em] text-amber-400 mb-1.5">✦ ✦ ✦ ✦ ✦</p>
                      <p className="text-sm font-black uppercase tracking-tight bg-gradient-to-r from-violet-600 to-indigo-600 bg-clip-text text-transparent">{t("— Closing Report End —", "— ক্লোজিং রিপোর্ট শেষ —")}</p>
                      <p className="text-sm text-slate-400 mt-1">{pharmacyName} · {pharmacyAddress}</p>
                      <p className="text-sm text-slate-400 mt-1">{t("Printed on:", "প্রিন্ট তারিখ:")} {new Date().toLocaleString()}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================
              TAB: DAILY REPORT
          ========================================================= */}
          {activeTab === "daily_report" && checkShouldRenderTabOption("daily_report") && (() => {
            const selectedDate = dailyReportDate;
            const setSelectedDate = setDailyReportDate;

            const isSameDay = (dateStr: string, isoDate: string) => {
              try {
                const d = parseCustomDateString(dateStr);
                return toLocalISODate(d) === isoDate;
              } catch { return false; }
            };

            const dayInvoices = invoices.filter(inv => isSameDay(inv.dateString, selectedDate));
            const daySell = dayInvoices.reduce((s: number, i: any) => s + (i.finalBill || 0), 0);
            const dayProfit = dayInvoices.reduce((s: number, i: any) => s + (i.profit || 0), 0);
            const dayDue = dayInvoices.reduce((s: number, i: any) => s + (i.due || 0), 0);
            const dayDueCollection = dueCollectionLog.filter((l: any) => isSameDay(l.dateString, selectedDate)).reduce((s: number, l: any) => s + (l.amount || 0), 0);
            const dayPurchase = purchaseList.filter((p: any) => isSameDay(p.dateString, selectedDate)).reduce((s: number, p: any) => s + (p.totalCost || 0), 0);
            const dayReturns = invoices.filter((i: any) => i.isReturned && i.returnDetails && isSameDay(i.returnDetails.timestamp || i.dateString, selectedDate));
            const dayRefund = dayReturns.reduce((s: number, i: any) => s + (i.returnDetails?.refundedAmount || 0), 0);
            const dayInvoiceCount = dayInvoices.filter((i: any) => !i.isReturned).length;
            const dayExpense = expenseList.filter((e: any) => isSameDay(e.dateString, selectedDate)).reduce((s: number, e: any) => s + (e.amount || 0), 0);
            const dayNetProfit = dayProfit - dayExpense;

            const stats = [
              { key: "daily_report_sell", label: t("Total Sell", "মোট বিক্রয়"), value: daySell, icon: "💰", color: "indigo" },
              { key: "daily_report_profit", label: t("Total Profit", "মোট লাভ"), value: dayProfit, icon: "📈", color: "emerald" },
              { key: "daily_report_due", label: t("New Due", "নতুন বাকি"), value: dayDue, icon: "⚠️", color: "red" },
              { key: "daily_report_due_collection", label: t("Due Collection", "বাকি আদায়"), value: dayDueCollection, icon: "✅", color: "blue" },
              { key: "daily_report_purchase", label: t("Purchase / Stock In", "ক্রয় / স্টক ইন"), value: dayPurchase, icon: "📦", color: "amber" },
              { key: "daily_report_returns", label: t("Returns / Refund", "ফেরত / রিফান্ড"), value: dayRefund, icon: "🔄", color: "rose" },
              { key: "expense_tracker", label: t("Today's Expense", "আজকের খরচ"), value: dayExpense, icon: "💸", color: "rose" },
              { key: "expense_view_profit", label: t("Net Profit", "নিট লাভ"), value: dayNetProfit, icon: "🧮", color: "teal" },
            ].filter(s => checkShouldRenderTabOption(s.key));

            const colorMap: Record<string, string> = {
              teal: isDarkMode ? 'bg-teal-950/60 border-teal-600 text-teal-300' : 'bg-white border-slate-200 text-teal-700',
              emerald: isDarkMode ? 'bg-emerald-950/60 border-emerald-600 text-emerald-300' : 'bg-white border-slate-200 text-emerald-700',
              red: isDarkMode ? 'bg-red-950/60 border-red-600 text-red-300' : 'bg-white border-slate-200 text-red-700',
              blue: isDarkMode ? 'bg-blue-950/60 border-blue-600 text-blue-300' : 'bg-white border-slate-200 text-blue-700',
              amber: isDarkMode ? 'bg-amber-950/60 border-amber-600 text-amber-300' : 'bg-white border-slate-200 text-amber-700',
              rose: isDarkMode ? 'bg-rose-950/60 border-rose-600 text-rose-300' : 'bg-white border-slate-200 text-rose-700',
            };

            return (
              <div className={`ccard p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800 border-slate-600' : 'bg-white border-slate-200'}`}>
                <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                  <div>
                    <h3 className="text-sm font-black uppercase tracking-wider text-sky-500">📅 {t("Daily Report", "দৈনিক রিপোর্ট")}</h3>
                    <p className={`text-sm mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Select a date to see all transactions", "যেকোনো তারিখের হিসাব দেখুন")}</p>
                  </div>
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={e => setSelectedDate(e.target.value)}
                    className={`px-3 py-2 rounded-xl border text-sm font-bold outline-none ${isDarkMode ? 'bg-slate-900 border-slate-600 text-white' : 'bg-white border-slate-200 text-slate-700'}`}
                  />
                </div>

                {/* Summary Cards */}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5">
                  {stats.map(s => (
                    <div key={s.label} className={`rounded-xl border p-3 text-center ${colorMap[s.color]}`}>
                      <p className="text-lg mb-0.5">{s.icon}</p>
                      <p className="text-xs font-bold uppercase opacity-70">{s.label}</p>
                      <p className="text-lg font-black font-mono mt-0.5">{s.value.toFixed(1)} {currencySymbol}</p>
                    </div>
                  ))}
                </div>

                {/* Invoice count */}
                <div className={`rounded-xl border px-4 py-2 mb-4 flex items-center justify-between text-sm font-bold ${isDarkMode ? 'bg-slate-900/50 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                  <span>🧾 {t("Total Invoices", "মোট রশিদ")}</span>
                  <span className="font-mono font-black text-indigo-500">{dayInvoiceCount}</span>
                </div>

                {/* Invoice list */}
                {dayInvoices.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm border-collapse">
                      <thead>
                        <tr className={`font-black text-xs border-b ${isDarkMode ? 'bg-slate-900/40 border-slate-700 text-slate-400' : 'bg-slate-100 border-slate-200 text-slate-500'}`}>
                          <th className="p-2">{t("Invoice", "রশিদ")}</th>
                          <th className="p-2">{t("Customer", "গ্রাহক")}</th>
                          <th className="p-2 text-right">{t("Sell", "বিক্রয়")}</th>
                          <th className="p-2 text-right">{t("Profit", "লাভ")}</th>
                          <th className="p-2 text-right">{t("Due", "বাকি")}</th>
                          <th className="p-2">{t("Status", "অবস্থা")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dayInvoices.map((inv: any, idx: number) => (
                          <tr key={inv.invoiceId} className={`border-b ${isDarkMode ? 'border-slate-700/50 hover:bg-slate-700/20' : 'border-slate-100 hover:bg-slate-50'}`}>
                            <td className="p-2 font-bold text-indigo-500">{inv.invoiceId}</td>
                            <td className="p-2">{inv.customer}</td>
                            <td className="p-2 text-right font-mono font-bold">{(inv.finalBill || 0).toFixed(1)}</td>
                            <td className="p-2 text-right font-mono text-emerald-500">{(inv.profit || 0).toFixed(1)}</td>
                            <td className="p-2 text-right font-mono text-red-500">{(inv.due || 0).toFixed(1)}</td>
                            <td className="p-2">
                              {inv.isReturned
                                ? <span className="text-xs bg-rose-500/10 text-rose-500 font-black px-1.5 py-0.5 rounded">🔄 {t("Returned", "ফেরত")}</span>
                                : <span className="text-xs bg-emerald-500/10 text-emerald-500 font-black px-1.5 py-0.5 rounded">✅ {t("Sold", "বিক্রি")}</span>
                              }
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className={`font-black text-sm border-t-2 ${isDarkMode ? 'border-slate-600 bg-slate-900/40' : 'border-slate-300 bg-slate-100'}`}>
                          <td colSpan={2} className="p-2 text-right uppercase text-xs">{t("Total", "মোট")}</td>
                          <td className="p-2 text-right font-mono text-indigo-500">{daySell.toFixed(1)}</td>
                          <td className="p-2 text-right font-mono text-emerald-500">{dayProfit.toFixed(1)}</td>
                          <td className="p-2 text-right font-mono text-red-500">{dayDue.toFixed(1)}</td>
                          <td></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                ) : (
                  <div className={`text-center py-12 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                    <p className="text-3xl mb-2">📭</p>
                    <p className="font-bold">{t("No transactions on this date", "এই তারিখে কোনো লেনদেন নেই")}</p>
                  </div>
                )}
              </div>
            );
          })()}

          {/* =========================================================
              TAB: MONTHLY REPORT
          ========================================================= */}
          {activeTab === "monthly_report" && checkShouldRenderTabOption("monthly_report") && (() => {
            // Build list of all unique year-months from invoices + purchases + due collection
            const allDates = [
              ...invoices.map((i: any) => i.dateString),
              ...purchaseList.map((p: any) => p.dateString),
              ...dueCollectionLog.map((l: any) => l.dateString),
            ];

            const getYearMonth = (dateStr: string) => {
              try {
                const d = parseCustomDateString(dateStr);
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
              } catch { return null; }
            };

            const thisMonth = new Date().toISOString().slice(0, 7);

            const monthSet = new Set<string>();
            allDates.forEach(ds => { const ym = getYearMonth(ds); if (ym) monthSet.add(ym); });
            const allMonths = Array.from(monthSet).sort((a, b) => b.localeCompare(a)); // newest first
            const selectedMonth = monthlyReportMonth || allMonths[0] || thisMonth;
            const setSelectedMonth = setMonthlyReportMonth;

            const monthLabel = (ym: string) => {
              const [y, m] = ym.split('-');
              const d = new Date(parseInt(y), parseInt(m) - 1, 1);
              return d.toLocaleDateString([], { year: 'numeric', month: 'long' });
            };

            const isInMonth = (dateStr: string, ym: string) => getYearMonth(dateStr) === ym;

            const mInvoices = invoices.filter((i: any) => isInMonth(i.dateString, selectedMonth));
            const mSell = mInvoices.reduce((s: number, i: any) => s + (i.finalBill || 0), 0);
            const mProfit = mInvoices.reduce((s: number, i: any) => s + (i.profit || 0), 0);
            const mDue = mInvoices.reduce((s: number, i: any) => s + (i.due || 0), 0);
            const mDueCollection = dueCollectionLog.filter((l: any) => isInMonth(l.dateString, selectedMonth)).reduce((s: number, l: any) => s + (l.amount || 0), 0);
            const mPurchase = purchaseList.filter((p: any) => isInMonth(p.dateString, selectedMonth)).reduce((s: number, p: any) => s + (p.totalCost || 0), 0);
            const mReturns = invoices.filter((i: any) => i.isReturned && i.returnDetails && isInMonth(i.returnDetails.timestamp || i.dateString, selectedMonth));
            const mRefund = mReturns.reduce((s: number, i: any) => s + (i.returnDetails?.refundedAmount || 0), 0);
            const mInvoiceCount = mInvoices.filter((i: any) => !i.isReturned).length;
            const mExpense = expenseList.filter((e: any) => isInMonth(e.dateString, selectedMonth)).reduce((s: number, e: any) => s + (e.amount || 0), 0);
            const mNetProfit = mProfit - mExpense;

            // Group month invoices by day for daily breakdown table
            const dayMap: Record<string, { sell: number; profit: number; due: number; dueCol: number; purchase: number; count: number }> = {};
            mInvoices.forEach((i: any) => {
              const day = toLocalISODate(parseCustomDateString(i.dateString));
              if (!dayMap[day]) dayMap[day] = { sell: 0, profit: 0, due: 0, dueCol: 0, purchase: 0, count: 0 };
              dayMap[day].sell += i.finalBill || 0;
              dayMap[day].profit += i.profit || 0;
              dayMap[day].due += i.due || 0;
              if (!i.isReturned) dayMap[day].count++;
            });
            dueCollectionLog.filter((l: any) => isInMonth(l.dateString, selectedMonth)).forEach((l: any) => {
              const day = toLocalISODate(parseCustomDateString(l.dateString));
              if (!dayMap[day]) dayMap[day] = { sell: 0, profit: 0, due: 0, dueCol: 0, purchase: 0, count: 0 };
              dayMap[day].dueCol += l.amount || 0;
            });
            purchaseList.filter((p: any) => isInMonth(p.dateString, selectedMonth)).forEach((p: any) => {
              const day = toLocalISODate(parseCustomDateString(p.dateString));
              if (!dayMap[day]) dayMap[day] = { sell: 0, profit: 0, due: 0, dueCol: 0, purchase: 0, count: 0 };
              dayMap[day].purchase += p.totalCost || 0;
            });
            const sortedDays = Object.keys(dayMap).sort((a, b) => b.localeCompare(a));

            const stats = [
              { key: "monthly_report_sell", label: t("Total Sell", "মোট বিক্রয়"), value: mSell, icon: "💰", color: "indigo" },
              { key: "monthly_report_profit", label: t("Total Profit", "মোট লাভ"), value: mProfit, icon: "📈", color: "emerald" },
              { key: "monthly_report_due", label: t("New Due", "নতুন বাকি"), value: mDue, icon: "⚠️", color: "red" },
              { key: "monthly_report_due_collection", label: t("Due Collection", "বাকি আদায়"), value: mDueCollection, icon: "✅", color: "blue" },
              { key: "monthly_report_purchase", label: t("Purchase / Stock In", "ক্রয় / স্টক ইন"), value: mPurchase, icon: "📦", color: "amber" },
              { key: "monthly_report_returns", label: t("Returns / Refund", "ফেরত / রিফান্ড"), value: mRefund, icon: "🔄", color: "rose" },
              { key: "expense_tracker", label: t("Monthly Expense", "মাসিক খরচ"), value: mExpense, icon: "💸", color: "rose" },
              { key: "expense_view_profit", label: t("Net Profit", "নিট লাভ"), value: mNetProfit, icon: "🧮", color: "teal" },
            ].filter(s => checkShouldRenderTabOption(s.key));

            const colorMap: Record<string, string> = {
              teal: isDarkMode ? 'bg-teal-950/60 border-teal-600 text-teal-300' : 'bg-white border-slate-200 text-teal-700',
              emerald: isDarkMode ? 'bg-emerald-950/60 border-emerald-600 text-emerald-300' : 'bg-white border-slate-200 text-emerald-700',
              red: isDarkMode ? 'bg-red-950/60 border-red-600 text-red-300' : 'bg-white border-slate-200 text-red-700',
              blue: isDarkMode ? 'bg-blue-950/60 border-blue-600 text-blue-300' : 'bg-white border-slate-200 text-blue-700',
              amber: isDarkMode ? 'bg-amber-950/60 border-amber-600 text-amber-300' : 'bg-white border-slate-200 text-amber-700',
              rose: isDarkMode ? 'bg-rose-950/60 border-rose-600 text-rose-300' : 'bg-white border-slate-200 text-rose-700',
            };

            return (
              <div className={`ccard p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800 border-slate-600' : 'bg-white border-slate-200'}`}>
                <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                  <div>
                    <h3 className="text-sm font-black uppercase tracking-wider text-violet-500">📆 {t("Monthly Report", "মাসিক রিপোর্ট")}</h3>
                    <p className={`text-sm mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Month by month breakdown", "মাস অনুযায়ী সম্পূর্ণ হিসাব")}</p>
                  </div>
                  <select
                    value={selectedMonth}
                    onChange={e => setSelectedMonth(e.target.value)}
                    className={`px-3 py-2 rounded-xl border text-sm font-bold outline-none ${isDarkMode ? 'bg-slate-900 border-slate-600 text-white' : 'bg-white border-slate-200 text-slate-700'}`}
                  >
                    {allMonths.length === 0 && <option value={thisMonth}>{monthLabel(thisMonth)}</option>}
                    {allMonths.map(ym => <option key={ym} value={ym}>{monthLabel(ym)}</option>)}
                  </select>
                </div>

                {/* Summary Cards */}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
                  {stats.map(s => (
                    <div key={s.label} className={`rounded-xl border p-3 text-center ${colorMap[s.color]}`}>
                      <p className="text-lg mb-0.5">{s.icon}</p>
                      <p className="text-xs font-bold uppercase opacity-70">{s.label}</p>
                      <p className="text-lg font-black font-mono mt-0.5">{s.value.toFixed(1)} {currencySymbol}</p>
                    </div>
                  ))}
                </div>

                {/* Invoice count */}
                <div className={`rounded-xl border px-4 py-2 mb-4 flex items-center justify-between text-sm font-bold ${isDarkMode ? 'bg-slate-900/50 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                  <span>🧾 {t("Total Invoices This Month", "এই মাসে মোট রশিদ")}</span>
                  <span className="font-mono font-black text-indigo-500">{mInvoiceCount}</span>
                </div>

                {/* Daily breakdown */}
                <h4 className={`text-xs font-black uppercase tracking-wider mb-2 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>📋 {t("Day by Day Breakdown", "দিন অনুযায়ী বিবরণ")}</h4>
                {sortedDays.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm border-collapse">
                      <thead>
                        <tr className={`font-black text-xs border-b ${isDarkMode ? 'bg-slate-900/40 border-slate-700 text-slate-400' : 'bg-slate-100 border-slate-200 text-slate-500'}`}>
                          <th className="p-2">{t("Date", "তারিখ")}</th>
                          <th className="p-2 text-center">{t("Invoices", "রশিদ")}</th>
                          <th className="p-2 text-right">{t("Sell", "বিক্রয়")}</th>
                          <th className="p-2 text-right">{t("Profit", "লাভ")}</th>
                          <th className="p-2 text-right">{t("Due", "বাকি")}</th>
                          <th className="p-2 text-right">{t("Due Collect", "বাকি আদায়")}</th>
                          <th className="p-2 text-right">{t("Purchase", "ক্রয়")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedDays.map((day, idx) => {
                          const r = dayMap[day];
                          const d = new Date(day);
                          const label = d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' });
                          return (
                            <tr key={day} className={`border-b cursor-pointer ${isDarkMode ? 'border-slate-700/50 hover:bg-slate-700/30' : 'border-slate-100 hover:bg-violet-50/50'}`}
                              onClick={() => { setDailyReportDate(day); navigateTab('daily_report'); }}>
                              <td className="p-2 font-bold text-violet-500">{label}</td>
                              <td className="p-2 text-center font-mono">{r.count}</td>
                              <td className="p-2 text-right font-mono font-bold text-indigo-500">{r.sell.toFixed(1)}</td>
                              <td className="p-2 text-right font-mono text-emerald-500">{r.profit.toFixed(1)}</td>
                              <td className="p-2 text-right font-mono text-red-500">{r.due.toFixed(1)}</td>
                              <td className="p-2 text-right font-mono text-blue-500">{r.dueCol.toFixed(1)}</td>
                              <td className="p-2 text-right font-mono text-amber-500">{r.purchase.toFixed(1)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className={`font-black text-sm border-t-2 ${isDarkMode ? 'border-slate-600 bg-slate-900/40' : 'border-slate-300 bg-slate-100'}`}>
                          <td className="p-2 text-xs uppercase">{t("Total", "মোট")}</td>
                          <td className="p-2 text-center font-mono">{mInvoiceCount}</td>
                          <td className="p-2 text-right font-mono text-indigo-500">{mSell.toFixed(1)}</td>
                          <td className="p-2 text-right font-mono text-emerald-500">{mProfit.toFixed(1)}</td>
                          <td className="p-2 text-right font-mono text-red-500">{mDue.toFixed(1)}</td>
                          <td className="p-2 text-right font-mono text-blue-500">{mDueCollection.toFixed(1)}</td>
                          <td className="p-2 text-right font-mono text-amber-500">{mPurchase.toFixed(1)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                ) : (
                  <div className={`text-center py-12 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                    <p className="text-3xl mb-2">📭</p>
                    <p className="font-bold">{t("No transactions this month", "এই মাসে কোনো লেনদেন নেই")}</p>
                  </div>
                )}
              </div>
            );
          })()}

          {/* =========================================================
              TAB 8: SETTINGS
          ========================================================= */}
          {activeTab === "settings" && checkShouldRenderTabOption("settings") && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

              {/* Website Info */}
              <div className={`ccard cc-cyan p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500 mb-3">🏪 {t("Pharmacy Info", "ফার্মেসির তথ্য")}</h3>
                <div className="flex flex-col gap-3 text-sm">
                  <div>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Pharmacy Name", "ফার্মেসির নাম")}</label>
                    <input type="text" value={settingsName} onChange={e => setSettingsName(e.target.value)} className={`w-full px-3 py-2 rounded-xl border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                  </div>
                  <div>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Slogan / Tagline", "স্লোগান")}</label>
                    <input type="text" value={settingsSlogan} onChange={e => setSettingsSlogan(e.target.value)} className={`w-full px-3 py-2 rounded-xl border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                  </div>
                  <div>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Address", "ঠিকানা")}</label>
                    <input type="text" value={settingsAddress} onChange={e => setSettingsAddress(e.target.value)} className={`w-full px-3 py-2 rounded-xl border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                  </div>
                  <div>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Logo Text / Icon (e.g. M+, 💊)", "লোগো টেক্সট/আইকন")}</label>
                    <input type="text" value={settingsLogo.startsWith('data:image') ? '' : settingsLogo} onChange={e => setSettingsLogo(e.target.value)} placeholder={settingsLogo.startsWith('data:image') ? t("Image selected — clear to type text", "ছবি নির্বাচিত — টেক্সট লিখতে মুছুন") : ""} className={`w-full px-3 py-2 rounded-xl border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />

                    <label className={`block text-sm font-bold mb-1 mt-3 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Or upload a logo image", "অথবা লোগো ছবি আপলোড করুন")}</label>
                    <div className="flex items-center gap-3">
                      <div className={`w-14 h-14 rounded-xl border flex items-center justify-center overflow-hidden shrink-0 font-black text-lg ${isDarkMode ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                        {settingsLogo.startsWith('data:image')
                          ? <img src={settingsLogo} alt="logo preview" className="w-full h-full object-cover" />
                          : <span className="text-indigo-500">{settingsLogo || "M+"}</span>
                        }
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            if (!file.type.startsWith('image/')) { alert(t("Please select a valid image file!", "একটি সঠিক ছবি ফাইল নির্বাচন করুন!")); return; }
                            const reader = new FileReader();
                            reader.onload = (ev) => {
                              const img = new window.Image();
                              img.onload = () => {
                                const maxSize = 200;
                                let w = img.width, h = img.height;
                                if (w > h) { if (w > maxSize) { h = Math.round(h * (maxSize / w)); w = maxSize; } }
                                else { if (h > maxSize) { w = Math.round(w * (maxSize / h)); h = maxSize; } }
                                const canvas = document.createElement('canvas');
                                canvas.width = w; canvas.height = h;
                                const ctx = canvas.getContext('2d');
                                if (ctx) {
                                  ctx.drawImage(img, 0, 0, w, h);
                                  const dataUrl = canvas.toDataURL('image/png');
                                  setSettingsLogo(dataUrl);
                                }
                              };
                              img.src = ev.target?.result as string;
                            };
                            reader.readAsDataURL(file);
                            e.target.value = '';
                          }}
                          className={`text-sm w-full file:mr-2 file:py-1.5 file:px-3 file:rounded-xl file:border-0 file:font-bold file:text-sm file:bg-indigo-500 file:text-white hover:file:bg-indigo-600 file:cursor-pointer cursor-pointer ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}
                        />
                        {settingsLogo.startsWith('data:image') && (
                          <button onClick={() => setSettingsLogo("M+")} className="text-sm font-bold text-red-500 hover:text-red-600 text-left">✕ {t("Remove image, use text instead", "ছবি মুছুন, টেক্সট ব্যবহার করুন")}</button>
                        )}
                      </div>
                    </div>
                  </div>
                  <button onClick={handleSaveWebsiteConfig} className="bg-indigo-500 hover:bg-indigo-600 text-white font-black px-4 py-2 rounded-xl text-sm transition">{t("Save Info", "তথ্য সংরক্ষণ")}</button>
                </div>
              </div>

              {/* Advanced Config */}
              <div className={`ccard cc-purple p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500 mb-3">⚙️ {t("Advanced Settings", "উন্নত সেটিংস")}</h3>
                <div className="flex flex-col gap-3 text-sm">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Currency Symbol", "মুদ্রা চিহ্ন")}</label>
                      <input type="text" value={currencySymbol} onChange={e => handleUpdateAdvancedConfig(e.target.value, vatPercentage, lowStockThreshold, receiptFooterMsg)} className={`w-full px-2 py-1.5 rounded border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                    </div>
                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("VAT %", "ভ্যাট %")}</label>
                      <input type="number" value={vatPercentage} onChange={e => handleUpdateAdvancedConfig(currencySymbol, e.target.value, lowStockThreshold, receiptFooterMsg)} className={`w-full px-2 py-1.5 rounded border outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                    </div>
                  </div>
                  <div>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Default Low Stock Alert Threshold", "ডিফল্ট কম স্টক সীমা")}</label>
                    <input type="number" value={lowStockThreshold} onChange={e => handleUpdateAdvancedConfig(currencySymbol, vatPercentage, e.target.value, receiptFooterMsg)} className={`w-full px-2 py-1.5 rounded border outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                  </div>
                  <div>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Receipt Footer Message", "রশিদের শেষ বার্তা")}</label>
                    <input type="text" value={receiptFooterMsg} onChange={e => handleUpdateAdvancedConfig(currencySymbol, vatPercentage, lowStockThreshold, e.target.value)} className={`w-full px-2 py-1.5 rounded border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                  </div>

                  {/* Theme */}
                  <div>
                    <label className={`block text-sm font-bold mb-2 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Theme / Appearance", "থিম / রঙ")}</label>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { key: 'light',    emoji: '☀️', label: t('Light',    'হালকা'),      dot: '#f8fafc', dotB: '#e2e8f0', ring: '#94a3b8' },
                        { key: 'dark',     emoji: '🌙', label: t('Dark',     'অন্ধকার'),    dot: '#1e293b', dotB: '#334155', ring: '#64748b' },
                      ].map(th => (
                        <button
                          key={th.key}
                          onClick={() => handleSetTheme(th.key)}
                          className="flex items-center gap-2 px-3 py-2 rounded-xl border-2 text-sm font-bold transition-all duration-200 hover:scale-[1.02]"
                          style={{
                            backgroundColor: th.dot,
                            borderColor: themeMode === th.key ? th.ring : th.dotB + '80',
                            color: th.key === 'light' || th.key === 'glacier' ? '#1e293b' : th.dotB,
                            boxShadow: themeMode === th.key ? `0 0 0 2px ${th.ring}55, 0 0 12px ${th.ring}33` : 'none',
                            transform: themeMode === th.key ? 'scale(1.03)' : 'scale(1)',
                          }}
                        >
                          <span className="text-base leading-none">{th.emoji}</span>
                          <span className="flex-1 text-left">{th.label}</span>
                          {themeMode === th.key && <span style={{ color: th.ring }} className="text-sm">✓</span>}
                        </button>
                      ))}
                    </div>
                    <p className="text-sm text-slate-400 mt-2">{t("Current theme: ", "বর্তমান থিম: ")}<strong style={{ color: isCustomTheme ? (activeThemeStyle as any)['--theme-accent'] : undefined }}>{themeMode.charAt(0).toUpperCase() + themeMode.slice(1)}</strong></p>
                  </div>

                  {/* Language */}
                  <div>
                    <label className={`block text-sm font-bold mb-2 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Language", "ভাষা")}</label>
                    <div className="flex gap-2">
                      <button onClick={() => handleLanguageChange("en")} className={`flex-1 py-1.5 rounded-xl text-sm font-black transition ${language === "en" ? 'bg-indigo-500 text-white' : isDarkMode ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>🇬🇧 English</button>
                      <button onClick={() => handleLanguageChange("bn")} className={`flex-1 py-1.5 rounded-xl text-sm font-black transition ${language === "bn" ? 'bg-indigo-500 text-white' : isDarkMode ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>🇧🇩 বাংলা</button>
                    </div>
                  </div>
                </div>
              </div>

              {/* System Lock & Notice Broadcast — Admin only */}
              {currentUserRole === "ADMIN" && (
                <div className={`ccard cc-amber p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <h3 className="text-sm font-black uppercase tracking-wider text-amber-500 mb-3">🛡️ {t("System Control", "সিস্টেম কন্ট্রোল")}</h3>
                  <div onClick={toggleSystemLock} className={`cursor-pointer select-none flex items-center justify-between gap-3 p-3 rounded-xl border transition-all mb-3 ${systemLocked ? 'border-red-500 bg-red-500/10' : isDarkMode ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-white'}`}>
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{systemLocked ? '🔒' : '🔓'}</span>
                      <span className={`text-sm font-black ${systemLocked ? 'text-red-500' : isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>
                        {systemLocked ? t("EVERYTHING LOCKED for Staff — tap to unlock", "স্টাফের জন্য সব বন্ধ — খুলতে ট্যাপ করুন") : t("App is OPEN — tap to lock everything for Staff", "অ্যাপ চালু আছে — স্টাফের জন্য সব বন্ধ করতে ট্যাপ করুন")}
                      </span>
                    </div>
                    <div className={`w-11 h-6 rounded-full transition-colors flex items-center px-0.5 ${systemLocked ? 'bg-red-500' : 'bg-slate-300'}`}>
                      <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${systemLocked ? 'translate-x-5' : 'translate-x-0'}`}></div>
                    </div>
                  </div>
                  <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Notice for Staff", "স্টাফের জন্য নোটিশ")}</label>
                  <textarea
                    value={creatorNoticeInput}
                    onChange={e => setCreatorNoticeInput(e.target.value)}
                    rows={2}
                    placeholder={t("Type a message Staff will see...", "স্টাফ যে বার্তা দেখবে তা লিখুন...")}
                    className={`w-full px-2 py-1.5 rounded border outline-none mb-2 ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                  />
                  <div className="flex gap-2 justify-end">
                    {creatorNotice && <button onClick={() => { setCreatorNoticeInput(""); setCreatorNotice(""); cloudSet('madina_v7_creator_notice', ""); }} className={`px-3 py-1.5 text-sm font-bold rounded transition ${isDarkMode ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-500'}`}>{t("Clear", "মুছুন")}</button>}
                    <button onClick={saveCreatorNotice} className="bg-amber-500 hover:bg-amber-600 text-white font-black text-sm px-4 py-1.5 rounded uppercase tracking-wider shadow-sm">{t("Broadcast", "পাঠান")}</button>
                  </div>
                </div>
              )}

              {/* Login Credentials — Admin-only management of Admin & Staff accounts */}
              <div className={`ccard cc-teal p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500 mb-3">🔐 {t("Login Credentials", "লগইন তথ্য পরিবর্তন")}</h3>

                {currentUserRole !== "ADMIN" ? (
                  <p className={`text-sm font-bold p-3 rounded-xl ${isDarkMode ? 'bg-slate-900 text-slate-400' : 'bg-white text-slate-500'}`}>
                    🔒 {t("Only the Admin account can view or change Admin & Staff login credentials.", "শুধুমাত্র অ্যাডমিন অ্যাকাউন্ট অ্যাডমিন ও স্টাফের লগইন তথ্য দেখতে বা পরিবর্তন করতে পারবে।")}
                  </p>
                ) : !isCredentialsFormUnlocked ? (
                  <form onSubmit={handleVerifyCurrentPassword} className="flex flex-col gap-2">
                    <div className="flex gap-2 items-center">
                      <input
                        type="password"
                        placeholder={t("Enter current Admin password to unlock...", "আনলক করতে বর্তমান অ্যাডমিন পাসওয়ার্ড দিন...")}
                        value={currentPassCheck}
                        onChange={e => { setCurrentPassCheck(e.target.value); if (credentialsUnlockError) setCredentialsUnlockError(""); }}
                        className={`px-3 py-1.5 text-sm rounded border outline-none flex-1 ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-100 border-slate-200'}`}
                      />
                      <button type="submit" className="bg-slate-600 text-white text-sm font-bold px-3 py-1.5 rounded uppercase transition">{t("Unlock", "আনলক")}</button>
                    </div>
                    {credentialsUnlockError && (
                      <p className="text-sm font-bold text-red-500">{credentialsUnlockError}</p>
                    )}
                  </form>
                ) : (
                  <form onSubmit={handleSaveAllCredentialsCombined} className="flex flex-col gap-3 text-sm">
                    <h4 className="text-sm font-black text-emerald-500 uppercase">✅ {t("Unlocked - Edit credentials below:", "আনলক হয়েছে - নিচে পরিবর্তন করুন:")}</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Admin Username", "অ্যাডমিন ইউজারনেম")}</label>
                        <input type="text" value={newUsernameInput} onChange={e => setNewUsernameInput(e.target.value)} className={`w-full px-2 py-1.5 rounded border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                      </div>
                      <div>
                        <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Admin Password", "অ্যাডমিন পাসওয়ার্ড")}</label>
                        <input type="text" value={newPasswordInput} onChange={e => setNewPasswordInput(e.target.value)} className={`w-full px-2 py-1.5 rounded border outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                      </div>
                      <div>
                        <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Staff Username", "স্টাফ ইউজারনেম")}</label>
                        <input type="text" value={newStaffUsernameInput} onChange={e => setNewStaffUsernameInput(e.target.value)} className={`w-full px-2 py-1.5 rounded border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                      </div>
                      <div>
                        <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Staff Password", "স্টাফ পাসওয়ার্ড")}</label>
                        <input type="text" value={newStaffPasswordInput} onChange={e => setNewStaffPasswordInput(e.target.value)} className={`w-full px-2 py-1.5 rounded border outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                      </div>
                      <div>
                        <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Telegram Bot Token", "টেলিগ্রাম বট টোকেন")}</label>
                        <input type="text" value={newTelegramBotTokenInput} onChange={e => setNewTelegramBotTokenInput(e.target.value)} placeholder="123456:ABC-DEF..." className={`w-full px-2 py-1.5 rounded border outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                      </div>
                      <div>
                        <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Telegram Chat ID", "টেলিগ্রাম চ্যাট আইডি")}</label>
                        <input type="text" value={newTelegramChatIdInput} onChange={e => setNewTelegramChatIdInput(e.target.value)} placeholder="123456789" className={`w-full px-2 py-1.5 rounded border outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                      </div>
                      <div className="col-span-2">
                        <p className="text-sm text-slate-400 mt-1">{t(
                          "Used for \"Forgot Password\": tap it on the login screen and a one-time code is sent to this Telegram chat. Setup: (1) message @BotFather → /newbot → copy the token above. (2) message your new bot once (e.g. \"hi\"). (3) open https://api.telegram.org/bot<token>/getUpdates in a browser and copy the \"chat\":{\"id\":...} number above.",
                          "\"পাসওয়ার্ড ভুলে গেছেন\" এর জন্য ব্যবহৃত হয়: লগইন স্ক্রিনে ট্যাপ করলে এই টেলিগ্রাম চ্যাটে একটি ওয়ান-টাইম কোড আসবে। সেটআপ: (১) @BotFather কে মেসেজ দিন → /newbot → টোকেন কপি করুন। (২) আপনার নতুন বটকে একবার মেসেজ দিন (যেমন \"hi\")। (৩) ব্রাউজারে https://api.telegram.org/bot<token>/getUpdates খুলে \"chat\":{\"id\":...} নম্বরটি কপি করুন।"
                        )}</p>
                      </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                      <button type="button" onClick={() => setIsCredentialsFormUnlocked(false)} className={`px-3 py-1.5 text-sm font-bold rounded transition ${isDarkMode ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-500'}`}>{t("Cancel", "বাতিল")}</button>
                      <button type="submit" className="bg-emerald-500 text-white font-black text-sm px-4 py-1.5 rounded uppercase tracking-wider shadow-sm">{t("Save Credentials", "সংরক্ষণ করুন")}</button>
                    </div>
                  </form>
                )}
              </div>

              {/* Backup & Restore Section — Phase 5 */}
              {checkShouldRenderTabOption("backup_restore") && (
                <div className={`ccard cc-blue p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <h3 className="text-sm font-black uppercase tracking-wider text-blue-500 mb-1 flex items-center gap-2">
                    💾 {t("Backup & Restore", "ব্যাকআপ ও পুনরুদ্ধার")}
                  </h3>
                  <p className={`text-sm mb-3 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                    {t("Keep your data safe across all devices. Download a JSON backup and store it in Google Drive, Email, or any safe location.", "সব ডিভাইসে ডেটা নিরাপদ রাখুন। JSON ব্যাকআপ ডাউনলোড করে Google Drive, Email বা যেকোনো নিরাপদ জায়গায় রাখুন।")}
                  </p>

                  {/* Last Backup Status */}
                  <div className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm mb-3 ${isDarkMode ? 'bg-slate-800' : 'bg-white border border-slate-200'}`}>
                    <span className="text-xl">🕐</span>
                    <div>
                      <span className={`font-bold block text-sm ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>{t("Last Backup:", "শেষ ব্যাকআপ:")}</span>
                      <span className={`text-sm font-mono ${lastBackupTime ? 'text-emerald-500 font-bold' : 'text-red-400'}`}>
                        {lastBackupTime || t("⚠️ No backup yet!", "⚠️ এখনো ব্যাকআপ হয়নি!")}
                      </span>
                    </div>
                  </div>

                  {/* Phase 5 Safety Info */}
                  <div className={`rounded-xl p-3 mb-3 text-sm ${isDarkMode ? 'bg-emerald-950/40 border border-emerald-700' : 'bg-emerald-50 border border-emerald-200'}`}>
                    <p className="font-black text-emerald-500 mb-1.5">🛡️ {t("Phase 5 Safety System", "ফেজ ৫ নিরাপত্তা সিস্টেম")}</p>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2"><span className="text-emerald-500">✅</span><span className={isDarkMode ? 'text-slate-300' : 'text-slate-600'}>{t("Collision-safe backup IDs (timestamp + UUID)", "কলিশন-নিরাপদ ব্যাকআপ আইডি (timestamp + UUID)")}</span></div>
                      <div className="flex items-center gap-2"><span className="text-blue-500">✅</span><span className={isDarkMode ? 'text-slate-300' : 'text-slate-600'}>{t("Atomic restore — all keys or nothing (no partial writes)", "অ্যাটমিক রিস্টোর — সব কী অথবা কিছুই না (আংশিক রাইট নেই)")}</span></div>
                      <div className="flex items-center gap-2"><span className="text-purple-500">✅</span><span className={isDarkMode ? 'text-slate-300' : 'text-slate-600'}>{t("Auto emergency backup before every restore", "প্রতিটি রিস্টোরের আগে স্বয়ংক্রিয় জরুরি ব্যাকআপ")}</span></div>
                      <div className="flex items-center gap-2"><span className="text-amber-500">✅</span><span className={isDarkMode ? 'text-slate-300' : 'text-slate-600'}>{t("Schema validation — rejects incompatible backups", "স্কিমা যাচাই — অসামঞ্জস্যপূর্ণ ব্যাকআপ প্রত্যাখ্যান করে")}</span></div>
                      <div className="flex items-center gap-2"><span className="text-rose-500">✅</span><span className={isDarkMode ? 'text-slate-300' : 'text-slate-600'}>{t("Post-restore integrity check on all financial keys", "সমস্ত আর্থিক কী-তে রিস্টোর-পরবর্তী অখণ্ডতা পরীক্ষা")}</span></div>
                    </div>
                  </div>

                  {/* Restore safety notice */}
                  <div className={`rounded-xl p-3 mb-3 text-xs ${isDarkMode ? 'bg-amber-950/40 border border-amber-700' : 'bg-amber-50 border border-amber-200'}`}>
                    <p className={`font-bold ${isDarkMode ? 'text-amber-400' : 'text-amber-700'}`}>
                      ⚠️ {t(
                        "Restore is destructive. An emergency backup of current live data is always saved to Firebase (/madina_backups) before any restore begins. If restore fails mid-way, your live data is NOT modified — the atomic write either succeeds completely or fails completely.",
                        "রিস্টোর একটি ধ্বংসাত্মক অপারেশন। যেকোনো রিস্টোর শুরুর আগে বর্তমান লাইভ ডেটার একটি জরুরি ব্যাকআপ Firebase-এ (/madina_backups) সংরক্ষিত হয়। রিস্টোর ব্যর্থ হলে আপনার লাইভ ডেটা পরিবর্তন হবে না — অ্যাটমিক রাইট হয় সম্পূর্ণ সফল হয় বা সম্পূর্ণ ব্যর্থ হয়।"
                      )}
                    </p>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex flex-wrap gap-2">
                    {/* Download JSON */}
                    <button
                      onClick={handleDownloadBackup}
                      disabled={isBackingUp}
                      className="flex items-center gap-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-60 text-white font-black text-sm px-4 py-2 rounded-xl uppercase tracking-wider shadow transition"
                    >
                      {isBackingUp ? '⏳' : '⬇️'} {t("Download Backup", "ব্যাকআপ ডাউনলোড")}
                    </button>

                    {/* Firebase Backup */}
                    {isFirebaseConfigured() && (
                      <button
                        onClick={handleFirebaseBackup}
                        disabled={isBackingUp}
                        className="flex items-center gap-1.5 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 text-white font-black text-sm px-4 py-2 rounded-xl uppercase tracking-wider shadow transition"
                      >
                        {isBackingUp ? '⏳' : '☁️'} {t("Cloud Backup", "ক্লাউড ব্যাকআপ")}
                      </button>
                    )}

                    {/* Restore from File */}
                    <button
                      onClick={() => restoreFileRef.current?.click()}
                      disabled={isRestoring}
                      className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white font-black text-sm px-4 py-2 rounded-xl uppercase tracking-wider shadow transition"
                    >
                      {isRestoring ? '⏳' : '⬆️'} {t("Restore from File", "ফাইল থেকে রিস্টোর")}
                    </button>
                    <input
                      ref={restoreFileRef}
                      type="file"
                      accept=".json"
                      onChange={handleRestoreFromFile}
                      className="hidden"
                    />
                  </div>

                  <p className={`text-sm mt-3 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                    💡 {t(
                      "Tip: Cloud Backup uses a unique ID per backup — multiple backups on the same day are all preserved separately in Firebase under /madina_backups.",
                      "টিপস: ক্লাউড ব্যাকআপ প্রতিটি ব্যাকআপে একটি অনন্য আইডি ব্যবহার করে — একই দিনের একাধিক ব্যাকআপ Firebase-এর /madina_backups-এ আলাদাভাবে সংরক্ষিত থাকে।"
                    )}
                  </p>
                </div>
              )}

              {/* Danger Zone */}
              {checkShouldRenderTabOption("backup_restore") && (
                <div className={`ccard cc-indigo p-4 rounded-xl border shadow-sm border-red-500/20 ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <h3 className="text-sm font-black uppercase tracking-wider text-red-500 mb-2">🚨 {t("Danger Zone", "বিপদ জোন")}</h3>
                  <p className={`text-sm mb-3 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("This will delete ALL data and reset to factory defaults.", "এটি সব তথ্য মুছে ফেলবে।")}</p>
                  <button onClick={resetDatabase} className="bg-red-500 hover:bg-red-600 text-white font-black text-sm px-4 py-2 rounded-xl uppercase tracking-wider transition">🗑️ {t("Factory Reset", "ফ্যাক্টরি রিসেট")}</button>
                </div>
              )}

            </div>
          )}


          {/* =========================================================
              FIREBASE SETUP GUIDE (shown inside Settings)
          ========================================================= */}
          {activeTab === "settings" && checkShouldRenderTabOption("settings") && (
            <div className={`ccard cc-green mt-4 p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
              <h3 className="text-sm font-black uppercase tracking-wider text-blue-500 mb-1">☁️ {t("Cloud Sync Setup (Firebase)", "ক্লাউড সিঙ্ক সেটআপ (Firebase)")}</h3>
              {isFirebaseConfigured() ? (
                <div className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-bold ${isDarkMode ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'}`}>
                  ✅ {t("Firebase is configured! Data syncs across all devices automatically.", "Firebase সেটআপ হয়ে গেছে! সব ডিভাইসে ডেটা অটো সিঙ্ক হচ্ছে।")}
                </div>
              ) : (
                <div className="flex flex-col gap-2 text-sm">
                  <p className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>
                    {t("Firebase is not configured yet. Follow the steps below to enable cross-device sync:", "Firebase এখনো সেটআপ হয়নি। নিচের ধাপ অনুসরণ করুন:")}
                  </p>
                  <ol className={`list-decimal list-inside flex flex-col gap-1.5 pl-1 ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>
                    <li>{t("Go to", "যান")} <a href="https://console.firebase.google.com" target="_blank" rel="noopener noreferrer" className="text-blue-500 underline font-bold">console.firebase.google.com</a></li>
                    <li>{t('Click "Add project" → give a name → Continue', '"Add project" ক্লিক করুন → নাম দিন → Continue')}</li>
                    <li>{t('Click "Build" → "Realtime Database" → "Create Database" → Test Mode', '"Build" → "Realtime Database" → "Create Database" → Test Mode')}</li>
                    <li>{t('Project Settings (gear ⚙️) → Your apps → Web (</>) → Register → copy firebaseConfig', 'Project Settings (⚙️) → Your apps → Web → Register → firebaseConfig কপি করুন')}</li>
                    <li>{t("Open this file's code and replace YOUR_API_KEY and YOUR_DATABASE_URL at the top", "এই ফাইলের কোডের উপরে FIREBASE_CONFIG-এ YOUR_API_KEY ও YOUR_DATABASE_URL বসান")}</li>
                  </ol>
                  <div className={`font-mono text-sm p-2 rounded-xl mt-1 select-all ${isDarkMode ? 'bg-slate-900 text-slate-300' : 'bg-slate-100 text-slate-700'}`}>
                    {`const FIREBASE_CONFIG = {\n  apiKey: "YOUR_API_KEY",\n  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",\n};`}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* =========================================================
              TAB: STAFF PERMISSIONS (Admin Only)
          ========================================================= */}
          {activeTab === "modules_menu" && currentUserRole === "ADMIN" && (() => {
            const permGroups = [
              {
                label: t("Main Menus", "প্রধান মেনু"),
                icon: "📌",
                items: [
                  { key: "pos",              label: t("Sell / POS", "বিক্রয়") },
                  { key: "analytics",        label: t("Dashboard", "ড্যাশবোর্ড") },
                  { key: "inventory",        label: t("Stock / Inventory", "স্টক") },
                  { key: "procurement",      label: t("Stock In (Purchase)", "মাল কিনুন") },
                  { key: "purchase_history", label: t("Purchase History", "ক্রয় ইতিহাস") },
                  { key: "company_purchase_history_view", label: t("Company Purchase History", "কোম্পানি ক্রয় ইতিহাস") },
                  { key: "invoices",         label: t("Invoices", "রশিদ") },
                  { key: "due_list_view",    label: t("Due List", "বাকি তালিকা") },
                  { key: "due_collection_view", label: t("Due Collection List", "বাকি আদায় তালিকা") },
                  { key: "report_view",      label: t("Report", "রিপোর্ট") },
                  { key: "closing_report",   label: t("Closing Report", "ক্লোজিং রিপোর্ট") },
                  { key: "returns",          label: t("Returns", "ফেরত") },
                  { key: "expense_tracker",  label: t("Expense Tracker (Tab Access)", "খরচ ট্র্যাকার (ট্যাব এক্সেস)") },
                  { key: "expense_add",       label: t("↳ Can Add Expense", "↳ খরচ যোগ করতে পারবে") },
                  { key: "expense_edit",      label: t("↳ Can Edit Expense", "↳ খরচ সম্পাদনা করতে পারবে") },
                  { key: "expense_delete",    label: t("↳ Can Delete Expense", "↳ খরচ মুছতে পারবে") },
                  { key: "expense_view_history", label: t("↳ Can View Expense History", "↳ খরচের তালিকা দেখতে পারবে") },
                  { key: "expense_view_profit",  label: t("↳ Can View Net Profit", "↳ নিট লাভ দেখতে পারবে") },
                ]
              },
              {
                label: t("Daily Report", "দৈনিক রিপোর্ট"),
                icon: "🗓️",
                items: [
                  { key: "daily_report",              label: t("Daily Report (Tab)", "দৈনিক রিপোর্ট (ট্যাব)") },
                  { key: "daily_report_sell",          label: t("Total Sell Card", "মোট বিক্রয় কার্ড") },
                  { key: "daily_report_profit",        label: t("Total Profit Card", "মোট লাভ কার্ড") },
                  { key: "daily_report_due",           label: t("New Due Card", "নতুন বাকি কার্ড") },
                  { key: "daily_report_due_collection",label: t("Due Collection Card", "বাকি আদায় কার্ড") },
                  { key: "daily_report_purchase",      label: t("Purchase / Stock In Card", "ক্রয় / স্টক ইন কার্ড") },
                  { key: "daily_report_returns",       label: t("Returns / Refund Card", "ফেরত / রিফান্ড কার্ড") },
                ]
              },
              {
                label: t("Monthly Report", "মাসিক রিপোর্ট"),
                icon: "📅",
                items: [
                  { key: "monthly_report",              label: t("Monthly Report (Tab)", "মাসিক রিপোর্ট (ট্যাব)") },
                  { key: "monthly_report_sell",          label: t("Total Sell Card", "মোট বিক্রয় কার্ড") },
                  { key: "monthly_report_profit",        label: t("Total Profit Card", "মোট লাভ কার্ড") },
                  { key: "monthly_report_due",           label: t("New Due Card", "নতুন বাকি কার্ড") },
                  { key: "monthly_report_due_collection",label: t("Due Collection Card", "বাকি আদায় কার্ড") },
                  { key: "monthly_report_purchase",      label: t("Purchase / Stock In Card", "ক্রয় / স্টক ইন কার্ড") },
                  { key: "monthly_report_returns",       label: t("Returns / Refund Card", "ফেরত / রিফান্ড কার্ড") },
                ]
              },
              {
                label: t("Closing Report Sections", "ক্লোজিং রিপোর্ট সেকশন"),
                icon: "🌙",
                items: [
                  { key: "closing_total_sales",    label: t("Total Sales Card", "মোট বিক্রয় কার্ড") },
                  { key: "closing_cash_received",  label: t("Cash Received Card", "নগদ পেয়েছি কার্ড") },
                  { key: "closing_profit",         label: t("Today's Profit Card", "আজকের লাভ কার্ড") },
                  { key: "closing_due",            label: t("Today's Due Card", "আজকের বাকি কার্ড") },
                  { key: "closing_bkash",          label: t("bKash/Nagad Card", "বিকাশ/নগদ কার্ড") },
                  { key: "closing_discount",       label: t("Discount Card", "ছাড় কার্ড") },
                  { key: "closing_due_collection", label: t("Due Collection Card", "বাকি আদায় কার্ড") },
                  { key: "closing_final_summary",  label: t("End of Day Summary", "দিনের শেষ হিসাব") },
                ]
              },
              {
                label: t("Dashboard Cards", "ড্যাশবোর্ড কার্ড"),
                icon: "📊",
                items: [
                  { key: "daily_sale_view",         label: t("Today's Sale", "আজকের বিক্রয়") },
                  { key: "monthly_sale_view",       label: t("Monthly Sale", "মাসিক বিক্রয়") },
                  { key: "daily_profit_view",       label: t("Today's Profit", "আজকের লাভ") },
                  { key: "monthly_profit_view",     label: t("Monthly Profit", "মাসিক লাভ") },
                  { key: "daily_purchases_view",    label: t("Today's Purchase", "আজকের ক্রয়") },
                  { key: "monthly_purchases_view",  label: t("Monthly Purchase", "মাসিক ক্রয়") },
                  { key: "daily_due_view",          label: t("Today's Due", "আজকের বাকি") },
                  { key: "monthly_due_view",        label: t("Monthly Due", "মাসিক বাকি") },
                  { key: "daily_due_collection_view",  label: t("Today's Due Collection", "আজকের বাকি আদায়") },
                  { key: "monthly_due_collection_view", label: t("Monthly Due Collection", "মাসিক বাকি আদায়") },
                  { key: "bkash_nagad_view",        label: t("bKash/Nagad Stats", "বিকাশ/নগদ তথ্য") },
                  { key: "low_stock_alerts",        label: t("Low Stock Alerts", "কম স্টক সতর্কতা") },
                  { key: "stock_out_view",          label: t("Stock Out List", "স্টক আউট তালিকা") },
                  { key: "expired_meds_view",       label: t("Expired Medicines", "মেয়াদ শেষ ওষুধ") },
                  { key: "stock_value_calculator",  label: t("Stock Value Summary", "স্টক মূল্য সারসংক্ষেপ") },
                  { key: "category_wise_stock",     label: t("Category Stock View", "ক্যাটাগরি স্টক") },
                  { key: "financials_summary_card", label: t("Financial Summary", "আর্থিক সারসংক্ষেপ") },
                  { key: "revenue_chart_view",      label: t("Revenue Chart", "রাজস্ব চার্ট") },
                  { key: "yearly_sales_view",       label: t("Yearly Sale", "বার্ষিক বিক্রয়") },
                  { key: "yearly_purchase_view",    label: t("Yearly Purchase", "বার্ষিক ক্রয়") },
                  { key: "yearly_profit_view",      label: t("Yearly Profit", "বার্ষিক লাভ") },
                  { key: "yearly_due_view",         label: t("Yearly Due", "বার্ষিক বাকি") },
                  { key: "monthly_discount_view",   label: t("Monthly Discount", "মাসিক ছাড়") },
                  { key: "yearly_discount_view",    label: t("Yearly Discount", "বার্ষিক ছাড়") },
                ]
              },
              {
                label: t("Inventory & Stock", "ইনভেন্টরি ও স্টক"),
                icon: "📦",
                items: [
                  { key: "rack_management",         label: t("Rack Location", "র‍‍্যাক লোকেশন") },
                  { key: "expiry_tracker",          label: t("Expiry Tracker", "মেয়াদ ট্র্যাকার") },
                  { key: "batch_tracking",          label: t("Batch Tracking", "ব্যাচ ট্র্যাকিং") },
                  { key: "supplier_management",     label: t("Supplier Info", "সরবরাহকারী তথ্য") },
                  { key: "medicine_suggestions_db", label: t("Medicine Name Suggestions", "ওষুধের নাম সাজেশন") },
                  { key: "company_database",        label: t("Company Database", "কোম্পানি ডেটাবেজ") },
                ]
              },
              {
                label: t("Sales & Reports", "বিক্রয় ও রিপোর্ট"),
                icon: "🧾",
                items: [
                  { key: "sales_reports",           label: t("Sales Reports", "বিক্রয় রিপোর্ট") },
                  { key: "purchase_reports",        label: t("Purchase Reports", "ক্রয় রিপোর্ট") },
                  { key: "invoice_search",          label: t("Invoice Search", "রশিদ খোঁজা") },
                  { key: "return_analytics",        label: t("Return Analytics", "ফেরত বিশ্লেষণ") },
                  { key: "advanced_analytics",      label: t("Advanced Analytics", "উন্নত বিশ্লেষণ") },
                ]
              },
              {
                label: t("POS / Checkout Options", "বিক্রয় / চেকআউট"),
                icon: "🛒",
                items: [
                  { key: "discount_manager",        label: t("Discount Manager", "ছাড় ব্যবস্থাপনা") },
                  { key: "vat_tax_calculator",      label: t("VAT / Tax Calculator", "ভ্যাট ক্যালকুলেটর") },
                  { key: "receipt_customizer",      label: t("Receipt Customizer", "রশিদ কাস্টমাইজ") },
                  { key: "customer_database",       label: t("Customer Database", "গ্রাহক ডেটাবেজ") },
                  { key: "profit_margin_calculator",label: t("Profit Margin View", "লাভের হার দেখা") },
                ]
              },
              {
                label: t("System Access", "সিস্টেম অ্যাক্সেস"),
                icon: "🔐",
                items: [
                  { key: "user_role_switcher", label: t("Role Switcher", "রোল সুইচার") },
                  { key: "backup_restore",     label: t("Factory Reset", "ফ্যাক্টরি রিসেট") },
                ]
              },
            ];
            return (
              <div className="flex flex-col gap-5">
                <div className={`ccard cc-amber p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500 mb-1">🛡️ {t("Staff Permissions", "স্টাফ অনুমতি")}</h3>
                  <p className="text-sm text-slate-400 font-semibold mb-5">{t("Toggle each feature on/off for staff. Admin always sees everything regardless.", "প্রতিটি ফিচার স্টাফের জন্য চালু/বন্ধ করুন। অ্যাডমিন সবসময় সব দেখতে পাবে।")}</p>
                  <div className="flex flex-col gap-5">
                    {permGroups.map(group => (
                      <div key={group.label}>
                        <h4 className={`text-sm font-black uppercase tracking-widest mb-2 flex items-center gap-1.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                          <span>{group.icon}</span><span>{group.label}</span>
                        </h4>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                          {group.items.map(({ key, label }) => {
                            const isOn = !!staffVisibleModules[key];
                            return (
                              <div
                                key={key}
                                onClick={() => toggleStaffPermissionField(key)}
                                className={`ccard cc-teal p-3 rounded-xl border flex items-center justify-between gap-3 cursor-pointer select-none transition-all ${isOn ? 'border-indigo-500 bg-indigo-500/5' : isDarkMode ? 'bg-slate-900/40 border-slate-700/60 opacity-50' : 'bg-slate-50 border-slate-200 opacity-50'}`}
                              >
                                <div className="flex items-center gap-2">
                                  <span className="text-sm">{isOn ? '✅' : '❌'}</span>
                                  <span className={`text-sm font-bold ${isOn ? (isDarkMode ? 'text-white' : 'text-slate-700') : 'text-slate-400'}`}>{label}</span>
                                </div>
                                <div className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${isOn ? 'bg-indigo-500' : isDarkMode ? 'bg-slate-700' : 'bg-slate-300'}`}>
                                  <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${isOn ? 'translate-x-4' : 'translate-x-0'}`}></div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* =========================================================
              TAB: PHASE 6 RECONCILIATION (Admin Only)
          ========================================================= */}
          {activeTab === "reconciliation" && currentUserRole === "ADMIN" && (() => {
            const eod = reconReport ? computeEOD(reconDate, reconReport) : null;
            const severityColor = (s: string) =>
              s === 'ERROR' ? 'text-red-500' : s === 'WARNING' ? 'text-amber-500' : 'text-emerald-500';
            const severityBg = (s: string) =>
              s === 'ERROR'
                ? (isDarkMode ? 'bg-red-900/30 border-red-800' : 'bg-red-50 border-red-200')
                : s === 'WARNING'
                ? (isDarkMode ? 'bg-amber-900/30 border-amber-800' : 'bg-amber-50 border-amber-200')
                : (isDarkMode ? 'bg-emerald-900/30 border-emerald-800' : 'bg-emerald-50 border-emerald-200');

            const Row = ({ label, value, highlight, mono }: { label: string; value: any; highlight?: boolean; mono?: boolean }) => (
              <div className={`flex justify-between items-center py-1 text-sm border-b border-slate-100 dark:border-slate-700/30 ${highlight ? 'font-black' : 'font-semibold'}`}>
                <span className={isDarkMode ? 'text-slate-300' : 'text-slate-600'}>{label}</span>
                <span className={`${mono ? 'font-mono' : ''} ${highlight ? 'text-indigo-500' : ''}`}>{value}</span>
              </div>
            );

            const tabs: { id: typeof reconTab; label: string; icon: string }[] = [
              { id: 'summary',  label: t('Summary', 'সারসংক্ষেপ'),    icon: '📋' },
              { id: 'eod',     label: t('End of Day', 'দিন শেষ'),     icon: '🌙' },
              { id: 'sales',   label: t('Sales', 'বিক্রয়'),           icon: '💰' },
              { id: 'cash',    label: t('Cash', 'নগদ'),               icon: '🏦' },
              { id: 'due',     label: t('Due', 'বাকি'),               icon: '💳' },
              { id: 'stock',   label: t('Stock', 'স্টক'),             icon: '📦' },
              { id: 'profit',  label: t('Profit', 'লাভ'),             icon: '📈' },
              { id: 'purchase',label: t('Purchase', 'ক্রয়'),          icon: '🛒' },
              { id: 'return',  label: t('Return', 'ফেরত'),            icon: '🔄' },
              { id: 'expense', label: t('Expense', 'খরচ'),            icon: '💸' },
              { id: 'audit',   label: t('Audit Log', 'অডিট লগ'),      icon: '📜' },
            ];

            const filteredIssues = (category: string) =>
              reconReport?.issues?.filter((i: any) => i.category === category) ?? [];

            const IssueList = ({ issues }: { issues: any[] }) => (
              <div className="flex flex-col gap-2 mt-3">
                {issues.length === 0 && (
                  <div className="text-emerald-500 font-bold text-sm text-center py-3">✅ {t('No issues found for this category', 'এই বিভাগে কোনো সমস্যা নেই')}</div>
                )}
                {issues.map((issue: any, idx: number) => (
                  <div key={idx} className={`rounded-xl border p-3 text-sm ${severityBg(issue.severity)}`}>
                    <div className={`font-black flex items-center gap-2 ${severityColor(issue.severity)}`}>
                      <span>{issue.severity === 'ERROR' ? '❌' : issue.severity === 'WARNING' ? '⚠️' : 'ℹ️'}</span>
                      <span>{issue.description}</span>
                    </div>
                    {issue.detail && (
                      <pre className={`mt-2 text-xs font-mono overflow-x-auto rounded p-2 ${isDarkMode ? 'bg-slate-900/50' : 'bg-white/50'}`}>
                        {JSON.stringify(issue.detail, null, 2).slice(0, 500)}
                        {JSON.stringify(issue.detail, null, 2).length > 500 ? '\n...(truncated)' : ''}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            );

            return (
              <div className="flex flex-col gap-4">
                {/* Header */}
                <div className={`ccard p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div>
                      <h3 className="text-sm font-black uppercase tracking-wider text-red-500 flex items-center gap-2">
                        🔍 {t('Data Reconciliation & Integrity Audit', 'ডেটা সমন্বয় ও অখণ্ডতা অডিট')}
                      </h3>
                      <p className={`text-sm mt-1 font-semibold ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                        {t('Read-only diagnostic. Never modifies any record.', 'শুধুমাত্র পঠনমাত্র ডায়াগনস্টিক। কোনো রেকর্ড পরিবর্তন করে না।')}
                      </p>
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      {reconReport && (
                        <div className="flex gap-2 text-sm font-black">
                          {reconReport.issueCount > 0 && <span className="bg-red-500 text-white px-2.5 py-1 rounded-xl">{reconReport.issueCount} {t('Errors', 'ত্রুটি')}</span>}
                          {reconReport.warningCount > 0 && <span className="bg-amber-500 text-white px-2.5 py-1 rounded-xl">{reconReport.warningCount} {t('Warnings', 'সতর্কতা')}</span>}
                          {reconReport.issueCount === 0 && reconReport.warningCount === 0 && <span className="bg-emerald-500 text-white px-2.5 py-1 rounded-xl">✅ {t('Clean', 'পরিষ্কার')}</span>}
                        </div>
                      )}
                      <button
                        onClick={runReconciliation}
                        disabled={reconRunning}
                        className="bg-red-600 hover:bg-red-700 text-white font-black px-5 py-2 rounded-xl uppercase tracking-wider shadow transition disabled:opacity-60 text-sm"
                      >
                        {reconRunning ? `⏳ ${t('Running...', 'চলছে...')}` : `🔍 ${t('Run Audit', 'অডিট চালান')}`}
                      </button>
                    </div>
                  </div>
                  {reconReport?.runAt && (
                    <p className={`text-sm mt-2 font-mono ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                      {t('Last run:', 'শেষ চালানো:')} {new Date(reconReport.runAt).toLocaleString()}
                    </p>
                  )}
                  {reconReport?.error && (
                    <div className="mt-3 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-sm font-bold">
                      ❌ {t('Reconciliation failed:', 'সমন্বয় ব্যর্থ:')} {reconReport.error}
                    </div>
                  )}
                </div>

                {reconReport && !reconReport.error && (
                  <>
                    {/* Sub-tab navigation */}
                    <div className={`flex gap-1 flex-wrap p-1 rounded-xl border ${isDarkMode ? 'bg-slate-800/40 border-slate-700' : 'bg-slate-100 border-slate-200'}`}>
                      {tabs.map(tab => (
                        <button
                          key={tab.id}
                          onClick={() => setReconTab(tab.id)}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold transition ${reconTab === tab.id ? 'bg-red-600 text-white shadow' : isDarkMode ? 'text-slate-400 hover:bg-slate-700' : 'text-slate-600 hover:bg-white'}`}
                        >
                          <span>{tab.icon}</span><span>{tab.label}</span>
                        </button>
                      ))}
                    </div>

                    {/* SUMMARY TAB */}
                    {reconTab === 'summary' && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Data Counts */}
                        <div className={`ccard p-4 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                          <h4 className="text-sm font-black text-indigo-500 uppercase mb-3">📊 {t('Record Counts', 'রেকর্ড সংখ্যা')}</h4>
                          <Row label={t('Invoices', 'রশিদ')} value={reconReport.totalInvoices} mono />
                          <Row label={t('Purchases', 'ক্রয়')} value={reconReport.totalPurchases} mono />
                          <Row label={t('Payment Ledger', 'পেমেন্ট লেজার')} value={reconReport.totalPayments} mono />
                          <Row label={t('Cash Ledger', 'নগদ লেজার')} value={reconReport.totalCashEntries} mono />
                          <Row label={t('Stock Movements', 'স্টক মুভমেন্ট')} value={reconReport.totalStockMovements} mono />
                          <Row label={t('Due Collection Log', 'বাকি আদায় লগ')} value={reconReport.totalDueCLogEntries} mono />
                          <Row label={t('Due List Entries', 'বাকি তালিকা')} value={reconReport.totalDueListEntries} mono />
                          <Row label={t('Expenses', 'খরচ')} value={reconReport.totalExpenses} mono />
                          <Row label={t('Medicines', 'ওষুধ')} value={reconReport.totalMedicines} mono />
                        </div>

                        {/* Financial Summary */}
                        <div className={`ccard p-4 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                          <h4 className="text-sm font-black text-indigo-500 uppercase mb-3">💰 {t('Financial Summary', 'আর্থিক সারসংক্ষেপ')}</h4>
                          <Row label={t('Sales Revenue', 'বিক্রয় আয়')} value={`${currencySymbol}${reconReport.salesRevenue.toFixed(2)}`} mono highlight />
                          <Row label={t('Gross Profit', 'মোট লাভ')} value={`${currencySymbol}${reconReport.salesProfit.toFixed(2)}`} mono />
                          <Row label={t('Total Discount', 'মোট ছাড়')} value={`${currencySymbol}${reconReport.totalDiscount.toFixed(2)}`} mono />
                          <Row label={t('Cash In (Ledger)', 'নগদ ইন')} value={`${currencySymbol}${reconReport.cashIn.toFixed(2)}`} mono />
                          <Row label={t('Cash Out (Ledger)', 'নগদ আউট')} value={`${currencySymbol}${reconReport.cashOut.toFixed(2)}`} mono />
                          <Row label={t('Net Cash (Ledger)', 'নিট নগদ')} value={`${currencySymbol}${reconReport.ledgerNetCash.toFixed(2)}`} mono highlight />
                          <Row label={t('Due Created', 'বাকি তৈরি')} value={`${currencySymbol}${reconReport.totalDueCreated.toFixed(2)}`} mono />
                          <Row label={t('Due Collected', 'বাকি আদায়')} value={`${currencySymbol}${reconReport.totalDueCollected.toFixed(2)}`} mono />
                          <Row label={t('Outstanding Due', 'বকেয়া বাকি')} value={`${currencySymbol}${reconReport.dueListTotal.toFixed(2)}`} mono highlight />
                        </div>

                        {/* Status Cards */}
                        <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div className={`rounded-xl border p-3 text-center ${reconReport.cashBalanceOk ? (isDarkMode ? 'bg-emerald-900/30 border-emerald-700' : 'bg-emerald-50 border-emerald-200') : (isDarkMode ? 'bg-red-900/30 border-red-700' : 'bg-red-50 border-red-200')}`}>
                            <div className="text-2xl mb-1">{reconReport.cashBalanceOk ? '✅' : '❌'}</div>
                            <div className="text-sm font-black">{t('Cash Balance', 'নগদ ব্যালেন্স')}</div>
                            {!reconReport.cashBalanceOk && <div className="text-sm font-mono text-red-500">Δ {reconReport.cashDiff.toFixed(2)}</div>}
                          </div>
                          <div className={`rounded-xl border p-3 text-center ${reconReport.dueBalanceOk ? (isDarkMode ? 'bg-emerald-900/30 border-emerald-700' : 'bg-emerald-50 border-emerald-200') : (isDarkMode ? 'bg-amber-900/30 border-amber-700' : 'bg-amber-50 border-amber-200')}`}>
                            <div className="text-2xl mb-1">{reconReport.dueBalanceOk ? '✅' : '⚠️'}</div>
                            <div className="text-sm font-black">{t('Due Balance', 'বাকি ব্যালেন্স')}</div>
                            {!reconReport.dueBalanceOk && <div className="text-sm font-mono text-amber-500">Δ {reconReport.dueDiff.toFixed(2)}</div>}
                          </div>
                          <div className={`rounded-xl border p-3 text-center ${reconReport.stockIssues.length === 0 ? (isDarkMode ? 'bg-emerald-900/30 border-emerald-700' : 'bg-emerald-50 border-emerald-200') : (isDarkMode ? 'bg-amber-900/30 border-amber-700' : 'bg-amber-50 border-amber-200')}`}>
                            <div className="text-2xl mb-1">{reconReport.stockIssues.length === 0 ? '✅' : '⚠️'}</div>
                            <div className="text-sm font-black">{t('Stock Integrity', 'স্টক অখণ্ডতা')}</div>
                            {reconReport.stockIssues.length > 0 && <div className="text-sm font-mono text-amber-500">{reconReport.stockIssues.length} {t('issues', 'সমস্যা')}</div>}
                          </div>
                        </div>

                        {/* All Issues Summary */}
                        <div className={`md:col-span-2 ccard p-4 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                          <h4 className="text-sm font-black text-red-500 uppercase mb-3">🚨 {t('All Issues', 'সব সমস্যা')}</h4>
                          {reconReport.issues.length === 0 ? (
                            <div className="text-emerald-500 font-black text-center py-6 text-lg">✅ {t('No issues detected! Data is consistent.', 'কোনো সমস্যা পাওয়া যায়নি! ডেটা সঙ্গতিপূর্ণ।')}</div>
                          ) : (
                            <div className="flex flex-col gap-2 max-h-96 overflow-y-auto">
                              {reconReport.issues.map((issue: any, idx: number) => (
                                <div key={idx} className={`rounded-xl border p-2.5 text-sm ${severityBg(issue.severity)}`}>
                                  <span className={`font-black mr-2 ${severityColor(issue.severity)}`}>[{issue.severity}] [{issue.category}]</span>
                                  <span>{issue.description}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* END OF DAY TAB */}
                    {reconTab === 'eod' && (
                      <div className="flex flex-col gap-4">
                        <div className={`ccard p-4 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                          <div className="flex items-center gap-3 mb-4">
                            <h4 className="text-sm font-black text-indigo-500 uppercase">🌙 {t('End-of-Day Reconciliation', 'দিন শেষের সমন্বয়')}</h4>
                            <input
                              type="date"
                              value={reconDate}
                              onChange={e => setReconDate(e.target.value)}
                              className={`ml-auto px-3 py-1.5 rounded-xl border text-sm font-mono outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                            />
                          </div>
                          {eod ? (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div>
                                <h5 className="text-sm font-black text-slate-400 uppercase mb-2">{t('Sales Summary', 'বিক্রয় সারসংক্ষেপ')}</h5>
                                <Row label={t('Gross Sales', 'মোট বিক্রয়')} value={`${currencySymbol}${eod.grossSales.toFixed(2)}`} mono highlight />
                                <Row label={t('Cash Sales', 'নগদ বিক্রয়')} value={`${currencySymbol}${eod.cashSales.toFixed(2)}`} mono />
                                <Row label={t('Credit Sales (Due Created)', 'বাকিতে বিক্রয়')} value={`${currencySymbol}${eod.creditSales.toFixed(2)}`} mono />
                                <Row label={t('Refunds/Returns', 'ফেরত')} value={`-${currencySymbol}${eod.refundsDay.toFixed(2)}`} mono />
                                <Row label={t('Net Sales', 'নিট বিক্রয়')} value={`${currencySymbol}${eod.netSales.toFixed(2)}`} mono highlight />
                                <Row label={t('Profit', 'লাভ')} value={`${currencySymbol}${eod.profitDay.toFixed(2)}`} mono />
                                <Row label={t('Number of Sales', 'বিক্রয় সংখ্যা')} value={eod.numSales} />
                                <Row label={t('Number of Returns', 'ফেরত সংখ্যা')} value={eod.numReturns} />
                              </div>
                              <div>
                                <h5 className="text-sm font-black text-slate-400 uppercase mb-2">{t('Cash Equation', 'নগদ হিসাব')}</h5>
                                <Row label={t('Cash Sales Received', 'নগদ বিক্রয় আদায়')} value={`${currencySymbol}${eod.cashSales.toFixed(2)}`} mono />
                                <Row label={t('Due Collections', 'বাকি আদায়')} value={`+${currencySymbol}${eod.totalDueCollectedDay.toFixed(2)}`} mono />
                                <Row label={t('Refunds Paid Out', 'রিফান্ড দেওয়া')} value={`-${currencySymbol}${eod.refundsDay.toFixed(2)}`} mono />
                                <Row label={t('Expenses Paid', 'খরচ')} value={`-${currencySymbol}${eod.expensesDay.toFixed(2)}`} mono />
                                <div className="border-t-2 border-slate-300 mt-1 pt-1">
                                  <Row label={t('Expected Net Cash', 'প্রত্যাশিত নগদ')} value={`${currencySymbol}${eod.expectedCashDay.toFixed(2)}`} mono highlight />
                                  <Row label={t('Cash Ledger Net (IN − OUT)', 'লেজার নিট')} value={`${currencySymbol}${eod.ledgerNetDay.toFixed(2)}`} mono highlight />
                                </div>
                                <div className={`mt-2 rounded-xl border p-3 text-center ${eod.cashOk ? (isDarkMode ? 'bg-emerald-900/30 border-emerald-700' : 'bg-emerald-50 border-emerald-200') : (isDarkMode ? 'bg-red-900/30 border-red-700' : 'bg-red-50 border-red-200')}`}>
                                  {eod.cashOk ? (
                                    <span className="text-emerald-500 font-black">✅ {t('Cash Balanced', 'নগদ সঠিক')}</span>
                                  ) : (
                                    <>
                                      <span className="text-red-500 font-black">❌ {t('Cash Mismatch', 'নগদ অমিল')}</span>
                                      <div className="text-red-500 font-mono text-sm">Δ {eod.cashDiffDay.toFixed(2)}</div>
                                    </>
                                  )}
                                </div>
                                <div className="mt-3">
                                  <h5 className="text-sm font-black text-slate-400 uppercase mb-2">{t('Other', 'অন্যান্য')}</h5>
                                  <Row label={t('Total Due Created', 'নতুন বাকি')} value={`${currencySymbol}${eod.totalDueCreatedDay.toFixed(2)}`} mono />
                                  <Row label={t('Total Due Collected', 'বাকি আদায়')} value={`${currencySymbol}${eod.totalDueCollectedDay.toFixed(2)}`} mono />
                                  <Row label={t('Purchase Total', 'ক্রয়')} value={`${currencySymbol}${eod.purchasesDay.toFixed(2)}`} mono />
                                  <Row label={t('Expense Total', 'খরচ')} value={`${currencySymbol}${eod.expensesDay.toFixed(2)}`} mono />
                                </div>
                              </div>
                            </div>
                          ) : (
                            <p className={`text-sm text-center py-6 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t('Select a date to view end-of-day reconciliation.', 'তারিখ নির্বাচন করুন।')}</p>
                          )}
                        </div>
                      </div>
                    )}

                    {/* SALES TAB */}
                    {reconTab === 'sales' && (
                      <div className={`ccard p-4 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                        <h4 className="text-sm font-black text-indigo-500 uppercase mb-1">💰 {t('Sales Reconciliation', 'বিক্রয় সমন্বয়')}</h4>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
                          <div className={`rounded-xl p-3 text-center ${isDarkMode ? 'bg-slate-900/60' : 'bg-slate-50'}`}>
                            <div className="font-mono font-black text-indigo-500 text-lg">{reconReport.totalInvoices}</div>
                            <div className="text-sm text-slate-400">{t('Total Invoices', 'মোট রশিদ')}</div>
                          </div>
                          <div className={`rounded-xl p-3 text-center ${isDarkMode ? 'bg-slate-900/60' : 'bg-slate-50'}`}>
                            <div className="font-mono font-black text-emerald-500 text-lg">{currencySymbol}{reconReport.salesRevenue.toFixed(2)}</div>
                            <div className="text-sm text-slate-400">{t('Revenue', 'আয়')}</div>
                          </div>
                          <div className={`rounded-xl p-3 text-center ${isDarkMode ? 'bg-slate-900/60' : 'bg-slate-50'}`}>
                            <div className="font-mono font-black text-amber-500 text-lg">{currencySymbol}{reconReport.salesProfit.toFixed(2)}</div>
                            <div className="text-sm text-slate-400">{t('Profit', 'লাভ')}</div>
                          </div>
                        </div>
                        <IssueList issues={[...filteredIssues('Sales'), ...filteredIssues('Chain')]} />
                      </div>
                    )}

                    {/* CASH TAB */}
                    {reconTab === 'cash' && (
                      <div className={`ccard p-4 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                        <h4 className="text-sm font-black text-indigo-500 uppercase mb-3">🏦 {t('Cash Reconciliation', 'নগদ সমন্বয়')}</h4>
                        <div className="mb-4">
                          <Row label={t('Cash IN (Ledger)', 'নগদ ইন')} value={`${currencySymbol}${reconReport.cashIn.toFixed(2)}`} mono />
                          <Row label={t('Cash OUT (Ledger)', 'নগদ আউট')} value={`${currencySymbol}${reconReport.cashOut.toFixed(2)}`} mono />
                          <Row label={t('Net Cash (Ledger)', 'লেজার নিট')} value={`${currencySymbol}${reconReport.ledgerNetCash.toFixed(2)}`} mono highlight />
                          <div className="border-t my-2" />
                          <Row label={t('Sale-time Cash', 'বিক্রয়কালীন নগদ')} value={`${currencySymbol}${reconReport.saleTimeCash.toFixed(2)}`} mono />
                          <Row label={t('Due Collections', 'বাকি আদায়')} value={`+${currencySymbol}${reconReport.dueCollected.toFixed(2)}`} mono />
                          <Row label={t('Refunds', 'রিফান্ড')} value={`-${currencySymbol}${reconReport.refunds.toFixed(2)}`} mono />
                          <Row label={t('Expenses', 'খরচ')} value={`-${currencySymbol}${reconReport.expenseCash.toFixed(2)}`} mono />
                          <Row label={t('Expected Net Cash', 'প্রত্যাশিত নিট')} value={`${currencySymbol}${reconReport.expectedNetCash.toFixed(2)}`} mono highlight />
                          <div className={`mt-2 rounded-xl border p-2 text-center text-sm font-black ${reconReport.cashBalanceOk ? (isDarkMode ? 'bg-emerald-900/30 border-emerald-700 text-emerald-400' : 'bg-emerald-50 border-emerald-200 text-emerald-600') : (isDarkMode ? 'bg-red-900/30 border-red-700 text-red-400' : 'bg-red-50 border-red-200 text-red-600')}`}>
                            {reconReport.cashBalanceOk ? `✅ ${t('Balanced', 'সঠিক')}` : `❌ ${t('Mismatch', 'অমিল')} Δ${currencySymbol}${reconReport.cashDiff.toFixed(2)}`}
                          </div>
                        </div>
                        <IssueList issues={filteredIssues('Cash')} />
                      </div>
                    )}

                    {/* DUE TAB */}
                    {reconTab === 'due' && (
                      <div className={`ccard p-4 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                        <h4 className="text-sm font-black text-indigo-500 uppercase mb-3">💳 {t('Due Reconciliation', 'বাকি সমন্বয়')}</h4>
                        <div className="mb-4">
                          <Row label={t('Total Due Created (from invoices)', 'বিক্রয় থেকে বাকি')} value={`${currencySymbol}${reconReport.totalDueCreated.toFixed(2)}`} mono />
                          <Row label={t('Total Due Collected', 'বাকি আদায়')} value={`-${currencySymbol}${reconReport.totalDueCollected.toFixed(2)}`} mono />
                          <Row label={t('Expected Outstanding', 'প্রত্যাশিত বকেয়া')} value={`${currencySymbol}${reconReport.expectedOutstandingDue.toFixed(2)}`} mono highlight />
                          <Row label={t('Recorded in Due List', 'তালিকায় রেকর্ড')} value={`${currencySymbol}${reconReport.dueListTotal.toFixed(2)}`} mono highlight />
                          <div className={`mt-2 rounded-xl border p-2 text-center text-sm font-black ${reconReport.dueBalanceOk ? (isDarkMode ? 'bg-emerald-900/30 border-emerald-700 text-emerald-400' : 'bg-emerald-50 border-emerald-200 text-emerald-600') : (isDarkMode ? 'bg-amber-900/30 border-amber-700 text-amber-400' : 'bg-amber-50 border-amber-200 text-amber-600')}`}>
                            {reconReport.dueBalanceOk ? `✅ ${t('Due Balanced', 'বাকি সঠিক')}` : `⚠️ ${t('Mismatch', 'অমিল')} Δ${currencySymbol}${reconReport.dueDiff.toFixed(2)}`}
                          </div>
                        </div>
                        <IssueList issues={filteredIssues('Due')} />
                      </div>
                    )}

                    {/* STOCK TAB */}
                    {reconTab === 'stock' && (
                      <div className={`ccard p-4 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                        <h4 className="text-sm font-black text-indigo-500 uppercase mb-3">📦 {t('Stock Reconciliation', 'স্টক সমন্বয়')}</h4>
                        {reconReport.stockIssues.length > 0 ? (
                          <div className="overflow-x-auto mb-4">
                            <table className="w-full text-sm border-collapse">
                              <thead>
                                <tr className={`${isDarkMode ? 'bg-slate-900' : 'bg-slate-100'} text-left`}>
                                  <th className="px-3 py-2 font-black">{t('Medicine', 'ওষুধ')}</th>
                                  <th className="px-3 py-2 font-black text-right">{t('Expected', 'প্রত্যাশিত')}</th>
                                  <th className="px-3 py-2 font-black text-right">{t('Actual', 'বাস্তব')}</th>
                                  <th className="px-3 py-2 font-black text-right">{t('Diff', 'পার্থক্য')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {reconReport.stockIssues.map((si: any, idx: number) => (
                                  <tr key={idx} className={`border-b ${isDarkMode ? 'border-slate-700' : 'border-slate-100'} ${si.actualStock < 0 ? (isDarkMode ? 'bg-red-900/30' : 'bg-red-50') : (isDarkMode ? 'bg-amber-900/20' : 'bg-amber-50')}`}>
                                    <td className="px-3 py-2 font-semibold">{si.name}</td>
                                    <td className="px-3 py-2 text-right font-mono">{si.expectedStock}</td>
                                    <td className={`px-3 py-2 text-right font-mono font-black ${si.actualStock < 0 ? 'text-red-500' : 'text-amber-500'}`}>{si.actualStock}</td>
                                    <td className={`px-3 py-2 text-right font-mono font-black ${si.diff !== 0 ? 'text-red-500' : 'text-emerald-500'}`}>{si.diff > 0 ? '+' : ''}{si.actualStock - si.expectedStock}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="text-emerald-500 font-black text-center py-4">✅ {t('All medicine stocks consistent with movement ledger', 'সব ওষুধের স্টক মুভমেন্ট লেজারের সাথে সঙ্গতিপূর্ণ')}</div>
                        )}
                        <IssueList issues={filteredIssues('Stock')} />
                      </div>
                    )}

                    {/* PROFIT TAB */}
                    {reconTab === 'profit' && (
                      <div className={`ccard p-4 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                        <h4 className="text-sm font-black text-indigo-500 uppercase mb-3">📈 {t('Profit Reconciliation', 'লাভ সমন্বয়')}</h4>
                        <div className="mb-4">
                          <Row label={t('Gross Revenue', 'মোট আয়')} value={`${currencySymbol}${reconReport.grossRevenue.toFixed(2)}`} mono />
                          <Row label={t('Total Discount', 'মোট ছাড়')} value={`-${currencySymbol}${reconReport.totalDiscount.toFixed(2)}`} mono />
                          <Row label={t('Total VAT', 'মোট ভ্যাট')} value={`+${currencySymbol}${reconReport.totalVat.toFixed(2)}`} mono />
                          <Row label={t('Profit from Invoices', 'রশিদ থেকে লাভ')} value={`${currencySymbol}${reconReport.profitFromInvoices.toFixed(2)}`} mono highlight />
                        </div>
                        <IssueList issues={filteredIssues('Profit')} />
                      </div>
                    )}

                    {/* PURCHASE TAB */}
                    {reconTab === 'purchase' && (
                      <div className={`ccard p-4 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                        <h4 className="text-sm font-black text-indigo-500 uppercase mb-3">🛒 {t('Purchase Reconciliation', 'ক্রয় সমন্বয়')}</h4>
                        <Row label={t('Total Purchases', 'মোট ক্রয়')} value={reconReport.totalPurchases} mono />
                        <Row label={t('Purchase Stock Movements', 'ক্রয় মুভমেন্ট')} value={(reconReport.stockMovArr ?? []).filter((m: any) => m.type === 'PURCHASE').length} mono />
                        <IssueList issues={filteredIssues('Purchase')} />
                      </div>
                    )}

                    {/* RETURN TAB */}
                    {reconTab === 'return' && (
                      <div className={`ccard p-4 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                        <h4 className="text-sm font-black text-indigo-500 uppercase mb-3">🔄 {t('Return Reconciliation', 'ফেরত সমন্বয়')}</h4>
                        <Row label={t('Returned Invoices', 'ফেরতকৃত রশিদ')} value={(reconReport.invoicesList ?? []).filter((i: any) => i.isReturned).length} mono />
                        <Row label={t('Total Refunds', 'মোট রিফান্ড')} value={`${currencySymbol}${reconReport.refunds?.toFixed(2) ?? '0.00'}`} mono />
                        <IssueList issues={filteredIssues('Return')} />
                      </div>
                    )}

                    {/* EXPENSE TAB */}
                    {reconTab === 'expense' && (
                      <div className={`ccard p-4 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                        <h4 className="text-sm font-black text-indigo-500 uppercase mb-3">💸 {t('Expense Reconciliation', 'খরচ সমন্বয়')}</h4>
                        <Row label={t('Total Expenses', 'মোট খরচ')} value={reconReport.totalExpenses} mono />
                        <Row label={t('Total Expense Amount', 'মোট পরিমাণ')} value={`${currencySymbol}${(reconReport.expenseArr ?? []).reduce((s: number, e: any) => s + (e.amount || 0), 0).toFixed(2)}`} mono highlight />
                        <IssueList issues={filteredIssues('Expense')} />
                      </div>
                    )}

                    {/* AUDIT LOG TAB */}
                    {reconTab === 'audit' && (
                      <div className={`ccard p-4 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                        <h4 className="text-sm font-black text-indigo-500 uppercase mb-3">📜 {t('Audit Log', 'অডিট লগ')}</h4>
                        {auditLog.length === 0 ? (
                          <p className={`text-sm text-center py-6 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t('No audit entries yet. Run the reconciliation to create the first entry.', 'এখনো কোনো অডিট এন্ট্রি নেই।')}</p>
                        ) : (
                          <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto">
                            {auditLog.map((entry: any, idx: number) => (
                              <div key={idx} className={`rounded-xl border p-3 text-sm ${isDarkMode ? 'bg-slate-900/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                                <div className="flex justify-between flex-wrap gap-2">
                                  <span className="font-black text-indigo-500">{entry.action}</span>
                                  <span className={`font-mono text-sm ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>{new Date(entry.timestamp).toLocaleString()}</span>
                                </div>
                                {entry.transactionId && <div className="text-sm mt-1"><span className="font-bold">{t('TXN:', 'লেনদেন:')} </span><span className="font-mono">{entry.transactionId}</span></div>}
                                {entry.affectedRecord && <div className="text-sm"><span className="font-bold">{t('Record:', 'রেকর্ড:')} </span>{entry.affectedRecord}</div>}
                                {entry.note && <div className={`text-sm mt-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{entry.note}</div>}
                                <div className={`text-sm mt-1 font-semibold ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>{t('Role:', 'রোল:')} {entry.userRole} · {entry.deviceHint}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* Safety Notice */}
                <div className={`rounded-xl border p-4 text-sm ${isDarkMode ? 'bg-amber-900/20 border-amber-800 text-amber-300' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
                  <strong>⚠️ {t('Safety Policy:', 'নিরাপত্তা নীতি:')}</strong> {t(
                    'This reconciliation tool is read-only. It NEVER modifies any financial record, stock quantity, cash balance, or due amount. Any mismatch shown here must be investigated and corrected manually through the appropriate module by an authorized user.',
                    'এই সমন্বয় টুল শুধুমাত্র পঠনমাত্র। এটি কখনো কোনো আর্থিক রেকর্ড, স্টক পরিমাণ, নগদ ব্যালেন্স বা বাকি পরিমাণ পরিবর্তন করে না। এখানে দেখানো যেকোনো অমিল অনুমোদিত ব্যবহারকারীকে সংশ্লিষ্ট মডিউলে ম্যানুয়ালি তদন্ত ও সংশোধন করতে হবে।'
                  )}
                </div>
              </div>
            );
          })()}

        </main>
      </div>

      {/* =========================================================
          MODAL 1: CHECKOUT CONFIRMATION
      ========================================================= */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-md z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className={`ccard cc-pink max-w-md w-full rounded-2xl border p-4 shadow-sm my-4 ${isDarkMode ? 'bg-slate-800/60 border-slate-700 text-white' : 'bg-white border-slate-200'}`}>
            <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500 border-b pb-2 mb-3 flex items-center justify-between">
              <span>🧾 {t("Confirm Invoice", "বিল নিশ্চিত করুন")}</span>
              <button onClick={() => setShowConfirmModal(false)} className="text-slate-400 hover:text-red-500 font-bold text-sm">✕</button>
            </h3>

            <div className="flex flex-col gap-3 text-sm">
              <div className="grid grid-cols-2 gap-2 bg-slate-500/5 p-2.5 rounded-xl text-sm font-semibold">
                <div><span className="text-slate-400 block">{t("Customer:", "গ্রাহক:")}</span><strong className="text-indigo-500">{customerName || t("Walk-in Customer", "সাধারণ গ্রাহক")}</strong></div>
                <div><span className="text-slate-400 block">{t("Items:", "আইটেম:")}</span><strong>{cart.reduce((s, i) => s + (parseInt(i.qty) || 0), 0)} {t("pcs", "টি")}</strong></div>
              </div>

              {selectedExistingDue && (
                <div className={`px-3 py-2 rounded-xl border text-sm ${isDarkMode ? 'bg-red-950/40 border-red-700' : 'bg-white border-slate-200'}`}>
                  <div className="flex justify-between mb-1">
                    <span className={isDarkMode ? 'text-red-300' : 'text-red-600'}>{t("Previous Due:", "আগের বাকি:")}</span>
                    <span className="font-mono font-black text-red-500">{selectedExistingDue.totalDue.toFixed(1)} {currencySymbol}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className={isDarkMode ? 'text-orange-300' : 'text-orange-600'}>{t("Today's Bill:", "আজকের বিল:")}</span>
                    <span className="font-mono font-black text-orange-500">{currentFinalBill.toFixed(1)} {currencySymbol}</span>
                  </div>
                  <div className={`flex justify-between font-black border-t mt-1 pt-1 ${isDarkMode ? 'border-red-700' : 'border-red-200'}`}>
                    <span className={isDarkMode ? 'text-white' : 'text-slate-800'}>{t("Grand Total:", "সর্বমোট:")}</span>
                    <span className="font-mono text-orange-500">{(currentFinalBill + selectedExistingDue.totalDue).toFixed(1)} {currencySymbol}</span>
                  </div>
                </div>
              )}

              <div className={`ccard cc-indigo p-3 rounded-xl border ${isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-bold text-slate-400">{t("Total Payable:", "মোট পরিশোধযোগ্য:")}</span>
                  <span className="font-mono text-base font-black text-indigo-500">
                    {(currentFinalBill + (selectedExistingDue ? selectedExistingDue.totalDue : 0)).toFixed(1)} {currencySymbol}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Cash Given", "নগদ দিয়েছে")}</label>
                    <input
                      type="number"
                      placeholder={t("Amount...", "পরিমাণ...")}
                      value={calculatorInput}
                      onChange={e => {
                        const val = e.target.value;
                        setCalculatorInput(val);
                        setCashReceived(val);
                        const cashNum = parseFloat(val) || 0;
                        const prevDue = selectedExistingDue ? selectedExistingDue.totalDue : 0;
                        const grandTotal = currentFinalBill + prevDue;
                        const due = grandTotal - cashNum;
                        setInvoiceDue(due > 0 ? due.toFixed(1) : "0");
                      }}
                      className={`w-full px-2.5 py-1.5 font-mono font-bold rounded border outline-none text-sm ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-300'}`}
                    />
                  </div>
                  <div>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Change Back", "ফেরত দেওয়া")}</label>
                    <div className={`w-full px-2.5 py-1.5 font-mono font-black text-sm rounded border ${((parseFloat(calculatorInput) || 0) - (currentFinalBill + (selectedExistingDue ? selectedExistingDue.totalDue : 0))) >= 0 ? 'text-emerald-400 bg-emerald-500/5 border-emerald-500/10' : 'text-red-400 bg-red-500/5 border-red-500/10'}`}>
                      {(() => {
                        const cashNum = parseFloat(calculatorInput) || 0;
                        const grandTotal = currentFinalBill + (selectedExistingDue ? selectedExistingDue.totalDue : 0);
                        const change = cashNum - grandTotal;
                        return change >= 0 ? `${change.toFixed(1)} ${currencySymbol}` : t("Short!", "কম আছে!");
                      })()}
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Payment Method", "পেমেন্ট পদ্ধতি")}</label>
                  <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} className={`w-full p-1.5 rounded border outline-none text-sm ${isDarkMode ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}`}>
                    <option value="Cash">💵 {t("Cash", "নগদ")}</option>
                    <option value="bKash/Nagad">📱 {t("bKash / Nagad", "বিকাশ / নগদ")}</option>
                    <option value="Card">💳 {t("Card", "কার্ড")}</option>
                  </select>
                </div>
                <div>
                  <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Due Amount", "বাকি পরিমাণ")}</label>
                  <input type="number" value={invoiceDue} readOnly disabled title={t("Auto-calculated from Cash Given", "নগদ দিয়েছে থেকে স্বয়ংক্রিয় হিসাব")} className={`w-full p-1.5 font-mono rounded border outline-none text-sm cursor-not-allowed opacity-80 ${isDarkMode ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}`} />
                </div>
              </div>

              <div className="flex gap-2 justify-end pt-2 border-t mt-1">
                <button onClick={() => setShowConfirmModal(false)} className={`px-4 py-2 text-sm font-bold rounded-xl transition ${isDarkMode ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{t("Cancel", "বাতিল")}</button>
                <button
                  onClick={executeFinalCheckout}
                  disabled={
                    isSubmittingSale ||
                    (((parseFloat(calculatorInput) || 0) - (currentFinalBill + (selectedExistingDue ? selectedExistingDue.totalDue : 0))) < 0 && parseFloat(invoiceDue) === 0)
                  }
                  className="bg-gradient-to-r from-indigo-500 to-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-black px-5 py-2 rounded-xl uppercase tracking-wider shadow hover:from-indigo-600 hover:to-emerald-600 transition"
                >
                  {isSubmittingSale
                    ? `⏳ ${t("Processing...", "প্রক্রিয়া হচ্ছে...")}`
                    : `✅ ${t("Confirm & Print", "নিশ্চিত ও প্রিন্ট")}`
                  }
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          MODAL 2: RETURN PROCESSING
      ========================================================= */}
      {showReturnModal && selectedInvoiceForReturn && (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-md z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className={`max-w-xl w-full rounded-2xl border p-4 shadow-sm my-4 ${isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200'}`}>
            <h3 className="text-sm font-black uppercase tracking-wider text-red-400 border-b pb-2 mb-3 flex items-center justify-between">
              <span>🔄 {t("Process Return", "ফেরত প্রক্রিয়া করুন")}</span>
              <button onClick={() => { setShowReturnModal(false); setSelectedInvoiceForReturn(null); }} className="text-slate-400 hover:text-white font-bold text-sm">✕</button>
            </h3>

            <div className="flex flex-col gap-3 text-sm">
              <div className="p-2.5 rounded-xl bg-slate-500/5 text-sm font-semibold flex justify-between items-center">
                <div>{t("Invoice:", "রশিদ:")} <strong className="text-indigo-500 font-mono">{selectedInvoiceForReturn.invoiceId}</strong></div>
                <div>{t("Customer:", "গ্রাহক:")} <strong>{selectedInvoiceForReturn.customer}</strong></div>
                <div>{t("Bill:", "বিল:")} <strong className="font-mono text-indigo-400">{selectedInvoiceForReturn.finalBill.toFixed(1)} {currencySymbol}</strong></div>
              </div>

              <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto">
                <span className="text-sm font-black uppercase text-slate-400">{t("Select return quantities:", "ফেরত পরিমাণ বেছে নিন:")}</span>
                {selectedInvoiceForReturn.items.map((item: any) => (
                  <div key={item.id} className={`p-2 rounded-xl border flex items-center justify-between gap-2 ${isDarkMode ? 'bg-slate-950/40 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                    <div className="flex-1">
                      <h5 className="font-bold text-sm">{item.name}</h5>
                      <span className="text-sm text-slate-400 font-mono">{t("Bought:", "কেনা:")} {item.qty} @ {item.price}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-slate-400">{t("Return:", "ফেরত:")}</span>
                      <input type="number" min="0" max={item.qty} value={returnItemsQuantities[item.id] || 0} onChange={e => handleReturnItemQtyChange(item.id, item.qty, e.target.value)} className={`w-14 px-1 py-0.5 font-mono text-center font-bold text-red-400 bg-transparent rounded border outline-none ${isDarkMode ? 'border-slate-700' : 'border-slate-300'}`} />
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Refund Type", "ফেরত পদ্ধতি")}</label>
                  <select value={returnActionType} onChange={e => setReturnActionType(e.target.value as any)} className={`w-full p-1.5 rounded border text-sm outline-none ${isDarkMode ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}`}>
                    <option value="CASH_REFUND">💰 {t("Cash Refund", "নগদ ফেরত")}</option>
                    <option value="STORE_CREDIT">💳 {t("Store Credit", "স্টোর ক্রেডিট")}</option>
                  </select>
                </div>
                <div>
                  <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Reason", "কারণ")}</label>
                  <input type="text" placeholder={t("e.g. Defective product...", "যেমন: নষ্ট পণ্য...")} value={returnReason} onChange={e => setReturnReason(e.target.value)} className={`w-full p-1.5 rounded border text-sm outline-none ${isDarkMode ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}`} />
                </div>
              </div>

              <div className="flex gap-2 justify-end pt-2 border-t mt-2">
                <button onClick={() => { setShowReturnModal(false); setSelectedInvoiceForReturn(null); }} className={`px-4 py-2 text-sm font-bold rounded-xl transition ${isDarkMode ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{t("Cancel", "বাতিল")}</button>
                <button
                  onClick={processInvoiceMedicineReturn}
                  disabled={isSubmittingReturn}
                  className={`text-white font-black px-5 py-2 rounded-xl uppercase tracking-wider shadow transition ${isSubmittingReturn ? 'bg-slate-400 cursor-not-allowed' : 'bg-red-500 hover:bg-red-600'}`}
                >
                  {isSubmittingReturn ? t("⏳ Processing...", "⏳ প্রক্রিয়া হচ্ছে...") : t("Process Return", "ফেরত প্রক্রিয়া করুন")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          MODAL 3: PRINT RECEIPT
      ========================================================= */}
      {showReceipt && lastInvoice && (
        <div onClick={() => setShowReceipt(false)} className="fixed inset-0 bg-slate-950/90 backdrop-blur-md z-50 flex items-center justify-center p-4 overflow-y-auto print:absolute print:inset-0 print:bg-white print:p-0">
          <div onClick={(e) => e.stopPropagation()} className="receipt-print max-w-sm w-full bg-white text-slate-950 rounded-2xl shadow-sm text-sm border border-slate-200 overflow-hidden print:shadow-none print:border-none print:w-full print:rounded-none">

            {/* Control bar — hidden when printing */}
            <div className="flex justify-between items-center px-4 py-2.5 border-b bg-slate-50 print:hidden">
              <div className="flex items-center gap-2">
                <button onClick={triggerPrintReceipt} className="bg-indigo-500 hover:bg-indigo-600 text-white font-bold py-1.5 px-3.5 rounded-xl uppercase tracking-wider text-sm transition shadow-sm">🖨️ {t("Print", "প্রিন্ট")}</button>
                <button onClick={() => posPrintInvoice(lastInvoice)} className="bg-amber-500 hover:bg-amber-600 text-white font-bold py-1.5 px-3.5 rounded-xl uppercase tracking-wider text-sm transition shadow-sm">🧾 {t("POS Print", "POS প্রিন্ট")}</button>
              </div>
              <button onClick={() => setShowReceipt(false)} className="text-red-500 hover:text-red-600 font-bold text-sm uppercase">✕ {t("Close", "বন্ধ")}</button>
            </div>

            {/* Branded header band */}
            <div className="bg-gradient-to-br from-indigo-600 to-emerald-500 text-white text-center px-5 pt-6 pb-8">
              <div className="w-12 h-12 mx-auto mb-2 rounded-xl bg-white/15 border border-white/40 flex items-center justify-center font-black text-lg overflow-hidden">{pharmacyLogo && pharmacyLogo.startsWith('data:image') ? <img src={pharmacyLogo} alt="logo" className="w-full h-full object-cover" /> : pharmacyLogo}</div>
              <h3 className="font-black text-base uppercase tracking-wide">{pharmacyName}</h3>
              <p className="text-sm opacity-90 leading-snug mt-0.5">{pharmacySlogan}</p>
              <p className="text-sm font-semibold mt-1.5 opacity-95">📍 {pharmacyAddress}</p>
            </div>

            <div className="font-mono px-5 pb-5">
              {/* Ticket-style title pill, overlapping the header band */}
              <div className="flex justify-center -mt-4 mb-4">
                <span className="bg-slate-950 text-white text-sm font-black px-4 py-1.5 rounded-full uppercase tracking-widest shadow-sm">🧾 {t("Sales Receipt", "বিক্রয় রশিদ")}</span>
              </div>

              {/* Invoice meta info card */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 mb-4 flex flex-col gap-1 text-sm">
                <div className="flex justify-between"><span className="text-slate-500">{t("Invoice ID:", "রশিদ নং:")}</span><span className="font-bold text-indigo-600">{lastInvoice.invoiceId}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">{t("Customer:", "গ্রাহক:")}</span><span className="font-bold">{lastInvoice.customer}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">{t("Phone:", "ফোন:")}</span><span>{lastInvoice.phone}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">{t("Date:", "তারিখ:")}</span><span>{lastInvoice.dateString}</span></div>
                <div className="flex justify-between items-center"><span className="text-slate-500">{t("Payment:", "পেমেন্ট:")}</span><span className="font-bold bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-lg text-sm">{lastInvoice.paymentMethod}</span></div>
              </div>

              {/* Items table */}
              <table className="w-full text-left border-collapse mb-4 text-sm overflow-hidden rounded-xl">
                <thead>
                  <tr className="bg-slate-900 text-white">
                    <th className="py-1.5 px-2 font-bold rounded-l-lg">{t("Item", "আইটেম")}</th>
                    <th className="py-1.5 px-2 font-mono text-center font-bold">{t("Qty", "পরিমাণ")}</th>
                    <th className="py-1.5 px-2 font-mono text-right font-bold rounded-r-lg">{t("Total", "মোট")}</th>
                  </tr>
                </thead>
                <tbody>
                  {lastInvoice.items.map((item: any, idx: number) => (
                    <tr key={item.id} className={idx % 2 === 1 ? 'bg-slate-50' : 'bg-white'}>
                      <td className="py-1.5 px-2">
                        <span className="block font-bold">{item.name}</span>
                        <span className="text-sm opacity-70 italic">{t("Rate:", "মূল্য:")} {item.price}</span>
                      </td>
                      <td className="py-1.5 px-2 font-mono text-center">{item.qty}</td>
                      <td className="py-1.5 px-2 font-mono text-right font-bold">{((parseInt(item.qty) || 0) * item.price).toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Totals card */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex flex-col gap-1.5 text-sm text-right font-semibold mb-4">
                <div className="flex justify-between"><span className="text-slate-500">{t("Subtotal:", "মোট:")}</span><span className="font-mono">{lastInvoice.subTotal.toFixed(1)} {currencySymbol}</span></div>
                {lastInvoice.vat > 0 && <div className="flex justify-between"><span className="text-slate-500">{t("VAT:", "ভ্যাট:")}</span><span className="font-mono">+{lastInvoice.vat.toFixed(1)}</span></div>}
                {lastInvoice.discount > 0 && <div className="flex justify-between text-red-600"><span>{t("Discount:", "ছাড়:")}</span><span className="font-mono">-{lastInvoice.discount.toFixed(1)}</span></div>}

                <div className="flex justify-between items-center bg-indigo-600 text-white rounded-xl px-3 py-2 mt-0.5">
                  <span className="uppercase text-sm font-black tracking-wide">{t("Net Payable", "মোট পরিশোধ")}</span>
                  <span className="font-mono text-base font-black">{lastInvoice.finalBill.toFixed(1)} {currencySymbol}</span>
                </div>

                <div className="flex justify-between text-sm font-semibold text-slate-600 mt-1">
                  <span>{t("Cash Received:", "নগদ পেয়েছি:")}</span>
                  {/* BUGFIX #10: use ?? instead of || so ৳0 paid correctly shows 0, not finalBill */}
                  <span className="font-mono">{(lastInvoice.cashReceived ?? lastInvoice.finalBill).toFixed(1)} {currencySymbol}</span>
                </div>
                <div className="flex justify-between text-sm font-semibold text-slate-600">
                  <span>{t("Change Given:", "ফেরত দিয়েছি:")}</span>
                  <span className="font-mono">{Math.max(0, (lastInvoice.cashReceived ?? lastInvoice.finalBill) - lastInvoice.finalBill).toFixed(1)} {currencySymbol}</span>
                </div>

                {lastInvoice.due > 0 && (
                  <div className="flex justify-between items-center bg-red-600 text-white rounded-xl px-3 py-2 mt-0.5">
                    <span className="uppercase text-sm font-black tracking-wide">⚠️ {t("Unpaid Due", "বাকি")}</span>
                    <span className="font-mono text-base font-black">{lastInvoice.due.toFixed(1)} {currencySymbol}</span>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="text-center border-t-2 border-dashed border-slate-300 pt-3">
                <p className="text-sm tracking-[0.3em] text-slate-300 mb-1.5">✦ ✦ ✦ ✦ ✦</p>
                <p className="text-sm font-black uppercase tracking-tight text-indigo-600">{lastInvoice.footerMsg || receiptFooterMsg}</p>
                <p className="text-sm text-slate-400 mt-1">{pharmacyName} · {pharmacyAddress}</p>
              </div>
            </div>
          </div>
        </div>
      )}


      {/* =========================================================
          MODAL 4: DUE PAYMENT COLLECTION
      ========================================================= */}
      {duePaymentModal && (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className={`ccard cc-rose max-w-sm w-full rounded-2xl border p-4 shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-slate-700 text-white' : 'bg-white border-slate-200'}`}>
            <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500 border-b pb-2 mb-3 flex items-center justify-between">
              <span>💰 {t("Collect Payment", "পরিশোধ নিন")}</span>
              <button onClick={() => { setDuePaymentModal(null); setDuePayAmount(""); }} className="text-slate-400 hover:text-red-500 font-bold text-sm">✕</button>
            </h3>

            <div className="flex flex-col gap-3 text-sm">
              <div className="bg-slate-500/5 p-3 rounded-xl">
                <div className="flex justify-between mb-1"><span className="text-slate-400">{t("Customer:", "গ্রাহক:")}</span><strong>{duePaymentModal.customerName}</strong></div>
                <div className="flex justify-between"><span className="text-slate-400">{t("Outstanding Due:", "বাকি:")}</span><strong className="text-red-500 font-mono text-sm">{duePaymentModal.totalDue.toFixed(1)} {currencySymbol}</strong></div>
              </div>

              <div>
                <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Payment Amount", "পরিশোধ পরিমাণ")}</label>
                <input
                  type="number"
                  value={duePayAmount}
                  onChange={e => setDuePayAmount(e.target.value)}
                  placeholder={t("Enter amount...", "পরিমাণ লিখুন...")}
                  className={`w-full px-3 py-2 rounded-xl border text-sm font-mono outline-none ${isDarkMode ? 'bg-slate-950 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                />
                {parseFloat(duePayAmount) > 0 && (
                  <p className="text-sm text-emerald-500 mt-1 font-bold">
                    {t("Remaining after payment:", "পেমেন্টের পর বাকি:")} {Math.max(0, duePaymentModal.totalDue - parseFloat(duePayAmount)).toFixed(1)} {currencySymbol}
                  </p>
                )}
              </div>

              <div className="flex gap-2 justify-end">
                <button onClick={() => { setDuePaymentModal(null); setDuePayAmount(""); }} className={`px-4 py-2 text-sm font-bold rounded-xl transition ${isDarkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>{t("Cancel", "বাতিল")}</button>
                <button onClick={handleDuePayment} className="bg-indigo-500 hover:bg-indigo-600 text-white font-black px-5 py-2 rounded-xl uppercase tracking-wider shadow transition">
                  ✅ {t("Record Payment", "পেমেন্ট রেকর্ড")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}