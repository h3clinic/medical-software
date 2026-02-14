const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const routes = require('./routes/index');

const app = express();
const PORT = process.env.PORT || 3000;

// Access code for the clinic
const VALID_ACCESS_CODE = '200882';

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from public folder
app.use(express.static(path.join(__dirname, '../public')));

// Access code verification endpoint
app.post('/api/verify-access', (req, res) => {
    const { code } = req.body;
    if (code === VALID_ACCESS_CODE) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'Invalid access code' });
    }
});

// Access code middleware for protected routes
const checkAccessCode = (req, res, next) => {
    const accessCode = req.headers['x-access-code'];
    if (accessCode === VALID_ACCESS_CODE) {
        next();
    } else {
        res.status(401).json({ message: 'Access denied. Invalid access code.' });
    }
};

// API Routes (protected)
app.use('/api', checkAccessCode, routes);

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ message: 'Something went wrong!', error: err.message });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`API available at http://localhost:${PORT}/api`);
});
