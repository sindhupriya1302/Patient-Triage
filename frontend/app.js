const API = 'http://localhost:4000/api';

let REFERENCE = null;
let currentFilter = 'active';          // for nurse queue: 'active' | 'waiting' | 'in_progress' | 'discharged'
let docQueueTab = 'assigned';          // for doctor queue: 'assigned' | 'department' | 'all'
let docStatusFilter = 'active';        // for doctor queue: 'active' | 'waiting' | 'in_progress' | 'discharged'

let activeOverrideId = null;
let activeRetriageId = null;
let activeAssignPatientId = null;

let currentUser = null;   // { id, name, email, role, department, isAvailable }
let authToken = null;
let socket = null;
let latestQueue = [];     // last queue snapshot
let availableDoctors = []; // list of active doctors on duty

// ---------------- DOM Helpers ----------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function levelColor(level) {
  return REFERENCE?.levels?.[level]?.color || '#4f8ff2';
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  if (res.status === 401) {
    logout('Session expired or invalid — please sign in again.');
    throw new Error('Not authenticated');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// =========================================================================
// AUTH & SESSION MANAGEMENT
// =========================================================================
function saveSession(token, user) {
  authToken = token;
  currentUser = user;
  sessionStorage.setItem('pt_token', token);
  sessionStorage.setItem('pt_user', JSON.stringify(user));
  localStorage.setItem('pt_token', token);
  localStorage.setItem('pt_user', JSON.stringify(user));
}

function clearSession() {
  authToken = null;
  currentUser = null;
  sessionStorage.removeItem('pt_token');
  sessionStorage.removeItem('pt_user');
  localStorage.removeItem('pt_token');
  localStorage.removeItem('pt_user');
}

function showLogin() {
  $('#appRoot').classList.add('hidden');
  $('#loginScreen').classList.remove('hidden');
}

function logout(message) {
  if (socket) { socket.disconnect(); socket = null; }
  clearSession();
  showLogin();
  if (message) toast(message);
}

// Auth Tab Switching
$('#tabSignIn').addEventListener('click', () => {
  $('#tabSignIn').classList.add('active');
  $('#tabSignUp').classList.remove('active');
  $('#signInPanel').classList.remove('hidden');
  $('#signUpPanel').classList.add('hidden');
  $('#loginError').textContent = '';
});

$('#tabSignUp').addEventListener('click', () => {
  $('#tabSignUp').classList.add('active');
  $('#tabSignIn').classList.remove('active');
  $('#signUpPanel').classList.remove('hidden');
  $('#signInPanel').classList.add('hidden');
  $('#signupError').textContent = '';
});

// Role selection in Signup form
$('#roleNurseCard').addEventListener('click', () => {
  $('#roleNurseCard').classList.add('selected');
  $('#roleDoctorCard').classList.remove('selected');
  $('#roleNurseCard input').checked = true;
  $('#doctorSpecializationField').classList.add('hidden');
  $('#signupDepartment').removeAttribute('required');
});

$('#roleDoctorCard').addEventListener('click', () => {
  $('#roleDoctorCard').classList.add('selected');
  $('#roleNurseCard').classList.remove('selected');
  $('#roleDoctorCard input').checked = true;
  $('#doctorSpecializationField').classList.remove('hidden');
  $('#signupDepartment').setAttribute('required', 'required');
});

// Sign In Form Submission
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const email = fd.get('email');
  const password = fd.get('password');
  const btn = $('#loginBtn');
  const errBox = $('#loginError');
  errBox.textContent = '';
  btn.disabled = true; btn.textContent = 'Signing in...';

  try {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    saveSession(data.token, data.user);
    await boot();
  } catch (err) {
    errBox.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Sign In';
  }
});

// Sign Up Form Submission
$('#signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const name = fd.get('name');
  const email = fd.get('email');
  const password = fd.get('password');
  const role = fd.get('role');
  const department = fd.get('department');

  const btn = $('#signupBtn');
  const errBox = $('#signupError');
  errBox.textContent = '';

  if (role === 'doctor' && !department) {
    errBox.textContent = 'Please select your department / specialization.';
    return;
  }

  btn.disabled = true; btn.textContent = 'Creating account...';

  try {
    const res = await fetch(`${API}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, role, department }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    saveSession(data.token, data.user);
    await boot();
    toast(`Welcome, ${data.user.name}!`);
  } catch (err) {
    errBox.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Create Account & Enter';
  }
});

// =========================================================================
// FORGOT & RESET PASSWORD CLIENT FLOW
// =========================================================================
let forgotUserEmail = '';

$('#btnGoForgot')?.addEventListener('click', () => {
  $('#signInPanel').classList.add('hidden');
  $('#signUpPanel').classList.add('hidden');
  $('#forgotPanel').classList.remove('hidden');
  $('#tabSignIn').classList.remove('active');
  $('#tabSignUp').classList.remove('active');
  $('#forgotSendError').textContent = '';
  $('#forgotSendSuccess').classList.add('hidden');
  $('#forgotResetForm').classList.add('hidden');
  $('#forgotSendCodeForm').classList.remove('hidden');
  $('#forgotEmailInput').value = $('input[name="email"]').value || '';
});

$('#btnBackToSignIn')?.addEventListener('click', () => {
  $('#forgotPanel').classList.add('hidden');
  $('#signUpPanel').classList.add('hidden');
  $('#signInPanel').classList.remove('hidden');
  $('#tabSignIn').classList.add('active');
  $('#tabSignUp').classList.remove('active');
  $('#loginError').textContent = '';
});

// Step 1: Send verification code
$('#forgotSendCodeForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#forgotEmailInput').value.trim();
  const btn = $('#forgotSendBtn');
  const errBox = $('#forgotSendError');
  const successBox = $('#forgotSendSuccess');
  errBox.textContent = '';
  successBox.classList.add('hidden');

  btn.disabled = true; btn.textContent = 'Sending verification code...';
  try {
    const res = await fetch(`${API}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send verification code');

    forgotUserEmail = email;
    $('#codeSentEmailDisplay').textContent = email;
    $('#forgotSendCodeForm').classList.add('hidden');
    $('#forgotResetForm').classList.remove('hidden');
    toast(`Verification code generated: ${data.verificationCode || 'Sent to email'}`);
  } catch (err) {
    errBox.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Send Verification Code';
  }
});

