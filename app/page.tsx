"use client";
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';

// ============================================================
// MADINA MEDICINE CORNER - PROFESSIONAL PHARMACY POS SYSTEM
// Version 8.0 - Advanced Edition + Firebase Cloud Sync
// ============================================================

// ============================================================
// FIREBASE CLOUD SYNC
// ─────────────────────────────────────────────────────────────
// HOW TO SETUP (one-time, 5 minutes):
//
// 1. Go to https://console.firebase.google.com
// 2. Click "Add project" → give it a name → Continue
// 3. In the project, click "Build" → "Realtime Database"
// 4. Click "Create Database" → choose any location → Start in TEST MODE
// 5. Click "Project Settings" (gear icon) → "Your apps" → </> (Web)
// 6. Register app → copy the firebaseConfig values below
// 7. In Realtime Database → Rules → paste:
//    { "rules": { ".read": true, ".write": true } }  → Publish
//
// Then fill in YOUR values in FIREBASE_CONFIG below.
// ============================================================

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD-oDPGUKhOhB71oso_9gN5L2KNxBRwbeE",
  databaseURL: "https://madinamedicine-default-rtdb.asia-southeast1.firebasedatabase.app",
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
  'madina_v7_admin_user',
  'madina_v7_admin_pass',
  'madina_v7_staff_user',
  'madina_v7_staff_pass',
  'madina_v7_secret_code',
  'madina_v7_staff_perms',
  'madina_v7_name',
  'madina_v7_slogan',
  'madina_v7_address',
  'madina_v7_logo',
  'madina_v7_currency',
  'madina_v7_vat',
  'madina_v7_threshold',
  'madina_v7_footer',
];

// ── Firebase REST helpers (no SDK needed — pure fetch) ──────
const isFirebaseConfigured = () =>
  FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY" &&
  FIREBASE_CONFIG.databaseURL !== "YOUR_DATABASE_URL" &&
  !!FIREBASE_CONFIG.databaseURL;

const fbUrl = (key: string) =>
  `${FIREBASE_CONFIG.databaseURL}/madina_data/${key}.json`;

// Fetch with timeout — works on slow mobile data connections
const fetchWithTimeout = (url: string, options: RequestInit = {}, timeoutMs = 10000): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
};

// Offline queue — saves failed writes and retries when back online
let offlineQueue: { key: string; value: string }[] = [];
const flushOfflineQueue = async () => {
  if (!isFirebaseConfigured() || offlineQueue.length === 0) return;
  const queue = [...offlineQueue];
  offlineQueue = [];
  for (const item of queue) {
    try {
      await fetchWithTimeout(fbUrl(item.key), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.value),
      });
    } catch {
      offlineQueue.push(item); // re-queue if still failing
    }
  }
};

// Listen for network recovery and flush queued writes
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { flushOfflineQueue(); });
}

