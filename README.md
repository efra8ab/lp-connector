# LeadPerfection Connector for RingCentral App Connect

This repository is a custom fork of `ringcentral/rc-unified-crm-extension` focused on building and validating a LeadPerfection CRM connector for RingCentral App Connect.

## Purpose

The goal of this fork is to add LeadPerfection-specific connector behavior on top of the App Connect framework, including:

- LeadPerfection authentication
- contact lookup by phone number
- call logging into LeadPerfection
- future extension support for additional CRM workflows

## Current status

Phase 0 is in active validation. The connector can already:

- connect to the LeadPerfection demo environment
- authenticate through the custom LeadPerfection sign-in flow
- query LeadPerfection contacts with `GetCustomers3`
- prepare call logging through `AddCallHistory`

## Upstream framework

This project is based on RingCentral App Connect:

- Upstream repo: `https://github.com/ringcentral/rc-unified-crm-extension`
- End-user docs: `https://ringcentral.github.io/rc-unified-crm-extension/`

## Notes

- This fork contains project-specific connector work and may intentionally differ from upstream.
- LeadPerfection production validation depends on the required API credentials and permissions being available.
