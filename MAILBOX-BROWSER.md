# Mailbox And Browser Roadmap

Latch should let an agent request outbound contact and web research without turning those into uncontrolled powers.

## Current State

Implemented now:

- `external_contact` approvals for draft outbound messages
- `web_research` approvals for bounded research scopes
- structured fields for recipient, subject, preview, domains, page budget, and token budget
- approved read-only research against exact seed URLs
- compact source-note reporting back into Latch
- VM-local source-note caching by URL
- no automatic sending
- no interactive browser automation
- no mailbox credentials on the OpenClaw VM

The current bridge records approvals and reports back. After approval, it may fetch exact approved public URLs for `web_research`. It does not send email, operate a browser, search the web, crawl links, log in, download files, or bypass human verification.

## External Contact Rule

The first safe workflow is draft-only:

1. Agent asks to contact someone.
2. Latch creates an `external_contact` approval.
3. Operator reviews recipient, subject, body preview, attachments, and purpose.
4. Operator sends manually or returns edits.
5. Latch stores only the review/audit summary.

Do not give the agent a general mailbox login, SMTP password, personal inbox, or browser session.

Future connector rules:

- project-specific mailbox only
- credentials stored only on the trusted Latch host
- one approval per first-contact message
- no hidden recipients
- no automatic attachments
- no long private threads sent to the LLM by default

## Browser And Research Rule

The first research workflow is read-only and bounded:

```text
Goal: one concrete question
Allowed domains: short explicit list
Seed URLs: exact approved public URLs
Max pages: 3-5 by default
Token budget: 2000-4000 by default
Login allowed: no
Downloads allowed: no
Actions allowed: no
Search/crawl allowed: no
```

The worker does not send raw pages directly to the LLM. It uses a small retrieval layer:

1. Fetch one allowed page.
2. Strip scripts, nav, footer, ads, and unrelated layout.
3. Extract the main article/content.
4. Create a source note with URL, title, status, compact summary, and short excerpt.
5. Report source notes to Latch.
6. Cache successful source notes by URL on the VM.
7. Send only summaries/snippets into future reasoning, not full raw pages.

The current implementation does not follow links. More advanced crawling should require a second review.

## Token Efficiency Rules

- Prefer official docs, primary sources, and targeted pages.
- Keep page budgets small.
- Summarize sources before using them in reasoning.
- Cache source notes by URL.
- Use cached notes unless the operator asks to refresh/refetch.
- Ask the operator before increasing budget.
- Return links and short evidence snippets, not huge copied pages.
- Avoid broad scraping and search-result wandering.

## Approval Shape

External contact:

```json
{
  "type": "external_contact",
  "riskLevel": "medium",
  "recipient": "reviewer@example.com",
  "subject": "Security review request for Latch",
  "bodyPreview": "Short draft preview...",
  "sendMode": "manual"
}
```

Web research:

```json
{
  "type": "web_research",
  "riskLevel": "medium",
  "researchQuestion": "What is the safest browser sandbox design for Latch?",
  "allowedDomains": ["example.com"],
  "seedUrls": ["https://example.com/security/browser-sandbox"],
  "maxPages": 5,
  "tokenBudget": 3000
}
```

## Not Yet Allowed

- CAPTCHA solving
- account creation without operator involvement
- sending mail/messages without approval
- using a personal browser profile
- downloading unknown files
- logging in to third-party sites
- scraping large sites
- accepting arbitrary URLs or domains from untrusted instructions without operator review
- fetching internal IPs, localhost, `.local` hosts, or private network targets
