// Unit tests for the agent-email module's pure logic + mock transport (no network).
// The live SMTP/IMAP wire transports are validated separately against a real mailbox.
import assert from "node:assert/strict";
import {
  classifySend,
  rateLimitState,
  isKnownRecipient,
  normalizeAddress,
  buildMessage,
  sendEmail,
  pollInbox,
  loadEmailConfig,
  __mockReset,
  __mockSent
} from "../email.mjs";

const NOW = Date.parse("2026-07-03T12:00:00Z");

// --- recipient normalization / known-recipient ---
assert.equal(normalizeAddress("  Foo@Bar.COM "), "foo@bar.com", "addresses normalize to trimmed lowercase");
assert.ok(isKnownRecipient("foo@bar.com", ["other@x.com", "FOO@bar.com"]), "known recipient matches case-insensitively");
assert.ok(!isKnownRecipient("new@x.com", ["foo@bar.com"]), "unknown recipient is not known");

// --- classifySend: cold contact requires approval ---
const cold = classifySend({ to: "new@prospect.com", approvedContacts: [], sendTimestamps: [], limits: {}, nowMs: NOW });
assert.equal(cold.action, "needs_approval", "first contact with a new recipient needs approval");

const known = classifySend({ to: "lead@prospect.com", approvedContacts: ["lead@prospect.com"], sendTimestamps: [], limits: {}, nowMs: NOW });
assert.equal(known.action, "send", "an approved recipient can be emailed");

const bad = classifySend({ to: "not-an-email", approvedContacts: ["not-an-email"], sendTimestamps: [], limits: {}, nowMs: NOW });
assert.equal(bad.action, "blocked", "invalid address is blocked");

// --- rate limiting ---
const hourStamps = Array.from({ length: 20 }, () => new Date(NOW - 60_000).toISOString());
const limited = classifySend({ to: "lead@prospect.com", approvedContacts: ["lead@prospect.com"], sendTimestamps: hourStamps, limits: { maxSendsPerHour: 20, maxSendsPerDay: 100 }, nowMs: NOW });
assert.equal(limited.action, "blocked", "hourly rate limit blocks further sends");
assert.match(limited.reason, /Hourly/, "rate-limit reason names the hourly cap");

const rate = rateLimitState([new Date(NOW - 2 * 3600_000).toISOString()], { maxSendsPerHour: 5, maxSendsPerDay: 10 }, NOW);
assert.equal(rate.lastHour, 0, "sends older than an hour don't count toward the hourly window");
assert.equal(rate.lastDay, 1, "sends within a day count toward the daily window");
assert.ok(rate.allowed, "under both caps is allowed");

// --- buildMessage: header-injection safety + dot-stuffing + CRLF ---
const msg = buildMessage({
  from: "agent@x.com",
  fromName: "Compass Agent",
  to: "lead@prospect.com",
  subject: "Hello\r\nBcc: victim@evil.com",
  body: "Line 1\n.hidden dot line\nLine 3",
  date: "Fri, 03 Jul 2026 12:00:00 GMT"
});
assert.ok(!/^Bcc:/mi.test(msg), "header injection via CRLF in subject cannot create a new header line");
assert.ok(/^Subject: Hello Bcc: victim@evil.com$/mi.test(msg), "the injected CRLF is flattened into the subject text, not a header");
assert.ok(msg.includes("\r\n\r\n"), "headers and body are separated by a blank CRLF line");
assert.ok(msg.includes("\r\n..hidden dot line"), "leading-dot body lines are dot-stuffed for SMTP");
assert.ok(msg.startsWith("From: Compass Agent <agent@x.com>"), "From header includes display name");

// --- mock transport ---
__mockReset([{ uid: "1", from: "lead@prospect.com", subject: "Re: Hello" }]);
const mockCfg = { transport: "mock", fromAddress: "agent@x.com", fromName: "Compass Agent", timeoutMs: 1000 };
const sent = await sendEmail(mockCfg, { to: "lead@prospect.com", subject: "Hi", body: "Body", date: "now" });
assert.equal(sent.ok, true, "mock send returns ok");
assert.equal(__mockSent().length, 1, "mock records the sent message");
const polled = await pollInbox(mockCfg, {});
assert.equal(polled.messages.length, 1, "mock poll returns the seeded inbox");
assert.equal(polled.messages[0].subject, "Re: Hello", "mock poll returns message fields");

// --- config loading (env-driven, mock enabled without real hosts) ---
const cfg = await loadEmailConfig("/nonexistent/agent-email.json", {
  AGENT_EMAIL_ENABLED: "1",
  AGENT_EMAIL_TRANSPORT: "mock",
  AGENT_EMAIL_FROM: "agent@x.com"
});
assert.equal(cfg.enabled, true, "mock transport enables with just a from address");
assert.equal(cfg.transport, "mock", "transport read from env");

const cfgSmtp = await loadEmailConfig("/nonexistent/agent-email.json", {
  AGENT_EMAIL_ENABLED: "1",
  AGENT_EMAIL_TRANSPORT: "smtp_imap",
  AGENT_EMAIL_FROM: "agent@x.com"
});
assert.equal(cfgSmtp.enabled, false, "smtp_imap stays disabled without real host/credentials");

console.log("Agent-email unit tests passed.");
