const mongoose = require('mongoose');

/**
 * A single triage snapshot — we store the AI's ORIGINAL recommendation
 * exactly as computed, and never overwrite it. A new intake or a
 * re-triage creates a new snapshot; overrides are stored separately
 * (see overrideLevel/overrideReason on the patient itself) so the
 * AI's own output is always recoverable for audit purposes.
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
 * history is an append-only audit log. Entries are pushed, never
 * edited or removed — this is what makes overrides and re-triages
 * defensible after the fact ("what did the system know, and when").
 */
const HistoryEntrySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  event: String,           // 'intake' | 're-triage' | 'override' | 'status:<x>'
  level: Number,
  score: Number,
  reason: String,
  byName: { type: String, default: null },  // who performed the action
  byRole: { type: String, default: null },  // their role at the time
}, { _id: false });

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

  triage: { type: TriageSnapshotSchema, required: true },     // AI's current recommendation — never mutated by an override
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
  timestamps: true, // adds createdAt / updatedAt automatically
});

// Shape the JSON the API sends back so the frontend contract never changes:
// Mongo's `_id` becomes `id`, and `__v` is dropped.
PatientSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Patient', PatientSchema);
