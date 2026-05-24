# Open Source Preparation

This project can become an open source repository, but publish only after a secrets and boundary check.

## Before First Push

- Confirm `data/` is not included.
- Confirm `.env` files with real values are not included.
- Confirm `data/auth.json` is not included.
- Confirm `data/llm-provider.json` is not included.
- Confirm no screenshots or docs contain real tokens.
- Rotate any token that was ever pasted into a public place.
- Choose a license before announcing the project.

## Recommended Repository Shape

Keep these in the public repo:

- `server.js`
- `public/`
- `README.md`
- `SECURITY.md`
- `DESIGN.md`
- `LLM-PROVIDER.md`
- `AGENT-BOUNDARY.md`
- scripts with placeholders only
- `.env.example`
- `llm-provider.example.json`

Keep these out of the public repo:

- `data/`
- real `.env` files
- API keys
- operator keys
- agent keys from a live deployment
- machine-specific logs

## GitHub Access Rule

Do not give the OpenClaw VM a GitHub token with write access.

Safe options:

- Human pushes from the trusted Windows machine.
- Agent receives tasks through Latch only.
- Agent can create patch files or reports for human review.
- If a repo checkout is needed, use read-only access.

## Public Code Assumption

Once public, assume attackers and agents can read every line. Secrets, authorization, spending limits, and approval workflows must carry the security model.
