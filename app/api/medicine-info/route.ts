import { NextRequest, NextResponse } from "next/server";

// ============================================================
// MEDICINE INFO API ROUTE — Google Gemini (FREE) ভার্সন
// ─────────────────────────────────────────────────────────────
// Google Gemini API ফ্রি — কার্ড/টাকা লাগে না, প্রতিদিন অনেক
// ফ্রি রিকোয়েস্ট পাওয়া যায়।
//
// SETUP (একবার করতে হবে):
// 1. যান https://aistudio.google.com/apikey এ
// 2. Google অ্যাকাউন্ট দিয়ে লগইন করুন
// 3. "Create API Key" চাপুন, key কপি করুন (AQ... বা AIza... দিয়ে শুরু)
// 4. প্রজেক্টের রুটে .env.local ফাইলে এই লাইন যুক্ত করুন:
//      GEMINI_API_KEY=আপনার-আসল-কী
// 5. ফাইল বদলানোর পর dev server পুনরায় চালু করুন (Ctrl+C তারপর npm run dev)
//    — Next.js শুধু স্টার্ট হওয়ার সময় .env.local পড়ে।
// 6. Vercel/server-এ deploy করলে Environment Variables-এ
//    GEMINI_API_KEY যুক্ত করুন।
// ============================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-2.0-flash"; // ফ্রি টিয়ারে দ্রুত ও ভালো মডেল

function buildPrompt(name: string, lang: string) {
  return `তুমি একজন অভিজ্ঞ বাংলাদেশী ডাক্তার এবং ফার্মাসিস্ট। তোমাকে যে ওষুধের নাম দেওয়া হবে (নামটি ভুল বানান, ছোট হাতের লেখা, অথবা শুধু একটা অংশ হতে পারে), সবচেয়ে কাছাকাছি মিলে যাওয়া আসল ওষুধটি চিনে নিয়ে সেই ওষুধ সম্পর্কে একজন ডাক্তার যেভাবে রোগীকে বলেন, ঠিক সেভাবে বিস্তারিত তথ্য দাও।

ওষুধের নাম: ${name}

যদি নামটি কোনো পরিচিত ওষুধের সাথে স্পষ্টভাবে না মেলে এবং তুমি নিশ্চিত না হও, তাহলেও সবচেয়ে কাছাকাছি সম্ভাব্য ওষুধ ধরে নিয়ে উত্তর দাও এবং "name" ফিল্ডে সঠিক/পূর্ণ নামটি লিখো। কখনো খালি/ব্যর্থ উত্তর দিও না — সবসময় একটা সম্পূর্ণ JSON object রিটার্ন করবে।

STRICT RULE: শুধুমাত্র একটি valid JSON object return করবে। কোনো markdown, backtick, ব্যাখ্যা, বা extra text দেবে না। উত্তরের শুরুতে { এবং শেষে } থাকতে হবে।

JSON structure হবে এরকম:
{
  "name": "ওষুধের পূর্ণ ও সঠিক নাম",
  "generic": "জেনেরিক/রাসায়নিক নাম",
  "category": "ধরন (Tablet/Syrup/Capsule/Injection ইত্যাদি)",
  "manufacturer": "কোম্পানির নাম",
  "therapeuticClass": "ওষুধের শ্রেণী (যেমন: Antibiotic, Antacid, Analgesic)",
  "mechanism": "এই ওষুধ শরীরে কীভাবে কাজ করে — সহজ বাংলায় ২-৩ বাক্যে",
  "uses": ["কাজ ১", "কাজ ২", "কাজ ৩", "কাজ ৪"],
  "dosage": {
    "adult": "প্রাপ্তবয়স্কদের মাত্রা — কতটা, কতবার, কতদিন",
    "child": "শিশুদের মাত্রা — বয়স ও ওজন অনুযায়ী",
    "elderly": "বয়স্কদের ক্ষেত্রে বিশেষ নির্দেশনা",
    "severe": "গুরুতর রোগের ক্ষেত্রে ডোজ"
  },
  "timing": "কখন খাবেন — খাবার আগে না পরে, সকাল না রাত, কীভাবে খাবেন",
  "duration": "সাধারণত কতদিন খেতে হয় এবং কেন",
  "howToTake": "কীভাবে খাবেন — পানি দিয়ে, চিবিয়ে নয়, ইত্যাদি বিস্তারিত",
  "sideEffects": {
    "common": ["সাধারণ পার্শ্বপ্রতিক্রিয়া ১", "২", "৩"],
    "serious": ["গুরুতর পার্শ্বপ্রতিক্রিয়া ১", "২"],
    "rare": ["বিরল পার্শ্বপ্রতিক্রিয়া ১"]
  },
  "warnings": ["সতর্কতা ১", "সতর্কতা ২", "সতর্কতা ৩"],
  "contraindications": ["যাদের দেওয়া যাবে না ১", "২"],
  "drugInteractions": ["কোন ওষুধের সাথে দেওয়া যাবে না বা সাবধান ১", "২"],
  "ageLimit": "কত বছর বয়স থেকে দেওয়া যাবে",
  "storage": "কোথায় কীভাবে রাখতে হবে",
  "pregnancy": "গর্ভাবস্থায় নিরাপদ/অনিরাপদ — Category A/B/C/D/X এবং কারণ",
  "breastfeeding": "বুকের দুধ খাওয়ানো মায়েদের ক্ষেত্রে",
  "overdose": "বেশি খেয়ে ফেললে কী হবে এবং কী করতে হবে",
  "missedDose": "ডোজ মিস হলে কী করতে হবে",
  "doctorAdvice": "ডাক্তার হিসেবে বিশেষ পরামর্শ — ৩-৪ বাক্যে",
  "price": "বাংলাদেশে আনুমানিক মূল্য প্রতি স্ট্রিপ/বোতল"
}

${lang === "bn" ? "সব তথ্য বাংলায় লিখবে।" : "Write all information in English."}`;
}

