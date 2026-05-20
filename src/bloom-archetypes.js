// ─────────────────────────────────────────────────────────────────────────────
// bloom-archetypes.js
// DATA ONLY — no UI, no logic.
//
// TOKEN COST: ~1,600 tokens
// SHARE THIS FILE WHEN: adding/editing archetype metadata, classifier keywords,
//   preview samples, honorific templates, pet name suggestions.
// DO NOT share when working on: activities, UI, principles, scoring engine.
//
// Schema per entry:
//   id, display_name, short_description, personality_sketch,
//   honorific_templates{with_name, without_name},
//   pet_name_suggestions[], preview_sample, classifier_keywords[], status
// ─────────────────────────────────────────────────────────────────────────────

export const ARCHETYPES = {
  PLAIN: 'plain',
  ROYAL_COURT: 'royal_court',
  TINY_TYRANT: 'tiny_tyrant',
  LITTLE_CREATURE: 'little_creature',
  FERAL_GOBLIN: 'feral_goblin',
  FIELD_RESEARCHER: 'field_researcher',
};

export const archetypes = [
  { id: ARCHETYPES.PLAIN, display_name: 'Plain', short_description: 'Clear, warm, straightforward.', personality_sketch: 'No archetype. Activities described in plain, warm, practical language.', honorific_templates: { with_name: '{name}', without_name: 'your baby' }, pet_name_suggestions: [], preview_sample: null, classifier_keywords: [], status: 'active' },
  { id: ARCHETYPES.ROYAL_COURT, display_name: 'Royal Court', short_description: 'Regal proclamations for your tiny sovereign.', personality_sketch: 'Mock-formal courtly language. The baby is a monarch; all activities are royal engagements.', honorific_templates: { with_name: '{name}', without_name: 'His or Her Lordship' }, pet_name_suggestions: ['King Arthur','Lord Reginald','Lady Beatrice','Queen Cordelia','His Tiny Highness','The Sovereign'], preview_sample: 'The Royal Tummy Audience — presenting the heir to the chest-throne of the realm.', classifier_keywords: ['king','queen','lord','lady','royal','majesty','prince','princess','sovereign','duke','duchess','sir','dame'], status: 'active' },
  { id: ARCHETYPES.TINY_TYRANT, display_name: 'Tiny Tyrant', short_description: 'Mock-bureaucratic dispatches from a very demanding boss.', personality_sketch: 'The baby is an exacting CEO or bureaucratic authority figure. Activities are performance reviews, compliance requirements, quarterly deliverables.', honorific_templates: { with_name: '{name}', without_name: 'The Director' }, pet_name_suggestions: ['The Boss','The Director','Chief','The Executive','The Manager','CEO'], preview_sample: 'Mandatory Tummy Time Compliance Review — failure to meet KPIs may result in fussing.', classifier_keywords: ['boss','chief','ceo','director','manager','executive','tyrant','commander','president'], status: 'active' },
  { id: ARCHETYPES.LITTLE_CREATURE, display_name: 'Little Creature', short_description: 'Warm, silly, creature-energy — your baby as a delightful small animal.', personality_sketch: 'The baby is a beloved small creature — undefined species, somewhere between hamster, dragon, and woodland spirit.', honorific_templates: { with_name: '{name}', without_name: 'the creature' }, pet_name_suggestions: ['Little Goblin','The Creature','Tiny Beast','Little Dragon','Snufflebug','Wrigglepod'], preview_sample: 'Tummy Time for the Creature — essential core strengthening for a being of this configuration.', classifier_keywords: ['goblin','gremlin','creature','beast','dragon','monster','bug','critter','possum','wombat','potato','nugget','dumpling'], status: 'active' },
  { id: ARCHETYPES.FERAL_GOBLIN, display_name: 'Feral Goblin', short_description: 'Anarchic affection — chaos is the love language.', personality_sketch: 'Pure id, maximum affection, zero dignity. The baby is a chaos agent and proud of it.', honorific_templates: { with_name: '{name}', without_name: 'the goblin' }, pet_name_suggestions: ['Gremlin','The Goblin','Chaos Agent','Little Menace','The Gremlin','Tiny Villain'], preview_sample: 'Operation Tummy Time — the goblin must acquire upper body strength for future schemes.', classifier_keywords: ['gremlin','goblin','menace','chaos','villain','trouble','mischief','feral','disaster'], status: 'active' },
  { id: ARCHETYPES.FIELD_RESEARCHER, display_name: 'Field Researcher', short_description: 'Mock-scientific field notes on a fascinating new specimen.', personality_sketch: 'Activities described as scientific field observations. The baby is a newly-discovered species of great research interest.', honorific_templates: { with_name: '{name}', without_name: 'the subject' }, pet_name_suggestions: ['The Subject','Specimen A','The Participant','Research Lead','Principal Investigator'], preview_sample: 'Field Note 001 — subject demonstrates prone positioning tolerance in controlled conditions.', classifier_keywords: ['specimen','subject','researcher','scientist','professor','doctor','experiment','hypothesis'], status: 'active' },
];

// ─── Classifier ───────────────────────────────────────────────────────────────

export const CLASSIFIER_SYSTEM_PROMPT = `You are helping classify a baby's nickname into one of six playful archetypes for a parenting app called Bloom.

The baby's nickname is: "{NICKNAME}"

The six archetypes are:
1. royal_court — Regal, courtly. Suits: King Arthur, Lady Beatrice, The Sovereign.
2. tiny_tyrant — Mock-bureaucratic, boss-like. Suits: The Boss, CEO, The Director, Chief.
3. little_creature — Warm creature-energy. Suits: Snufflebug, Tiny Dragon, Possum, Nugget.
4. feral_goblin — Anarchic chaos-agent. Suits: Gremlin, Chaos Agent, Little Menace.
5. field_researcher — Mock-scientific. Suits: Specimen A, The Subject, The Participant.
6. plain — No archetype; warm plain language.

Also flag if the nickname is inappropriate for a children's app.

Respond with valid JSON only, no markdown:
{"archetype":"royal_court|tiny_tyrant|little_creature|feral_goblin|field_researcher|plain|no_match","confidence":"high|medium|low","inappropriate":false,"reasoning":"one sentence"}`;

export function classifyNicknameLocally(nickname) {
  const lower = (nickname || '').toLowerCase().trim();
  for (const arch of archetypes) {
    if (arch.id === ARCHETYPES.PLAIN) continue;
    if (arch.classifier_keywords.some(kw => lower.includes(kw))) {
      return { archetype: arch.id, confidence: 'medium', inappropriate: false, reasoning: 'Keyword match' };
    }
  }
  return { archetype: 'no_match', confidence: 'low', inappropriate: false, reasoning: 'No keyword match' };
}
