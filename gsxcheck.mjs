import { getStore } from "@netlify/blobs";

const store = getStore("gsx-check-data");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_USER_ID || "");
const MOMO_NAME = process.env.MOMO_NAME || "SET_MOMO_NAME";
const MOMO_NUMBER = process.env.MOMO_NUMBER || "SET_MOMO_NUMBER";

const CHECK_PACKAGES = [
  { id: "check1", title: "1 Device Check", credits: 1, price: 5 },
  { id: "check3", title: "3 Device Checks", credits: 3, price: 10 }
];

const GIFT_CARD_FEE_PERCENT = Number(process.env.GIFT_CARD_FEE_PERCENT || 17);
const GIFT_CARD_PROFIT_PERCENT = Number(process.env.GIFT_CARD_PROFIT_PERCENT || 0);

const GIFT_CARDS = readJsonEnv("GIFT_CARD_PRODUCTS_JSON", [
  { id: "us25", title: "iTunes Gift Card — US $25", usd: 25, mtcGhs: 422.47, region: "US" },
  { id: "us30", title: "iTunes Gift Card — US $30", usd: 30, mtcGhs: 470.77, region: "US" }
]);

const VIRTUAL_NUMBERS = readJsonEnv("VIRTUAL_NUMBER_PRODUCTS_JSON", [
  { id: "vn-basic", title: "Virtual Number — Basic", price: 30, currency: "GHS", description: "Manual fulfillment" },
  { id: "vn-plus", title: "Virtual Number — Plus", price: 50, currency: "GHS", description: "Manual fulfillment" }
]);

function readJsonEnv(name, fallback) {
  try { return process.env[name] ? JSON.parse(process.env[name]) : fallback; }
  catch { return fallback; }
}

function giftPricing(p) {
  // New catalog format: USD denomination + MTC's current basket price in GHS.
  // Legacy catalogs with price/currency continue to work.
  const base = Number(p.mtcGhs ?? p.price ?? 0);
  const fee = base * (GIFT_CARD_FEE_PERCENT / 100);
  const profit = (base + fee) * (GIFT_CARD_PROFIT_PERCENT / 100);
  const total = base + fee + profit;
  return {
    baseGhs: round2(base),
    feeGhs: round2(fee),
    profitGhs: round2(profit),
    totalGhs: round2(total),
    usd: Number(p.usd ?? 0)
  };
}
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function giftLabel(p) {
  const price = giftPricing(p);
  return p.usd ? `${p.title} — GH₵${price.totalGhs.toFixed(2)}` : `${p.title} — GH₵${price.totalGhs.toFixed(2)}`;
}

function keyUser(id) { return `user:${id}`; }
function keyOrder(id) { return `order:${id}`; }
function keyReport(id) { return `report:${id}`; }

async function getJSON(key, fallback = null) {
  const v = await store.get(key, { type: "json" });
  return v ?? fallback;
}
async function putJSON(key, value) {
  await store.setJSON(key, value);
}

async function tg(method, body = {}) {
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.description || "Telegram API error");
  return data.result;
}

