require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const { connectDB } = require('./db');
const Patient = require('./models/Patient');
const Staff = require('./models/Staff');
const { computeTriage, LEVELS, CHIEF_COMPLAINTS, CONSCIOUSNESS } = require('./triageEngine');
const { hashPassword, checkPassword, signToken, requireAuth, requireRole } = require('./auth');
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

// Socket.io — real-time queue & doctor availability sync across clients
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

function minutesSince(date) { return Math.round((Date.now() - new Date(date).getTime()) / 60000); }

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

// Broadcast a full queue refresh to every connected client
async function broadcastQueue() {
  try {
    const docs = await Patient.find({});
    const list = sortQueue(docs.map(d => d.toJSON())).map(withWait);
    io.emit('queue:update', list);
  } catch (err) {
    console.error('Broadcast queue failed:', err.message);
  }
}

// Broadcast updated doctor roster & availability
async function broadcastDoctors() {
  try {
    const docs = await Staff.find({ role: 'doctor' });
    io.emit('doctors:update', docs.map(d => d.toJSON()));
  } catch (err) {
    console.error('Broadcast doctors failed:', err.message);
  }
}

io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

// =========================================================================
// AUTH — Sign up, Sign in, Me, Profile Edit, Change Password, Delete Account
// =========================================================================

// --- User Registration (Nurse or Doctor) ---------------------------------
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password, role, department } = req.body || {};
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'Name, email, password, and role are required' });
    }

    const cleanEmail = email.toLowerCase().trim();
    if (!['nurse', 'doctor', 'admin'].includes(role)) {
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
    });

    const token = signToken(staff);
    res.status(201).json({ token, user: staff.toJSON() });
    broadcastDoctors();
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// --- User Sign-in --------------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const cleanEmail = (email || '').toLowerCase().trim();
    if (!cleanEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const staff = await Staff.findOne({ email: cleanEmail });
    if (!staff) {
      return res.status(404).json({ error: 'This email does not exist. Please check your email or create an account.' });
    }

    const ok = await checkPassword(password, staff.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Incorrect password for this email.' });
    }

    const token = signToken(staff);
    res.json({ token, user: staff.toJSON() });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// --- Forgot Password: Send Verification Code ------------------------------
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    const cleanEmail = (email || '').toLowerCase().trim();
    if (!cleanEmail) {
      return res.status(400).json({ error: 'Email address is required' });
    }

    const staff = await Staff.findOne({ email: cleanEmail });
    if (!staff) {
      return res.status(404).json({ error: 'This email does not exist. Please check your email or create an account.' });
    }

    // Generate a 6-digit numeric verification code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    staff.resetCode = code;
    staff.resetCodeExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes validity
    await staff.save();

    console.log(`📧 [EMAIL NOTIFICATION] Password reset verification code requested for ${cleanEmail}`);
    
    // Dispatch real email via nodemailer
    const emailResult = await sendPasswordResetEmail(cleanEmail, code);

    res.json({
      message: `Verification code has been sent to ${cleanEmail}. Please check your inbox.`,
      verificationCode: code,
      emailDelivered: emailResult.success,
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process forgot password request' });
  }
});

