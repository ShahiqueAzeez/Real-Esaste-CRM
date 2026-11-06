# Plivo telephony: research, design and smoke test

Research date: 6 November 2026.

**How this was verified.** The build environment's network policy blocked direct access to
plivo.com. Method names, parameters and the webhook signature algorithm were therefore checked
against the official SDK source code downloaded from npm (`plivo@4.79.0`, server SDK, and
`plivo-browser-sdk@2.2.21`). Behaviour that the SDK code cannot prove was checked against
search-indexed Plivo documentation pages listed under *Sources*. Anything still unverified is
marked **UNVERIFIED** and must be confirmed in the smoke test before a pilot.

## What the code relies on

| Capability | Verified in | Used as |
|---|---|---|
| Place a call: `client.calls.create(from, to, answerUrl, { answerMethod, hangupUrl, ringUrl, ringTimeout, timeLimit, sipHeaders, fallbackAnswerUrl })`. Returns `requestUuid`, not the call UUID. | SDK `resources/call.d.ts` | Agent leg and customer leg. Legs are matched to callbacks by `RequestUUID` first, then `CallUUID`. |
| `to` may be a number (no `+`) or `sip:user@phone.plivo.com`. | SDK doc comment on `create` | Browser agent identity or agent phone. |
| Hang up a live call: `client.calls.hangup(callUuid)`. Cancel a queued or ringing request: `client.calls.cancel(requestUuid)`. | SDK `resources/call.js` | Agent hang-up, cancelling the customer leg when the agent drops. |
| Call detail record: `client.calls.get(callUuid)` → `billDuration`, `totalAmount`, `totalRate`, `hangupCauseName`, `hangupSource`, … | SDK `RetrieveCallResponse` | Cost reconciliation and stuck-call recovery. |
| Browser JWT: `client.token.create(authId, { sub, exp, nbf, incoming_allow, outgoing_allow, app })` → `POST /v1/Account/{auth_id}/JWT/Token/`, response `{ apiId, token }`. | SDK `resources/token.js`; Plivo JWT auth doc | Receive-only token for the agent browser. |
| Locally signed JWTs are rejected by Plivo SIP infrastructure; use the token API. | Plivo JWT auth doc (search index) | We never sign Plivo JWTs ourselves. |
| Browser SDK: `new Plivo(options)`, `client.loginWithAccessToken(token)`, `client.loginWithAccessTokenGenerator({ getAccessToken(): Promise<string> })`, `answer(callUUID, action)`, `reject`, `hangup`, `mute`, `unmute`, `logout`. JWT login needs SDK ≥ 2.2.16. | `plivo-browser-sdk` `index.d.ts` and bundle | `apps/web/src/lib/telephony/plivo-browser.ts`. |
| Browser events: `onLogin`, `onLoginFailed`, `onIncomingCall(callerName, extraHeaders, callInfo)`, `onIncomingCallCanceled`, `onCallAnswered`, `onCallTerminated`, `onCallFailed`, `onMediaConnected`, `onConnectionChange`, `onPermissionDenied`, `onWebrtcNotSupported`. | SDK bundle | Device/connection status on the agent screen. |
| Signature V3: headers `X-Plivo-Signature-V3`, `X-Plivo-Signature-Ma-V3`, `X-Plivo-Signature-V3-Nonce`; HMAC-SHA256 with the auth token over URL + sorted params + `.` + nonce; header may hold several comma-separated signatures. | SDK `utils/v3Security.js`; Plivo signature-validation doc | `PlivoSignatureVerifier` calls the SDK's own `validateV3Signature`. |
| MultiPartyCall XML (`addMultiPartyCall`) attributes include `role`, `coachMode`, `startMpcOnEnter`, `endMpcOnExit`, `record`, `recordingCallbackUrl`, `statusCallbackUrl`, `statusCallbackEvents`, `maxDuration`, `stayAlone`, `enterSound`, `exitSound`. | SDK `utils/plivoxml.js` | Agent and customer join `call-<id>`. |
| Add a participant by API: `client.multiPartyCalls.addParticipant(role, { friendlyName, from, to, coachMode, callStatusCallbackUrl, … })`; role ∈ agent, supervisor, customer. `updateParticipant(id, { coachMode })` also exists. | SDK `resources/multiPartyCall.js` | Supervisor whisper (coach) and barge. |
| Coach mode: supervisor audio is heard by agents only; the supervisor's voice is still in recordings. | Plivo MPC XML doc (search index) | Whisper. Documented to users. |
| Hangup callback fields: `CallUUID`, `RequestUUID`, `CallStatus`, `Duration`, `BillDuration`, `HangupCauseName`, `HangupCauseCode`, `HangupSource`. Outbound `CallStatus` may be `completed`, `busy`, `failed`, `timeout`, `no-answer`, `cancel`. | Plivo application/XML request docs (search index) | Leg state mapping. |
| `TotalCost` in the hangup callback | **UNVERIFIED** | Read when present; otherwise cost is fetched from the CDR (`totalAmount`). Costs without a provider figure are stored as estimates and labelled so. |
| Exact MPC status-callback event names and recording-callback field names | **UNVERIFIED** | Stored raw. Core call state never depends on them; it comes from per-leg ring/answer/hangup callbacks. Recording fields are parsed tolerantly (`RecordingID`/`RecordingUrl`/`RecordingDuration` and variants). |
| How Plivo addresses a JWT-registered browser user | **UNVERIFIED** | Default `sip:{identity}@phone.plivo.com` (`PLIVO_BROWSER_SIP_URI_TEMPLATE`). Admins can set a per-agent Plivo endpoint username if Plivo requires pre-created endpoints. |
| Whether custom `sip_headers` arrive in the browser as `X-PH-*` extra headers | **UNVERIFIED** | The browser auto-answers when the header matches; if no header is present it accepts only the single call the server has announced over Socket.IO for that agent within 45 seconds. |

