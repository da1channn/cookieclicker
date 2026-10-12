# iPhone evals

Automated, code-graded evals for the iOS build. Each eval maps to one acceptance
criterion from the brief, runs from a clean state, and returns pass/fail plus
metrics. The same suite runs against the plasma4 `mobile.html` **baseline** and the
iOS `index.html` **candidate**, so every change is measured against where we started.

```sh
NODE_PATH=$(npm root -g) node evals/run.js --target index.html  --label candidate
NODE_PATH=$(npm root -g) node evals/run.js --target mobile.html --label baseline
node evals/run.js --only T06,T07      # a subset
```

Results land in `evals/results/<label>.json`. The history is in [RESULTS.md](RESULTS.md).

## How the suite is built (eval best practices applied)

- **Success criteria first.** Every eval is one of the brief's requirements (P0 zoom / tap,
  P1 viewport / rotation / safe area / PWA / save, P2 UX). Each was written down
  before the fix it checks.
- **Baseline before changes.** plasma4 `mobile.html` is scored with the same suite.
- **Deterministic, code-based grading.** No LLM or human judging: counts, coordinates,
  computed styles, timestamps. Thresholds are fixed in code.
- **Test behaviour, not implementation.** Evals drive real touch input through the
  Chrome DevTools Protocol (`Input.dispatchTouchEvent`, `synthesizePinchGesture`,
  safe-area override, offline mode) and read game state (`Game.cookieClicks`,
  building amounts, upgrade state, minigame state). They do not call `ios-fixes.js`.
- **Clean state per eval.** Fresh browser context (storage, service worker) every time.
- **Edge cases as first-class evals.** Two-finger drumming, long press, sliding off,
  golden cookie over the big cookie (ghost click), mouse users, offline relaunch,
  stale layout after resume.
- **Read the failures.** Eval bugs found while reading transcripts were fixed in the
  eval, not hidden: e.g. Chromium sends a stray `mouseover` to (0,0) after a tap
  (T27), a save import legitimately unlocks achievements so "identical export" means
  "same export as plasma4 for the same save" (T19).
- **Known harness limits are written down.** See below.

## What Chromium emulation cannot show

The harness is Chromium with iPhone metrics (393×852, DPR 3, touch, mobile viewport).
It honours `<meta viewport>`, `touch-action`, pointer/touch events and env() insets
(via override), but it is not WebKit:

- WebKit's 350 ms double-tap wait and its hover "content change" heuristic do not exist
  in Chromium. They are covered structurally: the cookie's `touchstart` is
  `preventDefault`ed (T08), the viewport is non-scalable (T01), `touch-action`
  is set on every element (T04), and actions run on `pointerup` regardless of when
  (or whether) WebKit sends `click` (T05–T07, T11, T12, T23).
- Standalone-mode resume bugs are simulated by corrupting the layout and firing
  `visibilitychange` / `pageshow` (T18).

So the manual iPhone checklist in the main README is still required.

## Eval list

