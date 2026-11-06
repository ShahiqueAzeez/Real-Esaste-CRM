# Compliance notes for outbound calling in India

**This is not legal advice.** It summarises public regulatory material as understood on
6 November 2026 and maps it to features in this CRM. Rules change often (TRAI issued further
clarifications as recently as July 2026). Each agency using the CRM must confirm its obligations
with qualified counsel and its telecom provider before calling real people.

**Using Plivo does not make a campaign compliant.** Plivo provides connectivity under its own
India terms (India-region account, KYC, rented numbers); registration, consent, preference checks
and call content remain the calling business's responsibility.

## 1. Telemarketing rules (TRAI, TCCCPR 2018 as amended)

The Telecom Commercial Communications Customer Preference Regulations, 2018, as amended
(notably the amendment notified on 12 February 2025), govern commercial calls and messages:

* **Number series.** Promotional voice calls must come from the **140** series; transactional and
  service calls from the **1600** series. Using ordinary 10-digit mobile or landline numbers for
  telemarketing is prohibited, and senders doing so risk disconnection and blacklisting of their
  telecom resources. TRAI's July 2026 clarification adds that 1600-series calls cannot be blocked
  or filtered by apps, while 140-series promotional calls are blocked according to each
  customer's DND (Do Not Disturb) preferences.
* **Registration.** Entities that want 140-series numbers for promotional calls must register with
  a telecom service provider under the TCCCPR framework (the DLT ecosystem: principal entity and,
  where used, telemarketer registration).
* **Customer preferences.** Promotional calls must respect the recipient's DND preferences unless
  the recipient has given consent that satisfies the regulations (TRAI is moving consent capture
  onto the operators' digital consent systems; confirm the current mechanism with your operator).
* **Complaints.** Recipients can report unsolicited commercial communication through their
  operator and the TRAI DND app; repeated complaints trigger action against the sender.

**What this means for a Chennai real estate agency:** calls to prospects about properties are
generally promotional. Plan for a **140-series number from an India-region Plivo account**, DLT
registration as a principal entity, and DND-aware lead lists. Calls to people who explicitly asked
to be contacted (a callback request, an existing customer conversation) may be service calls, but
the classification is a legal judgement, not a CRM setting.

Sources: TRAI press release 11 of 2025 (https://cms.trai.gov.in/sites/default/files/2025-02/PR_No.11of2025.pdf),
TRAI press release 91 of 2026 (https://trai.gov.in/sites/default/files/2026-07/PR_No91of2026.pdf),
JSA summary of the February 2025 amendments
(https://www.jsalaw.com/wp-content/uploads/2025/02/JSA-Prism-Telecommunications_February-2025_TCCCPR-amendments.Final_.pdf).
These were located through search results during the build; read the primary texts before relying
on any detail.

## 2. Telecommunications Act, 2023 (DoT)

The Act gives the Central Government power to require prior consent for "specified messages"
(commercial communications), to maintain do-not-disturb registers and to provide complaint
mechanisms. Rules under the Act continue to be notified; track DoT notifications alongside TRAI's
regulations.

## 3. Personal data (DPDP Act, 2023 and DPDP Rules, 2025)

The Digital Personal Data Protection Rules, 2025 were notified in November 2025 with a phased
start: Data Protection Board provisions immediately, Consent Manager provisions after one year,
and the main obligations on data fiduciaries (notice, consent, security safeguards, breach
reporting, retention and erasure) about **18 months after notification, around May 2027**. Until
then the IT Act's SPDI Rules, 2011 continue to apply. Each agency is the data fiduciary for its
leads; the SaaS operator is a data processor and needs a processing agreement with each agency.

Sources: PIB notification document
(https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf),
AZB & Partners update (https://www.azbpartners.com/bank/update-indias-digital-personal-data-protection-framework-comes-into-effect/).

## 4. Call recording

Inform the other party that the call may be recorded. When recording is enabled the CRM plays a
configurable notice to the customer before they join the conversation (Settings → Call
recording). Recordings are personal data: keep them only as long as needed (retention days per
tenant) and restrict access (only roles with recording permission; every playback is audited).

## 5. WhatsApp

Meta requires opt-in before business-initiated messages and approved templates outside the
24-hour customer service window. Marketing templates are subject to Meta's per-user marketing
limits. See `docs/WHATSAPP.md`.

## What the CRM provides

| Obligation area | CRM feature | Where |
|---|---|---|
| Do-not-call and opt-out | Tenant suppression list (voice, WhatsApp or all channels). "Do not call", "wrong number" and "invalid number" outcomes and WhatsApp STOP replies add entries automatically. Suppressed numbers are never dialled or messaged. | Compliance page |
| Consent | Per-lead consent status (unknown / granted / revoked) with consent records (source, time, actor). By default only leads with granted consent are dialled or messaged. | Lead detail, Settings → Leads |
| Calling hours | Per-tenant windows in the tenant's time zone, enforced before every dial; retries move into the next open window. Default Monday–Saturday 10:00–19:00 (a conservative default; set it to what applies to you). | Compliance page / Settings |
| Attempt limits and retry policy | Maximum attempts and per-outcome retry delays per tenant; no retries after opt-out or terminal outcomes. | Settings → Calling |
| Caller ID | Only numbers configured on the tenant's Plivo account can be selected as caller IDs. | Integrations, Queues |
| Recording notice and retention | Spoken notice before the customer joins; retention period with automatic deletion; audited playback. | Settings → Call recording |
| Data minimisation | Agents see masked numbers; lead retention deletes inactive leads after a configured period; exports are permissioned and audited. | Settings → Leads & retention |
| Accountability | Audit log of logins, exports, settings changes, suppression changes, recording access and deletions. | Audit log |

## What the CRM does not do

* It does not check numbers against the national DND register or the operators' consent
  systems. Integrate a scrubbing service or your operator's API before calling DND-registered
  numbers.
* It does not register you on DLT or obtain 140/1600-series numbers.
* It cannot decide whether a call is promotional or service; it records what agents and admins
  enter.
* It does not provide legal templates (privacy notice, processing agreement, consent wording).

## Go-live checklist (per agency)

- [ ] Legal review of call purpose classification, scripts and consent wording.
- [ ] Plivo India-region account with KYC approved; 140-series (or 1600-series where applicable)
      number rented; DLT registration complete.
- [ ] Lead lists scrubbed against DND preferences, or consent captured in the required way.
- [ ] Calling windows, attempt limits and retry rules configured for the agency.
- [ ] Recording notice text approved; retention period set.
- [ ] Privacy notice published; processing agreement signed between agency and SaaS operator.
- [ ] Staff trained to record opt-outs immediately ("Do not call" outcome).
