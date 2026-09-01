# Quran Quiz Net — اختبار القرآن

[![Tests](https://github.com/tarekeldeeb/quranquiznet/actions/workflows/www-tests.yml/badge.svg)](https://github.com/tarekeldeeb/quranquiznet/actions/workflows/www-tests.yml)
[![Live](https://img.shields.io/badge/live-app.quranquiz.net-0d2d4e)](https://app.quranquiz.net)
[![Version](https://img.shields.io/github/package-json/v/tarekeldeeb/quranquiznet?filename=www%2Fpackage.json&label=version)](www/package.json)
[![Platforms](https://img.shields.io/badge/platform-web%20%7C%20iOS%20%7C%20Android-blue)](#)
[![License](https://img.shields.io/badge/license-GPLv3%20%2F%20Commercial-informational)](#license)

A multiple-choice quiz that tests real Quran memorization (ḥifẓ) — not
familiarity. Questions are generated only from the parts *you've* memorized,
with deliberately confusable ("mutashābiha") wrong answers, so guessing
doesn't work. The UI runs in 16 languages, from Arabic and English to
Bengali, Urdu, Hausa, and Javanese.

![Quiz](https://raw.githubusercontent.com/tarekeldeeb/quranquiznet/master/resources/feature.png)

**[:white_check_mark: Play now — app.quranquiz.net](https://app.quranquiz.net)**

No install, no signup — a full offline-capable PWA. Native iOS and Android
apps are also available:

<p>
<a href="https://apps.apple.com/app/id6790435986"><img alt="Download on the App Store" src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" height="40"></a>
<a href="https://play.google.com/store/apps/details?id=net.quranquiz"><img alt="Get it on Google Play" src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" height="55"></a>
</p>

Still in beta and evolving fast.

## Why it's different

- **Tests recall, not recognition** — every question comes from the real
  Quran text (Tanzil.net Uthmani script), with wrong answers pulled from
  genuinely similar verses/words instead of random noise.
- **Only quizzes what you know** — mark which of 50 study parts you've
  memorized; questions are generated only from those, with scores, streaks,
  and accuracy tracked per part.
- **Ranks & milestones** — a four-tier ladder (مبتدئ → مجتهد → حافظ → متقن)
  with confetti and khatam celebrations as parts move to mastered.
- **Daily quiz, leaderboard & live 1v1 PvP** — a shared quiz rotates every
  24h, plus real-time ghost-race matches against another player or an honest
  bot ("الحافظ") — seed-based, so no question data is ever transmitted.
- **Anonymous by default** — jump in as a guest instantly; sign in with
  Google/Facebook later to back up progress and rank on the leaderboard.
- **16 languages, RTL-first** — a full UI translation set covering Arabic,
  English, Malay, Bengali, Turkish, Urdu, Punjabi (Shahmukhi), Farsi, Hausa,
  Javanese, Pashto, French, Spanish, Indonesian, Chinese, and Swahili.
- **One codebase, three platforms** — Expo Router, running unmodified on
  web, iOS, and Android.

## Build locally

Requires Node.js 22+ and npm.

```bash
git clone https://github.com/tarekeldeeb/quranquiznet.git
cd quranquiznet/www
npm install

# Firebase config — copy the example and fill in your own project's values
# (Firebase Console → Project Settings → Your apps → Web app → Config)
cp .env.example .env

# Local dev server (web) — served at http://localhost:8081
npx expo start --web --port 8081

# Or run on a device/simulator
npx expo start                # then choose iOS / Android
```

Other useful commands (run from `www/`):

```bash
npx tsc --noEmit               # type check
npm test                       # unit tests (Jest, watch mode)
npm run lint                   # ESLint
npx expo export --clear        # production web build → www/dist
firebase deploy --only hosting # deploy the web build
```

The Quran word database (`q.json`, ~78k words, shipped zipped) is generated
from the root of the repo with:

```bash
python db_maker.py             # downloads Tanzil.net Uthmani text → q.json + q.json.zip
```

See [`CLAUDE.md`](CLAUDE.md) for the full command reference, including native
builds, Cloud Functions deployment, and Android/iOS signing notes.

## Architecture

```
quranquiznet/
├── www/                  # Expo SDK 53 + Expo Router v5 app — web, iOS, Android
├── functions/            # Firebase Cloud Functions (daily rotation, cleanup)
├── db_maker.py           # Generates q.json from Tanzil.net
├── q.json                # Quran word database (generated, checked in)
└── database.rules.json   # Realtime Database security rules
```

The client is a single Expo Router app: file-based routes for onboarding,
auth, and the main tab shell (`me` / `quiz` / `league` / `pvp` / `map`), a
Zustand store for the user profile (synced to Firebase RTDB when signed in),
and a seeded-random quiz engine that reads the Quran word DB (SQLite on
native, in-memory JSON on web). Live PvP matches are deterministic — both
clients compute the same question sequence from a shared seed, so only
scores cross the wire. Full breakdown, including the backend and Cloud
Functions, in [`CLAUDE.md`](CLAUDE.md).

## Contributing

Bug reports, translations, quiz-content fixes, and PRs are all welcome.

- Found a bug? Use the [issue template](ISSUE_TEMPLATE.md) (app version,
  anonymous or signed-in, repro steps), or the in-app "report a bad question"
  flow for content issues.
- Sending a PR: fork, branch from `master`, work under `www/`. Before
  opening it, make sure these pass from `www/`:
  ```bash
  npx tsc --noEmit && npm run lint && npm run test:ci
  ```
  CI runs the same checks on every push. Keep `www/.env` and other gitignored
  credentials out of commits.
- See [`CLAUDE.md`](CLAUDE.md) for the deeper architecture/command reference.

## License

Dual-licensed under [GPLv3](LICENSE-GPL3) or a
[commercial license](LICENSE-commercial) for uses incompatible with the
GPL's copyleft terms. See [`LICENSE`](LICENSE) for details.
