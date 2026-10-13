# PatientTriage.ai

**AI-Assisted Emergency Department Clinical Decision Support & Real-Time Patient Routing System**

PatientTriage.ai is an intelligent clinical decision-support portal designed for Emergency Departments (ED). It assists triage nurses and attending physicians in rapidly prioritizing incoming patients, assessing physiological risk factors, routing patients to available on-duty specialists, and tracking patient care in real time.

---

## Key Features

### 1. AI Clinical Decision Support (`triageEngine.js`)
- **5-Level Acuity Scale**: Modeled on the Emergency Severity Index (ESI):
  - **Level 1 — Resuscitation (Red)**: Immediate life-saving intervention (e.g., cardiac arrest, SpO₂ < 90%, unresponsiveness).
  - **Level 2 — Emergent (Orange)**: High risk, severe pain (≥8/10), altered mental status, severe vitals instability.
  - **Level 3 — Urgent (Yellow)**: Moderate distress requiring multiple hospital resources.
  - **Level 4 — Less Urgent (Green)**: Stable vitals requiring simple evaluation.
  - **Level 5 — Non-Urgent (Blue)**: Low-acuity, minor symptoms.
- **Explainable AI Score (0–100)**: Provides a breakdown of contributing risk factors (vitals deviation, symptom onset time, comorbidities, bleeding, age risk).
- **Deterioration Detection**: Re-triaging flags vital sign deterioration in real time across all connected screens.

### 2. Nurse Triage Station
- **Comprehensive Patient Intake**: Captures vitals (HR, SBP, RR, SpO₂, Temp, Pain score), AVPU consciousness, chief complaint, severe bleeding flags, comorbidities, and intake notes.
- **Auto-Clearing Intake Form**: After submitting intake, the patient is immediately scored and added to the live queue, and the form fields reset automatically for the next intake.
- **Specialist Doctor Assignment**: Dynamically lists available on-duty doctors with real-time on-duty counts.
- **Clinical Actions**: Re-triage deterioration check, clinician acuity override (with reason tracking), doctor reassignment, and discharge.

### 3. Doctor Station & Health Condition Overview
- **Doctor-Specific Queue**: Doctors only see patients specifically assigned to them by the triage nurse.
- **Assigned ED Metrics**: Live Queue, Average Waiting Time, Longest Wait, and Urgency distribution calculated strictly for the doctor's assigned patients.
- **Patient Health Condition Strip**: Full clinical visibility into vitals, AVPU consciousness level, active bleeding warnings, comorbidity badges, and nurse intake notes directly on each patient card.
- **Start Care / Attend Patient**: Starting treatment (`in_progress`) is reserved exclusively for the assigned doctor.

### 4. Real-Time Doctor Patient Situation Notifications
- **Socket.io Event Dispatch**: When a nurse admits or re-assigns a patient to a doctor, a real-time `doctor:patient_assigned` event is pushed instantly.
- **Interactive Notification Banner**:
  - **Audio Chime**: Synthesized Web Audio chime to notify the physician.
  - **Clinical Situation Summary**: Patient name, age/sex, chief complaint, live vitals strip, AVPU status, bleeding warnings, comorbidities, and nurse intake notes.
  - **"Review & Attend" Action**: Smoothly scrolls the screen to the patient's card in the live queue with an animated glowing pulse highlight (`highlight-glow`).

### 5. Automatic Doctor Availability Transitions
- **During Active Treatment**: When a doctor starts care (`in_progress`), their status is automatically set to **Unavailable / Busy (In Treatment)** across all interfaces, removing them from the nurse's available assignment roster.
- **Upon Discharge**: When a patient is discharged, if the doctor has zero remaining active cases in progress, the doctor's status is automatically restored to **Available on Duty** in real time.

### 6. Authentication & Secure Email OTP Password Reset
- **Real-Time Staff Accounts**: Sign up and sign in for Nurses and Doctors with hashed passwords (bcrypt) and JWT tokens.
- **Forgot Password with Email OTP**: Dispatches a 6-digit numeric verification code via `nodemailer` (supporting SMTP / Gmail / SendGrid / Mailtrap) with a 15-minute validity window.
- **Privacy & Security**: Verification codes are delivered directly to the user's email and are never logged to the terminal or console.
- **Account Management**: Support for profile updates, availability toggling, password changes, and account deletion.

### 7. Patient Timeline Audit Log
- **Append-Only History**: Every admission, doctor assignment, re-triage, acuity override, and status change is permanently recorded with timestamp, clinician name, and role.

---

## Architecture & Tech Stack

- **Backend**: Node.js, Express, Socket.io, Mongoose, JSON Web Tokens (JWT), Bcrypt.js, Nodemailer.
- **Database**: MongoDB Atlas (Cloud) / Local MongoDB.
- **Frontend**: Vanilla HTML5, CSS3 (Modern Medical Dark Mode), Vanilla JavaScript (ES6+), Socket.io Client, Web Audio API.

