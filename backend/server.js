require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const { connectDB } = require('./db');
const { Patient, appendHistory, verifyHistoryChain } = require('./models/Patient');
const Staff = require('./models/Staff');
const { computeTriage, LEVELS, CHIEF_COMPLAINTS, CONSCIOUSNESS } = require('./triageEngine');
const { hashPassword, checkPassword, signToken, verifyToken, requireAuth, requireRole } = require('./auth');
const { seedStaffIfEmpty } = require('./seedStaff');
const { sendPasswordResetEmail } = require('./mailer');

const DEPARTMENTS = [
  'Cardiology',
  'Neurology',
  'Pulmonology',
  'Emergency Medicine',
  'Orthopedics & Trauma',
  'General Medicine',
  'Pediatrics',
  'Psychiatry',
  'General Surgery & Gastroenterology',
];

const app = express();
const server = http.createServer(app);

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge: 12 * 60 * 60 * 1000,
  path: '/',
};

function parseCookieHeader(cookieString) {
  const result = {};
  if (!cookieString) return result;
  cookieString.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      result[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('=').trim());
    }
  });
  return result;
}

// Socket.io configuration with JWT authentication and room-based privacy
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, true),
    credentials: true,
  },
});

io.use((socket, next) => {
  try {
    let token = null;

    if (socket.handshake.auth && socket.handshake.auth.token) {
      token = socket.handshake.auth.token;
    }

    if (!token && socket.handshake.headers.cookie) {
      const parsed = parseCookieHeader(socket.handshake.headers.cookie);
      token = parsed.pt_token;
    }

    if (!token && socket.handshake.headers.authorization) {
      const header = socket.handshake.headers.authorization;
      if (header.startsWith('Bearer ')) token = header.slice(7);
    }

    if (!token) {
      return next(new Error('Authentication required for socket connection'));
    }

    const decoded = verifyToken(token);
    socket.user = decoded;
    next();
  } catch (err) {
    return next(new Error('Invalid or expired socket credentials'));
  }
});

io.on('connection', (socket) => {
  const user = socket.user;
  socket.join(`role:${user.role}`);

  if (user.role === 'doctor') {
    socket.join(`doctor:${user.id}`);
  }

  socket.on('disconnect', () => {});
});