// --- Reset Password: Verify Code & Update Password ------------------------
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
    if (!staff) {
      return res.status(404).json({ error: 'Account not found with this email' });
    }

    if (!staff.resetCode || staff.resetCode !== code.trim()) {
      return res.status(400).json({ error: 'Invalid verification code. Please check the code and try again.' });
    }

    if (!staff.resetCodeExpires || new Date() > staff.resetCodeExpires) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new code.' });
    }

    staff.passwordHash = await hashPassword(newPassword);
    staff.resetCode = null;
    staff.resetCodeExpires = null;
    await staff.save();

    res.json({ message: 'Password has been updated successfully! You can now sign in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// --- Current User Profile ------------------------------------------------
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const staff = await Staff.findById(req.user.id);
    if (!staff) return res.status(401).json({ error: 'Session no longer valid' });
    res.json({ user: staff.toJSON() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user session' });
  }
});

// --- Update Profile & Availability ---------------------------------------
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
    res.json({ token, user: staff.toJSON() });
    broadcastDoctors();
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// --- Change Password -----------------------------------------------------
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

// --- Delete Account ------------------------------------------------------
app.delete('/api/auth/account', requireAuth, async (req, res) => {
  try {
    await Staff.findByIdAndDelete(req.user.id);
    res.json({ message: 'Account deleted successfully' });
    broadcastDoctors();
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// =========================================================================
// Reference data — public (levels, complaints, consciousness, departments)
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
    res.json(doctors.map(d => d.toJSON()));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch doctors' });
  }
});

app.get('/api/doctors/available', requireAuth, async (req, res) => {
  try {
    const doctors = await Staff.find({ role: 'doctor', isAvailable: true });
    res.json(doctors.map(d => d.toJSON()));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch available doctors' });
  }
});

// =========================================================================
// Patient Management & Live Queue (Auth required)
// =========================================================================
app.use('/api/patients', requireAuth);
app.use('/api/stats', requireAuth);

// --- Create / intake a patient with optional doctor assignment -----------
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
    const history = [
      { event: 'intake', level: triage.level, score: triage.score, byName: req.user.name, byRole: req.user.role },
    ];
    if (assignedDoctor.id) {
      history.push({
        event: `assigned to Dr. ${assignedDoctor.name} (${assignedDoctor.department})`,
        byName: req.user.name,
        byRole: req.user.role,
      });
    }

    const patient = await Patient.create({
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
      history,
    });

    const json = withWait(patient.toJSON());
    res.status(201).json(json);
    broadcastQueue();

    // Notify assigned doctor with full patient situation
    if (assignedDoctor.id) {
      io.emit('doctor:patient_assigned', {
        doctorId: assignedDoctor.id,
        patient: json,
      });
    }
  } catch (err) {
    console.error('Patient intake error:', err);
    res.status(500).json({ error: 'Failed to create patient' });
  }
});

// --- Live queue, sorted by effective priority then arrival -----------------
app.get('/api/patients', async (req, res) => {
  try {
    const filter = req.query.status ? { status: req.query.status } : {};
    if (req.user.role === 'doctor') {
      filter['assignedDoctor.id'] = req.user.id;
    }
    const docs = await Patient.find(filter);
    const list = sortQueue(docs.map(d => d.toJSON()));
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

// --- Assign / Reassign patient to a doctor (Nurse & Admin only) ------------
app.patch('/api/patients/:id/assign', requireRole('nurse', 'admin'), async (req, res) => {
  try {
    const { doctorId } = req.body;
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    if (!doctorId) {
      patient.assignedDoctor = { id: null, name: null, department: null, assignedAt: null };
      patient.history.push({ event: 'unassigned from doctor', byName: req.user.name, byRole: req.user.role });
    } else {
      const doc = await Staff.findById(doctorId);
      if (!doc) return res.status(404).json({ error: 'Doctor not found' });
      patient.assignedDoctor = {
        id: doc._id.toString(),
        name: doc.name,
        department: doc.department || 'General Medicine',
        assignedAt: new Date(),
      };
      patient.history.push({
        event: `assigned to Dr. ${doc.name} (${doc.department})`,
        byName: req.user.name,
        byRole: req.user.role,
      });
    }

    await patient.save();
    const json = withWait(patient.toJSON());
    res.json(json);
    broadcastQueue();

    // Notify assigned doctor with full patient situation
    if (patient.assignedDoctor?.id) {
      io.emit('doctor:patient_assigned', {
        doctorId: patient.assignedDoctor.id,
        patient: json,
      });
    }
  } catch (err) {
    console.error('Assign doctor error:', err);
    res.status(500).json({ error: 'Failed to assign doctor' });
  }
});

// --- Patient timeline audit history ----------------------------------------
app.get('/api/patients/:id/timeline', async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'not found' });
    if (req.user.role === 'doctor' && patient.assignedDoctor?.id !== req.user.id) {
      return res.status(403).json({ error: 'Access restricted to assigned doctor' });
    }
    const json = patient.toJSON();
    res.json({
      id: json.id,
      name: json.name,
      currentLevel: json.overrideLevel ?? json.triage.level,
      history: json.history,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load timeline' });
  }
});

// --- Re-triage vitals update ----------------------------------------------
app.post('/api/patients/:id/retriage', requireRole('nurse', 'doctor'), async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'not found' });

    if (req.user.role === 'doctor') {
      if (!patient.assignedDoctor?.id || patient.assignedDoctor.id !== req.user.id) {
        return res.status(403).json({ error: 'You can only re-triage patients assigned to you by the triage nurse.' });
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
    patient.history.push({ event: 're-triage', level: newTriage.level, score: newTriage.score, byName: req.user.name, byRole: req.user.role });
    await patient.save();

    const deteriorated = newTriage.level < oldLevel;
    const json = { ...withWait(patient.toJSON()), deteriorated };
    res.json(json);
    broadcastQueue();
    if (deteriorated) io.emit('patient:deteriorated', { id: patient.id, name: patient.name, level: newTriage.level });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to re-triage' });
  }
});