// Step 2: Verify code & reset password
$('#forgotResetForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#resetCodeInput').value.trim();
  const newPassword = $('#resetNewPassInput').value;
  const confirmPassword = $('#resetConfirmPassInput').value;
  const btn = $('#resetPassBtn');
  const errBox = $('#resetPassError');
  const successBox = $('#resetPassSuccess');
  errBox.textContent = '';
  successBox.classList.add('hidden');

  if (newPassword !== confirmPassword) {
    errBox.textContent = 'New passwords do not match.';
    return;
  }

  btn.disabled = true; btn.textContent = 'Updating password...';
  try {
    const res = await fetch(`${API}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: forgotUserEmail, code, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to reset password');

    successBox.textContent = data.message || 'Password updated successfully!';
    successBox.classList.remove('hidden');
    toast('Password successfully reset! You can now sign in.');

    setTimeout(() => {
      $('#btnBackToSignIn')?.click();
    }, 1500);
  } catch (err) {
    errBox.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Update Password & Sign In';
  }
});

$('#logoutBtn').addEventListener('click', () => logout('Signed out successfully.'));
$('#profileSignOutBtn').addEventListener('click', () => {
  $('#profileBackdrop').classList.add('hidden');
  logout('Signed out successfully.');
});

// =========================================================================
// UI RENDER: TOPBAR & ROLE-SPECIFIC VIEWS
// =========================================================================
function updateTopbar() {
  $('#userName').textContent = currentUser.name;
  $('#userRole').textContent = currentUser.role;
  $('#userAvatar').textContent = (currentUser.name || 'U').charAt(0).toUpperCase();

  const deptPill = $('#userDeptPill');
  if (currentUser.role === 'doctor' && currentUser.department) {
    deptPill.textContent = currentUser.department;
    deptPill.classList.remove('hidden');
  } else {
    deptPill.classList.add('hidden');
  }

  // Doctor Topbar Availability
  const topbarAvail = $('#topbarAvail');
  if (currentUser.role === 'doctor') {
    topbarAvail.classList.remove('hidden');
    updateDoctorAvailabilityUI(currentUser.isAvailable !== false);
  } else {
    topbarAvail.classList.add('hidden');
  }
}

function showApp() {
  $('#loginScreen').classList.add('hidden');
  $('#appRoot').classList.remove('hidden');
  updateTopbar();

  if (currentUser.role === 'nurse') {
    $('#nurseView').classList.remove('hidden');
    $('#doctorView').classList.add('hidden');
  } else if (currentUser.role === 'doctor') {
    $('#doctorView').classList.remove('hidden');
    $('#nurseView').classList.add('hidden');
    $('#docHeaderGreeting').textContent = currentUser.name;
    $('#docHeaderDept').textContent = currentUser.department || 'General Medicine';
  } else {
    // Admin / General view defaults to nurse triage view
    $('#nurseView').classList.remove('hidden');
    $('#doctorView').classList.add('hidden');
  }
}

// =========================================================================
// DOCTOR AVAILABILITY CONTROLS
// =========================================================================
function updateDoctorAvailabilityUI(isAvail) {
  const isOnline = !!isAvail;
  // Topbar switch
  $('#topbarAvailCheck').checked = isOnline;
  $('#topbarAvailText').textContent = isOnline ? 'Available' : 'Off Duty';
  $('#topbarAvailDot').classList.toggle('offline', !isOnline);

  // Doctor Station card
  const circle = $('#docAvailCircle');
  const heading = $('#docAvailHeading');
  const sub = $('#docAvailSub');
  const btnText = $('#docAvailBtnText');

  if (circle) circle.classList.toggle('offline', !isOnline);
  if (heading) heading.textContent = isOnline ? 'Available on Duty' : 'Off Duty / Busy';
  if (sub) sub.textContent = isOnline
    ? 'Nurses can assign new incoming patients to you'
    : 'You are marked unavailable for new patient intake';
  if (btnText) btnText.textContent = isOnline ? 'Set Status: Off Duty' : 'Set Status: Available on Duty';

  // Profile modal availability
  const profDot = $('#profileAvailDot');
  const profLabel = $('#profileAvailLabel');
  const profBtn = $('#profileAvailToggleBtn');
  if (profDot) profDot.classList.toggle('offline', !isOnline);
  if (profLabel) profLabel.textContent = isOnline ? 'Currently Available on Duty' : 'Currently Off Duty / Busy';
  if (profBtn) profBtn.textContent = isOnline ? 'Set Off Duty' : 'Set Available';
}

async function setDoctorAvailability(isAvailable) {
  try {
    const res = await api('/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify({ isAvailable }),
    });
    currentUser.isAvailable = res.user.isAvailable;
    sessionStorage.setItem('pt_user', JSON.stringify(currentUser));
    updateDoctorAvailabilityUI(currentUser.isAvailable);
    toast(`Availability updated: ${currentUser.isAvailable ? 'On Duty' : 'Off Duty'}`);
  } catch (err) {
    toast(`Failed to update availability: ${err.message}`);
  }
}

$('#topbarAvailCheck').addEventListener('change', (e) => {
  setDoctorAvailability(e.target.checked);
});

$('#docAvailToggleBtn')?.addEventListener('click', () => {
  const current = currentUser.isAvailable !== false;
  setDoctorAvailability(!current);
});

$('#profileAvailToggleBtn')?.addEventListener('click', () => {
  const current = currentUser.isAvailable !== false;
  setDoctorAvailability(!current);
});

// =========================================================================
// AVAILABLE DOCTORS ROSTER
// =========================================================================
async function fetchAvailableDoctors() {
  try {
    availableDoctors = await api('/doctors/available');
    populateAvailableDoctorsDropdown();
  } catch (err) {
    console.error('Failed to load available doctors:', err);
  }
}

function populateAvailableDoctorsDropdown() {
  // Nurse station available summary pill
  const pill = $('#availDocsCountPill');
  if (pill) {
    if (availableDoctors.length === 0) {
      pill.textContent = '0 Doctors Available On Duty';
      pill.style.color = 'var(--avail-offline)';
    } else {
      pill.textContent = `${availableDoctors.length} Doctor${availableDoctors.length > 1 ? 's' : ''} Available On Duty`;
      pill.style.color = 'var(--avail-online)';
    }
  }

  // Live Queue Doctor Assignment Modal Select
  const modalSelect = $('#modalAssignDoctorSelect');
  if (modalSelect) {
    modalSelect.innerHTML = '<option value="">— Unassigned (General Queue) —</option>';
    availableDoctors.forEach(doc => {
      const opt = document.createElement('option');
      opt.value = doc.id;
      opt.textContent = `${doc.name} · ${doc.department || 'General'} (Available)`;
      modalSelect.appendChild(opt);
    });
  }
}

// =========================================================================
// REFERENCE DATA & INTAKE FORM SETUP
// =========================================================================
async function loadReference() {
  REFERENCE = await api('/reference');

  const ccSelect = $('#chiefComplaint');
  ccSelect.innerHTML = '';
  Object.entries(REFERENCE.chiefComplaints).forEach(([key, val]) => {
    const opt = document.createElement('option');
    opt.value = key; opt.textContent = val.label;
    ccSelect.appendChild(opt);
  });

  const avpuSelect = $('#consciousness');
  avpuSelect.innerHTML = '';
  Object.entries(REFERENCE.consciousnessOptions).forEach(([key, val]) => {
    const opt = document.createElement('option');
    opt.value = key; opt.textContent = val.label;
    avpuSelect.appendChild(opt);
  });

  const overrideSelect = $('#overrideLevel');
  overrideSelect.innerHTML = '';
  Object.entries(REFERENCE.levels).forEach(([key, val]) => {
    const opt = document.createElement('option');
    opt.value = key; opt.textContent = val.label;
    overrideSelect.appendChild(opt);
  });
}

// ---------------- Patient Intake Form Submission ----------------
$('#intakeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);

  const payload = {
    name: fd.get('name'),
    age: fd.get('age') ? Number(fd.get('age')) : null,
    sex: fd.get('sex') || null,
    onsetMinutesAgo: fd.get('onsetMinutesAgo') ? Number(fd.get('onsetMinutesAgo')) : null,
    chiefComplaint: fd.get('chiefComplaint'),
    consciousness: fd.get('consciousness') || 'alert',
    painScore: fd.get('painScore') ? Number(fd.get('painScore')) : null,
    severeBleeding: fd.get('severeBleeding') === 'on',
    comorbidities: fd.getAll('comorbidities'),
    notes: fd.get('notes') || '',
    vitals: {
      hr: fd.get('hr') ? Number(fd.get('hr')) : null,
      sbp: fd.get('sbp') ? Number(fd.get('sbp')) : null,
      rr: fd.get('rr') ? Number(fd.get('rr')) : null,
      spo2: fd.get('spo2') ? Number(fd.get('spo2')) : null,
      tempC: fd.get('tempC') ? Number(fd.get('tempC')) : null,
    },
  };

  const btn = $('#submitBtn');
  btn.disabled = true; btn.textContent = 'Scoring triage...';
  try {
    const patient = await api('/patients', { method: 'POST', body: JSON.stringify(payload) });
    showLastResult(patient);
    e.target.reset();
    if ($('#consciousness')) $('#consciousness').value = 'alert';
    await fetchQueueOnce();
    renderQueue();
    refreshStats();
    toast(`${patient.name} admitted to ED live queue — ${patient.triage?.levelLabel || 'Assessed'}`);
  } catch (err) {
    toast(`Error: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Run Triage Assessment & Admit';
  }
});

