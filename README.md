# Forge Tierlist

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/WizardCrown5911/TireList)

A full-stack tier-list builder with:

- drag-and-drop ranking lanes
- editable tier labels and colors
- bulk item import
- list save/import as JSON
- per-card or bulk image lookup
- image picker with multiple candidate choices
- source selection including Google Images
- local AI image ranking
- optional Gemini and Groq reranking
- PNG export
- Google sign-in dashboard for cloud-saved tier lists
- favorites and sorting for saved lists
- optional AdSense banner and rail placements
- Render free-host deployment config

## How it works

When you ask the app to find images, the server:

1. Searches Wikimedia Commons, Wikipedia, Openverse, and optionally Google Images for candidate images.
2. Uses a local CLIP model via Transformers.js to score the candidate images.
3. Optionally reranks low-confidence matches with Gemini and then Groq if keys are configured.
4. Falls back to metadata ranking if no model path is available.

When you sign in with Google, the browser uses Firebase Authentication and Firestore to save tier list snapshots under your user ID.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env` and fill in any optional hosted fallback keys you want:

```bash
PORT=3001
ENABLE_LOCAL_CLIP=true
GOOGLE_API_KEY=
GOOGLE_CSE_ID=
GOOGLE_GL=us
GOOGLE_HL=en
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
GROQ_API_KEY=
GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_ADSENSE_CLIENT=
VITE_ADSENSE_TOP_SLOT=
VITE_ADSENSE_SIDEBAR_SLOT=
VITE_ADSENSE_DASHBOARD_SLOT=
```

3. Start the app:

```bash
npm run dev
```

The Vite client runs on `http://localhost:5173` and proxies API calls to the local Express server on `http://localhost:3001`.

## Google Images setup

To enable Google Images in the `Image APIs` dropdown:

1. Use an existing Google Programmable Search Engine that searches the web for images.
2. Use a Google API key that already has access to the Custom Search JSON API.
3. Set `GOOGLE_API_KEY` and `GOOGLE_CSE_ID` in `.env`.

`GOOGLE_GL` and `GOOGLE_HL` are optional country/language hints for Google results.

As of February 18, 2026, Google's official docs say the Custom Search JSON API is closed to new customers and existing customers have until January 1, 2027 to transition, so this Google source is best understood as an optional compatibility path for accounts that already have access.

## Google sign-in dashboard setup

The Dashboard page is optional. It appears in the app even without Firebase, but sign-in and cloud saves unlock after you add Firebase configuration.

1. Create a Firebase project.
2. Add a Web app in Firebase project settings.
3. Enable Authentication with the Google provider.
4. Create a Firestore database.
5. Add your local and hosted domains to Firebase Authentication authorized domains.
6. Set the `VITE_FIREBASE_*` variables from the Firebase web app config.

Use Firestore rules like this so users can only read and write their own tier lists:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /userEntitlements/{userId} {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow write: if false;
    }

    match /users/{userId}/tierLists/{listId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

Cloud saves store the tier list snapshot in Firestore. Generated text images are compacted and rebuilt when a list opens; very large custom uploaded images may still make a list too large for Firestore, so export JSON for upload-heavy lists.

### Ad-free users

You can mark specific signed-in users as ad-free with a Firestore document:

1. Open Firestore in Firebase Console.
2. Create a document in the `userEntitlements` collection.
3. Use the user's Firebase Auth UID as the document ID.
4. Add a boolean field named `adFree` and set it to `true`.

After that user signs in, the app hides the top banner, sidebar ad, and dashboard ad for that account.

## AdSense setup

AdSense is optional and only renders if you set the `VITE_ADSENSE_*` variables.

1. Create or use an AdSense account and get your publisher ID in the form `ca-pub-...`.
2. Create ad units for:
   - the top banner
   - the sidebar rail
   - the dashboard banner
3. Set:
   - `VITE_ADSENSE_CLIENT`
   - `VITE_ADSENSE_TOP_SLOT`
   - `VITE_ADSENSE_SIDEBAR_SLOT`
   - `VITE_ADSENSE_DASHBOARD_SLOT`
4. Put your publisher line in [ads.txt](public/ads.txt) and replace `pub-XXXXXXXXXXXXXXXX` with your real publisher ID.
5. Redeploy the site.

The app loads the AdSense script only when a client ID is configured and keeps ads outside the draggable tier board so the builder layout stays usable.

## Free hosting

This repo now includes `render.yaml` for a Render web service deployment. It works with the current Express server and static build output, so you do not need to rewrite the app for serverless hosting.

Recommended Render env for low-cost hosting:

```bash
ENABLE_LOCAL_CLIP=false
GOOGLE_API_KEY=...
GOOGLE_CSE_ID=...
GEMINI_API_KEY=...
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_APP_ID=...
VITE_ADSENSE_CLIENT=ca-pub-...
VITE_ADSENSE_TOP_SLOT=...
VITE_ADSENSE_SIDEBAR_SLOT=...
VITE_ADSENSE_DASHBOARD_SLOT=...
```

Disabling local CLIP on a free host avoids repeated model downloads on cold starts and keeps the app usable with Google Images plus Gemini/Groq or heuristic fallback.

## Scripts

- `npm run dev` starts the client and server together
- `npm run build` type-checks and builds the frontend
- `npm run lint` runs ESLint
- `npm run start` serves the built app from the Express server

## Import format

Paste one item per line. For ambiguous names, use:

```text
Mario | Nintendo mascot
The Thing | 1982 horror film
Mercury | planet
```

That extra context is included in the image search request.

## Notes

- No paid AI API is required.
- The first run downloads the local model and caches it in `.cache/transformers`.
- Google Images is optional and requires `GOOGLE_API_KEY` plus `GOOGLE_CSE_ID`.
- Gemini and Groq are optional hosted fallbacks for tougher matches. Their free tiers and rate limits can change over time.
- PNG export may fail for some third-party remote images if the source blocks canvas use via CORS.
- PNG export captures only the tier board, not the floating pool.
- AdSense placements sit below the hero, in the sidebar rail, and in the dashboard instead of inside draggable tier rows.
- The dashboard can save, reopen, favorite, delete, and sort tier lists after Firebase Google sign-in is configured.
- Each card now supports an image picker so users can manually choose from ranked candidate results.
- Image matching uses local AI first, then optional hosted fallbacks, then heuristics across the public-source candidate set.
- Lists can be exported to JSON and imported back later with images, tiers, placements, and compact mode preserved.
- On free hosts, set `ENABLE_LOCAL_CLIP=false` if the local model is too heavy or cold starts are slow.
