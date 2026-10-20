# Draft message to Neon One support

**Subject:** API: PATCH /eventRegistrations/{id} fails with "Event coupon code is invalid" (14014) when couponCode is an empty string

Hello Amy,

Thank you for your help so far. As a follow-up to our earlier exchange, we are building an integration that marks event attendees as attended (`markedAttended`) through the v2 API. Updating a registration works for most registrations, but fails for registrations whose stored `couponCode` is an empty string. We would like to know how to update those.

**Organization:** `ourstompingground` (reproduced in our sandbox, `ourstompinggroundsandbox`)
**API version:** `NEON-API-VERSION: 2.11` (2.10 and 2.12 behave the same)

**Works** (registration created by bulk import; `couponCode` is `null`):

```
PATCH /v2/eventRegistrations/515
{"tickets":[{"attendees":[{"attendeeId":415,"markedAttended":false}]}]}
-> 200 {"id":515,"accountId":"1371","status":"SUCCEEDED","paymentResponse":null}
```

**Fails** (registration created through the online form, `origin.originCategory` is `Event Registration Form`; `GET` returns `"couponCode": ""`):

```
PATCH /v2/eventRegistrations/16883
{"tickets":[{"attendees":[{"attendeeId":23127,"markedAttended":false}]}]}
-> 400 [{"code":"14014","message":"Event coupon code is invalid."}]
```

What we tried on registration 16883:

| Request | Result |
| --- | --- |
| PATCH with `"couponCode": null` | 400 `1114` "You cannot modify Event Registration couponCode." |
| PATCH with `"couponCode": ""` | 400 `14014` "Event coupon code is invalid." |
| PATCH with any other `couponCode` value | 400 `14014` and `1114` |
| PUT with the full registration from `GET` (coupon omitted or null) | 400 `1114` |
| PATCH with other fields only (`sendSystemEmail`, `ignoreCapacity`) | 400 `14014` |
| `PATCH/PUT /events/{id}/attendees/{attendeeId}` and similar | 404 |

**What we tested** (every call set `markedAttended` to its current value, so no data changed):

| Registrations | `couponCode` | Result |
| --- | --- | --- |
| 46, across nine events held Oct 19-20, 2026 (online form and store order form) | `""` | all fail with `14014` |
| 8 more from Apr-Sep 2026 (online form) | `""` | all fail with `14014` |
| 4 from Apr-Sep 2026 (online form) | `null` | update normally |
| 20 from Jan 2025 through Mar 2026 (online form, data entry) | `null` | update normally |
| 24 from 2023-2024 (bulk import) | `null` | update normally |

So the problem is not the age of the event or how the registration was created. It happens whenever the stored `couponCode` is an empty string, which appears to affect registrations made since some point in 2026.

**Questions**

1. How can an integration set `markedAttended` on a registration whose stored `couponCode` is an empty string?
2. Is there an attendee-level endpoint for check-in that avoids re-validating the registration?
3. Is the empty-string `couponCode` on form registrations expected, and can the validation treat it as "no coupon"?

Thank you,

Ly Vuong  
OSG Software Developer
