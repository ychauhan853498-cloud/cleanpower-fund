// Admin API Route to fetch records/users from SQLite
app.get('/api/admin/records', (req, res) => {
    // Apne table ke naam ke mutabiq query yahan change kar sakte hain (e.g., 'users', 'investments')
    db.all("SELECT * FROM sqlite_master WHERE type='table'", [], (err, tables) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        // Example: Fetching data from your main table
        db.all("SELECT * FROM users", [], (err, rows) => {
            // Agar 'users' table na ho toh empty array return kar dega
            const data = err ? [] : rows;
            res.json({ success: true, tables: tables, records: data });
        });
    });
});