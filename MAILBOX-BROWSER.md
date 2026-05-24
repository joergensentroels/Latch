# Mailbox And Browser Roadmap

Latch should let an agent request outbound contact and web research without turning those into uncontrolled powers.

## Current State

Implemented now:

- `external_contact` approvals for draft outbound messages
- `web_research` approvals for bounded research scopes
- structured fields for recipient, subject, preview, domains, page budget, and token budget
- no automatic sending
- no browser automation
- no mailbox credentials on the OpenClaw VM

The current bridge records approvals and reports back. It does not send email, operate a browser, scrape pages, log in, download files, or bypass human verification.

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

The first browser/research workflow should be read-only and bounded:

```text
Goal: one concrete question
Allowed domains: short explicit list
Max pages: 3-5 by default
Token budget: 2000-4000 by default
Login allowed: no
Downloads allowed: no
Actions allowed: no
```

The worker should not send raw pages directly to the LLM. Use a retrieval layer:

1. Fetch one allowed page.
2. Strip scripts, nav, footer, ads, and unrelated layout.
3. Extract the main article/content.
4. Save a local source note with URL, title, timestamp, and compact summary.
5. Send only the summary and a few relevant snippets to the LLM.
6. Reuse saved source notes instead of repeatedly fetching and summarizing the same page.

## Token Efficiency Rules

- Prefer official docs, primary sources, and targeted pages.
- Keep page budgets small.
- Summarize sources before using them in reasoning.
- Cache source notes by URL.
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

