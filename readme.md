## Running
(from /jam)
uvicorn app:app --reload --port 8000
open frontend.html

Terminal: websocat -t ws://localhost:8000/ws/jam1

## Formatting

1. Install the JavaScript tooling once: `npm install`
2. Run `npm run format` (or `npm run format:check`) to apply Prettier.

Prettier automatically reads `.editorconfig`, so the whitespace rules defined there (LF line endings, trim trailing whitespace, 4-space Python, 2-space HTML/JS, etc.) are enforced whenever you run the formatter or rely on editor integrations.


## History
Started from commit "fix: removed old debugging logic"
1. set up consistent dev environment/tooling
2. refactor code to organize

## TODOs
1. Fix upstream peer selection, p2p instead of only from host
2. Improve swarm state tracking, only track have count instead of other fields? so update frontend to reflect this too
3. automatically update have count from p2p transfers
4. host to viewer heartbeat messages for playback sync
5. viewer drift correction
6. error handling, scheduling, UI polishing
7. stretch goals if all above working: multiple rooms, auth, logging/viz, modularization, playlists/vote