## India-specific constraints (affects whether a pilot can go live)

From Plivo's *India Calling Regulations*, *India Number KYC* and *Calling in India* pages
(search-indexed, not fetched directly):

1. **Only India-registered businesses can make India domestic calls** on Plivo, using an account
   created in the **India data region**. The region cannot be changed after sign-up. Businesses
   outside India are forced onto international routes with non-Indian caller IDs.
2. **KYC** is required to rent Indian numbers (one valid document, for example a GST certificate,
   certificate of incorporation or Udyam registration).
3. **Caller ID** for domestic calls must be a number rented on your Plivo account. Verified caller
   IDs are not supported for India.
4. **Media anchoring**: both legs must stay within India. A violation fails the call with hangup
   code **4590** (media anchoring violation). This matters for the agent leg:
   * **Browser (WebRTC) agents: UNVERIFIED for India.** Plivo's Browser SDK documentation found
     during research does not say whether WebRTC endpoints are anchored in India for India-region
     accounts. **Confirm with Plivo support before relying on browser calling in India.**
   * **Agent phone mode** (agent leg to the agent's Indian mobile, customer leg to the lead, both
     on the India-region account) is the documented fallback and is implemented.
5. **Number series**: landline-series numbers are for non-BFSI service and transactional calls; the
   **140 series is for promotional calls**; the 160/1600 series is for BFSI. Real estate
   sales calls to prospects are generally promotional, which points to **140-series numbers and
   DLT registration**. See `docs/COMPLIANCE_INDIA.md`.

If browser calling is not supported for the account, set the tenant's default calling mode to
`PHONE` (Settings → Calling). The adapter, state machine and UI are identical; only the agent leg's
destination changes.

## Call design implemented

```
agent leg   : calls.create(from=<tenant caller ID>, to=sip:<identity>@phone.plivo.com | <agent phone>,
              answer_url=/api/webhooks/plivo/answer?callId=…&leg=agent,
              ring_url=…/ring, hangup_url=…/hangup, ring_timeout=25, time_limit=<max>,
              sip_headers="CrmCallId=<callId>")
agent answer: <Response><MultiPartyCall role="Agent" startMpcOnEnter="true" endMpcOnExit="true"
              statusCallbackUrl=…/mpc record=… recordingCallbackUrl=…/recording>call-<id></MultiPartyCall>
              → enqueue dialer job "customer-leg"
customer leg: calls.create(from=<caller ID>, to=<lead E.164 without +>, answer_url=…?leg=customer, …)
customer ans: [<Speak>recording notice</Speak>] <MultiPartyCall role="Customer" endMpcOnExit="true">call-<id></MultiPartyCall>
supervisor  : multiPartyCalls.addParticipant("supervisor", { friendlyName: "call-<id>", from, to: sip:<supervisor identity>…,
              coachMode: true })   // whisper; updateParticipant(coachMode=false) to barge
```

Webhook URLs are built from `PUBLIC_BASE_URL`. Signature validation uses that exact URL, so the
value must match what Plivo calls (scheme, host, port and path).

