# Networkversity Final Exam

A timed online exam for the FHG Concept [Networkversity course](https://fhgconcept.coursify.me/courses/networkversity).
Students sign in with their name, take a 100-question exam and download a certificate if they pass.
Admins manage the question bank and see results from a password-protected panel.

- **Student exam:** `/`
- **Admin panel:** `/admin`

## Features

| | |
|---|---|
| Question types | True / False and Multiple Choice (single answer) |
| Scoring | 1 point per question. 100 questions = 100 points |
| Question bank | Admin can add, edit, delete and set the correct answer (`/admin` → Question bank) |
| Admin login | Username + password (scrypt-hashed), with lockout after 5 failed tries |
| Randomization | Each exam draws 100 questions at random from the bank in random order. Multiple-choice options are shuffled too |
| Timer | 45-minute countdown. The exam submits itself when time runs out. The deadline is enforced by the server too, so closing the browser does not stop the clock |
| Navigation | **One question at a time, no going back** (default), or **free navigation** with a progress bar and question grid. Switch it in Settings |
| Submit confirmation | "Are you sure you want to submit? You cannot change answers after this." |
| Grading | Excellent 81–100 · Very Good 71–80 · Good 61–70 · Pass 51–60 · Fair 41–50 · Fail 0–40 |
| Feedback | Score, grade and every question with the correct answer, shown right after submitting (can be turned off) |
| Attempt limit | 2 attempts per device by default (1–20 in Settings), using a device ID plus IP + device fingerprint |
| Certificate | Generated automatically on a pass. Downloadable as PDF or PNG, with the student's name, score, grade, date/time, a certificate ID and FHG / Networkversity branding |
| Mobile | Designed phone-first: large tap targets and a sticky timer/progress bar |
| Resume | Refreshing the page or losing connection resumes the same exam. The timer keeps running |
| Results | Admin sees every attempt, the student's answers, the certificate, pass rate and average score, and can export to CSV |

## Deploy on Vercel

Vercel runs the app as serverless functions, which can't keep files, so the data lives in a Postgres database. Vercel's Neon integration has a free tier.

1. **Import the repo.** In Vercel, choose **Add New → Project**, pick `networkversityexam`, and keep **Framework Preset: Other**. There's no build command; `vercel.json` already sets everything up.
2. **Add a database.** Open the project's **Storage** tab, choose **Create Database → Neon (Postgres)**, and connect it to the project. This adds `DATABASE_URL` / `POSTGRES_URL` automatically.
3. **Set the admin password.** Under **Settings → Environment Variables**, add `ADMIN_PASSWORD` with a strong password. Optionally add `ADMIN_USERNAME`, which defaults to `admin`.
4. **Redeploy** under **Deployments → ⋯ → Redeploy**, so the new variables take effect.
5. Open `https://<your-project>.vercel.app/admin` and log in with `admin` and your password.

The tables are created, and the 104 starting questions loaded, on the first request.

**Admin password notes**
- `ADMIN_PASSWORD` is only used to **create** the admin account the first time. Change it afterwards from **Admin → Account**. Changing the environment variable later does nothing.
- If you forget the password, run `DELETE FROM nv_kv WHERE key = 'admin';` in the Neon SQL editor (Vercel → Storage → your database → Open in Neon). The account is then recreated from `ADMIN_PASSWORD` on the next request. Questions and results are kept.

**What's stored where:** the tables `nv_questions`, `nv_attempts`, `nv_kv` (settings, admin account, session-signing key) and `nv_login_failures`. Back up the database (Neon has point-in-time restore) to keep results.

## Run it on your own computer

Requires Node.js 20+. With no database URL set, data is stored as JSON files in `./data`.

```bash
npm install
ADMIN_PASSWORD='choose-a-strong-password' npm start
# → http://localhost:3000  (admin: http://localhost:3000/admin, username "admin")
```

Off Vercel, if `ADMIN_PASSWORD` is not set on first start, a random password is generated and printed in the server log.
To use Postgres locally, set `DATABASE_URL=postgres://...`.

Run the tests with `npm test`. To run them against Postgres too, use `TEST_DATABASE_URL=postgres://... npm test`; this drops the `nv_*` tables first.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` / `POSTGRES_URL` | none | Postgres connection. Set automatically by Vercel's Neon integration. **Required on Vercel** |
| `ADMIN_USERNAME` | `admin` | Admin username, used only when the account is first created |
| `ADMIN_PASSWORD` | random (local only) | Admin password, used only when the account is first created. **Required on Vercel** |
| `SESSION_SECRET` | random, stored in the database | Optional fixed key for signing admin login cookies |
| `DATA_DIR` | `./data` | JSON-file storage location when no database is configured |
| `PORT` | `3000` | HTTP port when running locally |
| `TRUST_PROXY` | `1` | Reverse proxies in front of the app, so the real student IP is used. Ignored on Vercel, which reports the IP directly |

### Other hosts

Render, Railway or a VPS also work. Either connect Postgres with `DATABASE_URL`, or use JSON files with `DATA_DIR` on a persistent disk.

## Question bank

`data/questions.seed.json` holds the starting bank of **104 questions**:

- **61** come from the supplied *networkversity_Questions.txt*, renumbered.
- **43** are tagged `derived`. They were written to bring the bank above 100 and restate facts already present in the supplied questions (for example the PV range and bonus % of each rank, or false versions of stated facts). Please review them: in the admin panel, filter by *Needs review (derived)*. Editing and saving a question marks it as reviewed.

On first start, the seed is copied into the database (or `DATA_DIR/db.json` without one). From then on the admin panel is the source of truth, and the seed file is not read again.

## How the attempt limit works

Attempts are counted **per device**, using the device ID and the IP address together:

1. **Device ID.** On the first visit the server gives the browser a random ID. It is stored twice: in a long-lived HttpOnly cookie and in localStorage. If the student clears only one of them, the other restores it.
2. **Fingerprint + IP.** The page also sends a fingerprint: a hash of stable traits such as the browser, screen size, CPU cores, time zone and graphics renderer. If both copies of the device ID are gone, an attempt still counts when it comes from the **same IP and the same fingerprint**.
3. **IP alone never blocks.** Different phones that share one public IP (mobile networks, cyber cafés, school Wi-Fi) each get their own attempts.

| Situation | Result |
|---|---|
| Same phone, new network (Wi-Fi ↔ mobile data) | Still counted (device ID) |
| Same phone, cookies/storage cleared, same network | Still counted (IP + fingerprint) |
| Different phone on the same IP | Separate attempts |
| Same phone, storage cleared **and** network changed, or another browser/incognito on a new network | Counted as a new device (a known limit of this approach) |

The admin **Results** tab shows each attempt's IP and device. Devices used under more than one student name get a **⚠ used by N names** flag. The admin can give attempts back by deleting one attempt, using **Reset device** on a row, or using **Reset attempts for an IP**.

An exam in progress is also tied to the attempt ID saved in the browser, so changing network mid-exam does not lose it.

## Project layout

```
server.js               Express app: student API, admin API, static files
api/index.js            Vercel function entry (runs server.js); routing in vercel.json
lib/store.js            Picks storage: Postgres (lib/store-pg.js) or JSON files (lib/store-file.js)
lib/match.js            The "same student" rule for the attempt limit
lib/exam.js             Question draw, answer saving, grading, grade bands
lib/auth.js             Admin password hashing, signed session cookies, login rate limit
data/questions.seed.json  Initial question bank
public/index.html       Student exam (start → exam → result/certificate)
public/admin.html       Admin panel
public/js/certificate.js  Draws the certificate on a canvas, exports PNG/PDF
public/js/device.js     Device ID + browser fingerprint for the attempt limit
public/vendor/          jsPDF 4.2.1 (MIT), used for certificate PDFs
test/                   Unit + API tests (node --test)
```
