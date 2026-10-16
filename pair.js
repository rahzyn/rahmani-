const { makeid } = require('./id');
const express = require('express');
const fs = require('fs');
const path = require('path');
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
//   🧹 CLEANUP FUNCTION
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
//   🧹 AUTO CLEANUP OLD SESSIONS (every 5 min)
// ═══════════════════════════════════════════
setInterval(async () => {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) return;
    
    try {
        const folders = fs.readdirSync(tempDir);
        const now = Date.now();
        const MAX_AGE = 10 * 60 * 1000; // 10 minutes
        
        for (const folder of folders) {
            const folderPath = path.join(tempDir, folder);
            try {
                const stats = fs.statSync(folderPath);
                if (now - stats.mtimeMs > MAX_AGE) {
                    await removeFile(folderPath);
                    console.log(`🧹 Cleaned old session: ${folder}`);
                }
            } catch (e) {}
        }
    } catch (e) {}
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════
//   🛡️ SIMPLE RATE LIMIT (in-memory)
// ═══════════════════════════════════════════
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS = 3; // 3 requests per minute per IP

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
    
    if (record.count >= MAX_REQUESTS) {
        return true;
    }
    
    record.count++;
    return false;
}

// Clean rate limit map every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of rateLimitMap.entries()) {
        if (now - record.start > RATE_LIMIT_WINDOW) {
            rateLimitMap.delete(ip);
        }
    }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════
//   🔑 MAIN PAIR CODE ROUTE
// ═══════════════════════════════════════════
router.get('/', async (req, res) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    
    // Rate limiting
    if (isRateLimited(clientIp)) {
        return res.status(429).json({ 
            code: "Too many requests. Please wait 1 minute before trying again." 
        });
    }
    
    const id = makeid();
    let num = req.query.number;
    
    // ═══════════════════════════════════════════
    //   ✅ VALIDATE NUMBER
    // ═══════════════════════════════════════════
    if (!num) {
        return res.status(400).json({ code: "Please provide a phone number." });
    }
    
    num = num.replace(/[^0-9]/g, '');
    
    if (num.length < 10 || num.length > 15) {
        return res.status(400).json({ code: "Invalid phone number. Use country code (e.g., 255693629079)." });
    }
    
    let pairingCodeSent = false;
    let socketRef = null;
    let timeoutHandle = null;
    
    // ═══════════════════════════════════════════
    //   ⏱️ TIMEOUT (60 seconds max)
    // ═══════════════════════════════════════════
    timeoutHandle = setTimeout(async () => {
        if (!res.headersSent) {
            try {
                if (socketRef) await socketRef.ws?.close();
            } catch (e) {}
            await removeFile('./temp/' + id);
            res.status(408).json({ code: "Request timeout. Please try again." });
        }
    }, 60000);
    
    // ═══════════════════════════════════════════
    //   🚀 PAIR CODE FUNCTION
    // ═══════════════════════════════════════════
    async function RAHMANI_PAIR_CODE() {
        const { state, saveCreds } = await useMultiFileAuthState('./temp/' + id);
        
        try {
            const { version } = await fetchLatestBaileysVersion();
            
            const sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys, 
                        pino({ level: "fatal" }).child({ level: "fatal" })
                    ),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
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
                //   📱 PAIR CODE GENERATION
                // ═══════════════════════════════════════════
                if (qr && !pairingCodeSent && !sock.authState.creds.registered) {
                    pairingCodeSent = true;
                    try {
                        await delay(1500);
                        const code = await sock.requestPairingCode(num);
                        clearTimeout(timeoutHandle);
                        
                        if (!res.headersSent) {
                            res.json({ 
                                code: code,
                                message: "Enter this code in WhatsApp → Linked Devices"
                            });
                        }
                    } catch (e) {
                        console.log("❌ Pair error:", e.message);
                        clearTimeout(timeoutHandle);
                        await removeFile('./temp/' + id);
                        
                        if (!res.headersSent) {
                            res.status(500).json({ 
                                code: "Service is Currently Unavailable. Try again." 
                            });
                        }
                    }
                }
                
                // ═══════════════════════════════════════════
                //   ✅ CONNECTION OPEN
                // ═══════════════════════════════════════════
                if (connection === "open") {
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

✅ *Pair Code Connected Successfully!*

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
                        
                        // Close and cleanup
                        await delay(500);
                        await sock.ws.close();
                        await removeFile('./temp/' + id);
                        
                        console.log(`✅ Session generated for ${num}`);
                        
                    } catch (e) {
                        console.error("❌ Session send error:", e.message);
                        await removeFile('./temp/' + id);
                    }
                }
                
                // ═══════════════════════════════════════════
                //   🔄 RECONNECT IF CLOSED
                // ═══════════════════════════════════════════
                else if (connection === "close" && lastDisconnect?.error?.output?.statusCode !== 401) {
                    // Don't reconnect if already got pair code
                    if (!pairingCodeSent) {
                        await delay(5000);
                        RAHMANI_PAIR_CODE();
                    }
                }
            });
            
        } catch (err) {
            console.error("❌ Service error:", err.message);
            clearTimeout(timeoutHandle);
            await removeFile('./temp/' + id);
            
            if (!res.headersSent) {
                res.status(500).json({ 
                    code: "Service is Currently Unavailable. Try again." 
                });
            }
        }
    }
    
    return await RAHMANI_PAIR_CODE();
});

module.exports = router;
