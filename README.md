# Bubblotics Match Review

Offline FTC match video analysis for scouting: built for FTC BIOBUZZ 2026-27. Measures launches per second, cycle times, HIVE tips and POLLINATOR RP progress for the yellow POLLEN and red/blue NECTAR elements. Everything runs in the browser; video is stored in IndexedDB on the device and never uploaded.

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
2. **Calibrate** (once per venue/camera angle, saved as a camera profile): draw your alliance's HIVE cell opening ("Draw HIVE cell"), optionally a launch zone and a score line, click a ball to set the HSV range for pollen, red and blue, scrub to the first frame of auto and press "Match starts here".
3. **Analyze**: seeks through the match at the chosen fps (default 15) on 320 px wide frames; a Web Worker does the detection. Cancel returns to calibrating.
4. **Review**: timeline with phase bands (auto 0:00-0:30, transition 0:30-0:38, teleop 0:38-1:38, flower 1:38-2:38) and colored ticks. Click ticks to seek, fix misses with the keyboard (press `?` in the app). Press `T` (or the button) to mark a HIVE tip at the current frame.
5. **Export** CSV (matches, events) or JSON; import another scout's JSON to merge (newest `updatedAt` wins; videos are not included).

State machine: `idle -> loading -> calibrating -> analyzing -> reviewing`; cancel goes back to calibrating.

## Matches from YouTube

Paste a YouTube link (watch, youtu.be, /live/, /shorts/; `t=` or `start=` timestamps like `1h2m3s` or `3723` work) in "New match" instead of choosing a file. Nothing is stored in IndexedDB for these matches; the library shows a YouTube badge and re-embeds the video on open. JSON export keeps the link, so another scout can import and open the same match directly (file matches still need their video re-attached).

- **Manual review (any browser, needs internet).** The player is the YouTube embed. Seek to the start of the match and press "Match starts here"; a timestamp in the link pre-seeks there. Step is 1/30 s seeks, speeds are whatever YouTube offers. Click outside the player before using keyboard shortcuts, or the iframe keeps the keys.
- **Auto-count (share this tab).** Browsers cannot read pixels from a YouTube iframe, so the app records its own tab with screen capture, plays the video at 1x from the match start and runs the same detector on frames of the player area. Draw the HIVE cell on the player as usual (color picking is unavailable; default colors are used). Choose "This tab" in the share dialog. Keep the tab visible, the player unobscured, and do not scroll or resize until the 158 s window ends. Stop sharing or press Cancel to end early (stopping sharing keeps what was found).
- **Chrome is needed for auto-count** (Chrome/Edge desktop: `getDisplayMedia` with current-tab capture, plus Region Capture to crop to the player; other browsers fall back to cropping each frame in JS). iPad Safari has no screen capture, so only manual review works there.
- **Accuracy depends on stream quality.** Use 720p or better and set the YouTube quality manually; livestream compression blurs small balls. Event times come from the player clock, so a few frames of capture latency are possible.
- **Offline.** The app shell works offline; YouTube matches show "YouTube needs internet" instead of the player, but their events, metrics and edits stay usable. No YouTube resource is cached.

## Metrics definitions

- balls/sec = launches / 158 s match length (per phase: launches / phase length). The flower phase is the last 60 s of the match (flower scoring allowed) and is counted separately, not inside teleop. HIVE tip events are excluded from balls/sec, burst and cycles.
- Tips: auto and teleop counts, launches per tip, estimated HIVE points (20 per tip), POLLINATOR 1 / 2 RP progress (4 and 7 tips).
- A robot can hold at most 4 elements; cycles with more than 4 launches are flagged (possible control violation or two robots merged).
- Peak burst = most shots in any 5 s window starting at a shot.
- Cycle = run of shots with no gap longer than the cycle gap (default 3 s). Cycle time = mean start-to-start interval between cycles.

## Tips for good detection

- Fixed tripod, camera never moves between calibration and the end of the match.
- Film the HIVE with the camera high and to the side so the cell opening is visible, with both HIVES in frame.
- Whole HIVE cell opening visible, with a clear view of balls entering it.
- 30+ fps source video; 1080p is plenty.
- Even, bright lighting; avoid glare on the balls and mixed color temperature.
- Calibrate from a frame where balls are visible; re-pick colors if lighting differs between venues.

## Limitations

- Color thresholding: yellow/red/blue balls in shadow, robot parts, alliance-colored tape or alliance colors inside the ROI can be mistaken for balls. Tighten the HIVE cell polygon and min/max area.
- Balls that overlap or move faster than the analysis fps can merge or be missed; raise fps or add events manually.
- Analysis seeks frame by frame, so a full match takes on the order of a minute or two depending on the device and codec.
- The launch zone is stored and drawn but not yet used by detection.
- Recorded clips are WebM (or MP4 on Safari); playback depends on browser codec support.
