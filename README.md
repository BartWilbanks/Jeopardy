# Jeopardy Live (WordPress-friendly)

This is a real-time, multi-device Jeopardy-style game:
- Host screen (TV/browser): `/host.html`
- Player join (phones/tablets): `/player.html`
- Game mode per room: **Buzzer** or **Take Turns**
- New Round button (creates a fresh placeholder board)
- Team renaming + scoring

## Quick start (local test)
1) Install Node.js (LTS)
2) In this folder:
   - `npm install`
   - `npm start`
3) Open:
   - Host: `http://localhost:3000/host.html`
   - Player: `http://localhost:3000/player.html`

## Deploy alongside WordPress
WordPress itself isn't great for running WebSockets inside typical shared hosting.
Recommended setup:
- Keep WordPress where it is
- Deploy this Node app on a subdomain, e.g. `game.yoursite.com`
- Link to it from WordPress (or embed with an iframe if you want)

Common simple hosting:
- Render
- Railway
- Fly.io
- DigitalOcean App Platform
- Any VPS (Nginx reverse proxy)

## Add your real questions
Right now `defaultGame()` in `server.js` generates placeholder questions.
Next steps:
- Replace `defaultGame()` with:
  - Your offline random-round question bank
  - Or load from Google Sheet
  - Or add an admin editor page

## Notes
- This starter stores rooms in memory. If the server restarts, rooms reset.
- For "always on" production rooms, use Redis for room state.