function showLastResult(patient) {
  const box = $('#lastResult');
  if (!box) return;
  box.classList.remove('hidden');
  const triage = patient.triage || {};
  const docNameFormatted = patient.assignedDoctor?.name
    ? (patient.assignedDoctor.name.toLowerCase().startsWith('dr') ? patient.assignedDoctor.name : `Dr. ${patient.assignedDoctor.name}`)
    : '';
  const docNote = patient.assignedDoctor?.name
    ? `<div style="margin-top:6px;font-weight:600;color:var(--accent);">Assigned: ${escapeHtml(docNameFormatted)} (${escapeHtml(patient.assignedDoctor.department || 'Specialist')})</div>`
    : '<div style="margin-top:6px;font-size:0.75rem;color:var(--text-dim);">Status: Added to General Queue (Assign doctor in Live Queue below)</div>';

  box.style.borderLeft = `4px solid ${triage.color || 'var(--accent)'}`;
  box.innerHTML = `
    <h4>${escapeHtml(patient.name || 'Patient')} — ${triage.levelLabel || 'Triage Assessed'}</h4>
    <p style="margin:0 0 8px;color:var(--text-muted);font-size:0.82rem;">${triage.recommendedAction || 'Admitted to live queue'} · score ${triage.score || 0}/100</p>
    <ul style="margin:0;padding-left:18px;font-size:0.78rem;color:var(--text-muted);">
      ${(triage.topReasons || []).map(r => `<li>${escapeHtml(r.text)} <span style="color:var(--text-dim)">(+${r.points})</span></li>`).join('') || '<li>No notable risk factors identified</li>'}
    </ul>
    ${docNote}
  `;
}

// =========================================================================
// QUEUE RENDERING (NURSE & DOCTOR VIEWS)
// =========================================================================
function renderQueue() {
  if (currentUser.role === 'doctor') {
    renderDoctorQueue();
  } else {
    renderNurseQueue();
  }
  updateDoctorMetrics();
}