// Write a single key to Firebase
const fbSet = async (key: string, value: string): Promise<void> => {
  if (!isFirebaseConfigured()) return;
  try {
    await fetchWithTimeout(fbUrl(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch {
    // Network unavailable — queue for retry when back online
    offlineQueue = offlineQueue.filter(q => q.key !== key);
    offlineQueue.push({ key, value });
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

// Read ALL cloud keys at once (faster than individual reads on load)
const fbGetAll = async (): Promise<Record<string, string> | null> => {
  if (!isFirebaseConfigured()) return null;
  try {
    const res = await fetchWithTimeout(
      `${FIREBASE_CONFIG.databaseURL}/madina_data.json`,
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

// Delete a single key from Firebase
const fbDelete = async (key: string): Promise<void> => {
  if (!isFirebaseConfigured()) return;
  try {
    await fetchWithTimeout(fbUrl(key), { method: 'DELETE' });
  } catch { /* ignore */ }
};

// ── Firebase Real-time Listener via SSE ─────────────────────
// Returns an unsubscribe function. Calls onChange(data) whenever
// ANY key under /madina_data changes on Firebase (from any device).
const fbListenAll = (onChange: (data: Record<string, string>) => void): (() => void) => {
  if (!isFirebaseConfigured() || typeof window === 'undefined' || typeof EventSource === 'undefined') {
    return () => {};
  }
  const url = `${FIREBASE_CONFIG.databaseURL}/madina_data.json`;
  let es: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // initialLoadDone: after first connect snapshot is applied, mark as done
  let initialLoadDone = false;

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
    initialLoadDone = false;
    es = new EventSource(url);

    es.addEventListener('put', (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data);
        const result = extractResult(payload.path || '/', payload.data);
        // Always apply — initial full snapshot + all subsequent updates.
        // This ensures Device B sees live data as soon as it connects,
        // and any open device auto-updates when another device makes changes.
        if (Object.keys(result).length > 0) onChange(result);
        initialLoadDone = true;
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

// Wrapped localStorage.setItem that ALSO writes to Firebase
const cloudSet = (key: string, value: string) => {
  localStorage.setItem(key, value);
  if (CLOUD_SYNC_KEYS.includes(key)) fbSet(key, value);
};

// ============================================================
// SOUND ENGINE — Web Audio API (no external deps)
// ============================================================
const createSound = (type: 'success' | 'click' | 'error' | 'add' | 'login' | 'notify' | 'delete' | 'checkout' | 'tab' | 'warning' | 'print' | 'save') => {
  if (typeof window === 'undefined') return;
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
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
    setTimeout(() => ctx.close(), 1500);
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
  "Juice", "Belt", "Ball", "Suppository", "Chocolate", "Pack", "Piece", "Box"
];

// Theme CSS variable injection (static - defined outside component)
const themeStyles: Record<string, React.CSSProperties> = {
  light: {},
  dark: {},
  ocean: {
    '--theme-bg': '#0a1628',
    '--theme-bg2': '#0d2040',
    '--theme-card': '#0f2952',
    '--theme-border': '#1e3a6e',
    '--theme-text': '#b8d4f8',
    '--theme-accent': '#38bdf8',
    '--theme-accent2': '#0284c7',
  } as React.CSSProperties,
  forest: {
    '--theme-bg': '#0a1a0f',
    '--theme-bg2': '#0d2318',
    '--theme-card': '#0f2d1e',
    '--theme-border': '#1e4d33',
    '--theme-text': '#a7f3c0',
    '--theme-accent': '#34d399',
    '--theme-accent2': '#059669',
  } as React.CSSProperties,
  royal: {
    '--theme-bg': '#160a28',
    '--theme-bg2': '#1e0d40',
    '--theme-card': '#270f52',
    '--theme-border': '#3d1a8a',
    '--theme-text': '#d4b8f8',
    '--theme-accent': '#a78bfa',
    '--theme-accent2': '#7c3aed',
  } as React.CSSProperties,
  sunset: {
    '--theme-bg': '#1a0a05',
    '--theme-bg2': '#2a1005',
    '--theme-card': '#3a1508',
    '--theme-border': '#7c2d12',
    '--theme-text': '#fcd5b0',
    '--theme-accent': '#fb923c',
    '--theme-accent2': '#ea580c',
  } as React.CSSProperties,
  cherry: {
    '--theme-bg': '#1a0510',
    '--theme-bg2': '#270a18',
    '--theme-card': '#380d22',
    '--theme-border': '#7c1d45',
    '--theme-text': '#fdb8d4',
    '--theme-accent': '#f472b6',
    '--theme-accent2': '#db2777',
  } as React.CSSProperties,
  midnight: {
    '--theme-bg': '#050508',
    '--theme-bg2': '#0a0a12',
    '--theme-card': '#0f0f1e',
    '--theme-border': '#1a1a3a',
    '--theme-text': '#c8c8e8',
    '--theme-accent': '#818cf8',
    '--theme-accent2': '#4f46e5',
  } as React.CSSProperties,
  nordic: {
    '--theme-bg': '#1a1f2e',
    '--theme-bg2': '#1e2535',
    '--theme-card': '#252d42',
    '--theme-border': '#2e3a56',
    '--theme-text': '#cdd6f4',
    '--theme-accent': '#89dceb',
    '--theme-accent2': '#74c7ec',
  } as React.CSSProperties,
  lava: {
    '--theme-bg': '#110805',
    '--theme-bg2': '#1c0e07',
    '--theme-card': '#28130a',
    '--theme-border': '#6b1e09',
    '--theme-text': '#ffd5b0',
    '--theme-accent': '#f97316',
    '--theme-accent2': '#c2410c',
  } as React.CSSProperties,
  glacier: {
    '--theme-bg': '#f0f6ff',
    '--theme-bg2': '#e4eeff',
    '--theme-card': '#ffffff',
    '--theme-border': '#c7d9f5',
    '--theme-text': '#1e3a5f',
    '--theme-accent': '#2563eb',
    '--theme-accent2': '#1d4ed8',
  } as React.CSSProperties,
}

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
  const [forgotSecretInput, setForgotSecretInput] = useState("");
  const [forgotNewPass, setForgotNewPass] = useState("");
  const [forgotStep, setForgotStep] = useState<"secret" | "newpass">("secret");
  const [forgotError, setForgotError] = useState("");
  const [showLoginPass, setShowLoginPass] = useState(false);

  // ============================================================
  // CREDENTIALS & SECURITY
  // ============================================================
  const [adminUsername, setAdminUsername] = useState("admin");
  const [adminPassword, setAdminPassword] = useState("2026");
  const [staffUsername, setStaffUsername] = useState("staff");
  const [staffPassword, setStaffPassword] = useState("staff123");
  const [secretCode, setSecretCode] = useState("MADINA2026");
  const [currentPassCheck, setCurrentPassCheck] = useState("");
  const [newUsernameInput, setNewUsernameInput] = useState("admin");
  const [newPasswordInput, setNewPasswordInput] = useState("2026");
  const [newStaffUsernameInput, setNewStaffUsernameInput] = useState("staff");
  const [newStaffPasswordInput, setNewStaffPasswordInput] = useState("staff123");
  const [newSecretCodeInput, setNewSecretCodeInput] = useState("MADINA2026");
  const [isCredentialsFormUnlocked, setIsCredentialsFormUnlocked] = useState(false);

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
  });

  // ============================================================
  // TODAY KEY — used to force daily stats re-computation at midnight
  // ============================================================
  const [todayKey, setTodayKey] = useState(() => new Date().toDateString());

  // ============================================================
  // SOUND & UI ENHANCEMENT STATES
  // ============================================================
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [liveTime, setLiveTime] = useState("");
  const [liveDate, setLiveDate] = useState("");
  const [liveDay, setLiveDay] = useState("");
  const [loginShake, setLoginShake] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [toastQueue, setToastQueue] = useState<{id:number,msg:string,type:'success'|'error'|'info'}[]>([]);
  const toastIdRef = useRef(0);

  const playSound = useCallback((type: 'success'|'click'|'error'|'add'|'login'|'notify'|'delete'|'checkout'|'tab'|'warning'|'print'|'save') => {
    if (soundEnabled) createSound(type);
  }, [soundEnabled]);

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
  const [totalSales, setTotalSales] = useState(0);
  const [totalProfit, setTotalProfit] = useState(0);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [cart, setCart] = useState<any[]>([]);
  // cartRef always holds the latest cart so the Firebase listener
  // can re-apply pending deductions without stale closure issues
  const cartRef = useRef<any[]>([]);
  useEffect(() => { cartRef.current = cart; }, [cart]);
  const [activeTab, setActiveTab] = useState("pos");

  const [bdMedicineCompanies, setBdMedicineCompanies] = useState<string[]>([]);
  const [bdMedicineNamesList, setBdMedicineNamesList] = useState<string[]>([]);
  // Stores per-medicine metadata: { name, buyPrice, sellPrice, company, category }
  const [bdMedNameMetadata, setBdMedNameMetadata] = useState<{name:string; buyPrice:number; sellPrice:number; company:string; category?:string}[]>([]);

  // ============================================================
  // DUE (CUSTOMER CREDIT) SYSTEM
  // ============================================================
  const [dueList, setDueList] = useState<any[]>([]);
  const [duePaymentModal, setDuePaymentModal] = useState<any>(null);
  const [duePayAmount, setDuePayAmount] = useState("");
  const [dueCollectionLog, setDueCollectionLog] = useState<any[]>([]);
  const [dueSearch, setDueSearch] = useState("");

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
  const [selectedExistingDue, setSelectedExistingDue] = useState<any>(null);
  const [showCustomerPanel, setShowCustomerPanel] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState("Cash");
  const [cashReceived, setCashReceived] = useState("");
  const [invoiceDue, setInvoiceDue] = useState("0");
  const [discountType, setDiscountType] = useState<"TK" | "PERCENT">("TK");
  const [discountValue, setDiscountValue] = useState("0");
  const [searchTerm, setSearchTerm] = useState("");
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
  const [dashboardFilterView, setDashboardFilterView] = useState<"NONE" | "LOW_STOCK" | "EXPIRED">("NONE");

  // ============================================================
  // STOCK IN / PURCHASE
  // ============================================================
  const [purchaseList, setPurchaseList] = useState<any[]>([]);
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

  // ============================================================
  // SYNC STATUS STATE
  // ============================================================
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'offline'>('idle');

  // ============================================================
  // LOAD DATA — Firebase first, localStorage as fallback
  // ============================================================
  useEffect(() => {
    setIsMounted(true);
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
    if (savedTheme) setThemeMode(savedTheme);
    else if (savedDark) setThemeMode(JSON.parse(savedDark) ? 'dark' : 'light');
    if (savedSound !== null) setSoundEnabled(JSON.parse(savedSound));
    if (savedLang) setLanguage(savedLang as any);

    // Helper: apply loaded cloud/local data to all state setters
    // allowSeedDefaults: only true when we KNOW Firebase has no data at all
    const applyData = (data: Record<string, string | null>, allowSeedDefaults = false) => {
      const g = (key: string) => data[key] ?? null;

      const savedMeds = g('madina_v7_meds');
      if (savedMeds) setMedicines(JSON.parse(savedMeds));
      // No default seeding — start completely empty

      const savedInvoices = g('madina_v7_invoices');
      if (savedInvoices) setInvoices(JSON.parse(savedInvoices));

      const savedPurchases = g('madina_v7_purchases');
      if (savedPurchases) setPurchaseList(JSON.parse(savedPurchases));

      const savedDueList = g('madina_v7_due_list');
      if (savedDueList) setDueList(JSON.parse(savedDueList));

      const savedDueCLog = g('madina_v7_due_collection_log');
      if (savedDueCLog) setDueCollectionLog(JSON.parse(savedDueCLog));

      const savedSales = g('madina_v7_sales');
      if (savedSales) setTotalSales(parseFloat(savedSales));

      const savedProfit = g('madina_v7_profit');
      if (savedProfit) setTotalProfit(parseFloat(savedProfit));

      // Company suggestion list — seed defaults ONLY if absolutely nothing exists anywhere
      const savedCompanies = g('madina_v7_companies');
      if (savedCompanies) {
        try {
          const parsed = JSON.parse(savedCompanies);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setBdMedicineCompanies(parsed);
          }
          // If parsed is empty array, keep whatever is currently in state (don't overwrite with defaults)
        } catch { /* skip malformed */ }
      }
      // Note: Default seeding only happens in the dedicated first-boot block below

      // Medicine name suggestion list — seed defaults ONLY if absolutely nothing exists anywhere
      const savedMedNames = g('madina_v7_mednames');
      if (savedMedNames) {
        try {
          const parsed = JSON.parse(savedMedNames);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setBdMedicineNamesList(parsed);
          }
          // If parsed is empty array, keep whatever is currently in state (don't overwrite with defaults)
        } catch { /* skip malformed */ }
      }
      // Note: Default seeding only happens in the dedicated first-boot block below

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

      const savedSecret = g('madina_v7_secret_code');
      if (savedSecret) { setSecretCode(savedSecret); setNewSecretCodeInput(savedSecret); }

      const savedPermissions = g('madina_v7_staff_perms');
      if (savedPermissions) setStaffVisibleModules(prev => ({ ...prev, ...JSON.parse(savedPermissions) }));
    };

    // ── LOCAL CACHE RESET (Firebase data is NEVER deleted here) ──
    // This runs once per browser to clear stale localStorage cache only.
    // Firebase is the master data source — it is never touched here.
    const BUSINESS_KEYS = [
      'madina_v7_meds', 'madina_v7_invoices', 'madina_v7_purchases',
      'madina_v7_due_list', 'madina_v7_due_collection_log',
      'madina_v7_sales', 'madina_v7_profit', 'madina_v7_medmeta',
    ];
    const cleanStartDone = localStorage.getItem('madina_v7_clean_start_2026');
    if (!cleanStartDone) {
      // First time on this browser — wipe only localStorage (NOT Firebase)
      for (const k of BUSINESS_KEYS) localStorage.removeItem(k);
      localStorage.setItem('madina_v7_clean_start_2026', 'done');
      // NOTE: Firebase business data is intentionally NOT deleted here.
      // Firebase is the single source of truth; local cache is just a mirror.
      // Seed autocomplete defaults in localStorage only (if missing)
      if (!localStorage.getItem('madina_v7_companies')) {
        localStorage.setItem('madina_v7_companies', JSON.stringify(initialMedicineCompanies));
        setBdMedicineCompanies(initialMedicineCompanies);
      }
      if (!localStorage.getItem('madina_v7_mednames')) {
        localStorage.setItem('madina_v7_mednames', JSON.stringify(initialMedicineNamesList));
        setBdMedicineNamesList(initialMedicineNamesList);
      }
    } else {
      // Not first boot — ensure autocomplete lists exist in localStorage (seed if missing)
      if (!localStorage.getItem('madina_v7_companies')) {
        localStorage.setItem('madina_v7_companies', JSON.stringify(initialMedicineCompanies));
        setBdMedicineCompanies(initialMedicineCompanies);
      }
      if (!localStorage.getItem('madina_v7_mednames')) {
        localStorage.setItem('madina_v7_mednames', JSON.stringify(initialMedicineNamesList));
        setBdMedicineNamesList(initialMedicineNamesList);
      }
    }

    // Step 1: Load from localStorage immediately (instant, no flicker)
    const localData: Record<string, string | null> = {};
    for (const k of CLOUD_SYNC_KEYS) localData[k] = localStorage.getItem(k);
    const localHasMeds = !!localData['madina_v7_meds'];
    applyData(localData, false);

    // Step 2: Try Firebase — if available, overwrite with fresher cloud data
    if (isFirebaseConfigured()) {
      setSyncStatus('syncing');
      fbGetAll().then(cloudData => {
        const cloudHasMeds = !!(cloudData && cloudData['madina_v7_meds']);
        const cloudHasAnyData = !!(cloudData && Object.keys(cloudData).length > 0);

        if (cloudHasAnyData) {
          for (const k of CLOUD_SYNC_KEYS) {
            if (cloudData[k]) localStorage.setItem(k, cloudData[k]);
          }
          const mergedData: Record<string, string | null> = { ...localData };
          for (const k of CLOUD_SYNC_KEYS) {
            if (cloudData[k]) mergedData[k] = cloudData[k];
          }
          applyData(mergedData, false);
          setSyncStatus('synced');
        } else if (localHasMeds) {
          const localSnapshot: Record<string, string | null> = {};
          for (const k of CLOUD_SYNC_KEYS) localSnapshot[k] = localStorage.getItem(k);
          applyData(localSnapshot, false);
          for (const k of CLOUD_SYNC_KEYS) {
            const val = localStorage.getItem(k);
            if (val) fbSet(k, val);
          }
          setSyncStatus('synced');
        } else {
          // Truly empty — just apply (autocomplete lists already seeded in applyData)
          applyData(localData, false);
          setSyncStatus('idle');
        }
        setTimeout(() => setSyncStatus('idle'), 3000);
      }).catch(() => {
        setSyncStatus('offline');
      });
    } else {
      // Firebase not configured — seed defaults only if localStorage is empty
      if (!localHasMeds) {
        applyData(localData, true);
      }
    }
  }, []);

  // ============================================================
  // FIREBASE REAL-TIME LISTENER — Live sync across all devices
  // Whenever any device saves data, this device auto-updates.
  // ============================================================
  useEffect(() => {
    if (!isMounted) return;

    const unsubscribe = fbListenAll((cloudData) => {
      setSyncStatus('syncing');

      const apply = (key: string, setter: (v: any) => void, parse: (s: string) => any = JSON.parse) => {
        if (cloudData[key] !== undefined) {
          localStorage.setItem(key, cloudData[key]);
          try { setter(parse(cloudData[key])); } catch { /* skip malformed */ }
        }
      };

      // Special handling for medicines: if there's an active cart, re-apply cart deductions
      // so that Firebase updates from other devices don't undo pending stock changes
      if (cloudData['madina_v7_meds'] !== undefined) {
        localStorage.setItem('madina_v7_meds', cloudData['madina_v7_meds']);
        try {
          const freshMeds: any[] = JSON.parse(cloudData['madina_v7_meds']);
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

      apply('madina_v7_invoices', setInvoices);
      apply('madina_v7_purchases', setPurchaseList);
      apply('madina_v7_due_list', setDueList);
      apply('madina_v7_due_collection_log', setDueCollectionLog);
      apply('madina_v7_sales', setTotalSales, parseFloat);
      apply('madina_v7_profit', setTotalProfit, parseFloat);
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
      apply('madina_v7_admin_user', (v: string) => { setAdminUsername(v); setNewUsernameInput(v); }, (s: string) => s);
      apply('madina_v7_admin_pass', (v: string) => { setAdminPassword(v); setNewPasswordInput(v); }, (s: string) => s);
      apply('madina_v7_staff_user', (v: string) => { setStaffUsername(v); setNewStaffUsernameInput(v); }, (s: string) => s);
      apply('madina_v7_staff_pass', (v: string) => { setStaffPassword(v); setNewStaffPasswordInput(v); }, (s: string) => s);
      apply('madina_v7_secret_code', (v: string) => { setSecretCode(v); setNewSecretCodeInput(v); }, (s: string) => s);
      apply('madina_v7_staff_perms', (v: any) => setStaffVisibleModules((prev: any) => ({ ...prev, ...v })));

      setSyncStatus('synced');
      setTimeout(() => setSyncStatus('idle'), 3000);
    });

    return () => unsubscribe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMounted]);

  // ============================================================
  // LIVE CLOCK
  // ============================================================
  useEffect(() => {
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const daysBn = ['রবিবার','সোমবার','মঙ্গলবার','বুধবার','বৃহস্পতিবার','শুক্রবার','শনিবার'];
    const tick = () => {
      const now = new Date();
      setLiveTime(now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      setLiveDate(now.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }));
      setLiveDay(language === 'bn' ? daysBn[now.getDay()] : days[now.getDay()]);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [language]);

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
      const timer = setTimeout(() => setShowSuccessAlert(false), 4000);
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
    setActiveTab("pos");
  };

  const handleForgotPassword = () => {
    setForgotError("");
    if (forgotStep === "secret") {
      if (forgotSecretInput.trim() === secretCode) {
        setForgotStep("newpass");
      } else {
        setForgotError(t("Wrong secret code!", "ভুল সিক্রেট কোড!"));
      }
    } else {
      if (!forgotNewPass.trim()) {
        setForgotError(t("Please enter a new password!", "নতুন পাসওয়ার্ড লিখুন!"));
        return;
      }
      if (loginRole === "admin") {
        setAdminPassword(forgotNewPass);
        cloudSet('madina_v7_admin_pass', forgotNewPass);
        setNewPasswordInput(forgotNewPass);
      } else {
        setStaffPassword(forgotNewPass);
        cloudSet('madina_v7_staff_pass', forgotNewPass);
        setNewStaffPasswordInput(forgotNewPass);
      }
      alert(t("Password reset successfully!", "পাসওয়ার্ড সফলভাবে পরিবর্তন হয়েছে!"));
      setShowForgotPass(false);
      setForgotStep("secret");
      setForgotSecretInput("");
      setForgotNewPass("");
    }
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

  const checkShouldRenderTabOption = (tabKey: string) => {
    if (currentUserRole === "ADMIN") return true;
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
      id: Date.now(),
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
  const handleBulkPurchaseMasterSubmit = () => {
    if (!pCompanyName.trim()) return alert(t("Please enter Company name!", "কোম্পানির নাম লিখুন!"));
    if (purchaseCart.length === 0) return alert(t("Purchase list is empty!", "ক্রয় তালিকা খালি!"));

    const today = new Date();
    const formattedTime = today.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const formattedDate = today.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' });

    const totalVoucherCost = purchaseCart.reduce((sum, item) => sum + item.totalCost, 0);
    const paidAmt = pAmountPaid ? parseFloat(pAmountPaid) : totalVoucherCost;
    const dueAmt = Math.max(0, totalVoucherCost - paidAmt);

    let updatedMeds = [...medicines];
    let newPurchaseLogs = [...purchaseList];
    let currentCompanies = [...bdMedicineCompanies];
    let currentMedNames = [...bdMedicineNamesList];

    const trimmedCompany = pCompanyName.trim();
    if (trimmedCompany && !currentCompanies.some(c => c.toLowerCase() === trimmedCompany.toLowerCase())) {
      currentCompanies.push(trimmedCompany);
      setBdMedicineCompanies(currentCompanies);
      cloudSet('madina_v7_companies', JSON.stringify(currentCompanies));
    }

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

      const existingIdx = updatedMeds.findIndex(m => m.name.toLowerCase() === item.medicineName.toLowerCase());
      if (existingIdx !== -1) {
        updatedMeds[existingIdx] = {
          ...updatedMeds[existingIdx],
          stock: updatedMeds[existingIdx].stock + item.quantity,
          buyPrice: item.unitPrice,
          price: item.retailPrice,
          supplier: trimmedCompany,
          category: item.category,
          generic: item.genericName !== "N/A" ? item.genericName : updatedMeds[existingIdx].generic,
          rack: item.rackLocation !== "N/A" ? item.rackLocation : updatedMeds[existingIdx].rack,
          expire: item.expireDate
        };
      } else {
        updatedMeds.push({
          id: Date.now() + Math.random(),
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

      newPurchaseLogs.unshift({
        id: Date.now() + Math.random(),
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

    setMedicines(updatedMeds);
    setPurchaseList(newPurchaseLogs);
    cloudSet('madina_v7_meds', JSON.stringify(updatedMeds));
    cloudSet('madina_v7_purchases', JSON.stringify(newPurchaseLogs));

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
  const handleSaveNewProduct = (e: React.FormEvent) => {
    e.preventDefault();
    if (!npMedicineName.trim()) return alert(t("Please enter medicine name!", "ওষুধের নাম লিখুন!"));
    if (!npBuyPrice || !npSalePrice) return alert(t("Please enter buy price and sale price!", "ক্রয় মূল্য এবং বিক্রয় মূল্য লিখুন!"));

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
  };

  const handleEditFormChange = (field: string, value: any) => {
    setEditFormData({ ...editFormData, [field]: value });
  };

  const saveEditedMedicine = (id: number) => {
    const updatedStock = parseInt(editFormData.stock);
    if (isNaN(updatedStock) || updatedStock < 0) { alert(t("Please enter valid stock!", "সঠিক স্টক সংখ্যা দিন!")); return; }
    const updated = medicines.map(m => m.id === id ? {
      ...editFormData,
      buyPrice: parseFloat(editFormData.buyPrice) || 0,
      price: parseFloat(editFormData.price) || 0,
      stock: updatedStock,
      lowStockAlert: parseInt(editFormData.lowStockAlert) || 10
    } : m);
    setMedicines(updated);
    cloudSet('madina_v7_meds', JSON.stringify(updated));
    setEditingId(null);
    alert(t("✅ Medicine updated!", "✅ ওষুধ আপডেট হয়েছে!"));
  };

  const deleteMedicine = (id: number) => {
    if (confirm(t("Are you sure you want to delete this medicine?", "এই ওষুধটি মুছে ফেলবেন?"))) {
      const updated = medicines.filter(m => m.id !== id);
      setMedicines(updated);
      cloudSet('madina_v7_meds', JSON.stringify(updated));
    }
  };

  // ============================================================
  // POS / CART
  // ============================================================
  const addToCart = (med: any) => {
    const originalMed = medicines.find(m => m.id === med.id);
    if (!originalMed || originalMed.stock === 0) { playSound('error'); return alert(t("Out of stock!", "স্টক নেই!")); }
    if (new Date(originalMed.expire) < new Date()) { playSound('error'); return alert(t("⚠️ This medicine is expired!", "⚠️ এই ওষুধটির মেয়াদ শেষ!")); }
    playSound('add');

    const existing = cart.find(item => item.id === med.id);
    let updatedCart = [];
    if (existing) {
      updatedCart = cart.map(item => item.id === med.id ? { ...item, qty: (parseInt(item.qty) || 0) + 1 } : item);
    } else {
      updatedCart = [...cart, { ...med, qty: 1 }];
    }
    setCart(updatedCart);

    const updatedMeds = medicines.map(item => item.id === med.id ? { ...item, stock: item.stock - 1 } : item);
    setMedicines(updatedMeds);
  };

  const removeFromCart = (itemToRemove: any) => {
    setCart(cart.filter(item => item.id !== itemToRemove.id));
    const currentCartQty = parseInt(itemToRemove.qty) || 0;
    const updatedMeds = medicines.map(item => item.id === itemToRemove.id ? { ...item, stock: item.stock + currentCartQty } : item);
    setMedicines(updatedMeds);
  };

  const handleQuantityChange = (itemId: number, newQtyValue: string) => {
    const existingCartItem = cart.find(item => item.id === itemId);
    const originalMed = medicines.find(m => m.id === itemId);
    if (!existingCartItem || !originalMed) return;

    if (newQtyValue === "") {
      const currentCartQty = parseInt(existingCartItem.qty) || 0;
      const totalStockToRestore = originalMed.stock + currentCartQty;
      const updatedMeds = medicines.map(m => m.id === itemId ? { ...m, stock: totalStockToRestore } : m);
      setCart(cart.map(item => item.id === itemId ? { ...item, qty: "" } : item));
      setMedicines(updatedMeds);
      return;
    }

    const parsedQty = parseInt(newQtyValue);
    if (isNaN(parsedQty) || parsedQty < 0) return;
    const currentCartQty = parseInt(existingCartItem.qty) || 0;
    const currentTotalAvailable = originalMed.stock + currentCartQty;

    if (parsedQty > currentTotalAvailable) { alert(t(`⚠️ Max available: ${currentTotalAvailable} pcs`, `⚠️ সর্বোচ্চ ${currentTotalAvailable} টি পাওয়া যাবে`)); return; }

    const stockDifference = parsedQty - currentCartQty;
    const updatedMeds = medicines.map(m => m.id === itemId ? { ...m, stock: m.stock - stockDifference } : m);
    setCart(cart.map(item => item.id === itemId ? { ...item, qty: parsedQty } : item));
    setMedicines(updatedMeds);
  };

  const handleCheckoutIntent = () => {
    if (cart.length === 0) return alert(t("Cart is empty!", "কার্ট খালি!"));
    const hasEmptyQty = cart.some(item => item.qty === "" || item.qty === 0);
    if (hasEmptyQty) return alert(t("⚠️ Please enter valid quantities!", "⚠️ সঠিক পরিমাণ দিন!"));
    setCalculatorInput("");
    setShowConfirmModal(true);
  };

  const currentSubTotal = useMemo(() => cart.reduce((sum, item) => sum + (item.price * (parseInt(item.qty) || 0)), 0), [cart]);
  const calculatedVatAmount = (currentSubTotal * (parseFloat(vatPercentage) || 0)) / 100;
  const activeDiscountAmount = discountType === "PERCENT"
    ? (currentSubTotal * (parseFloat(discountValue) || 0)) / 100
    : (parseFloat(discountValue) || 0);
  const currentFinalBill = Math.max(0, currentSubTotal + calculatedVatAmount - activeDiscountAmount);
  const liveRefundAmount = (parseFloat(calculatorInput) || 0) - currentFinalBill;

  const executeFinalCheckout = () => {
    const totalCost = cart.reduce((sum, item) => sum + (item.buyPrice * (parseInt(item.qty) || 0)), 0);
    const dueAmt = parseFloat(invoiceDue) || 0;
    const paidCash = currentFinalBill - dueAmt;
    // Full profit added immediately regardless of cash or due
    const netProfit = currentFinalBill - totalCost;

    const today = new Date();
    const formattedTime = today.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const formattedDate = today.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' });

    const newInvoice = {
      invoiceId: `M-${Date.now().toString().slice(-6)}`,
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
      cashReceived: parseFloat(cashReceived) || currentFinalBill,
      due: dueAmt,
      changeAmount: (parseFloat(cashReceived) || currentFinalBill) - currentFinalBill,
      footerMsg: receiptFooterMsg,
      isReturned: false,
      returnDetails: null
    };

    const updatedInvoices = [newInvoice, ...invoices];
    setInvoices(updatedInvoices);
    setTotalSales(totalSales + currentFinalBill);
    setTotalProfit(totalProfit + netProfit);
    setLastInvoice(newInvoice);

    cloudSet('madina_v7_sales', (totalSales + currentFinalBill).toString());
    cloudSet('madina_v7_profit', (totalProfit + netProfit).toString());
    cloudSet('madina_v7_invoices', JSON.stringify(updatedInvoices));
    cloudSet('madina_v7_meds', JSON.stringify(medicines));

    let updatedDueList = [...dueList];

    // If customer had existing due and is paying it off now
    if (selectedExistingDue) {
      const prevDueAmt = selectedExistingDue.totalDue;
      const cashGiven = parseFloat(cashReceived) || currentFinalBill;
      const totalOwed = currentFinalBill + prevDueAmt;
      const prevDuePaid = Math.max(0, Math.min(prevDueAmt, cashGiven - (currentFinalBill - dueAmt)));

      if (prevDuePaid > 0) {
        const newPrevDue = prevDueAmt - prevDuePaid;
        // Add to sales (was previously not counted as today's sale)
        const salesWithPrevDue = totalSales + currentFinalBill + prevDuePaid;
        setTotalSales(salesWithPrevDue);
        cloudSet('madina_v7_sales', salesWithPrevDue.toString());

        // Log due collection
        const logEntry = {
          id: Date.now() + 1,
          customerName: selectedExistingDue.customerName,
          amount: prevDuePaid,
          dateString: formattedDate,
          date: today.toISOString()
        };
        const updatedLog = [logEntry, ...dueCollectionLog];
        setDueCollectionLog(updatedLog);
        cloudSet('madina_v7_due_collection_log', JSON.stringify(updatedLog));

        // Update or remove previous due entry
        if (newPrevDue <= 0) {
          updatedDueList = updatedDueList.filter(d => d.id !== selectedExistingDue.id);
        } else {
          updatedDueList = updatedDueList.map(d =>
            d.id === selectedExistingDue.id ? { ...d, totalDue: newPrevDue } : d
          );
        }
      }
    }

    if (dueAmt > 0) {
      const effectiveName = customerName.trim() || t("Regular Customer", "সাধারণ গ্রাহক");
      const effectivePhone = customerPhone || "N/A";
      const existingDueIdx = updatedDueList.findIndex(d => d.customerName.toLowerCase() === effectiveName.toLowerCase() && d.phone === effectivePhone);
      if (existingDueIdx !== -1) {
        updatedDueList[existingDueIdx] = {
          ...updatedDueList[existingDueIdx],
          totalDue: updatedDueList[existingDueIdx].totalDue + dueAmt,
          invoices: [...updatedDueList[existingDueIdx].invoices, { invoiceId: newInvoice.invoiceId, amount: dueAmt, date: formattedDate }]
        };
      } else {
        updatedDueList.push({
          id: Date.now(),
          customerName: effectiveName,
          phone: effectivePhone,
          totalDue: dueAmt,
          invoices: [{ invoiceId: newInvoice.invoiceId, amount: dueAmt, date: formattedDate }]
        });
      }
    }

    setDueList(updatedDueList);
    cloudSet('madina_v7_due_list', JSON.stringify(updatedDueList));

    setCart([]); setCustomerName(""); setCustomerPhone(""); setDiscountValue("0"); setCashReceived(""); setInvoiceDue("0");
    setSelectedExistingDue(null);
    setShowCustomerPanel(false);
    setShowConfirmModal(false);
    setShowSuccessAlert(true);
    playSound('checkout');
    addToast(t("✅ Invoice created successfully!", "✅ বিল তৈরি সফল হয়েছে!"), 'success');
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
  };

  const handleReturnItemQtyChange = (itemId: number, maxQty: number, value: string) => {
    const parsed = parseInt(value) || 0;
    if (parsed < 0) return;
    if (parsed > maxQty) { alert(t(`⚠️ Cannot return more than ${maxQty} pcs!`, `⚠️ সর্বোচ্চ ${maxQty} টি ফেরত দেওয়া যাবে!`)); return; }
    setReturnItemsQuantities({ ...returnItemsQuantities, [itemId]: parsed });
  };

  const processInvoiceMedicineReturn = () => {
    if (!selectedInvoiceForReturn) return;
    const totalReturnItemsCount = Object.values(returnItemsQuantities).reduce((a, b) => a + b, 0);
    if (totalReturnItemsCount === 0) { alert(t("⚠️ Please select at least 1 quantity to return!", "⚠️ কমপক্ষে ১টি পরিমাণ নির্বাচন করুন!")); return; }

    let calculatedRefundAmount = 0;
    let calculatedCostSavingsToSubtract = 0;
    const returnedItemsSummaryList: any[] = [];
    let updatedMeds = [...medicines];

    selectedInvoiceForReturn.items.forEach((item: any) => {
      const returnQty = returnItemsQuantities[item.id] || 0;
      if (returnQty > 0) {
        calculatedRefundAmount += (item.price * returnQty);
        calculatedCostSavingsToSubtract += (item.buyPrice * returnQty);
        returnedItemsSummaryList.push({ id: item.id, name: item.name, qtyReturned: returnQty, pricePerUnit: item.price });
        const targetMedIndex = updatedMeds.findIndex(m => m.id === item.id);
        if (targetMedIndex !== -1) updatedMeds[targetMedIndex].stock += returnQty;
      }
    });

    const originalSubtotal = selectedInvoiceForReturn.subTotal;
    if (originalSubtotal > 0) {
      const ratio = calculatedRefundAmount / originalSubtotal;
      const proportionalDiscount = selectedInvoiceForReturn.discount * ratio;
      const proportionalVat = selectedInvoiceForReturn.vat * ratio;
      calculatedRefundAmount = Math.max(0, calculatedRefundAmount + proportionalVat - proportionalDiscount);
    }

    let newSalesState = totalSales;
    let newProfitState = totalProfit;

    if (returnActionType === "CASH_REFUND") {
      newSalesState -= calculatedRefundAmount;
      newProfitState -= (calculatedRefundAmount - calculatedCostSavingsToSubtract);
    } else {
      newProfitState -= (calculatedRefundAmount - calculatedCostSavingsToSubtract);
      setDiscountType("TK");
      setDiscountValue(calculatedRefundAmount.toFixed(2));
      setCustomerName(selectedInvoiceForReturn.customer);
      setCustomerPhone(selectedInvoiceForReturn.phone);
      alert(t(`💳 Store credit of ${calculatedRefundAmount.toFixed(1)} ${currencySymbol} generated!`, `💳 ${calculatedRefundAmount.toFixed(1)} ${currencySymbol} স্টোর ক্রেডিট তৈরি হয়েছে!`));
      setActiveTab("pos");
    }

    const updatedInvoices = invoices.map((inv: any) => {
      if (inv.invoiceId === selectedInvoiceForReturn.invoiceId) {
        return {
          ...inv,
          isReturned: true,
          finalBill: inv.finalBill - calculatedRefundAmount,
          profit: inv.profit - (calculatedRefundAmount - calculatedCostSavingsToSubtract),
          returnDetails: {
            returnedItems: returnedItemsSummaryList,
            refundedAmount: calculatedRefundAmount,
            action: returnActionType,
            reason: returnReason || t("General Exchange Request", "সাধারণ ফেরত"),
            timestamp: new Date().toLocaleDateString() + " | " + new Date().toLocaleTimeString()
          }
        };
      }
      return inv;
    });

    setMedicines(updatedMeds);
    setInvoices(updatedInvoices);
    setTotalSales(newSalesState);
    setTotalProfit(newProfitState);
    cloudSet('madina_v7_meds', JSON.stringify(updatedMeds));
    cloudSet('madina_v7_invoices', JSON.stringify(updatedInvoices));
    cloudSet('madina_v7_sales', newSalesState.toString());
    cloudSet('madina_v7_profit', newProfitState.toString());

    setShowReturnModal(false);
    setSelectedInvoiceForReturn(null);
    alert(t("✅ Return processed successfully!", "✅ ফেরত সফলভাবে প্রক্রিয়া করা হয়েছে!"));
  };

  // ============================================================
  // DUE PAYMENT
  // ============================================================
  const handleDuePayment = () => {
    if (!duePaymentModal) return;
    const payAmt = parseFloat(duePayAmount) || 0;
    if (payAmt <= 0) { alert(t("Please enter a valid amount!", "সঠিক পরিমাণ দিন!")); return; }
    if (payAmt > duePaymentModal.totalDue) { alert(t(`Maximum payable is ${duePaymentModal.totalDue.toFixed(1)} ${currencySymbol}`, `সর্বোচ্চ পরিশোধ ${duePaymentModal.totalDue.toFixed(1)} ${currencySymbol}`)); return; }

    const newTotalDue = duePaymentModal.totalDue - payAmt;
    const updatedDueList = newTotalDue <= 0
      ? dueList.filter(d => d.id !== duePaymentModal.id)
      : dueList.map(d => d.id === duePaymentModal.id ? { ...d, totalDue: newTotalDue } : d);

    // Add collected cash to sales (profit was already counted at sale time)
    const newTotalSales = totalSales + payAmt;
    setTotalSales(newTotalSales);
    cloudSet('madina_v7_sales', newTotalSales.toString());

    // Log this collection with date for dashboard due collection stats
    const today = new Date();
    const logEntry = {
      id: Date.now(),
      customerName: duePaymentModal.customerName,
      amount: payAmt,
      dateString: today.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' }),
      date: today.toISOString()
    };
    const updatedLog = [logEntry, ...dueCollectionLog];
    setDueCollectionLog(updatedLog);
    cloudSet('madina_v7_due_collection_log', JSON.stringify(updatedLog));

    setDueList(updatedDueList);
    cloudSet('madina_v7_due_list', JSON.stringify(updatedDueList));
    setDuePaymentModal(null);
    setDuePayAmount("");
    alert(t(`✅ Payment of ${payAmt.toFixed(1)} ${currencySymbol} recorded!`, `✅ ${payAmt.toFixed(1)} ${currencySymbol} পরিশোধ নথিভুক্ত হয়েছে!`));
  };

  // ============================================================
  // SETTINGS
  // ============================================================
  const handleVerifyCurrentPassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (currentPassCheck === adminPassword) {
      setIsCredentialsFormUnlocked(true);
      setCurrentPassCheck("");
    } else {
      alert(t("❌ Wrong current password!", "❌ ভুল পাসওয়ার্ড!"));
      setCurrentPassCheck("");
    }
  };

  const handleSaveNewCredentials = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsernameInput.trim() || !newPasswordInput.trim()) { alert(t("⚠️ Fields cannot be empty!", "⚠️ ফিল্ড খালি রাখা যাবে না!")); return; }
    setAdminUsername(newUsernameInput);
    setAdminPassword(newPasswordInput);
    setStaffUsername(newStaffUsernameInput);
    setStaffPassword(newStaffPasswordInput);
    setSecretCode(newSecretCodeInput);
    cloudSet('madina_v7_admin_user', newUsernameInput);
    cloudSet('madina_v7_admin_pass', newPasswordInput);
    cloudSet('madina_v7_staff_user', newStaffUsernameInput);
    cloudSet('madina_v7_staff_pass', newStaffPasswordInput);
    cloudSet('madina_v7_secret_code', newSecretCodeInput);
    setIsCredentialsFormUnlocked(false);
    alert(t("✅ Credentials updated!", "✅ লগইন তথ্য আপডেট হয়েছে!"));
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
      // Preserve clean_start flag so first-boot block does NOT re-run on next load
      const keysToKeep = ['madina_v7_clean_start_2026', 'madina_v7_dark', 'madina_v7_theme', 'madina_v7_sound', 'madina_v7_language'];
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
      setPharmacyName("Madina Medicine Corner");
      setPharmacySlogan("Professional Pharmacy POS System");
      setPharmacyAddress("Chaumuhani Bazar, Cumilla");
      setPharmacyLogo("M+");
      setCurrencySymbol("৳"); setVatPercentage("0"); setLowStockThreshold("10");
      setReceiptFooterMsg("ধন্যবাদ, আবার আসবেন!");
      setThemeMode('light');
      setAdminUsername("admin"); setAdminPassword("2026");
      setStaffUsername("staff"); setStaffPassword("staff123");
      setSecretCode("MADINA2026");

      // Push clean data to localStorage AND Firebase so all devices reset properly
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
      cloudSet('madina_v7_secret_code', 'MADINA2026');
      cloudSet('madina_v7_name', 'Madina Medicine Corner');
      cloudSet('madina_v7_slogan', 'Professional Pharmacy POS System');
      cloudSet('madina_v7_address', 'Chaumuhani Bazar, Cumilla');
      cloudSet('madina_v7_logo', 'M+');
      cloudSet('madina_v7_currency', '৳');
      cloudSet('madina_v7_vat', '0');
      cloudSet('madina_v7_threshold', '10');
      cloudSet('madina_v7_footer', 'ধন্যবাদ, আবার আসবেন!');

      setIsLoggedIn(false);
      alert(t("✅ System reset successful!", "✅ সিস্টেম রিসেট সম্পন্ন!"));
    }
  };

  // ============================================================
  // BACKUP & RESTORE FUNCTIONS
  // ============================================================

  // সব important data একটা object এ জড়ো করে JSON ফাইল বানাও
  const buildBackupObject = () => {
    const backupData: Record<string, any> = {};
    for (const key of CLOUD_SYNC_KEYS) {
      const val = localStorage.getItem(key);
      if (val !== null) backupData[key] = val;
    }
    return backupData;
  };

  // JSON ফাইল ডাউনলোড করো (Browser download — PC/Android/iOS সব জায়গায় কাজ করে)
  const handleDownloadBackup = () => {
    setIsBackingUp(true);
    try {
      const now = new Date();
      const dateStr = now.toLocaleDateString('bn-BD', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
      const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).replace(':', '-');
      const filename = `MadinaPOS_Backup_${dateStr}_${timeStr}.json`;

      const backupObj = {
        _madina_backup_version: "v7",
        _backup_date: now.toISOString(),
        _backup_date_bn: now.toLocaleString('bn-BD'),
        _pharmacy_name: pharmacyName,
        data: buildBackupObject()
      };

      const blob = new Blob([JSON.stringify(backupObj, null, 2)], { type: 'application/json' });
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
    } catch (err) {
      addToast(t("❌ Backup failed! Try again.", "❌ ব্যাকআপ ব্যর্থ হয়েছে!"), 'error');
    }
    setIsBackingUp(false);
  };

  // Firebase এ আলাদা backup node এ push করো
  const handleFirebaseBackup = async () => {
    if (!isFirebaseConfigured()) {
      addToast(t("⚠️ Firebase not configured!", "⚠️ Firebase সেটআপ করা নেই!"), 'error');
      return;
    }
    setIsBackingUp(true);
    try {
      const now = new Date();
      const backupObj = {
        _backup_date: now.toISOString(),
        _backup_date_bn: now.toLocaleString('bn-BD'),
        _pharmacy_name: pharmacyName,
        data: buildBackupObject()
      };
      const backupKey = `backup_${now.toISOString().slice(0,10)}`;
      const url = `${FIREBASE_CONFIG.databaseURL}/madina_backups/${backupKey}.json`;
      const res = await fetchWithTimeout(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(backupObj),
      }, 15000);
      if (res.ok) {
        const nowStr = now.toLocaleString('bn-BD');
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

  // JSON ফাইল থেকে রিস্টোর করো
  const handleRestoreFromFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.json')) {
      addToast(t("❌ Only .json backup files accepted!", "❌ শুধু .json ব্যাকআপ ফাইল গ্রহণযোগ্য!"), 'error');
      return;
    }
    const confirmRestore = window.confirm(
      t("⚠️ This will REPLACE all current data with backup data. Are you sure?",
        "⚠️ এটি বর্তমান সব তথ্য মুছে ব্যাকআপের তথ্য দিয়ে প্রতিস্থাপন করবে। নিশ্চিত?")
    );
    if (!confirmRestore) { e.target.value = ""; return; }

    setIsRestoring(true);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        if (!parsed._madina_backup_version || !parsed.data) {
          addToast(t("❌ Invalid backup file!", "❌ ব্যাকআপ ফাইল সঠিক নয়!"), 'error');
          setIsRestoring(false);
          return;
        }
        // localStorage এ সব key restore করো
        for (const [key, val] of Object.entries(parsed.data)) {
          if (typeof val === 'string') {
            localStorage.setItem(key, val);
            if (CLOUD_SYNC_KEYS.includes(key)) fbSet(key, val);
          }
        }
        const nowStr = new Date().toLocaleString('bn-BD');
        setLastBackupTime(nowStr);
        localStorage.setItem('madina_v7_last_backup', nowStr);
        playSound('success');
        addToast(t("✅ Data restored! Reloading...", "✅ ডেটা পুনরুদ্ধার হয়েছে! রিলোড হচ্ছে..."), 'success');
        setTimeout(() => window.location.reload(), 1500);
      } catch {
        addToast(t("❌ Restore failed! File may be corrupted.", "❌ রিস্টোর ব্যর্থ! ফাইলটি নষ্ট হতে পারে।"), 'error');
      }
      setIsRestoring(false);
      e.target.value = "";
    };
    reader.readAsText(file);
  };

  // Auto daily backup reminder — প্রতিদিন একবার remind করবে যদি আজ ব্যাকআপ না হয়
  useEffect(() => {
    const checkDailyBackupReminder = () => {
      const last = localStorage.getItem('madina_v7_last_backup');
      if (!last) return; // প্রথমবার install এ remind করব না
      try {
        const lastDate = new Date(last);
        const today = new Date();
        const diffHours = (today.getTime() - lastDate.getTime()) / (1000 * 60 * 60);
        if (diffHours >= 24) {
          addToast(
            t("💾 Reminder: Last backup was over 24 hours ago! Please backup now.",
              "💾 স্মরণ করিয়ে দিচ্ছি: ২৪ ঘণ্টারও বেশি সময় ব্যাকআপ হয়নি! এখনই ব্যাকআপ করুন।"),
            'info'
          );
        }
      } catch {}
    };
    // লগইন করলে একবার চেক করো
    if (isLoggedIn) {
      const timer = setTimeout(checkDailyBackupReminder, 3000);
      return () => clearTimeout(timer);
    }
  }, [isLoggedIn]);

  // ============================================================
  // COMPUTED VALUES — wrapped in useMemo to prevent recalculation on every render
  // ============================================================
  const grandTotalPurchaseCost = useMemo(() => purchaseList.reduce((sum, item) => sum + (item.totalCost || 0), 0), [purchaseList]);
  const grandTotalPurchaseDue = useMemo(() => purchaseList.reduce((sum, item) => sum + (item.due || 0), 0), [purchaseList]);
  const bulkCartTotalCost = useMemo(() => purchaseCart.reduce((sum, item) => sum + item.totalCost, 0), [purchaseCart]);
  const bulkCartCalculatedDue = useMemo(() => Math.max(0, bulkCartTotalCost - (parseFloat(pAmountPaid) || 0)), [bulkCartTotalCost, pAmountPaid]);

  const filteredMedicines = useMemo(() => medicines.filter(med => {
    const matchesSearch = med.name.toLowerCase().includes(searchTerm.toLowerCase()) || (med.generic || "").toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === "All" || med.category === selectedCategory;
    return matchesSearch && matchesCategory;
  }), [medicines, searchTerm, selectedCategory]);

  const filteredInvoices = useMemo(() => invoices.filter(inv => {
    const query = searchInvoiceQuery.toLowerCase();
    return inv.invoiceId.toLowerCase().includes(query) || inv.customer.toLowerCase().includes(query) || inv.phone.toLowerCase().includes(query);
  }), [invoices, searchInvoiceQuery]);

  const activeThreshold = useMemo(() => parseInt(lowStockThreshold) || 10, [lowStockThreshold]);
  const lowStockMedicines = useMemo(() => medicines.filter(m => m.stock <= (m.lowStockAlert || activeThreshold)), [medicines, activeThreshold]);
  const expiredMedicines = useMemo(() => medicines.filter(m => new Date(m.expire) < new Date()), [medicines]);

  const countStockByCategory = useCallback((cat: string) => medicines.filter(m => m.category === cat).reduce((sum, item) => sum + item.stock, 0), [medicines]);
  const totalStockValue = useMemo(() => medicines.reduce((sum, m) => sum + (m.buyPrice * m.stock), 0), [medicines]);
  const totalStockRetailValue = useMemo(() => medicines.reduce((sum, m) => sum + (m.price * m.stock), 0), [medicines]);
  const totalDueFromCustomers = useMemo(() => dueList.reduce((sum, d) => sum + d.totalDue, 0), [dueList]);

  const triggerPrintReceipt = () => { playSound('print'); window.print(); };

  const viewInvoiceLog = (invoice: any) => { setLastInvoice(invoice); setShowReceipt(true); };

  const deleteInvoice = (invoiceId: string) => {
    if (!confirm(t("Delete this invoice permanently?", "এই রশিদটি স্থায়ীভাবে মুছে ফেলবেন?"))) return;
    const inv = invoices.find(i => i.invoiceId === invoiceId);
    if (!inv) return;
    const updatedInvoices = invoices.filter(i => i.invoiceId !== invoiceId);
    // Subtract the invoice profit and sales from totals
    const newSales = Math.max(0, totalSales - (inv.finalBill - (inv.due || 0)));
    const newProfit = totalProfit - (inv.profit || 0);
    setInvoices(updatedInvoices);
    setTotalSales(newSales);
    setTotalProfit(newProfit);
    cloudSet('madina_v7_invoices', JSON.stringify(updatedInvoices));
    cloudSet('madina_v7_sales', newSales.toString());
    cloudSet('madina_v7_profit', newProfit.toString());
    alert(t("✅ Invoice deleted!", "✅ রশিদ মুছে ফেলা হয়েছে!"));
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

    return {
      computedDailyPurchaseAmount, computedMonthlyPurchaseAmount, computedYearlyPurchaseAmount,
      computedDailySalesAmount, computedMonthlySalesAmount, computedYearlySalesAmount,
      computedDailyProfitAmount, computedMonthlyProfitAmount, computedYearlyProfitAmount,
      computedDailyDue, computedMonthlyDue, computedYearlyDue,
      computedDailyBkash, computedMonthlyBkash,
      computedDailyDueCollection, computedMonthlyDueCollection,
      computedDailyDiscount, computedMonthlyDiscount, computedYearlyDiscount,
    };
  }, [todayKey, invoices, purchaseList, dueCollectionLog]);

  const {
    computedDailyPurchaseAmount, computedMonthlyPurchaseAmount, computedYearlyPurchaseAmount,
    computedDailySalesAmount, computedMonthlySalesAmount, computedYearlySalesAmount,
    computedDailyProfitAmount, computedMonthlyProfitAmount, computedYearlyProfitAmount,
    computedDailyDue, computedMonthlyDue, computedYearlyDue,
    computedDailyBkash, computedMonthlyBkash,
    computedDailyDueCollection, computedMonthlyDueCollection,
    computedDailyDiscount, computedMonthlyDiscount, computedYearlyDiscount,
  } = analyticsData;

  // ============================================================
  // HYDRATION GUARD
  // ============================================================
  if (!isMounted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-teal-950 to-slate-900 flex flex-col items-center justify-center gap-4">
        <style>{`
          @keyframes spin-slow { to { transform: rotate(360deg); } }
          @keyframes pulse-ring { 0%,100%{transform:scale(1);opacity:0.6} 50%{transform:scale(1.15);opacity:0.3} }
          @keyframes fadein { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
        `}</style>
        <div className="relative">
          <div style={{animation:'spin-slow 2s linear infinite'}} className="w-16 h-16 rounded-full border-4 border-teal-500/20 border-t-teal-400"></div>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-2xl">💊</span>
          </div>
        </div>
        <p style={{animation:'fadein 0.5s ease'}} className="text-teal-400 font-bold text-sm tracking-widest uppercase">Loading...</p>
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
      <div className={`min-h-screen flex items-center justify-center p-4 relative overflow-hidden ${isDarkMode ? 'bg-slate-900' : 'bg-gradient-to-br from-teal-50 via-emerald-50 to-slate-100'}`} style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-bg'] } : {}}>
        {/* Animated background CSS */}
        <style>{`
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
          .animate-tab-content { animation: tab-content 0.25s ease forwards; }
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
        `}</style>

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
              <span className="animate-clock font-mono font-black text-2xl text-teal-500 tracking-widest">{liveTime}</span>
              <span className={`text-sm font-semibold tracking-wide ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{liveDate} · {liveDay}</span>
            </div>
          </div>

          <div className={`rounded-2xl shadow-2xl border p-6 ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white/95 border-slate-200'}`} style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-card'], borderColor: (activeThemeStyle as any)['--theme-border'], color: (activeThemeStyle as any)['--theme-text'] } : {}}>

            {/* Logo */}
            <div className="text-center mb-6">
              <div className="animate-logo-pulse w-16 h-16 rounded-2xl bg-gradient-to-tr from-teal-500 to-emerald-400 flex items-center justify-center text-white shadow-lg font-black text-xl mx-auto mb-3">{pharmacyLogo}</div>
              <h1 className="font-black text-lg text-teal-600">{pharmacyName}</h1>
              <p className={`text-sm font-semibold mt-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{pharmacySlogan}</p>
            </div>

          {!showForgotPass ? (
            <>
              {/* Login Type Toggle */}
              <div className={`flex p-1 rounded-xl mb-4 ${isDarkMode ? 'bg-slate-900' : 'bg-slate-100'}`}>
                <button onClick={() => setLoginRole("admin")} className={`flex-1 py-2 rounded-lg text-sm font-black transition-all btn-press ${loginRole === "admin" ? 'bg-teal-500 text-white shadow' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                  👑 {t("Admin", "অ্যাডমিন")}
                </button>
                <button onClick={() => setLoginRole("staff")} className={`flex-1 py-2 rounded-lg text-sm font-black transition-all btn-press ${loginRole === "staff" ? 'bg-indigo-500 text-white shadow' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
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
                    className={`w-full px-3 py-2 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-teal-500/30 transition-all ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
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
                      className={`w-full px-3 py-2 rounded-xl border text-sm outline-none focus:ring-2 focus:ring-teal-500/30 transition-all pr-10 ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                    />
                    <button type="button" onClick={() => setShowLoginPass(!showLoginPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">{showLoginPass ? "🙈" : "👁️"}</button>
                  </div>
                </div>

                {loginError && <p className="text-red-500 text-sm font-bold text-center">{loginError}</p>}

                <button onClick={handleLogin} disabled={loginLoading} className="w-full bg-gradient-to-r from-teal-500 to-emerald-500 text-white font-black py-2.5 rounded-xl text-sm hover:from-teal-600 hover:to-emerald-600 transition-all shadow-md mt-1 btn-press disabled:opacity-60 relative overflow-hidden">
                  {loginLoading ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full" style={{animation:'spin-slow 0.8s linear infinite'}}></span>
                      {t("Verifying...", "যাচাই হচ্ছে...")}
                    </span>
                  ) : <>🔐 {t("Login", "লগইন")}</>}
                </button>

                <button onClick={() => { setShowForgotPass(true); setForgotStep("secret"); setForgotError(""); }} className="text-teal-500 text-sm font-bold hover:underline text-center">
                  {t("Forgot Password?", "পাসওয়ার্ড ভুলে গেছেন?")}
                </button>
              </div>

              {/* Language Toggle on login */}
              <div className="flex justify-center mt-4 gap-2">
                <button onClick={() => handleLanguageChange("en")} className={`px-3 py-1 rounded-lg text-sm font-bold transition btn-press ${language === "en" ? 'bg-teal-500 text-white' : isDarkMode ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>EN</button>
                <button onClick={() => handleLanguageChange("bn")} className={`px-3 py-1 rounded-lg text-sm font-bold transition btn-press ${language === "bn" ? 'bg-teal-500 text-white' : isDarkMode ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>বাং</button>
              </div>
            </>
          ) : (
            <>
              <h3 className="text-sm font-black text-center text-teal-500 mb-4">{t("Reset Password", "পাসওয়ার্ড রিসেট")}</h3>
              {forgotStep === "secret" ? (
                <div className="flex flex-col gap-3">
                  <p className={`text-sm text-center ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Enter your Secret Code to verify identity:", "পরিচয় যাচাইয়ের জন্য সিক্রেট কোড দিন:")}</p>
                  <input
                    type="text"
                    value={forgotSecretInput}
                    onChange={e => setForgotSecretInput(e.target.value)}
                    placeholder={t("Secret Code...", "সিক্রেট কোড...")}
                    className={`w-full px-3 py-2 rounded-xl border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                  />
                  {forgotError && <p className="text-red-500 text-sm font-bold text-center">{forgotError}</p>}
                  <button onClick={handleForgotPassword} className="w-full bg-teal-500 text-white font-black py-2.5 rounded-xl text-sm hover:bg-teal-600 transition btn-press">{t("Verify Code", "কোড যাচাই করুন")}</button>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <p className={`text-sm text-center text-emerald-500 font-bold`}>{t("✅ Identity Verified! Set new password:", "✅ পরিচয় যাচাই হয়েছে! নতুন পাসওয়ার্ড দিন:")}</p>
                  <input
                    type="password"
                    value={forgotNewPass}
                    onChange={e => setForgotNewPass(e.target.value)}
                    placeholder={t("New Password...", "নতুন পাসওয়ার্ড...")}
                    className={`w-full px-3 py-2 rounded-xl border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                  />
                  {forgotError && <p className="text-red-500 text-sm font-bold text-center">{forgotError}</p>}
                  <button onClick={handleForgotPassword} className="w-full bg-emerald-500 text-white font-black py-2.5 rounded-xl text-sm hover:bg-emerald-600 transition btn-press">{t("Reset Password", "পাসওয়ার্ড রিসেট")}</button>
                </div>
              )}
              <button onClick={() => { setShowForgotPass(false); setForgotStep("secret"); setForgotSecretInput(""); setForgotNewPass(""); setForgotError(""); }} className="w-full text-slate-400 text-sm font-bold mt-3 hover:underline">← {t("Back to Login", "লগইনে ফিরুন")}</button>
            </>
          )}
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
      className={`min-h-screen font-sans flex flex-col selection:bg-teal-500 selection:text-white print:bg-white print:text-black antialiased transition-colors duration-200 ${isDarkMode ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-800'}`}
      style={isCustomTheme ? {
        ...activeThemeStyle,
        backgroundColor: (activeThemeStyle as any)['--theme-bg'],
        color: (activeThemeStyle as any)['--theme-text'],
      } : {}}
    >

      {/* GLOBAL ANIMATION STYLES */}
      <style>{`
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
        .animate-login-slide { animation: login-slide-in 0.5s cubic-bezier(0.22,1,0.36,1) forwards; }
        .animate-clock { animation: clock-tick 1s ease-in-out infinite; }
        .animate-logo-pulse { animation: logo-pulse 2s ease-in-out infinite; }
        .animate-shake { animation: shake 0.5s cubic-bezier(.36,.07,.19,.97) both; }
        .animate-sidebar-item { animation: sidebar-item 0.3s ease forwards; }
        .animate-tab-content { animation: tab-content 0.25s ease forwards; }
        .animate-toast-in { animation: toast-in 0.35s cubic-bezier(0.22,1,0.36,1) forwards; }
        .animate-badge-pop { animation: badge-pop 0.3s ease; }
        .btn-press { transition: transform 0.12s, box-shadow 0.12s; }
        .btn-press:active { transform: scale(0.95) !important; }
        .card-hover { transition: transform 0.2s, box-shadow 0.2s; }
        .card-hover:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
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
        /* ── Colorful card border system ── */
        .ccard { border-width: 2px !important; border-style: solid !important; }
        .cc-teal    { border-color: #0d9488 !important; }
        .cc-indigo  { border-color: #6366f1 !important; }
        .cc-amber   { border-color: #f59e0b !important; }
        .cc-emerald { border-color: #10b981 !important; }
        .cc-blue    { border-color: #3b82f6 !important; }
        .cc-red     { border-color: #ef4444 !important; }
        .cc-orange  { border-color: #f97316 !important; }
        .cc-violet  { border-color: #8b5cf6 !important; }
        .cc-pink    { border-color: #ec4899 !important; }
        .cc-rose    { border-color: #f43f5e !important; }
        .cc-green   { border-color: #22c55e !important; }
        .cc-slate   { border-color: #64748b !important; }
        .cc-cyan    { border-color: #06b6d4 !important; }
        .cc-purple  { border-color: #a855f7 !important; }
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
        .snav-pos     { border-width: 2px !important; border-style: solid !important; border-color: #0d9488 !important; }
        .snav-dash    { border-width: 2px !important; border-style: solid !important; border-color: #6366f1 !important; }
        .snav-stock   { border-width: 2px !important; border-style: solid !important; border-color: #f59e0b !important; }
        .snav-stockin { border-width: 2px !important; border-style: solid !important; border-color: #10b981 !important; }
        .snav-newprod { border-width: 2px !important; border-style: solid !important; border-color: #22c55e !important; }
        .snav-ph      { border-width: 2px !important; border-style: solid !important; border-color: #8b5cf6 !important; }
        .snav-inv     { border-width: 2px !important; border-style: solid !important; border-color: #3b82f6 !important; }
        .snav-due     { border-width: 2px !important; border-style: solid !important; border-color: #ef4444 !important; }
        .snav-report  { border-width: 2px !important; border-style: solid !important; border-color: #f97316 !important; }
        .snav-ret     { border-width: 2px !important; border-style: solid !important; border-color: #ec4899 !important; }
        .snav-set     { border-width: 2px !important; border-style: solid !important; border-color: #64748b !important; }
        .snav-perm    { border-width: 2px !important; border-style: solid !important; border-color: #f43f5e !important; }
        .snav-pos.bg-teal-500,.snav-dash.bg-teal-500,.snav-stock.bg-teal-500,
        .snav-stockin.bg-teal-500,.snav-newprod.bg-teal-500,.snav-ph.bg-teal-500,
        .snav-inv.bg-teal-500,.snav-due.bg-teal-500,.snav-report.bg-teal-500,
        .snav-ret.bg-teal-500,.snav-set.bg-teal-500,.snav-perm.bg-teal-500
        { border-color: rgba(255,255,255,0.45) !important; box-shadow: 0 0 10px rgba(20,184,166,0.35); }
      `}</style>

      {/* ANIMATED TOAST NOTIFICATIONS */}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
        {toastQueue.map((toast, idx) => (
          <div
            key={toast.id}
            className={`animate-toast-in pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border text-sm font-bold min-w-[220px] max-w-xs ${
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
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-md w-full px-4 py-3 rounded-xl shadow-2xl border flex items-center gap-3 ${isDarkMode ? 'bg-slate-800 border-teal-500/30 text-teal-400' : 'bg-white border-teal-200 text-teal-600'}`} style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-card'], borderColor: (activeThemeStyle as any)['--theme-border'], color: (activeThemeStyle as any)['--theme-accent'] } : {}}>
          <div className="w-8 h-8 rounded-full bg-teal-500/10 flex items-center justify-center text-lg">🎉</div>
          <div className="flex-1">
            <h5 className="font-bold text-sm">{t("Invoice Created Successfully!", "বিল তৈরি সফল হয়েছে!")}</h5>
            <p className="text-sm opacity-80">{t("Click Print to get a receipt copy.", "প্রিন্ট বাটনে ক্লিক করুন।")}</p>
          </div>
          <button onClick={() => viewInvoiceLog(invoices[0])} className="bg-teal-500 hover:bg-teal-600 text-white font-bold text-sm px-2.5 py-1 rounded uppercase tracking-wider transition">{t("View", "দেখুন")}</button>
        </div>
      )}

      {/* TOP HEADER */}
      <header
        className={`border-b sticky top-0 z-40 backdrop-blur-md px-4 py-2.5 flex items-center justify-between transition print:hidden ${isDarkMode ? 'bg-slate-900/90 border-slate-800' : 'bg-white/90 border-slate-200'}`}
        style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-bg2'] + 'f0', borderBottomColor: (activeThemeStyle as any)['--theme-border'] } : {}}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-teal-500 to-emerald-400 flex items-center justify-center text-white shadow-md font-black text-sm">{pharmacyLogo}</div>
          <div>
            <h1 className="font-black text-sm tracking-tight uppercase flex items-center gap-1.5">
              <span className="truncate max-w-[100px] sm:max-w-[180px] md:max-w-none">{pharmacyName}</span>
              <span className="text-sm font-bold bg-teal-500/10 text-teal-500 px-1.5 py-0.5 rounded-full lowercase shrink-0">v8.0</span>
            </h1>
            <p className={`text-sm font-semibold opacity-60 hidden sm:block ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{pharmacySlogan}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm">
          {/* Cloud Sync Status Badge */}
          {isFirebaseConfigured() && syncStatus !== 'idle' && (
            <div className={`hidden sm:flex items-center gap-1 px-2 py-1 rounded-lg text-sm font-bold border transition ${
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
            <div title={t("Firebase not configured — data is local only","Firebase সেটআপ হয়নি — ডেটা শুধু এই ডিভাইসে")} className={`hidden sm:flex items-center gap-1 px-2 py-1 rounded-lg text-sm font-bold border cursor-help ${isDarkMode ? 'bg-slate-700 border-slate-600 text-slate-400' : 'bg-slate-100 border-slate-200 text-slate-400'}`}>
              💾 {t("Local", "লোকাল")}
            </div>
          )}

          {/* Role Badge */}
          <div className={`hidden sm:block px-3 py-1.5 rounded-lg border text-sm font-black uppercase ${currentUserRole === "ADMIN" ? (isDarkMode ? 'bg-teal-500/20 border-teal-500/40 text-teal-400' : 'bg-teal-50 border-teal-200 text-teal-600') : (isDarkMode ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-400' : 'bg-indigo-50 border-indigo-200 text-indigo-600')}`}>
            {currentUserRole === "ADMIN" ? `👑 ${t("Admin", "অ্যাডমিন")}` : `👥 ${t("Staff", "স্টাফ")}`}
          </div>

          {/* Language Toggle */}
          <div className={`flex items-center p-0.5 rounded-lg border ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-slate-100 border-slate-200'}`}>
            <button onClick={() => handleLanguageChange("en")} className={`px-1.5 sm:px-2 py-1 rounded-md text-xs sm:text-sm font-black transition ${language === "en" ? 'bg-teal-500 text-white' : 'text-slate-400'}`}>EN</button>
            <button onClick={() => handleLanguageChange("bn")} className={`px-1.5 sm:px-2 py-1 rounded-md text-xs sm:text-sm font-black transition ${language === "bn" ? 'bg-teal-500 text-white' : 'text-slate-400'}`}>বাং</button>
          </div>

          <button onClick={() => handleToggleTheme(!isDarkMode)} className={`p-1.5 rounded-lg border transition ${isDarkMode ? 'bg-slate-800 border-slate-700 text-amber-400 hover:bg-slate-700' : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'}`} title={`Theme: ${themeMode}`}>
            {themeMode === 'light' ? "🌙" : themeMode === 'dark' ? "☀️" : themeMode === 'ocean' ? "🌊" : themeMode === 'forest' ? "🌿" : themeMode === 'royal' ? "👑" : themeMode === 'sunset' ? "🌅" : themeMode === 'cherry' ? "🌸" : themeMode === 'midnight' ? "🌌" : themeMode === 'nordic' ? "❄️" : themeMode === 'lava' ? "🌋" : themeMode === 'glacier' ? "🏔️" : "🎨"}
          </button>

          <div className={`text-right hidden sm:block text-sm ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            <span className="font-bold">{currentUserRole}</span>
            <span className="block font-mono text-teal-500 animate-clock font-black text-sm">{liveTime}</span>
            <span className="block font-mono text-sm opacity-70">{liveDate}</span>
          </div>

          <button onClick={handleLogout} className="bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white font-bold text-sm px-2 sm:px-3 py-1.5 sm:py-2 rounded-lg transition uppercase"><span className="hidden sm:inline">{t("Logout", "লগআউট")}</span><span className="sm:hidden">✕</span></button>
        </div>
      </header>

      {/* MAIN LAYOUT */}
      <div className="flex-1 flex print:block">

        {/* SIDEBAR — hidden on mobile, visible on md+ */}
        <nav className={`hidden md:flex w-52 border-r p-3 flex-col gap-1.5 shrink-0 transition print:hidden ${isDarkMode ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200'}`} style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-bg2'], borderRightColor: (activeThemeStyle as any)['--theme-border'] } : {}}>
          <span className="text-sm font-black text-slate-400 uppercase tracking-widest px-2 mb-1.5 block">{t("Menu", "মেনু")}</span>

          {checkShouldRenderTabOption("pos") && (
            <button onClick={() => { playSound('tab'); setActiveTab("pos"); }} className={`sidebar-nav-btn snav-pos w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "pos" ? 'bg-teal-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <div className="flex items-center gap-2"><span>🛒</span><span>{t("Sell", "বিক্রয়")}</span></div>
              <span className={`text-sm px-1.5 py-0.5 rounded font-mono ${activeTab === "pos" ? 'bg-white/20 text-white' : 'bg-slate-500/10 text-slate-400'}`}>{cart.length}</span>
            </button>
          )}

          {checkShouldRenderTabOption("analytics") && (
            <button onClick={() => { playSound('tab'); setActiveTab("analytics"); }} className={`sidebar-nav-btn snav-dash w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "analytics" ? 'bg-teal-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span>📊</span><span>{t("Dashboard", "ড্যাশবোর্ড")}</span>
            </button>
          )}

          {checkShouldRenderTabOption("inventory") && (
            <button onClick={() => { playSound('tab'); setActiveTab("inventory"); }} className={`sidebar-nav-btn snav-stock w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "inventory" ? 'bg-teal-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <div className="flex items-center gap-2"><span>📦</span><span>{t("Stock", "স্টক")}</span></div>
              <span className={`text-sm px-1.5 py-0.5 rounded font-mono ${activeTab === "inventory" ? 'bg-white/20 text-white' : 'bg-slate-500/10 text-slate-400'}`}>{medicines.length}</span>
            </button>
          )}

          {checkShouldRenderTabOption("procurement") && (
            <button onClick={() => { playSound('tab'); setActiveTab("procurement"); }} className={`sidebar-nav-btn snav-stockin w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "procurement" ? 'bg-teal-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <div className="flex items-center gap-2"><span>📥</span><span>{t("Stock In", "মাল কিনুন")}</span></div>
              <span className={`text-sm px-1.5 py-0.5 rounded font-mono ${activeTab === "procurement" ? 'bg-white/20 text-white' : 'bg-slate-500/10 text-slate-400'}`}>{purchaseList.length}</span>
            </button>
          )}

          {checkShouldRenderTabOption("procurement") && (
            <button onClick={() => { playSound('tab'); setActiveTab("new_product"); }} className={`sidebar-nav-btn snav-newprod w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "new_product" ? 'bg-teal-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span>➕</span><span>{t("New Product", "নতুন পণ্য")}</span>
            </button>
          )}

          {checkShouldRenderTabOption("purchase_history") && (
            <button onClick={() => { playSound('tab'); setActiveTab("purchase_history"); }} className={`sidebar-nav-btn snav-ph w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "purchase_history" ? 'bg-teal-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <div className="flex items-center gap-2"><span>🧾</span><span>{t("Purchase History", "ক্রয় ইতিহাস")}</span></div>
              <span className={`text-sm px-1.5 py-0.5 rounded font-mono ${activeTab === "purchase_history" ? 'bg-white/20 text-white' : 'bg-slate-500/10 text-slate-400'}`}>{purchaseList.length}</span>
            </button>
          )}

          {checkShouldRenderTabOption("invoices") && (
            <button onClick={() => { playSound('tab'); setActiveTab("invoices"); }} className={`sidebar-nav-btn snav-inv w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "invoices" ? 'bg-teal-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <div className="flex items-center gap-2"><span>🧾</span><span>{t("Invoices", "রশিদ")}</span></div>
              <span className={`text-sm px-1.5 py-0.5 rounded font-mono ${activeTab === "invoices" ? 'bg-white/20 text-white' : 'bg-slate-500/10 text-slate-400'}`}>{invoices.length}</span>
            </button>
          )}

          {checkShouldRenderTabOption("due_list_view") && (
            <button onClick={() => { playSound('tab'); setActiveTab("due_list"); }} className={`sidebar-nav-btn snav-due w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "due_list" ? 'bg-teal-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <div className="flex items-center gap-2"><span>💳</span><span>{t("Due List", "বাকি তালিকা")}</span></div>
              {dueList.length > 0 && <span className="text-xs px-1.5 py-0.5 rounded font-mono bg-red-500 text-white">{dueList.length}</span>}
            </button>
          )}

          {checkShouldRenderTabOption("report_view") && (
            <button onClick={() => { playSound('tab'); setActiveTab("report"); }} className={`sidebar-nav-btn snav-report w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "report" ? 'bg-teal-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span>📋</span><span>{t("Report", "রিপোর্ট")}</span>
            </button>
          )}

          {checkShouldRenderTabOption("returns") && (
            <button onClick={() => { playSound('tab'); setActiveTab("returns"); }} className={`sidebar-nav-btn snav-ret w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "returns" ? 'bg-teal-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span>🔄</span><span>{t("Returns", "ফেরত")}</span>
            </button>
          )}

          {checkShouldRenderTabOption("settings") && (
            <button onClick={() => { playSound('tab'); setActiveTab("settings"); }} className={`sidebar-nav-btn snav-set w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "settings" ? 'bg-teal-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span>⚙️</span><span>{t("Settings", "সেটিংস")}</span>
            </button>
          )}

          {currentUserRole === "ADMIN" && (
            <button onClick={() => { playSound('tab'); setActiveTab("modules_menu"); }} className={`sidebar-nav-btn snav-perm w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-extrabold transition btn-press ${activeTab === "modules_menu" ? 'bg-teal-500 text-white shadow-sm' : isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>
              <span>🛡️</span><span>{t("Permissions", "অনুমতি")}</span>
            </button>
          )}



          {/* Bottom Info */}
          <div className="mt-auto pt-4 border-t border-dashed border-slate-700/50">
            {/* Sidebar Clock */}
            <div className={`p-2 rounded-xl text-center mb-2 ${isDarkMode ? 'bg-slate-800/60' : 'bg-teal-50'}`}>
              <div className="animate-clock font-mono font-black text-teal-500 text-sm tracking-widest">{liveTime}</div>
              <div className={`text-sm font-semibold mt-0.5 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>{liveDate}</div>
              <div className={`text-sm font-semibold ${isDarkMode ? 'text-slate-400' : 'text-teal-600'}`}>{liveDay}</div>
            </div>
            <div className={`p-2 rounded-xl text-sm ${isDarkMode ? 'bg-slate-800/40' : 'bg-slate-100'}`}>
              <div className="flex items-center gap-1.5 font-bold mb-1">
                <span className={`w-2 h-2 rounded-full ${currentUserRole === 'ADMIN' ? 'bg-teal-400' : 'bg-indigo-400'}`}></span>
                <span className="uppercase tracking-wider text-sm text-slate-400">{t("Logged in as", "লগইন")}</span>
              </div>
              <p className="font-mono font-black text-sm truncate">{currentUserRole === "ADMIN" ? t("Administrator", "অ্যাডমিন") : t("Staff", "স্টাফ")}</p>
            </div>
            {checkShouldRenderTabOption("backup_restore") && (
              <button onClick={resetDatabase} className="w-full mt-2 bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white font-bold py-1 px-2 rounded text-sm transition uppercase tracking-wider">
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
              className={`relative rounded-t-2xl border-t p-4 pb-6 max-h-[80vh] overflow-y-auto ${isDarkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}
              style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-bg2'], borderTopColor: (activeThemeStyle as any)['--theme-border'] } : {}}
              onClick={e => e.stopPropagation()}
            >
              {/* Drawer handle */}
              <div className="w-10 h-1 rounded-full bg-slate-400/40 mx-auto mb-4" />
              <p className="text-xs font-black uppercase tracking-widest text-slate-400 mb-3 px-1">{t("All Menus", "সব মেনু")}</p>
              <div className="grid grid-cols-3 gap-2">
                {checkShouldRenderTabOption("pos") && (
                  <button onClick={() => { playSound('tab'); setActiveTab("pos"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "pos" ? 'bg-teal-500 text-white border-teal-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">🛒</span><span>{t("Sell", "বিক্রয়")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("analytics") && (
                  <button onClick={() => { playSound('tab'); setActiveTab("analytics"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "analytics" ? 'bg-teal-500 text-white border-teal-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">📊</span><span>{t("Dashboard", "ড্যাশবোর্ড")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("inventory") && (
                  <button onClick={() => { playSound('tab'); setActiveTab("inventory"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "inventory" ? 'bg-teal-500 text-white border-teal-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">📦</span><span>{t("Stock", "স্টক")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("procurement") && (
                  <button onClick={() => { playSound('tab'); setActiveTab("procurement"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "procurement" ? 'bg-teal-500 text-white border-teal-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">📥</span><span>{t("Stock In", "মাল কিনুন")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("procurement") && (
                  <button onClick={() => { playSound('tab'); setActiveTab("new_product"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "new_product" ? 'bg-teal-500 text-white border-teal-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">➕</span><span>{t("New Product", "নতুন পণ্য")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("purchase_history") && (
                  <button onClick={() => { playSound('tab'); setActiveTab("purchase_history"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "purchase_history" ? 'bg-teal-500 text-white border-teal-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">🧾</span><span>{t("Purchase Hist.", "ক্রয় ইতিহাস")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("invoices") && (
                  <button onClick={() => { playSound('tab'); setActiveTab("invoices"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "invoices" ? 'bg-teal-500 text-white border-teal-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">🧾</span><span>{t("Invoices", "রশিদ")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("due_list_view") && (
                  <button onClick={() => { playSound('tab'); setActiveTab("due_list"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "due_list" ? 'bg-teal-500 text-white border-teal-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">💳</span><span>{t("Due List", "বাকি তালিকা")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("report_view") && (
                  <button onClick={() => { playSound('tab'); setActiveTab("report"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "report" ? 'bg-teal-500 text-white border-teal-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">📋</span><span>{t("Report", "রিপোর্ট")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("returns") && (
                  <button onClick={() => { playSound('tab'); setActiveTab("returns"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "returns" ? 'bg-teal-500 text-white border-teal-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">🔄</span><span>{t("Returns", "ফেরত")}</span>
                  </button>
                )}
                {checkShouldRenderTabOption("settings") && (
                  <button onClick={() => { playSound('tab'); setActiveTab("settings"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "settings" ? 'bg-teal-500 text-white border-teal-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">⚙️</span><span>{t("Settings", "সেটিংস")}</span>
                  </button>
                )}
                {currentUserRole === "ADMIN" && (
                  <button onClick={() => { playSound('tab'); setActiveTab("modules_menu"); setMobileMenuOpen(false); }} className={`flex flex-col items-center gap-1 p-3 rounded-xl text-xs font-bold border transition ${activeTab === "modules_menu" ? 'bg-teal-500 text-white border-teal-500' : isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                    <span className="text-xl">🛡️</span><span>{t("Permissions", "অনুমতি")}</span>
                  </button>
                )}
              </div>
              <button onClick={() => setMobileMenuOpen(false)} className="w-full mt-4 py-2.5 rounded-xl text-sm font-black bg-slate-500/10 text-slate-500">{t("Close", "বন্ধ করুন")}</button>
            </div>
          </div>
        )}

        {/* MOBILE BOTTOM NAVIGATION — visible only on mobile (md: hidden) */}
        <nav className={`md:hidden fixed bottom-0 left-0 right-0 z-40 border-t flex items-center justify-around px-1 py-1.5 print:hidden ${isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`} style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-bg2'], borderTopColor: (activeThemeStyle as any)['--theme-border'] } : {}}>
          {checkShouldRenderTabOption("pos") && (
            <button onClick={() => { playSound('tab'); setActiveTab("pos"); }} className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-xl text-xs font-bold transition ${activeTab === "pos" ? 'text-teal-500' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              <span className="text-lg">🛒</span>
              <span>{t("Sell", "বিক্রয়")}</span>
            </button>
          )}
          {checkShouldRenderTabOption("analytics") && (
            <button onClick={() => { playSound('tab'); setActiveTab("analytics"); }} className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-xl text-xs font-bold transition ${activeTab === "analytics" ? 'text-teal-500' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              <span className="text-lg">📊</span>
              <span>{t("Dash", "ড্যাশ")}</span>
            </button>
          )}
          {checkShouldRenderTabOption("inventory") && (
            <button onClick={() => { playSound('tab'); setActiveTab("inventory"); }} className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-xl text-xs font-bold transition ${activeTab === "inventory" ? 'text-teal-500' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              <span className="text-lg">📦</span>
              <span>{t("Stock", "স্টক")}</span>
            </button>
          )}
          {checkShouldRenderTabOption("invoices") && (
            <button onClick={() => { playSound('tab'); setActiveTab("invoices"); }} className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-xl text-xs font-bold transition ${activeTab === "invoices" ? 'text-teal-500' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              <span className="text-lg">🧾</span>
              <span>{t("Invoices", "রশিদ")}</span>
            </button>
          )}
          {checkShouldRenderTabOption("due_list_view") && (
            <button onClick={() => { playSound('tab'); setActiveTab("due_list"); }} className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-xl text-xs font-bold transition ${activeTab === "due_list" ? 'text-teal-500' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              <span className="text-lg">💳</span>
              <span>{t("Due", "বাকি")}</span>
            </button>
          )}
          {/* "More" button — always visible, opens full menu drawer */}
          <button onClick={() => setMobileMenuOpen(true)} className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-xl text-xs font-bold transition ${mobileMenuOpen ? 'text-teal-500' : isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            <span className="text-lg">☰</span>
            <span>{t("More", "আরো")}</span>
          </button>
        </nav>

        {/* MAIN CONTENT */}
        <main className="flex-1 p-4 pb-24 md:pb-4 overflow-y-auto print:p-0">

          {/* =========================================================
              TAB 1: POS / SELL
          ========================================================= */}
          {activeTab === "pos" && checkShouldRenderTabOption("pos") && (
            <div key="pos-tab" className="animate-tab-content grid grid-cols-1 lg:grid-cols-12 gap-4">

              {/* Left: Product Search */}
              <div className="lg:col-span-7 flex flex-col gap-3">
                <div className={`ccard cc-teal p-3 rounded-xl border ${isDarkMode ? 'bg-teal-950/50 border-teal-600' : 'bg-teal-200 border-teal-400 shadow-sm'}`}>
                  <div className="flex gap-2 flex-wrap">
                    <input
                      type="text"
                      placeholder={t("Search medicine...", "ওষুধ খুঁজুন...")}
                      value={searchTerm}
                      onChange={e => setSearchTerm(e.target.value)}
                      className={`flex-1 px-3 py-2 text-sm rounded-lg border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                    />
                    <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)} className={`px-2 py-2 text-sm rounded-lg border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}>
                      <option value="All">{t("All", "সব")}</option>
                      {allCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-[45vh] sm:max-h-[55vh] md:max-h-[60vh] overflow-y-auto">
                  {filteredMedicines.map(med => {
                    const isExpired = new Date(med.expire) < new Date();
                    const isLowStock = med.stock <= (med.lowStockAlert || activeThreshold);
                    return (
                      <button
                        key={med.id}
                        onClick={() => addToCart(med)}
                        disabled={med.stock === 0 || isExpired}
                        className={`p-2.5 rounded-xl border ccard cc-teal text-left transition hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed ${isDarkMode ? 'bg-teal-950/50 border-teal-600 hover:border-teal-500/50' : 'bg-teal-50 border-teal-300 hover:border-teal-300 shadow-sm'}`}
                      >
                        <div className="font-black text-sm truncate mb-1">{med.name}</div>
                        <div className={`text-sm font-semibold ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{med.category}</div>
                        <div className="flex items-center justify-between mt-1.5">
                          <span className="font-mono font-black text-teal-500 text-sm">{med.price} {currencySymbol}</span>
                          <span className={`text-sm font-black px-1.5 py-0.5 rounded ${med.stock === 0 ? 'bg-red-500 text-white' : isExpired ? 'bg-red-500 text-white' : isLowStock ? 'bg-amber-500 text-white' : isDarkMode ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-500'}`}>
                            {med.stock === 0 ? t("Out", "শেষ") : isExpired ? t("Exp", "মেয়াদ") : `${med.stock}`}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                  {filteredMedicines.length === 0 && <div className="col-span-3 text-center py-8 text-slate-400 italic text-sm">{t("No medicine found.", "কোনো ওষুধ পাওয়া যায়নি।")}</div>}
                </div>
              </div>

              {/* Right: Cart */}
              <div className="lg:col-span-5">
                <div className={`ccard cc-indigo p-3 rounded-xl border ${isDarkMode ? 'bg-indigo-950/50 border-indigo-600' : 'bg-indigo-200 border-indigo-400 shadow-sm'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-black uppercase tracking-wider text-teal-500">🛒 {t("Cart", "কার্ট")} ({cart.length})</h3>
                    <button
                      onClick={() => setShowCustomerPanel(p => !p)}
                      className={`flex items-center gap-1.5 text-xs font-black px-2.5 py-1.5 rounded-lg border transition ${selectedExistingDue ? 'bg-red-500 border-red-600 text-white' : customerName ? 'bg-teal-500 border-teal-600 text-white' : isDarkMode ? 'bg-slate-800 border-slate-600 text-slate-300 hover:bg-slate-700' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'}`}
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
                        onBlur={() => setTimeout(() => setShowCustomerSuggestions(false), 150)}
                        placeholder={t("Optional...", "ঐচ্ছিক...")}
                        className={`w-full px-2 py-1.5 rounded border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                      />
                      {/* Due customer suggestions */}
                      {showCustomerSuggestions && customerName.trim() && (() => {
                        const matches = dueList.filter(d =>
                          d.customerName.toLowerCase().includes(customerName.toLowerCase()) ||
                          (d.phone && d.phone.includes(customerName))
                        );
                        return matches.length > 0 ? (
                          <div className={`absolute z-30 left-0 right-0 top-full mt-0.5 rounded-xl border shadow-xl overflow-hidden ${isDarkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}>
                            {matches.map(d => (
                              <button
                                key={d.id}
                                onMouseDown={() => {
                                  setCustomerName(d.customerName);
                                  setCustomerPhone(d.phone !== "N/A" ? d.phone : customerPhone);
                                  setSelectedExistingDue(d);
                                  setShowCustomerSuggestions(false);
                                }}
                                className={`w-full text-left px-3 py-2 text-sm flex justify-between items-center hover:bg-teal-500/10 transition ${isDarkMode ? 'text-white' : 'text-slate-800'}`}
                              >
                                <span className="font-bold">{d.customerName} <span className="font-mono text-xs text-slate-400">{d.phone}</span></span>
                                <span className="text-red-500 font-mono font-black text-xs">🔴 {d.totalDue.toFixed(1)} {currencySymbol} {t("due", "বাকি")}</span>
                              </button>
                            ))}
                          </div>
                        ) : null;
                      })()}
                    </div>
                    <div>
                      <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Phone", "ফোন")}</label>
                      <input type="text" value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} placeholder="01XXXXXXXXX" className={`w-full px-2 py-1.5 rounded border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                    </div>
                  </div>}

                  {/* Previous due alert */}
                  {selectedExistingDue && (
                    <div className={`mb-3 px-3 py-2 rounded-xl border text-sm flex items-center justify-between ${isDarkMode ? 'bg-red-950/50 border-red-700' : 'bg-red-50 border-red-300'}`}>
                      <span className={isDarkMode ? 'text-red-300' : 'text-red-700'}>⚠️ {t("Previous due:", "আগের বাকি:")} <strong className="font-mono">{selectedExistingDue.totalDue.toFixed(1)} {currencySymbol}</strong></span>
                      <button onClick={() => { setSelectedExistingDue(null); }} className="text-slate-400 hover:text-red-500 text-xs font-bold">✕</button>
                    </div>
                  )}

                  {/* Cart Items */}
                  <div className="flex flex-col gap-1.5 max-h-36 sm:max-h-48 overflow-y-auto mb-3">
                    {cart.map(item => (
                      <div key={item.id} className={`flex items-center gap-2 p-2 rounded-lg ${isDarkMode ? 'bg-slate-900/60' : 'bg-slate-50'}`}>
                        <div className="flex-1 min-w-0">
                          <div className="font-bold text-sm truncate">{item.name}</div>
                          <div className="text-sm text-teal-500 font-mono">{item.price} {currencySymbol}</div>
                        </div>
                        <input type="number" min={1} value={item.qty} onChange={e => handleQuantityChange(item.id, e.target.value)} className={`w-12 px-1 py-0.5 text-center font-mono text-sm rounded border ${isDarkMode ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}`} />
                        <span className="text-sm font-mono font-black w-14 text-right">{((parseInt(item.qty) || 0) * item.price).toFixed(1)}</span>
                        <button onClick={() => removeFromCart(item)} className="text-red-400 hover:text-red-600 text-sm">✕</button>
                      </div>
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
                      <input type="number" value={discountValue} onChange={e => setDiscountValue(e.target.value)} className={`flex-1 px-2 py-1 text-sm rounded border outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                    </div>
                  )}

                  {/* Totals */}
                  {cart.length > 0 && (
                    <div className="flex flex-col gap-1 text-sm mb-3 border-t pt-2">
                      <div className="flex justify-between"><span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>{t("Subtotal", "মোট")}</span><span className="font-mono">{currentSubTotal.toFixed(1)} {currencySymbol}</span></div>
                      {parseFloat(vatPercentage) > 0 && <div className="flex justify-between"><span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>{t("VAT", "ভ্যাট")} ({vatPercentage}%)</span><span className="font-mono">+{calculatedVatAmount.toFixed(1)} {currencySymbol}</span></div>}
                      {activeDiscountAmount > 0 && <div className="flex justify-between text-red-500"><span>{t("Discount", "ছাড়")}</span><span className="font-mono">-{activeDiscountAmount.toFixed(1)} {currencySymbol}</span></div>}
                      <div className="flex justify-between font-black text-teal-500 border-t pt-1"><span>{t("Total Payable", "মোট পরিশোধ")}</span><span className="font-mono text-base">{currentFinalBill.toFixed(1)} {currencySymbol}</span></div>
                      {selectedExistingDue && (
                        <>
                          <div className="flex justify-between text-red-500 font-bold"><span>+ {t("Prev. Due", "আগের বাকি")}</span><span className="font-mono">{selectedExistingDue.totalDue.toFixed(1)} {currencySymbol}</span></div>
                          <div className="flex justify-between font-black text-orange-500 border-t pt-1"><span>{t("Grand Total", "সর্বমোট")}</span><span className="font-mono text-base">{(currentFinalBill + selectedExistingDue.totalDue).toFixed(1)} {currencySymbol}</span></div>
                        </>
                      )}
                    </div>
                  )}

                  <button onClick={handleCheckoutIntent} disabled={cart.length === 0} className="w-full bg-gradient-to-r from-teal-500 to-emerald-500 text-white text-sm font-black py-2.5 rounded-xl uppercase tracking-wider shadow-md hover:from-teal-600 hover:to-emerald-600 transition disabled:opacity-40">
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
              <h2 className="text-sm font-black text-teal-500 uppercase tracking-wider">{t("Dashboard", "ড্যাশবোর্ড")}</h2>

              {/* Top Stats Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">

                {/* Daily Sale */}
                {checkShouldRenderTabOption("daily_sale_view") && (
                <div className={`ccard cc-violet p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-violet-950/50 border-violet-500' : 'border-emerald-600'}`} style={isCustomTheme ? { backgroundColor: (activeThemeStyle as any)['--theme-card'], borderColor: (activeThemeStyle as any)['--theme-border'] } : (!isDarkMode ? { background: 'linear-gradient(135deg, #059669 0%, #047857 100%)' } : {})}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#a7f3d0'} : {color:'#6ee7b7'}}>{t("Today's Sale", "আজকের বিক্রয়")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#6ee7b7'}}>{computedDailySalesAmount.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#d1fae5'} : {color:'#6b7280'}}>{t("Cash collected today", "আজ সংগ্রহ")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{`
                        @keyframes bagFloat{0%,100%{transform:translateY(0) rotate(-2deg) scale(1)}50%{transform:translateY(-8px) rotate(2deg) scale(1.04)}}
                        @keyframes bagGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                        @keyframes coinSpin1{0%{transform:translateY(-18px) scaleX(1);opacity:0}15%{opacity:1}40%{transform:translateY(2px) scaleX(-1);opacity:1}70%{transform:translateY(10px) scaleX(1);opacity:1}85%,100%{transform:translateY(14px);opacity:0}}
                        @keyframes coinSpin2{0%{transform:translateY(-14px) scaleX(1);opacity:0}20%{opacity:1}45%{transform:translateY(2px) scaleX(-1);opacity:1}75%{transform:translateY(8px) scaleX(1);opacity:1}90%,100%{opacity:0}}
                        @keyframes coinSpin3{0%{transform:translateY(-20px) scaleX(1);opacity:0}10%{opacity:1}38%{transform:translateY(2px) scaleX(-1);opacity:1}65%{transform:translateY(12px) scaleX(1);opacity:1}80%,100%{opacity:0}}
                        @keyframes shimmer{0%,100%{opacity:0.15}50%{opacity:0.55}}
                        @keyframes sparkle1{0%,100%{transform:scale(0) rotate(0deg);opacity:0}40%,60%{transform:scale(1.2) rotate(180deg);opacity:1}}
                        @keyframes sparkle2{0%,100%{transform:scale(0) rotate(0deg);opacity:0}30%,70%{transform:scale(1) rotate(90deg);opacity:0.9}}
                        #mbag{animation:bagFloat 2s ease-in-out infinite,bagGlow 2s ease-in-out infinite;transform-origin:32px 38px;will-change:transform}
                        #c1{animation:coinSpin1 2s 0.1s ease-in infinite;transform-origin:20px 18px;will-change:transform}
                        #c2{animation:coinSpin2 2s 0.55s ease-in infinite;transform-origin:36px 14px;will-change:transform}
                        #c3{animation:coinSpin3 2s 0.9s ease-in infinite;transform-origin:44px 22px;will-change:transform}
                        #sh1{animation:shimmer 2s 0s ease-in-out infinite}
                        #sh2{animation:shimmer 2s 0.4s ease-in-out infinite}
                        #sp1{animation:sparkle1 2s 0.2s ease-in-out infinite;transform-origin:12px 12px;will-change:transform}
                        #sp2{animation:sparkle2 2s 0.8s ease-in-out infinite;transform-origin:50px 10px;will-change:transform}
                      `}</style>
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
                <div className={`ccard cc-pink p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-pink-950/50 border-blue-500' : 'border-blue-700'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #1d4ed8 0%, #1e40af 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#bfdbfe'} : {color:'#93c5fd'}}>{t("Monthly Sale", "মাসিক বিক্রয়")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#93c5fd'}}>{computedMonthlySalesAmount.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#dbeafe'} : {color:'#6b7280'}}>{t("This month", "এই মাসে")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{`
                        @keyframes calFloat{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-6px) scale(1.05)}}
                        @keyframes calGlow{0%,100%{opacity:0.85}50%{opacity:1}}
                        @keyframes dateFlip{0%,30%{opacity:1;transform:scaleY(1)}40%{opacity:0;transform:scaleY(0)}50%{opacity:1;transform:scaleY(1)}100%{opacity:1}}
                        @keyframes ringRotate{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
                        @keyframes dotPulse{0%,100%{opacity:0.3;transform:scale(1)}50%{opacity:1;transform:scale(1.4)}}
                        @keyframes pageFlip{0%,60%{transform:scaleY(1)}70%{transform:scaleY(0)}80%{transform:scaleY(1)}100%{transform:scaleY(1)}}
                        #cal{animation:calFloat 2.2s ease-in-out infinite,calGlow 2.2s ease-in-out infinite;transform-origin:32px 36px;will-change:transform}
                        #dt{animation:dateFlip 3s 0.5s ease-in-out infinite;transform-origin:32px 42px;will-change:transform}
                        #ring{animation:ringRotate 8s linear infinite;transform-origin:32px 32px;will-change:transform}
                        #d1{animation:dotPulse 1.2s 0s ease-in-out infinite;will-change:transform}
                        #d2{animation:dotPulse 1.2s 0.3s ease-in-out infinite;will-change:transform}
                        #d3{animation:dotPulse 1.2s 0.6s ease-in-out infinite;will-change:transform}
                        #page{animation:pageFlip 3s 1s ease-in-out infinite;transform-origin:32px 30px;will-change:transform}
                      `}</style>
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
                  <div className={`ccard cc-rose p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-rose-950/50 border-emerald-500' : 'border-teal-700'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #0f766e 0%, #0d9488 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#99f6e4'} : {color:'#5eead4'}}>{t("Today's Profit", "আজকের লাভ")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#5eead4'}}>{computedDailyProfitAmount.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#ccfbf1'} : {color:'#6b7280'}}>{t("Net profit today", "আজ নেট লাভ")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{`
                          @keyframes b1grow{0%,100%{transform:scaleY(0.6)}50%{transform:scaleY(1.15)}}
                          @keyframes b2grow{0%,100%{transform:scaleY(0.7)}50%{transform:scaleY(1.2)}}
                          @keyframes b3grow{0%,100%{transform:scaleY(0.8)}50%{transform:scaleY(1.25)}}
                          @keyframes arrDash{0%,100%{transform:translate(0,0) scale(1)}40%{transform:translate(6px,-7px) scale(1.1)}60%{transform:translate(6px,-7px) scale(1.1)}}
                          @keyframes baseGlow{0%,100%{opacity:0.4}50%{opacity:0.9}}
                          @keyframes shimBars{0%{opacity:0.1}50%{opacity:0.5}100%{opacity:0.1}}
                          @keyframes particle{0%{transform:translate(0,0);opacity:0.8}100%{transform:translate(var(--px),var(--py));opacity:0}}
                          #b1{animation:b1grow 1.8s 0s ease-in-out infinite;transform-origin:14px 48px;will-change:transform}
                          #b2{animation:b2grow 1.8s 0.2s ease-in-out infinite;transform-origin:27px 48px;will-change:transform}
                          #b3{animation:b3grow 1.8s 0.4s ease-in-out infinite;transform-origin:40px 48px;will-change:transform}
                          #arr{animation:arrDash 1.6s ease-in-out infinite;will-change:transform}
                          #base{animation:baseGlow 1.8s ease-in-out infinite}
                          #p1{--px:-8px;--py:-12px;animation:particle 1.2s 0.3s ease-out infinite;transform-origin:44px 14px;will-change:transform}
                          #p2{--px:8px;--py:-10px;animation:particle 1.2s 0.7s ease-out infinite;transform-origin:44px 14px;will-change:transform}
                          #p3{--px:2px;--py:-14px;animation:particle 1.2s 1.1s ease-out infinite;transform-origin:44px 14px;will-change:transform}
                        `}</style>
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
                  <div className={`ccard cc-green p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-green-950/50 border-purple-500' : 'border-purple-700'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#ddd6fe'} : {color:'#c4b5fd'}}>{t("Monthly Profit", "মাসিক লাভ")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#c4b5fd'}}>{computedMonthlyProfitAmount.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#ede9fe'} : {color:'#6b7280'}}>{t("Net profit this month", "মাসে নেট লাভ")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{`
                          @keyframes rktLaunch{0%,100%{transform:translateY(0) rotate(0deg)}35%{transform:translateY(-13px) rotate(-3deg)}65%{transform:translateY(-13px) rotate(3deg)}}
                          @keyframes fireFlick{0%,100%{transform:scaleY(1) scaleX(1)}25%{transform:scaleY(1.6) scaleX(0.7)}50%{transform:scaleY(0.8) scaleX(1.25)}75%{transform:scaleY(1.5) scaleX(0.75)}}
                          @keyframes smoke1Up{0%{transform:translateY(0) scale(0.8);opacity:0.5}100%{transform:translateY(-22px) scale(1.8);opacity:0}}
                          @keyframes smoke2Up{0%{transform:translateY(0) scale(0.7);opacity:0.4}100%{transform:translateY(-18px) scale(1.5);opacity:0}}
                          @keyframes orbitDot{0%{transform:rotate(0deg) translateX(20px) rotate(0deg);opacity:0.6}100%{transform:rotate(360deg) translateX(20px) rotate(-360deg);opacity:0.6}}
                          @keyframes orbitDot2{0%{transform:rotate(120deg) translateX(18px) rotate(-120deg);opacity:0.4}100%{transform:rotate(480deg) translateX(18px) rotate(-480deg);opacity:0.4}}
                          @keyframes rktGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          #rkt{animation:rktLaunch 2s ease-in-out infinite,rktGlow 2s ease-in-out infinite;transform-origin:32px 40px;will-change:transform}
                          #fire{animation:fireFlick 0.18s linear infinite;transform-origin:32px 48px;will-change:transform}
                          #sm1{animation:smoke1Up 0.8s 0s ease-out infinite;will-change:transform}
                          #sm2{animation:smoke2Up 0.8s 0.28s ease-out infinite;will-change:transform}
                          #od1{animation:orbitDot 4s linear infinite;transform-origin:32px 28px;will-change:transform}
                          #od2{animation:orbitDot2 4s linear infinite;transform-origin:32px 28px;will-change:transform}
                        `}</style>
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
                  <div className={`ccard cc-slate p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-slate-800 border-orange-500' : 'border-orange-700'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #c2410c 0%, #ea580c 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fed7aa'} : {color:'#fdba74'}}>{t("Today's Purchase", "আজকের ক্রয়")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#fdba74'}}>{computedDailyPurchaseAmount.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#ffedd5'} : {color:'#6b7280'}}>{t("Purchased today", "আজ কেনা")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{`
                          @keyframes cartRoll{0%,100%{transform:translateX(0)}25%{transform:translateX(3px)}75%{transform:translateX(-2px)}}
                          @keyframes cartGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          @keyframes wheelSpin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
                          @keyframes it1Jump{0%,70%,100%{transform:translateY(0) rotate(0deg)}35%{transform:translateY(-10px) rotate(-8deg)}}
                          @keyframes it2Jump{0%,70%,100%{transform:translateY(0) rotate(0deg)}35%{transform:translateY(-14px) rotate(5deg)}}
                          @keyframes it3Jump{0%,70%,100%{transform:translateY(0) rotate(0deg)}35%{transform:translateY(-9px) rotate(-5deg)}}
                          @keyframes plusPop{0%,100%{transform:scale(0);opacity:0}50%{transform:scale(1.3);opacity:1}}
                          #cart{animation:cartRoll 1.4s ease-in-out infinite,cartGlow 1.8s ease-in-out infinite;will-change:transform}
                          #w1{animation:wheelSpin 1s linear infinite;transform-origin:22px 47px;will-change:transform}
                          #w2{animation:wheelSpin 1s linear infinite;transform-origin:44px 47px;will-change:transform}
                          #it1{animation:it1Jump 1.6s 0s ease-in-out infinite;transform-origin:22px 24px;will-change:transform}
                          #it2{animation:it2Jump 1.6s 0.2s ease-in-out infinite;transform-origin:32px 20px;will-change:transform}
                          #it3{animation:it3Jump 1.6s 0.4s ease-in-out infinite;transform-origin:42px 24px;will-change:transform}
                          #plus{animation:plusPop 1.6s 0.8s ease-in-out infinite;transform-origin:54px 12px;will-change:transform}
                        `}</style>
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
                  <div className={`ccard cc-cyan p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-cyan-950/50 border-cyan-500' : 'border-cyan-700'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #0e7490 0%, #0891b2 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#a5f3fc'} : {color:'#67e8f9'}}>{t("Monthly Purchase", "মাসিক ক্রয়")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#67e8f9'}}>{computedMonthlyPurchaseAmount.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#cffafe'} : {color:'#6b7280'}}>{t("Purchased this month", "মাসে কেনা")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{`
                          @keyframes bagSwing{0%,100%{transform:rotate(-8deg) translateY(0)}25%{transform:rotate(8deg) translateY(-3px)}50%{transform:rotate(-6deg) translateY(-1px)}75%{transform:rotate(6deg) translateY(-2px)}}
                          @keyframes tagBounce{0%,100%{transform:translateY(0) rotate(-10deg)}50%{transform:translateY(-7px) rotate(10deg)}}
                          @keyframes bagGlow{0%,100%{opacity:0.85}50%{opacity:1}}
                          @keyframes checkPop{0%,60%,100%{transform:scale(0);opacity:0}75%{transform:scale(1.3);opacity:1}90%{transform:scale(1);opacity:1}}
                          @keyframes shimBag{0%,100%{opacity:0.1}50%{opacity:0.4}}
                          #bag{animation:bagSwing 2s ease-in-out infinite,bagGlow 2s ease-in-out infinite;transform-origin:32px 22px;will-change:transform}
                          #tag{animation:tagBounce 2s 0.3s ease-in-out infinite;transform-origin:43px 14px;will-change:transform}
                          #chk{animation:checkPop 3s 0.5s ease-in-out infinite;transform-origin:32px 38px;will-change:transform}
                          #shbag{animation:shimBag 2s ease-in-out infinite}
                        `}</style>
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
                <div className={`ccard cc-purple p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-purple-950/50 border-red-500' : 'border-red-700'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #b91c1c 0%, #dc2626 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fecaca'} : {color:'#fca5a5'}}>{t("Today's Due", "আজকের বাকি")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#fca5a5'}}>{computedDailyDue.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#fee2e2'} : {color:'#6b7280'}}>{t("Due given today", "আজ বাকি দেওয়া")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{`
                        @keyframes hgSpin{0%,40%{transform:rotate(0deg)}60%,100%{transform:rotate(180deg)}}
                        @keyframes sandFill{0%{transform:scaleY(0);opacity:0}10%{opacity:1}80%{transform:scaleY(1);opacity:1}95%,100%{opacity:0}}
                        @keyframes sandDrop{0%,30%{transform:translateY(0);opacity:1}85%,100%{transform:translateY(18px);opacity:0}}
                        @keyframes ripple1{0%{transform:scale(0.5);opacity:0.6}100%{transform:scale(1.8);opacity:0}}
                        @keyframes ripple2{0%{transform:scale(0.5);opacity:0.4}100%{transform:scale(2.2);opacity:0}}
                        @keyframes glassGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                        #hg{animation:hgSpin 4s 0.5s cubic-bezier(0.4,0,0.2,1) infinite,glassGlow 2s ease-in-out infinite;transform-origin:32px 32px;will-change:transform}
                        #sf{animation:sandFill 2s 0.5s ease-in infinite;transform-origin:32px 20px}
                        #sd{animation:sandDrop 2s 0.5s ease-in infinite}
                        #rip1{animation:ripple1 2s 0s ease-out infinite}
                        #rip2{animation:ripple2 2s 0.6s ease-out infinite}
                      `}</style>
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
                <div className={`ccard cc-teal p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-teal-950/50 border-pink-500' : 'border-pink-700'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #be185d 0%, #db2777 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fce7f3'} : {color:'#f9a8d4'}}>{t("Monthly Due", "মাসিক বাকি")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#f9a8d4'}}>{computedMonthlyDue.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#fdf2f8'} : {color:'#6b7280'}}>{t("Total due this month", "মাসে মোট বাকি")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{`
                        @keyframes clipShake{0%,100%{transform:rotate(0deg)}15%{transform:rotate(-7deg)}30%{transform:rotate(7deg)}45%{transform:rotate(-4deg)}60%{transform:rotate(4deg)}75%,100%{transform:rotate(0deg)}}
                        @keyframes clipGlow{0%,100%{opacity:0.85}50%{opacity:1}}
                        @keyframes alertPulse{0%,100%{transform:scale(1);opacity:0.8}50%{transform:scale(1.4);opacity:1}}
                        @keyframes alertRing{0%{transform:scale(1);opacity:0.5}100%{transform:scale(1.9);opacity:0}}
                        @keyframes lineWrite1{0%{stroke-dashoffset:22}60%,100%{stroke-dashoffset:0}}
                        @keyframes lineWrite2{0%,20%{stroke-dashoffset:18}80%,100%{stroke-dashoffset:0}}
                        @keyframes lineWrite3{0%,40%{stroke-dashoffset:14}100%{stroke-dashoffset:0}}
                        @keyframes penMove{0%{transform:translate(0,0)}33%{transform:translate(4px,8px)}66%{transform:translate(0px,16px)}100%{transform:translate(0,0)}}
                        #clip{animation:clipShake 2.8s ease-in-out infinite,clipGlow 2s ease-in-out infinite;transform-origin:32px 36px;will-change:transform}
                        #al{animation:alertPulse 1s ease-in-out infinite}
                        #alring{animation:alertRing 1s ease-out infinite}
                        #l1{animation:lineWrite1 2.8s ease-in-out infinite;stroke-dasharray:22}
                        #l2{animation:lineWrite2 2.8s ease-in-out infinite;stroke-dasharray:18}
                        #l3{animation:lineWrite3 2.8s ease-in-out infinite;stroke-dasharray:14}
                        #pen{animation:penMove 2.8s ease-in-out infinite}
                      `}</style>
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
                  <div className={`ccard cc-indigo p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-indigo-950/50 border-fuchsia-500' : 'border-fuchsia-700'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #a21caf 0%, #c026d3 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fae8ff'} : {color:'#f0abfc'}}>{t("Today's bKash/Nagad", "আজকের বিকাশ/নগদ")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#f0abfc'}}>{computedDailyBkash.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#fdf4ff'} : {color:'#6b7280'}}>{t("Mobile payment today", "আজ মোবাইল পেমেন্ট")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'60px',height:'60px',opacity:0.55,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{`
                          @keyframes phVib{0%,80%,100%{transform:rotate(0deg)}10%{transform:rotate(-12deg)}20%{transform:rotate(12deg)}30%{transform:rotate(-8deg)}40%{transform:rotate(8deg)}50%{transform:rotate(-5deg)}60%{transform:rotate(5deg)}}
                          @keyframes phGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          @keyframes ping1{0%{transform:scale(0.8);opacity:0.8}100%{transform:scale(3);opacity:0}}
                          @keyframes ping2{0%{transform:scale(0.8);opacity:0.6}100%{transform:scale(3.5);opacity:0}}
                          @keyframes coinPop{0%,70%,100%{transform:translateY(0) scale(0);opacity:0}78%{transform:translateY(-12px) scale(1.3);opacity:1}90%{transform:translateY(-16px) scale(1);opacity:0.8}98%{opacity:0}}
                          @keyframes screenFlash{0%,85%,100%{opacity:0.55}88%{opacity:0.9}}
                          #ph{animation:phVib 2.5s ease-in-out infinite,phGlow 2s ease-in-out infinite;transform-origin:32px 32px;will-change:transform}
                          #p1{animation:ping1 1.6s 0s ease-out infinite;transform-origin:46px 15px;will-change:transform}
                          #p2{animation:ping2 1.6s 0.45s ease-out infinite;transform-origin:46px 15px;will-change:transform}
                          #cn{animation:coinPop 2.5s ease-in-out infinite;transform-origin:32px 20px;will-change:transform}
                          #scr{animation:screenFlash 2.5s ease-in-out infinite}
                        `}</style>
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
                  <div className={`ccard cc-amber p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-amber-950/50 border-amber-500' : 'border-amber-700'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #b45309 0%, #d97706 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fef3c7'} : {color:'#fde68a'}}>{t("Monthly bKash/Nagad", "মাসিক বিকাশ/নগদ")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#fde68a'}}>{computedMonthlyBkash.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#fffbeb'} : {color:'#6b7280'}}>{t("Mobile payment month", "মাসে মোবাইল পেমেন্ট")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{`
                          @keyframes cardPop{0%,100%{transform:translateY(0) rotate(-4deg) scale(1)}50%{transform:translateY(-10px) rotate(4deg) scale(1.06)}}
                          @keyframes cardGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          @keyframes chipShine{0%,100%{opacity:0.35;transform:scale(1)}50%{opacity:0.85;transform:scale(1.05)}}
                          @keyframes waveFlow{0%{transform:translateX(-14px);opacity:0}40%{opacity:0.7}100%{transform:translateX(14px);opacity:0}}
                          @keyframes tapRipple{0%{transform:scale(0.5);opacity:0.7}100%{transform:scale(2.2);opacity:0}}
                          @keyframes tapRipple2{0%{transform:scale(0.5);opacity:0.5}100%{transform:scale(2.8);opacity:0}}
                          #crd{animation:cardPop 2s ease-in-out infinite,cardGlow 2s ease-in-out infinite;will-change:transform}
                          #chip{animation:chipShine 2s ease-in-out infinite;will-change:transform}
                          #wave{animation:waveFlow 2s 0.5s ease-in-out infinite;will-change:transform}
                          #tr1{animation:tapRipple 1.5s 1s ease-out infinite;transform-origin:50px 12px;will-change:transform}
                          #tr2{animation:tapRipple2 1.5s 1.3s ease-out infinite;transform-origin:50px 12px;will-change:transform}
                        `}</style>
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
                <div className={`ccard cc-blue p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-blue-950/50 border-teal-500' : 'border-teal-800'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #065f46 0%, #047857 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#a7f3d0'} : {color:'#6ee7b7'}}>{t("Today's Due Collection", "আজকের বাকি আদায়")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#6ee7b7'}}>{computedDailyDueCollection.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#d1fae5'} : {color:'#6b7280'}}>{t("Collected today", "আজ আদায় হয়েছে")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{`
                        @keyframes circlePulse{0%,100%{transform:scale(1);opacity:0.5}50%{transform:scale(1.12);opacity:0.88}}
                        @keyframes circleGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                        @keyframes checkDraw{0%{stroke-dashoffset:70;opacity:0.2}50%,100%{stroke-dashoffset:0;opacity:1}}
                        @keyframes sp1Pop{0%,55%,100%{transform:scale(0) rotate(0deg);opacity:0}68%{transform:scale(1.4) rotate(45deg);opacity:1}85%{transform:scale(1) rotate(30deg);opacity:0.8}95%{opacity:0}}
                        @keyframes sp2Pop{0%,60%,100%{transform:scale(0);opacity:0}72%{transform:scale(1.3);opacity:1}88%{transform:scale(1);opacity:0.8}96%{opacity:0}}
                        @keyframes sp3Pop{0%,65%,100%{transform:scale(0);opacity:0}76%{transform:scale(1.5);opacity:1}90%{transform:scale(1);opacity:0.8}97%{opacity:0}}
                        @keyframes burstLine{0%,50%{stroke-dashoffset:20;opacity:0}70%{stroke-dashoffset:0;opacity:1}90%,100%{opacity:0}}
                        #chkc{animation:circlePulse 1.6s ease-in-out infinite,circleGlow 1.6s ease-in-out infinite;transform-origin:32px 32px;will-change:transform}
                        #chkm{stroke-dasharray:70;animation:checkDraw 1.6s ease-in-out infinite}
                        #sp1{animation:sp1Pop 1.6s 0.7s ease-out infinite;transform-origin:12px 14px;will-change:transform}
                        #sp2{animation:sp2Pop 1.6s 0.9s ease-out infinite;transform-origin:50px 16px;will-change:transform}
                        #sp3{animation:sp3Pop 1.6s 1.1s ease-out infinite;transform-origin:32px 6px}
                        #bl1{stroke-dasharray:20;animation:burstLine 1.6s 0.75s ease-out infinite;transform-origin:10px 22px}
                        #bl2{stroke-dasharray:20;animation:burstLine 1.6s 0.9s ease-out infinite;transform-origin:54px 22px}
                      `}</style>
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
                <div className={`ccard cc-red p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-red-950/50 border-slate-500' : 'border-slate-700'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #1e3a5f 0%, #1e40af 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#bfdbfe'} : {color:'#93c5fd'}}>{t("Monthly Due Collection", "মাসিক বাকি আদায়")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#93c5fd'}}>{computedMonthlyDueCollection.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#dbeafe'} : {color:'#6b7280'}}>{t("Collected this month", "এই মাসে আদায়")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{`
                        @keyframes wltOpen{0%,100%{transform:scaleY(1) rotate(-2deg)}50%{transform:scaleY(1.07) rotate(2deg)}}
                        @keyframes wltGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                        @keyframes cf1Fly{0%{transform:translate(0,0) scale(0);opacity:0}18%{transform:translate(-6px,-14px) scale(1.2);opacity:1}65%{transform:translate(-12px,-28px) scale(0.8);opacity:0.6}100%{transform:translate(-16px,-38px) scale(0);opacity:0}}
                        @keyframes cf2Fly{0%{transform:translate(0,0) scale(0);opacity:0}22%{transform:translate(5px,-12px) scale(1.1);opacity:1}70%{transform:translate(12px,-24px) scale(0.8);opacity:0.5}100%{transform:translate(16px,-34px) scale(0);opacity:0}}
                        @keyframes cf3Fly{0%{transform:translate(0,0) scale(0);opacity:0}30%{transform:translate(0px,-16px) scale(1.3);opacity:1}75%{transform:translate(4px,-30px) scale(0.7);opacity:0.4}100%{transform:translate(6px,-40px) scale(0);opacity:0}}
                        @keyframes coinShine{0%,100%{opacity:0.6}50%{opacity:1}}
                        #wlt{animation:wltOpen 2.2s ease-in-out infinite,wltGlow 2s ease-in-out infinite;will-change:transform}
                        #cf1{animation:cf1Fly 2.2s 0.3s ease-out infinite;transform-origin:32px 24px;will-change:transform}
                        #cf2{animation:cf2Fly 2.2s 0.7s ease-out infinite;transform-origin:32px 24px;will-change:transform}
                        #cf3{animation:cf3Fly 2.2s 1.1s ease-out infinite;transform-origin:32px 24px}
                        #cs{animation:coinShine 2s ease-in-out infinite}
                      `}</style>
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
                  <div className={`ccard cc-violet p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-violet-950/50 border-violet-500' : 'border-violet-800'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #4c1d95 0%, #5b21b6 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#ddd6fe'} : {color:'#c4b5fd'}}>{t("Yearly Sale", "বার্ষিক বিক্রয়")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#c4b5fd'}}>{computedYearlySalesAmount.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#ede9fe'} : {color:'#6b7280'}}>{t("This year's total sales", "এই বছরের মোট বিক্রয়")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{`
                          @keyframes starSpin{0%{transform:rotate(0deg) scale(1)}40%{transform:rotate(180deg) scale(1.18)}100%{transform:rotate(360deg) scale(1)}}
                          @keyframes starGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          @keyframes twinkle1{0%,100%{opacity:0.2;transform:scale(0.6) rotate(0deg)}50%{opacity:1;transform:scale(1.3) rotate(15deg)}}
                          @keyframes twinkle2{0%,100%{opacity:0.3;transform:scale(0.7)}50%{opacity:0.9;transform:scale(1.2)}}
                          @keyframes twinkle3{0%,100%{opacity:0.15;transform:scale(0.5) rotate(0deg)}50%{opacity:0.8;transform:scale(1.1) rotate(-10deg)}}
                          @keyframes orbitDot{0%{transform:rotate(0deg) translateX(28px) rotate(0deg)}100%{transform:rotate(360deg) translateX(28px) rotate(-360deg)}}
                          #star{animation:starSpin 4s linear infinite,starGlow 2s ease-in-out infinite;transform-origin:32px 32px;will-change:transform}
                          #t1{animation:twinkle1 1.5s 0s ease-in-out infinite;transform-origin:8px 12px;will-change:transform}
                          #t2{animation:twinkle2 1.5s 0.45s ease-in-out infinite;transform-origin:52px 16px;will-change:transform}
                          #t3{animation:twinkle3 1.5s 0.9s ease-in-out infinite;transform-origin:8px 52px;will-change:transform}
                          #t4{animation:twinkle1 1.5s 1.3s ease-in-out infinite;transform-origin:52px 50px;will-change:transform}
                          #od{animation:orbitDot 5s linear infinite;transform-origin:32px 32px}
                        `}</style>
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
                  <div className={`ccard cc-orange p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-orange-950/50 border-orange-500' : 'border-orange-800'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #9a3412 0%, #c2410c 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fed7aa'} : {color:'#fdba74'}}>{t("Yearly Purchase", "বার্ষিক ক্রয়")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#fdba74'}}>{computedYearlyPurchaseAmount.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#ffedd5'} : {color:'#6b7280'}}>{t("This year's total purchase", "এই বছরের মোট ক্রয়")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{`
                          @keyframes boxBounce{0%,100%{transform:translateY(0) rotate(0deg)}35%{transform:translateY(-12px) rotate(-5deg)}60%{transform:translateY(-12px) rotate(-4deg)}}
                          @keyframes boxGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          @keyframes lidOpen{0%,100%{transform:scaleY(1)}45%,65%{transform:scaleY(0.15)}}
                          @keyframes itemRise{0%,30%,100%{transform:translateY(0);opacity:0}42%{transform:translateY(-18px);opacity:1}68%{transform:translateY(-22px);opacity:0.7}80%,90%{opacity:0}}
                          @keyframes shimBox{0%,100%{opacity:0.1}50%{opacity:0.4}}
                          @keyframes dustPuff{0%{transform:scale(0.5);opacity:0.6}100%{transform:scale(2);opacity:0}}
                          #box{animation:boxBounce 2.2s ease-in-out infinite,boxGlow 2s ease-in-out infinite;will-change:transform}
                          #lid{animation:lidOpen 2.2s ease-in-out infinite;transform-origin:32px 20px;will-change:transform}
                          #item{animation:itemRise 2.2s ease-in-out infinite;will-change:transform}
                          #shb{animation:shimBox 2s ease-in-out infinite}
                          #dp1{animation:dustPuff 2.2s 0.4s ease-out infinite;transform-origin:20px 48px;will-change:transform}
                          #dp2{animation:dustPuff 2.2s 0.6s ease-out infinite;transform-origin:44px 48px;will-change:transform}
                        `}</style>
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
                  <div className={`ccard cc-green p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-green-950/50 border-emerald-500' : 'border-emerald-800'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #064e3b 0%, #065f46 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#a7f3d0'} : {color:'#6ee7b7'}}>{t("Yearly Profit", "বার্ষিক লাভ")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#6ee7b7'}}>{computedYearlyProfitAmount.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#d1fae5'} : {color:'#6b7280'}}>{t("This year's net profit", "এই বছরের নেট লাভ")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{`
                          @keyframes tropShake{0%,100%{transform:rotate(0deg) scale(1)}15%{transform:rotate(-7deg) scale(1.05)}30%{transform:rotate(7deg) scale(1.05)}45%{transform:rotate(-4deg)}60%{transform:rotate(4deg)}75%,100%{transform:rotate(0deg) scale(1)}}
                          @keyframes tropGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          @keyframes glowRing{0%,100%{r:22;opacity:0.07}50%{r:26;opacity:0.22}}
                          @keyframes star1Fly{0%{transform:translate(0,0) scale(0) rotate(0deg);opacity:0}25%{opacity:1;transform:scale(1.3)}100%{transform:translate(-14px,-16px) scale(0) rotate(180deg);opacity:0}}
                          @keyframes star2Fly{0%{transform:translate(0,0) scale(0) rotate(0deg);opacity:0}30%{opacity:1;transform:scale(1.2)}100%{transform:translate(16px,-18px) scale(0) rotate(-180deg);opacity:0}}
                          @keyframes star3Fly{0%{transform:translate(0,0) scale(0) rotate(0deg);opacity:0}20%{opacity:1;transform:scale(1.4)}100%{transform:translate(2px,-22px) scale(0) rotate(120deg);opacity:0}}
                          @keyframes confetti1{0%{transform:translate(0,0) rotate(0deg);opacity:0}20%{opacity:1}100%{transform:translate(-18px,-8px) rotate(180deg);opacity:0}}
                          @keyframes confetti2{0%{transform:translate(0,0) rotate(0deg);opacity:0}25%{opacity:1}100%{transform:translate(18px,-6px) rotate(-180deg);opacity:0}}
                          #trop{animation:tropShake 3s ease-in-out infinite,tropGlow 2s ease-in-out infinite;transform-origin:32px 34px;will-change:transform}
                          #glow{animation:glowRing 2.5s ease-in-out infinite;will-change:transform}
                          #s1{animation:star1Fly 2s 0s ease-out infinite;transform-origin:16px 12px;will-change:transform}
                          #s2{animation:star2Fly 2s 0.55s ease-out infinite;transform-origin:48px 14px;will-change:transform}
                          #s3{animation:star3Fly 2s 1.1s ease-out infinite;transform-origin:32px 8px;will-change:transform}
                          #cf1{animation:confetti1 2s 0.3s ease-out infinite;transform-origin:10px 20px;will-change:transform}
                          #cf2{animation:confetti2 2s 0.8s ease-out infinite;transform-origin:54px 18px;will-change:transform}
                        `}</style>
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
                  <div className={`ccard cc-rose p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-rose-950/50 border-rose-500' : 'border-rose-800'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #881337 0%, #9f1239 100%)' } : {}}>
                    <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fecdd3'} : {color:'#fda4af'}}>{t("Yearly Due", "বার্ষিক বাকি")}</span>
                    <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#fda4af'}}>{computedYearlyDue.toFixed(1)} {currencySymbol}</div>
                    <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#ffe4e6'} : {color:'#6b7280'}}>{t("Total due this year", "এই বছরের মোট বাকি")}</div>
                    <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <style>{`
                          @keyframes warnShake{0%,100%{transform:rotate(0deg) scale(1)}8%{transform:rotate(-10deg) scale(1.08)}16%{transform:rotate(10deg) scale(1.08)}24%{transform:rotate(-7deg)}32%{transform:rotate(7deg)}40%,100%{transform:rotate(0deg) scale(1)}}
                          @keyframes warnGlow{0%,100%{opacity:0.88}50%{opacity:1}}
                          @keyframes bangBlink{0%,100%{opacity:1;transform:scaleY(1)}50%{opacity:0.15;transform:scaleY(0.5)}}
                          @keyframes sw1Grow{0%{transform:scale(0.4);opacity:0.7}100%{transform:scale(1.8);opacity:0}}
                          @keyframes sw2Grow{0%{transform:scale(0.4);opacity:0.5}100%{transform:scale(2.2);opacity:0}}
                          @keyframes sw3Grow{0%{transform:scale(0.4);opacity:0.3}100%{transform:scale(2.6);opacity:0}}
                          @keyframes lightFlash{0%,90%,100%{opacity:0}45%,55%{opacity:0.4}}
                          #wrn{animation:warnShake 2.2s ease-in-out infinite,warnGlow 2.2s ease-in-out infinite;transform-origin:32px 34px;will-change:transform}
                          #bang{animation:bangBlink 0.55s ease-in-out infinite;will-change:transform}
                          #sw1{animation:sw1Grow 1.4s 0s ease-out infinite;transform-origin:32px 32px;will-change:transform}
                          #sw2{animation:sw2Grow 1.4s 0.35s ease-out infinite;transform-origin:32px 32px;will-change:transform}
                          #sw3{animation:sw3Grow 1.4s 0.7s ease-out infinite;transform-origin:32px 32px;will-change:transform}
                          #flash{animation:lightFlash 2.2s ease-in-out infinite;will-change:transform}
                        `}</style>
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
                <div className={`ccard cc-fuchsia p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-fuchsia-950/50 border-fuchsia-500' : 'border-fuchsia-700'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #86198f 0%, #a21caf 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fae8ff'} : {color:'#f0abfc'}}>{t("Today's Discount", "আজকের ছাড়")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#f0abfc'}}>{computedDailyDiscount.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#fdf4ff'} : {color:'#6b7280'}}>{t("Discount given today", "আজ ছাড় দেওয়া হয়েছে")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{`
                        @keyframes tagWiggle{0%,100%{transform:rotate(-6deg) scale(1)}50%{transform:rotate(6deg) scale(1.08)}}
                        @keyframes pctPop{0%,100%{transform:scale(1);opacity:0.9}50%{transform:scale(1.15);opacity:1}}
                        @keyframes sparkD1{0%,100%{transform:scale(0);opacity:0}40%,60%{transform:scale(1.3);opacity:1}}
                        #dtag{animation:tagWiggle 2s ease-in-out infinite;transform-origin:32px 34px;will-change:transform}
                        #dpct{animation:pctPop 1.6s ease-in-out infinite;transform-origin:32px 32px;will-change:transform}
                        #dsp1{animation:sparkD1 1.8s 0.2s ease-in-out infinite;transform-origin:10px 12px;will-change:transform}
                        #dsp2{animation:sparkD1 1.8s 0.8s ease-in-out infinite;transform-origin:52px 14px;will-change:transform}
                      `}</style>
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
                <div className={`ccard cc-pink p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-pink-950/50 border-pink-500' : 'border-pink-700'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #9d174d 0%, #be185d 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fce7f3'} : {color:'#f9a8d4'}}>{t("Monthly Discount", "মাসিক ছাড়")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#f9a8d4'}}>{computedMonthlyDiscount.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#fdf2f8'} : {color:'#6b7280'}}>{t("Discount given this month", "এই মাসে ছাড় দেওয়া হয়েছে")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{`
                        @keyframes calTagFloat{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(-7px) rotate(3deg)}}
                        @keyframes mPctSpin{0%,100%{transform:rotate(0deg) scale(1)}50%{transform:rotate(10deg) scale(1.1)}}
                        #mcal{animation:calTagFloat 2.2s ease-in-out infinite;transform-origin:32px 36px;will-change:transform}
                        #mpct{animation:mPctSpin 2s ease-in-out infinite;transform-origin:40px 40px;will-change:transform}
                      `}</style>
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
                <div className={`ccard cc-rose p-3.5 rounded-xl border-2 relative overflow-hidden shadow-lg ${isDarkMode ? 'bg-rose-950/50 border-rose-400' : 'border-rose-700'}`} style={!isDarkMode ? { background: 'linear-gradient(135deg, #7f1d1d 0%, #991b1b 100%)' } : {}}>
                  <span className="block text-xs font-black uppercase tracking-widest mb-1" style={!isDarkMode ? {color:'#fecaca'} : {color:'#fca5a5'}}>{t("Yearly Discount", "বার্ষিক ছাড়")}</span>
                  <div className="font-mono text-2xl font-black" style={!isDarkMode ? {color:'#ffffff'} : {color:'#fca5a5'}}>{computedYearlyDiscount.toFixed(1)} {currencySymbol}</div>
                  <div className="text-xs font-semibold mt-1" style={!isDarkMode ? {color:'#fee2e2'} : {color:'#6b7280'}}>{t("Total discount this year", "এই বছরের মোট ছাড়")}</div>
                  <div className="absolute right-2 bottom-1" style={{width:'64px',height:'64px',opacity:0.75,willChange:'transform'}}>
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <style>{`
                        @keyframes yrRibbon{0%,100%{transform:rotate(-4deg) scale(1)}50%{transform:rotate(4deg) scale(1.06)}}
                        @keyframes yrBadge{0%,100%{opacity:0.85;transform:scale(1)}50%{opacity:1;transform:scale(1.08)}}
                        @keyframes yrShine{0%{opacity:0.1}50%{opacity:0.5}100%{opacity:0.1}}
                        #yrib{animation:yrRibbon 2s ease-in-out infinite;transform-origin:32px 32px;will-change:transform}
                        #ybdg{animation:yrBadge 2s 0.4s ease-in-out infinite;transform-origin:42px 20px;will-change:transform}
                        #ysh{animation:yrShine 2s ease-in-out infinite}
                      `}</style>
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
                const today = new Date(todayKey);
                const weekDays = Array.from({ length: 7 }, (_, i) => {
                  const d = new Date(today); d.setDate(today.getDate() - (6 - i)); return d;
                });
                const weekSales = weekDays.map(day =>
                  invoices.reduce((s, inv) => {
                    const d = parseCustomDateString(inv.dateString);
                    return (d.getFullYear()===day.getFullYear()&&d.getMonth()===day.getMonth()&&d.getDate()===day.getDate()) ? s+(inv.finalBill||0) : s;
                  }, 0)
                );
                const totalWeek = weekSales.reduce((a,b)=>a+b,0);
                const maxVal = Math.max(...weekSales, 1);
                const maxIdx = weekSales.indexOf(Math.max(...weekSales));
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
                  <div className={`ccard cc-amber p-3 rounded-xl border ${isDarkMode ? 'bg-amber-950/50 border-amber-600' : 'bg-amber-200 border-amber-400 shadow-sm'}`}>
                    <h4 className="text-sm font-black uppercase text-teal-500 mb-2">📦 {t("Total Stock", "মোট স্টক")}</h4>
                    <div className="flex flex-col gap-1 text-sm">
                      <div className="flex justify-between"><span className="text-slate-400">{t("Total Items:", "মোট আইটেম:")}</span><span className="font-mono font-black">{medicines.length}</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">{t("Total Units:", "মোট পরিমাণ:")}</span><span className="font-mono font-black">{medicines.reduce((s, m) => s + m.stock, 0)}</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">{t("Buy Value:", "ক্রয় মূল্য:")}</span><span className="font-mono font-black text-amber-500">{totalStockValue.toFixed(1)} {currencySymbol}</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">{t("Sell Value:", "বিক্রয় মূল্য:")}</span><span className="font-mono font-black text-emerald-500">{totalStockRetailValue.toFixed(1)} {currencySymbol}</span></div>
                    </div>
                  </div>

                  {/* Low Stock Alert */}
                  {checkShouldRenderTabOption("low_stock_alerts") && (
                    <div className={`ccard cc-emerald p-3 rounded-xl border ${isDarkMode ? 'bg-emerald-950/50 border-emerald-600' : 'bg-emerald-50 border-emerald-300 shadow-sm'}`}>
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

                  {/* Expired */}
                  {checkShouldRenderTabOption("expired_meds_view") && (
                    <div className={`ccard cc-blue p-3 rounded-xl border ${isDarkMode ? 'bg-blue-950/50 border-blue-600' : 'bg-blue-200 border-blue-400 shadow-sm'}`}>
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
                </div>
              )}

              {/* Category Stock */}
              {checkShouldRenderTabOption("category_wise_stock") && (
                <div className={`ccard cc-red p-3 rounded-xl border ${isDarkMode ? 'bg-red-950/50 border-red-600' : 'bg-red-200 border-red-400 shadow-sm'}`}>
                  <h4 className="text-sm font-black uppercase text-teal-500 mb-3">📊 {t("Stock by Category", "ক্যাটাগরি অনুযায়ী স্টক")}</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
                    {allCategories.map(cat => {
                      const total = countStockByCategory(cat);
                      if (total === 0) return null;
                      return (
                        <div key={cat} className={`p-2 rounded-lg text-sm text-center ${isDarkMode ? 'bg-slate-900/60' : 'bg-slate-50'}`}>
                          <div className="font-black text-teal-500 text-sm font-mono">{total}</div>
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
                  <h3 className="text-sm font-black uppercase tracking-wider text-teal-500">{t("Medicine Stock List", "ওষুধের স্টক তালিকা")} ({medicines.length})</h3>
                  <div className="flex gap-2">
                    <input type="text" placeholder={t("Search...", "খুঁজুন...")} value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className={`px-2 py-1 text-sm rounded border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
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
                      {filteredMedicines.map((med, index) => {
                        const isEditing = editingId === med.id;
                        const medLowAlert = med.lowStockAlert || activeThreshold;
                        const lowStockFlag = med.stock <= medLowAlert;
                        const expiredFlag = new Date(med.expire) < new Date();

                        return (
                          <tr key={med.id} className={`transition-colors hover:bg-slate-500/5 ${expiredFlag ? 'bg-red-500/5' : lowStockFlag ? 'bg-amber-500/5' : ''}`}>
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
                            <td className="p-2.5 font-mono font-bold text-teal-500">
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
                                  <button onClick={() => setEditingId(null)} className="bg-slate-400 text-white text-sm font-bold px-2 py-0.5 rounded hover:bg-slate-500 transition">{t("Cancel", "বাতিল")}</button>
                                </div>
                              ) : (
                                <div className="flex gap-1.5 justify-center">
                                  <button onClick={() => startEditing(med)} className="text-teal-500 hover:text-teal-600 font-bold transition">✏️</button>
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
                <div className={`ccard cc-orange p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-orange-950/50 border-orange-600' : 'bg-orange-50 border-orange-300'}`}>
                  <h3 className="text-sm font-black uppercase tracking-wider text-teal-500 mb-3">📥 {t("Add Medicine to Purchase", "ক্রয়ে ওষুধ যোগ করুন")}</h3>

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
                      <div className={`absolute z-20 w-72 max-h-48 overflow-y-auto rounded-xl shadow-2xl border mt-1 ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                        {companySuggestions.map(name => (
                          <div key={name} className={`flex items-center justify-between px-3 py-1.5 cursor-pointer text-sm font-semibold hover:bg-teal-500/10 ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
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
                        <div className={`absolute z-20 w-72 max-h-48 overflow-y-auto rounded-xl shadow-2xl border mt-1 ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                          {pMedicineSuggestions.map(item => (
                            <div key={item.name} className={`flex items-center justify-between px-3 py-1.5 cursor-pointer text-sm font-semibold hover:bg-teal-500/10 ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
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
                                {item.company && <span className="ml-1 text-sm text-teal-400">· {item.company}</span>}
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
                      <button type="submit" className="bg-teal-500 hover:bg-teal-600 text-white font-black px-5 py-2 rounded-lg uppercase tracking-wider shadow-sm transition">+ {t("Add to List", "তালিকায় যোগ করুন")}</button>
                    </div>
                  </form>
                </div>

                {/* Purchase Cart */}
                {purchaseCart.length > 0 && (
                  <div className={`ccard cc-orange p-3 rounded-xl border ${isDarkMode ? 'bg-orange-950/50 border-orange-600' : 'bg-orange-200 border-orange-400 shadow-sm'}`}>
                    <h4 className="text-sm font-black uppercase text-teal-500 mb-2">📋 {t("Items Added", "যোগ করা আইটেম")} ({purchaseCart.length})</h4>
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
                        <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>{t("Total:", "মোট:")} <strong className="text-teal-500 font-mono">{bulkCartTotalCost.toFixed(1)} {currencySymbol}</strong></span>
                        <div>
                          <label className={`text-sm font-bold mr-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Paid:", "পরিশোধ:")}</label>
                          <input type="number" value={pAmountPaid} onChange={e => setPAmountPaid(e.target.value)} placeholder={t("Amount paid...", "পরিশোধিত...")} className={`px-2 py-1 rounded border text-sm outline-none font-mono w-28 ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                        </div>
                        {currentUserRole === "ADMIN" && <span className="text-red-400 font-bold font-mono">{t("Due:", "বাকি:")} {bulkCartCalculatedDue.toFixed(1)}</span>}
                      </div>
                      <button onClick={handleBulkPurchaseMasterSubmit} className="bg-teal-500 hover:bg-teal-600 text-white font-black text-sm px-5 py-2 rounded-xl uppercase tracking-wider shadow transition">
                        📥 {t("Save Purchase", "ক্রয় সংরক্ষণ")}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Right: Purchase History */}
              {checkShouldRenderTabOption("purchase_reports") && (
                <div className="xl:col-span-3">
                  <div className={`ccard cc-emerald p-3 rounded-xl border shadow-sm ${isDarkMode ? 'bg-emerald-950/50 border-emerald-600' : 'bg-emerald-50 border-emerald-300'}`}>
                    <h3 className="text-sm font-black uppercase tracking-wider text-teal-500 mb-2">{t("Purchase History", "ক্রয়ের ইতিহাস")}</h3>
                    {currentUserRole === "ADMIN" && (
                      <div className="mb-2 text-sm flex justify-between">
                        <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>{t("Total:", "মোট:")} <strong className="text-teal-500 font-mono">{grandTotalPurchaseCost.toFixed(1)} {currencySymbol}</strong></span>
                        <span className="text-red-400 font-bold">{t("Due:", "বাকি:")} <strong className="font-mono">{grandTotalPurchaseDue.toFixed(1)}</strong></span>
                      </div>
                    )}
                    <div className="flex flex-col gap-2 max-h-[500px] overflow-y-auto">
                      {purchaseList.map(log => (
                        <div key={log.id} className={`p-2.5 rounded-xl border flex flex-col gap-1 text-sm ${isDarkMode ? 'bg-slate-900/60 border-slate-700/60' : 'bg-slate-50 border-slate-200'}`}>
                          <div className="flex items-center justify-between font-bold">
                            <span className="text-teal-500 truncate max-w-[140px]">{log.medicineName}</span>
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
                <h2 className="text-sm font-black uppercase tracking-wider text-teal-500 mb-1">➕ {t("Add New Product", "নতুন পণ্য যোগ করুন")}</h2>
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
                      className={`w-full px-3 py-2 rounded-lg border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white placeholder-slate-500' : 'bg-slate-50 border-slate-200'}`}
                    />
                    {showNpCompanySuggestions && npCompanySuggestions.length > 0 && (
                      <div className={`absolute z-30 w-full mt-1 rounded-xl border shadow-lg max-h-40 overflow-y-auto ${isDarkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}>
                        {npCompanySuggestions.slice(0, 8).map(c => (
                          <button type="button" key={c} onClick={() => { setNpCompanyName(c); setShowNpCompanySuggestions(false); }}
                            className={`w-full text-left px-3 py-2 text-sm hover:bg-teal-500/10 transition ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
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
                      className={`w-full px-3 py-2 rounded-lg border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white placeholder-slate-500' : 'bg-slate-50 border-slate-200'}`}
                      required
                    />
                    {showNpMedSuggestions && npMedSuggestions.length > 0 && (
                      <div className={`absolute z-30 w-full mt-1 rounded-xl border shadow-lg max-h-48 overflow-y-auto ${isDarkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}>
                        {npMedSuggestions.slice(0, 10).map(item => (
                          <button type="button" key={item.name} onClick={() => handleNpMedSelect(item)}
                            className={`w-full text-left px-3 py-2 text-sm hover:bg-teal-500/10 transition ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
                            <span className="font-bold">{item.name}</span>
                            {item.buyPrice > 0 && <span className="ml-2 text-teal-500 font-mono text-sm">Buy: {item.buyPrice} / Sell: {item.sellPrice}</span>}
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
                      className={`w-full px-3 py-2 rounded-lg border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white placeholder-slate-500' : 'bg-slate-50 border-slate-200'}`}
                    />
                  </div>

                  {/* Category */}
                  <div>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Category", "ক্যাটাগরি")}</label>
                    <select value={npCategory} onChange={e => setNpCategory(e.target.value)}
                      className={`w-full px-3 py-2 rounded-lg border text-sm outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}>
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
                        className={`w-full px-3 py-2 rounded-lg border text-sm outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
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
                        className={`w-full px-3 py-2 rounded-lg border text-sm outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`}
                        required
                      />
                    </div>
                  </div>

                  {/* Info box */}
                  <div className={`rounded-lg p-3 text-sm flex items-start gap-2 ${isDarkMode ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400' : 'bg-amber-50 border border-amber-200 text-amber-700'}`}>
                    <span className="text-base shrink-0">ℹ️</span>
                    <span>{t("After adding, this product will appear in Stock In suggestions. Add quantity via Stock In — it will then become available in Sell.", "যোগ করার পর এই পণ্য স্টক ইন-এ সাজেশনে আসবে। স্টক ইন থেকে পরিমাণ যোগ করলে তবেই বিক্রয়তে দেখা যাবে।")}</span>
                  </div>

                  <div className="flex gap-2">
                    <button type="button" onClick={() => { setNpMedicineName(""); setNpCompanyName(""); setNpGenericName(""); setNpBuyPrice(""); setNpSalePrice(""); setNpCategory("Tablet"); }}
                      className={`px-4 py-2.5 rounded-lg text-sm font-bold transition ${isDarkMode ? 'bg-slate-700 text-slate-300 hover:bg-slate-600' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                      {t("Clear", "মুছুন")}
                    </button>
                    <button type="submit" className="flex-1 bg-teal-500 hover:bg-teal-600 text-white font-black py-2.5 rounded-lg text-sm uppercase tracking-wider shadow transition btn-press">
                      ✅ {t("Save Product", "পণ্য সেভ করুন")}
                    </button>
                    <button type="button" onClick={() => { setActiveTab("procurement"); }}
                      className="px-4 py-2.5 bg-indigo-500 hover:bg-indigo-600 text-white font-bold rounded-lg text-sm transition btn-press">
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
                  <div className="hidden print:block fixed inset-0 bg-white z-[9999] p-8 text-black">
                    <div className="max-w-sm mx-auto text-center border border-slate-300 p-5 rounded">
                      <h2 className="font-black text-base uppercase">{pharmacyName}</h2>
                      <p className="text-sm">{pharmacyAddress}</p>
                      <div className="border-b border-dashed border-slate-400 my-2"></div>
                      <h3 className="font-black text-sm uppercase">{t("Purchase Invoice", "ক্রয় ভাউচার")}</h3>
                      <div className="border-b border-dashed border-slate-400 my-2"></div>
                      <div className="text-left text-sm flex flex-col gap-0.5 mb-3">
                        <div className="flex justify-between"><span>{t("Voucher:", "ভাউচার নং:")}</span><span className="font-bold">{selectedVoucher.voucherId}</span></div>
                        <div className="flex justify-between"><span>{t("Supplier:", "সরবরাহকারী:")}</span><span className="font-bold">{selectedVoucher.companyName}</span></div>
                        <div className="flex justify-between"><span>{t("Date:", "তারিখ:")}</span><span>{selectedVoucher.dateStr}</span></div>
                      </div>
                      <div className="border-b border-dashed border-slate-400 my-2"></div>
                      <table className="w-full text-left text-sm border-collapse mb-3">
                        <thead>
                          <tr className="font-black border-b border-slate-300">
                            <th className="py-1">{t("Medicine", "ওষুধ")}</th>
                            <th className="py-1 text-center">{t("Qty", "পরিমাণ")}</th>
                            <th className="py-1 text-right">{t("Rate", "মূল্য")}</th>
                            <th className="py-1 text-right">{t("Total", "মোট")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedVoucher.items.map((item: any, i: number) => (
                            <tr key={i} className="border-b border-slate-100">
                              <td className="py-1">
                                <div className="font-bold">{item.medicineName}</div>
                                {item.batchNo && item.batchNo !== 'N/A' && <div className="text-sm text-slate-400">{t("Batch:", "ব্যাচ:")} {item.batchNo}</div>}
                                {item.expireDate && item.expireDate !== 'N/A' && <div className="text-sm text-slate-400">{t("Exp:", "মেয়াদ:")} {item.expireDate}</div>}
                              </td>
                              <td className="py-1 text-center font-mono">{item.quantity}</td>
                              <td className="py-1 text-right font-mono">{item.unitPrice?.toFixed(2) || '-'}</td>
                              <td className="py-1 text-right font-mono font-bold">{item.totalCost?.toFixed(1)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="border-b border-dashed border-slate-400 my-2"></div>
                      <div className="flex flex-col gap-1 text-sm text-right font-semibold">
                        <div className="flex justify-between"><span>{t("Total Cost:", "মোট খরচ:")}</span><span className="font-mono font-black">{selectedVoucher.totalCost.toFixed(1)} {currencySymbol}</span></div>
                        <div className="flex justify-between"><span>{t("Paid:", "পরিশোধ:")}</span><span className="font-mono text-emerald-600">{selectedVoucher.totalPaid.toFixed(1)} {currencySymbol}</span></div>
                        {selectedVoucher.totalDue > 0 && <div className="flex justify-between text-red-600 font-black"><span>{t("Due:", "বাকি:")}</span><span className="font-mono">{selectedVoucher.totalDue.toFixed(1)} {currencySymbol}</span></div>}
                      </div>
                      <div className="border-b border-dashed border-slate-400 my-3"></div>
                      <p className="text-sm font-bold uppercase">{t("Thank you!", "ধন্যবাদ!")}</p>
                    </div>
                  </div>
                )}

                <div className={`ccard cc-violet p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-violet-950/50 border-violet-600' : 'bg-violet-50 border-violet-300'}`}>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-sm font-black uppercase tracking-wider text-teal-500">📋 {t("Purchase History", "ক্রয়ের ইতিহাস")}</h3>
                      <p className={`text-sm mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{vouchers.length} {t("vouchers", "ভাউচার")} · {purchaseList.length} {t("items total", "টি আইটেম")}</p>
                    </div>
                    <div className={`text-right text-sm font-bold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                      <div>{t("Total Purchased:", "মোট ক্রয়:")} <span className="font-mono text-teal-500">{grandTotalPurchaseCost.toFixed(1)} {currencySymbol}</span></div>
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
                              <span className={`text-sm font-black font-mono px-2 py-0.5 rounded ${isDarkMode ? 'bg-teal-500/20 text-teal-400' : 'bg-teal-50 text-teal-600'}`}>{v.voucherId}</span>
                              <div>
                                <div className="text-sm font-black">{v.companyName}</div>
                                <div className={`text-sm font-mono ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{v.dateStr}</div>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <div className="text-right hidden sm:block">
                                <div className="text-sm font-black font-mono text-teal-500">{v.totalCost.toFixed(1)} {currencySymbol}</div>
                                {v.totalDue > 0 && <div className="text-sm font-mono text-red-400">{t("Due:", "বাকি:")} {v.totalDue.toFixed(1)}</div>}
                              </div>
                              <div className="flex gap-1.5">
                                <button
                                  onClick={() => { setSelectedVoucher(v); setTimeout(() => window.print(), 300); playSound('print'); }}
                                  className={`p-1.5 rounded-lg text-sm font-bold transition btn-press ${isDarkMode ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500 hover:text-white' : 'bg-blue-50 text-blue-500 hover:bg-blue-500 hover:text-white'}`}
                                  title={t("Print Invoice", "প্রিন্ট করুন")}
                                >🖨️</button>
                                {currentUserRole === "ADMIN" && (
                                  <button
                                    onClick={() => handleDeleteVoucher(v)}
                                    className={`p-1.5 rounded-lg text-sm font-bold transition btn-press ${isDarkMode ? 'bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white' : 'bg-red-50 text-red-500 hover:bg-red-500 hover:text-white'}`}
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
                                    {checkShouldRenderTabOption("purchase_reports") && <td className="px-4 py-2 text-right font-mono font-black text-teal-500">{item.totalCost?.toFixed(1)}</td>}
                                  </tr>
                                ))}
                              </tbody>
                              {checkShouldRenderTabOption("purchase_reports") && (
                                <tfoot>
                                  <tr className={`font-black text-sm border-t-2 ${isDarkMode ? 'border-slate-600 bg-slate-900/40' : 'border-slate-300 bg-slate-100'}`}>
                                    <td colSpan={checkShouldRenderTabOption("batch_tracking") && checkShouldRenderTabOption("expiry_tracker") ? 5 : checkShouldRenderTabOption("batch_tracking") || checkShouldRenderTabOption("expiry_tracker") ? 4 : 3} className="px-4 py-2 text-right uppercase">{t("Total:", "মোট:")}</td>
                                    <td className="px-4 py-2 text-right font-mono text-teal-500">{v.totalCost.toFixed(1)} {currencySymbol}</td>
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
              TAB 5: INVOICES
          ========================================================= */}
          {activeTab === "invoices" && checkShouldRenderTabOption("invoices") && (
            <div className={`ccard cc-pink p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-pink-950/50 border-pink-600' : 'bg-pink-50 border-pink-300'}`}>
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mb-4">
                <h3 className="text-sm font-black uppercase tracking-wider text-teal-500">{t("Customer Invoices", "গ্রাহকের রশিদ")} ({invoices.length})</h3>
                {checkShouldRenderTabOption("invoice_search") && (
                  <input type="text" placeholder={t("Search by invoice, customer, phone...", "রশিদ নং, নাম বা ফোনে খুঁজুন...")} value={searchInvoiceQuery} onChange={e => setSearchInvoiceQuery(e.target.value)} className={`px-3 py-1.5 text-sm rounded-lg border outline-none max-w-sm w-full ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
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
                    {filteredInvoices.map(inv => (
                      <tr key={inv.invoiceId} className="hover:bg-slate-500/5 transition-colors">
                        <td className="p-2.5 font-mono font-black text-teal-500">{inv.invoiceId}</td>
                        <td className="p-2.5 font-bold">
                          <div>{inv.customer}</div>
                          <div className="text-sm text-slate-400 font-mono">{inv.phone}</div>
                        </td>
                        <td className="p-2.5 font-mono text-slate-400 text-sm">{inv.dateString}</td>
                        <td className="p-2.5 font-mono text-right font-black text-teal-500">{inv.finalBill.toFixed(1)} {currencySymbol}</td>
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
                            : <span className="text-xs bg-teal-500/10 text-teal-500 font-black uppercase px-2 py-0.5 rounded">{t("Paid", "পরিশোধ")}</span>
                          }
                        </td>
                        <td className="p-2.5 text-center">
                          <div className="flex gap-2 justify-center">
                            <button onClick={() => viewInvoiceLog(inv)} className="bg-slate-500 hover:bg-slate-600 text-white font-bold text-sm px-2 py-0.5 rounded transition">🔍</button>
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
            </div>
          )}

          {/* =========================================================
              TAB 6: DUE LIST
          ========================================================= */}
          {activeTab === "due_list" && checkShouldRenderTabOption("due_list_view") && (
            <div className={`ccard cc-rose p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-rose-950/50 border-rose-600' : 'bg-rose-50 border-rose-300'}`}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-black uppercase tracking-wider text-teal-500">💳 {t("Customer Due List", "গ্রাহকের বাকি তালিকা")}</h3>
                <div className="flex items-center gap-3">
                  <div className={`text-sm font-bold ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                    {t("Total Outstanding:", "মোট বাকি:")} <span className="text-red-500 font-mono font-black">{totalDueFromCustomers.toFixed(1)} {currencySymbol}</span>
                  </div>
                  <button onClick={() => window.print()} className="bg-teal-500 hover:bg-teal-600 text-white font-bold text-sm px-3 py-1.5 rounded-lg transition uppercase tracking-wider">🖨️ {t("Print", "প্রিন্ট")}</button>
                </div>
              </div>

              {/* Search Bar */}
              <div className="mb-3">
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
              ) : (
                <div className="overflow-x-auto">
                  {(() => {
                    const filtered = dueSearch.trim()
                      ? dueList.filter(d =>
                          d.customerName.toLowerCase().includes(dueSearch.toLowerCase()) ||
                          (d.phone && d.phone.includes(dueSearch))
                        )
                      : dueList;
                    return filtered.length === 0 ? (
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
                            <button onClick={() => { setDuePaymentModal(due); setDuePayAmount(""); }} className="bg-teal-500 hover:bg-teal-600 text-white font-bold text-sm px-3 py-1 rounded transition">
                              💰 {t("Collect Payment", "পরিশোধ নিন")}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {/* =========================================================
              TAB 7: RETURNS
          ========================================================= */}
          {activeTab === "returns" && checkShouldRenderTabOption("returns") && (
            <div className={`ccard cc-green p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-green-950/50 border-green-600' : 'bg-green-50 border-green-300'}`}>
              <h3 className="text-sm font-black uppercase tracking-wider text-teal-500 mb-2">🔄 {t("Returns & Exchanges", "ফেরত ও বিনিময়")}</h3>
              <p className="text-sm text-slate-400 mb-4">{t("Log of orders where a return or exchange was processed.", "যে সব অর্ডার ফেরত বা বিনিময় করা হয়েছে।")}</p>

              <div className="overflow-x-auto w-full">
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
                    {invoices.filter(i => i.isReturned && i.returnDetails).map(inv => (
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
                    {invoices.filter(i => i.isReturned).length === 0 && (
                      <tr><td colSpan={6} className="text-center p-8 text-slate-400 italic">{t("No returns logged.", "কোনো ফেরত নেই।")}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* =========================================================
              TAB: REPORT - Full Stock Report with Print
          ========================================================= */}
          {activeTab === "report" && checkShouldRenderTabOption("report_view") && (
            <div className={`ccard cc-slate p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-slate-800 border-slate-500' : 'bg-slate-100 border-slate-400'}`}>
              <div className="flex items-center justify-between mb-4 print:hidden">
                <div>
                  <h3 className="text-sm font-black uppercase tracking-wider text-teal-500">📋 {t("Stock Report", "স্টক রিপোর্ট")}</h3>
                  <p className={`text-sm mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("All medicines currently in stock with prices", "দোকানে বর্তমানে সব মালের তালিকা ও দাম")}</p>
                </div>
                <button onClick={() => window.print()} className="bg-teal-500 hover:bg-teal-600 text-white font-bold text-sm px-4 py-2 rounded-lg transition uppercase tracking-wider shadow">🖨️ {t("Print Report", "রিপোর্ট প্রিন্ট করুন")}</button>
              </div>

              {/* Print Header - only shows on print */}
              <div className="hidden print:block mb-4 text-center border-b pb-3">
                <h1 className="text-xl font-black">{pharmacyName}</h1>
                <p className="text-sm">{pharmacyAddress}</p>
                <h2 className="text-base font-bold mt-2">{t("Stock Report", "স্টক রিপোর্ট")} — {new Date().toLocaleDateString()}</h2>
              </div>

              {/* Summary Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div className={`ccard cc-blue p-3 rounded-xl border text-center ${isDarkMode ? 'bg-blue-950/50 border-blue-600' : 'bg-blue-50 border-blue-300'}`}>
                  <p className={`text-sm font-bold uppercase ${isDarkMode ? 'text-slate-400' : 'text-teal-600'}`}>{t("Total Items", "মোট আইটেম")}</p>
                  <p className="text-xl font-black text-teal-500">{medicines.length}</p>
                </div>
                <div className={`ccard cc-red p-3 rounded-xl border text-center ${isDarkMode ? 'bg-red-950/50 border-red-600' : 'bg-red-50 border-red-300'}`}>
                  <p className={`text-sm font-bold uppercase ${isDarkMode ? 'text-slate-400' : 'text-blue-600'}`}>{t("Total Stock (pcs)", "মোট স্টক (পিস)")}</p>
                  <p className="text-xl font-black text-blue-500">{medicines.reduce((s, m) => s + m.stock, 0)}</p>
                </div>
                <div className={`ccard cc-orange p-3 rounded-xl border text-center ${isDarkMode ? 'bg-orange-950/50 border-orange-600' : 'bg-orange-50 border-orange-300'}`}>
                  <p className={`text-sm font-bold uppercase ${isDarkMode ? 'text-slate-400' : 'text-amber-600'}`}>{t("Buy Value", "ক্রয় মূল্য মোট")}</p>
                  <p className="text-xl font-black text-amber-500 font-mono">{totalStockValue.toFixed(0)} {currencySymbol}</p>
                </div>
                <div className={`ccard cc-violet p-3 rounded-xl border text-center ${isDarkMode ? 'bg-violet-950/50 border-violet-600' : 'bg-violet-50 border-violet-300'}`}>
                  <p className={`text-sm font-bold uppercase ${isDarkMode ? 'text-slate-400' : 'text-emerald-600'}`}>{t("Sell Value", "বিক্রয় মূল্য মোট")}</p>
                  <p className="text-xl font-black text-emerald-500 font-mono">{totalStockRetailValue.toFixed(0)} {currencySymbol}</p>
                </div>
              </div>

              {/* Full Medicine Table */}
              <div className="overflow-x-auto w-full">
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
                          <td className="p-2.5 text-right font-mono font-black text-teal-500">{med.price.toFixed(1)}</td>
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

              {/* Print footer */}
              <div className="hidden print:block mt-6 pt-3 border-t text-center text-sm text-slate-500">
                <p>{t("Printed on:", "প্রিন্ট তারিখ:")} {new Date().toLocaleString()} | {pharmacyName}</p>
              </div>
            </div>
          )}

          {/* =========================================================
              TAB 8: SETTINGS
          ========================================================= */}
          {activeTab === "settings" && checkShouldRenderTabOption("settings") && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

              {/* Website Info */}
              <div className={`ccard cc-cyan p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-cyan-950/50 border-cyan-600' : 'bg-cyan-50 border-cyan-300'}`}>
                <h3 className="text-sm font-black uppercase tracking-wider text-teal-500 mb-3">🏪 {t("Pharmacy Info", "ফার্মেসির তথ্য")}</h3>
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
                    <input type="text" value={settingsLogo} onChange={e => setSettingsLogo(e.target.value)} className={`w-full px-3 py-2 rounded-xl border outline-none ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                  </div>
                  <button onClick={handleSaveWebsiteConfig} className="bg-teal-500 hover:bg-teal-600 text-white font-black px-4 py-2 rounded-xl text-sm transition">{t("Save Info", "তথ্য সংরক্ষণ")}</button>
                </div>
              </div>

              {/* Advanced Config */}
              <div className={`ccard cc-purple p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-purple-950/50 border-purple-600' : 'bg-purple-50 border-purple-300'}`}>
                <h3 className="text-sm font-black uppercase tracking-wider text-teal-500 mb-3">⚙️ {t("Advanced Settings", "উন্নত সেটিংস")}</h3>
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
                        { key: 'ocean',    emoji: '🌊', label: t('Ocean',    'সমুদ্র'),      dot: '#0a1628', dotB: '#38bdf8', ring: '#38bdf8' },
                        { key: 'forest',   emoji: '🌿', label: t('Forest',   'বন'),          dot: '#0a1a0f', dotB: '#34d399', ring: '#34d399' },
                        { key: 'royal',    emoji: '👑', label: t('Royal',    'রাজকীয়'),     dot: '#160a28', dotB: '#a78bfa', ring: '#a78bfa' },
                        { key: 'sunset',   emoji: '🌅', label: t('Sunset',   'সূর্যাস্ত'),   dot: '#1a0a05', dotB: '#fb923c', ring: '#fb923c' },
                        { key: 'cherry',   emoji: '🌸', label: t('Cherry',   'চেরি'),        dot: '#1a0510', dotB: '#f472b6', ring: '#f472b6' },
                        { key: 'midnight', emoji: '🌌', label: t('Midnight', 'মধ্যরাত'),     dot: '#050508', dotB: '#818cf8', ring: '#818cf8' },
                        { key: 'nordic',   emoji: '❄️', label: t('Nordic',   'নর্ডিক'),      dot: '#1a1f2e', dotB: '#89dceb', ring: '#89dceb' },
                        { key: 'lava',     emoji: '🌋', label: t('Lava',     'লাভা'),        dot: '#110805', dotB: '#f97316', ring: '#f97316' },
                        { key: 'glacier',  emoji: '🏔️', label: t('Glacier',  'হিমবাহ'),      dot: '#f0f6ff', dotB: '#2563eb', ring: '#2563eb' },
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
                      <button onClick={() => handleLanguageChange("en")} className={`flex-1 py-1.5 rounded-lg text-sm font-black transition ${language === "en" ? 'bg-teal-500 text-white' : isDarkMode ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>🇬🇧 English</button>
                      <button onClick={() => handleLanguageChange("bn")} className={`flex-1 py-1.5 rounded-lg text-sm font-black transition ${language === "bn" ? 'bg-teal-500 text-white' : isDarkMode ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>🇧🇩 বাংলা</button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Login Credentials */}
              <div className={`ccard cc-teal p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-teal-950/50 border-teal-600' : 'bg-teal-50 border-teal-300'}`}>
                <h3 className="text-sm font-black uppercase tracking-wider text-teal-500 mb-3">🔐 {t("Login Credentials", "লগইন তথ্য পরিবর্তন")}</h3>

                {!isCredentialsFormUnlocked ? (
                  <form onSubmit={handleVerifyCurrentPassword} className="flex gap-2 items-center">
                    <input
                      type="password"
                      placeholder={t("Enter current admin password to unlock...", "আনলক করতে বর্তমান পাসওয়ার্ড দিন...")}
                      value={currentPassCheck}
                      onChange={e => setCurrentPassCheck(e.target.value)}
                      className={`px-3 py-1.5 text-sm rounded border outline-none flex-1 ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-100 border-slate-200'}`}
                    />
                    <button type="submit" className="bg-slate-600 text-white text-sm font-bold px-3 py-1.5 rounded uppercase transition">{t("Unlock", "আনলক")}</button>
                  </form>
                ) : (
                  <form onSubmit={handleSaveNewCredentials} className="flex flex-col gap-3 text-sm">
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
                      <div className="col-span-2">
                        <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Secret Code (for Forgot Password)", "সিক্রেট কোড (পাসওয়ার্ড ভুললে)")}</label>
                        <input type="text" value={newSecretCodeInput} onChange={e => setNewSecretCodeInput(e.target.value)} className={`w-full px-2 py-1.5 rounded border outline-none font-mono ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200'}`} />
                        <p className="text-sm text-slate-400 mt-1">{t("Keep this code safe. Use it to reset your password if forgotten.", "এই কোডটি সুরক্ষিত রাখুন। পাসওয়ার্ড ভুললে এটি ব্যবহার করুন।")}</p>
                      </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                      <button type="button" onClick={() => setIsCredentialsFormUnlocked(false)} className={`px-3 py-1.5 text-sm font-bold rounded transition ${isDarkMode ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-500'}`}>{t("Cancel", "বাতিল")}</button>
                      <button type="submit" className="bg-emerald-500 text-white font-black text-sm px-4 py-1.5 rounded uppercase tracking-wider shadow">{t("Save Credentials", "সংরক্ষণ করুন")}</button>
                    </div>
                  </form>
                )}
              </div>

              {/* Backup & Restore Section */}
              {checkShouldRenderTabOption("backup_restore") && (
                <div className={`ccard cc-blue p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-blue-950/50 border-blue-600' : 'bg-blue-50 border-blue-300'}`}>
                  <h3 className="text-sm font-black uppercase tracking-wider text-blue-500 mb-1 flex items-center gap-2">
                    💾 {t("Backup & Restore", "ব্যাকআপ ও পুনরুদ্ধার")}
                  </h3>
                  <p className={`text-sm mb-3 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                    {t("Keep your data safe across all devices. Download a JSON backup and store it in Google Drive, Email, or any safe location.", "সব ডিভাইসে ডেটা নিরাপদ রাখুন। JSON ব্যাকআপ ডাউনলোড করে Google Drive, Email বা যেকোনো নিরাপদ জায়গায় রাখুন।")}
                  </p>

                  {/* Last Backup Status */}
                  <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm mb-3 ${isDarkMode ? 'bg-slate-800' : 'bg-white border border-slate-200'}`}>
                    <span className="text-xl">🕐</span>
                    <div>
                      <span className={`font-bold block text-sm ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>{t("Last Backup:", "শেষ ব্যাকআপ:")}</span>
                      <span className={`text-sm font-mono ${lastBackupTime ? 'text-emerald-500 font-bold' : 'text-red-400'}`}>
                        {lastBackupTime || t("⚠️ No backup yet!", "⚠️ এখনো ব্যাকআপ হয়নি!")}
                      </span>
                    </div>
                  </div>

                  {/* Triple Safety Guide */}
                  <div className={`rounded-lg p-3 mb-3 text-sm ${isDarkMode ? 'bg-emerald-950/40 border border-emerald-700' : 'bg-emerald-50 border border-emerald-200'}`}>
                    <p className="font-black text-emerald-500 mb-1.5">🛡️ {t("Triple Safety System", "তিন স্তরের নিরাপত্তা")}</p>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2"><span className="text-emerald-500">✅</span><span className={isDarkMode ? 'text-slate-300' : 'text-slate-600'}>{t("Firebase Cloud — auto syncs 24/7", "Firebase Cloud — সবসময় অটো সিঙ্ক")}</span></div>
                      <div className="flex items-center gap-2"><span className="text-blue-500">✅</span><span className={isDarkMode ? 'text-slate-300' : 'text-slate-600'}>{t("Download JSON → save to Google Drive or Email", "JSON ডাউনলোড → Google Drive বা Email এ রাখুন")}</span></div>
                      <div className="flex items-center gap-2"><span className="text-purple-500">✅</span><span className={isDarkMode ? 'text-slate-300' : 'text-slate-600'}>{t("Firebase Backup Node — extra cloud snapshot", "Firebase Backup Node — আলাদা ক্লাউড কপি")}</span></div>
                    </div>
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

                    {/* Restore */}
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
                    💡 {t("Tip: After downloading, upload to Google Drive or send to your email for safekeeping.", "টিপস: ডাউনলোড করার পর Google Drive এ আপলোড করুন বা নিজের ইমেইলে পাঠান।")}
                  </p>
                </div>
              )}

              {/* Danger Zone */}
              {checkShouldRenderTabOption("backup_restore") && (
                <div className={`ccard cc-indigo p-4 rounded-xl border shadow-sm border-red-500/20 ${isDarkMode ? 'bg-indigo-950/50 border-indigo-600' : 'bg-indigo-50 border-indigo-300'}`}>
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
            <div className={`ccard cc-green mt-4 p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-green-950/50 border-green-600' : 'bg-green-50 border-green-300'}`}>
              <h3 className="text-sm font-black uppercase tracking-wider text-blue-500 mb-1">☁️ {t("Cloud Sync Setup (Firebase)", "ক্লাউড সিঙ্ক সেটআপ (Firebase)")}</h3>
              {isFirebaseConfigured() ? (
                <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-bold ${isDarkMode ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'}`}>
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
                  <div className={`font-mono text-sm p-2 rounded-lg mt-1 select-all ${isDarkMode ? 'bg-slate-900 text-slate-300' : 'bg-slate-100 text-slate-700'}`}>
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
                  { key: "invoices",         label: t("Invoices", "রশিদ") },
                  { key: "due_list_view",    label: t("Due List", "বাকি তালিকা") },
                  { key: "report_view",      label: t("Report", "রিপোর্ট") },
                  { key: "returns",          label: t("Returns", "ফেরত") },
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
                <div className={`ccard cc-amber p-4 rounded-xl border shadow-sm ${isDarkMode ? 'bg-amber-950/50 border-amber-600' : 'bg-amber-50 border-amber-300'}`}>
                  <h3 className="text-sm font-black uppercase tracking-wider text-teal-500 mb-1">🛡️ {t("Staff Permissions", "স্টাফ অনুমতি")}</h3>
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
                                className={`ccard cc-teal p-3 rounded-xl border flex items-center justify-between gap-3 cursor-pointer select-none transition-all ${isOn ? 'border-teal-500 bg-teal-500/5' : isDarkMode ? 'bg-slate-900/40 border-slate-700/60 opacity-50' : 'bg-slate-50 border-slate-200 opacity-50'}`}
                              >
                                <div className="flex items-center gap-2">
                                  <span className="text-sm">{isOn ? '✅' : '❌'}</span>
                                  <span className={`text-sm font-bold ${isOn ? (isDarkMode ? 'text-white' : 'text-slate-700') : 'text-slate-400'}`}>{label}</span>
                                </div>
                                <div className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${isOn ? 'bg-teal-500' : isDarkMode ? 'bg-slate-700' : 'bg-slate-300'}`}>
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

        </main>
      </div>

      {/* =========================================================
          MODAL 1: CHECKOUT CONFIRMATION
      ========================================================= */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className={`ccard cc-pink max-w-md w-full rounded-2xl border p-4 shadow-2xl my-4 ${isDarkMode ? 'bg-pink-950/50 border-pink-600 text-white' : 'bg-pink-50 border-pink-300'}`}>
            <h3 className="text-sm font-black uppercase tracking-wider text-teal-500 border-b pb-2 mb-3 flex items-center justify-between">
              <span>🧾 {t("Confirm Invoice", "বিল নিশ্চিত করুন")}</span>
              <button onClick={() => setShowConfirmModal(false)} className="text-slate-400 hover:text-red-500 font-bold text-sm">✕</button>
            </h3>

            <div className="flex flex-col gap-3 text-sm">
              <div className="grid grid-cols-2 gap-2 bg-slate-500/5 p-2.5 rounded-xl text-sm font-semibold">
                <div><span className="text-slate-400 block">{t("Customer:", "গ্রাহক:")}</span><strong className="text-teal-500">{customerName || t("Walk-in Customer", "সাধারণ গ্রাহক")}</strong></div>
                <div><span className="text-slate-400 block">{t("Items:", "আইটেম:")}</span><strong>{cart.reduce((s, i) => s + (parseInt(i.qty) || 0), 0)} {t("pcs", "টি")}</strong></div>
              </div>

              {selectedExistingDue && (
                <div className={`px-3 py-2 rounded-xl border text-sm ${isDarkMode ? 'bg-red-950/40 border-red-700' : 'bg-red-50 border-red-300'}`}>
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

              <div className={`ccard cc-indigo p-3 rounded-xl border ${isDarkMode ? 'bg-indigo-950/50 border-indigo-600' : 'bg-indigo-50 border-indigo-300'}`}>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-bold text-slate-400">{t("Total Payable:", "মোট পরিশোধযোগ্য:")}</span>
                  <span className="font-mono text-base font-black text-teal-500">{currentFinalBill.toFixed(1)} {currencySymbol}</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Cash Given", "নগদ দিয়েছে")}</label>
                    <input
                      type="number"
                      placeholder={t("Amount...", "পরিমাণ...")}
                      value={calculatorInput}
                      onChange={e => { setCalculatorInput(e.target.value); setCashReceived(e.target.value); }}
                      className={`w-full px-2.5 py-1.5 font-mono font-bold rounded border outline-none text-sm ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-300'}`}
                    />
                  </div>
                  <div>
                    <label className={`block text-sm font-bold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t("Change Back", "ফেরত দেওয়া")}</label>
                    <div className={`w-full px-2.5 py-1.5 font-mono font-black text-sm rounded border ${liveRefundAmount >= 0 ? 'text-emerald-400 bg-emerald-500/5 border-emerald-500/10' : 'text-red-400 bg-red-500/5 border-red-500/10'}`}>
                      {liveRefundAmount >= 0 ? `${liveRefundAmount.toFixed(1)} ${currencySymbol}` : t("Short!", "কম আছে!")}
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
                  <input type="number" value={invoiceDue} onChange={e => setInvoiceDue(e.target.value)} className={`w-full p-1.5 font-mono rounded border outline-none text-sm ${isDarkMode ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}`} />
                </div>
              </div>

              <div className="flex gap-2 justify-end pt-2 border-t mt-1">
                <button onClick={() => setShowConfirmModal(false)} className={`px-4 py-2 text-sm font-bold rounded-xl transition ${isDarkMode ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{t("Cancel", "বাতিল")}</button>
                <button
                  onClick={executeFinalCheckout}
                  disabled={liveRefundAmount < 0 && parseFloat(invoiceDue) === 0}
                  className="bg-gradient-to-r from-teal-500 to-emerald-500 disabled:opacity-40 text-white font-black px-5 py-2 rounded-xl uppercase tracking-wider shadow hover:from-teal-600 hover:to-emerald-600 transition"
                >
                  ✅ {t("Confirm & Print", "নিশ্চিত ও প্রিন্ট")}
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
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className={`max-w-xl w-full rounded-2xl border p-4 shadow-2xl my-4 ${isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200'}`}>
            <h3 className="text-sm font-black uppercase tracking-wider text-red-400 border-b pb-2 mb-3 flex items-center justify-between">
              <span>🔄 {t("Process Return", "ফেরত প্রক্রিয়া করুন")}</span>
              <button onClick={() => { setShowReturnModal(false); setSelectedInvoiceForReturn(null); }} className="text-slate-400 hover:text-white font-bold text-sm">✕</button>
            </h3>

            <div className="flex flex-col gap-3 text-sm">
              <div className="p-2.5 rounded-xl bg-slate-500/5 text-sm font-semibold flex justify-between items-center">
                <div>{t("Invoice:", "রশিদ:")} <strong className="text-teal-500 font-mono">{selectedInvoiceForReturn.invoiceId}</strong></div>
                <div>{t("Customer:", "গ্রাহক:")} <strong>{selectedInvoiceForReturn.customer}</strong></div>
                <div>{t("Bill:", "বিল:")} <strong className="font-mono text-teal-400">{selectedInvoiceForReturn.finalBill.toFixed(1)} {currencySymbol}</strong></div>
              </div>

              <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto">
                <span className="text-sm font-black uppercase text-slate-400">{t("Select return quantities:", "ফেরত পরিমাণ বেছে নিন:")}</span>
                {selectedInvoiceForReturn.items.map((item: any) => (
                  <div key={item.id} className={`p-2 rounded-lg border flex items-center justify-between gap-2 ${isDarkMode ? 'bg-slate-950/40 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
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
                <button onClick={processInvoiceMedicineReturn} className="bg-red-500 hover:bg-red-600 text-white font-black px-5 py-2 rounded-xl uppercase tracking-wider shadow transition">
                  {t("Process Return", "ফেরত প্রক্রিয়া করুন")}
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
        <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-md z-50 flex items-center justify-center p-4 overflow-y-auto print:absolute print:inset-0 print:bg-white print:p-0">
          <div className="max-w-sm w-full bg-white text-slate-950 p-5 rounded-xl shadow-2xl font-mono text-sm border border-slate-200 print:shadow-none print:border-none print:w-full print:p-0">

            <div className="flex justify-between items-center border-b pb-2 mb-4 print:hidden">
              <button onClick={triggerPrintReceipt} className="bg-teal-500 hover:bg-teal-600 text-white font-bold py-1 px-3 rounded uppercase tracking-wider text-sm transition shadow">🖨️ {t("Print", "প্রিন্ট")}</button>
              <button onClick={() => setShowReceipt(false)} className="text-red-500 hover:underline font-bold text-sm uppercase">✕ {t("Close", "বন্ধ")}</button>
            </div>

            <div className="text-center mb-4">
              <h3 className="font-black text-sm uppercase tracking-tight">{pharmacyName}</h3>
              <p className="text-sm opacity-80 leading-snug">{pharmacySlogan}</p>
              <p className="text-sm font-bold mt-0.5">{pharmacyAddress}</p>
              <div className="border-b border-dashed border-slate-400 my-2"></div>
              <h4 className="font-black text-sm tracking-wider uppercase">{t("SALES RECEIPT", "বিক্রয় রশিদ")}</h4>
            </div>

            <div className="flex flex-col gap-0.5 text-sm mb-3">
              <div className="flex justify-between"><span>{t("Invoice ID:", "রশিদ নং:")}</span><span className="font-bold text-teal-600">{lastInvoice.invoiceId}</span></div>
              <div className="flex justify-between"><span>{t("Customer:", "গ্রাহক:")}</span><span className="font-bold">{lastInvoice.customer}</span></div>
              <div className="flex justify-between"><span>{t("Phone:", "ফোন:")}</span><span>{lastInvoice.phone}</span></div>
              <div className="flex justify-between"><span>{t("Date:", "তারিখ:")}</span><span>{lastInvoice.dateString}</span></div>
              <div className="flex justify-between"><span>{t("Payment:", "পেমেন্ট:")}</span><span className="font-bold">{lastInvoice.paymentMethod}</span></div>
            </div>

            <div className="border-b border-dashed border-slate-400 my-2"></div>

            <table className="w-full text-left text-sm border-collapse mb-3">
              <thead>
                <tr className="font-black border-b border-slate-300">
                  <th className="py-1">{t("Item", "আইটেম")}</th>
                  <th className="py-1 font-mono text-center">{t("Qty", "পরিমাণ")}</th>
                  <th className="py-1 font-mono text-right">{t("Total", "মোট")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {lastInvoice.items.map((item: any) => (
                  <tr key={item.id}>
                    <td className="py-1">
                      <span className="block font-bold">{item.name}</span>
                      <span className="text-sm opacity-70 italic">{t("Rate:", "মূল্য:")} {item.price}</span>
                    </td>
                    <td className="py-1 font-mono text-center">{item.qty}</td>
                    <td className="py-1 font-mono text-right">{((parseInt(item.qty) || 0) * item.price).toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="border-b border-dashed border-slate-400 my-2"></div>

            <div className="flex flex-col gap-1 text-sm text-right font-semibold">
              <div className="flex justify-between"><span className="text-slate-500">{t("Subtotal:", "মোট:")}</span><span className="font-mono">{lastInvoice.subTotal.toFixed(1)} {currencySymbol}</span></div>
              {lastInvoice.vat > 0 && <div className="flex justify-between"><span className="text-slate-500">{t("VAT:", "ভ্যাট:")}</span><span className="font-mono">+{lastInvoice.vat.toFixed(1)}</span></div>}
              {lastInvoice.discount > 0 && <div className="flex justify-between text-red-600"><span>{t("Discount:", "ছাড়:")}</span><span className="font-mono">-{lastInvoice.discount.toFixed(1)}</span></div>}
              <div className="flex justify-between border-t border-dashed border-slate-400 pt-1 font-black text-sm text-slate-950">
                <span>{t("NET PAYABLE:", "মোট পরিশোধ:")}</span>
                <span className="font-mono text-teal-600 font-black">{lastInvoice.finalBill.toFixed(1)} {currencySymbol}</span>
              </div>
              <div className="border-b border-slate-200 my-1"></div>
              <div className="flex justify-between text-sm font-semibold text-slate-600">
                <span>{t("Cash Received:", "নগদ পেয়েছি:")}</span>
                <span className="font-mono">{(lastInvoice.cashReceived || lastInvoice.finalBill).toFixed(1)} {currencySymbol}</span>
              </div>
              <div className="flex justify-between text-sm font-semibold text-slate-600">
                <span>{t("Change Given:", "ফেরত দিয়েছি:")}</span>
                <span className="font-mono">{Math.max(0, (lastInvoice.cashReceived || lastInvoice.finalBill) - lastInvoice.finalBill).toFixed(1)} {currencySymbol}</span>
              </div>
              {lastInvoice.due > 0 && (
                <div className="flex justify-between text-sm font-black text-red-600">
                  <span>{t("UNPAID DUE:", "বাকি:")}</span>
                  <span className="font-mono">{lastInvoice.due.toFixed(1)} {currencySymbol}</span>
                </div>
              )}
            </div>

            <div className="border-b border-dashed border-slate-400 my-3"></div>
            <div className="text-center text-sm font-bold uppercase tracking-tight">
              <p>{lastInvoice.footerMsg || receiptFooterMsg}</p>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          MODAL 4: DUE PAYMENT COLLECTION
      ========================================================= */}
      {duePaymentModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`ccard cc-rose max-w-sm w-full rounded-2xl border p-4 shadow-2xl ${isDarkMode ? 'bg-rose-950/50 border-rose-600 text-white' : 'bg-rose-50 border-rose-300'}`}>
            <h3 className="text-sm font-black uppercase tracking-wider text-teal-500 border-b pb-2 mb-3 flex items-center justify-between">
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
                <button onClick={handleDuePayment} className="bg-teal-500 hover:bg-teal-600 text-white font-black px-5 py-2 rounded-xl uppercase tracking-wider shadow transition">
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