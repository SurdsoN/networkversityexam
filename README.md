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
| Attempt limit | 2 attempts per IP address by default (1–20 in Settings) |
| Certificate | Generated automatically on a pass. Downloadable as PDF or PNG, with the student's name, score, grade, date/time, a certificate ID and FHG / Networkversity branding |
| Mobile | Designed phone-first: large tap targets and a sticky timer/progress bar |
| Resume | Refreshing the page or losing connection resumes the same exam. The timer keeps running |
| Results | Admin sees every attempt, the student's answers, the certificate, pass rate and average score, and can export to CSV |

## Run it

Requires Node.js 18+.

```bash
npm install
ADMIN_PASSWORD='choose-a-strong-password' npm start
# → http://localhost:3000  (admin: http://localhost:3000/admin, username "admin")
```

If `ADMIN_PASSWORD` is not set on first start, a random password is generated and printed in the server log.
The password can be changed later from **Admin → Account**.

Run the tests with `npm test`.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ADMIN_USERNAME` | `admin` | Admin username, used only on first start |
| `ADMIN_PASSWORD` | random | Admin password, used only on first start |
| `DATA_DIR` | `./data` | Where results and the question bank are stored. **Must be on persistent storage in production** |
| `TRUST_PROXY` | `1` | How many reverse proxies sit in front of the app, so the real student IP is used for the attempt limit. Keep `1` on Render/Railway/Heroku/behind Nginx. Use `false` if Node is exposed directly |

## Deploying

The app keeps its data in JSON files under `DATA_DIR`, so it needs a host with a **persistent disk**:

- **Render:** create a *Web Service* (build `npm install`, start `npm start`), add a *Disk* mounted at e.g. `/var/data`, and set `DATA_DIR=/var/data` and `ADMIN_PASSWORD`.
- **Railway:** add a Volume and point `DATA_DIR` at it.
- **VPS:** `npm start` under pm2 or systemd behind Nginx.

Serverless hosts such as Vercel or Netlify Functions are **not** suitable, because they have no persistent file system.

Back up `DATA_DIR/db.json` and `DATA_DIR/attempts/` to keep results.

## Question bank

`data/questions.seed.json` holds the starting bank of **104 questions**:

- **61** come from the supplied *networkversity_Questions.txt*, renumbered.
- **43** are tagged `derived`. They were written to bring the bank above 100 and restate facts already present in the supplied questions (for example the PV range and bonus % of each rank, or false versions of stated facts). Please review them: in the admin panel, filter by *Needs review (derived)*. Editing and saving a question marks it as reviewed.

On first start, the seed is copied into `DATA_DIR/db.json`. From then on the admin panel is the source of truth, and the seed file is not read again.

## How the attempt limit works

Attempts are counted per **IP address**, as requested. Things to know:

- Students on the same Wi-Fi, in a cyber café, or behind a mobile network that shares one public IP (common with carrier-grade NAT) share the same attempt allowance.
- A student who switches network (Wi-Fi ↔ mobile data) gets a new IP and therefore new attempts.
- An exam in progress is tied to the browser as well as the IP, so changing network mid-exam does not lose it.
- An admin can give attempts back: delete a single attempt, or use **Reset attempts for an IP** on the Results tab.

## Project layout

```
server.js               Express app: student API, admin API, static files
lib/store.js            JSON-file storage (db.json + one file per attempt)
lib/exam.js             Question draw, answer saving, grading, grade bands
lib/auth.js             Admin password hashing, sessions, login rate limit
data/questions.seed.json  Initial question bank
public/index.html       Student exam (start → exam → result/certificate)
public/admin.html       Admin panel
public/js/certificate.js  Draws the certificate on a canvas, exports PNG/PDF
test/                   Unit + API tests (node --test)
```