// ---------------- Nurse Live Queue ----------------
function renderNurseQueue() {
  let list = latestQueue;
  if (currentFilter === 'active') list = list.filter(p => p.status !== 'discharged');
  else list = list.filter(p => p.status === currentFilter);

  const container = $('#nurseQueueList');
  if (!container) return;
  container.innerHTML = '';

  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state">No patients in this view.<br>Use the intake form on the left to admit an incoming patient.</div>`;
    return;
  }

  list.forEach(p => container.appendChild(renderNursePatientCard(p)));
}

function renderNursePatientCard(p) {
  const effLevel = p.overrideLevel ?? p.triage.level;
  const color = levelColor(effLevel);
  const el = document.createElement('div');
  el.className = 'card' + (effLevel <= 2 && p.status === 'waiting' ? ' pulse' : '');
  el.style.setProperty('--lvl-color', color);

  const ageSex = [p.age != null ? `${p.age}y` : null, p.sex].filter(Boolean).join(' · ');
  const complaintLabel = REFERENCE.chiefComplaints[p.chiefComplaint]?.label || p.chiefComplaint;
  const overrideNote = p.overrideLevel
    ? `<div class="override-note">Overridden to Level ${p.overrideLevel} by clinician: "${escapeHtml(p.overrideReason)}"</div>`
    : '';

  const docNameFormatted = p.assignedDoctor?.name
    ? (p.assignedDoctor.name.toLowerCase().startsWith('dr') ? p.assignedDoctor.name : `Dr. ${p.assignedDoctor.name}`)
    : '';
  const docTag = p.assignedDoctor?.name
    ? `<div class="assigned-doc-tag">🩺 Assigned: ${escapeHtml(docNameFormatted)} · ${escapeHtml(p.assignedDoctor.department || 'Specialist')}</div>`
    : `<div class="assigned-doc-tag unassigned">Unassigned (General Queue)</div>`;

  el.innerHTML = `
    <div class="card-main">
      <div class="card-top">
        <span class="level-badge" style="--lvl-color:${color}">${REFERENCE.levels[effLevel].label}</span>
        <span class="patient-name">${escapeHtml(p.name)}</span>
        <span class="patient-meta">${ageSex}</span>
        ${p.status === 'in_progress' ? '<span class="patient-meta" style="color:var(--accent);">· being seen</span>' : ''}
        ${p.status === 'discharged' ? '<span class="patient-meta">· discharged</span>' : ''}
      </div>
      <div>${docTag}</div>
      <div class="complaint">${escapeHtml(complaintLabel)}${p.notes ? ` — <span style="color:var(--text-dim)">${escapeHtml(p.notes)}</span>` : ''}</div>
      <div class="card-actions-inline">
        <button class="reasons-toggle" data-id="${p.id}">Why this priority? (score ${p.triage.score}/100)</button>
        <button class="timeline-toggle" data-action="timeline" data-id="${p.id}">Timeline</button>
      </div>
      <div class="reasons" id="reasons-${p.id}">
        ${p.triage.flags.map(f => `<div class="flag">⚠ ${escapeHtml(f)}</div>`).join('')}
        <ul>${p.triage.topReasons.map(r => `<li>${escapeHtml(r.text)} <span style="color:var(--text-dim)">(+${r.points})</span></li>`).join('') || '<li>No notable risk factors identified</li>'}</ul>
        ${overrideNote}
      </div>
    </div>
    <div class="card-side">
      ${p.status !== 'discharged' ? `<div><div class="wait">${p.waitingMinutes}m</div><div class="wait-label">waiting</div></div>` : ''}
      <div class="action-row">
        ${p.status !== 'discharged' ? `<button class="btn btn-ghost btn-small" data-action="assign-doc" data-id="${p.id}">Assign Doctor</button>` : ''}
        ${p.status !== 'discharged' ? `<button class="btn btn-ghost btn-small" data-action="retriage" data-id="${p.id}">Re-triage</button>` : ''}
        ${p.status !== 'discharged' ? `<button class="btn btn-ghost btn-small" data-action="override" data-id="${p.id}">Override</button>` : ''}
        ${p.status !== 'discharged' ? `<button class="btn btn-ghost btn-small" data-action="discharge" data-id="${p.id}">Discharge</button>` : ''}
      </div>
    </div>
  `;
  return el;
}

// ---------------- Doctor Live Queue ----------------
function renderDoctorQueue() {
  // Doctor only sees patients assigned to him/her by triage nurse
  let list = latestQueue.filter(p => p.assignedDoctor?.id === currentUser.id);

  // Status filter
  if (docStatusFilter === 'active') list = list.filter(p => p.status !== 'discharged');
  else list = list.filter(p => p.status === docStatusFilter);

  const container = $('#doctorQueueList');
  if (!container) return;
  container.innerHTML = '';

  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state">No patients currently assigned to you.<br>Patients assigned to you by the triage nurse will appear here in real time.</div>`;
    return;
  }

  list.forEach(p => container.appendChild(renderDoctorPatientCard(p)));
}