async function send(chatId, text, extra = {}) {
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

async function edit(chatId, messageId, text, extra = {}) {
  return tg("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...extra });
}

function kb(rows) { return { inline_keyboard: rows }; }
function btn(text, data) { return { text, callback_data: data }; }

function esc(s = "") {
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

function nowISO() { return new Date().toISOString(); }
function id(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
}

async function ensureUser(from) {
  const k = keyUser(from.id);
  let u = await getJSON(k);
  if (!u) {
    u = {
      id: String(from.id),
      firstName: from.first_name || "",
      lastName: from.last_name || "",
      username: from.username || "",
      credits: 0,
      totalChecks: 0,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      state: null
    };
  } else {
    u.firstName = from.first_name || u.firstName;
    u.lastName = from.last_name || u.lastName;
    u.username = from.username || u.username;
    u.updatedAt = nowISO();
  }
  await putJSON(k, u);
  return u;
}

function displayName(u) {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return name || u.username || u.id;
}

function mainMenu() {
  return kb([
    [btn("🔍 DEVICE CHECK", "menu:device"), btn("🛒 DIGITAL STORE", "menu:store")],
    [btn("💳 BUY CHECKS", "menu:buy"), btn("👤 MY ACCOUNT", "menu:account")],
    [btn("ℹ️ HELP", "menu:help")]
  ]);
}

function adminMenu() {
  return kb([
    [btn("🔔 PENDING ORDERS", "admin:pending"), btn("📊 STATS", "admin:stats")],
    [btn("👥 CUSTOMERS", "admin:users"), btn("💰 PAYMENTS", "admin:payments")],
    [btn("🔍 GSX ORDERS", "admin:checks"), btn("🎁 DIGITAL ORDERS", "admin:digital")],
    [btn("⚙️ PAYMENT SETTINGS", "admin:settings")]
  ]);
}

async function home(chatId) {
  await send(chatId,
`<b>📱 GSX CHECK</b>

<b>Verify Before You Buy.</b>

🔍 IMEI & Serial checks
🛡️ Device-risk reporting
🛒 Gift cards & virtual numbers
💳 MoMo & crypto payments
⚡ Fast • Secure • Verified

Choose an option below:`, { reply_markup: mainMenu() });
}

function normalizeIMEI(raw) {
  return String(raw || "").replace(/[\\s-]/g, "");
}

function validIMEI(raw) {
  const x = normalizeIMEI(raw);
  if (!/^\\d{15}$/.test(x)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let n = Number(x[i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

function tacLookup(imei) {
  const tac = imei.slice(0, 8);
  // Add authorized TAC data here later. This local fallback intentionally
  // returns UNKNOWN instead of guessing a model from an incomplete database.
  const known = {
    // "35285111": { brand:"Apple", model:"iPhone 11 Pro Max", storage:"64GB" }
  };
  return known[tac] || null;
}

function maskId(s) {
  const x = String(s || "");
  if (x.length <= 6) return x;
  return "•".repeat(Math.max(0, x.length - 6)) + x.slice(-6);
}

function reportText(r) {
  const d = r.device || {};
  const v = r.verification || {};
  return `<b>━━━━━━━━━━━━━━━━━━
📱 GSX CHECK REPORT
━━━━━━━━━━━━━━━━━━</b>

<b>STATUS:</b> ${esc(v.overall || "NOT VERIFIED")}

<b>DEVICE</b>
Brand: ${esc(d.brand || "UNKNOWN")}
Model: ${esc(d.model || "UNKNOWN")}
Color: ${esc(d.color || "UNKNOWN")}
Storage: ${esc(d.storage || "UNKNOWN")}

<b>IDENTIFIERS</b>
IMEI: <code>${esc(maskId(r.imei))}</code>
${r.serial ? `Serial: <code>${esc(maskId(r.serial))}</code>` : ""}

<b>VERIFICATION</b>
Blacklist: ${esc(v.blacklist || "UNKNOWN")}
Lost/Stolen: ${esc(v.lostStolen || "UNKNOWN")}
Carrier Lock: ${esc(v.carrierLock || "UNKNOWN")}
Activation Lock: ${esc(v.activationLock || "UNKNOWN")}
Warranty: ${esc(v.warranty || "UNKNOWN")}
Finance/Contract: ${esc(v.finance || "UNKNOWN")}

<b>DATA SOURCE</b>
${esc(r.source || "Local validation only — live provider not connected")}

<b>Report ID:</b> <code>${esc(r.reportId)}</code>
<b>Checked:</b> ${esc(new Date(r.checkedAt).toLocaleString("en-GB", { timeZone: "Africa/Accra" }))}

<i>UNKNOWN means this field was not independently verified.</i>`;
}

// Provider hook for later.
// Return a normalized result object when you have an authorized API.
// Do not scrape or bypass private systems, CAPTCHA or access controls.
async function providerCheck({ imei, serial, brand }) {
  if (!process.env.GSX_PROVIDER_URL || !process.env.GSX_PROVIDER_API_KEY) return null;

  // TODO: Replace this adapter with the exact API contract of your licensed provider.
  // Example expected normalized return:
  // {
  //   device: { brand, model, color, storage },
  //   verification: { overall:"CLEAN", blacklist:"CLEAN", lostStolen:"NOT REPORTED", ... },
  //   source:"Authorized provider"
  // }
  return null;
}

async function runDeviceCheck({ imei, serial = "", brand = "Universal" }) {
  const normalized = normalizeIMEI(imei);
  if (!validIMEI(normalized)) {
    return { error: "That IMEI is not valid. Please enter the 15-digit IMEI exactly as shown on the device." };
  }

  const local = tacLookup(normalized);
  const provider = await providerCheck({ imei: normalized, serial, brand });

  const result = provider || {
    reportId: id("GSX"),
    imei: normalized,
    serial,
    checkedAt: nowISO(),
    source: local ? "Local TAC database + validation" : "Local validation only — live provider not connected",
    device: {
      brand: local?.brand || brand || "UNKNOWN",
      model: local?.model || "UNKNOWN",
      color: local?.color || "UNKNOWN",
      storage: local?.storage || "UNKNOWN"
    },
    verification: {
      overall: "NOT VERIFIED",
      blacklist: "UNKNOWN",
      lostStolen: "UNKNOWN",
      carrierLock: "UNKNOWN",
      activationLock: "UNKNOWN",
      warranty: "UNKNOWN",
      finance: "UNKNOWN"
    }
  };

  result.reportId ||= id("GSX");
  result.imei = normalized;
  result.checkedAt ||= nowISO();
  return result;
}

function deviceMenu() {
  return kb([
    [btn("🍎 Apple IMEI", "device:appleimei"), btn("🍎 Apple Serial", "device:appleserial")],
    [btn("📱 Samsung IMEI", "device:samsungimei"), btn("🌐 Universal IMEI", "device:universalimei")],
    [btn("⬅️ Back", "menu:home")]
  ]);
}

function storeMenu() {
  return kb([
    [btn("🎁 Apple/iTunes Gift Cards", "store:gift")],
    [btn("📲 Virtual Numbers", "store:virtual")],
    [btn("⬅️ Back", "menu:home")]
  ]);
}

async function showBuy(chatId) {
  const rows = CHECK_PACKAGES.map(p => [btn(`💳 ${p.title} — GH₵${p.price}`, `buy:${p.id}`)]);
  rows.push([btn("⬅️ Back", "menu:home")]);
  await send(chatId, "<b>💳 BUY DEVICE CHECKS</b>\n\nChoose a package:", { reply_markup: kb(rows) });
}

async function showAccount(chatId, u) {
  await send(chatId,
`<b>👤 MY ACCOUNT</b>

Name: ${esc(displayName(u))}
Telegram ID: <code>${u.id}</code>
Available checks: <b>${u.credits}</b>
Completed checks: <b>${u.totalChecks}</b>`, { reply_markup: kb([[btn("⬅️ Back", "menu:home")]]) });
}

async function createOrder(u, type, item) {
  const order = {
    id: id("ORD"),
    userId: u.id,
    type,
    itemId: item.id,
    itemTitle: item.title,
    credits: type === "CHECK_PACKAGE" ? Number(item.credits || 0) : 0,
    region: item.region || null,
    usdAmount: type === "GIFT_CARD" ? Number(item.usd || 0) : null,
    baseGhs: type === "GIFT_CARD" ? giftPricing(item).baseGhs : Number(item.price || 0),
    feeGhs: type === "GIFT_CARD" ? giftPricing(item).feeGhs : 0,
    profitGhs: type === "GIFT_CARD" ? giftPricing(item).profitGhs : 0,
    amount: type === "GIFT_CARD" ? giftPricing(item).totalGhs : Number(item.price),
    currency: "GHS",
    status: "AWAITING_PAYMENT",
    paymentMethod: null,
    paymentReference: null,
    senderName: null,
    cryptoAddress: null,
    cryptoNetwork: null,
    delivery: null,
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
  await putJSON(keyOrder(order.id), order);
  return order;
}

async function sendAdminOrder(order, u) {
  if (!ADMIN_ID) return;
  await send(ADMIN_ID,
`<b>🔔 NEW GSX CHECK ORDER</b>

Order: <code>${order.id}</code>
Customer: ${esc(displayName(u))}
Username: @${esc(u.username || "none")}
Telegram ID: <code>${u.id}</code>

Item: ${esc(order.itemTitle)}
Amount: <b>${esc(order.currency)} ${order.amount}</b>
Type: ${esc(order.type)}

Payment: ${esc(order.paymentMethod || "Pending")}
Sender name: ${esc(order.senderName || "—")}
Network: ${esc(order.cryptoNetwork || "—")}
Status: <b>${esc(order.status)}</b>`, {
    reply_markup: kb([
      [btn("💰 Confirm Payment", `admin:confirm:${order.id}`), btn("❌ Reject", `admin:reject:${order.id}`)],
      [btn("📦 Open Order", `admin:order:${order.id}`)]
    ])
  });
}

async function paymentInstructions(chatId, order) {
  await send(chatId,
`<b>💳 PAYMENT</b>

Order: <code>${order.id}</code>
Item: ${esc(order.itemTitle)}
Amount: <b>GH₵${order.amount}</b>

<b>MoMo</b>
Name: <b>${esc(MOMO_NAME)}</b>
Number: <code>${esc(MOMO_NUMBER)}</code>

After sending the exact amount, tap <b>I've Paid</b>.

<i>Your order is fulfilled only after admin manually verifies the payment.</i>`, {
    reply_markup: kb([
      [btn("✅ I've Paid", `paid:${order.id}`)],
      [btn("❌ Cancel", `cancel:${order.id}`)]
    ])
  });
}

async function cryptoMenu(chatId, order) {
  const options = [
    ["₿ Bitcoin", "BTC"],
    ["💵 USDT — TRC20", "USDT-TRC20"],
    ["💵 USDT — ERC20", "USDT-ERC20"],
    ["🔷 Ethereum", "ETH"],
    ["🔺 TRON", "TRX"]
  ];

  await send(chatId, `<b>₿ CHOOSE CRYPTO</b>

Order: <code>${order.id}</code>
Amount to pay: <b>GH₵${Number(order.amount).toFixed(2)}</b>

Choose your crypto/network. The admin will send the payment address manually for this order.`, {
    reply_markup: kb(options.map(x => [btn(x[0], `crypto:${order.id}:${x[1]}`)])
      .concat([[btn("⬅️ Cancel", `cancel:${order.id}`)]]))
  });
}

async function sendManualCryptoAddress(order, network, address) {
  const u = await getJSON(keyUser(order.userId));
  if (!u) return;
  order.cryptoNetwork = network;
  order.cryptoAddress = address;
  order.status = "AWAITING_CRYPTO_PAYMENT";
  order.updatedAt = nowISO();
  await putJSON(keyOrder(order.id), order);
  await send(order.userId, `<b>₿ CRYPTO PAYMENT DETAILS</b>

Order: <code>${order.id}</code>
Network: <b>${esc(network)}</b>
Amount: <b>GH₵${Number(order.amount).toFixed(2)}</b>

<b>Payment address</b>
<code>${esc(address)}</code>

Send the exact amount, then tap <b>I've Paid</b>.`, {
    reply_markup: kb([
      [btn("✅ I've Paid", `paid:${order.id}`)],
      [btn("❌ Cancel", `cancel:${order.id}`)]
    ])
  });
}

async function handleText(chatId, from, text) {
  const u = await ensureUser(from);
  if (text === "/start") return home(chatId);
  if (text === "/help") {
    return send(chatId, `<b>ℹ️ GSX CHECK HELP</b>

Use the menu to check a device, buy checks or order digital products.

Device verification is honest: fields that require an external data source show UNKNOWN until an authorized provider is connected.

For payment problems, contact the admin.`);
  }
  if (text === "/account") return showAccount(chatId, u);
  if (text === "/admin" && String(from.id) === ADMIN_ID) return send(chatId, "<b>⚙️ ADMIN PANEL</b>", { reply_markup: adminMenu() });
  if (text === "/pending" && String(from.id) === ADMIN_ID) return adminPending(chatId);
  if (text === "/stats" && String(from.id) === ADMIN_ID) return adminStats(chatId);
  if (text === "/users" && String(from.id) === ADMIN_ID) return adminUsers(chatId);

  if (String(from.id) === ADMIN_ID && text.startsWith("/crypto ")) {
    const parts = text.trim().split(/\\s+/);
    if (parts.length < 3) return send(chatId, "Usage: <code>/crypto ORDER_ID NETWORK ADDRESS</code>");
    const orderId = parts[1];
    const network = parts[2];
    const address = parts.slice(3).join(" ");
    if (!address) return send(chatId, "Usage: <code>/crypto ORDER_ID NETWORK ADDRESS</code>");
    const order = await getJSON(keyOrder(orderId));
    if (!order) return send(chatId, "Order not found.");
    return sendManualCryptoAddress(order, network, address);
  }

  if (u.state?.type === "device_imei") {
    const requestedBrand = u.state.brand || "Universal";
    u.state = null; await putJSON(keyUser(u.id), u);
    if (u.credits < 1) return send(chatId, "❌ You have no checks available. Tap <b>BUY CHECKS</b> to purchase one.");
    const result = await runDeviceCheck({ imei: text, brand: requestedBrand });
    if (result.error) return send(chatId, `❌ ${esc(result.error)}`);
    u.credits -= 1; u.totalChecks += 1; await putJSON(keyUser(u.id), u);
    await putJSON(keyReport(result.reportId), { ...result, userId: u.id });
    return send(chatId, reportText(result), { reply_markup: kb([[btn("🔍 Another Check", "menu:device"), btn("🏠 Home", "menu:home")]]) });
  }

  if (u.state?.type === "device_serial") {
    const serial = text.trim();
    u.state = null; await putJSON(keyUser(u.id), u);
    return send(chatId, `<b>🍎 SERIAL CHECK</b>

Serial received: <code>${esc(maskId(serial))}</code>

Current offline mode can validate the workflow, but it cannot truthfully return Apple's private blacklist, activation-lock, warranty or carrier data without an authorized provider API.

Status: <b>NOT VERIFIED</b>`, { reply_markup: kb([[btn("⬅️ Device Menu", "menu:device")]]) });
  }

  if (u.state?.type === "payment_sender") {
    const order = await getJSON(keyOrder(u.state.orderId));
    u.state = null; await putJSON(keyUser(u.id), u);
    if (!order || order.userId !== u.id || order.status !== "AWAITING_SENDER_NAME") {
      return send(chatId, "❌ That payment request is no longer active.");
    }
    order.senderName = text.trim();
    order.status = "PAYMENT_REVIEW";
    order.updatedAt = nowISO();
    await putJSON(keyOrder(order.id), order);
    await send(chatId, "✅ Payment details submitted. The admin will verify your payment manually and notify you.");
    await sendAdminOrder(order, u);
    return;
  }

  if (u.state?.type === "digital_details") {
    const order = await getJSON(keyOrder(u.state.orderId));
    u.state = null; await putJSON(keyUser(u.id), u);
    if (!order || order.userId !== u.id) return send(chatId, "❌ Order not found.");
    order.customerDetails = text.trim();
    order.status = "AWAITING_PAYMENT";
    order.updatedAt = nowISO();
    await putJSON(keyOrder(order.id), order);
    await paymentInstructions(chatId, order);
    return;
  }

  if (text.startsWith("/")) return send(chatId, "Unknown command. Use /start.");
}

async function handleCallback(q) {
  const chatId = q.message.chat.id;
  const from = q.from;
  const data = q.data || "";
  const u = await ensureUser(from);

  await tg("answerCallbackQuery", { callback_query_id: q.id });

  if (data === "menu:home") return home(chatId);
  if (data === "menu:device") return send(chatId, "<b>🔍 DEVICE CHECK</b>\n\nChoose a check:", { reply_markup: deviceMenu() });
  if (data === "menu:store") return send(chatId, "<b>🛒 DIGITAL STORE</b>\n\nChoose a product:", { reply_markup: storeMenu() });
  if (data === "menu:buy") return showBuy(chatId);
  if (data === "menu:account") return showAccount(chatId, u);
  if (data === "menu:help") return send(chatId, "<b>ℹ️ HELP</b>\n\nChoose Device Check to verify an IMEI, or Digital Store to order a product.", { reply_markup: mainMenu() });

  if (data === "device:appleimei" || data === "device:samsungimei" || data === "device:universalimei") {
    if (u.credits < 1) return send(chatId, "❌ You need at least 1 check credit.", { reply_markup: kb([[btn("💳 Buy Checks", "menu:buy")]]) });
    const brand = data.includes("apple") ? "Apple" : data.includes("samsung") ? "Samsung" : "Universal";
    u.state = { type: "device_imei", brand };
    await putJSON(keyUser(u.id), u);
    return send(chatId, `🔎 Send the <b>${esc(brand)}</b> 15-digit IMEI now.\n\nExample: <code>352851114023666</code>\n\n<i>Your check will be charged only after a valid IMEI is processed.</i>`);
  }

  if (data === "device:appleserial") {
    u.state = { type: "device_serial" };
    await putJSON(keyUser(u.id), u);
    return send(chatId, "🍎 Send the Apple serial number.\n\n<i>Offline mode can validate the workflow, but live Apple/GSX status requires an authorized provider.</i>");
  }

  if (data.startsWith("buy:")) {
    const p = CHECK_PACKAGES.find(x => x.id === data.split(":")[1]);
    if (!p) return send(chatId, "Package not found.");
    const order = await createOrder(u, "CHECK_PACKAGE", p);
    return send(chatId, `<b>💳 ${esc(p.title)}</b>\n\nPrice: <b>GH₵${p.price}</b>\nCredits: <b>${p.credits}</b>\nOrder: <code>${order.id}</code>\n\nChoose payment method:`, {
      reply_markup: kb([
        [btn("📲 MoMo", `paymomo:${order.id}`), btn("₿ Crypto", `paycrypto:${order.id}`)],
        [btn("❌ Cancel", `cancel:${order.id}`)]
      ])
    });
  }

  if (data.startsWith("paymomo:")) {
    const order = await getJSON(keyOrder(data.split(":")[1]));
    if (!order || order.userId !== u.id) return send(chatId, "Order not found.");
    order.paymentMethod = "MoMo"; order.status = "AWAITING_PAYMENT"; order.updatedAt = nowISO();
    await putJSON(keyOrder(order.id), order);
    return paymentInstructions(chatId, order);
  }

  if (data.startsWith("paycrypto:")) {
    const order = await getJSON(keyOrder(data.split(":")[1]));
    if (!order || order.userId !== u.id) return send(chatId, "Order not found.");
    order.paymentMethod = "Crypto"; order.status = "AWAITING_CRYPTO";
    order.updatedAt = nowISO(); await putJSON(keyOrder(order.id), order);
    return cryptoMenu(chatId, order);
  }

  if (data.startsWith("paid:")) {
    const order = await getJSON(keyOrder(data.split(":")[1]));
    if (!order || order.userId !== u.id) return send(chatId, "Order not found.");
    if (order.status !== "AWAITING_PAYMENT") return send(chatId, "This order is not waiting for a MoMo payment.");
    order.status = "AWAITING_SENDER_NAME"; order.updatedAt = nowISO(); await putJSON(keyOrder(order.id), order);
    u.state = { type: "payment_sender", orderId: order.id }; await putJSON(keyUser(u.id), u);
    return send(chatId, "Please enter the <b>name shown on the MoMo account you used to make the payment</b>.\n\nType the name exactly as it appears.");
  }

  if (data.startsWith("crypto:")) {
    const [, orderId, network] = data.split(":");
    const order = await getJSON(keyOrder(orderId));
    if (!order || order.userId !== u.id) return send(chatId, "Order not found.");

    order.paymentMethod = "CRYPTO";
    order.cryptoNetwork = network;
    order.status = "CRYPTO_ADDRESS_PENDING";
    order.updatedAt = nowISO();
    await putJSON(keyOrder(order.id), order);

    if (ADMIN_ID) {
      await send(ADMIN_ID, `<b>₿ CRYPTO ADDRESS REQUEST</b>

Order: <code>${order.id}</code>
Customer: ${esc(displayName(u))}
Username: @${esc(u.username || "none")}
Network: <b>${esc(network)}</b>
Amount: <b>GH₵${Number(order.amount).toFixed(2)}</b>

Send the address manually with:
<code>/crypto ${order.id} ${network} YOUR_WALLET_ADDRESS</code>`, {
        reply_markup: kb([[btn("📦 Open Order", `admin:order:${order.id}`)]])
      });
    }

    return send(chatId, `<b>₿ ${esc(network)} SELECTED</b>

Order: <code>${order.id}</code>

The admin is preparing the payment address for this order. You will receive the address here before you pay.`);
  }

  if (data.startsWith("cryptopaid:")) {
    const order = await getJSON(keyOrder(data.split(":")[1]));
    if (!order || order.userId !== u.id) return send(chatId, "Order not found.");
    order.status = "CRYPTO_REVIEW"; order.updatedAt = nowISO(); await putJSON(keyOrder(order.id), order);
    await send(chatId, "✅ Crypto payment submitted for manual verification. The admin will notify you after confirmation.");
    return sendAdminOrder(order, u);
  }

  if (data.startsWith("cancel:")) {
    const order = await getJSON(keyOrder(data.split(":")[1]));
    if (order && order.userId === u.id) {
      order.status = "CANCELLED"; order.updatedAt = nowISO(); await putJSON(keyOrder(order.id), order);
    }
    return send(chatId, "Order cancelled.", { reply_markup: mainMenu() });
  }

  if (data === "store:gift") {
    const rows = GIFT_CARDS.map(p => [btn(`🎁 ${p.usd ? `US $${p.usd}` : p.title} — GH₵${giftPricing(p).totalGhs.toFixed(2)}`, `gift:${p.id}`)]);
    rows.push([btn("⬅️ Back", "menu:store")]);
    return send(chatId, `<b>🎁 APPLE / iTUNES GIFT CARDS</b>

<b>USD denomination</b> • payment automatically shown in Ghana cedis.

Fee included: <b>${GIFT_CARD_FEE_PERCENT}%</b>
Profit markup: <b>${GIFT_CARD_PROFIT_PERCENT}%</b>

Choose a denomination:`, { reply_markup: kb(rows) });
  }

  if (data.startsWith("gift:")) {
    const p = GIFT_CARDS.find(x => x.id === data.split(":")[1]);
    if (!p) return send(chatId, "Product not found.");
    const price = giftPricing(p);
    const order = await createOrder(u, "GIFT_CARD", p);
    u.state = { type: "digital_details", orderId: order.id }; await putJSON(keyUser(u.id), u);
    return send(chatId, `<b>🎁 ${esc(p.title)}</b>

Gift value: <b>US $${Number(p.usd || 0).toFixed(2)}</b>
MTC basket price: <b>GH₵${price.baseGhs.toFixed(2)}</b>
17% MTC fee: <b>GH₵${price.feeGhs.toFixed(2)}</b>
Profit markup: <b>GH₵${price.profitGhs.toFixed(2)}</b>

<b>Total to pay: GH₵${price.totalGhs.toFixed(2)}</b>
Order: <code>${order.id}</code>

Send the account/region details needed for fulfillment. Do not send passwords or private account credentials.`);
  }

  if (data === "store:virtual") {
    const rows = VIRTUAL_NUMBERS.map(p => [btn(`📲 ${p.title} — GH₵${p.price}`, `virtual:${p.id}`)]);
    rows.push([btn("⬅️ Back", "menu:store")]);
    return send(chatId, "<b>📲 VIRTUAL NUMBERS</b>\n\nChoose a product:", { reply_markup: kb(rows) });
  }

  if (data.startsWith("virtual:")) {
    const p = VIRTUAL_NUMBERS.find(x => x.id === data.split(":")[1]);
    if (!p) return send(chatId, "Product not found.");
    const order = await createOrder(u, "VIRTUAL_NUMBER", p);
    u.state = { type: "digital_details", orderId: order.id }; await putJSON(keyUser(u.id), u);
    return send(chatId, `<b>📲 ${esc(p.title)}</b>\n\nPrice: <b>GH₵${p.price}</b>\nOrder: <code>${order.id}</code>\n\nSend your requested country/region and intended lawful use. Do not request numbers for bypassing platform verification or anti-abuse controls.`);
  }

  // Admin
  if (String(from.id) === ADMIN_ID && data === "admin:back") return send(chatId, "<b>⚙️ ADMIN PANEL</b>", { reply_markup: adminMenu() });
  if (String(from.id) === ADMIN_ID && data === "admin:pending") return adminPending(chatId);
  if (String(from.id) === ADMIN_ID && data === "admin:stats") return adminStats(chatId);
  if (String(from.id) === ADMIN_ID && data === "admin:users") return adminUsers(chatId);
  if (String(from.id) === ADMIN_ID && data === "admin:payments") return adminPayments(chatId);
  if (String(from.id) === ADMIN_ID && data === "admin:checks") return adminChecks(chatId);
  if (String(from.id) === ADMIN_ID && data === "admin:digital") return adminDigital(chatId);
  if (String(from.id) === ADMIN_ID && data === "admin:settings") return adminSettings(chatId);

  if (String(from.id) === ADMIN_ID && data.startsWith("admin:confirm:")) {
    const orderId = data.split(":")[2];
    return adminConfirm(chatId, orderId);
  }
  if (String(from.id) === ADMIN_ID && data.startsWith("admin:reject:")) {
    const orderId = data.split(":")[2];
    return adminReject(chatId, orderId);
  }
  if (String(from.id) === ADMIN_ID && data.startsWith("admin:order:")) {
    const orderId = data.split(":")[2];
    return adminOrder(chatId, orderId);
  }
  if (String(from.id) === ADMIN_ID && data.startsWith("admin:deliver:")) {
    const orderId = data.split(":")[2];
    return adminDeliverPrompt(chatId, orderId);
  }
}

async function listKeys(prefix) {
  const out = [];
  let cursor;
  do {
    const page = await store.list({ prefix, cursor });
    for (const b of page.blobs || []) out.push(b.key);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

async function adminPending(chatId) {
  const keys = await listKeys("order:");
  const orders = [];
  for (const k of keys) {
    const o = await getJSON(k);
    if (o && ["PAYMENT_REVIEW","CRYPTO_REVIEW","AWAITING_PAYMENT","AWAITING_CRYPTO","CRYPTO_ADDRESS_PENDING","AWAITING_CRYPTO_PAYMENT"].includes(o.status)) orders.push(o);
  }
  orders.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  if (!orders.length) return send(chatId, "🔔 <b>PENDING</b>\n\nNo pending orders.", { reply_markup: adminMenu() });
  const text = orders.slice(0,20).map(o => `<code>${o.id}</code> — ${esc(o.itemTitle)} — GH₵${o.amount} — <b>${esc(o.status)}</b>`).join("\n");
  return send(chatId, `<b>🔔 PENDING ORDERS</b>\n\n${text}`, { reply_markup: adminMenu() });
}

async function adminStats(chatId) {
  const users = await listKeys("user:");
  const orders = await listKeys("order:");
  let revenue = 0, completed = 0, checks = 0;
  for (const k of orders) {
    const o = await getJSON(k);
    if (!o) continue;
    if (o.status === "PAID" || o.status === "FULFILLED") { revenue += Number(o.amount || 0); completed++; }
    if (o.type === "CHECK_PACKAGE" && (o.status === "PAID" || o.status === "FULFILLED")) checks += Number(o.credits || 0);
  }
  return send(chatId, `<b>📊 GSX CHECK STATS</b>

Customers: <b>${users.length}</b>
Orders: <b>${orders.length}</b>
Paid/Fulfilled orders: <b>${completed}</b>
Recorded revenue: <b>GH₵${revenue}</b>
`, { reply_markup: adminMenu() });
}

async function adminUsers(chatId) {
  const keys = await listKeys("user:");
  const rows = [];
  for (const k of keys.slice(-20)) {
    const u = await getJSON(k);
    if (u) rows.push(`${esc(displayName(u))} — <code>${u.id}</code> — checks: ${u.credits}`);
  }
  return send(chatId, `<b>👥 CUSTOMERS</b>\n\n${rows.join("\n") || "No customers yet."}`, { reply_markup: adminMenu() });
}

async function adminPayments(chatId) {
  const keys = await listKeys("order:");
  const rows = [];
  for (const k of keys.slice(-30)) {
    const o = await getJSON(k);
    if (o && (o.paymentMethod || "").length) rows.push(`<code>${o.id}</code> — ${esc(o.paymentMethod)} — GH₵${o.amount} — ${esc(o.status)}`);
  }
  return send(chatId, `<b>💰 PAYMENTS</b>\n\n${rows.join("\n") || "No payments yet."}`, { reply_markup: adminMenu() });
}

async function adminChecks(chatId) {
  const keys = await listKeys("report:");
  const rows = [];
  for (const k of keys.slice(-30)) {
    const r = await getJSON(k);
    if (r) rows.push(`<code>${r.reportId}</code> — ${esc(maskId(r.imei))} — ${esc(r.source)}`);
  }
  return send(chatId, `<b>🔍 CHECK REPORTS</b>\n\n${rows.join("\n") || "No reports yet."}`, { reply_markup: adminMenu() });
}

async function adminDigital(chatId) {
  const keys = await listKeys("order:");
  const rows = [];
  for (const k of keys.slice(-30)) {
    const o = await getJSON(k);
    if (o && ["GIFT_CARD","VIRTUAL_NUMBER"].includes(o.type)) {
      rows.push([btn(`📦 ${o.id} — ${o.status}`, `admin:order:${o.id}`)]);
    }
  }
  rows.push([btn("⬅️ Admin", "admin:back")]);
  return send(chatId, "<b>🎁 DIGITAL ORDERS</b>\n\nSelect an order:", { reply_markup: kb(rows) });
}

async function adminSettings(chatId) {
  const crypto = [
    ["BTC", !!process.env.BTC_ADDRESS],
    ["USDT TRC20", !!process.env.USDT_TRC20_ADDRESS],
    ["USDT ERC20", !!process.env.USDT_ERC20_ADDRESS],
    ["ETH", !!process.env.ETH_ADDRESS],
    ["TRX", !!process.env.TRX_ADDRESS]
  ].map(x => `${x[0]}: ${x[1] ? "✅" : "❌"}`).join("\n");
  return send(chatId, `<b>⚙️ PAYMENT SETTINGS</b>

MoMo name: <b>${esc(MOMO_NAME)}</b>
MoMo number: <code>${esc(MOMO_NUMBER)}</code>

<b>Crypto wallets</b>
${crypto}

<b>Provider API</b>
${process.env.GSX_PROVIDER_URL ? "Configured" : "Not configured"}

API key: ${process.env.GSX_PROVIDER_API_KEY ? "Configured" : "Not configured"}`, { reply_markup: adminMenu() });
}

async function adminOrder(chatId, orderId) {
  const o = await getJSON(keyOrder(orderId));
  if (!o) return send(chatId, "Order not found.");
  const u = await getJSON(keyUser(o.userId));
  return send(chatId, `<b>📦 ORDER</b>

Order: <code>${o.id}</code>
Customer: ${esc(u ? displayName(u) : o.userId)}
Type: <b>${esc(o.type)}</b>
Item: ${esc(o.itemTitle)}
Amount: <b>${esc(o.currency)} ${o.amount}</b>
Payment: ${esc(o.paymentMethod || "Not selected")}
Status: <b>${esc(o.status)}</b>
Sender name: ${esc(o.senderName || "—")}
Network: ${esc(o.cryptoNetwork || "—")}
Address: <code>${esc(o.cryptoAddress || "—")}</code>
Customer details: ${esc(o.customerDetails || "—")}`, {
    reply_markup: kb([
      [btn("💰 Confirm Payment", `admin:confirm:${o.id}`), btn("❌ Reject", `admin:reject:${o.id}`)],
      [btn("📤 Fulfill / Deliver", `admin:deliver:${o.id}`)],
      [btn("⬅️ Admin", "admin:pending")]
    ])
  });
}

async function adminConfirm(chatId, orderId) {
  const o = await getJSON(keyOrder(orderId));
  if (!o) return send(chatId, "Order not found.");
  if (o.status === "PAID" || o.status === "FULFILLED") return send(chatId, "This order is already paid.");
  o.status = "PAID"; o.updatedAt = nowISO(); await putJSON(keyOrder(o.id), o);

  if (o.type === "CHECK_PACKAGE") {
    const u = await getJSON(keyUser(o.userId));
    if (!u) return send(chatId, "Customer record not found.");
    // Idempotency: payment status prevents this branch being applied twice.
    u.credits = Number(u.credits || 0) + Number(o.credits || CHECK_PACKAGES.find(p=>p.id===o.itemId)?.credits || 0);
    await putJSON(keyUser(u.id), u);
    await send(u.id, `<b>✅ PAYMENT CONFIRMED</b>\n\nOrder: <code>${o.id}</code>\nCredits added: <b>${o.credits || 0}</b>\nAvailable checks: <b>${u.credits}</b>`);
  } else {
    await send(o.userId, `<b>✅ PAYMENT CONFIRMED</b>\n\nOrder: <code>${o.id}</code>\nYour order is now waiting for manual fulfillment.`);
  }
  return send(chatId, `✅ Payment confirmed for <code>${o.id}</code>.`, { reply_markup: adminMenu() });
}

async function adminReject(chatId, orderId) {
  const o = await getJSON(keyOrder(orderId));
  if (!o) return send(chatId, "Order not found.");
  o.status = "REJECTED"; o.updatedAt = nowISO(); await putJSON(keyOrder(o.id), o);
  await send(o.userId, `<b>❌ PAYMENT NOT CONFIRMED</b>\n\nOrder: <code>${o.id}</code>\nPlease contact admin if you believe this is an error.`);
  return send(chatId, `❌ Order <code>${o.id}</code> rejected.`);
}

async function adminDeliverPrompt(chatId, orderId) {
  const o = await getJSON(keyOrder(orderId));
  if (!o) return send(chatId, "Order not found.");
  // Admin replies to this prompt with a one-time delivery command:
  // /deliver ORDER_ID code-or-message
  return send(chatId, `<b>📤 DELIVERY</b>

Order: <code>${o.id}</code>
Item: ${esc(o.itemTitle)}

Reply with:
<code>/deliver ${o.id} YOUR_DELIVERY_TEXT</code>

For gift cards, send only the actual code after you have verified the order. Do not paste the code into public logs.`);
}

async function adminDeliver(chatId, text) {
  const parts = text.split(" ");
  const orderId = parts[1];
  const delivery = parts.slice(2).join(" ").trim();
  if (!orderId || !delivery) return send(chatId, "Usage: /deliver ORDER_ID DELIVERY_TEXT");
  const o = await getJSON(keyOrder(orderId));
  if (!o) return send(chatId, "Order not found.");
  if (o.status !== "PAID") return send(chatId, "Order must be PAID before delivery.");
  o.delivery = delivery;
  o.status = "FULFILLED";
  o.updatedAt = nowISO();
  await putJSON(keyOrder(o.id), o);

  const deliveryTitle = o.type === "GIFT_CARD" ? "🎁 GIFT CARD DELIVERED" : "📲 ORDER FULFILLED";
  await send(o.userId, `<b>${deliveryTitle}</b>

Order: <code>${o.id}</code>
Product: <b>${esc(o.itemTitle)}</b>

<pre>${esc(delivery)}</pre>

<i>Keep this delivery information private.</i>

Thank you for using <b>GSX CHECK</b>.`);

  return send(chatId, `✅ Delivered <code>${o.id}</code>.`, { reply_markup: adminMenu() });
}

export default async (req) => {
  if (req.method === "GET") {
    return new Response("GSX CHECK is online.", { status: 200 });
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    const update = await req.json();

    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return new Response("OK");
    }

    if (update.message) {
      const m = update.message;
      const chatId = m.chat.id;
      const from = m.from;
      const text = m.text || "";

      if (String(from.id) === ADMIN_ID && text.startsWith("/deliver ")) {
        await adminDeliver(chatId, text);
        return new Response("OK");
      }

      await handleText(chatId, from, text);
      return new Response("OK");
    }

    return new Response("OK");
  } catch (err) {
    console.error(err);
    return new Response("OK");
  }
};
