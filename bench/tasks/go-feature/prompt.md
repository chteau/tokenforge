Users want to schedule reminders for themselves, and they don't want them arriving in the middle of the night. Add scheduled notifications with per-user quiet hours, idempotent scheduling, and a dispatcher that delivers due notifications with bounded retries.

All new endpoints require a bearer token (`401` otherwise) and use the existing JSON error envelope and status-code conventions. Validation failures get `422` with error code `validation_failed` and one entry per offending field in `fields`, using the field names given below.

## 1. Notification preferences

`GET /v1/me/notification-preferences` returns the caller's preferences:

```json
{ "timezone": "America/New_York", "quiet_hours": { "start": "22:00", "end": "07:00" } }
```

A user who never saved preferences gets `{"timezone": "UTC", "quiet_hours": null}`.

`PUT /v1/me/notification-preferences` replaces the caller's preferences, using the same body shape, and returns `200` with the stored preferences. `quiet_hours` may be `null` (or omitted) to turn quiet hours off.

- `timezone` must be a valid IANA time zone name, such as `Europe/Paris` (field `timezone`).
- `quiet_hours.start` and `quiet_hours.end` must be 24-hour `HH:MM` times between `00:00` and `23:59` (fields `quiet_hours.start` and `quiet_hours.end`). They must differ from each other; report that error on `quiet_hours.end`.
- An invalid request stores nothing.

Quiet hours are a daily window in the user's own time zone, including daylight-saving changes. `start` is inclusive and `end` is exclusive. If `start` is later than `end`, the window wraps around midnight: `22:00`–`07:00` means 22:00 to 06:59.

## 2. Scheduling

`POST /v1/notifications` schedules a notification for the caller:

```json
{ "channel": "email", "subject": "Renewal", "body": "Your plan renews tomorrow", "send_at": "2026-07-02T09:30:00+02:00" }
```

- `channel` is `email` or `sms`. An e-mail goes to the user's account e-mail address; an SMS goes to the user's profile phone number.
- `subject` is required for `email` and can be at most 200 characters. It is optional for `sms`.
- `body` is required and can be at most 2000 characters.
- `send_at` is an RFC 3339 timestamp. It must not be earlier than the current time and must be at most 30 days after it (both bounds inclusive).
- Scheduling an `sms` when the user has no phone number on file is a validation error on field `channel`.

It returns **201 Created** with the notification:

```json
{
  "id": "ntf_...",
  "user_id": "usr_...",
  "channel": "email",
  "subject": "Renewal",
  "body": "Your plan renews tomorrow",
  "send_at": "2026-07-02T07:30:00Z",
  "status": "pending",
  "attempts": 0,
  "created_at": "2026-07-01T12:00:00Z"
}
```

All timestamps are returned in UTC. `status` is one of `pending`, `sent` or `failed`. `attempts` counts delivery attempts. A `sent_at` timestamp is included once the notification has been sent; before that it is `null` or absent.

`GET /v1/notifications/{id}` returns one notification. It is visible only to its owner. Anyone else, and any unknown ID, gets `404` with error code `notification_not_found`.

### Idempotency

Clients may send an `Idempotency-Key` header (at most 128 characters) with `POST /v1/notifications`. Keys are scoped per user.

- If the same user repeats a request with the same key and the same payload, the API returns **200** with the originally created notification and creates nothing new. The payload counts as the same when `channel`, `subject` and `body` are equal and `send_at` is the same instant, even if it is written with a different UTC offset. A repeat is answered from the stored notification even after its `send_at` has passed.
- If the key was already used with a different payload, the API returns `409` with error code `idempotency_key_reused`.
- A rejected request (any 4xx) does not consume its key.
- Concurrent requests with the same key must create exactly one notification. One request gets `201` and the others get `200` with the same notification.
- Requests without the header are never deduplicated.

## 3. Dispatching

`POST /v1/admin/notifications/dispatch` is for admins only (`403` for every other role). It runs one dispatch pass synchronously at the current time and returns:

```json
{ "sent": 1, "retried": 0, "failed": 0, "deferred": 0 }
```

A dispatch pass looks at every `pending` notification that is due, meaning its `send_at` (or, after a failure, its next retry time) is at or before now. It processes them in `send_at` order, earliest first:

- **Quiet hours.** If now falls inside the recipient's quiet hours, evaluated with the preferences they have at dispatch time, the notification is not attempted. It stays `pending`, its `attempts` count does not change, and it counts as `deferred`. It will be delivered by the first pass after the quiet window ends.
- **Delivery.** Otherwise, deliver it through the existing e-mail/SMS sender abstractions and increment `attempts`.
  - On success, set `status` to `sent` and `sent_at` to now. It counts as `sent`.
  - On failure, there are at most 3 attempts in total. After the 1st failed attempt the next retry is due 1 minute later, and after the 2nd it is due 2 minutes later. Each of these counts as `retried`. When the 3rd attempt fails, `status` becomes `failed` and it counts as `failed`. Failed notifications are never attempted again.
- A notification must never be delivered twice, even if several dispatch passes run at the same time.

The running server must also run a dispatch pass automatically every 30 seconds.

All time-dependent behaviour must be deterministic under test, so follow the codebase's existing conventions for obtaining the current time. Follow the existing architecture for routing, authentication, services, persistence and wiring. Add tests, and document the new endpoints.
