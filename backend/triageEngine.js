/**
 * triageEngine.js
 * ------------------------------------------------------------
 * PatientTriage.ai — decision-support scoring engine.
 *
 * IMPORTANT DESIGN PRINCIPLE (see README "Design decisions"):
 * This engine NEVER makes a clinical decision on its own. It produces
 * a recommended ESI-style acuity level (1 = most urgent, 5 = least)
 * plus a transparent, itemised explanation of every factor that fed
 * the score. A human clinician always sees the "why" and can override
 * it in one click — the override + reason is logged, never silently
 * accepted or hidden.
 *
 * This file is intentionally storage-agnostic: it's a pure function
 * of its input and has no idea whether the caller is using an
 * in-memory array or MongoDB. That's deliberate — swapping storage
 * (Round 1 -> Round 2) never has to touch this file.
 * ------------------------------------------------------------
 */

const LEVELS = {
  1: { label: 'Level 1 · Resuscitation', color: '#e5484d', action: 'Immediate physician / resus bay now', targetMins: 0 },
  2: { label: 'Level 2 · Emergent',      color: '#f2994a', action: 'Rapid assessment within 10 minutes', targetMins: 10 },
  3: { label: 'Level 3 · Urgent',        color: '#e0c341', action: 'Assessment within 30 minutes, allocate resources', targetMins: 30 },
  4: { label: 'Level 4 · Less Urgent',   color: '#4fae5f', action: 'Assessment within 60 minutes', targetMins: 60 },
  5: { label: 'Level 5 · Non-Urgent',    color: '#4f8ff2', action: 'Standard queue, within 120 minutes', targetMins: 120 },
};

const CHIEF_COMPLAINTS = {
  cardiac_arrest:       { label: 'Cardiac arrest / not breathing', points: 60, redFlag: true },
  stroke_symptoms:      { label: 'Stroke symptoms (FAST positive)', points: 30 },
  chest_pain:           { label: 'Chest pain', points: 22 },
  breathing_difficulty: { label: 'Difficulty breathing', points: 24 },
  anaphylaxis:          { label: 'Severe allergic reaction', points: 28 },
  active_seizure:       { label: 'Active seizure', points: 30, redFlag: true },
  severe_bleeding:      { label: 'Severe / uncontrolled bleeding', points: 22 },
  major_trauma:         { label: 'Major trauma', points: 22 },
  minor_trauma:         { label: 'Minor injury (cut, sprain, bruise)', points: 3 },
  abdominal_pain:       { label: 'Severe abdominal pain', points: 12 },
  psychiatric_crisis:   { label: 'Psychiatric crisis / self-harm risk', points: 22, safetyFlag: true },
  fever:                { label: 'Fever / infection symptoms', points: 6 },
  other:                { label: 'Other / unspecified', points: 4 },
};

const CONSCIOUSNESS = {
  alert:        { label: 'Alert', points: 0 },
  verbal:       { label: 'Responds to voice', points: 15 },
  pain:         { label: 'Responds to pain only', points: 28 },
  unresponsive: { label: 'Unresponsive', points: 45, redFlag: true },
};

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/**
 * @param {object} p patient intake payload
 * @returns {object} triage result
 */