app.use(cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

function minutesSince(date) {
  return Math.round((Date.now() - new Date(date).getTime()) / 60000);
}

function withWait(patientJson) {
  return { ...patientJson, waitingMinutes: minutesSince(patientJson.arrivedAt) };
}

function sortQueue(list) {
  return [...list].sort((a, b) => {
    const level = (a.overrideLevel ?? a.triage.level) - (b.overrideLevel ?? b.triage.level);
    if (level !== 0) return level;
    return new Date(a.arrivedAt) - new Date(b.arrivedAt);
  });
}

// Broadcasts real-time queue to authorized rooms: full queue to nurses/admins, doctor-specific queue to doctors
async function broadcastQueue() {
  try {
    const docs = await Patient.find({});
    const fullList = sortQueue(docs.map((d) => d.toJSON())).map(withWait);

    io.to('role:nurse').to('role:admin').emit('queue:update', fullList);

    const doctorSockets = await io.in('role:doctor').fetchSockets();
    for (const s of doctorSockets) {
      if (s.user && s.user.id) {
        const doctorQueue = fullList.filter((p) => p.assignedDoctor?.id === s.user.id);
        s.emit('queue:update', doctorQueue);
      }
    }
  } catch (err) {
    console.error('Broadcast queue failed:', err.message);
  }
}

// Broadcast updated doctor roster & availability
async function broadcastDoctors() {
  try {
    const docs = await Staff.find({ role: 'doctor' });
    io.emit('doctors:update', docs.map((d) => d.toJSON()));
  } catch (err) {
    console.error('Broadcast doctors failed:', err.message);
  }
}

function handleOptimisticConcurrency(err, res) {
  if (err && err.name === 'VersionError') {
    res.status(409).json({
      error: 'Conflict: This patient was modified concurrently by another staff member. Please refresh to load the latest record.',
      conflict: true,
    });
    return true;
  }
  return false;
}

// =========================================================================
// AUTH - Sign up, Sign in, Logout, Me, Profile Edit, Change Password, Delete
// =========================================================================

// --- User Registration ----------------------------------------------------
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password, role, department } = req.body || {};
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'Name, email, password, and role are required' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Prevent administrative privilege escalation via self-signup
    if (role === 'admin') {
      return res.status(403).json({
        error: 'Admin self-registration is disabled. Administrator accounts require approval and direct provisioning.',
      });
    }

    if (!['nurse', 'doctor'].includes(role)) {
      return res.status(400).json({ error: 'Role must be nurse or doctor' });
    }

    if (role === 'doctor' && !department) {
      return res.status(400).json({ error: 'Department / Specialization is required for doctor accounts' });
    }

    const existing = await Staff.findOne({ email: cleanEmail });
    if (existing) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await hashPassword(password);
    const staff = await Staff.create({
      name: name.trim(),
      email: cleanEmail,
      username: cleanEmail.split('@')[0],
      passwordHash,
      role,
      department: role === 'doctor' ? department.trim() : null,
      isAvailable: true,
      isApproved: true,
    });

    const token = signToken(staff);
    res.cookie('pt_token', token, COOKIE_OPTIONS);
    res.status(201).json({ token, user: staff.toJSON() });
    broadcastDoctors();
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// --- User Sign-in ---------------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const cleanEmail = (email || '').toLowerCase().trim();
    if (!cleanEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const staff = await Staff.findOne({ email: cleanEmail });

    // Use constant-time comparison to prevent user enumeration & timing attacks
    if (!staff) {
      await checkPassword(password, '$2a$10$e8T73O2g8YnZ6yU1p5mPneKz4m8d1.qP2v9l5v0k1b9z3f2e7y2a1');
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const ok = await checkPassword(password, staff.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (staff.isApproved === false) {
      return res.status(403).json({ error: 'Your staff account is pending administrator approval.' });
    }

    const token = signToken(staff);
    res.cookie('pt_token', token, COOKIE_OPTIONS);
    res.json({ token, user: staff.toJSON() });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// --- Sign-out -------------------------------------------------------------
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('pt_token', { path: '/' });
  res.json({ message: 'Signed out successfully' });
});

// --- Forgot Password: Secure OTP Generation & Dispatch --------------------
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    const cleanEmail = (email || '').toLowerCase().trim();
    if (!cleanEmail) {
      return res.status(400).json({ error: 'Email address is required' });
    }

    const staff = await Staff.findOne({ email: cleanEmail });

    // If account doesn't exist, return generic message without revealing existence
    if (!staff) {
      return res.json({
        message: `If an account with ${cleanEmail} exists, a verification code has been sent. Please check your inbox.`,
        emailDelivered: true,
      });
    }

    // Rate limiting: enforce a 60-second cooldown between OTP requests
    if (staff.resetLastRequestedAt && (Date.now() - staff.resetLastRequestedAt.getTime()) < 60 * 1000) {
      return res.status(429).json({
        error: 'Please wait at least 60 seconds before requesting another verification code.',
      });
    }

    // Cryptographically secure 6-digit numeric OTP generator
    const code = crypto.randomInt(100000, 1000000).toString();
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');

    staff.resetCodeHash = codeHash;
    staff.resetCodeExpires = new Date(Date.now() + 15 * 60 * 1000); // 15-minute validity window
    staff.resetAttempts = 0;
    staff.resetLastRequestedAt = new Date();
    await staff.save();

    console.log(`[EMAIL NOTIFICATION] Secure OTP dispatched for ${cleanEmail}`);

    const emailResult = await sendPasswordResetEmail(cleanEmail, code);

    // Secure response: OTP code is NEVER exposed in the API payload
    res.json({
      message: `If an account with ${cleanEmail} exists, a verification code has been sent. Please check your inbox.`,
      emailDelivered: emailResult.success,
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process forgot password request' });
  }
});

