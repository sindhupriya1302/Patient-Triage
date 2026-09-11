const mongoose = require('mongoose');

/**
 * Staff accounts for Nurses and Doctors.
 * Passwords are stored as bcrypt hashes only — never plaintext.
 * Roles:
 *   - nurse  : intake, doctor assignment, re-triage, override, status changes
 *   - doctor : clinical care, re-triage, override, discharge, availability toggle, department specialization
 *   - admin  : management and oversight
 */
const StaffSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  username: { type: String, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['nurse', 'doctor', 'admin'], required: true },
  department: { type: String, default: null, trim: true }, // e.g. 'Cardiology', 'Neurology', 'Pulmonology', etc.
  isAvailable: { type: Boolean, default: true }, // availability for doctor on-duty status
  resetCode: { type: String, default: null }, // 6-digit password verification code
  resetCodeExpires: { type: Date, default: null }, // expiry timestamp for verification code
}, {
  timestamps: true,
});

StaffSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.passwordHash; // never sent to the client, even by accident
    delete ret.resetCode;
    delete ret.resetCodeExpires;
    return ret;
  },
});

module.exports = mongoose.model('Staff', StaffSchema);
