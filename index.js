import TelegramBot from "node-telegram-bot-api";
import { google } from "googleapis";
import http from "http";
import url from "url";

/* =======================
   ENV
======================= */
const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

const WEBHOOK_PATH = "/webhook";
const SHEET_NAME = "DB CUAN";
const REPORT_SHEET = "REPORT";

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
http
  .createServer((req, res) => {
    const parsed = url.parse(req.url, true);

    if (req.method === "POST" && parsed.pathname === WEBHOOK_PATH) {
      let body = "";
      req.on("data", (c) => (body += c));
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
  })
  .listen(PORT);

/* =======================
   UTIL
======================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chunk = (arr, parts) => {
  const size = Math.ceil(arr.length / parts);
  return Array.from({ length: parts }, (_, i) =>
    arr.slice(i * size, (i + 1) * size)
  );
};

/* =======================
   REPORT (HARIAN) - WIB
   Sheet: REPORT
   Kolom: DATE | FRESH_OUT | FU_OUT
======================= */
const todayKeyWIB = () => {
  const d = new Date();
  const wib = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const yyyy = wib.getUTCFullYear();
  const mm = String(wib.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(wib.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

async function getReportRow(dateStr) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${REPORT_SHEET}!A2:C`,
  });

  const rows = res.data.values || [];

  for (let i = 0; i < rows.length; i++) {
    const [date, fresh, fu] = rows[i] || [];
    if (String(date || "").trim() === dateStr) {
      return {
        rowIndex: i + 2,
        fresh: parseInt(fresh || "0", 10) || 0,
        fu: parseInt(fu || "0", 10) || 0,
      };
    }
  }

  return { rowIndex: null, fresh: 0, fu: 0 };
}

async function addToReport(type, amount) {
  const dateStr = todayKeyWIB();
  const row = await getReportRow(dateStr);

  const freshAdd = type === "vcardfresh" ? amount : 0;
  const fuAdd = type === "vcardfu" ? amount : 0;

  if (!row.rowIndex) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${REPORT_SHEET}!A1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[dateStr, freshAdd, fuAdd]],
      },
    });
    return { dateStr, fresh: freshAdd, fu: fuAdd };
  }

  const newFresh = row.fresh + freshAdd;
  const newFu = row.fu + fuAdd;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${REPORT_SHEET}!A${row.rowIndex}:C${row.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[dateStr, newFresh, newFu]],
    },
  });

  return { dateStr, fresh: newFresh, fu: newFu };
}

async function getReportToday() {
  const dateStr = todayKeyWIB();
  const row = await getReportRow(dateStr);
  return { dateStr, fresh: row.fresh, fu: row.fu };
}

async function getReportByDate(dateStr) {
  const row = await getReportRow(dateStr);
  return {
    dateStr,
    fresh: row.fresh,
    fu: row.fu,
    found: row.rowIndex !== null,
  };
}

// Opsional: reset counter hari ini (kalau salah hitung / testing)
async function resetReportToday() {
  const dateStr = todayKeyWIB();
  const row = await getReportRow(dateStr);

  if (!row.rowIndex) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${REPORT_SHEET}!A1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[dateStr, 0, 0]],
      },
    });
    return { dateStr, fresh: 0, fu: 0 };
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${REPORT_SHEET}!A${row.rowIndex}:C${row.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[dateStr, 0, 0]] },
  });

  return { dateStr, fresh: 0, fu: 0 };
}

/* =======================
   REPORT BULANAN
   /reportmonth 12 2025
   /reportmonth 1 2026
   /reportmonth 2 2026
======================= */
async function getReportMonth(month, year) {
  const mm = String(month).padStart(2, "0");
  const prefix = `${year}-${mm}-`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${REPORT_SHEET}!A2:C`,
  });

  const rows = res.data.values || [];
  let freshSum = 0;
  let fuSum = 0;
  let daysCount = 0;

  for (const r of rows) {
    const [date, fresh, fu] = r || [];
    const ds = String(date || "").trim();
    if (!ds.startsWith(prefix)) continue;

    freshSum += parseInt(fresh || "0", 10) || 0;
    fuSum += parseInt(fu || "0", 10) || 0;
    daysCount += 1;
  }

  return { year, month: mm, fresh: freshSum, fu: fuSum, days: daysCount };
}

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
    await bot.sendMessage(chatId, "✅ Cek Japri bro...");
    await bot.sendMessage(userId, "⏳ Sebentar Bro...");

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!${col}:${col}`,
    });

    const numbers = (res.data.values || [])
      .map((v) => String(v[0] || "").replace(/\D/g, ""))
      .filter((v) => v.length >= 10);

    if (numbers.length < take) {
      await bot.sendMessage(chatId, "❌ Stok tidak cukup");
      busy = false;
      return processQueue();
    }

    const selected = numbers.slice(0, take);
    const remain = numbers.slice(take);
    const files = chunk(selected, 5);

    for (let i = 0; i < files.length; i++) {
      const vcardText = files[i]
        .map(
          (n, x) => `BEGIN:VCARD
VERSION:3.0
FN:${label}-${x + 1}
TEL;TYPE=CELL:${n}
END:VCARD`
        )
        .join("\n");

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

    // UPDATE SHEET: clear kolom + append sisa
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
          values: remain.map((v) => [v]),
        },
      });
    }

    // UPDATE REPORT HARIAN (SETELAH SUKSES)
    let rep = null;
    try {
      rep = await addToReport(type, take);
    } catch (e) {
      console.error("❌ REPORT ERROR:", e);
    }

    if (rep) {
      await bot.sendMessage(
        userId,
        `✅ PASTIKAN TIDAK SALAH TEMPLATE. SEMANGAT!\n\n📊 REPORT HARI INI (${rep.dateStr})\nFRESH keluar: ${rep.fresh}\nFU keluar: ${rep.fu}`
      );
    } else {
      await bot.sendMessage(userId, "✅ PASTIKAN TIDAK SALAH TEMPLATE. SEMANGAT!");
    }
  } catch (e) {
    console.error("❌ ERROR:", e);
    await bot.sendMessage(
      chatId,
      "❌ Gagal kirim file. Pastikan kamu sudah /start bot."
    );
  }

  busy = false;
  processQueue();
}

/* =======================
   MESSAGE HANDLER
======================= */
bot.on("message", async (msg) => {
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();

  if (text === "/start") {
    await bot.sendMessage(
      chatId,
      "✅ Bot aktif.\n\nGunakan:\n#vcardfresh JUMLAH\n#vcardfu JUMLAH\n\nLaporan:\n/report\n/reportdate YYYY-MM-DD\n/reportmonth BULAN(1-12) TAHUN\n/reset (opsional)\n\nContoh:\n/reportdate 2026-02-22\n/reportmonth 12 2025\n/reportmonth 1 2026\n/reportmonth 2 2026"
    );
    return;
  }

  // REPORT HARIAN
  if (text === "/report") {
    try {
      const rep = await getReportToday();
      await bot.sendMessage(
        chatId,
        `📊 REPORT HARI INI (${rep.dateStr})\n✅ FRESH keluar: ${rep.fresh}\n✅ FU keluar: ${rep.fu}`
      );
    } catch (e) {
      console.error("❌ /report ERROR:", e);
      await bot.sendMessage(
        chatId,
        "❌ Gagal ambil report. Pastikan sheet REPORT ada & header-nya bener."
      );
    }
    return;
  }

  // REPORT TANGGAL TERTENTU: /reportdate 2026-02-22
  const rd = text.match(/^\/reportdate\s+(\d{4}-\d{2}-\d{2})$/i);
  if (rd) {
    const dateStr = rd[1];
    try {
      const rep = await getReportByDate(dateStr);
      if (!rep.found) {
        await bot.sendMessage(chatId, `📊 REPORT ${dateStr}\nData tidak ditemukan.`);
      } else {
        await bot.sendMessage(
          chatId,
          `📊 REPORT ${dateStr}\n✅ FRESH keluar: ${rep.fresh}\n✅ FU keluar: ${rep.fu}`
        );
      }
    } catch (e) {
      console.error("❌ /reportdate ERROR:", e);
      await bot.sendMessage(chatId, "❌ Gagal ambil report tanggal.");
    }
    return;
  }

  // REPORT BULANAN: /reportmonth 2 2026
  const rm = text.match(/^\/reportmonth\s+(\d{1,2})\s+(\d{4})$/i);
  if (rm) {
    const month = parseInt(rm[1], 10);
    const year = parseInt(rm[2], 10);

    if (month < 1 || month > 12) {
      await bot.sendMessage(
        chatId,
        "❌ Format salah. Contoh:\n/reportmonth 12 2025\n/reportmonth 1 2026\n/reportmonth 2 2026"
      );
      return;
    }

    try {
      const rep = await getReportMonth(month, year);
      await bot.sendMessage(
        chatId,
        `📅 REPORT BULAN ${rep.year}-${rep.month}\n✅ Total hari tercatat: ${rep.days}\n✅ FRESH keluar: ${rep.fresh}\n✅ FU keluar: ${rep.fu}`
      );
    } catch (e) {
      console.error("❌ /reportmonth ERROR:", e);
      await bot.sendMessage(chatId, "❌ Gagal ambil report bulanan.");
    }
    return;
  }

  // RESET (opsional)
  if (text === "/reset") {
    try {
      const rep = await resetReportToday();
      await bot.sendMessage(
        chatId,
        `♻️ Report hari ini di-reset (${rep.dateStr}).\nFRESH: 0\nFU: 0`
      );
    } catch (e) {
      console.error("❌ /reset ERROR:", e);
      await bot.sendMessage(chatId, "❌ Gagal reset report.");
    }
    return;
  }

  // VCard command
  const m = text.match(/^#(vcardfresh|vcardfu)\s+(\d+)/i);
  if (!m) return;

  queue.push({
    chatId,
    userId,
    type: m[1].toLowerCase(),
    take: parseInt(m[2], 10),
  });

  await bot.sendMessage(chatId, "📥 Cek japri Bro");
  processQueue();
});

console.log("🤖 BOT FINAL FIX — FILE PASTI TERKIRIM");