// --- Reset Password: Hash Verification & Attempt Limits -------------------
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body || {};
    const cleanEmail = (email || '').toLowerCase().trim();
    if (!cleanEmail || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, verification code, and new password are required' });
    }
    if (newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters long' });
    }

    const staff = await Staff.findOne({ email: cleanEmail });
    if (!staff || !staff.resetCodeHash) {
      return res.status(400).json({ error: 'No active password reset request found for this email' });
    }

    // Enforce maximum attempt limit of 5 to protect against brute force
    if (staff.resetAttempts >= 5) {
      staff.resetCodeHash = null;
      staff.resetCodeExpires = null;
      staff.resetAttempts = 0;
      await staff.save();
      return res.status(429).json({
        error: 'Too many invalid attempts. This verification code has been revoked for security. Please request a new code.',
      });
    }

    if (!staff.resetCodeExpires || new Date() > staff.resetCodeExpires) {
      staff.resetCodeHash = null;
      staff.resetCodeExpires = null;
      staff.resetAttempts = 0;
      await staff.save();
      return res.status(400).json({ error: 'Verification code has expired. Please request a new code.' });
    }

    const inputHash = crypto.createHash('sha256').update(code.trim()).digest('hex');
    let isValid = false;
    try {
      isValid = crypto.timingSafeEqual(
        Buffer.from(staff.resetCodeHash, 'hex'),
        Buffer.from(inputHash, 'hex')
      );
    } catch {
      isValid = false;
    }

    if (!isValid) {
      staff.resetAttempts = (staff.resetAttempts || 0) + 1;
      await staff.save();
      const remaining = Math.max(0, 5 - staff.resetAttempts);
      return res.status(400).json({
        error: `Invalid verification code. (Attempts remaining: ${remaining})`,
      });
    }

    staff.passwordHash = await hashPassword(newPassword);
    staff.resetCodeHash = null;
    staff.resetCodeExpires = null;
    staff.resetAttempts = 0;
    await staff.save();

    res.json({ message: 'Password has been updated successfully! You can now sign in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// --- Current User Profile -------------------------------------------------
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const staff = await Staff.findById(req.user.id);
    if (!staff) return res.status(401).json({ error: 'Session no longer valid' });
    res.json({ user: staff.toJSON() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user session' });
  }
});

// --- Update Profile & Availability ----------------------------------------
app.patch('/api/auth/profile', requireAuth, async (req, res) => {
  try {
    const staff = await Staff.findById(req.user.id);
    if (!staff) return res.status(404).json({ error: 'User not found' });

    const { name, email, department, isAvailable } = req.body || {};
    if (name) staff.name = name.trim();
    if (email) {
      const cleanEmail = email.toLowerCase().trim();
      if (cleanEmail !== staff.email) {
        const existing = await Staff.findOne({ email: cleanEmail, _id: { $ne: staff._id } });
        if (existing) return res.status(400).json({ error: 'Email is already in use by another account' });
        staff.email = cleanEmail;
      }
    }
    if (staff.role === 'doctor') {
      if (department) staff.department = department.trim();
      if (typeof isAvailable === 'boolean') staff.isAvailable = isAvailable;
    }

    await staff.save();
    const token = signToken(staff);
    res.cookie('pt_token', token, COOKIE_OPTIONS);
    res.json({ token, user: staff.toJSON() });
    broadcastDoctors();
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// --- Change Password ------------------------------------------------------
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    if (newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters long' });
    }

    const staff = await Staff.findById(req.user.id);
    if (!staff) return res.status(404).json({ error: 'User not found' });

    const ok = await checkPassword(currentPassword, staff.passwordHash);
    if (!ok) return res.status(400).json({ error: 'Current password does not match' });

    staff.passwordHash = await hashPassword(newPassword);
    await staff.save();
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// --- Delete Account -------------------------------------------------------
app.delete('/api/auth/account', requireAuth, async (req, res) => {
  try {
    await Staff.findByIdAndDelete(req.user.id);
    res.clearCookie('pt_token', { path: '/' });
    res.json({ message: 'Account deleted successfully' });
    broadcastDoctors();
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// =========================================================================
// Reference data - public
// =========================================================================
app.get('/api/reference', (req, res) => {
  res.json({
    levels: LEVELS,
    chiefComplaints: CHIEF_COMPLAINTS,
    consciousnessOptions: CONSCIOUSNESS,
    departments: DEPARTMENTS,
  });
});

// =========================================================================
// Doctors Roster & Availability (Auth required)
// =========================================================================
app.get('/api/doctors', requireAuth, async (req, res) => {
  try {
    const doctors = await Staff.find({ role: 'doctor' });
    res.json(doctors.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch doctors' });
  }
});

app.get('/api/doctors/available', requireAuth, async (req, res) => {
  try {
    const doctors = await Staff.find({ role: 'doctor', isAvailable: true });
    res.json(doctors.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch available doctors' });
  }
});

// =========================================================================
// Patient Management & Live Queue (Auth required)
// =========================================================================
app.use('/api/patients', requireAuth);
app.use('/api/stats', requireAuth);

// --- Create / intake patient with cryptographic audit entry --------------
app.post('/api/patients', requireRole('nurse', 'doctor'), async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name || !body.chiefComplaint) {
      return res.status(400).json({ error: 'name and chiefComplaint are required' });
    }

    let assignedDoctor = { id: null, name: null, department: null, assignedAt: null };
    if (body.assignedDoctorId) {
      const doc = await Staff.findById(body.assignedDoctorId);
      if (doc) {
        assignedDoctor = {
          id: doc._id.toString(),
          name: doc.name,
          department: doc.department || 'General Medicine',
          assignedAt: new Date(),
        };
      }
    }

    const triage = computeTriage(body);

    const patient = new Patient({
      name: body.name,
      age: body.age ?? null,
      sex: body.sex ?? null,
      chiefComplaint: body.chiefComplaint,
      vitals: body.vitals || {},
      consciousness: body.consciousness || 'alert',
      painScore: body.painScore ?? null,
      onsetMinutesAgo: body.onsetMinutesAgo ?? null,
      severeBleeding: !!body.severeBleeding,
      comorbidities: body.comorbidities || [],
      notes: body.notes || '',
      status: 'waiting',
      assignedDoctor,
      triage,
      history: [],
    });

    appendHistory(patient, {
      event: 'intake',
      level: triage.level,
      score: triage.score,
      byName: req.user.name,
      byRole: req.user.role,
    });

    if (assignedDoctor.id) {
      appendHistory(patient, {
        event: `assigned to Dr. ${assignedDoctor.name} (${assignedDoctor.department})`,
        byName: req.user.name,
        byRole: req.user.role,
      });
    }

    await patient.save();

    const json = withWait(patient.toJSON());
    res.status(201).json(json);
    broadcastQueue();

    // Isolated real-time push exclusively to the assigned doctor's room
    if (assignedDoctor.id) {
      io.to(`doctor:${assignedDoctor.id}`).emit('doctor:patient_assigned', {
        doctorId: assignedDoctor.id,
        patient: json,
      });
    }
  } catch (err) {
    console.error('Patient intake error:', err);
    res.status(500).json({ error: 'Failed to create patient' });
  }
});

// --- Live queue, sorted by effective priority then arrival ---------------
app.get('/api/patients', async (req, res) => {
  try {
    const filter = req.query.status ? { status: req.query.status } : {};
    if (req.user.role === 'doctor') {
      filter['assignedDoctor.id'] = req.user.id;
    }
    const docs = await Patient.find(filter);
    const list = sortQueue(docs.map((d) => d.toJSON()));
    res.json(list.map(withWait));
  } catch (err) {
    console.error('Load queue error:', err);
    res.status(500).json({ error: 'Failed to load queue' });
  }
});

app.get('/api/patients/:id', async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'not found' });
    if (req.user.role === 'doctor' && patient.assignedDoctor?.id !== req.user.id) {
      return res.status(403).json({ error: 'Access restricted to assigned doctor' });
    }
    res.json(withWait(patient.toJSON()));
  } catch (err) {
    res.status(404).json({ error: 'not found' });
  }
});

// --- Assign / Reassign patient to a doctor --------------------------------
app.patch('/api/patients/:id/assign', requireRole('nurse', 'admin'), async (req, res) => {
  try {
    const { doctorId } = req.body;
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    if (!doctorId) {
      patient.assignedDoctor = { id: null, name: null, department: null, assignedAt: null };
      appendHistory(patient, {
        event: 'unassigned from doctor',
        byName: req.user.name,
        byRole: req.user.role,
      });
    } else {
      const doc = await Staff.findById(doctorId);
      if (!doc) return res.status(404).json({ error: 'Doctor not found' });
      patient.assignedDoctor = {
        id: doc._id.toString(),
        name: doc.name,
        department: doc.department || 'General Medicine',
        assignedAt: new Date(),
      };
      appendHistory(patient, {
        event: `assigned to Dr. ${doc.name} (${doc.department || 'General Medicine'})`,
        byName: req.user.name,
        byRole: req.user.role,
      });
    }

    await patient.save();
    const json = withWait(patient.toJSON());
    res.json(json);
    broadcastQueue();

    if (patient.assignedDoctor?.id) {
      io.to(`doctor:${patient.assignedDoctor.id}`).emit('doctor:patient_assigned', {
        doctorId: patient.assignedDoctor.id,
        patient: json,
      });
    }
  } catch (err) {
    if (handleOptimisticConcurrency(err, res)) return;
    console.error('Assign doctor error:', err);
    res.status(500).json({ error: 'Failed to assign doctor' });
  }
});

// --- Tamper-proof patient timeline audit history --------------------------
app.get('/api/patients/:id/timeline', async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'not found' });
    if (req.user.role === 'doctor' && patient.assignedDoctor?.id !== req.user.id) {
      return res.status(403).json({ error: 'Access restricted to assigned doctor' });
    }

    const verification = verifyHistoryChain(patient.history);
    const json = patient.toJSON();

    res.json({
      id: json.id,
      name: json.name,
      currentLevel: json.overrideLevel ?? json.triage.level,
      history: json.history,
      auditChainVerified: verification.verified,
      verification,
    });
  } catch (err) {
    console.error('Timeline error:', err);
    res.status(500).json({ error: 'Failed to load timeline' });
  }
});

