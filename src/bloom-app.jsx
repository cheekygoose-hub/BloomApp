// ─────────────────────────────────────────────────────────────────────────────
// bloom-app.jsx  — UI + Logic
// TOKEN COST: ~15,000 tokens
// SHARE WHEN: UI bugs, scoring engine, screen layouts, new screens,
//   filter/preset logic, journey, timer, feedback, onboarding.
// DO NOT share when: adding activities, editing principles/archetypes.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from "react";
import { PRINCIPLES, principles } from './bloom-principles.js';
import { ARCHETYPES, archetypes, CLASSIFIER_SYSTEM_PROMPT, classifyNicknameLocally } from './bloom-archetypes.js';
import { activities } from './bloom-activities.js';
import { debug, DebugOverlay } from './bloom-debug.jsx';

// ─── Display constants ────────────────────────────────────────────────────────

const DOMAIN_COLOURS = {
  motor: '#C8A97E', sensory: '#8BAF8E', language: '#89A8C4',
  cognitive: '#A892B8', social_emotional: '#C48B8B',
};
const DOMAIN_ICONS = {
  motor: '◎', sensory: '◈', language: '◐', cognitive: '◑', social_emotional: '◍',
};

const FILTER_GROUPS = [
  { key: 'setting',   label: 'Setting',   options: ['Home','Out','Car','Bath','Mealtime','Nappy change'] },
  { key: 'energy',    label: 'Energy',    options: ['Calm & alert','Wide awake','Fussy','Sleepy'] },
  { key: 'duration',  label: 'Duration',  options: ['Under 5 min','5–15 min','15+ min'] },
  { key: 'materials', label: 'Materials', options: ['Just us','Whatever\'s around','Toys available'] },
];

const SETTING_MAP   = { 'Home':'home','Out':'out','Car':'car','Bath':'bath','Mealtime':'mealtime','Nappy change':'nappy_change' };
const ENERGY_MAP    = { 'Calm & alert':'calm_alert','Wide awake':'wide_awake','Fussy':'fussy','Sleepy':'sleepy' };
const DURATION_FNS  = { 'Under 5 min': a => a.duration_minutes < 5, '5–15 min': a => a.duration_minutes >= 5 && a.duration_minutes <= 15, '15+ min': a => a.duration_minutes > 15 };

const MOMENT_PRESETS = [
  { id: 'just_us',       label: 'Just us',            emoji: '🤲', description: 'No props needed',       filters: { materials: ['Just us'] } },
  { id: 'in_the_car',    label: 'In the car',          emoji: '🚗', description: 'Hands-free, no objects', filters: { setting: ['Car'], materials: ['Just us'] } },
  { id: 'wake_up_3am',   label: '3am wake-up',         emoji: '🌙', description: 'Gentle and quick',      filters: { energy: ['Sleepy'], duration: ['Under 5 min'], materials: ['Just us'] } },
  { id: 'changing_mat',  label: 'On the changing mat', emoji: '🛁', description: 'Quick, lying down',     filters: { setting: ['Nappy change'], duration: ['Under 5 min'] } },
  { id: 'witching_hour', label: 'Witching hour',       emoji: '😤', description: 'Fussy, hands-on',       filters: { energy: ['Fussy'], materials: ['Just us'] } },
  { id: 'stuck_inside',  label: 'Stuck inside',        emoji: '🏠', description: 'Home, no time pressure', filters: { setting: ['Home'] } },
];

// ─── Scoring tuning constants ─────────────────────────────────────────────────
// Adjust these to tune recommendation behaviour without touching logic.

const SCORE_LOVED_BOOST    =  0.8;  // score bonus for a "loved" rating
const SCORE_NOT_TODAY_NUDGE= -0.6;  // score penalty for "not today"
const DECAY_HALF_LIFE_DAYS =  7;    // rating influence halves every N days
const COOLDOWN_HOURS       =  4;    // activities done within this window rank lower
const COOLDOWN_PENALTY     =  1.2;  // score subtracted during cooldown
const EXPLORE_FRACTION     =  0.25; // ~1 in 4 picks surfaces an unseen/fresh activity
const CARD_COUNT           =  5;    // number of cards shown on Today

// ─── Pure utilities ───────────────────────────────────────────────────────────

/**
 * Replace the {name} token in voice text.
 * - Uses the baby's name when set.
 * - Otherwise falls back to the archetype's honorific (e.g. "His or Her Lordship",
 *   "The Director"), capitalising it when it lands at the start of a sentence.
 * Returns the input unchanged if there's no token (e.g. plain voice).
 */
function fillName(text, babyName, archetypeId) {
  if (typeof text !== 'string' || !text.includes('{name}')) return text;
  const name = (babyName || '').trim();
  if (name) return text.replaceAll('{name}', name);
  const fallback = getArchetype(archetypeId)?.honorific_templates?.without_name || 'your baby';
  // Capitalise the honorific where {name} opens a sentence (start of string or after . ! ? —)
  const cap = fallback.charAt(0).toUpperCase() + fallback.slice(1);
  return text.replace(/(^|[.!?—]\s+)\{name\}/g, (_, lead) => lead + cap)
             .replaceAll('{name}', fallback);
}

function fillVoiceNames(voice, babyName, archetypeId) {
  if (!voice || voice.is_plain) return voice; // plain text carries no {name}
  return {
    ...voice,
    title: fillName(voice.title, babyName, archetypeId),
    one_line_description: fillName(voice.one_line_description, babyName, archetypeId),
    cta: fillName(voice.cta, babyName, archetypeId),
    card_cta: fillName(voice.card_cta, babyName, archetypeId),
    full_instructions: Array.isArray(voice.full_instructions)
      ? voice.full_instructions.map(s => fillName(s, babyName, archetypeId))
      : voice.full_instructions,
  };
}

function resolveVoice(activity, archetypeId, babyName) {
  if (!archetypeId || archetypeId === ARCHETYPES.PLAIN || !activity.persona_eligible)
    return { ...activity.plain, is_plain: true };
  const v = activity.persona_variants?.[archetypeId];
  if (!v) return { ...activity.plain, is_plain: true };
  return fillVoiceNames({ ...v, is_plain: false }, babyName, archetypeId);
}

function resolveKey(key, activity, archetypeId, babyName) {
  if (!archetypeId || archetypeId === ARCHETYPES.PLAIN || !activity.persona_eligible)
    return activity.plain[key] ?? null;
  const raw = activity.persona_variants?.[archetypeId]?.[key] ?? activity.plain[key] ?? null;
  return fillName(raw, babyName, archetypeId);
}

function getArchetype(id) { return archetypes.find(a => a.id === id) || archetypes[0]; }

// Which voices actually have authored content in the library.
// Data-driven so a voice "graduates" automatically once its first variant lands —
// no UI change needed. PLAIN is always ready.
const AUTHORED_VOICES = (() => {
  const set = new Set([ARCHETYPES.PLAIN]);
  for (const a of activities) {
    if (!a.persona_variants) continue;
    for (const k of Object.keys(a.persona_variants)) set.add(k);
  }
  return set;
})();
function isVoiceReady(id) { return AUTHORED_VOICES.has(id); }

// ─── Name resolution ──────────────────────────────────────────────────────────

/**
 * The baby's real name for plain factual copy (titles, headers).
 * Never the nickname or honorific — "Arthur's Journey", not "King Arthur's Journey".
 * Ignores the nickname toggle entirely.
 */
function babyLabel(profile) {
  return (profile?.babyName || '').trim();
}

/**
 * Possessive form of the baby's name for titles ("Arthur" → "Arthur's").
 * Falls back to the given fallback string when no name is set.
 */
function babyPossessive(profile, fallback = 'Our') {
  const n = babyLabel(profile);
  if (!n) return fallback;
  return n.endsWith('s') ? `${n}'` : `${n}'s`;
}

/**
 * The name to weave into persona/activity text, toggle-gated.
 * Prefers petName (nickname), falls back to babyName, returns '' → honorific when off.
 * This is the ONLY value fed into {name} substitution in activity copy.
 */
function effectiveName(profile, nicknameOn) {
  if (!nicknameOn) return '';
  return (profile?.petName || '').trim() || (profile?.babyName || '').trim() || '';
}

// ─── Rewrite cache ────────────────────────────────────────────────────────────

const REWRITE_CACHE_V = 1; // bump when activity strings change to discard stale rewrites

/** Stable short hash of a string — djb2. Used for cache keys. */
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function rewriteCacheKey(activityId, voiceId, nickname) {
  return `bloom_rewrite:${voiceId}:${hashStr(nickname.toLowerCase().trim())}:${activityId}`;
}

function getRewrite(activityId, voiceId, nickname) {
  if (!nickname) return null;
  try {
    const raw = localStorage.getItem(rewriteCacheKey(activityId, voiceId, nickname));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj?.v !== REWRITE_CACHE_V) return null; // stale schema
    return obj;
  } catch { return null; }
}

function saveRewrite(activityId, voiceId, nickname, payload) {
  try {
    const key = rewriteCacheKey(activityId, voiceId, nickname);
    localStorage.setItem(key, JSON.stringify({
      ...payload, v: REWRITE_CACHE_V,
      src_voice: voiceId, ts: Date.now(),
    }));
  } catch {}
}

