const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const { Cashfree } = require('cashfree-pg');

// Cashfree Configuration
Cashfree.XClientId = process.env.CLIENT_ID || "YOUR_CASHFREE_APP_ID";
Cashfree.XClientSecret = process.env.CLIENT_SECRET || "YOUR_CASHFREE_SECRET_KEY";
Cashfree.XEnvironment = Cashfree.Environment?.SANDBOX || "SANDBOX";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let db;
const emailOtpStore = {};
const sseClients = new Map();
const hasSpecialChar = (str) => /[!@#$%^&*(),.?":{}|<>]/.test(str);

(async () => {
  db = await open({
    filename: path.join(__dirname, 'database.sqlite'),
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS user (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      phone TEXT,
      password TEXT,
      txn_pin TEXT DEFAULT '',
      wallet_balance REAL DEFAULT 0,
      total_invested REAL DEFAULT 0,
      today_income REAL DEFAULT 0,
      vip_level INTEGER DEFAULT 1,
      referral_code TEXT,
      referred_by TEXT DEFAULT '',
      last_checkin TEXT DEFAULT '',
      last_spin TEXT DEFAULT '',
      claimed_milestones TEXT DEFAULT '',
      completed_tasks TEXT DEFAULT '',
      kyc_status TEXT DEFAULT 'Pending',
      aadhaar TEXT DEFAULT '',
      pan TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS user_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      plan_name TEXT,
      tier TEXT,
      cost REAL,
      daily_return REAL,
      days_remaining INTEGER,
      purchase_time TEXT,
      status TEXT DEFAULT 'Active'
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER DEFAULT 1,
      type TEXT,
      amount REAL,
      time TEXT,
      status TEXT
    );

    CREATE TABLE IF NOT EXISTS recharge_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      amount REAL,
      utr TEXT,
      time TEXT,
      status TEXT DEFAULT 'Pending'
    );

    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      gross_amount REAL,
      fee REAL,
      net_amount REAL,
      upi_id TEXT,
      time TEXT,
      status TEXT DEFAULT 'Pending',
      remarks TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      subject TEXT,
      message TEXT,
      status TEXT DEFAULT 'Open',
      time TEXT
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT,
      message TEXT,
      time TEXT,
      is_read INTEGER DEFAULT 0
    );
  `);

  // Safe migration check for existing SQLite databases
  try { await db.exec(`ALTER TABLE user ADD COLUMN kyc_status TEXT DEFAULT 'Pending'`); } catch(e) {}
  try { await db.exec(`ALTER TABLE user ADD COLUMN aadhaar TEXT DEFAULT ''`); } catch(e) {}
  try { await db.exec(`ALTER TABLE user ADD COLUMN pan TEXT DEFAULT ''`); } catch(e) {}
})();

function notifyUserLive(userId) {
  const client = sseClients.get(userId.toString());
  if (client) {
    client.write(`data: ${JSON.stringify({ type: 'REFRESH', timestamp: Date.now() })}\n\n`);
  }
  const adminClient = sseClients.get('admin');
  if (adminClient) {
    adminClient.write(`data: ${JSON.stringify({ type: 'REFRESH', timestamp: Date.now() })}\n\n`);
  }
}

async function checkAndUpdateVipTier(userId) {
  const user = await db.get('SELECT * FROM user WHERE id = ?', [userId]);
  if (!user) return;
  let newVip = 1;
  if (user.total_invested >= 25000) newVip = 4;
  else if (user.total_invested >= 10000) newVip = 3;
  else if (user.total_invested >= 2500) newVip = 2;
  else newVip = 1;

  if (newVip !== user.vip_level) {
    await db.run('UPDATE user SET vip_level = ? WHERE id = ?', [newVip, userId]);
  }
}

async function distributeMultiLevelCommission(buyerId, planCost) {
  const buyer = await db.get('SELECT * FROM user WHERE id = ?', [buyerId]);
  if (!buyer || !buyer.referred_by) return;

  const timeNow = new Date().toLocaleTimeString();
  const l1User = await db.get('SELECT * FROM user WHERE referral_code = ?', [buyer.referred_by]);
  if (l1User) {
    const l1Reward = Math.round(planCost * 0.10);
    await db.run('UPDATE user SET wallet_balance = wallet_balance + ?, today_income = today_income + ? WHERE id = ?', [l1Reward, l1Reward, l1User.id]);
    await db.run('INSERT INTO transactions (user_id, type, amount, time, status) VALUES (?, ?, ?, ?, ?)', [l1User.id, `TIER-1 REBATE (10%)`, l1Reward, timeNow, 'Settled']);
    notifyUserLive(l1User.id);

    if (l1User.referred_by) {
      const l2User = await db.get('SELECT * FROM user WHERE referral_code = ?', [l1User.referred_by]);
      if (l2User) {
        const l2Reward = Math.round(planCost * 0.05);
        await db.run('UPDATE user SET wallet_balance = wallet_balance + ?, today_income = today_income + ? WHERE id = ?', [l2Reward, l2Reward, l2User.id]);
        await db.run('INSERT INTO transactions (user_id, type, amount, time, status) VALUES (?, ?, ?, ?, ?)', [l2User.id, `TIER-2 REBATE (5%)`, l2Reward, timeNow, 'Settled']);
        notifyUserLive(l2User.id);

        if (l2User.referred_by) {
          const l3User = await db.get('SELECT * FROM user WHERE referral_code = ?', [l2User.referred_by]);
          if (l3User) {
            const l3Reward = Math.round(planCost * 0.02);
            await db.run('UPDATE user SET wallet_balance = wallet_balance + ?, today_income = today_income + ? WHERE id = ?', [l3Reward, l3Reward, l3User.id]);
            await db.run('INSERT INTO transactions (user_id, type, amount, time, status) VALUES (?, ?, ?, ?, ?)', [l3User.id, `TIER-3 REBATE (2%)`, l3Reward, timeNow, 'Settled']);
            notifyUserLive(l3User.id);
          }
        }
      }
    }
  }
}

cron.schedule('0 0 * * *', async () => {
  if (!db) return;
  await db.run('UPDATE user SET today_income = 0');
  const activePlans = await db.all('SELECT p.*, u.vip_level FROM user_plans p JOIN user u ON p.user_id = u.id WHERE p.days_remaining > 0 AND p.status = "Active"');
  const timeNow = new Date().toLocaleTimeString();

  for (const plan of activePlans) {
    const updatedDays = plan.days_remaining - 1;
    let multiplier = 1.0;
    if (plan.vip_level === 2) multiplier = 1.05;
    if (plan.vip_level === 3) multiplier = 1.10;
    if (plan.vip_level >= 4) multiplier = 1.15;

    const boostedReturn = Number((plan.daily_return * multiplier).toFixed(2));

    if (updatedDays > 0) {
      await db.run('UPDATE user SET wallet_balance = wallet_balance + ?, today_income = today_income + ? WHERE id = ?', [boostedReturn, boostedReturn, plan.user_id]);
      await db.run('UPDATE user_plans SET days_remaining = ? WHERE id = ?', [updatedDays, plan.id]);
      await db.run('INSERT INTO transactions (user_id, type, amount, time, status) VALUES (?, ?, ?, ?, ?)', [plan.user_id, `DAILY YIELD`, boostedReturn, timeNow, 'Settled']);
      notifyUserLive(plan.user_id);
    } else {
      const totalSettlement = boostedReturn + plan.cost;
      await db.run('UPDATE user SET wallet_balance = wallet_balance + ?, today_income = today_income + ?, total_invested = total_invested - ? WHERE id = ?', [totalSettlement, boostedReturn, plan.cost, plan.user_id]);
      await db.run('UPDATE user_plans SET days_remaining = 0, status = "Matured" WHERE id = ?', [plan.id]);
      await db.run('INSERT INTO transactions (user_id, type, amount, time, status) VALUES (?, ?, ?, ?, ?)', [plan.user_id, `PRINCIPAL RELEASE (${plan.plan_name})`, totalSettlement, timeNow, 'Matured & Settled']);
      await checkAndUpdateVipTier(plan.user_id);
      notifyUserLive(plan.user_id);
    }
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.get('/api/live-stream', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.set(userId, res);

  req.on('close', () => {
    sseClients.delete(userId);
  });
});

app.post('/api/send-email-otp', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: "Invalid email address." });
  
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  emailOtpStore[email] = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'api-key': process.env.BREVO_API_KEY ? process.env.BREVO_API_KEY.trim() : '',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: "CleanPower Global", email: "ychauhan853498@gmail.com" },
        to: [{ email: email }],
        subject: "Verification Code - CleanPower Global",
        textContent: `Your institutional verification code is: ${otp}`
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("Brevo Error Response:", data);
      throw new Error(data.message || data.code || "Failed to send email via Brevo");
    }

    res.json({ message: "OTP sent successfully to your email!" });
  } catch (err) {
    console.error("Brevo API error:", err);
    res.status(500).json({ error: "Failed to send email OTP: " + err.message });
  }
});

app.post('/api/register-with-email-otp', async (req, res) => {
  const { name, email, password, otp, refCode } = req.body;
  if (!name || !email || !password || !otp) return res.status(400).json({ error: "All fields required." });
  if (!hasSpecialChar(password)) return res.status(400).json({ error: "Password needs a special character." });

  const stored = emailOtpStore[email];
  if (!stored || stored.otp !== otp.trim() || Date.now() > stored.expiresAt) return res.status(400).json({ error: "Invalid or expired OTP." });

  const existing = await db.get('SELECT * FROM user WHERE phone = ?', [email]);
  if (existing) return res.status(400).json({ error: "Email already registered." });

  delete emailOtpStore[email];
  const cleanRef = (refCode || '').trim();
  const newRefCode = 'SLR' + Math.floor(1000 + Math.random() * 9000);
  const timeNow = new Date().toLocaleTimeString();

  const result = await db.run('INSERT INTO user (name, phone, password, wallet_balance, referral_code, referred_by, vip_level) VALUES (?, ?, ?, ?, ?, ?, 1)', [name, email, password, 50, newRefCode, cleanRef]);
  const newUserId = result.lastID;
  await db.run('INSERT INTO transactions (user_id, type, amount, time, status) VALUES (?, ?, ?, ?, ?)', [newUserId, 'WELCOME BONUS', 50, timeNow, 'Settled']);
  notifyUserLive(newUserId);

  if (cleanRef) {
    const inviter = await db.get('SELECT * FROM user WHERE referral_code = ?', [cleanRef]);
    if (inviter) {
      await db.run('UPDATE user SET wallet_balance = wallet_balance + 50 WHERE id = ?', [inviter.id]);
      await db.run('INSERT INTO transactions (user_id, type, amount, time, status) VALUES (?, ?, ?, ?, ?)', [inviter.id, 'AFFILIATE BONUS', 50, timeNow, 'Settled']);
      notifyUserLive(inviter.id);
    }
  }
  res.json({ message: "Registration successful. ₹50 credited.", userId: newUserId });
});

app.post('/api/reset-password-email', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  const stored = emailOtpStore[email];
  if (!stored || stored.otp !== otp.trim() || Date.now() > stored.expiresAt) return res.status(400).json({ error: "Invalid OTP." });
  await db.run('UPDATE user SET password = ? WHERE phone = ?', [newPassword, email]);
  delete emailOtpStore[email];
  res.json({ message: "Password updated." });
});

app.post('/api/set-txn-pin', async (req, res) => {
  const { userId, pin } = req.body;
  if (!pin || pin.toString().length !== 6) return res.status(400).json({ error: "PIN must be 6 digits." });
  await db.run('UPDATE user SET txn_pin = ? WHERE id = ?', [pin.toString(), userId]);
  res.json({ message: "PIN saved." });
});

app.post('/api/login-email', async (req, res) => {
  const { email, password } = req.body;
  const user = await db.get('SELECT * FROM user WHERE phone = ? AND password = ?', [email, password]);
  if (!user) return res.status(400).json({ error: "Invalid credentials." });
  res.json({ message: "Login successful.", userId: user.id });
});

app.post('/api/kyc/submit', async (req, res) => {
  const { userId, aadhaar, pan } = req.body;
  if (!userId || !aadhaar || !pan) return res.status(400).json({ error: "All KYC fields required." });
  await db.run('UPDATE user SET aadhaar = ?, pan = ?, kyc_status = "Under Review" WHERE id = ?', [aadhaar, pan, userId]);
  notifyUserLive(userId);
  res.json({ message: "KYC details submitted successfully. Verification under review." });
});

app.get('/api/dashboard', async (req, res) => {
  const userId = req.query.userId;
  const user = await db.get('SELECT * FROM user WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: "User not found." });

  const plans = await db.all('SELECT * FROM user_plans WHERE user_id = ? ORDER BY id DESC', [userId]);
  const txns = await db.all('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 15', [userId]);
  const tickets = await db.all('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY id DESC', [userId]);
  
  const totalAumRes = await db.get('SELECT SUM(total_invested) as total FROM user');
  const totalPayoutRes = await db.get('SELECT SUM(gross_amount) as total FROM withdrawal_requests WHERE status = "Settled"');

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();
  const nextSettlement = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);

  const l1Users = await db.all('SELECT id, name, phone FROM user WHERE referred_by = ?', [user.referral_code]);
  let l2Users = [], l3Users = [];
  for (const u1 of l1Users) {
    const subs = await db.all('SELECT id FROM user WHERE referred_by = ?', [u1.referral_code]);
    l2Users = l2Users.concat(subs);
  }

  const teamStats = { l1Count: l1Users.length, l2Count: l2Users.length, l3Count: l3Users.length, totalTeam: l1Users.length + l2Users.length + l3Users.length, l1Members: l1Users };
  const claimedMilestones = (user.claimed_milestones || '').split(',').filter(Boolean);
  const completedTasks = (user.completed_tasks || '').split(',').filter(Boolean);

  res.json({
    user: { ...user, hasPin: Boolean(user.txn_pin && user.txn_pin.length === 6), claimedMilestones, completedTasks },
    canCheckIn: user.last_checkin !== today,
    canSpin: user.last_spin !== today,
    nextSettlementTimestamp: nextSettlement.getTime(),
    myPlans: plans,
    transactions: txns,
    tickets,
    teamStats,
    platformStats: {
      totalAum: totalAumRes.total || 14250000,
      totalPayouts: totalPayoutRes.total || 8920000
    }
  });
});

app.get('/api/notifications', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "User ID required." });
  const notes = await db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 20', [userId]);
  res.json({ success: true, notifications: notes });
});

app.post('/api/notifications/read', async (req, res) => {
  const { userId } = req.body;
  await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [userId]);
  res.json({ success: true });
});

app.post('/api/complete-task', async (req, res) => {
  const { userId, taskId, reward } = req.body;
  const user = await db.get('SELECT * FROM user WHERE id = ?', [userId]);
  let completed = (user.completed_tasks || '').split(',').filter(Boolean);
  if (completed.includes(taskId.toString())) return res.status(400).json({ error: "Task already completed." });

  completed.push(taskId.toString());
  const timeNow = new Date().toLocaleTimeString();
  await db.run('UPDATE user SET wallet_balance = wallet_balance + ?, completed_tasks = ? WHERE id = ?', [reward, completed.join(','), userId]);
  await db.run('INSERT INTO transactions (user_id, type, amount, time, status) VALUES (?, ?, ?, ?, ?)', [userId, `TASK REWARD (Task #${taskId})`, reward, timeNow, 'Settled']);
  notifyUserLive(userId);
  res.json({ message: `Successfully claimed ₹${reward} reward!` });
});

app.post('/api/support/ticket', async (req, res) => {
  const { userId, subject, message } = req.body;
  if (!subject || !message) return res.status(400).json({ error: "Subject and message required." });
  const timeNow = new Date().toLocaleTimeString();
  await db.run('INSERT INTO support_tickets (user_id, subject, message, status, time) VALUES (?, ?, ?, "Open", ?)', [userId, subject, message, timeNow]);
  notifyUserLive(userId);
  res.json({ message: "Support ticket submitted successfully." });
});

app.post('/api/claim-daily', async (req, res) => {
  const { userId } = req.body;
  const user = await db.get('SELECT * FROM user WHERE id = ?', [userId]);
  const today = new Date().toISOString().slice(0, 10);
  if (!user || user.last_checkin === today) return res.status(400).json({ error: "Already claimed." });

  const timeNow = new Date().toLocaleTimeString();
  await db.run('UPDATE user SET wallet_balance = wallet_balance + 5, today_income = today_income + 5, last_checkin = ? WHERE id = ?', [today, userId]);
  await db.run('INSERT INTO transactions (user_id, type, amount, time, status) VALUES (?, ?, ?, ?, ?)', [userId, 'DAILY BONUS', 5, timeNow, 'Settled']);
  notifyUserLive(userId);
  res.json({ message: "₹5 credited." });
});

app.post('/api/spin-wheel', async (req, res) => {
  const { userId } = req.body;
  const user = await db.get('SELECT * FROM user WHERE id = ?', [userId]);
  const today = new Date().toISOString().slice(0, 10);
  if (user.last_spin === today) return res.status(400).json({ error: "Already spun today." });

  const segments = [{ label: "₹10", amount: 10 }, { label: "₹25", amount: 25 }, { label: "Try Again", amount: 0 }, { label: "₹50", amount: 50 }, { label: "₹5", amount: 5 }, { label: "₹100", amount: 100 }];
  const roll = Math.random() * 100;
  let idx = roll < 35 ? 4 : roll < 65 ? 0 : roll < 85 ? 1 : roll < 95 ? 2 : roll < 99 ? 3 : 5;
  const prize = segments[idx];
  const timeNow = new Date().toLocaleTimeString();

  await db.run('UPDATE user SET wallet_balance = wallet_balance + ?, last_spin = ? WHERE id = ?', [prize.amount, today, userId]);
  if (prize.amount > 0) {
    await db.run('INSERT INTO transactions (user_id, type, amount, time, status) VALUES (?, ?, ?, ?, ?)', [userId, `LUCKY SPIN (${prize.label})`, prize.amount, timeNow, 'Settled']);
  }
  notifyUserLive(userId);
  res.json({ segmentIndex: idx, label: prize.label, message: prize.amount > 0 ? `Won ${prize.label}!` : "Better luck next time!" });
});

app.post('/api/buy-plan', async (req, res) => {
  const { userId, planName, tier, cost, dailyReturn, durationDays } = req.body;
  const user = await db.get('SELECT * FROM user WHERE id = ?', [userId]);
  if (user.wallet_balance < cost) return res.status(400).json({ error: "Insufficient balance." });

  const timeNow = new Date().toLocaleTimeString();
  await db.run('UPDATE user SET wallet_balance = wallet_balance - ?, total_invested = total_invested + ? WHERE id = ?', [cost, cost, userId]);
  await db.run('INSERT INTO user_plans (user_id, plan_name, tier, cost, daily_return, days_remaining, purchase_time, status) VALUES (?, ?, ?, ?, ?, ?, ?, "Active")', [userId, planName, tier || 'VIP1', cost, dailyReturn, durationDays || 45, timeNow]);
  await db.run('INSERT INTO transactions (user_id, type, amount, time, status) VALUES (?, ?, ?, ?, ?)', [userId, `SUBSCRIPTION (${tier})`, -cost, timeNow, 'Settled']);

  await distributeMultiLevelCommission(userId, cost);
  await checkAndUpdateVipTier(userId);
  notifyUserLive(userId);
  res.json({ message: `Successfully subscribed to ${planName}.` });
});

// ⚡ Cashfree Order Creation Integration
app.post('/api/create-payment-order', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    const dep = Number(amount);
    if (!dep || dep < 200) return res.status(400).json({ error: "Minimum deposit is ₹200." });

    const user = await db.get('SELECT * FROM user WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: "User not found." });

    const orderId = "ORDER_" + Date.now();
    
    var request = {
      "order_amount": dep,
      "order_currency": "INR",
      "order_id": orderId,
      "customer_details": {
        "customer_id": user.id.toString(),
        "customer_phone": user.phone || "9999999999",
        "customer_email": user.phone || "user@cleanpower.com"
      },
      "order_meta": {
        "return_url": `${req.protocol}://${req.get('host')}/?order_id=${orderId}`
      }
    };

    Cashfree.PGCreateOrder("2023-08-01", request).then(async (response) => {
      const paymentSessionId = response.data.payment_session_id;
      const timeNow = new Date().toLocaleTimeString();

      await db.run('INSERT INTO recharge_requests (user_id, amount, utr, time, status) VALUES (?, ?, ?, ?, "Pending")', [userId, dep, orderId, timeNow]);
      res.json({ success: true, paymentSessionId: paymentSessionId, orderId: orderId });
    }).catch((error) => {
      console.error("Cashfree API Error:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to create Cashfree order." });
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/withdraw', async (req, res) => {
  const { userId, amount, upiId, pin } = req.body;
  const wAmt = Number(amount);
  const user = await db.get('SELECT * FROM user WHERE id = ?', [userId]);

  if (!user) return res.status(404).json({ error: "User not found." });
  if (!user.txn_pin || user.txn_pin.length !== 6) return res.status(400).json({ error: "Please configure your 6-digit Security PIN first." });
  if (!pin || pin.toString() !== user.txn_pin) return res.status(403).json({ error: "Incorrect 6-digit Security PIN." });
  if (!wAmt || wAmt < 200) return res.status(400).json({ error: "Minimum withdrawal amount is ₹200." });
  if (wAmt > user.wallet_balance) return res.status(400).json({ error: "Insufficient wallet balance." });

  let feePct = user.vip_level === 2 ? 0.04 : user.vip_level === 3 ? 0.03 : user.vip_level >= 4 ? 0.02 : 0.05;
  const handlingFee = Math.round(wAmt * feePct);
  const netPayable = wAmt - handlingFee;
  const timeNow = new Date().toLocaleTimeString();

  await db.run('UPDATE user SET wallet_balance = wallet_balance - ? WHERE id = ?', [wAmt, userId]);
  await db.run('INSERT INTO withdrawal_requests (user_id, gross_amount, fee, net_amount, upi_id, time, status) VALUES (?, ?, ?, ?, ?, ?, ?)', [userId, wAmt, handlingFee, netPayable, upiId, timeNow, 'Pending']);
  await db.run('INSERT INTO transactions (user_id, type, amount, time, status) VALUES (?, ?, ?, ?, ?)', [userId, `WITHDRAWAL QUEUED`, -wAmt, timeNow, 'Pending Approval']);
  notifyUserLive(userId);

  res.json({ message: `Withdrawal submitted! Net ₹${netPayable} queued for payout (${feePct * 100}% fee).` });
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'admin@123') res.json({ success: true });
  else res.status(401).json({ error: "Invalid credentials." });
});

app.get('/api/admin/overview', async (req, res) => {
  const recharges = await db.all('SELECT r.*, u.name as user_name, u.phone as user_phone FROM recharge_requests r LEFT JOIN user u ON r.user_id = u.id ORDER BY r.id DESC LIMIT 50');
  const withdrawals = await db.all('SELECT w.*, u.name as user_name, u.phone as user_phone FROM withdrawal_requests w LEFT JOIN user u ON w.user_id = u.id ORDER BY w.id DESC LIMIT 50');
  res.json({ recharges, withdrawals });
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await db.all(`
      SELECT 
        id, 
        name AS fullname, 
        phone AS email, 
        wallet_balance AS deposit_amount, 
        'Active' AS status, 
        '-' AS created_at 
      FROM user 
      ORDER BY id DESC
    `);
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/admin/users/:id', async (req, res) => {
  const userId = req.params.id;
  const { wallet_balance, status } = req.body;
  try {
    await db.run("UPDATE user SET wallet_balance = COALESCE(?, wallet_balance) WHERE id = ?", [wallet_balance, userId]);
    notifyUserLive(userId);
    res.json({ success: true, message: "User updated successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  const userId = req.params.id;
  try {
    await db.run("DELETE FROM user WHERE id = ?", [userId]);
    res.json({ success: true, message: "User deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/recharge-action', async (req, res) => {
  const { requestId, action } = req.body;
  const reqData = await db.get('SELECT * FROM recharge_requests WHERE id = ?', [requestId]);
  if (!reqData) return res.status(404).json({ error: "Request not found." });

  const timeNow = new Date().toLocaleTimeString();

  if (action === 'approve') {
    await db.run('UPDATE recharge_requests SET status = "Approved" WHERE id = ?', [requestId]);
    await db.run('UPDATE user SET wallet_balance = wallet_balance + ? WHERE id = ?', [reqData.amount, reqData.user_id]);
    await db.run('INSERT INTO transactions (user_id, type, amount, time, status) VALUES (?, ?, ?, ?, ?)', [reqData.user_id, `DEPOSIT APPROVED`, reqData.amount, timeNow, 'Settled']);
    
    await db.run('INSERT INTO notifications (user_id, title, message, time) VALUES (?, ?, ?, ?)', [
      reqData.user_id, 
      "Deposit Approved ⚡", 
      `Your deposit of ₹${reqData.amount} has been successfully credited to your wallet.`, 
      timeNow
    ]);

    notifyUserLive(reqData.user_id);
    res.json({ message: "Deposit approved & credited to user wallet." });
  } else {
    await db.run('UPDATE recharge_requests SET status = "Rejected" WHERE id = ?', [requestId]);
    
    await db.run('INSERT INTO notifications (user_id, title, message, time) VALUES (?, ?, ?, ?)', [
      reqData.user_id, 
      "Deposit Rejected ❌", 
      `Your deposit request of ₹${reqData.amount} was rejected by admin.`, 
      timeNow
    ]);

    notifyUserLive(reqData.user_id);
    res.json({ message: "Deposit rejected." });
  }
});

app.post('/api/admin/withdraw-action', async (req, res) => {
  const { requestId, action } = req.body;
  const reqData = await db.get('SELECT * FROM withdrawal_requests WHERE id = ?', [requestId]);
  if (!reqData) return res.status(404).json({ error: "Request not found." });

  const timeNow = new Date().toLocaleTimeString();

  if (action === 'approve') {
    await db.run('UPDATE withdrawal_requests SET status = "Settled" WHERE id = ?', [requestId]);
    await db.run('INSERT INTO transactions (user_id, type, amount, time, status) VALUES (?, ?, ?, ?, ?)', [reqData.user_id, `WITHDRAWAL SETTLED`, 0, timeNow, 'Settled']);
    
    await db.run('INSERT INTO notifications (user_id, title, message, time) VALUES (?, ?, ?, ?)', [
      reqData.user_id, 
      "Withdrawal Settled 🏦", 
      `Your withdrawal of ₹${reqData.net_amount} has been sent to your UPI ID.`, 
      timeNow
    ]);

    notifyUserLive(reqData.user_id);
    res.json({ message: "Withdrawal settled." });
  } else {
    await db.run('UPDATE withdrawal_requests SET status = "Rejected" WHERE id = ?', [requestId]);
    await db.run('UPDATE user SET wallet_balance = wallet_balance + ? WHERE id = ?', [reqData.gross_amount, reqData.user_id]);
    await db.run('INSERT INTO transactions (user_id, type, amount, time, status) VALUES (?, ?, ?, ?, ?)', [reqData.user_id, `WITHDRAWAL REFUNDED`, reqData.gross_amount, timeNow, 'Refunded']);
    
    await db.run('INSERT INTO notifications (user_id, title, message, time) VALUES (?, ?, ?, ?)', [
      reqData.user_id, 
      "Withdrawal Refunded ⚠️", 
      `Your withdrawal of ₹${reqData.gross_amount} was rejected. Funds have been refunded to your wallet.`, 
      timeNow
    ]);

    notifyUserLive(reqData.user_id);
    res.json({ message: "Withdrawal rejected & refunded." });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Enterprise server running on port ${PORT}`);
});