// মডেলের উত্তরে JSON-এর আগে/পরে অতিরিক্ত টেক্সট থাকলেও যেন বের করে আনা যায়
function extractJson(text: string): string | null {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return cleaned.slice(start, end + 1);
}

// Gemini error body থেকে আসল কারণ বের করে একটা মানুষ-বোঝা message বানায়
function explainGeminiError(status: number, errText: string): { code: string; message: string } {
  let parsed: any = null;
  try {
    parsed = JSON.parse(errText);
  } catch {
    // not JSON, ignore
  }
  const googleStatus = parsed?.error?.status || "";
  const googleMessage = parsed?.error?.message || errText;

  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(googleMessage)) {
    return {
      code: "INVALID_KEY",
      message:
        "GEMINI_API_KEY টা ভুল/পুরোনো। .env.local ফাইলে সঠিক key বসান (Google AI Studio → Get API key থেকে কপি করুন), তারপর dev server রিস্টার্ট করুন।",
    };
  }

  if (status === 403) {
    return {
      code: "FORBIDDEN",
      message:
        "এই API key দিয়ে অনুমতি নেই (key disabled/restricted হতে পারে)। AI Studio-এ গিয়ে key টা চেক করুন বা নতুন key বানান।",
    };
  }

  if (status === 429) {
    // limit: 0 মানে key/project এ quota বরাদ্দ নেই (key ভুল বা ভুল project থেকে নেওয়া),
    // সাধারণ rate-limit এ limit সংখ্যা শূন্য হয় না।
    const isZeroQuota = /limit:\s*0/i.test(googleMessage);
    return {
      code: isZeroQuota ? "ZERO_QUOTA" : "RATE_LIMITED",
      message: isZeroQuota
        ? "এই key/প্রজেক্টে Gemini-র কোনো quota বরাদ্দ নেই। সাধারণত key ভুল বা ভুল প্রজেক্ট থেকে কপি করা হলে এমন হয় — .env.local এ ঠিক key বসিয়ে server রিস্টার্ট করুন।"
        : "একসাথে অনেক রিকোয়েস্ট চলে যাওয়ায় সাময়িকভাবে rate limit এ পড়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।",
    };
  }

  return { code: "UPSTREAM_ERROR", message: googleStatus ? `${googleStatus}: ${googleMessage}` : googleMessage };
}

export async function POST(req: NextRequest) {
  try {
    const { name, lang } = await req.json();
    const trimmed = (name || "").trim();

    if (!trimmed) {
      return NextResponse.json({ error: "EMPTY_NAME" }, { status: 400 });
    }

    if (!GEMINI_API_KEY) {
      return NextResponse.json(
        { error: "MISSING_API_KEY", message: "Server-এ GEMINI_API_KEY সেট করা নেই।" },
        { status: 500 }
      );
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: buildPrompt(trimmed, lang === "en" ? "en" : "bn") }],
          },
        ],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 1800,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      const { code, message } = explainGeminiError(response.status, errText);
      console.error("Gemini API error:", response.status, code, errText);
      return NextResponse.json(
        { error: code, message },
        { status: 502 }
      );
    }

    const data = await response.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";

    const jsonStr = extractJson(text);
    if (!jsonStr) {
      console.error("Could not extract JSON from model output:", text);
      return NextResponse.json({ error: "PARSE_ERROR", message: "মডেলের উত্তর থেকে তথ্য বোঝা যায়নি। আবার চেষ্টা করুন।" }, { status: 502 });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error("JSON parse failed:", e, jsonStr);
      return NextResponse.json({ error: "PARSE_ERROR", message: "মডেলের উত্তর থেকে তথ্য বোঝা যায়নি। আবার চেষ্টা করুন।" }, { status: 502 });
    }

    return NextResponse.json({ result: parsed });
  } catch (err: any) {
    console.error("medicine-info route error:", err);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: err?.message || "unknown" },
      { status: 500 }
    );
  }
}