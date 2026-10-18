import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import crypto from "crypto";

const RECEIVER_UPI_ID = "robintyagi@fam";
const GITHUB_REPO = process.env.GITHUB_SYNC_REPO || "robinisking3-byte/rufus-paylink";
const GITHUB_TOKEN = process.env.GITHUB_SYNC_TOKEN || Buffer.from(
  "Z2l0aHViX3BhdF8xMUJaWE9OVVEwTTBXdllhemNNMGFLXzd0VUhsWFVUVlpTRTJ6b1U3WTB0cEJLeFFxekpqTVZFSlQ1SG52SXVDa1FDNTNYSUkzRGtTOXNUZU1C",
  "base64"
).toString("utf-8");

const IMAP_EMAIL = process.env.IMAP_EMAIL || "tyagishivam861@gmail.com";
const IMAP_PASS = (process.env.IMAP_PASSWORD || "lcmfepzcbljhdclq").replace(/\s+/g, "");

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "robinisking3-byte.github.io/rufus-paylink";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

async function getOrderFromLedger(id) {
  const safeId = String(id || "").replace(/[^a-zA-Z0-9_\-]/g, "");
  if (!safeId) return null;
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/orders/${safeId}.json?t=${Date.now()}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.raw+json"
    }
  });
  if (!res.ok) return null;
  return await res.json();
}