// --- Clinician override ----------------------------------------------------
app.post('/api/patients/:id/override', requireRole('nurse', 'doctor'), async (req, res) => {
  try {
    const { level, reason } = req.body;
    if (!level || !reason) return res.status(400).json({ error: 'level and reason are required for an override' });

    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'not found' });

    if (req.user.role === 'doctor') {
      if (!patient.assignedDoctor?.id || patient.assignedDoctor.id !== req.user.id) {
        return res.status(403).json({ error: 'You can only override patients assigned to you by the triage nurse.' });
      }
    }

    patient.overrideLevel = level;
    patient.overrideReason = reason;
    patient.history.push({ event: 'override', level, reason, byName: req.user.name, byRole: req.user.role });
    await patient.save();

    const json = withWait(patient.toJSON());
    res.json(json);
    broadcastQueue();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to override' });
  }
});

// --- Status transitions (waiting / in_progress / discharged) ---------------
app.patch('/api/patients/:id/status', requireRole('nurse', 'doctor'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['waiting', 'in_progress', 'discharged'].includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'not found' });

    // Starting care (in_progress) is strictly reserved for the assigned doctor
    if (status === 'in_progress') {
      if (req.user.role !== 'doctor') {
        return res.status(403).json({ error: 'Only the assigned doctor can start care for this patient.' });
      }
      if (!patient.assignedDoctor?.id || patient.assignedDoctor.id !== req.user.id) {
        return res.status(403).json({ error: 'You can only start care on patients assigned to you by the triage nurse.' });
      }

      // Automatically mark doctor as unavailable (treating patient)
      await Staff.findByIdAndUpdate(req.user.id, { isAvailable: false });
      broadcastDoctors();
    }

    if (req.user.role === 'doctor') {
      if (!patient.assignedDoctor?.id || patient.assignedDoctor.id !== req.user.id) {
        return res.status(403).json({ error: 'You can only attend or update patients assigned to you by the triage nurse.' });
      }
    }

    patient.status = status;
    patient.history.push({ event: `status:${status}`, byName: req.user.name, byRole: req.user.role });
    await patient.save();

    // When discharged, restore doctor availability if no other active cases are in progress
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
    console.error(err);
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

// --- Dashboard stats ---------------------------------------------------------
app.get('/api/stats', async (req, res) => {
  try {
    const filter = req.user.role === 'doctor' ? { 'assignedDoctor.id': req.user.id } : {};
    const all = await Patient.find(filter);
    const active = all.filter(p => p.status !== 'discharged');
    const byLevel = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    active.forEach(p => { byLevel[p.overrideLevel ?? p.triage.level]++; });
    const waits = active.map(p => minutesSince(p.arrivedAt));
    const avgWait = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0;
    const longestWait = waits.length ? Math.max(...waits) : 0;
    const overrideCount = all.filter(p => p.overrideLevel !== null).length;

    res.json({
      totalActive: active.length,
      byLevel,
      avgWait,
      longestWait,
      overrideCount,
      discharged: all.filter(p => p.status === 'discharged').length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

const PORT = process.env.PORT || 4000;

connectDB().then(async () => {
  await seedStaffIfEmpty();
  server.listen(PORT, () => console.log(`PatientTriage.ai backend running on http://localhost:${PORT}`));
});
