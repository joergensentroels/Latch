// Host-brokered agent email (Compass / Latch).
//
// The agent operates its OWN mailbox, but never holds the credentials: only this module — which
// runs on the trusted host ("credentials machine") — reads them. The worker calls the host API;
// the host talks SMTP/IMAP. No external npm dependencies: SMTP send and IMAP poll are implemented
// directly over node:tls, matching Latch's "Node built-ins only" property.
//
// Transports:
//   - "smtp_imap": real SMTP send (implicit TLS) + IMAP poll (implicit TLS). Needs validation
//     against a live mailbox before production use.
//   - "mock": no network; records sent messages in memory and returns a seeded inbox. Used by
//     tests and safe for local dry-runs.
//
// The feature is DISABLED unless data/agent-email.json exists with enabled:true (or env overrides).

import { readFile } from "node:fs/promises";
import tls from "node:tls";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function loadEmailConfig(configPath, env = process.env) {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    fileConfig = {};
  }

  const smtp = fileConfig.smtp || {};
  const imap = fileConfig.imap || {};
  const limits = fileConfig.limits || {};

  const config = {
    transport: env.AGENT_EMAIL_TRANSPORT || fileConfig.transport || "smtp_imap",
    fromAddress: String(env.AGENT_EMAIL_FROM || fileConfig.fromAddress || "").trim(),
    fromName: String(env.AGENT_EMAIL_FROM_NAME || fileConfig.fromName || "Compass Agent").trim(),
    smtp: {
      host: env.AGENT_EMAIL_SMTP_HOST || smtp.host || "",
      port: Number(env.AGENT_EMAIL_SMTP_PORT || smtp.port || 465),
      user: env.AGENT_EMAIL_SMTP_USER || smtp.user || "",
      pass: env.AGENT_EMAIL_SMTP_PASS || smtp.pass || ""
    },
    imap: {
      host: env.AGENT_EMAIL_IMAP_HOST || imap.host || "",
      port: Number(env.AGENT_EMAIL_IMAP_PORT || imap.port || 993),
      user: env.AGENT_EMAIL_IMAP_USER || imap.user || "",
      pass: env.AGENT_EMAIL_IMAP_PASS || imap.pass || ""
    },
    limits: {
      maxSendsPerHour: Number(env.AGENT_EMAIL_MAX_PER_HOUR || limits.maxSendsPerHour || 20),
      maxSendsPerDay: Number(env.AGENT_EMAIL_MAX_PER_DAY || limits.maxSendsPerDay || 100)
    },
    timeoutMs: Number(env.AGENT_EMAIL_TIMEOUT_MS || fileConfig.timeoutMs || 30000),
    fileLoaded: Object.keys(fileConfig).length > 0
  };

  const enabledFlag = env.AGENT_EMAIL_ENABLED != null
    ? !["0", "false", "no", ""].includes(String(env.AGENT_EMAIL_ENABLED).toLowerCase())
    : Boolean(fileConfig.enabled);

  // mock is usable as soon as it's enabled + has a from address; smtp_imap needs real hosts/creds.
  const hasSmtp = Boolean(config.smtp.host && config.smtp.user && config.smtp.pass);
  const hasImap = Boolean(config.imap.host && config.imap.user && config.imap.pass);
  config.enabled = enabledFlag && Boolean(config.fromAddress) &&
    (config.transport === "mock" || (hasSmtp && hasImap));
  return config;
}

