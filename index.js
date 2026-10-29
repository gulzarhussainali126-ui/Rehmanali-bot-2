'use strict';
const fs = require('fs');
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys.makeWASocket;
const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = baileys;
const pino = require('pino');
const qrcode = require('qrcode-terminal');

// ====================== SETTINGS (EDIT THIS BLOCK) ======================
const SETTINGS = {
  BUSINESS_NAME: 'YOUR BUSINESS NAME',
  BUSINESS_TYPE: 'restaurant',            // restaurant / pizza shop / salon / clinic / shop / other
  CITY: 'YOUR CITY',
  CALL_PHONE: '03XX-XXXXXXX',
  OPENING_HOURS: '11:00 AM - 11:00 PM (every day)',
  BOT_NUMBER: '03XXXXXXXXX',              // the WhatsApp number the bot runs on
  OWNER_NUMBER: '',                       // optional, e.g. 03XXXXXXXXX (gets order/booking alerts)
  FLOW: 'ORDER',                          // 'ORDER' | 'BOOKING' | 'INFO'
  CURRENCY: 'Rs',
  // Menu items (ORDER/INFO) or services (BOOKING)
  ITEMS: [
    { name: '[ITEM 1 NAME]', price: 100 },
    { name: '[ITEM 2 NAME]', price: 200 },
    { name: '[ITEM 3 NAME]', price: 300 },
  ],
  DELIVERY: { enabled: true, fee: 150, time: '30-45 minutes' }, // enabled:false = no delivery (pickup)
  PAYMENT: {
    cash: true,                           // cash on delivery
    online: [                             // set to [] if no online payment
      { method: 'JazzCash', number: '03XXXXXXXXX', title: '[ACCOUNT TITLE]' },
      { method: 'EasyPaisa', number: '03XXXXXXXXX', title: '[ACCOUNT TITLE]' },
    ],
  },
  EXTRA_RULES: '',                        // optional note shown under the menu
};
// =========================================================================

const S = SETTINGS;
const SESSION_DIR = 'session_bot';
const logger = pino({ level: 'silent' });
const FLOW = String(S.FLOW || 'ORDER').toUpperCase();

