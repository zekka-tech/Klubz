# Development Implementation Plan — Completion Items

**Target:** Industry-standard completion of four outstanding items.
**Prerequisite gate:** `npm run verify` must stay green after every item.
**Migration counter:** current last is `0013`; next is `0014`.

---

## Item 1 — Accessibility Completion

### Current state (verified)

| What exists | Where |
|---|---|
| Focus jump to `#app-content` on route change | `app.js:1688–1689` |
| Toast `aria-live="polite" aria-atomic="true"` | `app.js:3325` |
| `aria-label` on `.nav-item` buttons and main header buttons | `app.js:3332–3351` |
| No `@axe-core/playwright` in `package.json` | confirmed |
| No axe test file in `tests/e2e/` | confirmed |
| No focus-trap utility in `app.js` | confirmed |
| No `role="dialog"` / `aria-modal` / ESC pattern on any overlay | confirmed |

### 1-A — Install axe-core

```bash
npm install --save-dev @axe-core/playwright
```

Add to `package.json` devDependencies (no other change needed; Playwright is already installed).

---

### 1-B — Create `tests/e2e/accessibility.spec.ts`

Use the existing `installApiMocks` + `addInitScript` pattern from `app-smoke.spec.ts`.
Import `AxeBuilder` from `@axe-core/playwright`.

**Required axe scans (all WCAG 2.1 AA, zero critical violations):**

| Screen hash | What to assert |
|---|---|
| `#login` | zero `critical` or `serious` violations |
| `#register` | role-tabs semantic markup (see 1-C) |
| `#home` (authenticated) | bottom-nav landmark, quick-action buttons |
| `#find-ride` | form labels, seat-btn group |
| `#offer-ride` | form labels |
| `#my-trips` | trips-tabs ARIA, trip-card buttons |
| `#profile` | profile list ARIA |
| `#settings` | form controls and toggle labels |

Skeleton of each test:
```typescript
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('login screen has no critical violations', async ({ page }) => {
  await page.goto('/#login');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
});
```

Add this file at `tests/e2e/accessibility.spec.ts`. The playwright config at `playwright.config.ts:2` already picks up `tests/e2e/**/*.spec.ts`.

---

### 1-C — Semantic ARIA on role-tabs (register screen)

**File:** `public/static/js/app.js` — `renderRegisterScreen()` function.

The role-tabs container (`#role-tabs`) currently renders plain `.tab` divs. Update the HTML template:

```html
<!-- Before -->
<div id="role-tabs" class="tabs">
  <div class="tab active" data-role="user">Rider</div>
  <div class="tab" data-role="driver">Driver</div>
</div>

<!-- After -->
<div id="role-tabs" class="tabs" role="tablist" aria-label="Account type">
  <button class="tab active" role="tab" aria-selected="true" data-role="user">Rider</button>
  <button class="tab" role="tab" aria-selected="false" data-role="driver">Driver</button>
</div>
```

Update the `bindEvents` click handler for `#role-tabs .tab` (currently `app.js` ~line 1718) to also toggle `aria-selected`:

```javascript
onAll('#role-tabs .tab', 'click', (e) => {
  document.querySelectorAll('#role-tabs .tab').forEach(t => {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
  });
  e.currentTarget.classList.add('active');
  e.currentTarget.setAttribute('aria-selected', 'true');
});
```

---

### 1-D — Focus-trap utility + ESC handler

**File:** `public/static/js/app.js` — add near the top of the utility section.

Any place the app renders a modal overlay (booking confirmation, payment confirmation, rating dialog) must use this pattern. The utility must:

1. Collect all focusable elements inside the container.
2. Redirect Tab / Shift+Tab to cycle within those elements.
3. Listen for Escape to call the provided `onClose` callback.
4. On cleanup, restore focus to the element that was focused before the modal opened.

**Utility signature to implement:**

```javascript
function trapFocus(containerEl, onClose) {
  const focusable = containerEl.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];
  const prior = document.activeElement;

  first?.focus();

  function handleKey(e) {
    if (e.key === 'Escape') { cleanup(); onClose(); return; }
    if (e.key !== 'Tab') return;
    if (focusable.length === 0) { e.preventDefault(); return; }
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last?.focus(); }
    } else {
      if (document.activeElement === last)  { e.preventDefault(); first?.focus(); }
    }
  }

  containerEl.addEventListener('keydown', handleKey);
  function cleanup() {
    containerEl.removeEventListener('keydown', handleKey);
    prior?.focus();
  }
  return cleanup; // caller stores this and calls it on close
}
```