function renderPatientHealthCondition(p) {
  const v = p.vitals || {};
  const comorbidities = p.comorbidities || [];

  const vitalsBadges = [
    v.hr != null ? `<span class="vital-chip"><span class="vital-chip-label">HR</span> <strong>${v.hr}</strong> <small>bpm</small></span>` : null,
    v.sbp != null ? `<span class="vital-chip"><span class="vital-chip-label">BP</span> <strong>${v.sbp}</strong> <small>mmHg</small></span>` : null,
    v.rr != null ? `<span class="vital-chip"><span class="vital-chip-label">RR</span> <strong>${v.rr}</strong> <small>/min</small></span>` : null,
    v.spo2 != null ? `<span class="vital-chip ${v.spo2 < 92 ? 'vital-critical' : ''}"><span class="vital-chip-label">SpO₂</span> <strong>${v.spo2}%</strong></span>` : null,
    v.tempC != null ? `<span class="vital-chip ${v.tempC > 38.5 ? 'vital-critical' : ''}"><span class="vital-chip-label">Temp</span> <strong>${v.tempC}°C</strong></span>` : null,
    p.painScore != null ? `<span class="vital-chip ${p.painScore >= 7 ? 'vital-critical' : ''}"><span class="vital-chip-label">Pain</span> <strong>${p.painScore}/10</strong></span>` : null,
    p.consciousness ? `<span class="vital-chip"><span class="vital-chip-label">AVPU</span> <strong>${escapeHtml(p.consciousness.toUpperCase())}</strong></span>` : null,
  ].filter(Boolean);

  const clinicalBadges = [
    p.onsetMinutesAgo != null ? `<span class="health-badge"><span class="badge-icon">⏱</span> Onset: ${p.onsetMinutesAgo}m ago</span>` : null,
    p.severeBleeding ? `<span class="health-badge alert"><span class="badge-icon">🩸</span> Severe / Active Bleeding</span>` : null,
    ...comorbidities.map(c => `<span class="health-badge comorb"><span class="badge-icon">✚</span> ${escapeHtml(c.charAt(0).toUpperCase() + c.slice(1))}</span>`),
  ].filter(Boolean);

  return `
    <div class="patient-health-section">
      <div class="health-header">
        <span class="health-section-title">🩺 Patient Health Condition & Vitals</span>
      </div>
      <div class="vitals-row">
        ${vitalsBadges.length ? vitalsBadges.join('') : '<span class="vital-chip-muted">Vitals not recorded at intake</span>'}
      </div>
      ${clinicalBadges.length ? `<div class="clinical-tags-row">${clinicalBadges.join('')}</div>` : ''}
      ${p.notes ? `<div class="nurse-notes-box"><span class="notes-icon">📝</span> <strong>Nurse Notes:</strong> ${escapeHtml(p.notes)}</div>` : ''}
    </div>
  `;
}

function renderDoctorPatientCard(p) {
  const effLevel = p.overrideLevel ?? p.triage.level;
  const color = levelColor(effLevel);

  const el = document.createElement('div');
  el.className = 'card assigned-to-current-user' + (effLevel <= 2 && p.status === 'waiting' ? ' pulse' : '');
  el.style.setProperty('--lvl-color', color);
  el.dataset.id = p.id;

  const ageSex = [p.age != null ? `${p.age}y` : null, p.sex].filter(Boolean).join(' · ');
  const complaintLabel = REFERENCE.chiefComplaints[p.chiefComplaint]?.label || p.chiefComplaint;
  const overrideNote = p.overrideLevel
    ? `<div class="override-note">Overridden to Level ${p.overrideLevel} by clinician: "${escapeHtml(p.overrideReason)}"</div>`
    : '';

  const docTag = `<div class="assigned-doc-tag" style="background:rgba(167,139,250,0.15);border-color:var(--doctor-color);color:var(--doctor-color);">⭐ Assigned to You (${escapeHtml(currentUser.department || 'Specialist')})</div>`;

  el.innerHTML = `
    <div class="card-main">
      <div class="card-top">
        <span class="level-badge" style="--lvl-color:${color}">${REFERENCE.levels[effLevel].label}</span>
        <span class="patient-name">${escapeHtml(p.name)}</span>
        <span class="patient-meta">${ageSex}</span>
        ${p.status === 'in_progress' ? '<span class="patient-meta" style="color:var(--accent);font-weight:600;">· IN TREATMENT</span>' : ''}
        ${p.status === 'discharged' ? '<span class="patient-meta">· discharged</span>' : ''}
      </div>
      <div>${docTag}</div>
      <div class="complaint">${escapeHtml(complaintLabel)}</div>
      
      <!-- Patient Health Condition & Intake Details -->
      ${renderPatientHealthCondition(p)}

      <div class="card-actions-inline" style="margin-top:10px;">
        <button class="reasons-toggle" data-id="${p.id}">Why this priority? (score ${p.triage.score}/100)</button>
        <button class="timeline-toggle" data-action="timeline" data-id="${p.id}">Audit Timeline</button>
      </div>
      <div class="reasons" id="reasons-${p.id}">
        ${p.triage.flags.map(f => `<div class="flag">⚠ ${escapeHtml(f)}</div>`).join('')}
        <ul>${p.triage.topReasons.map(r => `<li>${escapeHtml(r.text)} <span style="color:var(--text-dim)">(+${r.points})</span></li>`).join('') || '<li>No notable risk factors identified</li>'}</ul>
        ${overrideNote}
      </div>
    </div>
    <div class="card-side">
      ${p.status !== 'discharged' ? `<div><div class="wait">${p.waitingMinutes}m</div><div class="wait-label">waiting</div></div>` : ''}
      <div class="action-row">
        ${p.status === 'waiting' ? `<button class="btn btn-primary btn-small" data-action="start" data-id="${p.id}">Attend Patient</button>` : ''}
        ${p.status !== 'discharged' ? `<button class="btn btn-ghost btn-small" data-action="retriage" data-id="${p.id}">Re-triage</button>` : ''}
        ${p.status !== 'discharged' ? `<button class="btn btn-ghost btn-small" data-action="override" data-id="${p.id}">Override</button>` : ''}
        ${p.status !== 'discharged' ? `<button class="btn btn-ghost btn-small" data-action="discharge" data-id="${p.id}">Discharge</button>` : ''}
      </div>
    </div>
  `;
  return el;
}

// Update doctor quick metrics
function updateDoctorMetrics() {
  if (currentUser?.role !== 'doctor') return;
  const myPatients = latestQueue.filter(p => p.assignedDoctor?.id === currentUser.id);
  const active = myPatients.filter(p => p.status !== 'discharged');
  const waiting = active.filter(p => p.status === 'waiting');
  const inTreatment = active.filter(p => p.status === 'in_progress');
  const critical = active.filter(p => (p.overrideLevel ?? p.triage.level) <= 2);

  const elAssigned = $('#docStatAssigned');
  const elWaiting = $('#docStatWaiting');
  const elInTreatment = $('#docStatInTreatment');
  const elCritical = $('#docStatCritical');
  const elTabCount = $('#docTabAssignedCount');

  if (elAssigned) elAssigned.textContent = active.length;
  if (elWaiting) elWaiting.textContent = waiting.length;
  if (elInTreatment) elInTreatment.textContent = inTreatment.length;
  if (elCritical) elCritical.textContent = critical.length;
  if (elTabCount) elTabCount.textContent = active.length;
}

