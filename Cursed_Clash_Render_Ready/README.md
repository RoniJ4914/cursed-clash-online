# Cursed Clash — deploy to Render

This deploy folder is based on the multiplayer HTML + dependency-free WebSocket/HTTP server.

## Upload to GitHub
1. Create a GitHub repository named `cursed-clash-online` (public or private).
2. Upload these four files to the repository **root**: `index.html`, `server.js`, `package.json`, `render.yaml`.
3. On [Render](https://dashboard.render.com/), choose **New > Web Service** and connect the repository (or use **New > Blueprint** and use render.yaml).
4. Choose the **Free** plan for a trial. When manually creating the Web Service, use build command `npm install` and start command `npm start`.
5. Wait until the service is Live. Visit its `https://<your-service>.onrender.com` URL; `/health` returns JSON status.
6. Students visit that HTTPS site; one player creates a room and shares its code. The second joins and the host starts the match.

## Important limits
- Free Render instances sleep after 15 minutes without incoming traffic, and can take about a minute to wake.
- The host's browser performs all game simulation and sends compressed WebP frames; online guest FPS is roughly 15 and host needs to stay connected. This can use considerable egress bandwidth.
- Rooms are in memory: deployments, server restarts, or host disconnects end them. Use one service instance for room consistency.
- This is suitable for testing with friends, not for large numbers of simultaneous matches. Start small and measure bandwidth/lag before promoting at school.
- Don't push passwords, API keys, or other secrets into the GitHub repository. Check your school's IT rules and ask permission if needed to use the network for multiplayer games.