/** On app load: drop rewrite entries for a different nickname or old schema version. */
function sweepRewriteCache(currentNickname) {
  try {
    const currentHash = currentNickname ? hashStr(currentNickname.toLowerCase().trim()) : null;
    const keys = Object.keys(localStorage).filter(k => k.startsWith('bloom_rewrite:'));
    for (const k of keys) {
      // key format: bloom_rewrite:<voice>:<nicknameHash>:<activityId>
      const parts = k.split(':');
      const keyHash = parts[2];
      try {
        const obj = JSON.parse(localStorage.getItem(k));
        if (obj?.v !== REWRITE_CACHE_V || keyHash !== currentHash) localStorage.removeItem(k);
      } catch { localStorage.removeItem(k); }
    }
  } catch {}
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function formatCitations(citations) {
  if (!citations?.length) return '';
  return citations.map(c => typeof c === 'string' ? c : `${c.organisation} — ${c.citation_title}`).join(' · ');
}

/** Age in weeks from ISO date string. Returns null if dob missing/invalid. */
function ageWeeks(dob) {
  if (!dob) return null;
  const ms = Date.now() - new Date(dob).getTime();
  if (isNaN(ms) || ms < 0) return null;
  return Math.floor(ms / (7 * 24 * 3600 * 1000));
}

/**
 * Decay multiplier: 1.0 at t=0, 0.5 at DECAY_HALF_LIFE_DAYS, fades to ~0.
 * Used to weight rating influence by recency.
 */
function decayWeight(isoDate) {
  const days = (Date.now() - new Date(isoDate).getTime()) / 86400000;
  return Math.pow(0.5, days / DECAY_HALF_LIFE_DAYS);
}

/**
 * Compute a rating nudge for one activity from the full journey.
 * Sums decayed loved/not_today signals; "okay" is neutral (0).
 */
function ratingNudge(activityId, journey) {
  let nudge = 0;
  for (const j of journey) {
    if (j.activity_id !== activityId || j.status !== 'completed') continue;
    const w = decayWeight(j.completed_at);
    if (j.rating === 'loved')     nudge += SCORE_LOVED_BOOST * w;
    if (j.rating === 'not_today') nudge += SCORE_NOT_TODAY_NUDGE * w;
  }
  return nudge;
}

/**
 * Cooldown penalty: subtract COOLDOWN_PENALTY if activity was done very recently.
 */
function cooldownPenalty(activityId, journey) {
  const cutoff = Date.now() - COOLDOWN_HOURS * 3600000;
  const recent = journey.some(j =>
    j.activity_id === activityId &&
    j.status === 'completed' &&
    new Date(j.completed_at).getTime() > cutoff
  );
  return recent ? COOLDOWN_PENALTY : 0;
}

/**
 * Score one activity. Returns { score, mismatch_label, is_explore }.
 * score: float, may be >4 (loved boost) or <0 (clamped to 0 after).
 * Hard exclusions still return score=0.
 */
function scoreActivity(activity, filters, activePreset, journey = [], babyAgeWeeks = null) {
  // ── Age-band hard exclusion ────────────────────────────────────────────────
  if (babyAgeWeeks !== null) {
    const { min_weeks, max_weeks } = activity.milestone_requirements || {};
    if (min_weeks != null && babyAgeWeeks < min_weeks) return { score: 0, mismatch_label: null, is_explore: false };
    if (max_weeks != null && babyAgeWeeks > max_weeks) return { score: 0, mismatch_label: null, is_explore: false };
  }

  // ── Merge filters + preset ─────────────────────────────────────────────────
  const merged = { ...filters };
  if (activePreset) {
    const p = MOMENT_PRESETS.find(p => p.id === activePreset);
    if (p) Object.entries(p.filters).forEach(([k, v]) => { merged[k] = [...(merged[k] || []), ...v]; });
  }
  const hasFilters = Object.values(merged).flat().length > 0;

  // ── Hard exclusions ────────────────────────────────────────────────────────
  const settingFilters = (merged.setting || []).map(s => SETTING_MAP[s]).filter(Boolean);
  if (settingFilters.length && activity.incompatible_settings?.some(s => settingFilters.includes(s)))
    return { score: 0, mismatch_label: null, is_explore: false };
  if (merged.materials?.includes('Just us') && !activity.materials?.includes('none'))
    return { score: 0, mismatch_label: null, is_explore: false };

  // ── Base filter score (0–4) ────────────────────────────────────────────────
  let score = 4; let mismatch_label = null;
  if (!hasFilters) score = 4;

  if (settingFilters.length) {
    const ok = settingFilters.some(s => activity.preferred_settings?.includes(s));
    if (!ok) { score--; mismatch_label = `Best at ${activity.preferred_settings?.[0] || 'home'}`; }
  }
  const energyFilters = (merged.energy || []).map(e => ENERGY_MAP[e]).filter(Boolean);
  if (energyFilters.length) {
    const el = Array.isArray(activity.energy_level) ? activity.energy_level : [activity.energy_level];
    if (!energyFilters.some(e => el.includes(e))) { score--; if (!mismatch_label) mismatch_label = 'Better for a different mood'; }
  }
  if (merged.duration?.length) {
    const ok = merged.duration.some(d => DURATION_FNS[d]?.(activity));
    if (!ok) { score--; if (!mismatch_label) mismatch_label = `About ${activity.duration_minutes} min`; }
  }

  // ── Rating nudge (decayed) ─────────────────────────────────────────────────
  score += ratingNudge(activity.id, journey);

  // ── Cooldown penalty ──────────────────────────────────────────────────────
  score -= cooldownPenalty(activity.id, journey);

  // ── Explore flag: never-tried or not tried recently ───────────────────────
  const everTried = journey.some(j => j.activity_id === activity.id && j.status === 'completed');
  const is_explore = !everTried;

  return { score: Math.max(score, 0.01), mismatch_label, is_explore };
}

/**
 * Return CARD_COUNT scored activities for the Today screen.
 * Maintains:
 *  - domain diversity (no two cards same domain where possible)
 *  - no-materials guarantee: at least one no-materials card when unfiltered
 *  - explore/exploit: ~EXPLORE_FRACTION of slots prefer unseen activities
 */
function getScoredSet(excludeIds = [], filters = {}, activePreset = null, journey = [], babyAgeWeeks = null) {
  const merged = { ...filters };
  if (activePreset) {
    const p = MOMENT_PRESETS.find(p => p.id === activePreset);
    if (p) Object.entries(p.filters).forEach(([k, v]) => { merged[k] = [...(merged[k] || []), ...v]; });
  }
  const hasFilters = Object.values(merged).flat().length > 0;

  const allScored = shuffle(activities)
    .filter(a => !excludeIds.includes(a.id))
    .map(a => ({ activity: a, ...scoreActivity(a, filters, activePreset, journey, babyAgeWeeks) }))
    .filter(s => s.score > 0);

  if (!allScored.length) return [];

  // Split into exploit (tried + well-rated) and explore (fresh/unseen)
  const exploreBucket  = allScored.filter(s => s.is_explore).sort((a, b) => b.score - a.score);
  const exploitBucket  = allScored.filter(s => !s.is_explore).sort((a, b) => b.score - a.score);
  const exploitSorted  = allScored.sort((a, b) => b.score - a.score);

  const result = [];
  const usedDomains = new Set();
  const usedIds = new Set();

  const tryAdd = (candidate) => {
    if (!candidate || usedIds.has(candidate.activity.id)) return false;
    const domain = principles.find(p => p.id === candidate.activity.principle_id)?.domain;
    if (usedDomains.has(domain) && result.length < CARD_COUNT && allScored.length > CARD_COUNT) return false;
    result.push(candidate);
    usedIds.add(candidate.activity.id);
    if (domain) usedDomains.add(domain);
    return true;
  };

  // Slot 0: no-materials guarantee when unfiltered
  if (!hasFilters) {
    const noMat = exploitSorted.find(s => s.activity.materials?.includes('none') && !usedIds.has(s.activity.id));
    if (noMat) tryAdd(noMat);
  }

  // Fill remaining slots with explore/exploit mix
  const exploreSlots = Math.round((CARD_COUNT - result.length) * EXPLORE_FRACTION);
  let ei = 0, xi = 0;
  let exploreUsed = 0;

  while (result.length < CARD_COUNT) {
    const useExplore = exploreUsed < exploreSlots && ei < exploreBucket.length;
    if (useExplore) {
      const added = tryAdd(exploreBucket[ei++]);
      if (added) exploreUsed++;
    } else if (xi < exploitSorted.length) {
      tryAdd(exploitSorted[xi++]);
    } else {
      break; // pool exhausted
    }
  }

  // If domain diversity left gaps, fill without domain constraint
  if (result.length < CARD_COUNT) {
    for (const s of exploitSorted) {
      if (result.length >= CARD_COUNT) break;
      if (!usedIds.has(s.activity.id)) { result.push(s); usedIds.add(s.activity.id); }
    }
  }

  return result;
}

/** Pick one activity for "Surprise me" — best scored, not in current card set. */
function getSurpriseActivity(excludeIds = [], filters = {}, activePreset = null, journey = [], babyAgeWeeks = null) {
  const scored = shuffle(activities)
    .filter(a => !excludeIds.includes(a.id))
    .map(a => ({ activity: a, ...scoreActivity(a, filters, activePreset, journey, babyAgeWeeks) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

function getCardHistoryLabel(activityId, journey) {
  const entries = journey.filter(j => j.activity_id === activityId && j.status === 'completed');
  if (!entries.length) return { text: 'Not tried yet', type: 'new' };
  if (entries.find(e => e.rating === 'loved')) return { text: 'You loved this one', type: 'loved' };
  const days = Math.floor((Date.now() - new Date(entries[0].completed_at).getTime()) / 86400000);
  if (days === 0) return { text: 'Tried earlier today', type: 'recent' };
  if (days === 1) return { text: 'Tried yesterday', type: 'recent' };
  if (days <= 13) return { text: 'Tried a few days ago', type: 'recent' };
  return { text: 'Tried a while back', type: 'neutral' };
}

function getDailyRhythmLine(journey, profile) {
  const hour = new Date().getHours();
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayDone = journey.filter(j => j.status === 'completed' && new Date(j.completed_at) >= todayStart);
  const who = babyLabel(profile) ? `You and ${babyLabel(profile)}` : 'You two';
  if (todayDone.length >= 2) return `${who} have done a couple of things together today.`;
  if (todayDone.length === 1) {
    const prin = principles.find(p => p.id === activities.find(a => a.id === todayDone[0].activity_id)?.principle_id);
    if (prin?.domain === 'language') return 'A nice bit of talking earlier. Want another go?';
    if (prin?.domain === 'motor') return 'Good — some movement earlier. Ready for something different?';
    return 'One down. Ready when you are.';
  }
  const ago14 = Date.now() - 14 * 86400000;
  const recentDomains = new Set(journey
    .filter(j => j.status === 'completed' && new Date(j.completed_at).getTime() > ago14)
    .map(j => principles.find(p => p.id === activities.find(a => a.id === j.activity_id)?.principle_id)?.domain)
    .filter(Boolean));
  if (journey.length > 2 && !recentDomains.has('motor')) return "It's been a little while since something with movement — fancy that?";
  if (hour < 7) return "Up early. Here's something gentle.";
  if (hour < 12) return 'A quiet morning so far?';
  if (hour >= 21) return "Late one. Here's something calm.";
  return 'Ready when you are.';
}

function formatCountdown(secs) {
  if (secs <= 0) return '0:00';
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

// ─── Analytics shim ───────────────────────────────────────────────────────────
// Inert — logs to debug only. Structure supports future retention analysis.
// Each event carries archetype so voice/engagement can be correlated later.

function track(event, payload = {}) {
  debug.log(`track:${event}`, payload);
}

// ─── Classifier API ───────────────────────────────────────────────────────────

async function callClassifierAPI(nickname, apiKey) {
  debug.log('classifier', `nickname="${nickname}"`);
  const prompt = CLASSIFIER_SYSTEM_PROMPT.replace('{NICKNAME}', nickname);
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) { const err = new Error(`API ${resp.status}`); debug._err('classifier/http', err); throw err; }
  const data = await resp.json();
  const text = data.content?.find(b => b.type === 'text')?.text || '';
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    debug._err('classifier/parse', e);
    throw e;
  }
}

// ─── Rewrite API ──────────────────────────────────────────────────────────────

/**
 * Ask Claude to lightly rewrite the four short, non-clinical strings so the
 * nickname flows naturally. Instructions are NEVER sent — only titles/one-liners/CTAs.
 * Mirrors callClassifierAPI: same endpoint, headers, model, debug instrumentation.
 */
async function callRewriteAPI(voice, nickname, archetypeId, apiKey) {
  const arch = getArchetype(archetypeId);
  const prompt = [
    `You are lightly personalising four short UI strings for a baby-activity app.`,
    `The baby's nickname is "${nickname}". The voice/persona is ${arch?.display_name} (${arch?.personality_sketch}).`,
    ``,
    `Rewrite each string below so the nickname is woven in naturally — fix articles, possessives, capitalisation and flow so it doesn't read like a template. Keep the same meaning, tone, and persona. Do not add new claims, instructions, advice, durations, or safety notes. Do not make any string materially longer. These are titles and button labels, not instructions.`,
    ``,
    `If a string reads fine without the nickname, leave it unchanged. Never invent facts about the baby.`,
    ``,
    `Return ONLY this JSON, no prose, no markdown fences:`,
    `{"title": "...", "one_line_description": "...", "cta": "...", "card_cta": "..."}`,
    ``,
    `Strings:`,
    `title: "${voice.title}"`,
    `one_line_description: "${voice.one_line_description}"`,
    `cta: "${voice.cta}"`,
    `card_cta: "${voice.card_cta}"`,
  ].join('\n');

  debug.log('rewrite', `activity_title="${voice.title}" nickname="${nickname}"`);
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) { const err = new Error(`Rewrite API ${resp.status}`); debug._err('rewrite/http', err); throw err; }
  const data = await resp.json();
  const text = data.content?.find(b => b.type === 'text')?.text || '';
  let parsed;
  try { parsed = JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch (e) { debug._err('rewrite/parse', e); throw e; }

  // Validation guards: all four keys present, non-empty strings, not wildly longer
  const fields = ['title', 'one_line_description', 'cta', 'card_cta'];
  for (const f of fields) {
    const src = voice[f] || '';
    const got = parsed[f];
    if (!got || typeof got !== 'string' || got.trim() === '') throw new Error(`rewrite missing ${f}`);
    if (got.length > Math.max(src.length * 1.6, src.length + 60)) throw new Error(`rewrite too long: ${f}`);
  }
  // CTAs must be single-line button labels
  if (parsed.cta.includes('\n') || parsed.card_cta.includes('\n')) throw new Error('rewrite CTA has newlines');

  return { title: parsed.title, one_line_description: parsed.one_line_description, cta: parsed.cta, card_cta: parsed.card_cta };
}

// ─── Style constants ──────────────────────────────────────────────────────────

const labelSt = { display: 'block', fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: '#7A6A5E', marginBottom: 6, marginTop: 18 };
const inputSt = { width: '100%', padding: '12px 14px', background: 'rgba(255,255,255,0.8)', border: '1px solid rgba(200,185,165,0.35)', borderRadius: 12, fontSize: 14, color: '#3A2E24', fontFamily: "'DM Sans',sans-serif", outline: 'none', boxSizing: 'border-box' };
const btnPri  = { width: '100%', padding: '14px', background: '#C8A97E', border: 'none', borderRadius: 14, fontSize: 15, color: 'white', fontFamily: "'Crimson Pro',Georgia,serif", fontWeight: 600, cursor: 'pointer', marginTop: 16 };
const btnSkp  = { width: '100%', padding: '10px', background: 'none', border: 'none', fontSize: 13, color: '#A0845C', fontFamily: "'DM Sans',sans-serif", cursor: 'pointer', marginTop: 4 };
const sHead   = { fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 24, fontWeight: 600, color: '#3A2E24', margin: '0 0 8px' };
const sSub    = { fontFamily: "'DM Sans',sans-serif", fontSize: 13.5, color: '#7A6A5E', margin: '0 0 20px', lineHeight: 1.6 };
const cardBox = { background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(200,185,165,0.25)', borderRadius: 18, padding: '18px 20px', marginBottom: 14 };
const secLabel= { fontSize: 11, color: '#A0845C', fontFamily: "'DM Sans',sans-serif", fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 12 };

// One Hand Mode style overrides — applied additionally when ohm=true
function ohmBtn(base) {
  return { ...base, padding: '18px', fontSize: 18, borderRadius: 18 };
}

// ─── Atomic components ────────────────────────────────────────────────────────

function BloomMark({ pulse, size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" style={{ animation: pulse ? 'bloomPulse 0.6s ease-in-out' : 'none', flexShrink: 0 }}>
      <circle cx="14" cy="14" r="4" fill="#C8A97E" opacity="0.9" />
      {[0,60,120,180,240,300].map((deg, i) => { const rad=deg*Math.PI/180, cx=14+7*Math.cos(rad), cy=14+7*Math.sin(rad); return <ellipse key={i} cx={cx} cy={cy} rx="2.8" ry="4.5" transform={`rotate(${deg},${cx},${cy})`} fill="#C8A97E" opacity={0.55+i*0.07} />; })}
    </svg>
  );
}

function BackButton({ onBack, label = 'Back' }) {
  return (
    <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", fontSize: 13.5, color: '#A0845C', padding: 0 }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="#A0845C" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      {label}
    </button>
  );
}

function PrincipleTag({ principleId, small }) {
  const p = principles.find(x => x.id === principleId); if (!p) return null;
  const color = DOMAIN_COLOURS[p.domain] || '#999';
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: `${color}18`, border: `1px solid ${color}40`, borderRadius: 20, padding: small ? '2px 8px' : '3px 10px', fontSize: small ? 10 : 11, color, fontFamily: "'DM Sans',sans-serif", fontWeight: 500, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{DOMAIN_ICONS[p.domain]} {p.display_name}</span>;
}

function ArchetypeBadge({ archetypeId, onPress, small, showHint }) {
  const arch = getArchetype(archetypeId); if (!arch || archetypeId === ARCHETYPES.PLAIN) return null;
  const icons = { royal_court:'♛', tiny_tyrant:'◈', little_creature:'❋', feral_goblin:'⚡', field_researcher:'◉' };
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={onPress} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(180,155,115,0.12)', border: '1px solid rgba(180,155,115,0.3)', borderRadius: 20, padding: small ? '2px 8px' : '3px 10px', fontSize: small ? 10 : 11, color: '#A0845C', fontFamily: "'Crimson Pro',Georgia,serif", fontStyle: 'italic', cursor: onPress ? 'pointer' : 'default' }}>
        {icons[archetypeId] || '◎'} {arch.display_name}
      </button>
      {showHint && (
        <div style={{ position: 'absolute', top: '110%', right: 0, background: '#3A2E24', color: 'white', borderRadius: 10, padding: '5px 10px', fontSize: 11, fontFamily: "'DM Sans',sans-serif", whiteSpace: 'nowrap', zIndex: 200, animation: 'fadeIn 0.3s ease', pointerEvents: 'none' }}>
          Tap to change voice ↑
        </div>
      )}
    </div>
  );
}

// Small marker for voices that exist but aren't authored yet.
function ComingSoonPill() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 9.5, color: '#A0845C', background: 'rgba(200,169,126,0.14)', border: '1px solid rgba(200,169,126,0.3)', borderRadius: 10, padding: '2px 7px', fontFamily: "'DM Sans',sans-serif", fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
      Coming soon
    </span>
  );
}

// ─── Post-activity "one more" beat ────────────────────────────────────────────

function PostActivityBeat({ rating, onShowAnother, onBack }) {
  const msg = rating === 'loved'
    ? 'Lovely. Ready for another?'
    : rating === 'not_today'
    ? 'No worries — there are plenty more.'
    : 'Nice one. Want another?';
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(58,46,36,0.32)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', animation: 'fadeIn 0.2s ease' }}>
      <div style={{ background: '#FFFDF8', borderRadius: '24px 24px 0 0', width: '100%', maxWidth: 480, padding: '20px 22px 52px', animation: 'slideUp 0.28s cubic-bezier(0.32,0.72,0,1)', boxShadow: '0 -4px 40px rgba(100,80,60,0.14)' }}>
        <div style={{ width: 32, height: 4, background: '#E2D8CE', borderRadius: 4, margin: '0 auto 20px' }} />
        <p style={{ margin: '0 0 20px', fontFamily: "'Crimson Pro',Georgia,serif", fontStyle: 'italic', fontSize: 17, color: '#5A4A3E', textAlign: 'center' }}>{msg}</p>
        <button onClick={onShowAnother} style={{ width: '100%', padding: '15px', background: '#C8A97E', border: 'none', borderRadius: 16, fontSize: 16, color: 'white', fontFamily: "'Crimson Pro',Georgia,serif", fontWeight: 600, cursor: 'pointer', marginBottom: 10 }}>
          Show me another
        </button>
        <button onClick={onBack} style={{ width: '100%', padding: '10px', background: 'none', border: 'none', fontSize: 13, color: '#A0845C', fontFamily: "'DM Sans',sans-serif", cursor: 'pointer' }}>
          Back to Today
        </button>
      </div>
    </div>
  );
}

// ─── Filters + Moments Modal ──────────────────────────────────────────────────

function FiltersModal({ filters, activePreset, onChange, onPresetChange, onClose }) {
  const [local, setLocal] = useState({ ...filters });
  const [localPreset, setLocalPreset] = useState(activePreset);
  const toggle = (group, val) => { setLocalPreset(null); setLocal(f => ({ ...f, [group]: f[group]?.includes(val) ? f[group].filter(x => x !== val) : [...(f[group]||[]), val] })); };
  const selectPreset = id => { if (localPreset === id) { setLocalPreset(null); setLocal({}); } else { setLocalPreset(id); setLocal({}); } };
  const totalActive = localPreset ? Object.values(MOMENT_PRESETS.find(p => p.id === localPreset)?.filters||{}).flat().length : Object.values(local).flat().length;
  const apply = () => { onChange(local); onPresetChange(localPreset); onClose(); };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(58,46,36,0.4)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', animation: 'fadeIn 0.2s ease' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#FFFDF8', borderRadius: '24px 24px 0 0', width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto', padding: '20px 22px 48px', animation: 'slideUp 0.28s cubic-bezier(0.32,0.72,0,1)', boxShadow: '0 -4px 40px rgba(100,80,60,0.15)' }}>
        <div style={{ width: 32, height: 4, background: '#E2D8CE', borderRadius: 4, margin: '0 auto 20px' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 20, color: '#3A2E24', fontWeight: 600 }}>Filters</h3>
          {totalActive > 0 && <button onClick={() => { setLocal({}); setLocalPreset(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#C8A97E', fontFamily: "'DM Sans',sans-serif" }}>Clear all</button>}
        </div>
        <div style={{ ...secLabel }}>Quick moments</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 24 }}>
          {MOMENT_PRESETS.map(preset => {
            const active = localPreset === preset.id;
            return <button key={preset.id} onClick={() => selectPreset(preset.id)} style={{ padding: '10px 12px', background: active ? 'rgba(200,169,126,0.15)' : 'white', border: `1.5px solid ${active ? '#C8A97E' : 'rgba(200,185,165,0.35)'}`, borderRadius: 14, cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s' }}>
              <div style={{ fontSize: 16, marginBottom: 3 }}>{preset.emoji}</div>
              <div style={{ fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 13.5, color: '#3A2E24', fontWeight: 600 }}>{preset.label}</div>
              <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: '#9A8070', marginTop: 1 }}>{preset.description}</div>
            </button>;
          })}
        </div>
        <div style={{ ...secLabel, marginBottom: 16 }}>Or filter manually</div>
        {FILTER_GROUPS.map(({ key, label, options }) => (
          <div key={key} style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: '#7A6A5E', fontFamily: "'DM Sans',sans-serif", fontWeight: 500, marginBottom: 8 }}>{label}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {options.map(opt => { const active = !localPreset && local[key]?.includes(opt); return <button key={opt} onClick={() => toggle(key, opt)} style={{ padding: '7px 13px', background: active ? '#C8A97E' : 'white', border: `1px solid ${active ? '#C8A97E' : 'rgba(200,185,165,0.4)'}`, borderRadius: 20, fontSize: 12.5, color: active ? 'white' : '#5A4A3E', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", transition: 'all 0.15s' }}>{opt}</button>; })}
            </div>
          </div>
        ))}
        <button onClick={apply} style={{ width: '100%', padding: '14px', background: '#C8A97E', border: 'none', borderRadius: 14, fontSize: 15, color: 'white', fontFamily: "'Crimson Pro',Georgia,serif", fontWeight: 600, cursor: 'pointer', marginTop: 8 }}>
          {totalActive > 0 ? `Apply · ${totalActive} active` : 'Apply'}
        </button>
      </div>
    </div>
  );
}

// ─── Archetype Switcher ───────────────────────────────────────────────────────

function ArchetypeSwitcher({ current, onSelect, onClose }) {
  const icons = { royal_court:'♛', tiny_tyrant:'◈', little_creature:'❋', feral_goblin:'⚡', field_researcher:'◉', plain:'○' };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(58,46,36,0.4)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', animation: 'fadeIn 0.2s ease' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#FFFDF8', borderRadius: '24px 24px 0 0', width: '100%', maxWidth: 480, maxHeight: '80vh', overflowY: 'auto', padding: '20px 22px 48px', animation: 'slideUp 0.28s cubic-bezier(0.32,0.72,0,1)', boxShadow: '0 -4px 40px rgba(100,80,60,0.15)' }}>
        <div style={{ width: 32, height: 4, background: '#E2D8CE', borderRadius: 4, margin: '0 auto 20px' }} />
        <h3 style={{ margin: '0 0 6px', fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 20, color: '#3A2E24', fontWeight: 600 }}>Voice</h3>
        <p style={{ margin: '0 0 18px', fontSize: 13, color: '#9A8070', fontFamily: "'DM Sans',sans-serif" }}>Choose how activities are described.</p>
        {archetypes.filter(a => a.status === 'active')
          .sort((a, b) => Number(isVoiceReady(b.id)) - Number(isVoiceReady(a.id)))
          .map(a => {
          const active = current === a.id;
          const ready = isVoiceReady(a.id);
          return <div key={a.id} onClick={ready ? () => { onSelect(a.id); onClose(); } : undefined} style={{ background: active ? 'rgba(200,169,126,0.12)' : 'white', border: `1.5px solid ${active ? 'rgba(200,169,126,0.5)' : 'rgba(200,185,165,0.25)'}`, borderRadius: 14, padding: '12px 16px', marginBottom: 10, cursor: ready ? 'pointer' : 'default', opacity: ready ? 1 : 0.6, transition: 'all 0.15s' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                  <span style={{ fontSize: 14, color: '#C8A97E' }}>{icons[a.id]}</span>
                  <span style={{ fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 16, color: '#3A2E24', fontWeight: 600 }}>{a.display_name}</span>
                  {!ready && <ComingSoonPill />}
                </div>
                <p style={{ margin: 0, fontFamily: "'DM Sans',sans-serif", fontSize: 12.5, color: '#7A6A5E' }}>{a.short_description}</p>
                {ready && a.preview_sample && <p style={{ margin: '5px 0 0', fontFamily: "'Crimson Pro',Georgia,serif", fontStyle: 'italic', fontSize: 12, color: '#A0845C' }}>{a.preview_sample}</p>}
              </div>
              {ready && <div style={{ width: 18, height: 18, borderRadius: '50%', border: `2px solid ${active ? '#C8A97E' : '#D0C0B0'}`, background: active ? '#C8A97E' : 'transparent', transition: 'all 0.15s', flexShrink: 0, marginLeft: 12, marginTop: 2 }} />}
            </div>
          </div>;
        })}
      </div>
    </div>
  );
}

// ─── Classification ───────────────────────────────────────────────────────────

function ArchetypePickerList({ onSelect, onSkip }) {
  const icons = { royal_court:'♛', tiny_tyrant:'◈', little_creature:'❋', feral_goblin:'⚡', field_researcher:'◉' };
  // Ready voices first, then coming-soon ones.
  const list = archetypes
    .filter(a => a.id !== ARCHETYPES.PLAIN && a.status === 'active')
    .sort((a, b) => Number(isVoiceReady(b.id)) - Number(isVoiceReady(a.id)));
  return (
    <div>
      {list.map(a => {
        const ready = isVoiceReady(a.id);
        return (
          <div key={a.id} onClick={ready ? () => onSelect(a.id) : undefined} style={{ background: 'rgba(255,255,255,0.75)', border: '1px solid rgba(200,185,165,0.3)', borderRadius: 14, padding: '13px 16px', marginBottom: 10, cursor: ready ? 'pointer' : 'default', opacity: ready ? 1 : 0.6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: 15, color: '#C8A97E' }}>{icons[a.id]}</span>
              <span style={{ fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 16, color: '#3A2E24', fontWeight: 600 }}>{a.display_name}</span>
              {!ready && <ComingSoonPill />}
            </div>
            <p style={{ margin: 0, fontFamily: "'DM Sans',sans-serif", fontSize: 12.5, color: '#7A6A5E' }}>{a.short_description}</p>
          </div>
        );
      })}
      <button onClick={onSkip} style={{ ...btnSkp, textAlign: 'center', marginTop: 8 }}>Use plain voice instead</button>
    </div>
  );
}

function ClassificationResult({ result, nickname, onAccept, onPickManually }) {
  const arch = getArchetype(result.archetype);
  const icons = { royal_court:'♛', tiny_tyrant:'◈', little_creature:'❋', feral_goblin:'⚡', field_researcher:'◉' };
  if (result.inappropriate) return (
    <div style={{ padding: '0 0 16px', textAlign: 'center' }}>
      <div style={{ fontSize: 32, marginBottom: 16 }}>🌸</div>
      <h2 style={{ ...sHead, textAlign: 'center' }}>Let's pick a different nickname</h2>
      <p style={{ ...sSub, textAlign: 'center' }}>That one's not quite right for the app. Try something else?</p>
      <button onClick={() => onPickManually('retry')} style={btnPri}>Try a different name</button>
    </div>
  );
  if (result.archetype === 'no_match' || result.confidence === 'low') return (
    <div>
      <h2 style={sHead}>Pick a vibe for {nickname}</h2>
      <p style={sSub}>We don't quite have a match for {nickname} yet — but you can pick one here.</p>
      <ArchetypePickerList onSelect={onAccept} onSkip={() => onAccept(ARCHETYPES.PLAIN)} />
    </div>
  );
  // Suggested voice exists but isn't authored yet — don't present it as ready.
  if (!isVoiceReady(result.archetype)) return (
    <div>
      <h2 style={sHead}>{nickname} feels like {arch?.display_name}</h2>
      <p style={sSub}>That voice isn't quite ready yet — it's coming soon. In the meantime, pick one of these or keep it plain.</p>
      <ArchetypePickerList onSelect={onAccept} onSkip={() => onAccept(ARCHETYPES.PLAIN)} />
    </div>
  );
  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>{icons[result.archetype] || '◎'}</div>
        <h2 style={{ ...sHead, textAlign: 'center', marginBottom: 8 }}>{nickname} feels like {arch?.display_name}</h2>
        <p style={{ ...sSub, textAlign: 'center' }}>{arch?.short_description}</p>
        {arch?.preview_sample && <p style={{ fontFamily: "'Crimson Pro',Georgia,serif", fontStyle: 'italic', fontSize: 13, color: '#A0845C', textAlign: 'center' }}>{arch.preview_sample}</p>}
      </div>
      <button onClick={() => onAccept(result.archetype)} style={btnPri}>Yes, sounds good</button>
      <button onClick={onPickManually} style={{ ...btnSkp, textAlign: 'center' }}>{result.confidence === 'high' ? 'Pick a different one' : 'Or pick another vibe'}</button>
    </div>
  );
}

// ─── Countdown Timer ──────────────────────────────────────────────────────────

function CountdownTimer({ totalSecs, running, elapsed, onToggle, onReset, onDisable, ohm }) {
  const SIZE=180, R=76, CX=90, CY=90, circ=2*Math.PI*R;
  const remaining = Math.max(totalSecs - elapsed, 0);
  const done = elapsed >= totalSecs && totalSecs > 0;
  const offset = circ * (1 - (totalSecs > 0 ? remaining / totalSecs : 1));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div style={{ position: 'relative', cursor: 'pointer' }} onClick={onToggle}>
        <svg width={SIZE} height={SIZE} style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(200,169,126,0.12)" strokeWidth="6" />
          <circle cx={CX} cy={CY} r={R} fill="none" stroke={done ? 'rgba(139,175,142,0.6)' : '#C8A97E'} strokeWidth="6" strokeDasharray={circ} strokeDashoffset={done ? 0 : offset} strokeLinecap="round" style={{ transition: 'stroke-dashoffset 0.8s ease, stroke 0.5s ease', filter: done ? 'drop-shadow(0 0 6px rgba(139,175,142,0.4))' : 'none' }} />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
          <span style={{ fontFamily: "'Crimson Pro',Georgia,serif", fontSize: ohm ? 44 : 38, fontWeight: 600, color: done ? '#8BAF8E' : '#3A2E24', lineHeight: 1 }}>{formatCountdown(remaining)}</span>
          <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: '#B8A898' }}>{done ? "time's up ✦" : running ? 'tap to pause' : elapsed === 0 ? 'tap to start' : 'tap to resume'}</span>
        </div>
      </div>
      {done && elapsed > totalSecs && <div style={{ fontSize: 12, color: '#8BAF8E', fontFamily: "'DM Sans',sans-serif" }}>+{formatCountdown(elapsed - totalSecs)} bonus time</div>}
      {/* Bigger timer controls — comfortable tap targets regardless of OHM */}
      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={onReset} style={{ background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(200,185,165,0.35)', borderRadius: 20, padding: ohm ? '10px 22px' : '7px 16px', fontSize: ohm ? 14 : 12, color: '#7A6A5E', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Reset</button>
        <button onClick={onDisable} style={{ background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(200,185,165,0.35)', borderRadius: 20, padding: ohm ? '10px 22px' : '7px 16px', fontSize: ohm ? 14 : 12, color: '#7A6A5E', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>No timer</button>
      </div>
    </div>
  );
}

// ─── Feedback Modal ───────────────────────────────────────────────────────────

function FeedbackModal({ onRate }) {
  const [phase, setPhase] = useState('rate');
  const [rating, setRating] = useState(null);
  const pick = r => {
    setRating(r);
    if (r === 'not_today') { setPhase('followup'); return; }
    setTimeout(() => onRate(r), 350);
  };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(58,46,36,0.32)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', animation: 'fadeIn 0.2s ease' }}>
      <div style={{ background: '#FFFDF8', borderRadius: '24px 24px 0 0', width: '100%', maxWidth: 480, padding: '20px 22px 52px', animation: 'slideUp 0.28s cubic-bezier(0.32,0.72,0,1)', boxShadow: '0 -4px 40px rgba(100,80,60,0.14)' }}>
        <div style={{ width: 32, height: 4, background: '#E2D8CE', borderRadius: 4, margin: '0 auto 20px' }} />
        {phase === 'rate' ? (
          <>
            <div style={{ fontSize: 17, color: '#5A4A3E', fontFamily: "'Crimson Pro',Georgia,serif", fontStyle: 'italic', marginBottom: 18, textAlign: 'center' }}>How did that go?</div>
            {[{k:'loved',l:'Loved it',s:'✦'},{k:'okay',l:'Okay',s:'◇'},{k:'not_today',l:'Not today',s:'○'}].map(r => (
              <button key={r.k} onClick={() => pick(r.k)} style={{ width: '100%', padding: '14px 18px', marginBottom: 8, background: 'white', border: '1px solid rgba(200,185,165,0.3)', borderRadius: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14, fontFamily: "'DM Sans',sans-serif", fontSize: 14.5, color: '#3A2E24' }}>
                <span style={{ fontSize: 18, color: '#C8A97E', width: 22, textAlign: 'center' }}>{r.s}</span>{r.l}
              </button>
            ))}
          </>
        ) : (
          <>
            <div style={{ fontSize: 14, color: '#7A6A5E', fontFamily: "'DM Sans',sans-serif", marginBottom: 14 }}>What got in the way? <span style={{ color: '#B8A898' }}>(optional)</span></div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
              {['Too fussy','Too easy','Too hard',"Didn't have the stuff"].map(opt => <button key={opt} onClick={() => onRate(rating)} style={{ padding: '9px 14px', background: 'white', border: '1px solid rgba(200,185,165,0.4)', borderRadius: 20, fontSize: 13, color: '#5A4A3E', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>{opt}</button>)}
            </div>
            <button onClick={() => onRate(rating)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#B8A898', fontFamily: "'DM Sans',sans-serif" }}>Skip</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Activity Screen (card style + OHM) ──────────────────────────────────────

function ActivityScreen({ activity, archetypeId, babyName, entryPoint, resumeElapsed, onBack, backLabel, onComplete, onSaveForLater, isRepeat, ohm, nicknameOn, apiKey, onRewriteLanded }) {
  const [localPlain, setLocalPlain] = useState(false);
  const effectiveArchetype = localPlain ? ARCHETYPES.PLAIN : archetypeId;
  const voice = resolveVoice(activity, effectiveArchetype, babyName);
  const principle = principles.find(p => p.id === activity.principle_id);
  const totalSecs = activity.duration_minutes * 60;
  const domainColor = DOMAIN_COLOURS[principle?.domain] || '#C8A97E';
  const icons = { royal_court:'♛', tiny_tyrant:'◈', little_creature:'❋', feral_goblin:'⚡', field_researcher:'◉' };

  // Apply rewrite overlay for title/one_liner if cached
  const rwCache = (nicknameOn && babyName && isVoiceReady(effectiveArchetype) && effectiveArchetype !== ARCHETYPES.PLAIN)
    ? getRewrite(activity.id, effectiveArchetype, babyName) : null;
  const displayVoice = rwCache ? { ...voice, title: rwCache.title, one_line_description: rwCache.one_line_description } : voice;
  const displayCta = isRepeat ? 'Start this again →' : (rwCache?.cta || resolveKey('cta', activity, effectiveArchetype, babyName));

  // Background rewrite request — fires once per (activity, voice, nickname) miss
  useEffect(() => {
    if (!nicknameOn || !babyName || !apiKey || !navigator.onLine) return;
    if (!isVoiceReady(effectiveArchetype) || effectiveArchetype === ARCHETYPES.PLAIN || localPlain) return;
    if (getRewrite(activity.id, effectiveArchetype, babyName)) return; // already cached
    callRewriteAPI(voice, babyName, effectiveArchetype, apiKey)
      .then(result => { saveRewrite(activity.id, effectiveArchetype, babyName, result); onRewriteLanded?.(); })
      .catch(() => {}); // silent failure — stays on mechanical
  }, [activity.id, effectiveArchetype, babyName, nicknameOn]); // eslint-disable-line

  const [timerEnabled, setTimerEnabled] = useState(true);
  const [timerRunning, setTimerRunning] = useState(false);
  const [elapsed, setElapsed] = useState(resumeElapsed || 0);
  const intervalRef = useRef(null);
  const runStartRef = useRef(null);
  const elapsedAtRunStart = useRef(elapsed);

  useEffect(() => {
    if (!timerRunning || !timerEnabled) { clearInterval(intervalRef.current); return; }
    runStartRef.current = Date.now(); elapsedAtRunStart.current = elapsed;
    intervalRef.current = setInterval(() => { setElapsed(elapsedAtRunStart.current + Math.floor((Date.now() - runStartRef.current) / 1000)); }, 1000);
    return () => clearInterval(intervalRef.current);
  }, [timerRunning, timerEnabled]); // eslint-disable-line

  const toggleTimer = () => { setTimerRunning(r => { if (r) setElapsed(elapsedAtRunStart.current + Math.floor((Date.now() - runStartRef.current) / 1000)); return !r; }); };
  const resetTimer = () => { clearInterval(intervalRef.current); setTimerRunning(false); setElapsed(0); };
  const toggleTimerEnabled = () => { if (timerEnabled) { clearInterval(intervalRef.current); setTimerRunning(false); } setTimerEnabled(e => !e); };

  const [whyOpen, setWhyOpen] = useState(entryPoint === 'principles');
  const [showFeedback, setShowFeedback] = useState(false);
  const handleRate = r => { setShowFeedback(false); onComplete(r, elapsed); };
  const ctaLabel = displayCta;

  const fontSize = ohm ? { h1: 30, body: 17, step: 16, tag: 12 } : { h1: 26, body: 15.5, step: 14.5, tag: 11 };

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(160deg,#FDF6ED 0%,#F5EDE0 40%,#EDE4D8 100%)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: ohm ? '18px 22px 0' : '14px 20px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <BackButton onBack={onBack} label={backLabel || 'Today'} />
        {/* "Aa" control — labelled for clarity */}
        <button
          onClick={() => setLocalPlain(l => !l)}
          title="Toggle plain voice"
          aria-label="Toggle plain voice"
          style={{ background: localPlain ? 'rgba(200,169,126,0.15)' : 'transparent', border: '1px solid rgba(200,169,126,0.3)', borderRadius: 8, padding: '4px 10px', fontSize: 11, color: '#A0845C', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
          {isRepeat ? (localPlain ? 'Original voice' : 'Current voice') : (localPlain ? 'Plain voice' : 'Plain voice off')}
        </button>
      </div>

      {/* Activity as a card — elevated, rounded, sitting on the background */}
      <div style={{ flex: 1, overflowY: 'auto', padding: ohm ? '16px 14px 140px' : '16px 16px 130px' }}>
        <div style={{ background: 'rgba(255,255,255,0.82)', backdropFilter: 'blur(16px)', borderRadius: 24, boxShadow: '0 4px 32px rgba(140,110,80,0.12)', padding: ohm ? '24px 22px' : '20px 20px', marginBottom: 16 }}>
          <h1 style={{ margin: '0 0 10px', fontFamily: "'Crimson Pro',Georgia,serif", fontSize: fontSize.h1, fontWeight: 600, color: '#3A2E24', lineHeight: 1.25 }}>{displayVoice.title}</h1>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
            <PrincipleTag principleId={activity.principle_id} />
            {!voice.is_plain && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(180,155,115,0.12)', border: '1px solid rgba(180,155,115,0.3)', borderRadius: 20, padding: '3px 10px', fontSize: fontSize.tag, color: '#A0845C', fontFamily: "'Crimson Pro',Georgia,serif", fontStyle: 'italic' }}>{icons[effectiveArchetype] || '◎'} {getArchetype(effectiveArchetype)?.display_name}</span>}
            <span style={{ fontSize: fontSize.tag, color: '#B8A898', fontFamily: "'DM Sans',sans-serif" }}>{activity.duration_minutes} min</span>
            {activity.materials_display && <span style={{ fontSize: fontSize.tag, color: '#9A8070', fontFamily: "'DM Sans',sans-serif", fontStyle: 'italic' }}>You'll need: {activity.materials_display}</span>}
          </div>
          <p style={{ margin: '0 0 24px', fontSize: fontSize.body, color: '#5A4A3E', lineHeight: 1.65, fontFamily: "'DM Sans',sans-serif" }}>{displayVoice.one_line_description}</p>

          {timerEnabled && <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}><CountdownTimer totalSecs={totalSecs} running={timerRunning} elapsed={elapsed} onToggle={toggleTimer} onReset={resetTimer} onDisable={toggleTimerEnabled} ohm={ohm} /></div>}
          {!timerEnabled && <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}><button onClick={toggleTimerEnabled} style={{ background: 'none', border: '1px solid rgba(200,185,165,0.3)', borderRadius: 20, padding: '6px 16px', fontSize: 12, color: '#B8A898', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>+ Turn on timer</button></div>}

          <div style={{ marginBottom: 24 }}>
            {voice.full_instructions.map((step, i) => (
              <div key={i} style={{ display: 'flex', gap: ohm ? 16 : 14, marginBottom: ohm ? 20 : 16, alignItems: 'flex-start' }}>
                <div style={{ width: ohm ? 34 : 28, height: ohm ? 34 : 28, borderRadius: '50%', flexShrink: 0, background: `${domainColor}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: ohm ? 14 : 12, fontWeight: 600, fontFamily: "'DM Sans',sans-serif", color: domainColor }}>{i + 1}</div>
                <p style={{ margin: 0, fontSize: fontSize.step, color: '#5A4A3E', lineHeight: 1.65, fontFamily: "'DM Sans',sans-serif", paddingTop: 4 }}>{step}</p>
              </div>
            ))}
          </div>

          <div style={{ marginBottom: 8 }}>
            <button onClick={() => setWhyOpen(o => !o)} style={{ width: '100%', background: 'rgba(200,169,126,0.08)', border: '1px solid rgba(200,169,126,0.18)', borderRadius: whyOpen ? '14px 14px 0 0' : 14, padding: '12px 16px', cursor: 'pointer', textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#A0845C', fontFamily: "'DM Sans',sans-serif", fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase' }}>Why this helps</span>
              <span style={{ fontSize: 14, color: '#C8A97E', display: 'inline-block', transition: 'transform 0.2s ease', transform: whyOpen ? 'rotate(180deg)' : 'none' }}>⌄</span>
            </button>
            {whyOpen && <div style={{ background: 'rgba(200,169,126,0.05)', border: '1px solid rgba(200,169,126,0.15)', borderTop: 'none', borderRadius: '0 0 14px 14px', padding: '14px 16px', animation: 'fadeIn 0.2s ease' }}>
              <p style={{ margin: '0 0 8px', fontSize: 13.5, color: '#5A4A3E', lineHeight: 1.6, fontFamily: "'DM Sans',sans-serif" }}>{activity.principle_explanation}</p>
              <div style={{ fontSize: 11, color: '#B8A898', fontFamily: "'DM Sans',sans-serif" }}>{formatCitations(activity.source_citations)}</div>
            </div>}
          </div>
        </div>
      </div>

      <div style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 480, background: 'rgba(253,246,237,0.96)', backdropFilter: 'blur(12px)', borderTop: '1px solid rgba(200,185,165,0.2)', padding: ohm ? '16px 22px 36px' : '14px 22px 28px' }}>
        <button onClick={() => setShowFeedback(true)} style={{ width: '100%', padding: ohm ? '18px' : '15px', background: '#C8A97E', border: 'none', borderRadius: ohm ? 20 : 16, fontSize: ohm ? 18 : 16, color: 'white', fontFamily: "'Crimson Pro',Georgia,serif", fontWeight: 600, cursor: 'pointer' }}>{ctaLabel}</button>
        <button onClick={() => onSaveForLater(activity)} style={{ width: '100%', padding: ohm ? '12px' : '10px', background: 'none', border: 'none', fontSize: ohm ? 15 : 13, color: '#A0845C', fontFamily: "'DM Sans',sans-serif", cursor: 'pointer' }}>Save for later</button>
      </div>
      {showFeedback && <FeedbackModal onRate={handleRate} />}
    </div>
  );
}

// ─── Activity Card ────────────────────────────────────────────────────────────

function ActivityCard({ scored, archetypeId, babyName, onOpen, index, journey, ohm, rewriteVer, nicknameOn, apiKey, onRewriteLanded }) {
  const { activity, mismatch_label } = scored;
  const voice = resolveVoice(activity, archetypeId, babyName);
  const principle = principles.find(p => p.id === activity.principle_id);
  const hist = getCardHistoryLabel(activity.id, journey);
  const domainColor = DOMAIN_COLOURS[principle?.domain] || '#C8A97E';

  // Apply rewrite overlay for card title/one_liner/card_cta if cached
  const rwCache = (nicknameOn && babyName && isVoiceReady(archetypeId) && archetypeId !== ARCHETYPES.PLAIN)
    ? getRewrite(activity.id, archetypeId, babyName) : null;
  const displayTitle = rwCache?.title || voice.title;
  const displayOneLiner = rwCache?.one_line_description || voice.one_line_description;
  const cardCta = rwCache?.card_cta || resolveKey('card_cta', activity, archetypeId, babyName);

  // Background rewrite request for Today cards
  useEffect(() => {
    if (!nicknameOn || !babyName || !apiKey || !navigator.onLine) return;
    if (!isVoiceReady(archetypeId) || archetypeId === ARCHETYPES.PLAIN) return;
    if (getRewrite(activity.id, archetypeId, babyName)) return;
    callRewriteAPI(voice, babyName, archetypeId, apiKey)
      .then(result => { saveRewrite(activity.id, archetypeId, babyName, result); onRewriteLanded?.(); })
      .catch(() => {});
  }, [activity.id, archetypeId, babyName, nicknameOn]); // eslint-disable-line

  // Item 12: only show "Not tried yet" on the first unseen card, not all of them
  const showHist = hist.type !== 'new' || index === 0;

  return (
    <div onClick={() => onOpen(activity)} style={{ background: 'rgba(255,255,255,0.72)', backdropFilter: 'blur(12px)', border: '1px solid rgba(200,185,165,0.25)', borderRadius: 20, padding: ohm ? '24px 22px' : '20px 22px', cursor: 'pointer', transition: 'transform 0.2s ease, box-shadow 0.2s ease', boxShadow: '0 2px 20px rgba(160,140,120,0.08)', animation: 'cardIn 0.4s ease both', animationDelay: `${index * 0.06}s`, position: 'relative', overflow: 'hidden' }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 6px 28px rgba(160,140,120,0.14)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = '0 2px 20px rgba(160,140,120,0.08)'; }}>
      <div style={{ position: 'absolute', top: 0, right: 0, width: 80, height: 80, borderRadius: '0 20px 0 80px', background: `${domainColor}10` }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
        <div style={{ fontSize: 11, fontFamily: "'Crimson Pro',Georgia,serif", fontStyle: 'italic', color: hist.type === 'loved' ? '#C8A97E' : hist.type === 'new' ? '#8BAF8E' : '#B8A898', minHeight: 15 }}>
          {showHist ? hist.text : ''}
        </div>
        {mismatch_label && <span style={{ fontSize: 10, color: '#B8A898', background: 'rgba(200,185,165,0.15)', borderRadius: 10, padding: '2px 7px', fontFamily: "'DM Sans',sans-serif", whiteSpace: 'nowrap' }}>{mismatch_label}</span>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: ohm ? 20 : 17, fontFamily: "'Crimson Pro',Georgia,serif", fontWeight: 600, color: '#3A2E24', lineHeight: 1.3, flex: 1 }}>{displayTitle}</h3>
        <span style={{ fontSize: 12, color: '#9A8070', fontFamily: "'DM Sans',sans-serif", whiteSpace: 'nowrap', marginTop: 2 }}>{activity.duration_minutes} min</span>
      </div>
      <p style={{ margin: '0 0 10px', fontSize: ohm ? 15 : 13.5, color: '#6A5A4E', lineHeight: 1.55, fontFamily: "'DM Sans',sans-serif" }}>{displayOneLiner}</p>
      {activity.materials_display && <p style={{ margin: '0 0 10px', fontSize: 11.5, color: '#9A8070', fontFamily: "'DM Sans',sans-serif", fontStyle: 'italic' }}>You'll need: {activity.materials_display}</p>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <PrincipleTag principleId={activity.principle_id} small />
        {!voice.is_plain && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'rgba(180,155,115,0.12)', border: '1px solid rgba(180,155,115,0.3)', borderRadius: 20, padding: '2px 8px', fontSize: 10, color: '#A0845C', fontFamily: "'Crimson Pro',Georgia,serif", fontStyle: 'italic' }}>♛</span>}
      </div>
      <div style={{ marginTop: 12, fontSize: ohm ? 14 : 12, color: '#C8A97E', fontFamily: "'DM Sans',sans-serif", fontWeight: 500 }}>{cardCta}</div>
    </div>
  );
}

// ─── In-progress Banner ───────────────────────────────────────────────────────

function InProgressBanner({ inProgress, onResume, onDismiss }) {
  if (!inProgress) return null;
  const act = activities.find(a => a.id === inProgress.activity_id); if (!act) return null;
  return (
    <div style={{ background: 'rgba(200,169,126,0.09)', border: '1px solid rgba(200,169,126,0.28)', borderRadius: 14, padding: '11px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, animation: 'fadeIn 0.3s ease' }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#C8A97E', flexShrink: 0, animation: 'softPulse 2s ease-in-out infinite' }} />
      <button onClick={onResume} style={{ background: 'none', border: 'none', cursor: 'pointer', flex: 1, textAlign: 'left', padding: 0 }}>
        <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12.5, color: '#5A4A3E' }}>Still on <em style={{ fontFamily: "'Crimson Pro',Georgia,serif" }}>{act.plain.title}</em>? Pick up where you left off →</span>
      </button>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#C0B0A0', fontSize: 18, padding: '0 2px', lineHeight: 1 }}>×</button>
    </div>
  );
}

// ─── Saved-for-later nudge ────────────────────────────────────────────────────

function SavedNudge({ journey, onOpen }) {
  const saved = journey.filter(j => j.status === 'saved');
  if (!saved.length) return null;
  const item = saved[0];
  const act = activities.find(a => a.id === item.activity_id); if (!act) return null;
  return (
    <div onClick={() => onOpen(item)} style={{ background: 'rgba(139,175,142,0.08)', border: '1px solid rgba(139,175,142,0.28)', borderRadius: 14, padding: '11px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', animation: 'fadeIn 0.3s ease' }}>
      <span style={{ fontSize: 14 }}>🔖</span>
      <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12.5, color: '#5A4A3E', flex: 1 }}>
        You saved <em style={{ fontFamily: "'Crimson Pro',Georgia,serif" }}>{act.plain.title}</em> — give it a try?
      </span>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ opacity: 0.4, flexShrink: 0 }}><path d="M4 2l4 4-4 4" stroke="#5A4A3E" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
    </div>
  );
}

// ─── Journey components ───────────────────────────────────────────────────────

function JourneyEntry({ j, tint, babyName, onOpen }) {
  const act = activities.find(a => a.id === j.activity_id); if (!act) return null;
  const voice = resolveVoice(act, j.archetype_id_at_time || j.persona_id_at_time, babyName);
  const dateStr = new Date(j.completed_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const durStr = j.duration_seconds ? ` · ${Math.round(j.duration_seconds / 60)} min` : '';
  return (
    <div onClick={() => onOpen(j)} style={{ background: tint || 'rgba(255,255,255,0.7)', border: '1px solid rgba(200,185,165,0.25)', borderRadius: 16, padding: '13px 16px', marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', transition: 'box-shadow 0.15s' }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = '0 3px 14px rgba(160,140,120,0.12)'}
      onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 16, color: '#3A2E24', fontWeight: 600 }}>{voice.title}</div>
        <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: '#9A8070', marginTop: 2 }}>{j.status === 'saved' ? 'Saved for later' : `${dateStr}${durStr}${j.rating === 'loved' ? ' · ✦ loved' : ''}`}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 10 }}>
        <PrincipleTag principleId={act.principle_id} small />
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.35 }}><path d="M5 2l5 5-5 5" stroke="#7A6A5E" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </div>
    </div>
  );
}

function JourneySection({ label, items, tint, babyName, onOpen }) {
  if (!items.length) return null;
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 15, color: '#A0845C', margin: '0 0 12px', fontStyle: 'italic' }}>{label}</h3>
      {items.map(j => <JourneyEntry key={j.id} j={j} tint={tint} babyName={babyName} onOpen={onOpen} />)}
    </div>
  );
}

// ─── Explainer Screen ─────────────────────────────────────────────────────────

function ExplainerScreen({ onBack }) {
  const sections = [
    { title: 'This is an early alpha', body: 'Bloom is in early testing. The activities are grounded in the sources below, but the formal clinical review described here is still in progress — not yet complete. Please treat everything as a work in progress and use your own judgement.', isNote: true },
    { title: 'Built on five developmental areas', body: 'Every play idea in Bloom is built on the same five developmental areas — motor, sensory, language, cognitive, and social-emotional. Within each, we use principles drawn from current Australian and UK guidance.' },
    { title: 'Our main sources', isList: true, items: ['Raising Children Network (Australia) — our primary source', 'NHS Start for Life (UK)', 'Early Years Learning Framework (Australia)', 'Red Nose Australia — safe sleep and supervision', 'Royal Children\'s Hospital Melbourne', 'Speech and Language UK', 'National Literacy Trust', 'BBC Tiny Happy People'], body: 'Where Australian guidance leads, we cite it first. UK guidance fills in where Australian sources don\'t cover a specific principle. Where foundational research comes from elsewhere — including the United States — we cite it openly.' },
    { title: 'How activities are written', body: 'Every activity is hand-authored against the sources above. We don\'t generate activity content with AI in real time. Before public launch, the library will be reviewed by an Australian-registered paediatric professional — that review is part of getting Bloom out of alpha. When you give your baby a nickname and pick a voice, we use AI to lightly reword the activity titles and prompts so the name reads naturally. The step-by-step instructions are never AI-generated — those stay exactly as written and reviewed. You can turn this off any time in Settings.' },
    { title: 'A living library', body: 'Australian and UK guidance updates over time, and so will we. Source links and review dates are still being finalised during alpha.' },
    { title: 'What this app is not', body: 'Bloom isn\'t medical advice and isn\'t a developmental tracker. If you have concerns about your baby\'s development, speak with your maternal child health nurse or GP.', isNote: true },
  ];
  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(160deg,#FDF6ED 0%,#F5EDE0 40%,#EDE4D8 100%)' }}>
      <div style={{ maxWidth: 480, margin: '0 auto', padding: '14px 22px 80px' }}>
        <div style={{ marginBottom: 28 }}>
          <BackButton onBack={onBack} label="Settings" />
          <h1 style={{ margin: '16px 0 4px', fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 26, fontWeight: 600, color: '#3A2E24' }}>How activities are made</h1>
          <p style={{ margin: 0, fontSize: 13, color: '#9A8070', fontFamily: "'DM Sans',sans-serif" }}>What's behind every suggestion.</p>
        </div>
        {sections.map((s, i) => (
          <div key={i} style={{ ...cardBox }}>
            <h3 style={{ margin: '0 0 10px', fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 18, color: '#3A2E24', fontWeight: 600 }}>{s.title}</h3>
            {s.isList && <ul style={{ margin: '0 0 12px', paddingLeft: 18 }}>{s.items.map((item, j) => <li key={j} style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13.5, color: '#5A4A3E', lineHeight: 1.65, marginBottom: 4 }}>{item}</li>)}</ul>}
            <p style={{ margin: 0, fontFamily: "'DM Sans',sans-serif", fontSize: 13.5, color: s.isNote ? '#9A8070' : '#5A4A3E', lineHeight: 1.65, fontStyle: s.isNote ? 'italic' : 'normal' }}>{s.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Settings Screen ──────────────────────────────────────────────────────────

function SettingsScreen({ profile, apiKey, ohm, nicknameOn, onSave, onSaveApiKey, onToggleOhm, onToggleNickname, onBack, onShowExplainer }) {
  const [babyName, setBabyName] = useState(profile?.babyName || '');
  const [petName, setPetName] = useState(profile?.petName || '');
  const [archetype, setArchetype] = useState(profile?.archetype || ARCHETYPES.PLAIN);
  const [dob, setDob] = useState(profile?.dob || '');
  const [localApiKey, setLocalApiKey] = useState(apiKey || '');
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState(null);
  const suggestions = archetypes.find(a => a.id === ARCHETYPES.ROYAL_COURT)?.pet_name_suggestions ?? [];
  const icons = { royal_court:'♛', tiny_tyrant:'◈', little_creature:'❋', feral_goblin:'⚡', field_researcher:'◉', plain:'○' };

  const testConnection = async () => {
    if (!localApiKey.trim()) { setTestStatus('fail'); return; }
    setTestStatus('testing');
    try { const r = await callClassifierAPI('Tiny Possum', localApiKey.trim()); setTestStatus(r?.archetype ? 'ok' : 'fail'); }
    catch { setTestStatus('fail'); }
  };

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(160deg,#FDF6ED 0%,#F5EDE0 40%,#EDE4D8 100%)' }}>
      <div style={{ maxWidth: 480, margin: '0 auto', padding: '14px 22px 80px' }}>
        <div style={{ marginBottom: 28 }}>
          <BackButton onBack={onBack} label="Today" />
          <h1 style={{ margin: '16px 0 4px', fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 26, fontWeight: 600, color: '#3A2E24' }}>Settings</h1>
          <p style={{ margin: 0, fontSize: 13, color: '#9A8070', fontFamily: "'DM Sans',sans-serif" }}>Your details and preferences.</p>
        </div>

        <div style={{ ...cardBox }}>
          <div style={{ ...secLabel }}>Baby</div>
          <label style={labelSt}>Date of birth</label>
          {/* type=date renders DD/MM/YYYY on AU/UK devices natively */}
          <input type="date" value={dob} onChange={e => setDob(e.target.value)} style={inputSt} />
          <label style={labelSt}>Baby's name <span style={{ color: '#B8A898', fontSize: 11 }}>optional</span></label>
          <input placeholder="e.g. Arthur" value={babyName} onChange={e => setBabyName(e.target.value)} style={inputSt} />
          <label style={labelSt}>What do you call them? <span style={{ color: '#B8A898', fontSize: 11 }}>optional</span></label>
          <input placeholder="e.g. Little Possum, The Boss…" value={petName} onChange={e => setPetName(e.target.value)} style={inputSt} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 10 }}>
            {suggestions.slice(0, 4).map(s => <button key={s} onClick={() => setPetName(s)} style={{ padding: '5px 12px', background: petName === s ? 'rgba(200,169,126,0.2)' : 'white', border: `1px solid ${petName === s ? 'rgba(200,169,126,0.5)' : 'rgba(200,185,165,0.35)'}`, borderRadius: 20, fontSize: 12, color: '#5A4A3E', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>{s}</button>)}
          </div>
        </div>

        {/* One Hand Mode toggle */}
        <div style={{ ...cardBox }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 14, color: '#3A2E24', fontWeight: 500 }}>One Hand Mode</div>
              <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: '#9A8070', marginTop: 2 }}>Larger text and controls for 3am ease</div>
            </div>
            <button onClick={onToggleOhm} style={{ width: 44, height: 26, borderRadius: 13, background: ohm ? '#C8A97E' : '#D0C0B0', border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.2s' }}>
              <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'white', position: 'absolute', top: 3, left: ohm ? 21 : 3, transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
            </button>
          </div>
        </div>

        {/* Nickname toggle — only shown when a name/nickname exists */}
        {(babyName.trim() || petName.trim()) && (
          <div style={{ ...cardBox }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ flex: 1, paddingRight: 12 }}>
                <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 14, color: '#3A2E24', fontWeight: 500 }}>Use baby's nickname</div>
                <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: '#9A8070', marginTop: 2 }}>Weave their name into activities. Off uses each voice's title instead (e.g. 'Your Highness').</div>
              </div>
              <button onClick={onToggleNickname} style={{ width: 44, height: 26, borderRadius: 13, background: nicknameOn ? '#C8A97E' : '#D0C0B0', border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'white', position: 'absolute', top: 3, left: nicknameOn ? 21 : 3, transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
              </button>
            </div>
          </div>
        )}

        <div style={{ ...cardBox }}>
          <div style={{ ...secLabel }}>Voice</div>
          <p style={{ margin: '0 0 14px', fontSize: 13, color: '#7A6A5E', fontFamily: "'DM Sans',sans-serif" }}>Choose how activities are described to you.</p>
          {archetypes.filter(a => a.status === 'active')
            .sort((a, b) => Number(isVoiceReady(b.id)) - Number(isVoiceReady(a.id)))
            .map(a => {
            const ready = isVoiceReady(a.id);
            return (
            <div key={a.id} onClick={ready ? () => setArchetype(a.id) : undefined} style={{ background: archetype === a.id ? 'rgba(200,169,126,0.12)' : 'white', border: `1.5px solid ${archetype === a.id ? 'rgba(200,169,126,0.5)' : 'rgba(200,185,165,0.25)'}`, borderRadius: 14, padding: '11px 14px', marginBottom: 8, cursor: ready ? 'pointer' : 'default', opacity: ready ? 1 : 0.6, transition: 'all 0.15s', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div><div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}><span style={{ fontSize: 13, color: '#C8A97E' }}>{icons[a.id]}</span><span style={{ fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 15, color: '#3A2E24', fontWeight: 600 }}>{a.display_name}</span>{!ready && <ComingSoonPill />}</div><p style={{ margin: 0, fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: '#7A6A5E' }}>{a.short_description}</p></div>
              {ready && <div style={{ width: 17, height: 17, borderRadius: '50%', border: `2px solid ${archetype === a.id ? '#C8A97E' : '#D0C0B0'}`, background: archetype === a.id ? '#C8A97E' : 'transparent', transition: 'all 0.15s', flexShrink: 0, marginLeft: 12 }} />}
            </div>
            );
          })}
        </div>

        <div style={{ ...cardBox, marginBottom: 14 }}>
          <div style={{ ...secLabel }}>About Bloom</div>
          <button onClick={onShowExplainer} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div><div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 14, color: '#3A2E24', fontWeight: 500 }}>How activities are made</div><div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: '#9A8070', marginTop: 2 }}>Sources, review process, what this app is not</div></div>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.4, flexShrink: 0 }}><path d="M5 2l5 5-5 5" stroke="#7A6A5E" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        </div>

        <div style={{ ...cardBox, marginBottom: 24, background: 'rgba(245,240,232,0.6)', border: '1px dashed rgba(200,185,165,0.4)' }}>
          <div style={{ ...secLabel, color: '#B8A898' }}>Developer settings — prototype only</div>
          <p style={{ margin: '0 0 12px', fontSize: 12, color: '#B8A898', fontFamily: "'DM Sans',sans-serif", lineHeight: 1.5 }}>The API key is stored only on this device and used for the nickname classification feature.</p>
          <label style={{ ...labelSt, marginTop: 0 }}>AI API key</label>
          <div style={{ position: 'relative' }}>
            <input type={showKey ? 'text' : 'password'} placeholder="Paste your API key here" value={localApiKey} onChange={e => setLocalApiKey(e.target.value)} style={{ ...inputSt, paddingRight: 60 }} />
            <button onClick={() => setShowKey(s => !s)} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#A0845C', fontFamily: "'DM Sans',sans-serif" }}>{showKey ? 'Hide' : 'Show'}</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <button onClick={testConnection} disabled={testStatus === 'testing'} style={{ padding: '8px 16px', background: 'rgba(200,169,126,0.15)', border: '1px solid rgba(200,169,126,0.3)', borderRadius: 10, fontSize: 12.5, color: '#A0845C', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>{testStatus === 'testing' ? 'Testing…' : 'Test connection'}</button>
            {testStatus === 'ok'   && <span style={{ fontSize: 12, color: '#8BAF8E', fontFamily: "'DM Sans',sans-serif" }}>✓ Connected</span>}
            {testStatus === 'fail' && <span style={{ fontSize: 12, color: '#C48B8B', fontFamily: "'DM Sans',sans-serif" }}>✗ Check your key</span>}
          </div>
        </div>

        <button onClick={() => { onSaveApiKey(localApiKey.trim()); onSave({ ...profile, babyName, petName, archetype, dob }); }} style={{ width: '100%', padding: '15px', background: '#C8A97E', border: 'none', borderRadius: 16, fontSize: 16, color: 'white', fontFamily: "'Crimson Pro',Georgia,serif", fontWeight: 600, cursor: 'pointer' }}>Save changes</button>
      </div>
    </div>
  );
}

// ─── Onboarding ───────────────────────────────────────────────────────────────

function OnboardingScreen({ onComplete, apiKey }) {
  const [step, setStep] = useState(0);
  const [babyName, setBabyName] = useState('');
  const [petName, setPetName] = useState('');
  const [dob, setDob] = useState('');
  const [archetype, setArchetype] = useState(ARCHETYPES.PLAIN);
  const [classifying, setClassifying] = useState(false);
  const [classResult, setClassResult] = useState(null);
  const [showManualPicker, setShowManualPicker] = useState(false);
  const suggestions = archetypes.find(a => a.id === ARCHETYPES.ROYAL_COURT)?.pet_name_suggestions ?? [];

  const runClassification = async () => {
    if (!petName.trim()) { setStep(3); return; }
    setClassifying(true);
    try {
      const result = apiKey ? await callClassifierAPI(petName, apiKey) : classifyNicknameLocally(petName);
      setClassResult(result); setStep(3);
    } catch { setClassResult(classifyNicknameLocally(petName)); setStep(3); }
    finally { setClassifying(false); }
  };

  const handleArchetypeAccept = id => { setArchetype(id); setStep(4); };

  const steps = [
    <div key="0" style={{ animation: 'fadeIn 0.4s ease' }}>
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}><BloomMark size={40} /></div>
        <h1 style={{ fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 32, fontWeight: 600, color: '#3A2E24', margin: '0 0 8px' }}>Bloom</h1>
        <p style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 14, color: '#7A6A5E', margin: 0, lineHeight: 1.6 }}>Activity ideas for you and your baby,<br />whenever you need them.</p>
      </div>
      <label style={labelSt}>Baby's name <span style={{ color: '#B8A898', fontSize: 11 }}>optional</span></label>
      <input placeholder="e.g. Arthur" value={babyName} onChange={e => setBabyName(e.target.value)} style={inputSt} />
      <label style={labelSt}>Baby's date of birth <span style={{ color: '#C8A97E' }}>*</span></label>
      <input type="date" value={dob} onChange={e => setDob(e.target.value)} style={inputSt} />
      <button onClick={() => dob && setStep(1)} style={{ ...btnPri, opacity: dob ? 1 : 0.45, marginTop: 20 }}>Continue</button>
    </div>,

    <div key="1" style={{ animation: 'fadeIn 0.4s ease' }}>
      <h2 style={sHead}>What do you call your baby?</h2>
      <p style={sSub}>Optional — just for a bit of fun with certain features.</p>
      <input placeholder="e.g. King Arthur, Little Possum, The Boss..." value={petName} onChange={e => setPetName(e.target.value)} style={inputSt} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '10px 0 24px' }}>
        {suggestions.slice(0, 4).map(s => <button key={s} onClick={() => setPetName(s)} style={{ padding: '6px 12px', background: petName === s ? 'rgba(200,169,126,0.2)' : 'white', border: `1px solid ${petName === s ? 'rgba(200,169,126,0.5)' : 'rgba(200,185,165,0.35)'}`, borderRadius: 20, fontSize: 12, color: '#5A4A3E', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>{s}</button>)}
      </div>
      <button onClick={() => setStep(2)} style={btnPri}>Continue</button>
      <button onClick={() => setStep(2)} style={btnSkp}>Skip for now</button>
    </div>,

    <div key="2" style={{ animation: 'fadeIn 0.4s ease' }}>
      <h2 style={sHead}>Want to make it a bit more fun?</h2>
      <p style={sSub}>Give activities a playful spin based on your baby's vibe. You can change this any time.</p>
      <button onClick={() => { petName.trim() ? runClassification() : setStep(3); }} style={btnPri}>{classifying ? 'Working it out…' : petName.trim() ? `Find a voice for ${petName}` : 'Choose a voice'}</button>
      <button onClick={() => { setArchetype(ARCHETYPES.PLAIN); setStep(4); }} style={btnSkp}>Keep it plain</button>
    </div>,

    <div key="3" style={{ animation: 'fadeIn 0.4s ease' }}>
      {classResult
        ? <ClassificationResult result={classResult} nickname={petName} onAccept={handleArchetypeAccept} onPickManually={() => setShowManualPicker(true)} />
        : <div><h2 style={sHead}>Choose a voice</h2><ArchetypePickerList onSelect={handleArchetypeAccept} onSkip={() => handleArchetypeAccept(ARCHETYPES.PLAIN)} /></div>
      }
      {showManualPicker && <div style={{ marginTop: 24 }}><h3 style={{ fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 18, color: '#3A2E24', margin: '0 0 12px' }}>Pick a different vibe</h3><ArchetypePickerList onSelect={handleArchetypeAccept} onSkip={() => handleArchetypeAccept(ARCHETYPES.PLAIN)} /></div>}
    </div>,

    <div key="4" style={{ animation: 'fadeIn 0.4s ease', textAlign: 'center' }}>
      <div style={{ fontSize: 40, marginBottom: 16 }}>✦</div>
      <h2 style={{ ...sHead, textAlign: 'center' }}>{babyName ? `All set — let's meet ${babyName.split(' ')[0]}!` : 'All set!'}</h2>
      <p style={{ ...sSub, textAlign: 'center' }}>{archetype !== ARCHETYPES.PLAIN ? `Activities will be described in the ${getArchetype(archetype)?.display_name} voice. You can always change this in Settings.` : 'Ready when you are.'}</p>
      <button onClick={() => onComplete({ babyName, petName, dob, archetype })} style={btnPri}>Start exploring</button>
    </div>,
  ];

  return (
    <div style={{ padding: '48px 26px 32px', maxWidth: 420, margin: '0 auto' }}>
      {step > 0 && step < 4 && <button onClick={() => setStep(s => Math.max(0, s-1))} style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: '#A0845C', padding: 0, marginBottom: 28, display: 'flex', alignItems: 'center', gap: 4 }}>← Back</button>}
      {steps[step]}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginTop: 32 }}>
        {[0,1,2,3,4].map(i => <div key={i} style={{ width: i === step ? 20 : 6, height: 6, borderRadius: 3, background: i === step ? '#C8A97E' : i < step ? 'rgba(200,169,126,0.4)' : '#E2D8CE', transition: 'all 0.25s' }} />)}
      </div>
    </div>
  );
}

// ─── Principles Tab ───────────────────────────────────────────────────────────

function PrinciplesTab() {
  const [expandedId, setExpandedId] = useState(null);
  const domainOrder = ['motor','sensory','language','cognitive','social_emotional'];
  const domainLabels = { motor:'Motor Development', sensory:'Sensory Exploration', language:'Language & Communication', cognitive:'Cognitive Development', social_emotional:'Social-Emotional Development' };
  return (
    <div style={{ paddingBottom: 24 }}>
      {domainOrder.map(domain => {
        const domainPrinciples = principles.filter(p => p.domain === domain);
        if (!domainPrinciples.length) return null;
        const color = DOMAIN_COLOURS[domain];
        return (
          <div key={domain} style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: `${color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>{DOMAIN_ICONS[domain]}</div>
              <span style={{ fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 16, color: '#3A2E24', fontWeight: 600 }}>{domainLabels[domain]}</span>
            </div>
            {domainPrinciples.map(p => (
              <div key={p.id} onClick={() => setExpandedId(expandedId === p.id ? null : p.id)} style={{ background: 'rgba(255,255,255,0.65)', border: '1px solid rgba(200,185,165,0.22)', borderRadius: 14, padding: '12px 16px', marginBottom: 8, cursor: 'pointer', borderLeft: `3px solid ${color}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 14, color: '#3A2E24', fontWeight: 500 }}>{p.display_name}</div>
                  <span style={{ fontSize: 10, color: '#B8A898', fontFamily: "'DM Sans',sans-serif", flexShrink: 0, marginLeft: 8 }}>{p.age_band}</span>
                </div>
                {expandedId === p.id && <p style={{ margin: '8px 0 0', fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: '#6A5A4E', lineHeight: 1.6, borderTop: '1px solid rgba(200,185,165,0.2)', paddingTop: 8 }}>{p.full_description || p.short_description}</p>}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────

export default function BloomApp() {
  // ── Persistence helpers ──────────────────────────────────────────────────
  function load(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }

  const [screen, setScreen]           = useState(() => load('bloom_screen', 'onboarding'));
  const [profile, setProfile]         = useState(() => load('bloom_profile', null));
  const [apiKey, setApiKey]           = useState(() => load('bloom_apikey', ''));
  const [cards, setCards]             = useState([]);
  const [journey, setJourney]         = useState(() => load('bloom_journey', []));
  const [filters, setFilters]         = useState(() => load('bloom_filters', {}));
  const [activePreset, setActivePreset] = useState(() => load('bloom_preset', null));
  const [ohm, setOhm]                 = useState(() => load('bloom_ohm', false));
  const [nicknameOn, setNicknameOn]   = useState(() => load('bloom_nickname_on', true));
  // Bump this to trigger re-render of activity cards after a rewrite lands
  const [rewriteVer, setRewriteVer]   = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [showArchetypeSwitcher, setShowArchetypeSwitcher] = useState(false);
  // One-time voice badge hint — shown until dismissed or badge tapped
  const [showVoiceHint, setShowVoiceHint] = useState(() => load('bloom_voicehint', true));

  useEffect(() => { save('bloom_profile', profile); }, [profile]);
  useEffect(() => { save('bloom_journey', journey); }, [journey]);
  useEffect(() => { save('bloom_apikey', apiKey); }, [apiKey]);
  useEffect(() => { save('bloom_filters', filters); }, [filters]);
  useEffect(() => { save('bloom_preset', activePreset); }, [activePreset]);
  useEffect(() => { save('bloom_ohm', ohm); }, [ohm]);
  useEffect(() => { save('bloom_nickname_on', nicknameOn); }, [nicknameOn]);
  useEffect(() => { if (screen !== 'onboarding') save('bloom_screen', screen); }, [screen]);

  const babyAge = ageWeeks(profile?.dob);

  // Profile migration v2: drop the old ambiguous profile.name (was collected as parent name).
  // Run once, gated by profile.v. Discards profile.name — do NOT copy to babyName.
  useEffect(() => {
    if (profile && profile.v !== 2) {
      const { name: _dropped, v: _oldV, ...rest } = profile;
      const migrated = { ...rest, v: 2 };
      setProfile(migrated);
    }
  }, []); // eslint-disable-line

  // Sweep stale rewrite cache entries on mount (wrong nickname hash or old schema version)
  useEffect(() => {
    const nick = profile ? effectiveName(profile, true) : '';
    sweepRewriteCache(nick);
  }, []); // eslint-disable-line

  // Build card set helper — threads journey + age into scoring
  const buildCards = useCallback((exclude = []) => {
    return getScoredSet(exclude, filters, activePreset, journey, babyAge);
  }, [filters, activePreset, journey, babyAge]); // eslint-disable-line

  // Restore cards on mount if profile exists
  useEffect(() => {
    if (profile && cards.length === 0) setCards(buildCards());
  }, []); // eslint-disable-line

  const [activeActivity, setActiveActivity]               = useState(null);
  const [activityEntryPoint, setActivityEntryPoint]       = useState('today');
  const [activityResumeElapsed, setActivityResumeElapsed] = useState(0);
  const [activityIsRepeat, setActivityIsRepeat]           = useState(false);
  const [activityArchetypeOverride, setActivityArchetypeOverride] = useState(null);
  const [inProgress, setInProgress]   = useState(() => load('bloom_inprogress', null));
  useEffect(() => { save('bloom_inprogress', inProgress); }, [inProgress]); // eslint-disable-line
  const [bloomPulse, setBloomPulse]   = useState(false);
  const [postBeat, setPostBeat]       = useState(null); // { rating }
  const justCompleted = useRef(false);

  const archetypeId = profile?.archetype || ARCHETYPES.PLAIN;
  const filterCount = activePreset
    ? Object.values(MOMENT_PRESETS.find(p => p.id === activePreset)?.filters || {}).flat().length
    : Object.values(filters).flat().length;

  const handleOnboardComplete = p => {
    debug.log('onboard', `archetype=${p.archetype}`);
    track('voice_selected', { archetype: p.archetype, context: 'onboarding' });
    setProfile(p); setCards(getScoredSet([], {}, null, [], ageWeeks(p.dob))); setScreen('home');
    save('bloom_screen', 'home');
  };

  const openActivity = (activity, entryPoint = 'today', resumeElapsed = 0, archetypeOverride = null, isRepeat = false) => {
    track('activity_opened', { activity_id: activity.id, archetype: archetypeOverride || archetypeId, entry: entryPoint });
    setActiveActivity(activity); setActivityEntryPoint(entryPoint);
    setActivityResumeElapsed(resumeElapsed); setActivityArchetypeOverride(archetypeOverride);
    setActivityIsRepeat(isRepeat); setScreen('activity');
    if (entryPoint === 'today') setInProgress({ activity_id: activity.id, elapsed_seconds: resumeElapsed || 0 });
  };

  const openJourneyActivity = j => {
    const act = activities.find(a => a.id === j.activity_id); if (!act) return;
    openActivity(act, 'journey', 0, j.archetype_id_at_time || j.persona_id_at_time || archetypeId, true);
  };

  const closeActivity = useCallback(() => {
    setScreen('home'); setActiveActivity(null); setActivityArchetypeOverride(null); setActivityIsRepeat(false);
    if (justCompleted.current) { justCompleted.current = false; setBloomPulse(true); setTimeout(() => setBloomPulse(false), 700); }
  }, []);

  const handleComplete = (rating, durationSeconds) => {
    if (!activeActivity) return;
    debug.log('complete', `${activeActivity.id} rating=${rating}`);
    track('activity_completed', { activity_id: activeActivity.id, archetype: activityArchetypeOverride || archetypeId, rating, duration_seconds: durationSeconds });
    const entry = { id: Date.now(), activity_id: activeActivity.id, activity_version: activeActivity.version ?? 1, archetype_id_at_time: activityArchetypeOverride || archetypeId, persona_id_at_time: activityArchetypeOverride || archetypeId, completed_at: new Date().toISOString(), rating, status: 'completed', duration_seconds: durationSeconds > 0 ? durationSeconds : null };
    setJourney(j => [entry, ...j]);
    setInProgress(null);
    justCompleted.current = true;
    // Show the "one more" beat before going back
    setPostBeat({ rating, completedActivity: activeActivity });
  };

  const handleSaveForLater = activity => {
    setJourney(j => [{ id: Date.now(), activity_id: activity.id, activity_version: activity.version ?? 1, archetype_id_at_time: archetypeId, persona_id_at_time: archetypeId, completed_at: new Date().toISOString(), rating: null, status: 'saved', duration_seconds: null }, ...j]);
    closeActivity();
  };

  const handleShowAnother = () => {
    track('show_another', { archetype: archetypeId });
    setPostBeat(null);
    const currentIds = cards.map(c => c?.activity?.id).filter(Boolean);
    const surprise = getSurpriseActivity(currentIds, filters, activePreset, journey, babyAge);
    if (surprise) openActivity(surprise.activity, 'today');
    else closeActivity();
  };

  const handleSurprise = () => {
    track('surprise_me', { archetype: archetypeId });
    const currentIds = cards.map(c => c?.activity?.id).filter(Boolean);
    const surprise = getSurpriseActivity(currentIds, filters, activePreset, journey, babyAge);
    if (surprise) openActivity(surprise.activity, 'today');
  };

  const rhythmLine = profile ? getDailyRhythmLine(journey, profile) : null;

  const dismissVoiceHint = () => { setShowVoiceHint(false); save('bloom_voicehint', false); };

  // Full-screen takeovers
  if (screen === 'activity' && activeActivity) return (
    <>
      <style>{globalStyles}</style>
      <ActivityScreen
        activity={activeActivity} archetypeId={activityArchetypeOverride || archetypeId} babyName={effectiveName(profile, nicknameOn)}
        entryPoint={activityEntryPoint} resumeElapsed={activityResumeElapsed}
        onBack={closeActivity} backLabel={activityEntryPoint === 'journey' ? 'Journey' : 'Today'}
        onComplete={handleComplete} onSaveForLater={handleSaveForLater}
        isRepeat={activityIsRepeat} ohm={ohm}
        nicknameOn={nicknameOn} apiKey={apiKey} onRewriteLanded={() => setRewriteVer(v => v+1)}
      />
      {postBeat && <PostActivityBeat rating={postBeat.rating} onShowAnother={handleShowAnother} onBack={() => { setPostBeat(null); closeActivity(); }} />}
    </>
  );

  if (screen === 'settings') return (
    <>
      <style>{globalStyles}</style>
      <SettingsScreen
        profile={profile} apiKey={apiKey} ohm={ohm} nicknameOn={nicknameOn}
        onSave={p => { setProfile(p); setScreen('home'); }}
        onSaveApiKey={setApiKey}
        onToggleOhm={() => setOhm(o => !o)}
        onToggleNickname={() => setNicknameOn(v => !v)}
        onBack={() => setScreen('home')}
        onShowExplainer={() => setScreen('explainer')}
      />
    </>
  );
  if (screen === 'explainer') return <><style>{globalStyles}</style><ExplainerScreen onBack={() => setScreen('settings')} /></>;
  if (screen === 'onboarding') return <div style={{ minHeight: '100vh', background: 'linear-gradient(160deg,#FDF6ED 0%,#F5EDE0 40%,#EDE4D8 100%)' }}><style>{globalStyles}</style><OnboardingScreen onComplete={handleOnboardComplete} apiKey={apiKey} /></div>;

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(160deg,#FDF6ED 0%,#F5EDE0 40%,#EDE4D8 100%)', fontFamily: "'DM Sans',sans-serif", position: 'relative' }}>
      <style>{globalStyles}</style>
      <div style={{ position: 'fixed', top: -80, right: -60, width: 260, height: 260, borderRadius: '50%', background: 'radial-gradient(circle,rgba(200,169,126,0.12) 0%,transparent 70%)', pointerEvents: 'none' }} />
      <div style={{ position: 'fixed', bottom: 80, left: -80, width: 300, height: 300, borderRadius: '50%', background: 'radial-gradient(circle,rgba(139,175,142,0.10) 0%,transparent 70%)', pointerEvents: 'none' }} />

      <div style={{ maxWidth: 480, margin: '0 auto', display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        {/* Top bar */}
        <div style={{ padding: ohm ? '18px 20px 0' : '14px 20px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <BloomMark pulse={bloomPulse} />
            <span style={{ fontFamily: "'Crimson Pro',Georgia,serif", fontSize: ohm ? 24 : 20, fontWeight: 600, color: '#3A2E24' }}>Bloom</span>
            {ohm && <span style={{ fontSize: 10, color: '#C8A97E', fontFamily: "'DM Sans',sans-serif", background: 'rgba(200,169,126,0.12)', border: '1px solid rgba(200,169,126,0.3)', borderRadius: 10, padding: '2px 7px' }}>One Hand</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => setScreen('settings')} style={{ background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(200,185,165,0.3)', borderRadius: 20, padding: ohm ? '6px 16px' : '4px 12px', fontSize: ohm ? 14 : 12, color: '#7A6A5E', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", display: 'flex', alignItems: 'center', gap: 5 }}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="2" stroke="#7A6A5E" strokeWidth="1.4"/><path d="M6.5 1v1.5M6.5 10.5V12M1 6.5h1.5M10.5 6.5H12M2.64 2.64l1.06 1.06M9.3 9.3l1.06 1.06M9.3 3.7L8.24 4.76M3.7 9.3L2.64 10.36" stroke="#7A6A5E" strokeWidth="1.3" strokeLinecap="round"/></svg>
              Settings
            </button>
            <ArchetypeBadge
              archetypeId={archetypeId}
              onPress={() => { dismissVoiceHint(); setShowArchetypeSwitcher(true); track('voice_badge_tapped', { archetype: archetypeId }); }}
              small
              showHint={showVoiceHint && archetypeId !== ARCHETYPES.PLAIN && screen === 'home'}
            />
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, padding: ohm ? '20px 16px 100px' : '18px 22px 90px', overflowY: 'auto' }}>

          {screen === 'home' && <>
            <div style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontFamily: "'Crimson Pro',Georgia,serif", fontSize: ohm ? 26 : 22, color: '#3A2E24', fontWeight: 600 }}>{babyLabel(profile) ? `What to do with ${babyLabel(profile)}` : 'What to do right now'}</h2>
              {rhythmLine && <p style={{ margin: '5px 0 0', fontSize: 13, color: '#9A8070', fontStyle: 'italic', fontFamily: "'Crimson Pro',Georgia,serif", lineHeight: 1.5 }}>{rhythmLine}</p>}
            </div>

            {/* Filters row + Surprise me */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 1 }}>
                <button onClick={() => setShowFilters(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: ohm ? '10px 18px' : '7px 14px', background: filterCount > 0 ? '#C8A97E' : 'rgba(255,255,255,0.65)', border: `1px solid ${filterCount > 0 ? '#C8A97E' : 'rgba(200,185,165,0.3)'}`, borderRadius: 20, fontSize: ohm ? 14 : 12.5, color: filterCount > 0 ? 'white' : '#6A5A4E', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", whiteSpace: 'nowrap', transition: 'all 0.15s' }}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 2h10M3 6h6M5 10h2" stroke={filterCount > 0 ? 'white' : '#6A5A4E'} strokeWidth="1.5" strokeLinecap="round"/></svg>
                  {activePreset ? MOMENT_PRESETS.find(p => p.id === activePreset)?.label : filterCount > 0 ? `${filterCount} filter${filterCount !== 1 ? 's' : ''}` : 'Filters'}
                </button>
                {filterCount > 0 && !activePreset && Object.values(filters).flat().slice(0, 2).map(f => <span key={f} style={{ fontSize: 11, color: '#A0845C', background: 'rgba(200,169,126,0.12)', border: '1px solid rgba(200,169,126,0.25)', borderRadius: 20, padding: '2px 8px', fontFamily: "'DM Sans',sans-serif" }}>{f}</span>)}
              </div>
              {/* Surprise me — visually lighter than a primary CTA */}
              <button onClick={handleSurprise} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: ohm ? '10px 18px' : '7px 14px', background: 'rgba(255,255,255,0.65)', border: '1px solid rgba(200,185,165,0.35)', borderRadius: 20, fontSize: ohm ? 14 : 12.5, color: '#7A6A5E', cursor: 'pointer', fontFamily: "'Crimson Pro',Georgia,serif", fontStyle: 'italic', whiteSpace: 'nowrap' }}>
                ✱ Surprise me
              </button>
            </div>

            <InProgressBanner inProgress={inProgress} onResume={() => { const a = activities.find(x => x.id === inProgress?.activity_id); if (a) openActivity(a, 'today', inProgress.elapsed_seconds||0); }} onDismiss={() => setInProgress(null)} />
            <SavedNudge journey={journey} onOpen={openJourneyActivity} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: ohm ? 16 : 14, marginBottom: 16 }}>
              {cards.map((scored, i) => scored && (
                <ActivityCard key={scored.activity.id+'-'+i} scored={scored} archetypeId={archetypeId} babyName={effectiveName(profile, nicknameOn)} onOpen={a => openActivity(a,'today')} index={i} journey={journey} ohm={ohm} rewriteVer={rewriteVer} nicknameOn={nicknameOn} apiKey={apiKey} onRewriteLanded={() => setRewriteVer(v => v+1)} />
              ))}
            </div>

            <button onClick={() => { track('refresh_cards', { archetype: archetypeId }); setCards(buildCards(cards.map(c => c?.activity?.id).filter(Boolean))); }} style={{ width: '100%', padding: ohm ? '14px' : '12px', background: 'rgba(255,255,255,0.55)', border: '1px solid rgba(200,185,165,0.3)', borderRadius: 14, fontSize: ohm ? 15 : 13.5, color: '#7A6A5E', fontFamily: "'DM Sans',sans-serif", cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>↻ Show me different ones</button>
          </>}

          {screen === 'journey' && <>
            <div style={{ marginBottom: 22 }}>
              <h2 style={{ margin: 0, fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 22, color: '#3A2E24', fontWeight: 600 }}>{babyPossessive(profile)} Journey</h2>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: '#9A8070' }}>Tap any activity to do it again.</p>
            </div>
            {journey.length === 0 ? (
              <div style={{ padding: '40px 0', textAlign: 'center' }}>
                <div style={{ fontSize: 32, marginBottom: 16 }}>✦</div>
                <h3 style={{ fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 20, color: '#3A2E24', margin: '0 0 8px' }}>Your journey starts here</h3>
                <p style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 14, color: '#7A6A5E', lineHeight: 1.6 }}>Activities you try will appear here.</p>
              </div>
            ) : (
              <div style={{ paddingBottom: 24 }}>
                <JourneySection label="Saved for later" items={journey.filter(j => j.status==='saved')} tint="rgba(200,169,126,0.07)" babyName={effectiveName(profile, nicknameOn)} onOpen={openJourneyActivity} />
                <JourneySection label="Favourites" items={journey.filter(j => j.status==='completed'&&j.rating==='loved')} babyName={effectiveName(profile, nicknameOn)} onOpen={openJourneyActivity} />
                <JourneySection label="Recent" items={journey.filter(j => j.status==='completed'&&j.rating!=='loved')} tint="rgba(255,255,255,0.55)" babyName={effectiveName(profile, nicknameOn)} onOpen={openJourneyActivity} />
              </div>
            )}
          </>}

          {screen === 'principles' && <>
            <div style={{ marginBottom: 22 }}>
              <h2 style={{ margin: 0, fontFamily: "'Crimson Pro',Georgia,serif", fontSize: 22, color: '#3A2E24', fontWeight: 600 }}>What we focus on</h2>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: '#9A8070' }}>Every activity traces back to one of these areas.</p>
            </div>
            <PrinciplesTab />
          </>}
        </div>

        {/* Bottom nav */}
        <div style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 480, background: 'rgba(253,246,237,0.93)', backdropFilter: 'blur(12px)', borderTop: '1px solid rgba(200,185,165,0.2)', display: 'flex', padding: ohm ? '14px 0 24px' : '10px 0 18px' }}>
          {[{id:'home',label:'Today',icon:'◎'},{id:'journey',label:'Journey',icon:'✦'},{id:'principles',label:'Principles',icon:'◈'}].map(tab => (
            <button key={tab.id} onClick={() => setScreen(tab.id)} style={{ flex: 1, background: 'none', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '6px 0' }}>
              <span style={{ fontSize: ohm ? 20 : 16, color: screen === tab.id ? '#C8A97E' : '#C0B0A0', transition: 'color 0.15s' }}>{tab.icon}</span>
              <span style={{ fontSize: ohm ? 13 : 11, fontFamily: "'DM Sans',sans-serif", color: screen === tab.id ? '#C8A97E' : '#A090806A', fontWeight: screen === tab.id ? 600 : 400, transition: 'color 0.15s' }}>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {showFilters && <FiltersModal filters={filters} activePreset={activePreset} onChange={f => setFilters(f)} onPresetChange={p => { setActivePreset(p); setCards(getScoredSet([], filters, p, journey, babyAge)); }} onClose={() => { setShowFilters(false); setCards(getScoredSet([], filters, activePreset, journey, babyAge)); }} />}
      {showArchetypeSwitcher && <ArchetypeSwitcher current={archetypeId} onSelect={id => { setProfile(p => ({ ...p, archetype: id })); track('voice_changed', { from: archetypeId, to: id }); }} onClose={() => setShowArchetypeSwitcher(false)} />}
      <DebugOverlay />
    </div>
  );
}

const globalStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,600;1,400;1,600&family=DM+Sans:wght@400;500;600&display=swap');
  * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-thumb { background: rgba(200,169,126,0.3); border-radius: 4px; }
  @keyframes fadeIn    { from { opacity:0 } to { opacity:1 } }
  @keyframes slideUp   { from { transform:translateY(40px); opacity:0 } to { transform:translateY(0); opacity:1 } }
  @keyframes cardIn    { from { transform:translateY(14px); opacity:0 } to { transform:translateY(0); opacity:1 } }
  @keyframes bloomPulse { 0%,100% { transform:scale(1) } 50% { transform:scale(1.09) } }
  @keyframes softPulse  { 0%,100% { opacity:1 } 50% { opacity:0.35 } }
  button:active { transform: scale(0.97) !important; transition: transform 0.1s !important; }
`;
