const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const mongoose = require('mongoose');
const path = require('path');
const { Cashfree } = require('cashfree-pg');

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://ychauhan853498_db_user:MyPassword123@cluster0.lknpheh.mongodb.net/?appName=Cluster0";

mongoose.connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB Atlas successfully!'))
  .catch(err => console.error('MongoDB connection error:', err));

// Mongoose Schemas & Models
const userSchema = new mongoose.Schema({
  name: String,
  phone: { type: String, unique: true },
  password: String,
  txn_pin: { type: String, default: '' },
  wallet_balance: { type: Number, default: 0 },
  total_invested: { type: Number, default: 0 },
  today_income: { type: Number, default: 0 },
  vip_level: { type: Number, default: 1 },
  referral_code: String,
  referred_by: { type: String, default: '' },
  last_checkin: { type: String, default: '' },
  last_spin: { type: String, default: '' },
  claimed_milestones: { type: String, default: '' },
  completed_tasks: { type: String, default: '' },
  kyc_status: { type: String, default: 'Pending' },
  aadhaar: { type: String, default: '' },
  pan: { type: String, default: '' },
  is_suspended: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

const userPlanSchema = new mongoose.Schema({
  user_id: mongoose.Schema.Types.ObjectId,
  plan_name: String,
  tier: String,
  cost: Number,
  daily_return: Number,
  days_remaining: Number,
  purchase_time: String,
  status: { type: String, default: 'Active' }
});
const UserPlan = mongoose.model('UserPlan', userPlanSchema);

const transactionSchema = new mongoose.Schema({
  user_id: mongoose.Schema.Types.ObjectId,
  type: String,
  amount: Number,
  time: String,
  status: String
});
const Transaction = mongoose.model('Transaction', transactionSchema);

const rechargeRequestSchema = new mongoose.Schema({
  user_id: mongoose.Schema.Types.ObjectId,
  amount: Number,
  utr: String,
  time: String,
  status: { type: String, default: 'Pending' }
});
const RechargeRequest = mongoose.model('RechargeRequest', rechargeRequestSchema);

const withdrawalRequestSchema = new mongoose.Schema({
  user_id: mongoose.Schema.Types.ObjectId,
  gross_amount: Number,
  fee: Number,
  net_amount: Number,
  upi_id: String,
  time: String,
  status: { type: String, default: 'Pending' },
  remarks: { type: String, default: '' }
});
const WithdrawalRequest = mongoose.model('WithdrawalRequest', withdrawalRequestSchema);

const supportTicketSchema = new mongoose.Schema({
  user_id: mongoose.Schema.Types.ObjectId,
  subject: String,
  message: String,
  status: { type: String, default: 'Open' },
  time: String
});
const SupportTicket = mongoose.model('SupportTicket', supportTicketSchema);

const notificationSchema = new mongoose.Schema({
  user_id: mongoose.Schema.Types.ObjectId,
  title: String,
  message: String,
  time: String,
  is_read: { type: Number, default: 0 }
});
const Notification = mongoose.model('Notification', notificationSchema);

const customPlanSchema = new mongoose.Schema({
  plan_name: String,
  tier: String,
  cost: Number,
  daily_return: Number,
  duration_days: Number
});
const CustomPlan = mongoose.model('CustomPlan', customPlanSchema);

// Cashfree Configuration
Cashfree.XClientId = process.env.CLIENT_ID || "YOUR_CASHFREE_APP_ID";
Cashfree.XClientSecret = process.env.CLIENT_SECRET || "YOUR_CASHFREE_SECRET_KEY";
Cashfree.XEnvironment = Cashfree.Environment?.SANDBOX || "SANDBOX";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const emailOtpStore = {};
const sseClients = new Map();

// Strict password validation helper
const validatePassword = (pass) => {
  if (!pass) return false;
  const minLength = pass.length >= 6;
  const hasCapital = /[A-Z]/.test(pass);
  const hasNumber = /[0-9]/.test(pass);
  const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(pass);
  return minLength && hasCapital && hasNumber && hasSpecial;
};

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
  try {
    const user = await User.findById(userId);
    if (!user) return;
    let newVip = 1;
    if (user.total_invested >= 25000) newVip = 4;
    else if (user.total_invested >= 10000) newVip = 3;
    else if (user.total_invested >= 2500) newVip = 2;
    else newVip = 1;

    if (newVip !== user.vip_level) {
      user.vip_level = newVip;
      await user.save();
    }
  } catch (err) {
    console.error("VIP Tier Error:", err);
  }
}

async function distributeMultiLevelCommission(buyerId, planCost) {
  try {
    const buyer = await User.findById(buyerId);
    if (!buyer || !buyer.referred_by) return;

    const timeNow = new Date().toLocaleTimeString();
    const l1User = await User.findOne({ referral_code: buyer.referred_by });
    
    if (l1User) {
      const l1Reward = planCost >= 500 ? 250 : 0;
      if (l1Reward > 0) {
        l1User.wallet_balance += l1Reward;
        l1User.today_income += l1Reward;
        await l1User.save();

        await Transaction.create({ user_id: l1User._id, type: `REFERRAL REWARD (₹500+ Plan)`, amount: l1Reward, time: timeNow, status: 'Settled' });
        await Notification.create({
          user_id: l1User._id,
          title: "Referral Bonus Credited 💰",
          message: `Your recruit purchased a ₹${planCost} plan! ₹250 has been credited to your wallet.`,
          time: timeNow
        });
        notifyUserLive(l1User._id);
      }
    }
  } catch (err) {
    console.error("Commission Error:", err);
  }
}

cron.schedule('0 0 * * *', async () => {
  try {
    await User.updateMany({}, { today_income: 0 });
    const activePlans = await UserPlan.find({ days_remaining: { $gt: 0 }, status: "Active" });
    const timeNow = new Date().toLocaleTimeString();

    for (const plan of activePlans) {
      const user = await User.findById(plan.user_id);
      if (!user) continue;

      const updatedDays = plan.days_remaining - 1;
      let multiplier = 1.0;
      if (user.vip_level === 2) multiplier = 1.05;
      if (user.vip_level === 3) multiplier = 1.10;
      if (user.vip_level >= 4) multiplier = 1.15;

      const boostedReturn = Number((plan.daily_return * multiplier).toFixed(2));

      if (updatedDays > 0) {
        user.wallet_balance += boostedReturn;
        user.today_income += boostedReturn;
        await user.save();

        plan.days_remaining = updatedDays;
        await plan.save();

        await Transaction.create({ user_id: user._id, type: `DAILY YIELD`, amount: boostedReturn, time: timeNow, status: 'Settled' });
        notifyUserLive(user._id);
      } else {
        const totalSettlement = boostedReturn + plan.cost;
        user.wallet_balance += totalSettlement;
        user.today_income += boostedReturn;
        user.total_invested -= plan.cost;
        await user.save();

        plan.days_remaining = 0;
        plan.status = "Matured";
        await plan.save();

        await Transaction.create({ user_id: user._id, type: `PRINCIPAL RELEASE (${plan.plan_name})`, amount: totalSettlement, time: timeNow, status: 'Matured & Settled' });
        await checkAndUpdateVipTier(user._id);
        notifyUserLive(user._id);
      }
    }
  } catch (err) {
    console.error("Cron Job Error:", err);
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
  req.on('close', () => sseClients.delete(userId));
});

app.post('/api/send-email-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: "Invalid email address." });
    
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    emailOtpStore[email] = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };

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
    if (!response.ok) throw new Error(data.message || "Failed to send email via Brevo");

    res.json({ message: "OTP sent successfully to your email!" });
  } catch (err) {
    console.error("OTP Error:", err);
    res.status(500).json({ error: "Failed to send email OTP: " + err.message });
  }
});