// ---------------- Global Queue Click Delegation ----------------
document.addEventListener('click', async (e) => {
  const reasonsToggle = e.target.closest('.reasons-toggle');
  if (reasonsToggle) {
    const panel = $(`#reasons-${reasonsToggle.dataset.id}`);
    if (panel) panel.classList.toggle('open');
    return;
  }

  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === 'start') {
    await api(`/patients/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'in_progress' }) });
    toast('Patient marked as In Treatment');
  } else if (action === 'discharge') {
    await api(`/patients/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'discharged' }) });
    toast('Patient discharged from ED queue');
  } else if (action === 'assign-doc') {
    openAssignDoctorModal(id);
  } else if (action === 'override') {
    openOverrideModal(id);
  } else if (action === 'retriage') {
    openRetriageModal(id);
  } else if (action === 'timeline') {
    openTimelineModal(id);
  }
});

// =========================================================================
// MODALS LOGIC
// =========================================================================

// ---------------- Doctor Assignment Modal ----------------
function openAssignDoctorModal(id) {
  activeAssignPatientId = id;
  const p = latestQueue.find(x => x.id === id);
  if (!p) return;

  $('#assignDoctorPatientInfo').textContent = `Assign ${p.name} (${REFERENCE.chiefComplaints[p.chiefComplaint]?.label || p.chiefComplaint})`;
  const select = $('#modalAssignDoctorSelect');
  select.value = p.assignedDoctor?.id || '';
  $('#assignDoctorBackdrop').classList.remove('hidden');
}

$('#assignDoctorCancel').addEventListener('click', () => $('#assignDoctorBackdrop').classList.add('hidden'));
$('#assignDoctorConfirm').addEventListener('click', async () => {
  const doctorId = $('#modalAssignDoctorSelect').value || null;
  try {
    await api(`/patients/${activeAssignPatientId}/assign`, {
      method: 'PATCH',
      body: JSON.stringify({ doctorId }),
    });
    $('#assignDoctorBackdrop').classList.add('hidden');
    toast('Doctor assignment updated');
  } catch (err) {
    toast(`Assignment failed: ${err.message}`);
  }
});

// ---------------- Override Modal ----------------
function openOverrideModal(id) {
  activeOverrideId = id;
  $('#overrideReason').value = '';
  $('#overrideBackdrop').classList.remove('hidden');
}
$('#overrideCancel').addEventListener('click', () => $('#overrideBackdrop').classList.add('hidden'));
$('#overrideConfirm').addEventListener('click', async () => {
  const level = Number($('#overrideLevel').value);
  const reason = $('#overrideReason').value.trim();
  if (!reason) { toast('A reason is required to override'); return; }
  await api(`/patients/${activeOverrideId}/override`, { method: 'POST', body: JSON.stringify({ level, reason }) });
  $('#overrideBackdrop').classList.add('hidden');
  toast('Clinician override logged');
});

// ---------------- Re-triage Modal ----------------
function openRetriageModal(id) {
  activeRetriageId = id;
  ['rtHr','rtSbp','rtRr','rtSpo2','rtTemp','rtPain'].forEach(f => $(`#${f}`).value = '');
  $('#retriageBackdrop').classList.remove('hidden');
}
$('#retriageCancel').addEventListener('click', () => $('#retriageBackdrop').classList.add('hidden'));
$('#retriageConfirm').addEventListener('click', async () => {
  const body = {
    vitals: {
      hr: numOrUndef('#rtHr'), sbp: numOrUndef('#rtSbp'), rr: numOrUndef('#rtRr'),
      spo2: numOrUndef('#rtSpo2'), tempC: numOrUndef('#rtTemp'),
    },
    painScore: numOrUndef('#rtPain'),
  };
  Object.keys(body.vitals).forEach(k => body.vitals[k] === undefined && delete body.vitals[k]);
  const result = await api(`/patients/${activeRetriageId}/retriage`, { method: 'POST', body: JSON.stringify(body) });
  $('#retriageBackdrop').classList.add('hidden');
  toast(result.deteriorated ? `⚠ ${result.name} re-triaged to a MORE urgent level` : 'Re-triage complete');
});

function numOrUndef(sel) {
  const v = $(sel).value;
  return v === '' ? undefined : Number(v);
}

// ---------------- Timeline Modal ----------------
async function openTimelineModal(id) {
  try {
    const data = await api(`/patients/${id}/timeline`);
    $('#timelineTitle').textContent = `${data.name} — Timeline`;
    const list = $('#timelineList');
    list.innerHTML = '';
    data.history.slice().reverse().forEach(h => {
      const li = document.createElement('li');
      const lvl = h.level ? REFERENCE.levels[h.level] : null;
      if (lvl) li.style.setProperty('--lvl-color', lvl.color);
      const who = h.byName ? `${escapeHtml(h.byName)} (${escapeHtml(h.byRole)})` : 'System';
      const when = new Date(h.at).toLocaleString();
      li.innerHTML = `
        <div class="timeline-event">${escapeHtml(h.event.replace(':', ' → '))}${lvl ? ` — ${lvl.label}` : ''}</div>
        <div class="timeline-meta">${when} · ${who}</div>
        ${h.reason ? `<div class="timeline-reason">"${escapeHtml(h.reason)}"</div>` : ''}
      `;
      list.appendChild(li);
    });
    $('#timelineBackdrop').classList.remove('hidden');
  } catch (err) {
    toast(`Could not load timeline: ${err.message}`);
  }
}
$('#timelineClose').addEventListener('click', () => $('#timelineBackdrop').classList.add('hidden'));

