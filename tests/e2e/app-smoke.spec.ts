import { test, expect, type Page, type Route } from '@playwright/test';

const baseUser = {
  id: 1,
  name: 'QA Driver',
  email: 'qa.driver@klubz.test',
  role: 'driver',
  mfaEnabled: false,
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installApiMocks(page: Page) {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === '/api/users/1' && method === 'GET') {
      return fulfillJson(route, {
        id: 1,
        stats: { totalTrips: 12, rating: 4.8, carbonSaved: 31.2, completedTrips: 9 },
      });
    }

    if (path === '/api/users/profile' && method === 'GET') {
      return fulfillJson(route, {
        ...baseUser,
        tosVersionAccepted: '1.0',
      });
    }

    if (path === '/api/users/trips' && method === 'GET') {
      const status = url.searchParams.get('status');
      if (status === 'completed') {
        return fulfillJson(route, {
          trips: [
            {
              id: 21,
              driverName: 'Driver One',
              driverRating: 4.9,
              pickup: 'A',
              dropoff: 'B',
              scheduledTime: new Date().toISOString(),
              availableSeats: 1,
              carbonSaved: 1.2,
              status: 'completed',
              participantRole: 'rider',
              price: 35,
            },
          ],
        });
      }

      return fulfillJson(route, {
        trips: [
          {
            id: 11,
            driverName: 'Driver One',
            driverRating: 4.9,
            pickup: 'A',
            dropoff: 'B',
            scheduledTime: new Date().toISOString(),
            availableSeats: 3,
            carbonSaved: 2.1,
            status: 'scheduled',
            price: 35,
          },
        ],
      });
    }

    if (path === '/api/subscriptions/current' && method === 'GET') {
      return fulfillJson(route, { subscription: null });
    }

    if (path === '/api/auth/mfa/setup' && method === 'POST') {
      return fulfillJson(route, {
        qrCodeUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgS89WwAAAABJRU5ErkJggg==',
        secret: 'ABCDEF123456',
        backupCodes: ['CODE-1111', 'CODE-2222'],
      });
    }

    if (path === '/api/users/documents' && method === 'GET') {
      return fulfillJson(route, { documents: [] });
    }

    if (path === '/api/users/earnings' && method === 'GET') {
      return fulfillJson(route, {
        summary: { totalEarnings: 1200, totalTrips: 20, avgPerTrip: 60 },
        months: [{ month: '2026-02', trip_count: 6, estimated_earnings: 360 }],
      });
    }

    if (path === '/api/users/referral' && method === 'GET') {
      return fulfillJson(route, { code: 'REF12345', usesCount: 0 });
    }

    if (path === '/api/users/points' && method === 'GET') {
      return fulfillJson(route, { balance: 240, history: [] });
    }

    if (path === '/api/organizations/current' && method === 'GET') {
      return fulfillJson(route, { organization: null });
    }

    if (path === '/api/disputes' && method === 'POST') {
      return fulfillJson(route, { disputeId: 101 }, 201);
    }

    if (path === '/api/promo-codes/validate' && method === 'GET') {
      return fulfillJson(route, {
        isValid: true,
        discountType: 'percent',
        discountValue: 10,
        minFareCents: 0,
      });
    }

    if (path === '/api/referrals/redeem' && method === 'POST') {
      return fulfillJson(route, { success: true, pointsAwarded: 200 });
    }

    return fulfillJson(route, {});
  });
}

