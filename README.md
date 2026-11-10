# Bubblotics Match Review

Offline FTC match video analysis for scouting: measures balls per second, shot counts and cycle times for the purple and green artifacts of the 2025-26 game. Everything runs in the browser; video is stored in IndexedDB on the device and never uploaded.

## Run locally

No build step.

```
python3 -m http.server
# open http://localhost:8000
```

Tests (pure logic, Node 20+): `node --test`

## Deploy to GitHub Pages

Push to GitHub, then Settings > Pages > Deploy from branch `main` / root. All URLs are relative, so it works under `/repo-name/` or a custom domain root. `.nojekyll` is included.

## Workflow

1. **Library**: pick a video file or record from the camera, enter match number, teams, alliance.
2. **Calibrate** (once per venue/camera angle, saved as a camera profile): draw the goal ROI, optionally a launch zone and a score line, click a ball to set each color's HSV range, scrub to the first frame of auto and press "Match starts here".
3. **Analyze**: seeks through the match at the chosen fps (default 15) on 320 px wide frames; a Web Worker does the detection. Cancel returns to calibrating.
4. **Review**: timeline with phase bands (auto 0:00-0:30, transition 0:30-0:38, teleop 0:38-2:08, endgame 2:08-2:38) and colored ticks. Click ticks to seek, fix misses with the keyboard (press `?` in the app).
5. **Export** CSV (matches, events) or JSON; import another scout's JSON to merge (newest `updatedAt` wins; videos are not included).

State machine: `idle -> loading -> calibrating -> analyzing -> reviewing`; cancel goes back to calibrating.

## Metrics definitions

- balls/sec = shots / 158 s match length (per phase: shots / phase length). Endgame is the last 30 s of teleop and is counted separately, not inside teleop.
- Peak burst = most shots in any 5 s window starting at a shot.
- Cycle = run of shots with no gap longer than the cycle gap (default 3 s). Cycle time = mean start-to-start interval between cycles.

## Tips for good detection

- Fixed tripod, camera never moves between calibration and the end of the match.
- Whole goal opening visible, with a clear view of balls entering it.
- 30+ fps source video; 1080p is plenty.
- Even, bright lighting; avoid glare on the balls and mixed color temperature.
- Calibrate from a frame where balls are visible; re-pick colors if lighting differs between venues.

## Limitations

- Color thresholding: purple balls in shadow, purple robot parts, green tape or alliance colors inside the ROI can be mistaken for balls. Tighten the ROI and min/max area.
- Balls that overlap or move faster than the analysis fps can merge or be missed; raise fps or add events manually.
- Analysis seeks frame by frame, so a full match takes on the order of a minute or two depending on the device and codec.
- The launch zone is stored and drawn but not yet used by detection.
- Recorded clips are WebM (or MP4 on Safari); playback depends on browser codec support.