// =========================================================================
// PROFILE MODAL & ACCOUNT MANAGEMENT
// =========================================================================
function openProfileModal() {
  $('#profileAvatarLarge').textContent = (currentUser.name || 'U').charAt(0).toUpperCase();
  $('#profileNameDisplay').textContent = currentUser.name;
  $('#profileRoleDisplay').textContent = currentUser.role.toUpperCase();
  $('#profileEmailDisplay').textContent = currentUser.email || '';

  const profDept = $('#profileDeptDisplay');
  if (currentUser.role === 'doctor' && currentUser.department) {
    profDept.textContent = currentUser.department;
    profDept.classList.remove('hidden');
    $('#profileDoctorAvailSection').classList.remove('hidden');
    $('#editProfileDeptGroup').classList.remove('hidden');
    $('#editProfileDept').value = currentUser.department;
    updateDoctorAvailabilityUI(currentUser.isAvailable !== false);
  } else {
    profDept.classList.add('hidden');
    $('#profileDoctorAvailSection').classList.add('hidden');
    $('#editProfileDeptGroup').classList.add('hidden');
  }

  $('#editProfileName').value = currentUser.name;
  $('#editProfileEmail').value = currentUser.email || '';
  $('#editProfileFeedback').textContent = '';
  $('#passwordFeedback').textContent = '';

  $('#profileBackdrop').classList.remove('hidden');
}

$('#userBadge').addEventListener('click', openProfileModal);
$('#profileCloseTop').addEventListener('click', () => $('#profileBackdrop').classList.add('hidden'));
$('#profileCloseBtn').addEventListener('click', () => $('#profileBackdrop').classList.add('hidden'));

// Edit Profile Form Submission
$('#editProfileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#editProfileName').value.trim();
  const email = $('#editProfileEmail').value.trim();
  const department = currentUser.role === 'doctor' ? $('#editProfileDept').value : undefined;
  const feedback = $('#editProfileFeedback');
  feedback.className = 'form-feedback'; feedback.textContent = 'Saving changes...';

  try {
    const res = await api('/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify({ name, email, department }),
    });
    saveSession(res.token, res.user);
    updateTopbar();
    $('#profileNameDisplay').textContent = res.user.name;
    $('#profileEmailDisplay').textContent = res.user.email;
    if (res.user.department) $('#profileDeptDisplay').textContent = res.user.department;
    feedback.className = 'form-feedback success';
    feedback.textContent = 'Profile updated successfully!';
    toast('Profile changes saved');
  } catch (err) {
    feedback.className = 'form-feedback error';
    feedback.textContent = err.message;
  }
});

// Change Password Form Submission
$('#changePasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const currentPassword = $('#currentPasswordInput').value;
  const newPassword = $('#newPasswordInput').value;
  const confirmNewPassword = $('#confirmNewPasswordInput').value;
  const feedback = $('#passwordFeedback');
  feedback.className = 'form-feedback';

  if (newPassword !== confirmNewPassword) {
    feedback.className = 'form-feedback error';
    feedback.textContent = 'New passwords do not match.';
    return;
  }

  try {
    await api('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    feedback.className = 'form-feedback success';
    feedback.textContent = 'Password changed successfully!';
    $('#changePasswordForm').reset();
    toast('Password changed successfully');
  } catch (err) {
    feedback.className = 'form-feedback error';
    feedback.textContent = err.message;
  }
});

// Delete Account Confirmation
$('#profileDeleteAccountBtn').addEventListener('click', () => {
  $('#deleteAccountBackdrop').classList.remove('hidden');
});

$('#deleteAccountCancel').addEventListener('click', () => {
  $('#deleteAccountBackdrop').classList.add('hidden');
});

$('#deleteAccountConfirm').addEventListener('click', async () => {
  try {
    await api('/auth/account', { method: 'DELETE' });
    $('#deleteAccountBackdrop').classList.add('hidden');
    $('#profileBackdrop').classList.add('hidden');
    logout('Your account has been deleted.');
  } catch (err) {
    toast(`Failed to delete account: ${err.message}`);
  }
});

// =========================================================================
// STATS & DISTRIBUTION
// =========================================================================
async function refreshStats() {
  const stats = await api('/stats');
  $('#statActive').textContent = stats.totalActive;
  $('#statAvgWait').textContent = stats.avgWait;
  $('#statLongest').textContent = stats.longestWait;
  $('#statOverrides').textContent = stats.overrideCount;

  const total = Object.values(stats.byLevel).reduce((a, b) => a + b, 0) || 1;
  const dist = $('#distribution');
  dist.innerHTML = '';
  [1, 2, 3, 4, 5].forEach(level => {
    const count = stats.byLevel[level];
    if (count === 0) return;
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.style.width = `${(count / total) * 100}%`;
    seg.style.background = levelColor(level);
    seg.title = `${REFERENCE.levels[level].label}: ${count}`;
    dist.appendChild(seg);
  });
}

async function fetchQueueOnce() {
  latestQueue = await api('/patients');
  renderQueue();
}

async function refreshAll() {
  await Promise.all([fetchQueueOnce(), refreshStats(), fetchAvailableDoctors()]);
}

// ---------------- Filter Handlers ----------------
$('#queueFilters')?.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $$('#queueFilters .chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  currentFilter = chip.dataset.filter;
  renderQueue();
});

$('#docStatusFilters')?.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $$('#docStatusFilters .chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  docStatusFilter = chip.dataset.filter;
  renderQueue();
});

// Live clock
function tickClock() {
  $('#clock').textContent = new Date().toLocaleTimeString();
}
setInterval(tickClock, 1000);
tickClock();

// Synthesized pleasant notification chime via Web Audio API
function playAlertChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.15); // A5
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.6);
  } catch (e) {
    // Audio Context may require initial user click in some browsers
  }
}