const money = (n) => `${S.CURRENCY} ${n}`;
const toIntl = (num) => {
  let d = String(num || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '92' + d.slice(1);
  return d;
};
const validIntl = (d) => /^92\d{10}$/.test(d);

// ------------------------- state -------------------------
const sessions = new Map();
const newSession = () => ({ step: 'IDLE', cart: {}, phone: '' });
const getS = (chat) => {
  if (!sessions.has(chat)) sessions.set(chat, newSession());
  return sessions.get(chat);
};
const resetS = (chat) => sessions.set(chat, newSession());
const seen = new Set();
const usedIds = new Set();
const genId = (prefix) => {
  let id;
  do { id = `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`; } while (usedIds.has(id));
  usedIds.add(id);
  return id;
};

// ------------------------- texts -------------------------
function welcomeText() {
  return (
    `👋 Welcome to *${S.BUSINESS_NAME}*!\n` +
    `📍 ${S.CITY}\n` +
    `📞 Call us: ${S.CALL_PHONE}\n` +
    `🕐 Hours: ${S.OPENING_HOURS}\n\n` +
    `Reply *1* or *MENU* to see the ${FLOW === 'BOOKING' ? 'services' : 'menu'} 😊`
  );
}

function menuText() {
  const lines = S.ITEMS.map((it, i) => `${i + 1}. ${it.name} — ${money(it.price)}`);
  let head, foot;
  if (FLOW === 'BOOKING') {
    head = `💇 *${S.BUSINESS_NAME} — Services*`;
    foot = `\n📅 Reply with the *service number* to book.\n❌ Reply *0* to cancel.`;
  } else if (FLOW === 'INFO') {
    head = `📋 *${S.BUSINESS_NAME} — Menu*`;
    foot = `\n📞 For orders or bookings please call: ${S.CALL_PHONE}`;
  } else {
    head = `🍽️ *${S.BUSINESS_NAME} — Menu*`;
    foot =
      `\n🛒 To order, send item numbers like: *1x2, 5, 9*\n(1x2 = item 1, quantity 2)\n` +
      (S.DELIVERY.enabled
        ? `🚚 Delivery: ${money(S.DELIVERY.fee)} • ${S.DELIVERY.time}\n`
        : `🏪 Pickup only (no delivery)\n`) +
      `❌ Reply *0* to cancel.`;
  }
  const extra = S.EXTRA_RULES ? `\nℹ️ ${S.EXTRA_RULES}` : '';
  return `${head}\n\n${lines.join('\n')}\n${foot}${extra}`;
}

function totals(s) {
  let sub = 0;
  for (const [i, q] of Object.entries(s.cart)) sub += S.ITEMS[i - 1].price * q;
  const fee = S.DELIVERY.enabled ? S.DELIVERY.fee : 0;
  return { sub, fee, total: sub + fee };
}
function cartLines(s) {
  return Object.entries(s.cart).map(([i, q]) => `${q} x ${S.ITEMS[i - 1].name} = ${money(S.ITEMS[i - 1].price * q)}`);
}
function summaryText(s) {
  const t = totals(s);
  return (
    `🧾 *Your order*\n${cartLines(s).join('\n')}\n\n` +
    `Subtotal: ${money(t.sub)}\n` +
    (S.DELIVERY.enabled ? `Delivery: ${money(t.fee)}\n` : `Pickup: no delivery fee\n`) +
    `*Total: ${money(t.total)}*\n\n` +
    `Reply:\n*1* ✅ Confirm\n*2* ➕ Add more\n*0* ❌ Cancel`
  );
}

function payOptions() {
  const o = [];
  if (S.PAYMENT.cash) o.push('cash');
  if (S.PAYMENT.online && S.PAYMENT.online.length) o.push('online');
  if (!o.length) o.push('cash');
  return o;
}
const cashLabel = () => (S.DELIVERY.enabled ? 'Cash on delivery' : 'Cash on pickup');

function accountsText(s) {
  const t = totals(s);
  const acc = S.PAYMENT.online.map((a) => `• ${a.method}: *${a.number}*\n  Title: ${a.title}`).join('\n');
  return (
    `💳 *Online payment*\nPlease send *${money(t.total)}* to:\n${acc}\n\n` +
    `Then send the payment *screenshot* 📸 or type *PAID*.` +
    (payOptions().includes('cash') ? `\n(Type *CASH* to pay by cash instead.)` : '') +
    `\n❌ Reply *0* to cancel.`
  );
}

// ------------------------- sending -------------------------
async function send(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
    return true;
  } catch (e) {
    console.log('[SEND ERROR]', jid, e && e.message ? e.message : e);
    return false;
  }
}
async function notifyOwner(sock, text) {
  const d = toIntl(S.OWNER_NUMBER);
  if (!validIntl(d)) return;
  await send(sock, `${d}@s.whatsapp.net`, text);
}

// ------------------------- parsing -------------------------
function parseOrder(raw) {
  const txt = raw
    .toLowerCase()
    .replace(/(\d+)\s*[x×*]\s*(\d+)/g, '$1x$2')
    .replace(/\band\b/g, ' ');
  const tokens = txt.split(/[\s,;+&\n]+/).filter(Boolean);
  const added = [];
  const bad = [];
  for (const tk of tokens) {
    let idx, qty;
    let m = tk.match(/^(\d{1,3})x(\d{1,2})$/);
    if (m) { idx = +m[1]; qty = +m[2]; }
    else if (/^\d{1,3}$/.test(tk)) { idx = +tk; qty = 1; }
    else { bad.push(tk); continue; }
    if (idx < 1 || idx > S.ITEMS.length || qty < 1 || qty > 50) { bad.push(tk); continue; }
    added.push({ idx, qty });
  }
  return { added, bad };
}

// ------------------------- flow helpers -------------------------
async function askAddressOrName(sock, chat, s) {
  if (S.DELIVERY.enabled) {
    s.step = 'ADDRESS';
    return send(sock, chat, `📍 Please send your *full delivery address* (house no, street, area, landmark).\n❌ Reply *0* to cancel.`);
  }
  s.step = 'NAME';
  return send(sock, chat, `😊 Please send your *name* for the pickup.\n❌ Reply *0* to cancel.`);
}

async function choosePayment(sock, chat, s, kind) {
  if (kind === 'cash') {
    s.payment = cashLabel();
    await send(sock, chat, `💵 ${s.payment} selected.`);
    return askAddressOrName(sock, chat, s);
  }
  s.payment = 'Online';
  s.step = 'PAY_WAIT';
  return send(sock, chat, accountsText(s));
}