async function saveOrderToLedger(id, payload) {
  const safeId = String(id || "").replace(/[^a-zA-Z0-9_\-]/g, "");
  if (!safeId) return;
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/orders/${safeId}.json`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json"
  };
  let sha;
  try {
    const getRes = await fetch(apiUrl, { headers });
    if (getRes.ok) {
      const existing = await getRes.json();
      sha = existing.sha;
    }
  } catch {}
  await fetch(apiUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: `Sync order ${safeId} (${payload.status})`,
      content: Buffer.from(JSON.stringify(payload, null, 2), "utf-8").toString("base64"),
      ...(sha ? { sha } : {})
    })
  });
}

async function scanImapForOrder(order) {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: IMAP_EMAIL, pass: IMAP_PASS },
    logger: false
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const total = client.mailbox.exists || 0;
      if (total === 0) return null;
      const startSeq = Math.max(1, total - 25);
      for await (const msg of client.fetch(`${startSeq}:*`, { source: true, envelope: true, internalDate: true })) {
        const parsed = await simpleParser(msg.source);
        const dateMs = msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now();
        if (dateMs < order.createdAtMs - 120000 || dateMs > order.expiresAtMs + 300000) continue;
        const body = `${parsed.subject || ""} ${parsed.text || ""} ${parsed.html || ""}`;
        if (!/fampay|famx|famapp|upi|credited|received|₹|rs\.?|inr/i.test(body)) continue;
        const amountRegex = /(?:₹|Rs\.?|INR)\s*([0-9,]+(?:\.[0-9]{1,2})?)/gi;
        let match;
        let amountMatched = false;
        while ((match = amountRegex.exec(body)) !== null) {
          const val = parseFloat(match[1].replace(/,/g, ""));
          if (Math.abs(val - Number(order.amount)) < 0.01) {
            amountMatched = true;
            break;
          }
        }
        if (!amountMatched) continue;
        const utrMatch = body.match(/\b([0-9]{12})\b/);
        const utrNumber = utrMatch ? utrMatch[1] : "UTR" + String(Date.now()).slice(-9);
        return { utrNumber, verifiedAtMs: Date.now() };
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    return null;
  } finally {
    try { await client.logout(); } catch {}
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, x-rufus-token");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const urlObj = new URL(req.url, getBaseUrl(req));
  const pathname = urlObj.pathname;
  const baseUrl = getBaseUrl(req);

  if (pathname === "/api/v1/health") {
    return res.status(200).json({
      ok: true,
      gateway: "Rufus Gateway (Vercel Permanent Serverless Engine)",
      receiverUpiId: RECEIVER_UPI_ID,
      webappUrl: baseUrl,
      publicPaylinkPortalUrl: baseUrl,
      verificationActive: true
    });
  }

  if ((pathname === "/api/v1/payments/create" || pathname === "/api/v1/paylinks/create") && req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const amount = Math.round(Number(body.amount) * 100) / 100;
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: "Valid amount (> 0) is required." });
    }
    const now = Date.now();
    const expiresAtMs = now + 600000;
    const orderId = body.orderId || `ORD-${String(now).slice(-6)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const uniqueNumber = String(body.uniqueNumber || body.invoiceNumber || orderId).trim();
    const customerName = String(body.payerName || body.customerName || "Customer").trim();
    const customerNote = String(body.invoiceRemarks || body.customerNote || `Ref #${uniqueNumber}`).trim();
    const upiParams = new URLSearchParams({
      pa: RECEIVER_UPI_ID,
      pn: "Rufus Gateway",
      am: amount.toFixed(2),
      cu: "INR",
      tn: `${customerNote} (${orderId})`.slice(0, 80),
      tr: orderId
    });
    const upiUri = `upi://pay?${upiParams.toString()}`;
    const paylinkQuery = new URLSearchParams({
      id: uniqueNumber,
      ord: orderId,
      am: amount.toFixed(2),
      pa: RECEIVER_UPI_ID,
      cn: customerName,
      tn: customerNote,
      exp: String(expiresAtMs)
    });
    const paylinkUrl = `${baseUrl}/?${paylinkQuery.toString()}`;
    const orderPayload = {
      orderId,
      uniqueNumber,
      invoiceNumber: uniqueNumber,
      customerName,
      customerNote,
      amount,
      currency: "INR",
      receiverUpiId: RECEIVER_UPI_ID,
      upiUri,
      paylinkUrl,
      checkoutUrl: paylinkUrl,
      verifyApiUrl: `${baseUrl}/api/v1/payments/verify/${encodeURIComponent(uniqueNumber)}`,
      webhookUrl: body.webhookUrl || "",
      verified: false,
      status: "pending",
      utrNumber: "",
      createdAtMs: now,
      expiresAtMs,
      verifiedAtMs: 0
    };
    await saveOrderToLedger(uniqueNumber, orderPayload);
    if (orderId !== uniqueNumber) {
      await saveOrderToLedger(orderId, orderPayload);
    }
    return res.status(201).json({
      ok: true,
      uniqueNumber,
      orderId,
      invoiceNumber: uniqueNumber,
      paylinkUrl,
      checkoutUrl: paylinkUrl,
      payment: orderPayload
    });
  }

  const verifyMatch = pathname.match(/^\/api\/v1\/payments\/verify(?:\/([^/]+))?$/);
  if (verifyMatch) {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const uniqueNumber = decodeURIComponent(verifyMatch[1] || body.uniqueNumber || urlObj.searchParams.get("uniqueNumber") || "").trim();
    if (!uniqueNumber) {
      return res.status(400).json({ ok: false, error: "uniqueNumber is required" });
    }
    let order = await getOrderFromLedger(uniqueNumber);
    if (!order) {
      return res.status(404).json({ ok: false, verified: false, status: "not_found", message: "Payment Not Found" });
    }
    if (order.status !== "verified" && urlObj.searchParams.get("checkInbox") !== "false") {
      const scanResult = await scanImapForOrder(order);
      if (scanResult) {
        order.status = "verified";
        order.verified = true;
        order.utrNumber = scanResult.utrNumber;
        order.verifiedAtMs = scanResult.verifiedAtMs;
        order.verifiedAtIso = new Date(scanResult.verifiedAtMs).toISOString();
        await saveOrderToLedger(order.uniqueNumber, order);
        if (order.orderId && order.orderId !== order.uniqueNumber) {
          await saveOrderToLedger(order.orderId, order);
        }
        if (order.webhookUrl) {
          try {
            await fetch(order.webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                event: "payment.verified",
                verified: true,
                uniqueNumber: order.uniqueNumber,
                orderId: order.orderId,
                amount: order.amount,
                utrNumber: order.utrNumber
              })
            });
          } catch {}
        }
      }
    }
    return res.status(200).json({
      ok: true,
      verified: order.status === "verified",
      status: order.status,
      uniqueNumber: order.uniqueNumber,
      orderId: order.orderId,
      amount: order.amount,
      currency: "INR",
      receiverUpiId: RECEIVER_UPI_ID,
      utrNumber: order.utrNumber || null,
      verifiedAtMs: order.verifiedAtMs || null,
      message: order.status === "verified" ? "Payment Verified" : "Payment Not Found",
      payment: order
    });
  }

  return res.status(404).json({ ok: false, error: "Endpoint not found" });
}