// A redacted view safe to return to the operator UI (never the passwords).
export function publicEmailConfig(config) {
  return {
    enabled: config.enabled,
    transport: config.transport,
    fromAddress: config.fromAddress,
    fromName: config.fromName,
    smtpHost: config.smtp.host,
    imapHost: config.imap.host,
    maxSendsPerHour: config.limits.maxSendsPerHour,
    maxSendsPerDay: config.limits.maxSendsPerDay,
    fileLoaded: config.fileLoaded
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (no network) — the parts worth unit-testing hardest
// ---------------------------------------------------------------------------

export function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase();
}

// Is this recipient already cleared for autonomous contact? (i.e. part of an approved campaign)
export function isKnownRecipient(address, approvedContacts = []) {
  const target = normalizeAddress(address);
  if (!target) return false;
  return approvedContacts.some((item) => normalizeAddress(item) === target);
}

// Rate-limit accounting from an audit log of prior sends (array of ISO timestamps).
export function rateLimitState(sendTimestamps = [], limits = {}, nowMs) {
  const maxHour = Number(limits.maxSendsPerHour || 20);
  const maxDay = Number(limits.maxSendsPerDay || 100);
  const times = sendTimestamps.map((t) => Date.parse(t)).filter((n) => Number.isFinite(n));
  const lastHour = times.filter((t) => nowMs - t < 3600_000).length;
  const lastDay = times.filter((t) => nowMs - t < 86_400_000).length;
  return {
    lastHour,
    lastDay,
    allowed: lastHour < maxHour && lastDay < maxDay,
    reason: lastHour >= maxHour
      ? `Hourly send limit reached (${maxHour}/h).`
      : lastDay >= maxDay
        ? `Daily send limit reached (${maxDay}/day).`
        : ""
  };
}

// Decide what a send request requires, before any network call.
//   -> { action: "send" }            recipient already approved, within limits
//   -> { action: "needs_approval" }  new recipient — cold-contact approval required first
//   -> { action: "blocked", reason } rate limit or bad input
export function classifySend({ to, approvedContacts = [], sendTimestamps = [], limits = {}, nowMs }) {
  const target = normalizeAddress(to);
  if (!target || !target.includes("@")) {
    return { action: "blocked", reason: "A valid recipient address is required." };
  }
  const rate = rateLimitState(sendTimestamps, limits, nowMs);
  if (!rate.allowed) {
    return { action: "blocked", reason: rate.reason, rate };
  }
  if (!isKnownRecipient(target, approvedContacts)) {
    return { action: "needs_approval", reason: "First contact with a new recipient requires an approved outreach plan." };
  }
  return { action: "send", rate };
}

// Build an RFC 5322 message with CRLF line endings and SMTP dot-stuffing applied to the body.
export function buildMessage({ from, fromName, to, subject, body, inReplyTo, references, date }) {
  const messageDate = date || new Date().toUTCString();
  const headers = [
    `From: ${fromName ? `${sanitizeHeader(fromName)} <${from}>` : from}`,
    `To: ${sanitizeHeader(to)}`,
    `Subject: ${sanitizeHeader(subject)}`,
    `Date: ${messageDate}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit"
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeader(inReplyTo)}`);
  if (references) headers.push(`References: ${sanitizeHeader(references)}`);
  const normalizedBody = String(body || "").replace(/\r?\n/g, "\r\n");
  const dotStuffed = normalizedBody.replace(/\r\n\./g, "\r\n..");
  return `${headers.join("\r\n")}\r\n\r\n${dotStuffed}`;
}

function sanitizeHeader(value) {
  // Prevent header injection: strip CR/LF from header values.
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

// In-memory mock state for tests / dry-runs.
const mockState = { sent: [], inbox: [] };
export function __mockReset(inbox = []) {
  mockState.sent = [];
  mockState.inbox = inbox.slice();
  return mockState;
}
export function __mockSent() {
  return mockState.sent.slice();
}

export async function sendEmail(config, message) {
  if (config.transport === "mock") {
    const record = { to: message.to, subject: message.subject, at: message.date || null, id: `mock_${mockState.sent.length + 1}` };
    mockState.sent.push(record);
    return { ok: true, id: record.id, transport: "mock" };
  }
  return sendViaSmtp(config, message);
}

export async function pollInbox(config, options = {}) {
  if (config.transport === "mock") {
    return { ok: true, messages: mockState.inbox.slice(0, options.limit || 20), transport: "mock" };
  }
  return pollViaImap(config, options);
}

// --- SMTP over implicit TLS (port 465). AUTH LOGIN. ---
async function sendViaSmtp(config, message) {
  const raw = buildMessage({
    from: config.fromAddress,
    fromName: config.fromName,
    to: message.to,
    subject: message.subject,
    body: message.body,
    inReplyTo: message.inReplyTo,
    references: message.references
  });

  const conn = await tlsConnect(config.smtp.host, config.smtp.port, config.timeoutMs);
  try {
    await conn.expect(220);
    await conn.command(`EHLO ${hostnameLabel(config.fromAddress)}`, 250);
    await conn.command("AUTH LOGIN", 334);
    await conn.command(Buffer.from(config.smtp.user).toString("base64"), 334);
    await conn.command(Buffer.from(config.smtp.pass).toString("base64"), 235);
    await conn.command(`MAIL FROM:<${config.fromAddress}>`, 250);
    await conn.command(`RCPT TO:<${message.to}>`, 250);
    await conn.command("DATA", 354);
    await conn.command(`${raw}\r\n.`, 250);
    await conn.command("QUIT", 221).catch(() => {});
    return { ok: true, transport: "smtp", to: message.to };
  } finally {
    conn.close();
  }
}

// --- IMAP over implicit TLS (port 993). Minimal poll: LOGIN, SELECT, SEARCH, FETCH. ---
// NOTE: implemented against the IMAP4rev1 basics; validate against your live server before relying
// on it. Returns lightweight { uid, from, subject, snippet } records; full MIME parsing is a later
// enhancement.
async function pollViaImap(config, options = {}) {
  const conn = await tlsConnect(config.imap.host, config.imap.port, config.timeoutMs);
  try {
    await conn.readUntil(/^\* OK/mi);
    await conn.imap("a1", `LOGIN ${imapQuote(config.imap.user)} ${imapQuote(config.imap.pass)}`);
    await conn.imap("a2", "SELECT INBOX");
    const criteria = options.unseenOnly === false ? "ALL" : "UNSEEN";
    const search = await conn.imap("a3", `SEARCH ${criteria}`);
    const ids = (search.match(/^\* SEARCH ([\d ]+)/mi)?.[1] || "").trim().split(/\s+/).filter(Boolean);
    const pick = ids.slice(-(options.limit || 20));
    const messages = [];
    for (const id of pick) {
      const fetch = await conn.imap(`f${id}`, `FETCH ${id} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID)])`);
      messages.push({
        uid: id,
        from: fetch.match(/^From:\s*(.+)$/mi)?.[1]?.trim() || "",
        subject: fetch.match(/^Subject:\s*(.+)$/mi)?.[1]?.trim() || "",
        messageId: fetch.match(/^Message-ID:\s*(.+)$/mi)?.[1]?.trim() || ""
      });
    }
    await conn.imap("a9", "LOGOUT").catch(() => {});
    return { ok: true, transport: "imap", messages };
  } finally {
    conn.close();
  }
}

function imapQuote(value) {
  return `"${String(value || "").replace(/(["\\])/g, "\\$1")}"`;
}

function hostnameLabel(address) {
  const domain = String(address || "").split("@")[1] || "localhost";
  return domain.replace(/[^A-Za-z0-9.-]/g, "") || "localhost";
}

// Minimal promise-based TLS line client shared by SMTP and IMAP.
function tlsConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!host) {
      reject(new Error("email transport host is not configured"));
      return;
    }
    let buffer = "";
    const socket = tls.connect({ host, port, servername: host }, () => {});
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs || 30000, () => socket.destroy(new Error("email transport timeout")));
    socket.on("data", (chunk) => { buffer += chunk; });
    socket.on("error", reject);
    socket.once("secureConnect", () => resolve(makeClient()));
    // Some TLS stacks fire "connect" before "secureConnect"; guard with a ready fallback.
    socket.once("connect", () => {});

    function drainMatching(matcher) {
      return new Promise((res, rej) => {
        // Both listeners are removed on whichever path fires first, so repeated commands over the
        // same socket don't accumulate handlers (previously leaked one 'error' listener per call,
        // tripping Node's MaxListenersExceededWarning after ~10 commands).
        const cleanup = () => {
          socket.off("data", onData);
          socket.off("error", onError);
        };
        const onData = () => {
          if (matcher.test(buffer)) {
            const out = buffer;
            buffer = "";
            cleanup();
            res(out);
          }
        };
        const onError = (err) => {
          cleanup();
          rej(err);
        };
        if (matcher.test(buffer)) {
          const out = buffer;
          buffer = "";
          res(out);
          return;
        }
        socket.on("data", onData);
        socket.once("error", onError);
      });
    }

    function makeClient() {
      return {
        // SMTP: read until a line begins with the expected 3-digit code (and not a continuation "-").
        async expect(code) {
          // SMTP final reply line is "<code> ..."; continuations are "<code>-...". Wait for the final.
          return drainMatching(new RegExp(`^${code} `, "m"));
        },
        async command(line, code) {
          socket.write(line + "\r\n");
          return this.expect(code);
        },
        // IMAP: send a tagged command and read until the tagged completion line.
        async imap(tag, line) {
          socket.write(`${tag} ${line}\r\n`);
          const out = await drainMatching(new RegExp(`^${tag} (OK|NO|BAD)`, "mi"));
          if (new RegExp(`^${tag} (NO|BAD)`, "mi").test(out)) {
            throw new Error(`IMAP ${line.split(" ")[0]} failed: ${out.trim().slice(0, 200)}`);
          }
          return out;
        },
        readUntil(matcher) { return drainMatching(matcher); },
        close() { try { socket.end(); } catch {} }
      };
    }
  });
}