async function startPayment(sock, chat, s) {
  const opts = payOptions();
  if (opts.length === 1) return choosePayment(sock, chat, s, opts[0]);
  s.step = 'PAYMENT';
  const lines = opts.map((o, i) => `*${i + 1}* ${o === 'cash' ? '💵 ' + cashLabel() : '💳 Online (JazzCash / EasyPaisa etc.)'}`);
  return send(sock, chat, `💰 How would you like to pay?\n\n${lines.join('\n')}\n\n❌ Reply *0* to cancel.`);
}

async function finalizeOrder(sock, chat, s) {
  const id = genId('ORD');
  const t = totals(s);
  const where = S.DELIVERY.enabled ? `📍 Address: ${s.address}` : `🙋 Name: ${s.name}`;
  const eta = S.DELIVERY.enabled
    ? `⏱️ Your order will reach you in *${S.DELIVERY.time}*.`
    : `⏱️ Your order will be ready for pickup in *${S.DELIVERY.time}*.`;
  const msg =
    `🎉 *Order confirmed!*\n🧾 Order ID: *${id}*\n\n${cartLines(s).join('\n')}\n` +
    `Total: *${money(t.total)}*\n💳 Payment: ${s.payment}${s.payNote ? ' (' + s.payNote + ')' : ''}\n${where}\n\n` +
    `${eta}\nThank you for choosing *${S.BUSINESS_NAME}*! 🙏\n📞 ${S.CALL_PHONE}`;
  await send(sock, chat, msg);
  await notifyOwner(
    sock,
    `🔔 *NEW ORDER ${id}*\n📱 Customer: ${s.phone || chat}\n${cartLines(s).join('\n')}\n` +
      `Delivery fee: ${money(t.fee)}\n*Total: ${money(t.total)}*\n💳 ${s.payment}${s.payNote ? ' — ' + s.payNote : ''}\n${where}`
  );
  console.log(`[ORDER] ${id} from ${s.phone || chat} total ${t.total}`);
  resetS(chat);
}

async function finalizeBooking(sock, chat, s) {
  const id = genId('BKG');
  const it = S.ITEMS[s.service - 1];
  await send(
    sock,
    chat,
    `🎉 *Booking received!*\n🧾 Booking ID: *${id}*\n\n💇 Service: ${it.name} (${money(it.price)})\n📅 When: ${s.when}\n👤 Name: ${s.name}\n\n` +
      `We will see you soon at *${S.BUSINESS_NAME}*, ${S.CITY}. 🙏\n🕐 ${S.OPENING_HOURS}\n📞 ${S.CALL_PHONE}`
  );
  await notifyOwner(
    sock,
    `🔔 *NEW BOOKING ${id}*\n📱 Customer: ${s.phone || chat}\n👤 ${s.name}\n💇 ${it.name} (${money(it.price)})\n📅 ${s.when}`
  );
  console.log(`[BOOKING] ${id} from ${s.phone || chat}`);
  resetS(chat);
}