// Display high-priority interactive notification banner for doctors
function showDoctorPatientAlert(p) {
  playAlertChime();
  const container = $('#doctorNotificationCenter');
  if (!container) return;

  const effLevel = p.overrideLevel ?? p.triage?.level ?? 3;
  const color = levelColor(effLevel);
  const v = p.vitals || {};
  const complaintLabel = REFERENCE.chiefComplaints?.[p.chiefComplaint]?.label || p.chiefComplaint;
  const ageSex = [p.age != null ? `${p.age}y` : null, p.sex].filter(Boolean).join(' · ');

  const vitalsSummary = [
    v.hr ? `HR: <strong>${v.hr}</strong> bpm` : null,
    v.sbp ? `BP: <strong>${v.sbp}</strong> mmHg` : null,
    v.spo2 ? `SpO₂: <strong>${v.spo2}%</strong>` : null,
    v.tempC ? `Temp: <strong>${v.tempC}°C</strong>` : null,
    p.painScore != null ? `Pain: <strong>${p.painScore}/10</strong>` : null,
  ].filter(Boolean).join(' | ');

  const situationFlags = [
    p.severeBleeding ? '<span class="notif-badge danger">🩸 Severe Bleeding</span>' : '',
    p.consciousness && p.consciousness !== 'alert' ? `<span class="notif-badge warning">AVPU: ${escapeHtml(p.consciousness.toUpperCase())}</span>` : '',
    ...(p.comorbidities || []).map(c => `<span class="notif-badge comorb">✚ ${escapeHtml(c)}</span>`),
  ].filter(Boolean).join(' ');

  const card = document.createElement('div');
  card.className = 'doc-alert-card';
  card.style.borderLeftColor = color;
  card.innerHTML = `
    <div class="doc-alert-header">
      <div class="doc-alert-title-row">
        <span class="doc-alert-badge" style="background:${color}; color:#0a0f1a;">Level ${effLevel} · ${REFERENCE.levels?.[effLevel]?.label || ''}</span>
        <span class="doc-alert-heading">🚨 New Patient Assigned to Your Station!</span>
      </div>
      <button class="doc-alert-close" title="Dismiss">&times;</button>
    </div>
    <div class="doc-alert-body">
      <div class="doc-alert-patient-name">${escapeHtml(p.name)} <span class="doc-alert-meta">(${ageSex || 'Age N/A'})</span></div>
      <div class="doc-alert-complaint"><strong>Chief Complaint:</strong> ${escapeHtml(complaintLabel)}</div>
      ${vitalsSummary ? `<div class="doc-alert-vitals">${vitalsSummary}</div>` : ''}
      ${situationFlags ? `<div class="doc-alert-flags">${situationFlags}</div>` : ''}
      ${p.notes ? `<div class="doc-alert-notes"><strong>Nurse Notes:</strong> ${escapeHtml(p.notes)}</div>` : ''}
    </div>
    <div class="doc-alert-actions">
      <button class="btn btn-primary btn-small doc-alert-btn-attend" data-id="${p.id}">Review & Attend Patient</button>
    </div>
  `;

  // Close dismiss handler
  card.querySelector('.doc-alert-close').addEventListener('click', () => {
    card.classList.add('dismissing');
    setTimeout(() => card.remove(), 250);
  });

  // Review & Attend handler
  card.querySelector('.doc-alert-btn-attend').addEventListener('click', () => {
    card.remove();
    // Scroll smoothly to doctor live queue and highlight the patient card
    const targetCard = $(`#doctorQueueList .card[data-id="${p.id}"]`) || document.querySelector(`#doctorQueueList`);
    if (targetCard) {
      targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetCard.classList.add('highlight-glow');
      setTimeout(() => targetCard.classList.remove('highlight-glow'), 4500);
    }
  });

  container.prepend(card);

  // Auto-dismiss after 15 seconds
  setTimeout(() => {
    if (card.parentNode) {
      card.classList.add('dismissing');
      setTimeout(() => card.remove(), 250);
    }
  }, 15000);
}

// =========================================================================
// REAL-TIME SYNC (SOCKET.IO)
// =========================================================================
function connectSocket() {
  socket = io('http://localhost:4000', { transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    $('#liveDot').classList.add('on');
  });

  socket.on('disconnect', () => {
    $('#liveDot').classList.remove('on');
  });

  socket.on('queue:update', (list) => {
    latestQueue = list;
    renderQueue();
    refreshStats();
  });

  socket.on('doctors:update', (docs) => {
    availableDoctors = docs.filter(d => d.isAvailable !== false);
    populateAvailableDoctorsDropdown();
    // If current doctor's availability was updated remotely
    if (currentUser?.role === 'doctor') {
      const me = docs.find(d => d.id === currentUser.id);
      if (me && me.isAvailable !== currentUser.isAvailable) {
        currentUser.isAvailable = me.isAvailable;
        updateDoctorAvailabilityUI(currentUser.isAvailable);
      }
    }
  });

  // Real-time notification when a patient is assigned to this doctor
  socket.on('doctor:patient_assigned', (data) => {
    if (!currentUser || currentUser.role !== 'doctor') return;
    if (data.doctorId === currentUser.id) {
      showDoctorPatientAlert(data.patient);
      refreshAll();
    }
  });

  socket.on('patient:deteriorated', (info) => {
    toast(`⚠ Acuity Warning: ${info.name} deteriorated to ${REFERENCE.levels[info.level]?.label || 'urgent'}`);
  });
}

// =========================================================================
// BOOTSTRAP APPLICATION
// =========================================================================
async function boot() {
  try {
    showApp();
    await loadReference();
    await refreshAll();
    connectSocket();

    clearInterval(boot._poll);
    boot._poll = setInterval(refreshAll, 15000);
  } catch (err) {
    toast('Could not connect to the backend server on localhost:4000.');
    console.error(err);
  }
}

(function init() {
  const token = sessionStorage.getItem('pt_token') || localStorage.getItem('pt_token');
  const userRaw = sessionStorage.getItem('pt_user') || localStorage.getItem('pt_user');
  if (token && userRaw) {
    try {
      authToken = token;
      currentUser = JSON.parse(userRaw);
      sessionStorage.setItem('pt_token', token);
      sessionStorage.setItem('pt_user', userRaw);
      boot();
      return;
    } catch (e) {
      clearSession();
    }
  }
  showLogin();
})();