**Required ARIA on any modal container:**
```html
<div role="dialog" aria-modal="true" aria-labelledby="modal-title-id" class="modal">
  <h2 id="modal-title-id">Confirm Booking</h2>
  ...
</div>
```

Apply `trapFocus` to every place the app currently opens an overlay (search the app for `modal`, `overlay`, `confirm`, `dialog`; apply the pattern to each).
Set `aria-hidden="true"` on `#app-content` and `#bottom-nav` while any modal is open; remove on close.

---

### 1-E — Icon-button aria-label audit

Grep `app.js` for `<button` patterns that have an icon child but no visible text and no `aria-label`.
Every such button must have `aria-label`. Confirmed present on: `#notifications-btn`, `.nav-item` buttons, `#profile-avatar-btn`.
Common gaps to check: back buttons, close buttons, seat increment/decrement buttons, map zoom buttons.

---

### Definition of done — Item 1

- `npm run test:e2e` runs `accessibility.spec.ts` with zero critical/serious axe violations on all scanned screens.
- ESC closes any open dialog and returns focus to the trigger element.
- Tab cycling stays within an open modal.
- `npm run verify` passes.

---

## Item 2 — Cron Match Linkage

### Current state (verified)

In `src/lib/cron.ts:129–132`, after a successful match the UPDATE sets only `status` and `updated_at`:

```sql
UPDATE monthly_scheduled_days
SET status = 'matched', updated_at = CURRENT_TIMESTAMP
WHERE id = ?
```

`monthly_scheduled_days.trip_id INTEGER REFERENCES trips(id)` exists (migration `0013`, line 70) but is never written by the cron.

The matched result provides `topMatch.driverTripId` (TEXT UUID, references `driver_trips(id)`). The `driver_trips` table does **not** have a back-reference to the integer `trips(id)`. Therefore a correlation join is required to resolve the INTEGER `trips.id`.

### 2-A — Resolve `trips.id` from `driverTripId`

After `topMatch` is found, query `trips` by matching on `driver_id` and `scheduled_time` proximity to the `driver_trips.departure_time`. The join path is:

```sql
SELECT t.id
FROM   driver_trips dt
JOIN   trips t ON t.driver_id = dt.driver_id
WHERE  dt.id = ?
  AND  ABS(strftime('%s', t.scheduled_time) - (dt.departure_time / 1000)) < 300
  AND  t.status NOT IN ('cancelled', 'completed')
LIMIT  1
```

This correlates within a 5-minute window, consistent with the existing departure-time grace window used elsewhere in the codebase.

If the query returns null (driver_trip has no matching trips row yet — e.g., the offer was created only in driver_trips and not yet confirmed as a main trip), the cron should still write `status = 'matched'` without `trip_id`, logging a warning. **Never block the status update on a failed trip_id lookup.**

### 2-B — Update `src/lib/cron.ts`

Replace the UPDATE block at lines `129–132`:

```typescript
// Before
await db
  .prepare(`UPDATE monthly_scheduled_days SET status = 'matched', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
  .bind(day.id)
  .run();

// After
let resolvedTripId: number | null = null;
try {
  const tripRow = await db
    .prepare(
      `SELECT t.id
       FROM   driver_trips dt
       JOIN   trips t ON t.driver_id = dt.driver_id
       WHERE  dt.id = ?
         AND  ABS(strftime('%s', t.scheduled_time) - (dt.departure_time / 1000)) < 300
         AND  t.status NOT IN ('cancelled','completed')
       LIMIT  1`
    )
    .bind(topMatch.driverTripId)
    .first<{ id: number }>();
  resolvedTripId = tripRow?.id ?? null;
} catch {
  logger.warn('batchMatchSubscriptionDays: trip_id resolution failed', { dayId: day.id });
}

await db
  .prepare(
    `UPDATE monthly_scheduled_days
     SET    status = 'matched',
            trip_id = ?,
            updated_at = CURRENT_TIMESTAMP
     WHERE  id = ?`
  )
  .bind(resolvedTripId, day.id)
  .run();