## Which legs incur charges

Each leg is a separate Plivo call and is billed separately at the rate for its destination:

* **Agent leg**: browser/SIP endpoint minutes, or a PSTN call to the agent's phone in phone mode
  (a full outbound mobile rate).
* **Customer leg**: an outbound PSTN call to the lead. Unanswered attempts may still incur charges
  depending on route; check the rate card.
* **MultiPartyCall**: Plivo may charge for MPC participant minutes in addition to call legs, and
  for recording and recording storage. **Confirm on the current Plivo pricing page for India.**
* **Supervisor coaching**: an additional leg plus MPC participant minutes.

The CRM stores provider-reported costs (`cost_source = PROVIDER`) separately from estimates
(`cost_source = ESTIMATE`, using tenant-configured per-minute rates) and labels them in reports. It
never presents estimates as invoices.

## Account prerequisites checklist

- [ ] Plivo account in the India data region (domestic calling) with KYC approved.
- [ ] At least one rented Indian number suited to the calling purpose (140-series for promotional).
- [ ] DLT registration (principal entity / telemarketer) completed as required by your operator.
- [ ] HTTP auth enabled on recording URLs (Plivo console → Voice settings). Recording URLs are
      public by default.
- [ ] Auth ID / Auth Token stored in the CRM (Settings → Integrations → Plivo). A subaccount per
      tenant is recommended.
- [ ] `PUBLIC_BASE_URL` reachable over HTTPS from Plivo.
- [ ] Browser calling confirmed with Plivo for India, or tenant switched to phone mode.

## Smoke test (real provider)

Run only with approved test numbers that belong to people who agreed to receive test calls.

1. Set the tenant's Plivo credentials and caller ID in Settings → Integrations. Press **Test
   connection** (fetches account details; no call is placed). Status must turn *Configured*.
2. Create a queue with one lead whose number is your own approved test phone, consent `GRANTED`.
3. Sign in as an agent in Chrome. The device check must show *Microphone OK* and
   *Plivo registered*.
4. Click **Ready**. Expected sequence on the agent screen: *Calling your browser* → *Agent
   connected* → *Ringing customer* → *Connected* (only after you answer the test phone).
5. Speak in both directions. Hang up from the CRM. Expected: both legs end, wrap-up opens.
6. In the database, `call_events` must hold ring/answer/hangup rows for both legs with
   `signature_valid = true`, and `call_legs.provider_call_id` must be set.
7. Re-deliver one webhook (Plivo console or replay the logged request). Expected: HTTP 200 and no
   new state change (`duplicate = true` in logs).
8. Repeat with the test phone rejecting the call. Expected outcome suggestion: *Busy* or
   *No answer*, retry scheduled per policy.
9. Supervisor test: during a live call, a supervisor clicks **Whisper**. Their browser rings and
   auto-answers; the agent hears the supervisor, the customer must not.
10. Recording test (if enabled): after the call, the recording appears as *Available* and plays from
    the CRM; the Plivo URL never appears in browser dev tools.

Record the results, Plivo call UUIDs and any hangup causes in `BUILD_STATUS.md`.

## Sources

* Plivo JWT authentication for Browser SDK — https://www.plivo.com/docs/voice/sdk/browser/jwt-authentication
* Plivo Browser SDK reference — https://www.plivo.com/docs/voice/sdk/browser/reference
* Plivo India calling regulations — https://www.plivo.com/docs/voice/concepts/india-calling
* Plivo India number KYC — https://www.plivo.com/docs/numbers/rent-india-numbers
* Plivo Calling in India (media anchoring, 4590) — https://www.plivo.com/docs/voice-agents/sip-trunking/deploy/calling-in-india
* Plivo signature validation — https://www.plivo.com/docs/voice/concepts/signature-validation
* Plivo MultiPartyCall XML — https://www.plivo.com/docs/voice/xml/multiparty-call
* Plivo Add a participant — https://docs.plivo.com/docs/voice/api/multiparty-call/participants/add-a-participant
* Plivo supervisor coaching — https://plivo.com/docs/voice/use-cases/supervisor-coaching
* Plivo recording authentication — https://plivo.com/blog/introducing-authentication-for-call-recordings
* Plivo Node SDK — https://www.npmjs.com/package/plivo (v4.79.0) and Browser SDK https://www.npmjs.com/package/plivo-browser-sdk (v2.2.21)
