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
  decodeImapText,
  decodeMimeWords,
  parseImapHeaders,
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

// decodeImapText: pulls the literal body, undoes quoted-printable, drops MIME boundaries,
// Content-* headers, and quoted reply history.
const imapBody = [
  "--bnd",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Thanks for the note =E2=80=94 sounds good.",
  "> On Tue you wrote:",
  "> earlier stuff",
  "--bnd--"
].join("\r\n");
const imapResp = `* 5 FETCH (BODY[TEXT] {${imapBody.length}}\r\n${imapBody})\r\na9 OK FETCH completed\r\n`;
const decoded = decodeImapText(imapResp);
assert.ok(decoded.includes("Thanks for the note"), "decodeImapText should surface the plain body");
assert.ok(decoded.includes("sounds good"), "decodeImapText should keep the reply text");
assert.ok(!decoded.includes(">"), "decodeImapText should drop quoted reply history");
assert.ok(!decoded.includes("Content-Type"), "decodeImapText should drop MIME headers");
assert.ok(!decoded.includes("--bnd"), "decodeImapText should drop MIME boundaries");

// parseImapHeaders: a folded From (long/encoded display name pushes the address to the next line)
// must still yield the address - this is the bug that made the companion silently skip real replies.
const foldedFetch = [
  "* 5 FETCH (BODY[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID)] {140}",
  "From: =?iso-8859-1?Q?Jane_D=F8e?=",
  " <jane.doe@example.com>",
  "Subject: Re: Message from the Compass companion",
  "Message-ID: <abc123@example.com>",
  "",
  ")",
  "a9 OK FETCH completed"
].join("\r\n");
const parsed = parseImapHeaders(foldedFetch);
assert.ok(/jane\.doe@example\.com/.test(parsed.from), "folded From must still expose the address");
assert.match(extractEmailForTest(parsed.from), /^jane\.doe@example\.com$/);
assert.equal(parsed.messageId, "<abc123@example.com>", "Message-ID should parse");
assert.ok(parsed.subject.startsWith("Re: Message from the Compass"), "Subject should parse");
assert.equal(decodeMimeWords("=?UTF-8?B?SGVsbG8=?="), "Hello", "decodeMimeWords should decode base64 words");
assert.equal(decodeMimeWords("=?utf-8?Q?a_b?="), "a b", "decodeMimeWords should decode Q words");

function extractEmailForTest(s) {
  return (String(s).match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/) || [""])[0];
}

console.log("Agent-email unit tests passed.");