test.describe('Public Auth Navigation', () => {
  test('login/register/forgot links route correctly', async ({ page }) => {
    await page.goto('/#login');

    await expect(page.locator('#login-form')).toBeVisible();

    await page.locator('#link-to-register').click();
    await expect(page).toHaveURL(/#register$/);
    await expect(page.locator('#register-form')).toBeVisible();

    await page.locator('#link-to-login').click();
    await expect(page).toHaveURL(/#login$/);

    await page.locator('#link-to-forgot').click();
    await expect(page).toHaveURL(/#forgot-password$/);
    await expect(page.locator('#forgot-form')).toBeVisible();

    await page.locator('#link-forgot-to-login').click();
    await expect(page).toHaveURL(/#login$/);
  });
});

test.describe('Authenticated App Shell Flows', () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);

    await page.setViewportSize({ width: 390, height: 844 });

    await page.addInitScript((user) => {
      localStorage.setItem('klubz_access_token', 'test-access-token');
      localStorage.setItem('klubz_refresh_token', 'test-refresh-token');
      localStorage.setItem('klubz_user', JSON.stringify(user));

      // Keep tests deterministic and avoid permission prompts/network retries.
      if ('Notification' in window) {
        Object.defineProperty(Notification, 'permission', { value: 'denied', configurable: true });
        Notification.requestPermission = async () => 'denied';
      }

      // Avoid EventSource network churn in tests.
      class MockEventSource {
        close() {}
      }
      // @ts-expect-error test shim
      window.EventSource = MockEventSource;
    }, baseUser);

    await page.goto('/#home');
    await expect(page.locator('#app-header')).toBeVisible();
    await expect(page.locator('#bottom-nav')).toBeVisible();
  });

  test('bottom nav and home quick actions navigate to target screens', async ({ page }) => {
    await page.locator('.quick-action[data-action="find-ride"]').click();
    await expect(page).toHaveURL(/#find-ride$/);
    await expect(page.locator('#find-ride-form')).toBeVisible();

    await page.locator('#find-monthly-btn').click();
    await expect(page).toHaveURL(/#subscription$/);
    await expect(page.locator('#sub-form')).toBeVisible();

    await page.locator('#bottom-nav [data-screen="offer-ride"]').click();
    await expect(page).toHaveURL(/#offer-ride$/);
    await expect(page.locator('#offer-ride-form')).toBeVisible();

    await page.locator('#bottom-nav [data-screen="my-trips"]').click();
    await expect(page).toHaveURL(/#my-trips$/);
    await expect(page.locator('#trips-tabs')).toBeVisible();

    await page.locator('#trips-tabs .tab[data-tab="completed"]').click();
    await expect(page.locator('#trips-list .trip-card')).toHaveCount(1);

    await page.locator('#bottom-nav [data-screen="home"]').click();
    await expect(page).toHaveURL(/#home$/);

    await page.locator('#notifications-btn').click();
    await expect(page.locator('#toast-container .toast')).toHaveCount(1);
  });

  test('profile links, settings and back buttons are wired', async ({ page }) => {
    await page.locator('#bottom-nav [data-screen="profile"]').click();
    await expect(page).toHaveURL(/#profile$/);

    await page.locator('#profile-settings-item').click();
    await expect(page).toHaveURL(/#settings$/);
    await expect(page.locator('#settings-back-btn')).toBeVisible();

    await page.locator('#settings-mfa-enable-btn').click();
    await expect(page).toHaveURL(/#mfa-setup$/);
    await expect(page.locator('#mfa-confirm-form')).toBeVisible();

    await page.locator('#mfa-setup-cancel-btn').click();
    await expect(page).toHaveURL(/#settings$/);

    await page.locator('#settings-back-btn').click();
    await expect(page).toHaveURL(/#profile$/);

    await page.locator('#profile-docs-item').click();
    await expect(page).toHaveURL(/#driver-docs$/);
    await page.locator('#driver-docs-back-btn').click();
    await expect(page).toHaveURL(/#profile$/);

    await page.locator('#profile-earnings-item').click();
    await expect(page).toHaveURL(/#driver-earnings$/);
    await page.locator('#driver-earnings-back-btn').click();

    await page.locator('#profile-referral-item').click();
    await expect(page).toHaveURL(/#referral$/);
    await page.locator('#referral-back-btn').click();

    await page.locator('#profile-org-item').click();
    await expect(page).toHaveURL(/#organization$/);
    await page.locator('#organization-back-btn').click();

    await expect(page).toHaveURL(/#profile$/);
  });
});