app.post('/api/register-with-email-otp', async (req, res) => {
  try {
    const { name, email, password, otp, refCode } = req.body;
    if (!name || !email || !password || !otp) return res.status(400).json({ error: "All fields required." });
    
    if (!validatePassword(password)) {
      return res.status(400).json({ error: "Password must be at least 6 characters long, contain at least 1 capital letter, 1 number, and 1 special character." });
    }

    const stored = emailOtpStore[email];
    if (!stored || stored.otp !== otp.trim() || Date.now() > stored.expiresAt) return res.status(400).json({ error: "Invalid or expired OTP." });

    const existing = await User.findOne({ phone: email });
    if (existing) return res.status(400).json({ error: "Email already registered." });

    delete emailOtpStore[email];
    const cleanRef = (refCode || '').trim();
    const newRefCode = 'SLR' + Math.floor(1000 + Math.random() * 9000);
    const timeNow = new Date().toLocaleTimeString();

    const newUser = await User.create({
      name,
      phone: email,
      password,
      wallet_balance: 50,
      referral_code: newRefCode,
      referred_by: cleanRef,
      vip_level: 1
    });

    await Transaction.create({ user_id: newUser._id, type: 'WELCOME BONUS', amount: 50, time: timeNow, status: 'Settled' });
    notifyUserLive(newUser._id);

    if (cleanRef) {
      const inviter = await User.findOne({ referral_code: cleanRef });
      if (inviter) {
        inviter.wallet_balance += 50;
        await inviter.save();
        await Transaction.create({ user_id: inviter._id, type: 'AFFILIATE BONUS', amount: 50, time: timeNow, status: 'Settled' });
        notifyUserLive(inviter._id);
      }
    }
    res.json({ message: "Registration successful. ₹50 credited.", userId: newUser._id });
  } catch (err) {
    console.error("Registration Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reset-password-email', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!validatePassword(newPassword)) {
      return res.status(400).json({ error: "Password must be at least 6 characters long, contain at least 1 capital letter, 1 number, and 1 special character." });
    }

    const stored = emailOtpStore[email];
    if (!stored || stored.otp !== otp.trim() || Date.now() > stored.expiresAt) return res.status(400).json({ error: "Invalid OTP." });
    
    await User.findOneAndUpdate({ phone: email }, { password: newPassword });
    delete emailOtpStore[email];
    res.json({ message: "Password updated successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/set-txn-pin', async (req, res) => {
  try {
    const { userId, pin } = req.body;
    if (!pin || pin.toString().length !== 6) return res.status(400).json({ error: "PIN must be 6 digits." });
    await User.findByIdAndUpdate(userId, { txn_pin: pin.toString() });
    res.json({ message: "PIN saved." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login-email', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required." });

    const user = await User.findOne({ phone: email, password });
    if (!user) return res.status(400).json({ error: "Invalid credentials." });
    if (user.is_suspended) return res.status(403).json({ error: "Account suspended by administrator." });
    
    res.json({ message: "Login successful.", userId: user._id });
  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/kyc/submit', async (req, res) => {
  try {
    const { userId, aadhaar, pan } = req.body;
    if (!userId || !aadhaar || !pan) return res.status(400).json({ error: "All KYC fields required." });
    await User.findByIdAndUpdate(userId, { aadhaar, pan, kyc_status: "Under Review" });
    notifyUserLive(userId);
    res.json({ message: "KYC details submitted successfully. Verification under review." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const userId = req.query.userId;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found." });

    const plans = await UserPlan.find({ user_id: userId }).sort({ _id: -1 });
    const txns = await Transaction.find({ user_id: userId }).sort({ _id: -1 }).limit(15);
    const tickets = await SupportTicket.find({ user_id: userId }).sort({ _id: -1 });
    const customPlans = await CustomPlan.find({});
    
    const totalAumRes = await User.aggregate([{ $group: { _id: null, total: { $sum: "$total_invested" } } }]);
    const totalPayoutRes = await WithdrawalRequest.aggregate([{ $match: { status: "Settled" } }, { $group: { _id: null, total: { $sum: "$gross_amount" } } }]);

    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();
    const nextSettlement = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);

    const l1Users = await User.find({ referred_by: user.referral_code }).select('_id name phone referral_code');
    let l2Users = [];
    for (const u1 of l1Users) {
      const subs = await User.find({ referred_by: u1.referral_code }).select('_id');
      l2Users = l2Users.concat(subs);
    }

    const teamStats = { l1Count: l1Users.length, l2Count: l2Users.length, l3Count: 0, totalTeam: l1Users.length + l2Users.length, l1Members: l1Users };
    const claimedMilestones = (user.claimed_milestones || '').split(',').filter(Boolean);
    const completedTasks = (user.completed_tasks || '').split(',').filter(Boolean);

    res.json({
      user: { ...user.toObject(), userId: user._id, hasPin: Boolean(user.txn_pin && user.txn_pin.length === 6), claimedMilestones, completedTasks },
      canCheckIn: user.last_checkin !== today,
      canSpin: user.last_spin !== today,
      nextSettlementTimestamp: nextSettlement.getTime(),
      myPlans: plans,
      customPlans,
      transactions: txns,
      tickets,
      teamStats,
      platformStats: {
        totalAum: totalAumRes[0]?.total || 14250000,
        totalPayouts: totalPayoutRes[0]?.total || 8920000
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/notifications', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "User ID required." });
    const notes = await Notification.find({ user_id: userId }).sort({ _id: -1 }).limit(20);
    res.json({ success: true, notifications: notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/read', async (req, res) => {
  try {
    const { userId } = req.body;
    await Notification.updateMany({ user_id: userId }, { is_read: 1 });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/complete-task', async (req, res) => {
  try {
    const { userId, taskId, reward } = req.body;
    const user = await User.findById(userId);
    let completed = (user.completed_tasks || '').split(',').filter(Boolean);
    if (completed.includes(taskId.toString())) return res.status(400).json({ error: "Task already completed." });

    completed.push(taskId.toString());
    const timeNow = new Date().toLocaleTimeString();
    user.wallet_balance += reward;
    user.completed_tasks = completed.join(',');
    await user.save();

    await Transaction.create({ user_id: userId, type: `TASK REWARD (Task #${taskId})`, amount: reward, time: timeNow, status: 'Settled' });
    notifyUserLive(userId);
    res.json({ message: `Successfully claimed ₹${reward} reward!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/support/ticket', async (req, res) => {
  try {
    const { userId, subject, message } = req.body;
    if (!subject || !message) return res.status(400).json({ error: "Subject and message required." });
    const timeNow = new Date().toLocaleTimeString();
    await SupportTicket.create({ user_id: userId, subject, message, status: "Open", time: timeNow });
    notifyUserLive(userId);
    res.json({ message: "Support ticket submitted successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/claim-daily', async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await User.findById(userId);
    const today = new Date().toISOString().slice(0, 10);
    if (!user || user.last_checkin === today) return res.status(400).json({ error: "Already claimed." });

    const timeNow = new Date().toLocaleTimeString();
    user.wallet_balance += 5;
    user.today_income += 5;
    user.last_checkin = today;
    await user.save();

    await Transaction.create({ user_id: userId, type: 'DAILY BONUS', amount: 5, time: timeNow, status: 'Settled' });
    notifyUserLive(userId);
    res.json({ message: "₹5 credited." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/spin-wheel', async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await User.findById(userId);
    const today = new Date().toISOString().slice(0, 10);
    if (user.last_spin === today) return res.status(400).json({ error: "Already spun today." });

    const segments = [{ label: "₹10", amount: 10 }, { label: "₹25", amount: 25 }, { label: "Try Again", amount: 0 }, { label: "₹50", amount: 50 }, { label: "₹5", amount: 5 }, { label: "₹100", amount: 100 }];
    const roll = Math.random() * 100;
    let idx = roll < 35 ? 4 : roll < 65 ? 0 : roll < 85 ? 1 : roll < 95 ? 2 : roll < 99 ? 3 : 5;
    const prize = segments[idx];
    const timeNow = new Date().toLocaleTimeString();

    user.wallet_balance += prize.amount;
    user.last_spin = today;
    await user.save();

    if (prize.amount > 0) {
      await Transaction.create({ user_id: userId, type: `LUCKY SPIN (${prize.label})`, amount: prize.amount, time: timeNow, status: 'Settled' });
    }
    notifyUserLive(userId);
    res.json({ segmentIndex: idx, label: prize.label, message: prize.amount > 0 ? `Won ${prize.label}!` : "Better luck next time!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/buy-plan', async (req, res) => {
  try {
    const { userId, planName, tier, cost, dailyReturn, durationDays } = req.body;
    const user = await User.findById(userId);
    if (user.wallet_balance < cost) return res.status(400).json({ error: "Insufficient balance." });

    const timeNow = new Date().toLocaleTimeString();
    user.wallet_balance -= cost;
    user.total_invested += cost;
    await user.save();

    await UserPlan.create({
      user_id: userId,
      plan_name: planName,
      tier: tier || 'VIP1',
      cost,
      daily_return: dailyReturn,
      days_remaining: durationDays || 45,
      purchase_time: timeNow,
      status: 'Active'
    });

    await Transaction.create({ user_id: userId, type: `SUBSCRIPTION (${tier})`, amount: -cost, time: timeNow, status: 'Settled' });

    await distributeMultiLevelCommission(userId, cost);
    await checkAndUpdateVipTier(userId);
    notifyUserLive(userId);
    res.json({ message: `Successfully subscribed to ${planName}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/create-payment-order', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    const dep = Number(amount);
    if (!dep || dep < 200) return res.status(400).json({ error: "Minimum deposit is ₹200." });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found." });

    const orderId = "ORDER_" + Date.now();
    var request = {
      "order_amount": dep,
      "order_currency": "INR",
      "order_id": orderId,
      "customer_details": {
        "customer_id": user._id.toString(),
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

      await RechargeRequest.create({ user_id: userId, amount: dep, utr: orderId, time: timeNow, status: 'Pending' });
      res.json({ success: true, paymentSessionId, orderId });
    }).catch((error) => {
      console.error("Cashfree API Error:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to create Cashfree order." });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, upiId, pin } = req.body;
    const wAmt = Number(amount);
    const user = await User.findById(userId);

    if (!user) return res.status(404).json({ error: "User not found." });
    if (!user.txn_pin || user.txn_pin.length !== 6) return res.status(400).json({ error: "Please configure your 6-digit Security PIN first." });
    if (!pin || pin.toString() !== user.txn_pin) return res.status(403).json({ error: "Incorrect 6-digit Security PIN." });
    if (!wAmt || wAmt < 200) return res.status(400).json({ error: "Minimum withdrawal amount is ₹200." });
    if (wAmt > user.wallet_balance) return res.status(400).json({ error: "Insufficient wallet balance." });

    let feePct = user.vip_level === 2 ? 0.04 : user.vip_level === 3 ? 0.03 : user.vip_level >= 4 ? 0.02 : 0.05;
    const handlingFee = Math.round(wAmt * feePct);
    const netPayable = wAmt - handlingFee;
    const timeNow = new Date().toLocaleTimeString();

    user.wallet_balance -= wAmt;
    await user.save();

    await WithdrawalRequest.create({ user_id: userId, gross_amount: wAmt, fee: handlingFee, net_amount: netPayable, upi_id: upiId, time: timeNow, status: 'Pending' });
    await Transaction.create({ user_id: userId, type: `WITHDRAWAL QUEUED`, amount: -wAmt, time: timeNow, status: 'Pending Approval' });
    notifyUserLive(userId);

    res.json({ message: `Withdrawal submitted! Net ₹${netPayable} queued for payout (${feePct * 100}% fee).` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'admin@123') res.json({ success: true });
    else res.status(401).json({ error: "Invalid credentials." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/overview', async (req, res) => {
  try {
    const recharges = await RechargeRequest.find({}).populate('user_id', 'name phone').sort({ _id: -1 }).limit(50);
    const withdrawals = await WithdrawalRequest.find({}).populate('user_id', 'name phone').sort({ _id: -1 }).limit(50);
    const users = await User.find({}).sort({ _id: -1 }).lean();
    const formattedUsers = users.map(u => ({ ...u, fullname: u.name, email: u.phone }));
    
    const tickets = await SupportTicket.find({}).populate('user_id', 'name phone').sort({ _id: -1 });
    const customPlans = await CustomPlan.find({});
    const transactions = await Transaction.find({}).populate('user_id', 'name').sort({ _id: -1 }).limit(100);
    
    const totalUsers = users.length;
    const totalDeposits = users.reduce((sum, u) => sum + Number(u.wallet_balance || 0), 0);
    const totalAumRes = await User.aggregate([{ $group: { _id: null, total: { $sum: "$total_invested" } } }]);
    const pendingPayoutsRes = await WithdrawalRequest.aggregate([{ $match: { status: "Pending" } }, { $group: { _id: null, total: { $sum: "$net_amount" } } }]);

    res.json({
      recharges,
      withdrawals,
      users: formattedUsers,
      tickets,
      customPlans,
      transactions,
      totalUsers,
      totalDeposits,
      totalAum: totalAumRes[0]?.total || 0,
      pendingPayouts: pendingPayoutsRes[0]?.total || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await User.find({}).sort({ _id: -1 }).lean();
    const formattedUsers = users.map(u => ({ ...u, fullname: u.name, email: u.phone, status: 'Active' }));
    res.json({ success: true, users: formattedUsers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/kyc-action', async (req, res) => {
  try {
    const { userId, status } = req.body;
    await User.findByIdAndUpdate(userId, { kyc_status: status });
    notifyUserLive(userId);
    res.json({ message: `KYC status updated to ${status}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/ticket-resolve', async (req, res) => {
  try {
    const { ticketId } = req.body;
    await SupportTicket.findByIdAndUpdate(ticketId, { status: "Resolved" });
    res.json({ message: "Support ticket marked as resolved." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/broadcast', async (req, res) => {
  try {
    const { message } = req.body;
    const users = await User.find({}, '_id');
    const timeNow = new Date().toLocaleTimeString();
    for (const u of users) {
      await Notification.create({ user_id: u._id, title: "Platform Announcement 📢", message, time: timeNow });
      notifyUserLive(u._id);
    }
    res.json({ message: "Announcement broadcasted successfully to all users!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/user-history', async (req, res) => {
  try {
    const userId = req.query.userId;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    const plans = await UserPlan.find({ user_id: userId });
    const referrals = await User.find({ referred_by: user.referral_code }, 'id name phone');
    res.json({ success: true, user, plans, referrals, teamCount: referrals.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/suspend-user', async (req, res) => {
  try {
    const { userId, suspend } = req.body;
    await User.findByIdAndUpdate(userId, { is_suspended: suspend ? 1 : 0 });
    notifyUserLive(userId);
    res.json({ success: true, message: `User account status updated successfully.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/create-plan', async (req, res) => {
  try {
    const { planName, tier, cost, dailyReturn, durationDays } = req.body;
    await CustomPlan.create({ plan_name: planName, tier, cost, daily_return: dailyReturn, duration_days: durationDays });
    res.json({ success: true, message: "Investment plan created successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const { wallet_balance, adjustment_type, amount, reason } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    if (adjustment_type && amount) {
      const amt = Number(amount);
      if (adjustment_type === 'credit') user.wallet_balance += amt;
      else user.wallet_balance -= amt;
      await user.save();
      await Transaction.create({ user_id: userId, type: `ADMIN ${adjustment_type.toUpperCase()} (${reason || 'Manual Adjustment'})`, amount: adjustment_type === 'credit' ? amt : -amt, time: new Date().toLocaleTimeString(), status: 'Settled' });
    } else if (wallet_balance !== undefined) {
      user.wallet_balance = wallet_balance;
      await user.save();
    }
    notifyUserLive(userId);
    res.json({ success: true, message: "User wallet updated successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    await User.findByIdAndDelete(userId);
    res.json({ success: true, message: "User deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/recharge-action', async (req, res) => {
  try {
    const { requestId, action } = req.body;
    const reqData = await RechargeRequest.findById(requestId);
    if (!reqData) return res.status(404).json({ error: "Request not found." });

    const timeNow = new Date().toLocaleTimeString();
    const user = await User.findById(reqData.user_id);

    if (action === 'approve') {
      reqData.status = "Approved";
      await reqData.save();

      if (user) {
        user.wallet_balance += reqData.amount;
        await user.save();
      }

      await Transaction.create({ user_id: reqData.user_id, type: `DEPOSIT APPROVED`, amount: reqData.amount, time: timeNow, status: 'Settled' });
      await Notification.create({ user_id: reqData.user_id, title: "Deposit Approved ⚡", message: `Your deposit of ₹${reqData.amount} has been successfully credited to your wallet.`, time: timeNow });

      notifyUserLive(reqData.user_id);
      res.json({ message: "Deposit approved & credited to user wallet." });
    } else {
      reqData.status = "Rejected";
      await reqData.save();

      await Notification.create({ user_id: reqData.user_id, title: "Deposit Rejected ❌", message: `Your deposit request of ₹${reqData.amount} was rejected by admin.`, time: timeNow });
      notifyUserLive(reqData.user_id);
      res.json({ message: "Deposit rejected." });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/withdraw-action', async (req, res) => {
  try {
    const { requestId, action } = req.body;
    const reqData = await WithdrawalRequest.findById(requestId);
    if (!reqData) return res.status(404).json({ error: "Request not found." });

    const timeNow = new Date().toLocaleTimeString();
    const user = await User.findById(reqData.user_id);

    if (action === 'approve') {
      reqData.status = "Settled";
      await reqData.save();

      await Transaction.create({ user_id: reqData.user_id, type: `WITHDRAWAL SETTLED`, amount: 0, time: timeNow, status: 'Settled' });
      await Notification.create({ user_id: reqData.user_id, title: "Withdrawal Settled 🏦", message: `Your withdrawal of ₹${reqData.net_amount} has been sent to your UPI ID.`, time: timeNow });

      notifyUserLive(reqData.user_id);
      res.json({ message: "Withdrawal settled & payout triggered." });
    } else {
      reqData.status = "Rejected";
      await reqData.save();

      if (user) {
        user.wallet_balance += reqData.gross_amount;
        await user.save();
      }

      await Transaction.create({ user_id: reqData.user_id, type: `WITHDRAWAL REFUNDED`, amount: reqData.gross_amount, time: timeNow, status: 'Refunded' });
      await Notification.create({ user_id: reqData.user_id, title: "Withdrawal Refunded ⚠️", message: `Your withdrawal of ₹${reqData.gross_amount} was rejected. Funds have been refunded to your wallet.`, time: timeNow });

      notifyUserLive(reqData.user_id);
      res.json({ message: "Withdrawal rejected & refunded." });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Enterprise server running on port ${PORT}`);
});