# PatientTriage.ai

**AI-Assisted Emergency Department Clinical Decision Support & Real-Time Patient Routing System**

PatientTriage.ai is an intelligent clinical decision-support portal designed for Emergency Departments (ED). It assists triage nurses and attending physicians in prioritizing incoming patients, assessing physiological risk factors with explainable AI, routing patients to available on-duty specialists, and tracking patient care in real time.

---

## Core Features

### 1. AI Clinical Decision Support (`triageEngine.js`)
- **5-Level Acuity Scale**: Modeled on the Emergency Severity Index (ESI):
  - **Level 1 - Resuscitation (Red)**: Immediate life-saving intervention (e.g., cardiac arrest, SpO2 < 90%, unresponsiveness).
  - **Level 2 - Emergent (Orange)**: High risk, severe pain (>= 8/10), altered mental status, severe vitals instability.
  - **Level 3 - Urgent (Yellow)**: Moderate distress requiring multiple hospital resources.
  - **Level 4 - Less Urgent (Green)**: Stable vitals requiring simple evaluation.
  - **Level 5 - Non-Urgent (Blue)**: Low-acuity, minor symptoms.
- **Explainable AI Score (0-100)**: Provides a breakdown of contributing risk factors (vitals deviation, symptom onset time, comorbidities, active bleeding, age-related risk).
- **Deterioration Detection**: Re-triaging flags vital sign deterioration in real time across all connected clinical screens.

### 2. Nurse Triage Station
- **Comprehensive Patient Intake**: Captures vitals (HR, SBP, RR, SpO2, Temp, Pain score), AVPU consciousness, chief complaint, severe bleeding flags, comorbidities, and intake notes.
- **Auto-Clearing Intake Form**: After submitting intake, the patient is immediately scored and admitted to the live queue, and the form resets automatically for the next patient.
- **Specialist Doctor Assignment**: Dynamically lists available on-duty doctors with real-time on-duty counts.
- **Clinical Actions**: Re-triage deterioration check, clinician acuity override (with reason tracking), doctor reassignment, and discharge.

### 3. Doctor Station & Patient Health Condition Strip
- **Doctor-Specific Queue**: Doctors only receive patients specifically assigned to them by the triage nurse.
- **Assigned ED Metrics**: Live Queue, Average Waiting Time, Longest Wait, and Urgency distribution calculated strictly for the doctor's assigned patients.
- **Patient Health Condition Strip**: Full clinical visibility into vitals, AVPU consciousness level, active bleeding warnings, comorbidity badges, and nurse intake notes directly on each patient card.
- **Start Care / Attend Patient**: Starting treatment (`in_progress`) is reserved exclusively for the assigned doctor.

### 4. Real-Time Doctor Patient Situation Notifications
- **Socket.io Event Dispatch**: When a nurse admits or re-assigns a patient to a doctor, a real-time `doctor:patient_assigned` event is pushed instantly to that doctor's private room.
- **Interactive Notification Banner**:
  - **Audio Chime**: Synthesized Web Audio chime to alert the physician.
  - **Clinical Situation Summary**: Patient name, age/sex, chief complaint, live vitals strip, AVPU status, bleeding warnings, comorbidities, and nurse intake notes.
  - **Review & Attend Action**: Smoothly scrolls the screen to the patient's card in the live queue with an animated glowing pulse highlight (`highlight-glow`).

### 5. Automatic Doctor Availability Transitions
- **During Active Treatment**: When a doctor starts care (`in_progress`), their status is automatically set to **Unavailable / Busy (In Treatment)** across all interfaces, removing them from the nurse's available assignment roster.
- **Upon Discharge**: When a patient is discharged, if the doctor has zero remaining active cases in progress, the doctor's status is automatically restored to **Available on Duty** in real time.

---

## Security & Reliability Implementations

### 1. Secure Password Reset OTP
- **CSPRNG Generation**: Generated using Node.js `crypto.randomInt` rather than predictable pseudo-random functions.
- **Hashed Storage**: Only the SHA-256 cryptographic hash of the verification code is persisted (`resetCodeHash`); plaintext OTPs are never stored.
- **No Response Leakage**: The verification code is never returned in API response payloads.
- **Rate Limiting & Attempt Limits**: Enforces a 60-second cooldown between OTP requests and revokes the verification code after 5 invalid attempts to prevent brute-force attacks.

### 2. Authenticated Socket.io & Room Isolation
- **Handshake Verification**: Socket connections verify the caller's JWT token during the handshake (`io.use`). Unauthenticated connection attempts are rejected.
- **Room-Based Privacy**: Sockets automatically join role rooms (`role:nurse`, `role:doctor`, `role:admin`) and private doctor rooms (`doctor:<id>`). Doctors only receive real-time updates and patient assignments intended for their station.

### 3. Role-Based Signup Protection
- **Admin Self-Signup Blocked**: Self-registration with the `admin` role is strictly disabled. Only `nurse` and `doctor` roles are allowed for self-signup.
- **Admin Approval Model**: Administrative oversight ensures privileged accounts are provisioned and approved by authorized personnel.

### 4. Anti-User Enumeration
- **Generic Error Responses**: Both login and forgot-password endpoints return generic messages (`Invalid email or password`, `If an account with that email exists, a verification code has been sent`) to prevent malicious actors from discovering valid staff email addresses.

### 5. XSS-Resistant Token Storage
- **HttpOnly Cookies**: Session tokens are issued via `httpOnly`, `sameSite`, secure cookies with `credentials: 'include'` support, eliminating vulnerable `localStorage` JWT storage susceptible to Cross-Site Scripting (XSS).

