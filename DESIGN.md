# Latch Design Pattern

## Product Shape

Latch is an operator gateway for directing a disposable agent machine from a trusted phone or desktop.

The interface should feel:

- calm under pressure
- fast to scan on a phone
- explicit about risk and approval state
- sparse enough to use while walking around
- operational, not decorative

## Navigation

Use four primary surfaces:

- Inbox: human and agent messages
- Tasks: queued and running work
- Approvals: actions that need operator consent
- Timeline: audit trail

On phones, primary navigation lives at the bottom. On desktop, it becomes an inline segmented control.

## Visual Language

- Cards are individual records only: messages, tasks, approvals, events.
- Avoid nested cards.
- Use compact status badges for queued, running, waiting, done, failed, pending, approved, denied.
- Keep the color system restrained:
  - teal for active/primary
  - green for approved/done
  - amber for queued/waiting/pending
  - red for denied/failed
  - slate/white surfaces for reading

## Interaction Rules

- Destructive or sensitive agent actions must become approvals.
- Operator actions should complete in one tap where safe.
- Agent status should be visible without opening a detail view.
- The app should stay useful even if the network drops: cached shell, clear offline state, no fake success.

## Mobile Install Pattern

The phone app is a PWA. Prefer Tailscale Serve HTTPS for installation and daily use.

Avoid Tailscale Funnel for this product unless public exposure is intentionally designed and reviewed.