// --- Re-triage vitals update with concurrency protection ------------------
app.post('/api/patients/:id/retriage', requireRole('nurse', 'doctor'), async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'not found' });

    if (req.user.role === 'doctor') {
      if (!patient.assignedDoctor?.id || patient.assignedDoctor.id !== req.user.id) {
        return res.status(403).json({ error: 'You can only re-triage patients assigned to you.' });
      }
    }

    const merged = {
      chiefComplaint: patient.chiefComplaint,
      age: patient.age,
      onsetMinutesAgo: patient.onsetMinutesAgo,
      severeBleeding: patient.severeBleeding,
      comorbidities: patient.comorbidities,
      vitals: { ...patient.vitals.toObject(), ...(req.body.vitals || {}) },
      consciousness: req.body.consciousness || patient.consciousness,
      painScore: req.body.painScore ?? patient.painScore,
    };
    const newTriage = computeTriage(merged);
    const oldLevel = patient.overrideLevel ?? patient.triage.level;

    patient.vitals = merged.vitals;
    patient.consciousness = merged.consciousness;
    patient.painScore = merged.painScore;
    patient.triage = newTriage;
    patient.overrideLevel = null;
    patient.overrideReason = null;

    appendHistory(patient, {
      event: 're-triage',
      level: newTriage.level,
      score: newTriage.score,
      byName: req.user.name,
      byRole: req.user.role,
    });

    await patient.save();

    const deteriorated = newTriage.level < oldLevel;
    const json = { ...withWait(patient.toJSON()), deteriorated };
    res.json(json);
    broadcastQueue();

    if (deteriorated) {
      io.to('role:nurse').to('role:admin').emit('patient:deteriorated', {
        id: patient.id,
        name: patient.name,
        level: newTriage.level,
      });
      if (patient.assignedDoctor?.id) {
        io.to(`doctor:${patient.assignedDoctor.id}`).emit('patient:deteriorated', {
          id: patient.id,
          name: patient.name,
          level: newTriage.level,
        });
      }
    }
  } catch (err) {
    if (handleOptimisticConcurrency(err, res)) return;
    console.error('Retriage error:', err);
    res.status(500).json({ error: 'Failed to re-triage' });
  }
});