### 6. Cryptographic Tamper-Proof Audit Timeline
- **SHA-256 Hash Chaining**: Every patient intake, doctor assignment, re-triage, override, and status change creates an immutable audit block linking to the previous entry's hash (`prevHash`).
- **Chain Verification**: The `/api/patients/:id/timeline` endpoint verifies the mathematical integrity of the hash chain, immediately exposing any manual tampering.

### 7. Optimistic Concurrency Control
- **Version Tracking**: Enabled via Mongoose optimistic concurrency (`__v`).
- **Conflict Handling**: Simultaneous updates from multiple clinicians return a `409 Conflict` status, preventing silent last-write-wins data loss and triggering a real-time queue refresh.

---

## Architecture & Tech Stack

- **Backend**: Node.js, Express, Socket.io, Mongoose, JSON Web Tokens (JWT), Bcrypt.js, Cookie-Parser, Nodemailer.
- **Database**: MongoDB (Atlas Cloud or Local MongoDB).
- **Frontend**: Vanilla HTML5, CSS3 (Clinical Dark Mode), Vanilla JavaScript (ES6+), Socket.io Client, Web Audio API.

```
patient-triage-ai/
├── backend/
│   ├── server.js          # Express API, authenticated Socket.io, concurrency handling
│   ├── mailer.js          # Nodemailer email service for OTP verification codes
│   ├── auth.js            # Password hashing, JWT signing & httpOnly cookie middleware
│   ├── triageEngine.js    # AI triage scoring engine & explainability logic
│   ├── db.js              # MongoDB connection
│   ├── models/
│   │   ├── Patient.js     # Patient schema, optimistic concurrency, SHA-256 hash chaining
│   │   └── Staff.js       # Staff schema, hashed OTP storage, attempt limiting
│   ├── seedStaff.js       # Database initialization
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── index.html         # Application markup (Nurse Station, Doctor Station, Modals)
│   ├── styles.css         # Clinical dark mode, ESI acuity tags, notification animations
│   └── app.js             # Client logic, Socket.io sync, doctor alerts, audio chime
├── .gitignore
└── README.md
```

---

## Getting Started

### 1. Prerequisites
- **Node.js** (v18 or higher)
- **MongoDB** (Local instance or MongoDB Atlas connection string)

### 2. Backend Configuration
1. Navigate to the `backend/` directory:
   ```bash
   cd backend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create your `.env` file (copy from `.env.example`):
   ```env
   PORT=4000
   MONGODB_URI=mongodb://127.0.0.1:27017/patient_triage
   JWT_SECRET=your_jwt_secret_key

   # Optional: Email SMTP settings for real Password Reset OTP delivery
   # When omitted, OTP codes are logged safely to the backend server console
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your_email@gmail.com
   SMTP_PASS=your_app_password
   EMAIL_FROM=noreply@patienttriage.ai
   ```
4. Start the backend server:
   ```bash
   npm start
   ```

### 3. Frontend Execution
1. Navigate to the `frontend/` directory (or open `frontend/index.html` in your browser or a local web server):
   ```bash
   cd frontend
   npx serve -l 5500
   ```
2. Open `http://localhost:5500` in your web browser.

---

## API Reference

### Authentication & Profile (`/api/auth`)
| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/signup` | Public | Register new nurse or doctor account |
| `POST` | `/api/auth/login` | Public | Sign in, set httpOnly cookie & receive session token |
| `POST` | `/api/auth/logout` | Public | Clear httpOnly session cookie |
| `POST` | `/api/auth/forgot-password` | Public | Generate CSPRNG OTP, store SHA-256 hash, dispatch email |
| `POST` | `/api/auth/reset-password` | Public | Verify OTP hash with attempt limits and update password |
| `GET` | `/api/auth/me` | Staff | Fetch current user session |
| `PATCH` | `/api/auth/profile` | Staff | Update profile & on-duty availability |
| `POST` | `/api/auth/change-password` | Staff | Change password with current password verification |
| `DELETE` | `/api/auth/account` | Staff | Delete staff account |

### Doctors Roster (`/api/doctors`)
| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/doctors` | Staff | List all registered doctors |
| `GET` | `/api/doctors/available` | Staff | List currently available on-duty doctors |

### Patient Management (`/api/patients`)
| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/patients` | Nurse/Doctor | Intake patient, score AI triage, hash-chain audit log |
| `GET` | `/api/patients` | Staff | Get live queue (filtered to assigned doctor if doctor role) |
| `GET` | `/api/patients/:id` | Staff | Get single patient record |
| `PATCH` | `/api/patients/:id/assign` | Nurse/Admin | Assign or reassign patient to a doctor |
| `PATCH` | `/api/patients/:id/status` | Nurse/Doctor | Update status (`waiting` -> `in_progress` -> `discharged`) |
| `POST` | `/api/patients/:id/retriage` | Nurse/Doctor | Re-run AI triage with updated vitals & concurrency check |
| `POST` | `/api/patients/:id/override` | Nurse/Doctor | Clinician override with rationale & concurrency check |
| `GET` | `/api/patients/:id/timeline` | Staff | Fetch verified tamper-proof patient audit timeline |
| `DELETE` | `/api/patients/:id` | Admin | Delete patient record |

### Real-Time Socket.io Events
- `queue:update`: Emitted to authorized roles/rooms when patient records change.
- `doctors:update`: Emitted when doctor on-duty availability updates.
- `doctor:patient_assigned`: Emitted directly to the assigned doctor's private room.
- `patient:deteriorated`: Emitted when re-triage detects acuity deterioration.