```

No migration is required; `trip_id` already exists in the schema (migration 0013, line 70).

### Definition of done — Item 2

- `trip_id` on `monthly_scheduled_days` is non-null after a successful cron match when a corresponding `trips` row exists.
- Cron does not error when `trip_id` cannot be resolved; it logs a warning and still marks the day as `matched`.
- `npm run verify` passes.

---

## Item 3 — Cron Test Coverage

### Current state (verified)

No file matching `cron` exists under `tests/`. `batchMatchSubscriptionDays` and `sendTripReminders` have no integration tests. The MockDB/MockKV helpers used by other integration test files are defined inline and can be replicated.

### 3-A — Create `tests/integration/cron-flows.test.ts`

The test file must directly import and call the exported cron functions (not go through HTTP), using a MockDB/MockKV that matches the pattern in `roadmap-contracts.test.ts`.

**Required test cases:**

#### `batchMatchSubscriptionDays`

| Test | Setup | Assert |
|---|---|---|
| Returns early when DB is undefined | `env.DB = undefined` | Function resolves without throwing |
| Skips days when query returns empty | MockDB returns `{ results: [] }` for the scheduled-days query | No `.run()` calls |
| Skips days with null coordinates | Day row has `pickup_lat: null` | status UPDATE to `requested` fires; no match attempted |
| Skips days with invalid departure_time | Day row has `departure_time: 'XX:YY'` | Warning logged; status stays `requested` |
| Calls saveMatchResult and updates status to matched | MockDB returns 1 day + 1 candidate driver; `matchRiderToDrivers` returns a top match | UPDATE SQL contains `status = 'matched'` |
| Persists resolved trip_id when trips row found | Correlation query returns `{ id: 42 }` | UPDATE bind args include `42` |
| Sets trip_id to null when correlation returns nothing | Correlation query returns null | UPDATE bind args include `null` |
| Does not re-process days already in requested status | Initial query WHERE filters `status = 'scheduled'` | Verified by only seeding `status = 'scheduled'` rows |

#### `sendTripReminders`

| Test | Setup | Assert |
|---|---|---|
| Returns early when DB is undefined | `env.DB = undefined` | Resolves silently |
| Returns early when CACHE KV is undefined | DB present but `env.CACHE = undefined` | Resolves silently |
| Does nothing when no trips fall in window | Trips query returns `{ results: [] }` | No KV puts, no notification calls |
| Skips trip already in CACHE (dedup) | MockKV pre-seeded with `reminder:{window}:{tripId}` | Email/push send NOT called |
| Sends email and sets CACHE key for unseen trip | KV get returns null; DB returns 1 rider row | NotificationService mock called once; KV put called once |
| Works for both `24h` and `1h` windows | Separate test for each value | CACHE key prefix matches window |

**MockDB note:** The correlation query in Item 2 uses a JOIN. The MockDB resolver must match on `FROM driver_trips dt JOIN trips t` (substring match) to return the stubbed `trips.id`.

**MockNotificationService:** `vi.mock('../../../src/integrations/notifications')` or pass a spy into the function. Check which injection pattern is used in `cron.ts` — if `NotificationService` is instantiated inline, use `vi.spyOn`.

### Definition of done — Item 3

- `npx vitest run tests/integration/cron-flows.test.ts` passes all cases.
- `npm run verify` passes.
- Coverage includes at least the 14 cases listed above.

---

## Item 4 — Final Real-Provider Staging Validation

### Scope

This item is **operational** (no new code). It validates that the already-implemented routes work end-to-end against live third-party services on the `klubz-staging.pages.dev` deployment.

### 4-A — Secrets to set on staging

Run these before the validation session (staging already has `JWT_SECRET` and `ENCRYPTION_KEY`):

```bash
# Apple OAuth
wrangler pages secret put APPLE_CLIENT_ID  --project-name klubz-staging
wrangler pages secret put APPLE_TEAM_ID    --project-name klubz-staging
wrangler pages secret put APPLE_KEY_ID     --project-name klubz-staging
wrangler pages secret put APPLE_PRIVATE_KEY --project-name klubz-staging

# Push notifications (VAPID)
wrangler pages secret put VAPID_PUBLIC_KEY  --project-name klubz-staging
wrangler pages secret put VAPID_PRIVATE_KEY --project-name klubz-staging

# Email
wrangler pages secret put SENDGRID_API_KEY --project-name klubz-staging

