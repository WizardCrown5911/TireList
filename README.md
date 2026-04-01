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
- Render free-host deployment config

## How it works

When you ask the app to find images, the server:

1. Searches Wikimedia Commons, Wikipedia, Openverse, and optionally Google Images for candidate images.
2. Uses a local CLIP model via Transformers.js to score the candidate images.
3. Optionally reranks low-confidence matches with Gemini and then Groq if keys are configured.
4. Falls back to metadata ranking if no model path is available.

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

## Free hosting

This repo now includes `render.yaml` for a Render web service deployment. It works with the current Express server and static build output, so you do not need to rewrite the app for serverless hosting.

Recommended Render env for low-cost hosting:

```bash
ENABLE_LOCAL_CLIP=false
GOOGLE_API_KEY=...
GOOGLE_CSE_ID=...
GEMINI_API_KEY=...
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
- Each card now supports an image picker so users can manually choose from ranked candidate results.
- Image matching uses local AI first, then optional hosted fallbacks, then heuristics across the public-source candidate set.
- Lists can be exported to JSON and imported back later with images, tiers, placements, and compact mode preserved.
- On free hosts, set `ENABLE_LOCAL_CLIP=false` if the local model is too heavy or cold starts are slow.
