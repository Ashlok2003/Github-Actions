import express from 'express';
import path, { resolve } from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import fs from 'fs';
import { Readable } from 'stream';
import csvParser from 'csv-parser';
import db from '../config/db.js';
import nodemailer from 'nodemailer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resumesDir = path.join(__dirname, '..', 'Uploads', 'resumes');
if (!fs.existsSync(resumesDir)) {
  fs.mkdirSync(resumesDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, resumesDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix);
  }
});

const upload = multer({ storage: storage });

const router = express.Router();

// Helper function to retry sending email
async function sendMailWithRetry(transporter, mailOptions, retries = 3, delay = 2000) {
  for (let attempt = retries; attempt > 0; attempt--) {
    try {
      const info = await transporter.sendMail(mailOptions);
      return info;
    } catch (error) {
      if (attempt === 1) throw error;
      console.warn(`Retrying email send... Attempts left: ${attempt - 1}. Error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Middleware to ensure the organization is logged in
const ensureLoggedIn = (req, res, next) => {
  console.log('Session data:', req.session);
  if (req.session && req.session.orgEmail && req.session.orgName) {
    next();
  } else {
    res.status(401).json({ success: false, error: "Organization not logged in." });
  }
};

// POST /signup - Sign up a new franchise user and send OTP
router.post('/signup', async (req, res) => {
  const { email, password, organization } = req.body;
  const db = req.app.get('db');
  const transporter = req.app.get('transporter');

  if (!email || !password || !organization) {
    return res.status(400).json({ success: false, error: "Email, Password, and Organization Name are required." });
  }

  try {
    const [results] = await db.query(
      'SELECT id FROM franchiselogindata WHERE Email = ? AND `Organization name` = ?',
      [email, organization]
    );
    if (results.length > 0) {
      return res.status(400).json({ success: false, error: "Already signed up using this email." });
    }

    const [result] = await db.query(
      'INSERT INTO franchiselogindata (Email, Password, `Organization name`) VALUES (?, ?, ?)',
      [email, password, organization]
    );

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await db.query(
      'UPDATE franchiselogindata SET Otp = ? WHERE id = ?',
      [otp, result.insertId]
    );

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: email,
      subject: 'Your OTP for Talent Corner Sign Up',
      text: `Your OTP is: ${otp}`
    };

    const info = await sendMailWithRetry(transporter, mailOptions);
    console.log("OTP email sent: " + info.response);
    res.json({ success: true, message: "User signed up successfully. OTP sent to email." });
  } catch (error) {
    console.error("Error in signup:", error);
    if (error.message.includes("Duplicate entry")) {
      return res.status(400).json({ success: false, error: "Already signed up using this email." });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /signin - Verify credentials and store organization info in session
router.post('/signin', async (req, res) => {
  const { email, password, organization } = req.body;
  const db = req.app.get('db');

  if (!email || !password || !organization) {
    return res.status(400).json({ success: false, error: "All fields are required." });
  }

  try {
    const [results] = await db.query(
      'SELECT * FROM franchiselogindata WHERE Email = ? AND Password = ? AND `Organization name` = ?',
      [email, password, organization]
    );

    if (results.length > 0) {
      req.session.orgEmail = email;
      req.session.orgName = organization;
      console.log('User signed in. Session updated:', req.session);
      res.json({
        success: true,
        message: "Sign in successful.",
        org: encodeURIComponent(organization)
      });
    } else {
      res.json({ success: false, error: "Invalid credentials. Please check your email, password, and organization name." });
    }
  } catch (error) {
    console.error("Error during sign in:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /reset-otp - Generate OTP for password reset
router.post('/reset-otp', async (req, res) => {
  const { email, organization } = req.body;
  const db = req.app.get('db');
  const transporter = req.app.get('transporter');

  if (!email || !organization) {
    return res.status(400).json({ success: false, error: "Email and Organization Name are required." });
  }

  try {
    const [results] = await db.query(
      'SELECT id FROM franchiselogindata WHERE Email = ? AND `Organization name` = ?',
      [email, organization]
    );
    if (results.length === 0) {
      return res.status(400).json({ success: false, error: "No account found with this email and organization combination." });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const userId = results[0].id;
    await db.query(
      'UPDATE franchiselogindata SET Otp = ? WHERE id = ?',
      [otp, userId]
    );

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: email,
      subject: 'Your Password Reset OTP for Talent Corner',
      text: `Your OTP for password reset is: ${otp}\n\nThis OTP will expire soon. Please use it immediately.`
    };

    const info = await sendMailWithRetry(transporter, mailOptions);
    console.log("OTP email sent: " + info.response);
    res.json({ success: true, message: "OTP sent to email.", otp: otp });
  } catch (error) {
    console.error("Error in reset-otp:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /verify-otp - Verify OTP during password reset
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  const db = req.app.get('db');

  if (!email || !otp) {
    return res.status(400).json({ success: false, error: "Email and OTP are required." });
  }

  try {
    const [results] = await db.query(
      'SELECT id, Otp FROM franchiselogindata WHERE Email = ?',
      [email]
    );
    if (results.length === 0) {
      return res.status(400).json({ success: false, error: "User not found." });
    }

    if (results[0].Otp === otp) {
      await db.query(
        'UPDATE franchiselogindata SET Otp = NULL WHERE id = ?',
        [results[0].id]
      );
      res.json({ success: true, message: "OTP verified successfully." });
    } else {
      res.status(400).json({ success: false, error: "Invalid OTP." });
    }
  } catch (error) {
    console.error("Error verifying OTP:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /reset-password - Update password after OTP verification
router.post('/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  const db = req.app.get('db');

  if (!email || !otp || !newPassword) {
    return res.status(400).json({ success: false, error: "Email, OTP, and new password are required." });
  }

  try {
    const [results] = await db.query(
      'SELECT id, Otp FROM franchiselogindata WHERE Email = ? AND Otp = ?',
      [email, otp]
    );
    if (results.length === 0) {
      return res.status(400).json({ success: false, error: "Invalid or expired OTP." });
    }

    const userId = results[0].id;
    await db.query(
      'UPDATE franchiselogindata SET Password = ?, Otp = NULL WHERE id = ?',
      [newPassword, userId]
    );
    res.json({ success: true, message: "Password reset successfully." });
  } catch (error) {
    console.error("Error resetting password:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /change-password - Change password without requiring the old password
router.post('/change-password', async (req, res) => {
  const { email, newPassword } = req.body;
  const db = req.app.get('db');

  if (!email || !newPassword) {
    return res.status(400).json({ success: false, error: "Email and new password are required." });
  }

  try {
    const [results] = await db.query(
      'SELECT id FROM franchiselogindata WHERE Email = ?',
      [email]
    );
    if (results.length === 0) {
      return res.status(400).json({ success: false, error: "User not found." });
    }

    await db.query(
      'UPDATE franchiselogindata SET Password = ? WHERE id = ?',
      [newPassword, results[0].id]
    );
    res.json({ success: true, message: "Password changed successfully." });
  } catch (error) {
    console.error("Error updating password:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /verifyCredentials - Verifies the organization credentials
router.post('/verifyCredentials', async (req, res) => {
  let { orgEmail, orgName, password } = req.body;
  const db = req.app.get('db');

  if (!orgEmail || !orgName || !password) {
    return res.status(400).json({ success: false, error: "Email, Organization Name and Password are required." });
  }

  orgEmail = orgEmail.trim();
  orgName = orgName.trim();
  password = password.trim();

  try {
    const [results] = await db.query(
      'SELECT * FROM franchiselogindata WHERE LOWER(Email) = LOWER(?) AND LOWER(`Organization name`) = LOWER(?) AND Password = ?',
      [orgEmail, orgName, password]
    );
    if (results.length === 0) {
      return res.status(200).json({ success: false, error: "Invalid email, organization name or password." });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Error verifying credentials:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Uploading the CSV File in the Application
router.post('/upload-csv', upload.single('csvFile'), async (req, res) => {
  const appendData = req.query.append !== 'false';
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded.' });
  }

  const filePath = req.file.path;
  const results Jade = [];

  try {
    const csvStream = fs.createReadStream(filePath).pipe(csvParser());

    csvStream
      .on('data', (data) => {
        console.log("CSV row:", data);
        results.push(data);
      })
      .on('end', async () => {
        console.log(`Parsed ${results.length} rows from CSV.`);

        if (results.length === 0) {
          return res.status(400).json({ success: false, error: "CSV file is empty or has no valid rows." });
        }

        const fullNameSynonyms = ["full name", "Full Name", "name", "Name"];
        const emailSynonyms = ["email", "Email"];
        const phoneSynonyms = ["phone no", "Phone No", "phone", "Phone", "contact no", "Contact No", "contact", "Contact"];
        const tokenSynonyms = ["token_url", "Token URL", "token url", "tokenUrl"];
        const insertQuery = "INSERT INTO `imported data` (`full name`, email, `phone no`, token_url) VALUES (?, ?, ?, ?)";

        try {
          const connection = await db.getConnection();

          if (!appendData) {
            await connection.query('SET FOREIGN_KEY_CHECKS=0');
            try {
              await connection.query('TRUNCATE TABLE `imported data`');
              console.log("Table truncated.");
            } catch (truncateErr) {
              console.error("Truncate failed, using DELETE instead:", truncateErr);
              await connection.query('DELETE FROM `imported data`');
            }
            await connection.query('SET FOREIGN_KEY_CHECKS=1');
          }

          const getValue = (row, synonyms) => {
            for (const key of synonyms) {
              if (row[key] && row[key].trim() !== '') return row[key].trim();
            }
            return '';
          };

          const insertPromises = results.map((row, index) => {
            const fullName = getValue(row, fullNameSynonyms);
            const email = getValue(row, emailSynonyms);
            const phoneNo = getValue(row, phoneSynonyms);
            const tokenUrl = getValue(row, tokenSynonyms);

            if (!fullName || !email || !phoneNo) {
              console.log(`Skipping row ${index + 1} due to missing required fields.`);
              return Promise.resolve();
            }

            return connection.query(insertQuery, [fullName, email, phoneNo, tokenUrl]);
          });

          await Promise.all(insertPromises);
          connection.release();
          res.json({ success: true, message: "CSV data imported successfully." });

        } catch (err) {
          console.error("Database error:", err);
          res.status(500).json({ success: false, error: err.message });
        }
      })
      .on('error', (err) => {
        console.error("CSV parsing error:", err);
        res.status(500).json({ success: false, error: err.message });
      });

  } catch (err) {
    console.error("File read error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoints for "Imported Data"
router.get('/data', async (req, res) => {
  const query = 'SELECT id, `full name`, email, `phone no`, token_url, email_sent FROM `imported data`';
  try {
    const [rows] = await db.query(query);
    const headers = ["ID", "Full Name", "Email", "Phone No", "Token URL"];
    res.json({ headers, rows });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/modify-record', async (req, res) => {
  const { id, fullName, email, phone, token_url, emailStatus } = req.body;
  if (!id) {
    return res.status(400).json({ success: false, error: "Missing record id." });
  }
  const query = `UPDATE \`imported data\` 
                 SET \`full name\` = ?, email = ?, \`phone no\` = ?, token_url = ?, email_sent = ?
                 WHERE id = ?`;
  try {
    const [result] = await db.query(query, [fullName, email, phone, token_url, emailStatus, id]);
    res.json({ success: true, message: "Record updated successfully." });
  } catch (err) {
    console.error("Error updating record:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/delete-records', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.json({ success: false, error: "No record ids provided." });
  }
  const query = 'DELETE FROM `imported data` WHERE id IN (?)';
  try {
    const [result] = await db.query(query, [ids]);
    res.json({ success: true, message: `${result.affectedRows} records deleted successfully.` });
  } catch (err) {
    console.error("Error deleting records:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/deleteAll', async (req, res) => {
  const query = 'DELETE FROM `imported data`';
  try {
    await db.query(query);
    res.send('All data deleted successfully');
  } catch (err) {
    console.error("Error deleting all data:", err);
    res.status(500).send('Error deleting all data');
  }
});

// Email Sending with Token Generation for Imported Data
const logoUrl = "https://drive.google.com/uc?export=view&id=1ADydfHmq0wp0ddFiHcVkQl8_ADu8ERsI";

router.post('/send-email', async (req, res) => {
  const baseFormUrl = "http://localhost:5173/candidate-form";
  try {
    const [results] = await db.query('SELECT id, `full name` as fullName, email FROM `imported data` WHERE email_sent = 0 OR email_sent IS NULL');

    if (results.length === 0) {
      return res.json({ success: false, error: 'No new candidates found.' });
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'trial.project.intern@gmail.com',
        pass: 'encu ioab yzfv nsbq'
      }
    });

    function delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    const sendEmailPromises = results.map(async (candidate, i) => {
      const body = `
<html>
  <head>
    <style>
      body {
        font-family: Arial, sans-serif;
        background-color: #54397e;
        color: #fff;
        padding: 20px;
        margin: 0;
      }
      .container {
        max-width: 600px;
        margin: 20px auto;
        padding: 20px;
        background-color: #fff;
        border: 2px solid #54397e;
        border-radius: 10px;
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
      }
      .header {
        text-align: center;
        padding-bottom: 20px;
      }
      .header img {
        max-width: 150px;
        margin-bottom: 20px;
        border-radius: 29px;
      }
      .header h2 {
        color: #54397e;
        margin: 0;
      }
      .content {
        font-size: 16px;
        line-height: 1.6;
        color: #333;
        text-align: center;
        padding: 20px 40px;
      }
      .content a {
        display: inline-block;
        background-color: #54397e;
        color: #fff;
        text-decoration: none;
        font-weight: bold;
        padding: 10px 20px;
        border-radius: 5px;
        font-size: 16px;
      }
      .footer {
        font-size: 16px;
        line-height: 1.6;
        color: #333;
        text-align: center;
        padding-top: 20px;
      }
      .link-container {
        text-align: center;
        margin: 20px 0;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <img src="${logoUrl}" alt="Talent Corner Logo" />
        <h2>Thank You!</h2>
      </div>
      <div class="content">
        <p>Hello ${candidate.fullName}</p>
        <p>You have been invited to fill out the form. Please use the following link to access it:</p>
        <div class="link-container">
          <a href="${baseFormUrl}">Click here to access the Form link</a>
        </div>
        <p>Once you submit the form, your access will be marked as used.</p>
      </div>
      <div class="footer">
        <p>Thank you.</p>
        <p>HR Team<br>Talent Corner</p>
      </div>
    </div>
  </body>
</html>
`;

      await delay(i * 1000);
      await transporter.sendMail({
        from: 'trial.project.intern@gmail.com',
        to: candidate.email,
        subject: 'Form Submission Invitation',
        html: body
      });

      await db.query(
        'UPDATE `imported data` SET email_sent = 1 WHERE id = ?',
        [candidate.id]
      );
    });

    await Promise.all(sendEmailPromises);

    res.json({ success: true, message: "Emails sent successfully to all candidates." });

  } catch (error) {
    console.error("Error processing candidates:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /filterCandidates - Filter candidates (using session info)
router.post('/filterCandidates', ensureLoggedIn, async (req, res) => {
  const { domain, subDomain } = req.body;
  const orgEmail = req.session.orgEmail;
  const orgName = req.session.orgName;
  const db = req.app.get('db');

  if (!domain || !subDomain) {
    return res.status(200).json({ success: false, error: "Domain and SubDomain are required." });
  }

  try {
    const [results] = await db.query(
      `SELECT 
        cr.Full_Name, 
        cr.Email, 
        cr.Phone_No, 
        cr.Domain, 
        cr.Sub_Domain, 
        cr.Date, 
        cr.Month, 
        cr.Year,
        COALESCE(ces.email_status, 0) AS email_status
      FROM \`candidate ranking\` cr
      LEFT JOIN candidate_email_status ces 
        ON LOWER(cr.Email) = LOWER(ces.candidateEmail)
        AND LOWER(ces.orgName) = LOWER(?)
      WHERE LOWER(cr.Domain) = LOWER(?)
        AND LOWER(cr.Sub_Domain) = LOWER(?)
      ORDER BY cr.\`Rank\`
      LIMIT 3`,
      [orgName, domain, subDomain]
    );

    if (results.length === 0) {
      return res.status(200).json({ success: false, error: "No candidate data found for the selected filters." });
    }
    res.json({ success: true, data: results });
  } catch (error) {
    console.error("Error fetching candidates:", error);
    res.status(200).json({ success: false, error: error.message });
  }
});

// POST /sendCandidateEmail - Send email to candidate using session info
router.post('/sendCandidateEmail', ensureLoggedIn, async (req, res) => {
  const orgEmail = req.session.orgEmail;
  const orgName = req.session.orgName;
  const { candidateEmail, candidateName, domain, subDomain } = req.body;
  const db = req.app.get('db');
  const transporter = req.app.get('transporter');

  if (!candidateEmail || !candidateName || !domain || !subDomain) {
    return res.status(400).json({ success: false, error: "All candidate and domain fields are required." });
  }

  try {
    const [checkResults] = await db.query(
      `SELECT email_status 
       FROM candidate_email_status
       WHERE LOWER(candidateEmail) = LOWER(?)
       AND LOWER(orgName) = LOWER(?)
       LIMIT 1`,
      [candidateEmail, orgName]
    );

    if (checkResults.length > 0 && checkResults[0].email_status == 1) {
      return res.json({ success: true, message: "Email already sent." });
    }

    const mailOptions = {
      from: `"${orgName}" <${orgEmail}>`,
      replyTo: orgEmail,
      to: candidateEmail,
      subject: `${orgName}: Talent Corner Opportunity`,
      text: `Dear ${candidateName},\n\nWe are pleased to inform you about a new opportunity in the ${subDomain} domain.\n\nBest regards,\n${orgName}\n${orgEmail}`
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`Candidate email sent to ${candidateEmail}: ${info.response}`);

    await db.query(
      `INSERT INTO candidate_email_status (candidateEmail, orgName, email_status, candidateName, subDomain)
       VALUES (?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE 
         email_status = 1, 
         candidateName = VALUES(candidateName), 
         subDomain = VALUES(subDomain)`,
      [candidateEmail, orgName, candidateName, subDomain]
    );

    res.json({ success: true, message: "Candidate email sent and status updated." });
  } catch (error) {
    console.error(`Error sending email to ${candidateEmail}:`, error);
    res.status(500).json({ success: false, error: "Error sending candidate email: " + error.message });
  }
});

// GET /orgEmailCount - Get aggregated email counts by organization
router.get('/orgEmailCount', async (req, res) => {
  const db = req.app.get('db');

  try {
    const [results] = await db.query(
      `SELECT orgName, email_sent_count FROM org_email_counts ORDER BY email_sent_count DESC`
    );
    res.json({ success: true, data: results });
  } catch (error) {
    console.error("Error fetching org email count:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /dashboardData - Aggregate dashboard data with org-specific email count
router.get('/dashboardData', async (req, res) => {
  const orgName = req.query.org;
  const db = req.app.get('db');

  if (!orgName) {
    return res.status(400).json({ error: 'Organization name is required' });
  }

  try {
    let dashboardData = {};

    const [signupResults] = await db.query(
      'SELECT COUNT(*) AS totalSignups FROM franchiselogindata'
    );
    dashboardData.totalSignups = signupResults[0].totalSignups;

    const [orgEmailResults] = await db.query(
      'SELECT email_sent_count FROM org_email_counts WHERE orgName = ?',
      [orgName]
    );
    dashboardData.totalEmailsSent = orgEmailResults.length > 0 ? orgEmailResults[0].email_sent_count : 0;

    const [candidateResults] = await db.query(
      'SELECT COUNT(*) AS totalCandidates FROM `candidate ranking`'
    );
    dashboardData.totalCandidates = candidateResults[0].totalCandidates;

    const [dailyResults] = await db.query(
      `SELECT DATE(Timestamp) AS signupDate, COUNT(*) AS signupCount 
       FROM franchiselogindata
       GROUP BY DATE(Timestamp)
       ORDER BY DATE(Timestamp)`
    );
    dashboardData.signupDates = dailyResults.map(row => row.signupDate);
    dashboardData.signupCounts = dailyResults.map(row => row.signupCount);

    res.json(dashboardData);
  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /candidate-by-year - Candidate registrations by year
router.get('/candidate-by-year', async (req, res) => {
  const db = req.app.get('db');

  try {
    const [results] = await db.query(
      `SELECT Year, COUNT(*) AS count 
       FROM \`candidate ranking\`
       GROUP BY Year
       ORDER BY Year`
    );
    res.json(results);
  } catch (error) {
    console.error("Error fetching candidate by year:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /candidate-by-domain - Candidates by Domain with optional year filter
router.get('/candidate-by-domain', async (req, res) => {
  const filter = req.query.filter;
  const db = req.app.get('db');
  let sql = 'SELECT Domain, COUNT(*) AS count FROM `candidate ranking`';
  let params = [];

  if (filter) {
    sql += ' WHERE Year = ?';
    params.push(filter);
  }
  sql += ' GROUP BY Domain';

  try {
    const [results] = await db.query(sql, params);
    res.json(results);
  } catch (error) {
    console.error("Error fetching candidate by domain:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /candidate-by-subdomain - Candidates by Subdomain with optional year filter
router.get('/candidate-by-subdomain', async (req, res) => {
  const filter = req.query.filter;
  const db = req.app.get('db');
  let sql = 'SELECT Sub_Domain, COUNT(*) AS count FROM `candidate ranking`';
  let params = [];

  if (filter) {
    sql += ' WHERE Year = ?';
    params.push(filter);
  }
  sql += ' GROUP BY Sub_Domain';

  try {
    const [results] = await db.query(sql, params);
    res.json(results);
  } catch (error) {
    console.error("Error fetching candidate by subdomain:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

router.get('/otp.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'otp.html'));
});

router.get('/resetPassword.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'resetPassword.html'));
});

router.get('/changePassword.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'changePassword.html'));
});

// For Form 1 (CandidateForm.jsx)
router.post('/submitCandidate', upload.single('resume'), async (req, res) => {
  const {
    Full_Name, Email, Phone_No, Domain, Sub_Domain, dob, gender, location,
    pincode, state, city, country, emergencyPhone, contactName, contactRelation,
    highestQualification, degree, courseName, collegeName, universityName,
    yearOfPassing, marks, internship_experience, skills, resume_url,
  } = req.body;

  const resume = req.file;
  const nameParts = Full_Name.split(" ");
  const First_Name = nameParts[0];
  const Middle_Name = nameParts.length > 2 ? nameParts.slice(1, nameParts.length - 1).join(" ") : '';
  const Last_Name = nameParts[nameParts.length - 1];

  const db = req.app.get('db');

  try {
    let resumePath = resume_url || '';
    if (resume) {
      resumePath = `/Uploads/resumes/${resume.filename}`;
    }

    await db.query(
      `INSERT INTO candidate_details (
        first_name, middle_name, last_name, email, contact_number, domain, subdomain, marks,
        date_of_birth, gender, current_location, pincode, state, city, country,
        emergency_contact_number, emergency_contact_name, emergency_contact_relation,
        highest_qualification, degree, course_name, college, university, year_of_passing,
        internship_experience, skills, resume_url, email_sent, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        First_Name, Middle_Name, Last_Name, Email, Phone_No, Domain, Sub_Domain, marks,
        dob, gender, location, pincode, state, city, country,
        emergencyPhone, contactName, contactRelation,
        highestQualification, degree, courseName, collegeName, universityName, yearOfPassing,
        internship_experience, skills, resumePath, 0
      ]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Candidate submission error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// For FreshersData table (FDFormData.jsx)
router.get('/candidate-details', async (req, res) => {
  try {
    const query = `
      SELECT 
        id,
        CONCAT_WS(' ', first_name, middle_name, last_name) AS name,
        email,
        contact_number,
        gender,
        city,
        college,
        created_at,
        email_sent,
        token_url
      FROM candidate_details
    `;
    const [rows] = await db.query(query);

    const headers = [
      "id", "name", "email", "contact_number", "gender",
      "city", "college", "created_at", "email_sent", "token_url"
    ];
    res.json({ headers, rows });
  } catch (err) {
    console.error("Error fetching `candidate_details`:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/modify-candidate-details-record', async (req, res) => {
  const {
    id, first_name, middle_name, last_name,
    email, contact_number, gender, city, college,
    token_url, emailStatus
  } = req.body;

  if (!id) {
    return res.status(400).json({ success: false, error: "Missing record id." });
  }

  try {
    const query = `
      UPDATE candidate_details
      SET first_name = ?, middle_name = ?, last_name = ?, email = ?, contact_number = ?, gender = ?, city = ?, college = ?, token_url = ?, email_sent = ?
      WHERE id = ?
    `;
    const values = [first_name, middle_name, last_name, email, contact_number, gender, city, college, token_url, emailStatus, id];
    await db.query(query, values);
    res.json({ success: true, message: "Record updated successfully." });
  } catch (err) {
    console.error("Error updating record:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/delete-records-candidate-details', async (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.json({ success: false, error: "No record ids*** provided." });
  }

  try {
    const query = 'DELETE FROM candidate_details WHERE id IN (?)';
    const [result] = await db.query(query, [ids]);
    res.json({ success: true, message: `${result.affectedRows} records deleted successfully.` });
  } catch (err) {
    console.error("Error deleting records:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/deleteAll-candidate-details', async (req, res) => {
  try {
    await db.query('DELETE FROM candidate_details');
    await db.query('ALTER TABLE candidate_details AUTO_INCREMENT = 1');
    res.json({ success: true, message: "All candidate_details deleted and auto_increment reset." });
  } catch (err) {
    console.error("Error deleting all candidate_details:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Email Sending for `candidate_details`
router.post('/send-email-candidate-details', async (req, res) => {
  const baseFormUrl = "http://localhost:5173/domain-form";
  try {
    const [candidates] = await db.query(
      'SELECT id, CONCAT(first_name, " ", middle_name, " ", last_name) AS name, email, token_url FROM `candidate_details` WHERE email_sent = 0 OR email_sent IS NULL'
    );

    if (candidates.length === 0) {
      return res.json({ success: false, error: 'No new candidates found in `candidate_details`.' });
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'trial.project.intern@gmail.com',
        pass: 'encu ioab yzfv nsbq'
      }
    });

    const sendEmailPromises = candidates.map(candidate => {
      const body = `
<html>
  <head>
    <style>
      body {
        font-family: Arial, sans-serif;
        background-color: #54397e;
        color: #fff;
        padding: 20px;
        margin: 0;
      }
      .container {
        max-width: 600px;
        margin: 20px auto;
        padding: 20px;
        background-color: #fff;
        border: 2px solid #54397e;
        border-radius: 10px;
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
      }
      .header {
        text-align: center;
        padding-bottom: 20px;
      }
      .header img {
        max-width: 150px;
        margin-bottom: 20px;
        border-radius: 29px;
      }
      .header h2 {
        color: #54397e;
        margin: 0;
      }
      .content {
        font-size: 16px;
        line-height: 1.6;
        color: #333;
        text-align: center;
        padding: 20px 40px;
      }
      .content a {
        display: inline-block;
        background-color: #54397e;
        color: #fff;
        text-decoration: none;
        font-weight: bold;
        padding: 10px 20px;
        border-radius: 5px;
        font-size: 16px;
      }
      .footer {
        font-size: 16px;
        line-height: 1.6;
        color: #333;
        text-align: center;
        padding-top: 20px;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <img src="${logoUrl}" alt="Talent Corner Logo" />
        <h2>Thank You!</h2>
      </div>
      <div class="content">
        <p>Dear ${candidate.name}</p>
        <p>We have received your form. Thank you for taking the time to complete it. Your responses will help us process your application more efficiently.</p>
        <p>Please click the button below to fill out an evaluation form for the next step in the process.</p>
        <p><a href="${baseFormUrl}">Click the Evaluation Form</a></p>
      </div>
      <div class="footer">
        <p> Publishing Best regards,</p>
        <p>HR Team<br>Talent Corner</p>
      </div>
    </div>
  </body>
</html>
`;

      return transporter.sendMail({
        from: 'trial.project.intern@gmail.com',
        to: candidate.email,
        subject: 'Your Access Token for the Form',
        html: body
      }).then(() => {
        return db.query('UPDATE candidate_details SET email_sent = 1 WHERE id = ?', [candidate.id]);
      });
    });

    await Promise.all(sendEmailPromises);
    res.json({ success: true, message: "Emails sent successfully to all `candidate_details` candidates." });
  } catch (error) {
    console.error("Error sending emails:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /submit-domain-assessment
router.post('/submit-domain-assessment', async (req, res) => {
  const data = req.body;
  console.log("Received submission payload:", data);
  try {
    const [dupResults] = await db.query(
      `SELECT COUNT(*) AS count FROM \`candidate ranking\` WHERE Email = ? AND Sub_Domain = ?`,
      [data.email, data.subdomain]
    );
    if (dupResults[0].count > 0) {
      return res.json({ success: false, message: "Already submitted for this subdomain." });
    }

    const score = parseInt(data.score) || 0;
    const elapsed = parseInt(data.elapsedTimeInSeconds) || 0;
    const now = new Date();

    const insertQuery = `
      INSERT INTO \`candidate ranking\` (
        \`Rank\`, \`Timestamp\`, \`First_Name\`, \`Middle_Name\`, \`Last_Name\`,
        \`Email\`, \`Phone_No\`, \`College\`, \`University\`, \`Degree\`,
        \`Domain\`, \`Sub_Domain\`, \`Marks\`, \`Completion_of_MCQ\`,
        \`Date\`, \`Month\`, \`Year\`, \`Selection_Email\`
      )
      VALUES (NULL, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      data.firstName, data.middleName, data.lastName,
      data.email, data.phone, data.college, data.university, data.degree,
      data.domain, data.subdomain, score, elapsed,
      now.getDate(), now.toLocaleString('default', { month: 'long' }), now.getFullYear(), "0"
    ];

    await db.query(insertQuery, values);
    await db.query("SET @rank := 0");
    await db.query(`
      UPDATE \`candidate ranking\` AS cr
      JOIN (
        SELECT id, (@rank := @rank + 1) AS newRank
        FROM \`candidate ranking\`, (SELECT @rank := 0) r
        WHERE Domain = ? AND Sub_Domain = ?
        ORDER BY Marks DESC, Completion_of_MCQ ASC
      ) AS ranking ON cr.id = ranking.id
      SET cr.Rank = ranking.newRank
    `, [data.domain, data.subdomain]);

    return res.json({ success: true });
  } catch (err) {
    console.error("Error in /api/submit-domain-assessment:", err);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// Candidate Ranking Routes
router.get('/', async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const db = req.app.get('db');

  try {
    const offset = (page - 1) * limit;
    const headers = [
      'id',
      'first_name',
      'middle_name',
      'last_name',
      'email',
      'phone_no',
      'domain',
      'sub_domain',
      'marks',
      'dob',
      'gender',
      'location',
      'city',
      'state',
      'country',
      'college_name',
      'year_of_passing',
      'email_status',
    ];

    const [rows] = await db.query(
      `SELECT ${headers.join(', ')} FROM \`candidate ranking\` LIMIT ? OFFSET ?`,
      [parseInt(limit), parseInt(offset)]
    );

    res.json({ headers, rows });
  } catch (error) {
    console.error('Error fetching candidates:', error);
    res.status(500).json({ error: 'Failed to fetch candidates' });
  }
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const data = req.body;
  const db = req.app.get('db');

  try {
    await db.query(
      `UPDATE \`candidate ranking\` SET ? WHERE id = ?`,
      [data, id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating candidate:', error);
    res.status(500).json({ error: 'Failed to update candidate' });
  }
});

router.delete('/', async (req, res) => {
  const { ids } = req.body;
  const db = req.app.get('db');

  try {
    await db.query(
      `DELETE FROM \`candidate ranking\` WHERE id IN (?)`,
      [ids]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting candidates:', error);
    res.status(500).json({ error: 'Failed to delete candidates' });
  }
});

router.delete('/all', async (req, res) => {
  const db = req.app.get('db');

  try {
    await db.query(`DELETE FROM \`candidate ranking\``);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting all candidates:', error);
    res.status(500).json({ error: 'Failed to delete all candidates' });
  }
});

router.post('/send-emails', async (req, res) => {
  const { ids } = req.body;
  const db = req.app.get('db');

  try {
    await db.query(
      `UPDATE \`candidate ranking\` SET email_status = 1 WHERE id IN (?)`,
      [ids]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error sending emails:', error);
    res.status(500).json({ error: 'Failed to send emails' });
  }
});

export default router;