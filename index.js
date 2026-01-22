import TelegramBot from "node-telegram-bot-api";
import { google } from "googleapis";
import http from "http";
import url from "url";
import fs from "fs";

/* =======================
   ENV
======================= */
const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

const WEBHOOK_PATH = "/webhook";
const SHEET_NAME = "DB INCES";

if (!BOT_TOKEN || !SHEET_ID || !GOOGLE_CREDENTIALS || !BASE_URL) {
  console.error("❌ ENV belum lengkap");
  process.exit(1);
}

/* =======================
   GOOGLE SHEETS
======================= */
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

/* =======================
   TELEGRAM BOT (WEBHOOK)
======================= */
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

await bot.setWebHook(`${BASE_URL}${WEBHOOK_PATH}`, {
  allowed_updates: ["message"],
});

/* =======================
   HTTP SERVER
======================= */
http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === "POST" && parsed.pathname === WEBHOOK_PATH) {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        await bot.processUpdate(JSON.parse(body));
        res.end("OK");
      } catch (e) {
        console.error(e);
        res.end("ERROR");
      }
    });
  } else {
    res.end("Bot running");
  }
}).listen(PORT);

/* =======================
   UTIL
======================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chunk = (arr, parts) => {
  const size = Math.ceil(arr.length / parts);
  return Array.from({ length: parts }, (_, i) =>
    arr.slice(i * size, (i + 1) * size)
  );
};

const buildVcard = (nums, label) =>
  nums.map(
`BEGIN:VCARD
VERSION:3.0
FN:${label}
TEL;TYPE=CELL:${nums.shift()}
END:VCARD`
).join("\n");

/* =======================
   COMMAND MAP
======================= */
const COMMANDS = {
  vcardfresh: { col: "A", label: "FRESH" },
  vcardfu: { col: "D", label: "FU" },
};

/* =======================
   QUEUE
======================= */
const queue = [];
let busy = false;

async function processQueue() {
  if (busy || queue.length === 0) return;
  busy = true;

  const { chatId, userId, take, type } = queue.shift();
  const { col, label } = COMMANDS[type];

  try {
    await bot.sendMessage(chatId, "✅ Udah di kirim lewat japri eaak...");

    // WAJIB TEST DM
    await bot.sendMessage(userId, "⏳ Sebentar beb...");

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!${col}:${col}`,
    });

    const numbers = (res.data.values || [])
      .map(v => String(v[0]).replace(/\D/g, ""))
      .filter(v => v.length >= 10);

    if (numbers.length < take) {
      await bot.sendMessage(chatId, "❌ Stok tidak cukup");
      busy = false;
      return processQueue();
    }

    const selected = numbers.slice(0, take);
    const remain = numbers.slice(take);
    const files = chunk(selected, 5);

    for (let i = 0; i < files.length; i++) {
      const vcardText = files[i].map(
        (n, x) => `BEGIN:VCARD
VERSION:3.0
FN:${label}-${x + 1}
TEL;TYPE=CELL:${n}
END:VCARD`
      ).join("\n");

      const buffer = Buffer.from(vcardText, "utf8");

      await bot.sendDocument(
        userId,
        buffer,
        {},
        {
          filename: `${label}_${i + 1}.vcf`,
          contentType: "text/vcard",
        }
      );

      await sleep(1200);
    }

    // UPDATE SHEET
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!${col}:${col}`,
    });

    if (remain.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!${col}1`,
        valueInputOption: "RAW",
        requestBody: {
          values: remain.map(v => [v]),
        },
      });
    }

    await bot.sendMessage(userId, "✅ VCARD udah dikirim semua eakkk");

  } catch (e) {
    console.error("❌ ERROR:", e);
    await bot.sendMessage(chatId, "❌ Gagal kirim file. Pastikan kamu sudah /start bot.");
  }

  busy = false;
  processQueue();
}

/* =======================
   MESSAGE HANDLER
======================= */
bot.on("message", msg => {
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (msg.text === "/start") {
    bot.sendMessage(chatId, "✅ Bot aktif. Gunakan:\n#vcardfresh JUMLAH\n#vcardfu JUMLAH");
    return;
  }

  const m = msg.text.match(/^#(vcardfresh|vcardfu)\s+(\d+)/i);
  if (!m) return;

  queue.push({
    chatId,
    userId,
    type: m[1].toLowerCase(),
    take: parseInt(m[2], 10),
  });

  bot.sendMessage(chatId, "📥 Cek japri ea");
  processQueue();
});

console.log("🤖 BOT FINAL FIX — FILE PASTI TERKIRIM");



