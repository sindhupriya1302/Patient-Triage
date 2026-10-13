const nodemailer = require('nodemailer');

/**
 * Configure email transporter using SMTP settings or service credentials.
 * Supports Gmail, Outlook, SendGrid, Mailtrap, or any standard SMTP server.
 */
function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587;
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

  if (user && pass) {
    if (user.endsWith('@gmail.com') && !host) {
      return nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass },
      });
    }
    return nodemailer.createTransport({
      host: host || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user, pass },
    });
  }

  // Fallback for development/testing when SMTP credentials are not yet configured in .env
  return null;
}

/**
 * Sends a secure 6-digit OTP verification email for password reset.
 * @param {string} toEmail - Recipient email address
 * @param {string} otpCode - 6-digit verification code
 */
async function sendPasswordResetEmail(toEmail, otpCode) {
  const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER || 'noreply@patienttriage.ai';
  const transporter = createTransporter();

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b1329; color: #e2e8f0; margin: 0; padding: 20px; }
        .card { max-width: 520px; margin: 0 auto; background-color: #131d38; border: 1px solid #1e293b; border-radius: 12px; padding: 32px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .logo { font-size: 20px; font-weight: 700; color: #5eead4; margin-bottom: 24px; display: flex; align-items: center; gap: 8px; }
        h2 { color: #ffffff; font-size: 22px; margin-top: 0; margin-bottom: 12px; }
        p { color: #94a3b8; font-size: 15px; line-height: 1.5; margin-bottom: 20px; }
        .otp-box { background: rgba(94, 234, 212, 0.08); border: 2px dashed #5eead4; border-radius: 10px; padding: 18px; text-align: center; margin: 24px 0; }
        .otp-code { font-family: 'SF Mono', Consolas, Monaco, monospace; font-size: 34px; font-weight: 700; letter-spacing: 8px; color: #5eead4; }
        .meta-notice { font-size: 13px; color: #64748b; margin-top: 10px; }
        .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #1e293b; font-size: 12px; color: #475569; text-align: center; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="logo">🏥 PatientTriage.ai</div>
        <h2>Password Reset Verification Code</h2>
        <p>You recently requested to reset your password for your <strong>PatientTriage.ai</strong> staff portal account. Use the 6-digit verification code below to complete the verification process:</p>
        
        <div class="otp-box">
          <div class="otp-code">${otpCode}</div>
          <div class="meta-notice">Valid for 15 minutes</div>
        </div>

        <p>If you did not request this password reset, please disregard this message or contact your hospital system administrator.</p>

        <div class="footer">
          PatientTriage.ai · Emergency Department Clinical Decision Support System
        </div>
      </div>
    </body>
    </html>
  `;

  const textContent = `PatientTriage.ai Password Reset Code: ${otpCode}\n\nYour 6-digit verification code is: ${otpCode}\nThis code is valid for 15 minutes.\n\nIf you did not request this reset, please ignore this email.`;

  if (transporter) {
    try {
      const info = await transporter.sendMail({
        from: `"PatientTriage.ai Support" <${fromAddress}>`,
        to: toEmail,
        subject: `Your PatientTriage.ai Password Reset Code: ${otpCode}`,
        text: textContent,
        html: htmlContent,
      });
      console.log(`📧 [EMAIL SENT] Password reset OTP sent to ${toEmail} (MessageId: ${info.messageId})`);
      return { success: true, messageId: info.messageId };
    } catch (err) {
      console.error(`❌ [EMAIL ERROR] Failed to send email to ${toEmail}:`, err.message);
      return { success: false, error: err.message };
    }
  } else {
    console.log(`\n======================================================`);
    console.log(`📧 [EMAIL NOTIFICATION] (SMTP not configured in .env)`);
    console.log(`Recipient: ${toEmail}`);
    console.log(`Subject: PatientTriage.ai Password Reset Verification`);
    console.log(`Status: Verification email dispatched`);
    console.log(`======================================================\n`);
    return { success: true, simulated: true };
  }
}

module.exports = { sendPasswordResetEmail };
