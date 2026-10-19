# Neon One API notes (verified against the live org, read-only)

Base `https://api.neoncrm.com/v2`, Basic auth (Org ID : API key), header `NEON-API-VERSION: 2.11`.

## Verified
- **Events search** `POST /events/search`. Search fields include `Event Start Date` / `Event End Date`
  (operators `GREATER_AND_EQUAL`, `LESS_AND_EQUAL`, `IN_RANGE`, ...). Body pagination
  `{currentPage (0-based), pageSize (up to 200)}`; response `pagination.totalPages`.
- **Event output fields**: `Event ID`, `Event Name`, `Event Start/End Date`, `Event Start/End Time`,
  `Event Location Name`, `Event Description`, `Event Registration Attendee Count`, `Event Capacity`,
  `Marked Attended`, `Event Category Name`, `Event Topic`.
- Times are `HH:MM:SS` (sometimes `:01` seconds); the proxy trims to `HH:MM`.
- **List endpoints** (`/events/{id}/eventRegistrations`, `/events/{id}/attendees`) page with `currentPage`;
  page size is fixed at 20 (`pageSize` is ignored), so loop on `pagination.totalPages`.
- **Attendees** (`GET /events/{id}/attendees`): `attendeeId, accountId, registrationId, firstName, lastName,
  email, registrationStatus (e.g. SUCCEEDED), markedAttended (boolean), ticketName, ...`.
- **Registrations**: `id, eventId, registrantAccountId, tickets[{ticketId, ticketSequence,
  attendees[{attendeeId, accountId, firstName, lastName, registrationStatus, markedAttended, ...}]}]`.
  So attendance lives per attendee, nested inside a ticket of a registration.
- Org has ~1,200 events in 2026 (many recurring, e.g. "Alexandria Dinner Club"); import by date range.
- Custom event search fields in this org: County of Event, OSG Community, Participant Registration ID,
  Program Hours, Event Category, Event Type, Zoom URL.

## Not yet verified (needs a write test, ask before doing it)
- How to set `markedAttended` (likely `PATCH /eventRegistrations/{id}` with the ticket attendee, or `PUT`).
- Creating a walk-in registration (`POST /eventRegistrations`) and what ticket/payment fields it needs.
- Where volunteer hours live (candidate: custom field `Program Hours`).
- Account search field names (`First Name`, `Last Name`, `Email`, `Account ID`, `Email 1`) used by the proxy.