```
patient-triage-ai/
├── backend/
│   ├── models/
│   │   ├── Patient.js          # Patient Mongoose schema + vitals + audit timeline
│   │   └── Staff.js            # Staff account schema + role + OTP reset fields
│   ├── auth.js                 # Password hashing, JWT signing & role middleware
│   ├── db.js                   # MongoDB connection configuration
│   ├── mailer.js               # Nodemailer email service for OTP verification codes
│   ├── package.json            # Node.js backend dependencies & scripts
│   ├── seedStaff.js            # Staff database initialization helper
│   ├── server.js               # Express API + Socket.io + clinical routes
│   └── triageEngine.js         # AI triage scoring engine & explainability logic
├── frontend/
│   ├── app.js                  # Client logic, Socket.io sync, doctor alerts, audio chime
│   ├── index.html              # Application markup (Auth, Nurse Station, Doctor Station, Modals)
│   └── styles.css              # Clinical dark mode, ESI acuity tags, notification animations
├── .gitignore
└── README.md
```

---

## Getting Started

### 1. Prerequisites
- **Node.js** (v18 or higher)
- **MongoDB** (MongoDB Atlas cloud connection string or local MongoDB instance)

### 2. Backend Configuration
1. Navigate to the `backend/` directory:
   ```bash
   cd backend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure environment variables (create a `.env` file in the `backend/` folder):
   ```env
   PORT=4000
   MONGODB_URI=your_mongodb_connection_string
   JWT_SECRET=your_jwt_secret_key

   # Optional: Email configuration for Password Reset OTP delivery
   # For Gmail: Use your Gmail address and a 16-character Google App Password
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your_hospital_email@gmail.com
   SMTP_PASS=your_gmail_app_password
   EMAIL_FROM=noreply@patienttriage.ai
   ```

4. Start the backend server:
   ```bash
   npm start
   ```

### 3. Frontend Execution
1. Open `frontend/index.html` directly in your browser or run via a local static web server:
   ```bash
   cd frontend
   npx serve -l 5500
   ```
2. Open `http://localhost:5500` in your web browser.

---

## API Reference

### Authentication & Staff Management (`/api/auth`)
| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/signup` | Public | Register a new nurse or doctor account |
| `POST` | `/api/auth/login` | Public | Authenticate staff credentials and issue JWT token |
| `POST` | `/api/auth/forgot-password` | Public | Generate 6-digit OTP code and dispatch via email |
| `POST` | `/api/auth/reset-password` | Public | Verify OTP code and update password |
| `GET` | `/api/auth/me` | Staff | Fetch current authenticated staff profile |
| `PATCH` | `/api/auth/profile` | Staff | Update profile details and on-duty availability |
| `POST` | `/api/auth/change-password` | Staff | Update password with current password verification |
| `DELETE` | `/api/auth/account` | Staff | Delete staff member account |

### Clinical Reference & Doctors Roster
| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/reference` | Public | Clinical ESI level thresholds and scoring references |
| `GET` | `/api/doctors` | Staff | List all registered doctors |
| `GET` | `/api/doctors/available` | Staff | List currently available on-duty doctors |

### Patient Management (`/api/patients`)
| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/patients` | Nurse/Doctor | Intake patient, calculate AI triage acuity score, auto-assign |
| `GET` | `/api/patients` | Staff | Fetch live queue (filtered by assigned doctor for doctor role) |
| `GET` | `/api/patients/:id` | Staff | Retrieve full patient record and clinical history |
| `PATCH` | `/api/patients/:id/assign` | Nurse/Admin | Assign or reassign patient to a doctor |
| `PATCH` | `/api/patients/:id/status` | Nurse/Doctor | Update care status (`waiting` → `in_progress` → `discharged`) |
| `POST` | `/api/patients/:id/retriage` | Nurse/Doctor | Re-run AI triage with updated physiological vitals |
| `POST` | `/api/patients/:id/override` | Nurse/Doctor | Clinician acuity override with required clinical rationale |
| `GET` | `/api/patients/:id/timeline` | Staff | Fetch immutable patient audit timeline |
| `DELETE` | `/api/patients/:id` | Admin | Delete patient record |

### Analytics & System Metrics (`/api/stats`)
| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/stats` | Staff | Emergency department aggregate stats (wait times, acuity distribution) |

### Real-Time Socket.io Events
- `queue:update`: Emitted when any patient is admitted, updated, or status changes.
- `doctors:update`: Emitted when doctor on-duty availability updates.
- `doctor:patient_assigned`: Emitted directly to the assigned doctor with full patient situation data.
- `patient:deteriorated`: Emitted when re-triage detects acuity deterioration.

---

## Clinical Safety Principles
1. **Decision Support, Not Decision-Making**: The AI engine provides acuity scoring and risk factor explainability to support clinical workflows; ultimate clinical decisions remain with licensed medical professionals.
2. **Role-Based Authorization**: Intake, doctor assignment, care initiation, and overrides are protected and validated on the backend.
3. **Audit Trail**: Every clinical action, override reason, and status progression is logged with timestamps and clinician identifiers.
