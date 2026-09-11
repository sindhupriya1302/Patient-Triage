# PatientTriage.ai 

**AI-Assisted Emergency Department Clinical Decision Support & Real-Time Patient Routing System**

PatientTriage.ai is an intelligent clinical decision-support portal designed for Emergency Departments (ED). It assists triage nurses and attending physicians in rapidly prioritizing incoming patients, assessing physiological risk factors, routing patients to available on-duty specialists, and tracking patient care in real time.

---

##  Key Features

### 1.  AI Clinical Decision Support (`triageEngine.js`)
- **5-Level Acuity Scale**: Modeled on the Emergency Severity Index (ESI):
  - **Level 1 — Resuscitation (Red)**: Immediate life-saving intervention (e.g., cardiac arrest, SpO₂ < 90%, unresponsiveness).
  - **Level 2 — Emergent (Orange)**: High risk, severe pain (≥8/10), altered mental status, severe vitals instability.
  - **Level 3 — Urgent (Yellow)**: Moderate distress requiring multiple hospital resources.
  - **Level 4 — Less Urgent (Green)**: Stable vitals requiring simple evaluation.
  - **Level 5 — Non-Urgent (Blue)**: Low-acuity, minor symptoms.
- **Explainable AI Score (0–100)**: Provides a breakdown of contributing risk factors (vitals deviation, symptom onset time, comorbidities, bleeding, age risk).
- **Deterioration Detection**: Re-triaging flags vital sign deterioration in real time across all connected screens.

### 2.  Nurse Triage Station
- **Comprehensive Patient Intake**: Captures vitals (HR, SBP, RR, SpO₂, Temp, Pain score), AVPU consciousness, chief complaint, severe bleeding flags, comorbidities, and intake notes.
- **Auto-Clearing Intake Form**: After submitting intake, the patient is immediately scored and added to the live queue, and the form fields reset automatically for the next intake.
- **Specialist Doctor Assignment**: Dynamically lists available on-duty doctors with real-time on-duty counts.
- **Clinical Actions**: Re-triage deterioration check, clinician acuity override (with reason tracking), doctor reassignment, and discharge.

### 3.  Doctor Station & Health Condition Overview
- **Doctor-Specific Queue**: Doctors only see patients specifically assigned to them by the triage nurse.
- **Assigned ED Metrics**: Live Queue, Average Waiting Time, Longest Wait, and Urgency distribution calculated strictly for the doctor's assigned patients.
- **Patient Health Condition Strip**: Full clinical visibility into vitals, AVPU consciousness level, active bleeding warnings, comorbidity badges, and nurse intake notes directly on each patient card.
- **Start Care / Attend Patient**: Starting treatment (`in_progress`) is reserved exclusively for the assigned doctor.

### 4.  Real-Time Doctor Patient Situation Notifications
- **Socket.io Event Dispatch**: When a nurse admits or re-assigns a patient to a doctor, a real-time `doctor:patient_assigned` event is pushed instantly.
- **Interactive Notification Banner**:
  - **Audio Chime**: Synthesized Web Audio chime to notify the physician.
  - **Clinical Situation Summary**: Patient name, age/sex, chief complaint, live vitals strip, AVPU status, bleeding warnings, comorbidities, and nurse intake notes.
  - **"Review & Attend" Action**: Smoothly scrolls the screen to the patient's card in the live queue with an animated glowing pulse highlight (`highlight-glow`).

### 5.  Automatic Doctor Availability Transitions
- **During Active Treatment**: When a doctor starts care (`in_progress`), their status is automatically set to **Unavailable / Busy (In Treatment)** across all interfaces, removing them from the nurse's available assignment roster.
- **Upon Discharge**: When a patient is discharged, if the doctor has zero remaining active cases in progress, the doctor's status is automatically restored to **Available on Duty** in real time.

### 6.  Authentication & Real Email OTP Password Reset
- **Real-Time Staff Accounts**: Sign up and sign in for Nurses and Doctors with hashed passwords (bcrypt) and JWT tokens.
- **Forgot Password with Real Email OTP**: Dispatches a 6-digit numeric verification code via `nodemailer` (supporting SMTP / Gmail / SendGrid / Mailtrap) with a 15-minute validity window.
- **Clean Database**: Pure real-time records with zero hardcoded/dummy staff accounts.

