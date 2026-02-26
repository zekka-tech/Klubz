# TWA Release: Digital Asset Links Fingerprint Setup

Use this checklist before shipping the Android Trusted Web Activity (TWA).

## 1. Get the Play signing certificate fingerprint

After uploading your signed APK/AAB to Google Play Console:

1. Open **Play Console → App Integrity**.
2. Under **App signing key certificate**, copy the **SHA-256 fingerprint**.

## 2. Optional local fingerprint extraction

If you need to inspect a local build artifact:

```bash
keytool -printcert -jarfile release.apk | grep SHA256
```

## 3. Update asset links file

Edit `public/.well-known/assetlinks.json` and replace:

`REPLACE_WITH_PLAY_STORE_SHA256_CERT_FINGERPRINT`

with the real certificate fingerprint in colon-separated uppercase hex format.

## 4. Deploy and validate file delivery

```bash
npm run check:assetlinks

# then deploy
curl https://klubz-production.pages.dev/.well-known/assetlinks.json
```

Confirm the response includes your real SHA-256 fingerprint.

## 5. Validate with Google's Digital Asset Links API

```bash
curl "https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://klubz-production.pages.dev&relation=delegate_permission/common.handle_all_urls"
```

Confirm the response returns a valid statement for package `com.klubz.app`.
