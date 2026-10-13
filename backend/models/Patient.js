const mongoose = require('mongoose');
const crypto = require('crypto');

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * A single triage snapshot - stores the AI's recommendation
 * exactly as computed, without overwriting upon clinician override.
 */
const TriageSnapshotSchema = new mongoose.Schema({
  score: Number,
  level: Number,
  levelLabel: String,
  color: String,
  recommendedAction: String,
  targetMins: Number,
  flags: [String],
  reasons: [{ text: String, points: Number }],
  topReasons: [{ text: String, points: Number }],
}, { _id: false });

/**
 * Cryptographically tamper-proof audit log entry.
 * Uses SHA-256 hash-chaining where each entry points to the hash of the preceding entry.
 */
const HistoryEntrySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  event: { type: String, required: true },
  level: Number,
  score: Number,
  reason: String,
  byName: { type: String, default: null },
  byRole: { type: String, default: null },
  prevHash: { type: String, required: true, default: GENESIS_HASH },
  hash: { type: String, required: true },
}, { _id: false });

function calculateEntryHash(prevHash, entry) {
  const atStr = entry.at instanceof Date ? entry.at.toISOString() : new Date(entry.at || Date.now()).toISOString();
  const payload = [
    prevHash || GENESIS_HASH,
    atStr,
    entry.event || '',
    entry.level != null ? entry.level : '',
    entry.score != null ? entry.score : '',
    entry.reason || '',
    entry.byName || '',
    entry.byRole || ''
  ].join('|');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function appendHistory(patient, entryData) {
  if (!patient.history) {
    patient.history = [];
  }
  const history = patient.history;
  const prevHash = (history.length > 0 && history[history.length - 1].hash)
    ? history[history.length - 1].hash
    : GENESIS_HASH;
  const at = entryData.at || new Date();
  const entry = {
    ...entryData,
    at,
    prevHash,
  };
  entry.hash = calculateEntryHash(prevHash, entry);
  patient.history.push(entry);
  return entry;
}

function verifyHistoryChain(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return { verified: true, count: 0 };
  }
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (!entry.hash || !entry.prevHash) {
      return { verified: false, brokenAtIndex: i, error: `Missing cryptographic hash at entry index ${i}` };
    }
    if (entry.prevHash !== prevHash) {
      return { verified: false, brokenAtIndex: i, error: `Broken chain link at index ${i}` };
    }
    const computed = calculateEntryHash(prevHash, entry);
    if (entry.hash !== computed) {
      return { verified: false, brokenAtIndex: i, error: `Content hash verification failed at index ${i}` };
    }
    prevHash = entry.hash;
  }
  return { verified: true, count: history.length };
}

const PatientSchema = new mongoose.Schema({
  name: { type: String, required: true },
  age: { type: Number, default: null },
  sex: { type: String, default: null },
  chiefComplaint: { type: String, required: true },
  vitals: {
    hr: { type: Number, default: null },
    sbp: { type: Number, default: null },
    rr: { type: Number, default: null },
    spo2: { type: Number, default: null },
    tempC: { type: Number, default: null },
  },
  consciousness: { type: String, default: 'alert' },
  painScore: { type: Number, default: null },
  onsetMinutesAgo: { type: Number, default: null },
  severeBleeding: { type: Boolean, default: false },
  comorbidities: { type: [String], default: [] },
  notes: { type: String, default: '' },

  arrivedAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['waiting', 'in_progress', 'discharged'], default: 'waiting' },

  triage: { type: TriageSnapshotSchema, required: true },
  overrideLevel: { type: Number, default: null },
  overrideReason: { type: String, default: null },

  assignedDoctor: {
    id: { type: String, default: null },
    name: { type: String, default: null },
    department: { type: String, default: null },
    assignedAt: { type: Date, default: null },
  },

  history: { type: [HistoryEntrySchema], default: [] },
}, {
  timestamps: true,
  optimisticConcurrency: true,
});

PatientSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    ret.version = ret.__v;
    delete ret._id;
    return ret;
  },
});

module.exports = {
  Patient: mongoose.model('Patient', PatientSchema),
  appendHistory,
  verifyHistoryChain,
  calculateEntryHash,
  GENESIS_HASH,
};
