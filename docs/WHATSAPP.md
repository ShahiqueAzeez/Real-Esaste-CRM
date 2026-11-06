# WhatsApp Cloud API

WhatsApp is optional and per organisation. It sends **approved template messages** through Meta's
WhatsApp Cloud API: a callback confirmation, an optional missed-call follow-up, and manual sends by
staff. It never sends free-form marketing, and it is never triggered on every missed call by
default.

## What is implemented

| Area | Behaviour |
|---|---|
| Configuration | Integrations → WhatsApp: phone number ID, business account ID (optional), Graph API version (default `v23.0`), access token, app secret, webhook verify token. Secrets are encrypted with AES-256-GCM and never returned to the browser. |
| Templates | Admins register templates already approved in WhatsApp Manager: name, language, category (`UTILITY` or `MARKETING`), purpose and variable mapping (for example `lead.firstName`, `callback.when`, `org.name`). The CRM does not create or submit templates to Meta. |
| Sending | `POST https://graph.facebook.com/<version>/<phone-number-id>/messages` with a `template` payload. Messages are queued (BullMQ) and retried on transient errors; permanent Meta errors mark the message `FAILED` with the error code. |
| Automations | *Callback confirmation* after a "Callback scheduled" or "Follow-up required" outcome, and *missed-call follow-up* after "No answer" or "Busy". Both are **off by default** (Settings → WhatsApp follow-ups) and must use a `UTILITY` template; automated sends with a marketing template are refused. |
| Policy checks before every send | Active subscription; plan includes WhatsApp; template active; number not on the WhatsApp or all-channel suppression list; consent not revoked; consent granted when the tenant requires it (default); at most `maxMessagesPerLeadPer7Days` (default 2) outbound messages per number in 7 days. Skipped messages are stored with the reason (`opted_out`, `frequency_cap`, …), never silently dropped. Opt-out is re-checked when the queued message is actually sent. |
| Webhooks | `GET/POST /api/webhooks/whatsapp/<tenantId>`. `GET` answers Meta's verification challenge only with the tenant's verify token. `POST` requires a valid `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the tenant's app secret). Delivery statuses (`sent`, `delivered`, `read`, `failed`) are applied in order and never move backwards. |
| Opt-out | Inbound replies such as STOP, UNSUBSCRIBE, OPT OUT, CANCEL, END or QUIT add the number to the WhatsApp suppression list and are audited. |
| Simulated mode | Without configuration and with `WHATSAPP_ALLOW_MOCK=true`, messages go through the same policy checks and are stored with `is_simulated = true` and shown as SIMULATED. Nothing reaches WhatsApp. |

## Setting up a real number

1. In Meta Business Manager, create (or use) a WhatsApp Business Account and add a phone number.
   Complete business verification as Meta requires.
2. Create a Meta app with the WhatsApp product. Generate a **permanent system-user access token**
   with `whatsapp_business_messaging` permission (temporary tokens expire within a day).
3. In WhatsApp Manager, create templates and wait for approval. Use the **Utility** category for
   callback confirmations and missed-call follow-ups, for example:
   * `callback_confirmation` (en): "Hi {{1}}, as requested, {{3}} will call you back on {{2}}.
     Reply STOP to opt out."
   * `missed_call_followup` (en): "Hi {{1}}, we tried to reach you from {{2}}. Reply here if you
     would like a call back. Reply STOP to opt out."
4. In the CRM: Integrations → WhatsApp. Enter the phone number ID, the access token, the app secret
   (Meta app → Settings → Basic) and choose a long random verify token. Save.
5. In the Meta app's WhatsApp → Configuration, set the callback URL to
   `<PUBLIC_BASE_URL>/api/webhooks/whatsapp/<your tenant id>` (shown on the Integrations page) and
   the same verify token. Subscribe to the `messages` field.
6. Register the approved templates in the CRM with the same name and language and map their
   variables.
7. Send a manual message to an approved test number, then reply STOP from that phone and confirm
   the number appears on the Compliance page.

## Policy notes

* Business-initiated conversations require the recipient's opt-in and an approved template. Free-form
  messages are only allowed within 24 hours of the customer's last message; the CRM does not send
  free-form messages at all.
* Meta limits how many marketing templates a user receives across businesses. Do not use marketing
  templates for follow-ups; the CRM blocks them for automated sends.
* Indian telemarketing rules apply to promotional content regardless of channel. See
  `docs/COMPLIANCE_INDIA.md`.

## Not verified against a live WhatsApp account

The adapter was built from Meta's documented Cloud API request/response shapes and tested against a
mocked HTTP server and signed webhook fixtures. Before relying on it:

* Send one real template message and confirm the template component/parameter structure renders as
  expected for your templates (header or button parameters are not mapped yet; body parameters are).
* Confirm the delivery-status webhook arrives and updates the message to *Delivered* / *Read*.
* Confirm error codes for an unapproved template and a recipient outside the 24-hour window are
  surfaced in the message list.
