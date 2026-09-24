# Hosted validation and one-agent pilot

This runbook moves the LeadPerfection connector from infrastructure-ready to a
controlled real-agent pilot. It separates read-only deployment checks from
tests that create production LeadPerfection records.

## Required roles and test data

Have these people available for the initial validation:

- **Pilot lead:** runs the checklist, timestamps evidence, and makes the
  go/no-go decision.
- **Test agent:** uses the same browser, RingCentral App Connect installation,
  and LeadPerfection permissions they will use during the pilot.
- **LeadPerfection verifier:** confirms the resulting history and note directly
  in LeadPerfection.
- **Render owner:** can view logs and roll back. This person does not share the
  Render password, recovery codes, deploy hook, or environment secrets.

Use one dedicated LeadPerfection test lead and two phone numbers controlled by
the team. Do not use a real customer record for the scripted tests. Record the
test lead ID and the last four digits of each phone number in the private test
record; do not add credentials or full phone numbers to this repository.

Also ask the LeadPerfection verifier for one dedicated test **customer** record
(a record with a customer ID, not only a prospect ID). Notes have so far been
proven only on prospect records; UAT-08 covers the customer case.

## Entry gate

1. Confirm the deployed commit in Render is the intended tested `main` commit.
2. Run the local automated gate:

   ```bash
   pnpm test
   ```

3. Run the read-only hosted gate with the exact public Render URL:

   ```bash
   pnpm test:hosted -- https://YOUR-SERVICE.onrender.com
   ```

   It must pass health, manifest routing, connector-interface, hosted
   sign-in-page, and sign-in hardening checks. This command does not submit
   credentials or create CRM data.
