const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Database Connection
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
    }
});

// Admin Route to serve admin.html explicitly
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Admin API to fetch records
app.get('/api/admin/records', (req, res) => {
    db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, tables) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        // Try fetching from records table or fallback to sqlite_master
        db.all("SELECT * FROM records", [], (err, rows) => {
            const data = err ? [] : rows;
            res.json({ success: true, tables: tables, records: data });
        });
    });
});

// Admin API to save/insert new record into database
app.post('/api/admin/save', (req, res) => {
    const { title, description } = req.body;
    
    // Agar 'records' table nahi hai, toh use pehle create kar lete hain
    db.run("CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, description TEXT)", (err) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }

        const query = `INSERT INTO records (title, description) VALUES (?, ?)`;
        db.run(query, [title, description], function(err) {
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }
            res.json({ success: true, message: 'Record saved successfully!', id: this.lastID });
        });
    });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});