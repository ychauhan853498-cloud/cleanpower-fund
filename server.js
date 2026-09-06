const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Database Connection & Table Initialization
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fullname TEXT,
            email TEXT,
            deposit_amount REAL,
            status TEXT DEFAULT 'Active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }
});

// Admin Route to serve admin.html explicitly
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// API: Fetch all user records for Admin Dashboard
app.get('/api/admin/users', (req, res) => {
    db.all("SELECT * FROM users ORDER BY id DESC", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, users: rows });
    });
});

// API: Register User / Add Deposit
app.post('/api/users/register', (req, res) => {
    const { fullname, email, deposit_amount } = req.body;
    const query = `INSERT INTO users (fullname, email, deposit_amount) VALUES (?, ?, ?)`;
    db.run(query, [fullname, email, deposit_amount || 0], function(err) {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, message: 'User registered successfully!', id: this.lastID });
    });
});

// API: Update user deposit amount or status
app.put('/api/admin/users/:id', (req, res) => {
    const userId = req.params.id;
    const { deposit_amount, status } = req.body;
    const query = `UPDATE users SET deposit_amount = COALESCE(?, deposit_amount), status = COALESCE(?, status) WHERE id = ?`;
    db.run(query, [deposit_amount, status, userId], function(err) {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, message: 'User updated successfully' });
    });
});

// API: Delete user record by ID
app.delete('/api/admin/users/:id', (req, res) => {
    const userId = req.params.id;
    db.run("DELETE FROM users WHERE id = ?", [userId], function(err) {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, message: 'User deleted successfully' });
    });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});