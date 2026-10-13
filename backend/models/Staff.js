const mongoose = require('mongoose');

/**
 * Staff accounts for Nurses and Doctors.
 * Passwords and sensitive reset tokens are stored as secure hashes only.
 * Roles:
 *   - nurse  : intake, doctor assignment, re-triage, override, status changes
 *   - doctor : clinical care, re-triage, override, discharge, availability toggle, department specialization
 *   - admin  : management, approvals, and oversight
 */
const StaffSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  username: { type: String, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['nurse', 'doctor', 'admin'], required: true },
  department: { type: String, default: null, trim: true },
  isAvailable: { type: Boolean, default: true },
  isApproved: { type: Boolean, default: true },
  resetCodeHash: { type: String, default: null },
  resetCodeExpires: { type: Date, default: null },
  resetAttempts: { type: Number, default: 0 },
  resetLastRequestedAt: { type: Date, default: null },
}, {
  timestamps: true,
});

StaffSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.passwordHash;
    delete ret.resetCodeHash;
    delete ret.resetCodeExpires;
    delete ret.resetAttempts;
    delete ret.resetLastRequestedAt;
    return ret;
  },
});

module.exports = mongoose.model('Staff', StaffSchema);