function computeTriage(p) {
  const reasons = [];   // { text, points }
  const flags = [];     // red flags forcing Level 1 regardless of score
  let score = 0;

  const add = (points, text) => {
    if (points === 0) return;
    score += points;
    reasons.push({ text, points });
  };

  // --- Chief complaint -------------------------------------------------
  const cc = CHIEF_COMPLAINTS[p.chiefComplaint] || CHIEF_COMPLAINTS.other;
  add(cc.points, `Chief complaint: ${cc.label}`);
  if (cc.redFlag) flags.push(`Chief complaint "${cc.label}" is an automatic critical flag`);
  if (cc.safetyFlag) flags.push('Safety flag: route to a secure area and notify psychiatric liaison / security per protocol');

  // --- Consciousness (AVPU) --------------------------------------------
  const avpu = CONSCIOUSNESS[p.consciousness] || CONSCIOUSNESS.alert;
  add(avpu.points, `Consciousness (AVPU): ${avpu.label}`);
  if (avpu.redFlag) flags.push('Unresponsive patient — automatic Level 1');

  // --- Vitals ------------------------------------------------------------
  const v = p.vitals || {};

  if (v.spo2 != null) {
    if (v.spo2 < 90) { add(35, `SpO₂ critically low (${v.spo2}%)`); flags.push('SpO₂ < 90% — automatic Level 1'); }
    else if (v.spo2 <= 94) add(16, `SpO₂ low (${v.spo2}%)`);
  }
  if (v.sbp != null) {
    if (v.sbp < 90) { add(28, `Systolic BP critically low (${v.sbp} mmHg)`); flags.push('Systolic BP < 90 mmHg — possible shock, automatic Level 1'); }
    else if (v.sbp < 100) add(12, `Systolic BP low (${v.sbp} mmHg)`);
    else if (v.sbp > 180) add(10, `Systolic BP very high (${v.sbp} mmHg)`);
  }
  if (v.hr != null) {
    if (v.hr > 130 || v.hr < 40) add(20, `Heart rate markedly abnormal (${v.hr} bpm)`);
    else if (v.hr > 110 || v.hr < 50) add(10, `Heart rate abnormal (${v.hr} bpm)`);
  }
  if (v.rr != null) {
    if (v.rr > 28 || v.rr < 8) { add(22, `Respiratory rate markedly abnormal (${v.rr}/min)`); }
    else if (v.rr > 22 || v.rr < 10) add(12, `Respiratory rate abnormal (${v.rr}/min)`);
  }
  if (v.tempC != null) {
    if (v.tempC >= 40 || v.tempC < 35) add(14, `Temperature markedly abnormal (${v.tempC}°C)`);
    else if (v.tempC >= 39) add(6, `Fever (${v.tempC}°C)`);
  }

  // --- Pain -----------------------------------------------------------
  if (p.painScore != null) {
    if (p.painScore >= 8) add(10, `Pain reported ${p.painScore}/10 (severe)`);
    else if (p.painScore >= 5) add(5, `Pain reported ${p.painScore}/10 (moderate)`);
  }

  // --- Age modifiers -----------------------------------------------------
  if (p.age != null) {
    if (p.age < 0.08) add(18, 'Neonate (under 1 month) — higher baseline risk');
    else if (p.age < 2) add(10, 'Infant/toddler — higher baseline risk');
    else if (p.age >= 65) add(8, 'Age 65+ — higher baseline risk');
  }

  // --- Time-sensitive windows -------------------------------------------
  if (p.onsetMinutesAgo != null && ['chest_pain', 'stroke_symptoms'].includes(p.chiefComplaint)) {
    if (p.onsetMinutesAgo <= 60) add(12, `Symptom onset ${p.onsetMinutesAgo} min ago — inside treatment window`);
    else if (p.onsetMinutesAgo <= 270) add(6, `Symptom onset ${p.onsetMinutesAgo} min ago — approaching window limit`);
  }

  // --- Bleeding / comorbidities -------------------------------------------
  if (p.severeBleeding) { add(15, 'Actively, visibly bleeding'); }
  const comorb = p.comorbidities || [];
  if (comorb.includes('cardiac')) add(6, 'History of cardiac disease');
  if (comorb.includes('respiratory')) add(6, 'History of respiratory disease');
  if (comorb.includes('immunocompromised')) add(10, 'Immunocompromised');
  if (comorb.includes('anticoagulant')) add(8, 'On blood thinners — bleeding risk elevated');
  if (comorb.includes('pregnancy') && ['abdominal_pain', 'severe_bleeding', 'major_trauma'].includes(p.chiefComplaint)) {
    add(15, 'Pregnant, with a complaint that raises obstetric risk');
  }

  score = clamp(Math.round(score), 0, 100);

  // --- Map score -> level, red flags always win --------------------------
  let level;
  if (flags.length > 0) level = 1;
  else if (score >= 65) level = 2;
  else if (score >= 45) level = 3;
  else if (score >= 22) level = 4;
  else level = 5;
  // A raw score of 78+ is resuscitation-grade even without an explicit red flag
  if (score >= 78) level = 1;

  reasons.sort((a, b) => b.points - a.points);

  return {
    score,
    level,
    levelLabel: LEVELS[level].label,
    color: LEVELS[level].color,
    recommendedAction: LEVELS[level].action,
    targetMins: LEVELS[level].targetMins,
    flags,
    reasons,
    topReasons: reasons.slice(0, 5),
  };
}

module.exports = { computeTriage, LEVELS, CHIEF_COMPLAINTS, CONSCIOUSNESS };
