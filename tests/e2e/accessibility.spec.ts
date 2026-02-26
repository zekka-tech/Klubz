import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

test.setTimeout(120_000);

const axeTags = ['wcag2a', 'wcag2aa'];

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
              id: 22,
              driverName: 'Driver One',
              driverRating: 4.8,
              pickup: 'A',
              dropoff: 'B',
              scheduledTime: new Date().toISOString(),
              availableSeats: 1,
              carbonSaved: 1.2,
              status: 'completed',
              participantRole: 'rider',
              price: 35,
              rating: null,
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

    return fulfillJson(route, {});
  });
}

async function assertNoCriticalOrSeriousViolations(page: Page, screen: string) {
  const results = await new AxeBuilder({ page }).withTags(axeTags).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');

  const detail = blocking
    .map((v) => {
      const targets = v.nodes
        .flatMap((n) => n.target)
        .slice(0, 3)
        .join(', ');
      return `[${v.impact}] ${v.id}: ${v.description} — targets: ${targets}`;
    })
    .join('\n  ');

  expect(
    blocking,
    `${screen} has ${blocking.length} blocking violation(s):\n  ${detail}`,
  ).toHaveLength(0);
}

test.describe('Accessibility - Public Screens', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('login screen has no critical/serious axe violations', async ({ page }) => {
    await page.goto('/#login');
    await expect(page.locator('#login-form')).toBeVisible();
    await assertNoCriticalOrSeriousViolations(page, 'login');
  });

  test('register screen has no critical/serious axe violations', async ({ page }) => {
    await page.goto('/#register');
    await expect(page.locator('#register-form')).toBeVisible();
    await assertNoCriticalOrSeriousViolations(page, 'register');
  });
});

test.describe('Accessibility - Authenticated Screens', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installApiMocks(page);
    await page.addInitScript((user) => {
      localStorage.setItem('klubz_access_token', 'test-access-token');
      localStorage.setItem('klubz_refresh_token', 'test-refresh-token');
      localStorage.setItem('klubz_user', JSON.stringify(user));

      if ('Notification' in window) {
        Object.defineProperty(Notification, 'permission', { value: 'denied', configurable: true });
        Notification.requestPermission = async () => 'denied';
      }

      class MockEventSource {
        close() {}
      }
      // @ts-expect-error test shim
      window.EventSource = MockEventSource;
    }, baseUser);
  });

  test('home screen has no critical/serious axe violations', async ({ page }) => {
    await page.goto('/#home');
    await expect(page.locator('.quick-actions')).toBeVisible();
    await assertNoCriticalOrSeriousViolations(page, 'home');
  });

  test('find-ride screen has no critical/serious axe violations', async ({ page }) => {
    await page.goto('/#find-ride');
    await expect(page.locator('#find-ride-form')).toBeVisible();
    await assertNoCriticalOrSeriousViolations(page, 'find-ride');
  });

  test('offer-ride screen has no critical/serious axe violations', async ({ page }) => {
    await page.goto('/#offer-ride');
    await expect(page.locator('#offer-ride-form')).toBeVisible();
    await assertNoCriticalOrSeriousViolations(page, 'offer-ride');
  });

  test('my-trips screen has no critical/serious axe violations', async ({ page }) => {
    await page.goto('/#my-trips');
    await expect(page.locator('#trips-tabs')).toBeVisible();
    await assertNoCriticalOrSeriousViolations(page, 'my-trips');
  });

  test('profile screen has no critical/serious axe violations', async ({ page }) => {
    await page.goto('/#profile');
    await expect(page.locator('#profile-stats')).toBeVisible();
    await assertNoCriticalOrSeriousViolations(page, 'profile');
  });

  test('settings screen has no critical/serious axe violations', async ({ page }) => {
    await page.goto('/#settings');
    await expect(page.locator('#settings-back-btn')).toBeVisible();
    await assertNoCriticalOrSeriousViolations(page, 'settings');
  });

  test('icon-only buttons include accessible labels across key screens', async ({ page }) => {
    await page.goto('/#settings');
    await expect(page.locator('button.icon-btn')).toHaveAttribute('aria-label', /.+/);

    await page.goto('/#profile');
    await page.locator('#profile-docs-item').click();
    await expect(page.locator('button.icon-btn')).toHaveAttribute('aria-label', /.+/);

    await page.goto('/#profile');
    await page.locator('#profile-earnings-item').click();
    await expect(page.locator('button.icon-btn')).toHaveAttribute('aria-label', /.+/);
  });

  test('rating dialog exposes accessible radiogroup semantics', async ({ page }) => {
    await page.goto('/#my-trips');
    await page.locator('#trips-tabs .tab[data-tab=\"completed\"]').click();
    await page.locator('.trip-rate-btn').click();

    const group = page.locator('#rating-stars[role=\"radiogroup\"]');
    await expect(group).toHaveAttribute('aria-labelledby', 'rating-stars-label');
    await expect(group).toHaveAttribute('aria-describedby', 'rating-stars-hint');
    await expect(page.locator('.rating-star-btn[role=\"radio\"]')).toHaveCount(5);
  });
});

test.describe('Accessibility - Public Screens (extended)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('forgot-password screen has no critical/serious axe violations', async ({ page }) => {
    await page.goto('/#forgot-password');
    // Wait for the screen to stabilise — accept either a form or the back button
    await page.waitForFunction(
      () =>
        document.querySelector('#forgot-password-form') !== null ||
        document.querySelector('button[data-nav="login"]') !== null ||
        document.querySelector('input[type="email"]') !== null,
      { timeout: 10_000 },
    );
    await assertNoCriticalOrSeriousViolations(page, 'forgot-password');
  });
});
