const express = require('express');
const app = express();
const path = require('path');
const bodyParser = require("body-parser");

const PORT = process.env.PORT || 8000;
const __path = process.cwd();

// ═══════════════════════════════════════════
//   🔧 MIDDLEWARE
// ═══════════════════════════════════════════
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Trust Heroku proxy (kwa IP detection)
app.set('trust proxy', 1);

// Serve static files (CSS, JS, images)
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════
//   📱 ROUTES
// ═══════════════════════════════════════════
try {
    const qrRouter = require('./qr');
    const pairRouter = require('./pair');
    
    app.use('/qr', qrRouter);
    app.use('/code', pairRouter);
    app.use('/pair', pairRouter);
    
} catch (e) {
    console.log("⚠️ Router error:", e.message);
}

// ═══════════════════════════════════════════
//   🏠 HOME PAGE
// ═══════════════════════════════════════════
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ═══════════════════════════════════════════
//   🩺 HEALTH CHECK (for Heroku/Render)
// ═══════════════════════════════════════════
app.get('/health', (req, res) => {
    res.json({
        status: "OK",
        bot: "RAHMANI-XMD",
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// ═══════════════════════════════════════════
//   🚫 404 HANDLER
// ═══════════════════════════════════════════
app.use((req, res) => {
    res.status(404).json({
        error: "Not Found",
        path: req.path,
        bot: "RAHMANI-XMD"
    });
});

// ═══════════════════════════════════════════
//   🚨 ERROR HANDLER
// ═══════════════════════════════════════════
app.use((err, req, res, next) => {
    console.error("❌ Server error:", err.message);
    if (!res.headersSent) {
        res.status(500).json({
            error: "Internal Server Error",
            bot: "RAHMANI-XMD"
        });
    }
});

// ═══════════════════════════════════════════
//   🚀 START SERVER
// ═══════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║   ⚡ RAHMANI-XMD PAIRING SERVER ⚡       ║
║   Session Generator · Public Mode       ║
╚══════════════════════════════════════════╝

🚀 Server is running on port: ${PORT}
🌐 Local URL: http://localhost:${PORT}
📱 Pair Code: /code
📷 QR Code: /qr
🏠 Home: /

✅ Ready to receive requests!
`);
});

// ═══════════════════════════════════════════
//   🚨 GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
process.on('SIGTERM', () => {
    console.log('⚠️ SIGTERM received, closing server...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('⚠️ SIGINT received, closing server...');
    process.exit(0);
});

module.exports = app;