// ------------------------- main conversation logic -------------------------
async function converse(sock, chat, phone, text, isMedia) {
  const s = getS(chat);
  if (phone) s.phone = phone;
  const raw = (text || '').trim();
  const l = raw.toLowerCase();
  const reply = (t) => send(sock, chat, t);

  // Cancel at any step
  if (s.step !== 'IDLE' && (l === '0' || l === 'cancel' || l === 'cancel order' || l === 'cancel booking')) {
    resetS(chat);
    return reply(`❌ Cancelled. No problem! 😊\nReply *MENU* anytime to start again.`);
  }

  switch (s.step) {
    case 'IDLE': {
      if (l === '1' || l === 'menu' || l === 'services') {
        if (FLOW === 'ORDER') s.step = 'ORDERING';
        else if (FLOW === 'BOOKING') s.step = 'B_SERVICE';
        return reply(menuText());
      }
      return reply(welcomeText());
    }

    case 'ORDERING': {
      if (l === 'menu') return reply(menuText());
      const { added, bad } = parseOrder(raw);
      if (!added.length) {
        return reply(`🤔 I didn't get that.\nSend item numbers like *1x2, 5, 9* (item x quantity).\nSend *MENU* to see the list or *0* to cancel.`);
      }
      for (const a of added) s.cart[a.idx] = Math.min(50, (s.cart[a.idx] || 0) + a.qty);
      s.step = 'CONFIRM';
      const note = bad.length ? `⚠️ Skipped: ${bad.join(', ')}\n\n` : '';
      return reply(note + summaryText(s));
    }

    case 'CONFIRM': {
      if (['1', 'confirm', 'yes', 'y', 'ok', 'okay'].includes(l)) return startPayment(sock, chat, s);
      if (l === 'menu') { s.step = 'ORDERING'; return reply(menuText()); }
      if (['2', 'add', 'add more', 'more'].includes(l)) {
        s.step = 'ORDERING';
        return reply(`➕ Send more items like *3x1, 4*.\nSend *MENU* to see the list again.\n\nCurrent cart:\n${cartLines(s).join('\n')}`);
      }
      return reply(`Please reply:\n*1* ✅ Confirm\n*2* ➕ Add more\n*0* ❌ Cancel`);
    }

    case 'PAYMENT': {
      const opts = payOptions();
      let kind = null;
      const n = parseInt(l, 10);
      if (n >= 1 && n <= opts.length && String(n) === l) kind = opts[n - 1];
      else if (['cash', 'cod'].includes(l) && opts.includes('cash')) kind = 'cash';
      else if (['online', 'jazzcash', 'easypaisa'].includes(l) && opts.includes('online')) kind = 'online';
      if (!kind) return reply(`Please reply with *1`+ (opts.length > 1 ? ` or 2*` : `*`) + ` to choose payment, or *0* to cancel.`);
      return choosePayment(sock, chat, s, kind);
    }

    case 'PAY_WAIT': {
      if (l === 'cash' && payOptions().includes('cash')) return choosePayment(sock, chat, s, 'cash');
      if (isMedia) {
        s.payNote = 'screenshot received';
      } else if (/\b(paid|done)\b/.test(l)) {
        s.payNote = 'customer says PAID, please verify';
      } else {
        return reply(`📸 Please send the payment *screenshot* or type *PAID*.` + (payOptions().includes('cash') ? `\nType *CASH* for cash instead.` : '') + `\nReply *0* to cancel.`);
      }
      await reply(`✅ Thank you! Payment noted.`);
      return askAddressOrName(sock, chat, s);
    }

    case 'ADDRESS': {
      if (raw.length < 8) return reply(`📍 Please send your *complete address* (house no, street, area).\nReply *0* to cancel.`);
      s.address = raw;
      return finalizeOrder(sock, chat, s);
    }

    case 'NAME': {
      if (raw.length < 2) return reply(`😊 Please send your *name*.\nReply *0* to cancel.`);
      s.name = raw;
      return finalizeOrder(sock, chat, s);
    }

    // ---------------- BOOKING ----------------
    case 'B_SERVICE': {
      if (l === 'menu') return reply(menuText());
      const n = parseInt(l, 10);
      if (String(n) === l && n >= 1 && n <= S.ITEMS.length) {
        s.service = n;
        s.step = 'B_DATETIME';
        return reply(`✅ *${S.ITEMS[n - 1].name}* selected.\n\n📅 Send your preferred *date and time*, e.g. *Friday 5 PM*\n🕐 Hours: ${S.OPENING_HOURS}\n❌ Reply *0* to cancel.`);
      }
      return reply(`Please reply with a *service number* (1-${S.ITEMS.length}).\nSend *MENU* to see the list or *0* to cancel.`);
    }

    case 'B_DATETIME': {
      if (raw.length < 3) return reply(`📅 Please send date and time, e.g. *Friday 5 PM*.\nReply *0* to cancel.`);
      s.when = raw;
      s.step = 'B_NAME';
      return reply(`😊 Please send your *name* to complete the booking.\n❌ Reply *0* to cancel.`);
    }

    case 'B_NAME': {
      if (raw.length < 2) return reply(`😊 Please send your *name*.\nReply *0* to cancel.`);
      s.name = raw;
      return finalizeBooking(sock, chat, s);
    }

    default: {
      resetS(chat);
      return reply(welcomeText());
    }
  }
}

// ------------------------- message plumbing -------------------------
function unwrap(msg) {
  let c = msg;
  for (let i = 0; i < 4; i++) {
    if (c && c.ephemeralMessage) c = c.ephemeralMessage.message;
    else if (c && c.viewOnceMessage) c = c.viewOnceMessage.message;
    else if (c && c.viewOnceMessageV2) c = c.viewOnceMessageV2.message;
    else if (c && c.documentWithCaptionMessage) c = c.documentWithCaptionMessage.message;
    else break;
  }
  return c || {};
}