// --- Clinician override with concurrency protection -----------------------
app.post('/api/patients/:id/override', requireRole('nurse', 'doctor'), async (req, res) => {
  try {
    const { level, reason } = req.body;
    if (!level || !reason) return res.status(400).json({ error: 'level and reason are required for an override' });

    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'not found' });

    if (req.user.role === 'doctor') {
      if (!patient.assignedDoctor?.id || patient.assignedDoctor.id !== req.user.id) {
        return res.status(403).json({ error: 'You can only override patients assigned to you.' });
      }
    }

    patient.overrideLevel = level;
    patient.overrideReason = reason;

    appendHistory(patient, {
      event: 'override',
      level,
      reason,
      byName: req.user.name,
      byRole: req.user.role,
    });

    await patient.save();

    const json = withWait(patient.toJSON());
    res.json(json);
    broadcastQueue();
  } catch (err) {
    if (handleOptimisticConcurrency(err, res)) return;
    console.error('Override error:', err);
    res.status(500).json({ error: 'Failed to override' });
  }
});

// --- Status transitions with concurrency protection -----------------------
app.patch('/api/patients/:id/status', requireRole('nurse', 'doctor'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['waiting', 'in_progress', 'discharged'].includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'not found' });

    if (status === 'in_progress') {
      if (req.user.role !== 'doctor') {
        return res.status(403).json({ error: 'Only the assigned doctor can start care for this patient.' });
      }
      if (!patient.assignedDoctor?.id || patient.assignedDoctor.id !== req.user.id) {
        return res.status(403).json({ error: 'You can only start care on patients assigned to you.' });
      }

      await Staff.findByIdAndUpdate(req.user.id, { isAvailable: false });
      broadcastDoctors();
    }

    if (req.user.role === 'doctor') {
      if (!patient.assignedDoctor?.id || patient.assignedDoctor.id !== req.user.id) {
        return res.status(403).json({ error: 'You can only attend or update patients assigned to you.' });
      }
    }

    patient.status = status;
    appendHistory(patient, {
      event: `status:${status}`,
      byName: req.user.name,
      byRole: req.user.role,
    });

    await patient.save();

    if (status === 'discharged' && patient.assignedDoctor?.id) {
      const remainingInProgress = await Patient.countDocuments({
        _id: { $ne: patient._id },
        'assignedDoctor.id': patient.assignedDoctor.id,
        status: 'in_progress',
      });
      if (remainingInProgress === 0) {
        await Staff.findByIdAndUpdate(patient.assignedDoctor.id, { isAvailable: true });
        broadcastDoctors();
      }
    }

    const json = withWait(patient.toJSON());
    res.json(json);
    broadcastQueue();
  } catch (err) {
    if (handleOptimisticConcurrency(err, res)) return;
    console.error('Status error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

app.delete('/api/patients/:id', requireRole('admin'), async (req, res) => {
  try {
    await Patient.findByIdAndDelete(req.params.id);
    res.status(204).end();
    broadcastQueue();
  } catch (err) {
    res.status(404).end();
  }
});

// --- Dashboard stats ------------------------------------------------------
app.get('/api/stats', async (req, res) => {
  try {
    const filter = req.user.role === 'doctor' ? { 'assignedDoctor.id': req.user.id } : {};
    const all = await Patient.find(filter);
    const active = all.filter((p) => p.status !== 'discharged');
    const byLevel = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    active.forEach((p) => {
      byLevel[p.overrideLevel ?? p.triage.level]++;
    });
    const waits = active.map((p) => minutesSince(p.arrivedAt));
    const avgWait = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0;
    const longestWait = waits.length ? Math.max(...waits) : 0;
    const overrideCount = all.filter((p) => p.overrideLevel !== null).length;

    res.json({
      totalActive: active.length,
      byLevel,
      avgWait,
      longestWait,
      overrideCount,
      discharged: all.filter((p) => p.status === 'discharged').length,
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  if (err && err.name === 'VersionError') {
    return res.status(409).json({
      error: 'Conflict: This record was modified concurrently. Please refresh and retry.',
      conflict: true,
    });
  }
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;

connectDB().then(async () => {
  await seedStaffIfEmpty();
  server.listen(PORT, () => console.log(`PatientTriage.ai backend running on http://localhost:${PORT}`));
});