# Google OAuth (already implemented, verify staging has it)
wrangler pages secret put GOOGLE_CLIENT_ID     --project-name klubz-staging
wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name klubz-staging
```

R2 (`klubz-storage-prod`) is already bound in `wrangler.jsonc`; no action needed.

### 4-B — Apple OAuth validation steps

Requirements: Apple Developer account, a registered App ID with Sign In with Apple enabled, and a Services ID whose redirect URI is set to `https://klubz-staging.pages.dev/api/auth/apple/callback`.

1. Open `https://klubz-staging.pages.dev/#login` on Safari (desktop or iOS — Apple enforces popup on non-Safari).
2. Click "Continue with Apple" → Apple login page opens.
3. Authenticate with an Apple ID → browser redirects to `/api/auth/apple/callback` with `form_post`.
4. Verify redirect to `/?oauth_code=<uuid>#login`.
5. Verify the JS exchanges the code via `GET /api/auth/oauth-session?code=<uuid>` and the user lands on `#home`.
6. Check D1 staging: `SELECT * FROM users WHERE oauth_provider = 'apple' ORDER BY created_at DESC LIMIT 1` — expect a row with `email_verified = 1`.
7. Confirm `audit_logs` has a `USER_LOGIN` entry for the session.

**Edge case:** Apple sends `user` JSON (name) only on first authorization. Ensure the `handleAppleOAuthCallback` path for new users correctly parses `payload.user` (JSON string field from the form POST body) and stores first/last name via encryption.

### 4-C — Push notification validation steps

Requirements: VAPID key pair generated via `npx web-push generate-vapid-keys`. `VAPID_PUBLIC_KEY` must match the key stored in `public/static/js/app.js` (or `CONFIG.VAPID_PUBLIC_KEY`) for subscription creation.

1. Open staging on Chrome (desktop) in a non-incognito window.
2. Log in, grant notification permission when prompted.
3. Confirm `POST /api/users/push-subscription` returns `200` (check DevTools Network).
4. Trigger a 1-hour reminder: manually insert a trip scheduled 1 hour from now into staging D1 with an accepted rider, then POST to the staging cron endpoint or wait for the scheduled cron.
5. Verify the push notification is received in the browser.
6. Check `audit_logs` for a `NOTIFICATION_SENT` event.

### 4-D — Email (SendGrid) validation steps

1. Register a new test account on staging.
2. Verify the verification email arrives (SendGrid Activity Feed → confirm delivery, opens).
3. Click the link → app redirects to `/?verified=1#login`.
4. Request a password reset → confirm reset email arrives.
5. Use the reset link within its 1-hour TTL; confirm password change works.

### 4-E — R2 document upload validation

1. Log in as a driver-role staging user.
2. Navigate to `#driver-docs`.
3. Upload a PDF document.
4. Confirm `GET /api/users/documents` lists the document.
5. Open Cloudflare dashboard → R2 → `klubz-storage-prod` → verify the key `users/<id>/docs/<filename>` exists with correct content-type.

### 4-F — Known staging constraint

Staging shares the same D1 database and KV namespaces as production (bound via `wrangler.jsonc`). Perform all staging validation with test accounts whose emails are clearly marked (e.g., `+staging` email alias) to avoid polluting production data. After validation, soft-delete or disable test accounts via the admin API.

### Definition of done — Item 4

- [ ] Apple OAuth: full sign-in flow completes; user row created in D1.
- [ ] Push: at least one push notification delivered end-to-end.
- [ ] Email: registration verification + password reset emails confirmed delivered via SendGrid activity.
- [ ] R2: document upload verified in Cloudflare dashboard.
- [ ] No 500 errors or unhandled exceptions in Cloudflare Workers logs during any of the above.
- [ ] All provider secrets removed from local shell history (`history -c` or equivalent).

---

## Execution Order

```
Item 2 (cron linkage) → Item 3 (cron tests) → Item 1 (accessibility) → Item 4 (staging ops)
```

Items 2 and 3 are tightly coupled (test the linkage you just wrote). Item 1 is independent. Item 4 is last because it requires live credentials that should never touch the dev environment.

## Regression gate

After each item, run:

```bash
npm run verify   # type-check + lint + vitest + build
npm run test:e2e # after Item 1 only
```

CI must pass the full gate (`verify:ci`) before merging any PR.