const locks = new Map();
function runLocked(chat, fn) {
  const prev = locks.get(chat) || Promise.resolve();
  const next = prev.then(() => fn()).catch((e) => console.log('[HANDLER ERROR]', e && e.message ? e.message : e));
  locks.set(chat, next);
  next.then(() => { if (locks.get(chat) === next) locks.delete(chat); });
  return next;
}

async function onMessage(sock, m) {
  const key = m.key || {};
  if (!m.message || key.fromMe) return;
  const rjid = key.remoteJid || '';
  if (!rjid || rjid === 'status@broadcast' || rjid.endsWith('@g.us') || rjid.endsWith('@newsletter') || rjid.endsWith('@broadcast')) return;

  if (key.id) {
    if (seen.has(key.id)) return;
    seen.add(key.id);
    if (seen.size > 3000) seen.delete(seen.values().next().value);
  }

  const alt = key.remoteJidAlt;
  let chat = rjid;
  if (rjid.endsWith('@lid') && alt && alt.endsWith('@s.whatsapp.net')) chat = alt;
  const phoneJid = [alt, rjid].find((j) => j && j.endsWith('@s.whatsapp.net'));
  const phone = phoneJid ? phoneJid.split('@')[0] : '';

  const c = unwrap(m.message);
  if (c.protocolMessage || c.reactionMessage || c.pollUpdateMessage) return;
  const text =
    c.conversation ||
    (c.extendedTextMessage && c.extendedTextMessage.text) ||
    (c.imageMessage && c.imageMessage.caption) ||
    (c.videoMessage && c.videoMessage.caption) ||
    (c.documentMessage && c.documentMessage.caption) ||
    '';
  const isMedia = !!(c.imageMessage || c.documentMessage);

  await runLocked(chat, async () => {
    try {
      await converse(sock, chat, phone, text, isMedia);
    } catch (e) {
      console.log('[FLOW ERROR]', e && e.message ? e.message : e);
      await send(sock, chat, `Sorry, something went wrong 🙏 Reply *MENU* to start again or call ${S.CALL_PHONE}.`);
      resetS(chat);
    }
  });
}

// ------------------------- connection -------------------------
let currentSock = null;
let startTimer = null;
function scheduleStart(ms) {
  if (startTimer) return;
  startTimer = setTimeout(() => {
    startTimer = null;
    start().catch((e) => {
      console.log('[START ERROR]', e && e.message ? e.message : e);
      scheduleStart(4000);
    });
  }, ms);
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
  });
  currentSock = sock;
  let pairingRequested = false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    if (sock !== currentSock) return;
    const { connection, lastDisconnect, qr } = u;

    if (qr && !sock.authState.creds.registered) {
      console.log('QR LINK: https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(qr));
      try { qrcode.generate(qr, { small: true }); } catch (e) { /* ignore */ }
      if (!pairingRequested) {
        pairingRequested = true;
        const num = toIntl(process.env.BOT_NUMBER || S.BOT_NUMBER);
        if (!validIntl(num)) {
          console.log('[WARN] BOT_NUMBER is not valid (need 03XXXXXXXXX). Fix it in index.js. Use the QR link above meanwhile.');
        } else {
          setTimeout(async () => {
            try {
              const code = await sock.requestPairingCode(num);
              const pretty = String(code).match(/.{1,4}/g).join('-');
              console.log('PAIRING CODE: ' + pretty);
            } catch (e) {
              console.log('[PAIRING ERROR]', e && e.message ? e.message : e);
            }
          }, 1000);
        }
      }
    }

    if (connection === 'open') {
      console.log(`✅ ${S.BUSINESS_NAME} bot is LIVE (flow: ${FLOW})`);
    }

    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output ? lastDisconnect.error.output.statusCode : undefined;
      console.log('[CONN] closed, code:', code);
      if (code === DisconnectReason.loggedOut) {
        console.log('[CONN] Logged out. Clearing session and starting fresh pairing...');
        try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      }
      scheduleStart(4000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (sock !== currentSock || type !== 'notify') return;
    for (const m of messages) {
      try { await onMessage(sock, m); } catch (e) { console.log('[UPSERT ERROR]', e && e.message ? e.message : e); }
    }
  });
}

process.on('unhandledRejection', (e) => console.log('[UNHANDLED]', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.log('[UNCAUGHT]', e && e.message ? e.message : e));

console.log(`Starting ${S.BUSINESS_NAME} WhatsApp bot...`);
start().catch((e) => {
  console.log('[START ERROR]', e && e.message ? e.message : e);
  scheduleStart(4000);
});