4. Confirm the App Connect Developer Console connector points at Render, as
   described in
   [Point the Developer Console connector at Render](render-client-deployment.md#point-the-developer-console-connector-at-render).
   The extension reads its manifest from the Console, so the hosted gate above
   cannot prove this on its own; rerun it with the Console manifest URL as the
   second argument and require the **Developer Console manifest routing** check
   to pass.
5. Confirm the test agent can open RingCentral App Connect and LeadPerfection in
   the intended browser profile.
6. Confirm the Render owner has the service logs open and knows the most recent
   known-good deployment.

Do not start write tests if either automated gate fails, the deployed commit is
unknown, or the Render owner is unavailable for the first session.

## Scripted hosted validation

Use a new test-run ID in the form `LP-PILOT-YYYYMMDD-NN`. Prefix every test note
with that ID so records can be found without storing customer data in the test
report.

| ID | Agent action | Expected application result | LeadPerfection verification |
|---|---|---|---|
| UAT-01 | Load App Connect with the hosted LeadPerfection connector. | LeadPerfection is selected; Call Result and Call Type fields are visible, with Call Type defaulting to **Auto**. | No record is created. |
| UAT-02 | Connect with the pilot agent's own LeadPerfection credentials. | The hosted sign-in page completes and App Connect reports a connected user. | No call or note is created. Render logs show `LeadPerfection token user_data fields` listing `Emp_ID`; record the field list. |
| UAT-03 | Search using the designated test phone number. | Exactly the expected test lead appears and its deep link opens the correct lead. | The lead ID matches the private test record. |
| UAT-04 | After the access token expires, repeat UAT-03 without reconnecting. | Lookup succeeds through refresh; the agent sees no credential prompt. | Render logs show one successful refresh path and no credential values. |
| UAT-05 | Place a short outbound call to the controlled test number, choose **No Answer**, leave Call Type on **Auto**, enter a note containing the test-run ID, then save. Write down the call's start time. | App Connect reports a successful log and remains usable. | One `AddCallHistory` entry with result No Answer and type Other; its date/time matches the call's local start time (not 6–7 hours later); the Caller column shows the **pilot agent**, not "RingCentral"; one `AddNotes` entry contains the exact test note. |
| UAT-06 | Receive a short inbound call from the second controlled number, choose an agreed result, leave Call Type on **Auto**, enter a different test-run note, then save. | The correct test lead is matched and the log succeeds once. | One history entry with Call Type **Inbound** and one matching note exist; no duplicate record was created. |
| UAT-07 | Refresh the browser and perform another lookup. | The connection remains valid and lookup still works. | No new history or note is created by lookup alone. |
| UAT-08 | Log a short call with a test-run note against the dedicated test customer record. | The log succeeds once. | The history entry and the note both appear on the customer record. |
| UAT-09 | Look up a number that is not in LeadPerfection. | No contact is matched and no "Create new contact" option is offered. | No record is created. |

For UAT-04, prefer naturally waiting for token expiry. If time requires forcing
expiry, the Render owner may set only the dedicated pilot user's `tokenExpiry`
to a past timestamp after taking a database export. Do not change access tokens,
refresh tokens, credentials, or another user's row. Record the before/after
timestamp and restore only from the known export if the test causes an issue.

## Evidence record

Create one private copy of this table per run. Screenshots must mask credentials,
tokens, full phone numbers, customer names, and unrelated records.

| Field | Value |
|---|---|
| Test-run ID | |
| Date/time and timezone | |
| Deployed commit | |
| Render service URL | |
| Pilot agent | |
| Browser and App Connect version | |
| Test LeadPerfection lead ID | |
| Automated gate result | |
| UAT-01 through UAT-09 results | |
| `user_data` field list from UAT-02 | |
| LeadPerfection call-history IDs | |
| LeadPerfection note verification | |
| Relevant Render log timestamps | |
| Defects or observations | |
| Go/no-go decision and approver | |

An individual scenario passes only when both the agent-visible result and the
LeadPerfection-side verification pass. A successful App Connect notification by
itself is not sufficient evidence.

## Brief the pilot agent

Tell the agent these known limits before the pilot day:

- Choose the real **Call Result** every time. It defaults to No Answer, so saving
  without changing it records a connected call as No Answer.
- Leave **Call Type** on Auto unless a specific type applies; Auto records
  Inbound for incoming calls and Other for outgoing calls.
- Keep App Connect's automatic call logging off for the pilot.
- A caller who is not in LeadPerfection cannot be logged. Add the lead in
  LeadPerfection first, refresh the contact match, then log the call.
- Editing a saved log in App Connect does not update LeadPerfection.
- Searching contacts by name is not supported; lookups are by phone number.
- Repeat calls from the same number may reuse a cached match.

## One-working-day pilot

After all scripted scenarios pass, use one agent for one normal working day.
The agent should follow their normal workflow and record only operational
metadata, not customer content:

- time of issue;
- incoming or outgoing;
- lookup, sign-in, call-log, note, duplicate, or performance category;
- whether retry succeeded;
- the relevant LeadPerfection record ID; and
- whether the problem blocked work.

At the end of the day, compare RingCentral completed calls for the pilot agent
with LeadPerfection call-history records. Review every mismatch and spot-check
notes, call direction, Call Result, and Call Type. Wider rollout requires zero
unexplained missing or duplicate call logs, no credential prompts during normal
token refresh, and no unresolved severity-1 or severity-2 defect.

## Stop and rollback rules

Stop the pilot immediately for any of these conditions:

- a call or note is written to the wrong lead;
- credentials, access tokens, or customer data appear in logs;
- duplicate call histories or notes are created;
- agents cannot reconnect or continue their existing workflow;
- the service has repeated 5xx responses; or
- the database becomes unavailable or inconsistent.

Disable the pilot connector for the test agent, preserve the test-run ID and log
timestamps, and have the Render owner roll back to the last known-good deploy if
the hosted change caused the issue. Do not delete or manually rewrite production
LeadPerfection records until the LeadPerfection owner has reviewed them.

## Exit criteria

The pilot is complete when the scripted run and one-working-day comparison are
documented, defects are triaged, backup/restore has been tested separately, and
the business owner records an explicit decision to proceed, extend the pilot, or
stop. Adding more agents is a separate rollout decision.