| ID | Group | Checks |
|----|-------|--------|
| T01 | P0 zoom | viewport meta is device-width, non-scalable, viewport-fit=cover |
| T02 | P1 viewport | layout viewport = device width, page scale 1 |
| T03 | P1 viewport | whole game fits the screen, no horizontal scroll |
| T04 | P0 zoom | computed touch-action: html/body manipulation, cookie none, store pan-y |
| T05 | P0 tap | 1 tap = exactly 1 cookie click |
| T06 | P0 tap | 20 taps at 22/s: all counted, latency pointerup→click (p50/p95/max) |
| T07 | P0 tap | two-finger drumming: every lift counts |
| T08 | P0 zoom | cookie touchstart is default-prevented |
| T09 | P0 zoom | double tap anywhere never zooms |
| T10 | P0 zoom | pinch never zooms |
| T11 | P0 tap | building: 1 tap = 1, 5 fast taps = 5 |
| T12 | P0 tap | store upgrade bought exactly once |
| T13 | P0 tap | store scrolls by dragging, dragging never buys |
| T14 | P2 ux | long press shows the tooltip, does not buy |
| T15 | P1 rotation | portrait→landscape→portrait: fits, scale restored |
| T16 | P1 rotation | finger maps to game coordinates (particles, drags) |
| T17 | P1 safe-area | Dynamic Island / home indicator insets respected, taps still map |
| T18 | P1 resume | broken layout repaired on resume; zero resizes while idle |
| T19 | P0 save | saves move both ways between this build, plasma4 mobile and desktop; same export format |
| T20 | P1 lifecycle | progress saved when the app goes to background |
| T21 | P1 pwa | GitHub Pages subpath: no 404, no absolute paths |
| T22 | P1 pwa | manifest, apple meta, icons, service worker |
| T23 | P0 tap | golden cookie over the big cookie: 1 pop, no ghost click |
| T24 | P1 minigame | Garden tile tap plants the seed |
| T25 | P1 minigame | Pantheon tap-to-slot |
| T26 | P1 minigame | Ascension tree follows the finger |
| T27 | P2 ux | tooltip closes when touching elsewhere |
| T29 | P0 tap | click sound starts quickly after touch-down |
| T30 | P0 tap | mouse/trackpad still works exactly once |
| T31 | P2 ux | sliding off a building cancels the purchase |
| T32 | P1 save | Import prompt: textarea pasteable, buttons work, no leftover scroll |
| T33 | P1 pwa | relaunch works offline |
| T34 | P2 ux | cookie press feedback while the finger is down |
| T28 | P0 stability | no JavaScript errors |

### Portrait UI evals (added with the portrait layout)

| ID | Checks |
|----|--------|
| T38 | UI scale in portrait ≥ 0.95 (desktop layout shrinks to 0.44) |
| T39 | tab bar in the bottom thumb zone, above the home indicator, every tab ≥ 44pt (Apple HIG) |
| T40 | each tab opens its screen (store, buildings, stats, options, info, legacy prompt) |
| T41 | store rows full width and ≥ 44pt tall, upgrade crates ≥ 44pt |
| T42 | the whole big cookie is visible and hit-testable |
| T43 | no sideways clipping in any panel |
| T44 | building tooltip fits on screen |
| T45 | notifications never block the cookie or the store |
| T46 | landscape returns to the 3-column layout, portrait restores the tab UI and tab |
| T47 | ? help button ≥ 44pt opens the touch-controls guide, X closes it |
| T48 | help shows itself on the first launch only |
| T49 | panel drawer: more store rows when pulled up, state remembered across launches |
| T50 | long press never harvests a sugar lump or plants a garden plot; tap still does |
| T51 | ascension: long press on a heavenly upgrade = info only, tap buys |
| T52 | no broken images/assets on any screen (tabs, 4 minigames, ascension, help page, landscape): `<img>` load failures, every CSS `background-image` URL fetched, any 4xx |
| T53 | ascension screen is clean: no tab bar / drawer handle / help button, notifications clear of the Reincarnate button |
| T54 | each tab keeps its own scroll position; a menu never opens half-scrolled from another tab |

### Visual review (manual, every release)

Automated checks can't judge everything, so screenshots of every screen are also reviewed by eye on
iPhone SE (375×667), 15 Pro (393×852, Dynamic Island) and Pro Max (430×932, English). Issues found
this way so far and fixed:

- the lone "?" help button looked like a broken-image placeholder → labelled "📖 遊び方 / Help" pill
- the drawer handle showed in the middle of the ascension screen; notifications covered "Reincarnate"
- an empty plasma4 ad box left a black strip at the top of the store
- the DashNet/Steam link bar wrapped over the game in landscape (now hidden on iOS)
- the bakery name was cut off and the news ticker squeezed to one character per line in landscape
- menus opened half-scrolled when switching from another scrolled menu
| T55 | progress survives a relaunch: 60s autosave writes, relaunch restores, leaving the app saves the latest state, autosave-off is respected |
