# LeadPerfection Connector for RingCentral App Connect

This repository is a custom fork of `ringcentral/rc-unified-crm-extension` focused on building and validating a LeadPerfection CRM connector for RingCentral App Connect.

## Purpose

The goal of this fork is to add LeadPerfection-specific connector behavior on top of the App Connect framework, including:

- LeadPerfection authentication
- contact lookup by phone number
- call logging into LeadPerfection
- future extension support for additional CRM workflows

## Development prerequisites

This project uses Node.js 24 and pnpm 10.34.0. With `nvm` and Corepack
available, activate the required toolchain with:

```bash
nvm use
corepack enable
pnpm --version
```

The reported pnpm version should be `10.34.0`.

## Current status

Phase 0 development is complete, and management has approved moving into
deployment preparation and controlled testing. The local and CI toolchain is
now standardized on Node.js 24 and pnpm 10.34.0, with frozen dependency installs
and the complete automated test command verified locally: 54 suites and 1,326
tests pass. The connector has not yet been deployed or tested by a Discountbath
agent during a full day of live calls. The connector can:

- connect to the LeadPerfection production environment
- authenticate through the custom LeadPerfection sign-in flow
- query LeadPerfection contacts with `GetCustomers3`
- screen-pop and deep-link matched contacts
- log calls through `AddCallHistory`, including Call Result and Call Type
- save agent notes to the LeadPerfection Notes tab through `AddNotes`

The executive report and demonstration video were sent to the boss on August 6,
2026. Approval to begin deployment preparation and a one-agent browser pilot was
confirmed on August 28, 2026. Wider rollout should happen only after that pilot
is reviewed successfully.

## Production hosting direction

Production will run in a dedicated, client-owned Render workspace managed by
the assistant owner. The pilot uses a single-member Hobby workspace, one paid
always-on Node.js web service, and one paid Render Postgres database. The
developer does not need a paid Render seat: this public repository can deploy
automatically from `main` after GitHub checks pass.

The root `render.yaml` defines both resources, their private database
connection, generated application secrets, the `/isAlive` health check, and
the production start command. No hosting account, web service, or cloud
database has been created yet; those will be created with the assistant owner
during the client meeting.

The permanent deployment region is Ohio, selected to balance the client's
Colorado agents with LeadPerfection's central-US production endpoints. A
dedicated outbound IP is not expected to be necessary.

The LeadPerfection token-refresh lock has been moved from the upstream
framework's DynamoDB mechanism to an atomic, expiring PostgreSQL lock with
owner-checked release. The active LeadPerfection paths do not require AWS or
DynamoDB configuration when optional framework caching and proxy features are
disabled. This infrastructure change does not alter LeadPerfection's API,
credentials, permissions, contacts, calls, notes, or agent workflow.

The tracked [Render client deployment
runbook](docs/developers/render-client-deployment.md) contains the exact
pre-meeting preparation, meeting sequence, ownership boundary, acceptance
checklist, and post-deployment tests. The local working-copy hosting note
contains the historical provider comparison and deeper project context.

## Upstream framework

This project is based on RingCentral App Connect:

- Upstream repo: `https://github.com/ringcentral/rc-unified-crm-extension`
- End-user docs: `https://ringcentral.github.io/rc-unified-crm-extension/`

## Notes

- This fork contains project-specific connector work and may intentionally differ from upstream.
- Production deployment must use paid, always-on application and database
  resources with backups; free hosting/database tiers are not suitable.
