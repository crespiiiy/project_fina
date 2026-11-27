/**
 * Vercel Serverless Function: /api/launch.js
 *
 * Handles launch-offer discount code submissions for Presenta.
 * Backend: Supabase (PostgreSQL via REST API).
 *
 * Environment variables (set in Vercel Project Settings, never in frontend):
 *   SUPABASE_URL           - https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY - service role key (server-side only)
 *   TELEGRAM_BOT_TOKEN     - Telegram bot token (added by you in Vercel)
 *   TELEGRAM_CHAT_ID       - Telegram chat ID (added by you in Vercel)
 *   LAUNCH_PCT             - override discount percent (default 35)
 *   LAUNCH_LIMIT           - override max uses per code (default 3)
 *
 * Database tables (create via Supabase SQL editor):
 *   launch_counters (market text, tier text, used_count int default 0, primary key (market, tier))
 *   launch_submissions (id uuid default gen_random_uuid() primary key,
 *                        name text, phone text, code text, tier text, market text,
 *                        lang text, valid boolean, remaining_after int,
 *                        received_at timestamptz default now(), client_time text)
 */

const LAUNCH_PCT = parseInt(process.env.LAUNCH_PCT || '35', 10);
const LAUNCH_LIMIT = parseInt(process.env.LAUNCH_LIMIT || '3', 10);
const LAUNCH_CODES = { start: 'START3', clear: 'CLEAR3', plus: 'PLUS3' };
const REGULAR_NUM = { eg: [1200, 2500, 4200], qa: [450, 900, 1500], ae: [399, 799, 1299], int: [119, 229, 379] };
const CURRENCY = { eg: { ar: 'ج.م', en: 'EGP' }, qa: { ar: 'ر.ق', en: 'QAR' }, ae: { ar: 'د.إ', en: 'AED' }, int: { ar: 'USD', en: 'USD' } };
const TIER_ORDER = ['start', 'clear', 'plus'];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function supabaseHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function discountedPrice(regNum) {
  return Math.round(regNum * (1 - LAUNCH_PCT / 100));
}

function discountPct(regNum) {
  return Math.round((1 - discountedPrice(regNum) / regNum) * 100);
}

async function supabaseFetch(path, opts = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Supabase not configured');
  const url = SUPABASE_URL.endsWith('/') ? SUPABASE_URL + path.slice(1) : SUPABASE_URL + path;
  const res = await fetch(url, {
    headers: supabaseHeaders(),
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  return res;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    // Telegram failure must not break the response
  }
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { name, phone, code, tier, market, lang = 'ar', time } = req.body || {};

    if (!name || !phone || !code || !tier || !market) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const codeOk = code === LAUNCH_CODES[tier];
    const tierIdx = TIER_ORDER.indexOf(tier);
    const regNum = REGULAR_NUM[market]?.[tierIdx];
    const discNum = regNum ? discountedPrice(regNum) : null;
    const pct = regNum ? discountPct(regNum) : LAUNCH_PCT;
    const cur = CURRENCY[market]?.[lang] || '';

    if (!codeOk) {
      // Record invalid-code submission
      if (SUPABASE_URL && SERVICE_KEY) {
        await supabaseFetch('/rest/v1/launch_submissions', {
          method: 'POST',
          body: JSON.stringify({ name, phone, code, tier, market, lang, valid: false, remaining_after: 0, client_time: time }),
        });
      }
      await sendTelegram(
        `<b>🚫 Presenta Launch — Invalid Code</b>\n` +
        `<b>Name:</b> ${name}\n<b>WhatsApp:</b> ${phone}\n<b>Code:</b> ${code}\n` +
        `<b>Package:</b> ${tier}\n<b>Country:</b> ${market}\n<b>Lang:</b> ${lang}\n` +
        `<b>Time:</b> ${time || new Date().toISOString()}`
      );
      const msg = lang === 'ar'
        ? 'عذرًا، كود الخصم غير صحيح أو غير صالح لهذه الباقة.'
        : 'Sorry, the discount code is invalid or not applicable to this package.';
      return res.status(200).json({ valid: false, message: msg });
    }

    // Atomic counter: ensure row exists, then increment only if under limit.
    // Retry loop for optimistic concurrency (rare race on concurrent submits).
    let valid = false;
    let remaining = 0;
    let usedAfter = 0;

    for (let attempt = 0; attempt < 5; attempt++) {
      // Ensure counter row exists
      await supabaseFetch('/rest/v1/launch_counters', {
        method: 'POST',
        body: JSON.stringify({ market, tier, used_count: 0 }),
        headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      });

      // Read current value
      const curRes = await supabaseFetch(
        `/rest/v1/launch_counters?select=used_count&market=eq.${encodeURIComponent(market)}&tier=eq.${encodeURIComponent(tier)}`
      );
      const rows = await curRes.json();
      const used = rows.length ? parseInt(rows[0].used_count, 10) : 0;

      if (used >= LAUNCH_LIMIT) {
        remaining = 0;
        usedAfter = used;
        break; // limit reached
      }

      // Try atomic increment with optimistic lock
      const patchRes = await supabaseFetch(
        `/rest/v1/launch_counters?market=eq.${encodeURIComponent(market)}&tier=eq.${encodeURIComponent(tier)}&used_count=eq.${used}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ used_count: used + 1 }),
          headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
        }
      );
      const updated = await patchRes.json();
      if (updated && updated.length) {
        usedAfter = parseInt(updated[0].used_count, 10);
        remaining = Math.max(0, LAUNCH_LIMIT - usedAfter);
        valid = true;
        break;
      }
      // Row was changed by another request; retry
    }

    // Record submission
    if (SUPABASE_URL && SERVICE_KEY) {
      await supabaseFetch('/rest/v1/launch_submissions', {
        method: 'POST',
        body: JSON.stringify({ name, phone, code, tier, market, lang, valid, remaining_after: remaining, client_time: time }),
      });
    }

    let message;
    if (!valid) {
      message = lang === 'ar'
        ? 'عرض الإطلاق على الباقة دي خلص، لكن هنتواصل معاك بالسعر العادي.'
        : 'The launch offer for this package is sold out, but we\'ll contact you at the regular price.';
    } else {
      message = lang === 'ar'
        ? `مبروك، حصلت على خصم الإطلاق ${pct}%، والسعر بعد الخصم ${discNum} ${cur}، وهنتواصل معاك قريب.`
        : `Congratulations! You got the launch offer: ${pct}% off. Price after discount: ${discNum} ${cur}. We'll contact you soon.`;
    }

    // Telegram notification (server-side only)
    await sendTelegram(
      `<b>🚀 Presenta Launch Offer</b>\n` +
      `<b>Name:</b> ${name}\n<b>WhatsApp:</b> ${phone}\n<b>Code:</b> ${code}\n` +
      `<b>Package:</b> ${tier}\n<b>Country:</b> ${market}\n<b>Lang:</b> ${lang}\n` +
      `<b>Valid:</b> ${valid ? 'Yes' : 'No'}\n<b>Remaining:</b> ${remaining}\n` +
      `<b>Time:</b> ${time || new Date().toISOString()}`
    );

    return res.status(200).json({
      valid,
      message,
      remaining: valid ? remaining : remaining,
      discount_pct: pct,
      discounted_price: discNum,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
