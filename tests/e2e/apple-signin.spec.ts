import { expect, test } from '@playwright/test';

const isEnabled = process.env.APPLE_OAUTH_E2E === '1';
const baseUrl = process.env.APPLE_OAUTH_E2E_BASE_URL || 'https://klubz-staging.pages.dev';

test.describe('Apple OAuth staging e2e', () => {
  test.skip(!isEnabled, 'Set APPLE_OAUTH_E2E=1 and APPLE_OAUTH_E2E_BASE_URL to run this suite.');

  test('apple auth endpoint redirects to Apple authorize URL', async ({ request }) => {
    const response = await request.get(`${baseUrl}/api/auth/apple`, { maxRedirects: 0 });

    expect([301, 302, 303, 307, 308]).toContain(response.status());

    const location = response.headers()['location'] || '';
    expect(location).toContain('https://appleid.apple.com/auth/authorize');
    expect(location).toContain('state=');
    expect(location).toContain('client_id=');
    expect(location).toContain('response_mode=form_post');
  });
});
