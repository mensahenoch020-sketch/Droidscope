# DroidScope

DroidScope is a transparent, consent-based Android device testing system. It has a mobile web dashboard and an Android companion. The companion stays visible, records its own activity, and only uploads data the Android owner has explicitly approved.

## Included in v0.1

- Password-protected, iPhone-friendly dashboard
- One-time device enrollment links
- Device information and heartbeat status
- Guided notification-access setup
- New notification previews after access is enabled
- Owner-controlled pause switch for notification sharing
- Owner-selected photo upload using Android's system photo picker
- On-device security checks
- Owner-triggered audit of launchable applications
- Owner-selected JSON message-backup import without replacing the SMS app
- Installable iPhone dashboard (PWA), JSON report export, and data-deletion controls
- AES-256-GCM encryption at rest for dashboard records and selected photos
- Per-device activity history
- Immediate server-side device revocation
- No advertising, subscription locks, fake results, hidden icon, lock bypass, or silent permission approval

## Important Android limits

Android itself displays and owns sensitive permission screens. DroidScope cannot approve them automatically. On modern Android, screen capture requires a fresh system approval for each capture session. Full SMS inbox access is not included; notification access captures only previews Android exposes after permission is granted.

## Run the dashboard

1. Copy `.env.example` values into your hosting environment.
2. Set a long `DROIDSCOPE_ADMIN_PASSWORD` and a permanent random `DROIDSCOPE_DATA_KEY`. Changing the data key later makes previously encrypted records unreadable.
3. Run `npm start`.
4. Open the displayed URL, sign in, and choose **Add device**.

The server uses only Node.js built-in modules. Data is stored locally in `data/state.json`; selected photos are stored in `uploads/`. For production, use HTTPS and persistent storage.

## Build the Android companion

Open the `android` folder in Android Studio, let Gradle sync, and build the `app` module. Before building, set `DEFAULT_SERVER_URL` in `MainActivity.java` to the HTTPS address of your dashboard. Android Studio will produce an APK under `android/app/build/outputs/apk/`.

The phone owner installs the APK, opens it, pastes the one-time enrollment token shown by the dashboard, and taps **Connect device**. After pairing, the numbered buttons walk through Android's required settings.

If the project is pushed to GitHub, the included **Verify and build** workflow tests the server and produces a downloadable debug APK artifact automatically.

## Railway

The included `Dockerfile` and `railway.json` can deploy the dashboard/API. Set all values from `.env.example`, attach persistent storage at `/data`, and generate an HTTPS public domain before building the APK.

## Safe deployment checklist

- Use HTTPS only.
- Keep the dashboard private and use a unique password.
- Do not reuse enrollment tokens; they expire after 15 minutes.
- Revoke devices you no longer test.
- Never install the companion without the phone owner's informed approval.
- Treat notification previews and photos as sensitive personal data.

## Optional message-backup format

The owner can select a JSON file containing up to 500 messages. DroidScope accepts either a JSON array or an object containing a `messages` array:

```json
{
  "messages": [
    { "sender": "Example", "text": "Owner-approved test message", "messageAt": 1788278400000 }
  ]
}
```

This is a manual, visible import. DroidScope does not replace the default SMS app or silently read the SMS database.

## Tests

Run `npm test`.
