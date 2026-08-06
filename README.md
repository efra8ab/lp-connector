# LeadPerfection Connector for RingCentral App Connect

This repository is a custom fork of `ringcentral/rc-unified-crm-extension` focused on building and validating a LeadPerfection CRM connector for RingCentral App Connect.

## Purpose

The goal of this fork is to add LeadPerfection-specific connector behavior on top of the App Connect framework, including:

- LeadPerfection authentication
- contact lookup by phone number
- call logging into LeadPerfection
- future extension support for additional CRM workflows

## Current status

Phase 0 development is complete. The connector has passed automated tests and
controlled production checks, but it has not yet been tested by a Discountbath
agent during a full day of live calls. The connector can:

- connect to the LeadPerfection production environment
- authenticate through the custom LeadPerfection sign-in flow
- query LeadPerfection contacts with `GetCustomers3`
- screen-pop and deep-link matched contacts
- log calls through `AddCallHistory`, including Call Result and Call Type
- save agent notes to the LeadPerfection Notes tab through `AddNotes`

The executive report and demonstration video were sent to the boss on August 6,
2026. The project is waiting for approval of lean production hosting and a
one-agent browser pilot. Wider rollout should happen only after that pilot is
reviewed successfully.

## Production hosting direction

The target production architecture is one Render web service and one paid
Render Postgres database. The goal is to give the client one provider, one
account, and one operational interface for the application, database, backups,
secrets, and logs.

The upstream RingCentral framework uses AWS DynamoDB for short-lived
token-refresh locks. This is internal connector infrastructure; it is not part
of LeadPerfection and was not configured by LeadPerfection. Before deploying to
Render, replace the LeadPerfection connector's DynamoDB token lock with an
atomic, expiring lock stored in the same Postgres database. Audit the active
LeadPerfection runtime paths for any other DynamoDB dependency and validate
concurrent and expired-token refresh behavior before removing AWS configuration.

This infrastructure change must not alter the LeadPerfection API contract,
credentials, AppKey permissions, contacts, calls, notes, or workflows.

See
[LeadPerfection production hosting](docs/developers/leadperfection-production-hosting.md)
for the architecture decision and deployment checklist.

## Upstream framework

This project is based on RingCentral App Connect:

- Upstream repo: `https://github.com/ringcentral/rc-unified-crm-extension`
- End-user docs: `https://ringcentral.github.io/rc-unified-crm-extension/`

## Notes

- This fork contains project-specific connector work and may intentionally differ from upstream.
- Production deployment must use paid, always-on application and database
  resources with backups; free hosting/database tiers are not suitable.
