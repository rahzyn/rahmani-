const { makeid } = require('./id');
const QRCode = require('qrcode');
const express = require('express');
const path = require('path');
const fs = require('fs');
let router = express.Router();
const pino = require("pino");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

// ═══════════════════════════════════════════
//   🧹 CLEANUP
// ═══════════════════════════════════════════
async function removeFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    try {
        await fs.rmSync(filePath, { recursive: true, force: true });
        return true;
    } catch (e) {
        console.log("Cleanup error:", e.message);
        return false;
    }
}

// ═══════════════════════════════════════════
//   🧹 AUTO CLEANUP OLD SESSIONS
// ═══════════════════════════════════════════
setInterval(async () => {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) return;
    
    try {
        const folders = fs.readdirSync(tempDir);
        const now = Date.now();
        const MAX_AGE = 10 * 60 * 1000;
        
        for (const folder of folders) {
            const folderPath = path.join(tempDir, folder);
            try {
                const stats = fs.statSync(folderPath);
                if (now - stats.mtimeMs > MAX_AGE) {
                    await removeFile(folderPath);
                    console.log(`🧹 Cleaned old QR session: ${folder}`);
                }
            } catch (e) {}
        }
    } catch (e) {}
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════
//   🛡️ RATE LIMITING
// ═══════════════════════════════════════════
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_REQUESTS = 3;

function isRateLimited(ip) {
    const now = Date.now();
    const record = rateLimitMap.get(ip);
    
    if (!record) {
        rateLimitMap.set(ip, { count: 1, start: now });
        return false;
    }
    
    if (now - record.start > RATE_LIMIT_WINDOW) {
        rateLimitMap.set(ip, { count: 1, start: now });
        return false;
    }
    
    if (record.count >= MAX_REQUESTS) return true;
    
    record.count++;
    return false;
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of rateLimitMap.entries()) {
        if (now - record.start > RATE_LIMIT_WINDOW) {
            rateLimitMap.delete(ip);
        }
    }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════
//   📱 QR CODE ROUTE
// ═══════════════════════════════════════════
router.get('/', async (req, res) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    
    if (isRateLimited(clientIp)) {
        return res.status(429).json({ 
            code: "Too many requests. Please wait 1 minute." 
        });
    }
    
    const id = makeid();
    let socketRef = null;
    let timeoutHandle = null;
    let sessionCompleted = false;
    
    // Timeout (25s for Heroku)
    timeoutHandle = setTimeout(async () => {
        if (!res.headersSent && !sessionCompleted) {
            try {
                if (socketRef) await socketRef.ws?.close();
            } catch (e) {}
            await removeFile('./temp/' + id);
            res.status(408).json({ code: "Request timeout. Try again." });
        }
    }, 25000);
    
    async function RAHMANI_QR_CODE() {
        const { state, saveCreds } = await useMultiFileAuthState('./temp/' + id);
        
        try {
            const { version } = await fetchLatestBaileysVersion();
            
            const sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: "silent" })
                    ),
                },
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                browser: ["RAHMANI-XMD", "Chrome", "1.0.0"],
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                syncFullHistory: false,
                fireInitQueries: false,
            });
            
            socketRef = sock;
            sock.ev.on('creds.update', saveCreds);
            
            sock.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect, qr } = s;
                
                // ═══════════════════════════════════════════
                //   📱 SEND QR CODE
                // ═══════════════════════════════════════════
                if (qr && !res.headersSent) {
                    try {
                        const qrBuffer = await QRCode.toBuffer(qr, {
                            type: 'png',
                            width: 400,
                            margin: 1,
                        });
                        
                        res.setHeader('Content-Type', 'image/png');
                        res.end(qrBuffer);
                    } catch (e) {
                        console.error("QR generation error:", e.message);
                        if (!res.headersSent) {
                            res.status(500).json({ code: "QR generation failed" });
                        }
                    }
                }
                
                // ═══════════════════════════════════════════
                //   ✅ CONNECTION OPEN — Send session
                // ═══════════════════════════════════════════
                if (connection === "open") {
                    sessionCompleted = true;
                    clearTimeout(timeoutHandle);
                    
                    try {
                        await delay(3000);
                        
                        const credsPath = `./temp/${id}/creds.json`;
                        if (!fs.existsSync(credsPath)) {
                            throw new Error("Session file not found");
                        }
                        
                        const data = fs.readFileSync(credsPath);
                        const b64data = Buffer.from(data).toString('base64');
                        
                        await delay(1000);
                        
                        // Send session ID
                        const sessionMsg = await sock.sendMessage(
                            sock.user.id,
                            { text: b64data }
                        );
                        
                        // Send info message
                        const infoMsg = `
╔════════════════════════════╗
║   ⚡ RAHMANI-XMD ⚡        ║
║   SESSION GENERATED        ║
╚════════════════════════════╝

✅ *QR Code Scanned Successfully!*

📌 *What next?*
1. Copy the SESSION ID above
2. Add it to your bot's config
3. Deploy your bot

━━━━━━━━━━━━━━━━━━━━━━━━━━
📞 *Owner:* wa.me/255693629079
📦 *Repo:* github.com/Qartde/RAHMANI-XMD
📢 *Channel:* whatsapp.com/channel/0029VatokI45EjxufALmY32X
━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ *Keep your session safe!*
🔒 *Never share it with anyone*
`;

                        await sock.sendMessage(
                            sock.user.id,
                            { text: infoMsg },
                            { quoted: sessionMsg }
                        );
                        
                        await delay(500);
                        await sock.ws.close();
                        await removeFile('./temp/' + id);
                        
                        console.log(`✅ QR Session generated`);
                        
                    } catch (e) {
                        console.error("❌ Session send error:", e.message);
                        await removeFile('./temp/' + id);
                    }
                }
                
                // ═══════════════════════════════════════════
                //   🔄 RECONNECT IF CLOSED
                // ═══════════════════════════════════════════
                else if (connection === "close" && lastDisconnect?.error?.output?.statusCode !== 401) {
                    await delay(5000);
                    RAHMANI_QR_CODE();
                }
            });
            
        } catch (err) {
            console.error("❌ QR Service error:", err.message);
            clearTimeout(timeoutHandle);
            await removeFile('./temp/' + id);
            
            if (!res.headersSent) {
                res.status(500).json({ code: "Service is Currently Unavailable" });
            }
        }
    }
    
    return await RAHMANI_QR_CODE();
});

module.exports = router;