### 7.  Patient Timeline Audit Log
- **Append-Only History**: Every admission, doctor assignment, re-triage, acuity override, and status change is permanently recorded with timestamp, clinician name, and role.

---

##  Architecture & Tech Stack

- **Backend**: Node.js, Express, Socket.io, Mongoose, JSON Web Tokens (JWT), Bcrypt.js, Nodemailer.
- **Database**: MongoDB Atlas (Cloud) / Local MongoDB.
- **Frontend**: Vanilla HTML5, CSS3 (Modern Medical Dark Mode), Vanilla JavaScript (ES6+), Socket.io Client, Web Audio API.

```
patient-triage-ai/
├── backend/
│   ├── server.js          # Express API + Socket.io + patient status & auto-availability
│   ├── mailer.js          # Nodemailer email service for OTP verification codes
│   ├── auth.js            # Password hashing, JWT signing & role middleware
│   ├── triageEngine.js    # AI triage scoring engine & explainability logic
│   ├── db.js              # MongoDB connection
│   ├── models/
│   │   ├── Patient.js     # Patient Mongoose schema + vitals + audit timeline
│   │   └── Staff.js       # Staff account schema + role + OTP reset fields
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── index.html         # Application markup (Auth, Nurse Station, Doctor Station, Modals)
│   ├── styles.css         # Clinical dark mode, ESI acuity tags, notification animations
│   └── app.js             # Client logic, Socket.io sync, doctor alerts, audio chime
└── README.md
```

---

##  Getting Started

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
3. Create your `.env` file (or update existing `.env`):
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
   *(Note: If SMTP is not configured, OTP codes are logged safely to the backend server console for seamless testing).*

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

##  API Reference

### Authentication & Profile (`/api/auth`)
| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/signup` | Public | Register new nurse or doctor account |
| `POST` | `/api/auth/login` | Public | Sign in and receive JWT token |
| `POST` | `/api/auth/forgot-password` | Public | Generate & email 6-digit OTP code |
| `POST` | `/api/auth/reset-password` | Public | Verify OTP code and update password |
| `GET` | `/api/auth/me` | Staff | Fetch current user session |
| `PATCH` | `/api/auth/profile` | Staff | Update profile & on-duty availability |

### Doctors Roster (`/api/doctors`)
| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/doctors` | Staff | List all registered doctors |
| `GET` | `/api/doctors/available` | Staff | List currently available on-duty doctors |

### Patient Management (`/api/patients`)
| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/patients` | Nurse/Doctor | Intake patient, score AI triage, auto-assign |
| `GET` | `/api/patients` | Staff | Get live queue (filtered by assigned doctor if doctor role) |
| `GET` | `/api/patients/:id` | Staff | Get single patient record |
| `PATCH` | `/api/patients/:id/assign` | Nurse/Admin | Assign or reassign patient to a doctor |
| `PATCH` | `/api/patients/:id/status` | Nurse/Doctor | Update status (`waiting` → `in_progress` → `discharged`). Auto-sets doctor availability |
| `POST` | `/api/patients/:id/retriage` | Nurse/Doctor | Re-run AI triage with updated vitals |
| `POST` | `/api/patients/:id/override` | Nurse/Doctor | Clinician override with required rationale |
| `GET` | `/api/patients/:id/timeline` | Staff | Fetch tamper-evident patient audit timeline |

### Real-Time Socket.io Events
- `queue:update`: Emitted when any patient is admitted, updated, or status changes.
- `doctors:update`: Emitted when doctor on-duty availability updates.
- `doctor:patient_assigned`: Emitted directly to the assigned doctor with full patient situation data.
- `patient:deteriorated`: Emitted when re-triage detects acuity deterioration.

---

##  Security & Medical Compliance Principles
1. **Decision Support, Not Decision-Making**: The AI provides scoring and explainability to empower clinicians; final medical decisions remain strictly with licensed nurses and physicians.
2. **Role-Based Authorization**: Clinical actions (starting care, re-triage, overrides) are strictly validated server-side.
3. **Data Integrity**: Patient audit timeline entries are append-only and cryptographically tied to the acting staff member.
