# HighBeam: Implementation Plan

HighBeam is a GNOME Shell extension that opens a Spotlight-style search box with a hotkey. It shows up centred on screen, outside the Activities Overview, and lets you launch apps, open files, run settings, do quick calculations and switch windows from the keyboard.

- **Target:** GNOME Shell 50 only (the version installed here is 50.1). ESM modules only.
- **UUID:** `highbeam@kthompson`. This can still be changed until the first upload to extensions.gnome.org; after that it is permanent. It only needs to be unique; it does not have to be a real domain.
- **License:** GPL-2.0-or-later, the same as GNOME Shell and Search Light, so code from the reference can be reused with attribution.
- **Reference:** `search-light-main.zip` (icedman/search-light v101, GNOME 48–50).

---

## 1. What we learned from Search Light

Search Light gets its results by *borrowing the Overview's own search widgets*. When it opens, it removes `Main.overview.searchEntry` and `Main.overview.searchController` from the Overview, puts them inside its own popup, and puts them back on close. To make that work it monkey-patches `Main.overview.toggle`, `Main.overview.hide`, `searchResults.activateDefault`, `_searchCancelled` and the `activate` method of whichever widget has focus.

| Keep (good ideas) | Avoid (sources of breakage) |
|---|---|
| `Main.layoutManager.addChrome()` for a top-level actor | Reparenting Overview actors and monkey-patching Overview methods. This is why the project needs separate branches per GNOME version (g44, gnome-47…) and why it clashes with other extensions. |
| Picking the monitor (primary, preferred, or under the cursor) | Watching `notify::key-focus` to decide when to hide. It's fragile with popups and drag-and-drop (see `_isDraggingIcon`, `_hidePopups`). |
| An opacity + scale `ease()` animation for show/hide | Running ImageMagick (`convert`) to blur the wallpaper into `/tmp` |
| `connectObject`/`disconnectObject` for cleaning up signals | Its own `Timer` class, the `msg-to-ext`/`msg-to-pref` "message bus" GSettings keys, and the `transpile.py` legacy build |
| GSettings with a schema and an Adw prefs window | `grab_accelerator`, which is less clean than `Main.wm.addKeybinding` with a schema key |
| Putting the GLSL effects in separate files | Reaching into private widget trees (e.g. `_content.first_child.first_child.child.child`) |

**Conclusion:** HighBeam will have **its own UI and its own search engine**. The engine calls the same providers GNOME uses (the app search and the D-Bus `SearchProvider2` providers) directly, so we never touch the Overview. This adds roughly a few hundred lines but avoids the per-version breakage Search Light deals with.

---

## 2. Architecture

```
┌────────────────── extension.js (enable/disable only) ──────────────────┐
│  Keybinding (Main.wm.addKeybinding)  ──toggle──►  HighBeamController     │
│                                                    │                     │
│     ┌──────────────────── UI (St/Clutter) ─────────┴───────────┐         │
│     │ Backdrop (full-monitor, click-outside → close)           │         │
│     │  └ Panel  ─ SearchEntry                                  │         │
│     │           ─ ResultList (sections, rows, Top Hit)         │         │
│     │           ─ PreviewPane (phase 7)                        │         │
│     └──────────────────────────▲───────────────────────────────┘         │
│                                │ results (incremental)                   │
│     ┌──────────────── SearchEngine ────────────────────────────┐         │
│     │ debounce · Gio.Cancellable per query · merge · rank       │         │
│     └─┬─────────┬───────────┬───────────┬──────────┬───────────┘         │
│    Apps    Remote(D-Bus)  Calculator   Windows   WebSearch  …providers   │
└────────────────────────────────────────────────────────────────────────┘
```

### Main design decisions
- **Modality:** call `Main.pushModal(panel, {actionMode: Shell.ActionMode.POPUP})` on show and `Main.popModal(grab)` on hide. That gives a real keyboard and pointer grab, so we don't need the key-focus tricks. A transparent full-monitor backdrop catches clicks outside the panel and closes it.
- **Hotkey:** a `highbeam-toggle` key of type `as` in our schema, registered with `Main.wm.addKeybinding(..., Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, cb)`. **Default: `<Control><Super>space`.** `<Super>space` is GNOME's default "switch input source" shortcut. The prefs page offers to rebind it.
- **Provider interface** (one shape for every provider):
  ```js
  {
    id, title, icon, priority,
    async search(terms, cancellable) -> ResultMeta[],     // may resolve empty
    activate(result, terms),
    // optional:
    async subsearch(prevResults, terms, cancellable),
    launchSearch(terms),                                  // "Show all in Files"
  }
  // ResultMeta: { id, providerId, title, subtitle, gicon|createIcon(size), score, preview? }
  ```
- **Engine:** waits ~60 ms after typing (debounce). It cancels the previous query's `Gio.Cancellable`, asks all providers in parallel, and **streams** each provider's results into the list as they arrive, keeping section order stable to avoid jumps. The best hit across all providers becomes the "Top Hit" row, as in Spotlight.
- **Remote providers:** use `loadRemoteSearchProviders()` from `resource:///org/gnome/shell/ui/remoteSearch.js` and respect `org.gnome.desktop.search-providers` (`disabled`, `enabled`, `sort-order`, `disable-external`). Wrap them in our provider interface: `getInitialResultSet` → `getResultMetas`. This gives us Files (Nautilus/localsearch), Settings, Calculator, Characters, Clocks, Contacts, etc. for free. *This is a shell-internal module, not a stable API, so its exact signatures must be checked against the GNOME 50 source before coding (§6).*
- **Apps:** `Shell.AppSystem.get_default().search()` plus `Shell.AppUsage` for frecency. We could reuse `AppSearchProvider` from `appDisplay.js` instead, but a thin provider of our own avoids depending on Overview internals.
- **Look and feel:** CSS in `stylesheet.css` with classes for light and dark, following `org.gnome.desktop.interface color-scheme`. Optional blur uses `Shell.BlurEffect` in `BACKGROUND` mode (done on the GPU, no ImageMagick). Its property names changed over time (`sigma` → `radius`), so check this on GNOME 50.
- **Settings:** GSettings only. Prefs use `ExtensionPreferences.fillPreferencesWindow` with Adw pages: General, Appearance, Providers, Shortcuts.

### Directory layout
```
highbeam@kthompson/
  LICENSE                 # GPL-2.0-or-later
  metadata.json
  extension.js            # enable()/disable() → creates/destroys Controller
  prefs.js                # Adw preferences window
  stylesheet.css
  schemas/org.gnome.shell.extensions.highbeam.gschema.xml
  src/
    controller.js         # show/hide/toggle, monitor choice, modal grab
    ui/panel.js           # St.BoxLayout: entry + list (+ preview)
    ui/resultList.js      # sections, selection model, keyboard nav
    ui/resultRow.js
    ui/previewPane.js     # phase 7
    search/engine.js      # debounce, cancellation, fan-out, merge
    search/ranking.js     # fuzzy match + frecency scoring (pure JS, unit-tested)
    search/providers/{apps,remote,calculator,windows,web,system}.js
    util/keybinding.js
    util/history.js       # selection history (JSON in $XDG_DATA_HOME/highbeam)
  tests/                  # gjs -m unit tests for pure modules
  Makefile                # schemas, install, pack, nested, lint, test
```

---

## 3. Phased delivery

Each phase finishes with something that runs in a nested shell.

**Status (2026-10-12):** Phases 0–6 and 8 are done (Phase 7, the optional preview pane, is not started). All were tested in a headless GNOME Shell 50.1; submitting to extensions.gnome.org is left to the maintainer. Differences from the plan below:
- GNOME's system actions (Lock Screen, Power Off, …) are already in the app results, the same way the Overview offers them; Phase 4 only needs the confirmation and Settings-panel parts.
- Ctrl+Enter / Alt+Enter opens a new app window for apps and runs "show all in <App>" for provider results. "Open containing folder" isn't possible through the D-Bus provider API.
- Each provider section has a "Show More" button in its header instead of an extra row.
- Phase 4: every built-in provider (calculator, open windows, system actions, web search) has an on/off switch on a **Search** prefs page, on by default, applied live.
- Phase 5: the prefs pages are General, Appearance and Search (the planned Providers page became Search). Section order is a `result-order` list with up/down buttons; GNOME's providers move as one block and keep the order from GNOME Settings. "Max rows" became a result-list height in pixels, since rows differ in height. Font sizes in the stylesheet are in em of a base size, so one text-size setting scales them. Blur is on by default but only clearly visible below about 90% opacity.
- Phase 6: the history logic is `src/search/history.js` (pure, unit-tested) and the file I/O is `src/util/historyFile.js`. A pick also boosts the result for longer and shorter forms of the query at half weight; boosts decay with a 14-day half-life, are capped at +0.25 and move the result to the front of its section. Providers with `recordHistory: false` (windows, calculator, web) are never learned from. "Forget" in the prefs deletes the file; the extension watches it and clears its copy. On by default (`learn-from-selections`).
- Phase 8: GNOME 50 still uses ATK. Rows are `LIST_ITEM`s with the `SELECTED` state, headings are `HEADING`s, and the selected row is announced through the entry's ATK `notification` signal (polite), 250 ms after results settle. `make pot` builds `po/highbeam.pot` from the JS and the schema (needs gettext); `make pack` passes `--podir=po`. The EGO checklist is in the README.
- GNOME already asks for confirmation before Power Off, Restart and Log Out, so HighBeam adds none of its own. Settings panels come from the GNOME Settings search provider, so no separate provider was needed.
- The web search default is Google; it is a URL template setting.

### Phase 0: Scaffold and dev loop
- `LICENSE` (GPL-2.0-or-later) and SPDX headers in each source file.
- `metadata.json` (uuid `highbeam@kthompson`, `shell-version: ["50"]`, `settings-schema`, `gettext-domain`), plus an empty `enable`/`disable`.
- Makefile targets:
  - `schemas` (`glib-compile-schemas`)
  - `install` (symlink into `~/.local/share/gnome-shell/extensions/`)
  - `pack` (`gnome-extensions pack --extra-source=src ...`)
  - `nested` (`dbus-run-session gnome-shell --devkit --wayland`)
  - `logs` (`journalctl -f -o cat /usr/bin/gnome-shell`)
  - `lint` (eslint with GNOME's shell config)
- **Done when:** the extension enables in a nested shell and logs a line.

### Phase 1: Popup shell (no search yet)
- Controller plus Panel with an `St.Entry`. Opens centred on the chosen monitor (primary, a specific one, or the one under the cursor).
- Hotkey toggles it. Escape, clicking outside, losing focus and a window going fullscreen all close it.
- `pushModal`/`popModal`, show/hide animation (honours `org.gnome.desktop.interface enable-animations`), and multi-monitor and scale-factor sizing.
- **Done when:** repeated toggling leaks nothing (check with Looking Glass), and disabling the extension while the popup is open cleans everything up.

### Phase 2: Engine and app search (MVP)
- `engine.js` with debounce and cancellation, plus `ranking.js` (prefix > word-start > subsequence fuzzy, combined with a frecency boost).
- Apps provider and result rows (icon, title, subtitle).
- Keys:
  - Up/Down and Tab move the selection.
  - Enter activates the selection.
  - Ctrl+Enter / Alt+Enter is the secondary action (e.g. open containing folder).
  - Ctrl+1…9 jumps to a result.
- Top Hit row. The query is cleared each time the popup opens (configurable later).
- **Done when:** typing "fire" + Enter launches Firefox in under 100 ms from the hotkey, at typical typing speed.

### Phase 3: Remote (system) providers
- Load D-Bus providers, respect the GNOME Search settings, and show one section per provider in `sort-order`.
- Gnome-shell enforces per-provider timeouts and ignores late responses; we do the same. A slow provider must never block the list.
- "Show more in <App>" row calls `launchSearch`.
- **Done when:** results from Files, Settings, Calculator and Characters appear, and disabling one in GNOME Settings removes it.

### Phase 4: Built-in providers
- **Calculator:** a hand-written expression parser (no `eval`; EGO reviewers reject it). Enter copies the result via `St.Clipboard`.
- **Windows:** search open windows by title and app; activating one runs `Main.activateWindow`.
- **System actions:** Lock, Log Out, Suspend, Power Off, Settings panels (`gnome-control-center <panel>`), each with a confirmation where it matters.
- **Web search fallback:** "Search the web for …" using a configurable URL template, opened with `Gio.AppInfo.launch_default_for_uri`.
- Each provider can be toggled in prefs.

### Phase 5: Preferences and appearance
- Adw prefs pages:
  - General: shortcut capture widget, monitor choice, remember last query.
  - Appearance: width, max rows, font size, corner radius, background opacity, blur on/off and radius, theme (auto/light/dark).
  - Providers: enable and reorder built-ins.
- The extension listens for `changed::` signals and applies updates live without re-enabling.

### Phase 6: Ranking quality
- Record what was chosen for each query in `util/history.js` (capped and pruned, stored in `$XDG_DATA_HOME/highbeam/history.json`, written asynchronously). Boost results picked before for the same prefix ("fi" → Firefox), as Spotlight does.
- Unit-test the ranking with fixture data.

### Phase 7 (optional): Preview pane
- A right-hand pane for the selected result: app description and actions, file thumbnail (via the `org.freedesktop.thumbnails` cache path), size and modification date, a larger calculator result.
- Off by default; the panel widens when it's turned on.

### Phase 8: Polish and release
- Accessibility: accessible names and roles on the entry, list and rows, screen-reader announcements of the selected result.
- i18n with gettext and a `po/` directory, README, screenshots, `CHANGELOG.md`.
- Walk through the EGO review checklist:
  - Nothing created in the constructor; `disable()` undoes everything.
  - No synchronous I/O in the shell process; no `eval`.
  - `session-modes` left at the default (so it doesn't run on the lock screen).
- Submit to extensions.gnome.org.

---

## 4. Testing strategy
- **Unit tests:** run `gjs -m tests/*.js` on the pure modules (ranking, calculator parser, history pruning). These need no shell and should run in CI.
- **Nested shell:** `make nested` with `MUTTER_DEBUG_DUMMY_MODE_SPECS` and `MUTTER_DEBUG_DUMMY_MONITOR_SCALES` for HiDPI and multi-monitor checks.
- **Manual checklist for each release:**
  - enable/disable 20× with no errors in the journal
  - toggle while the Overview is open
  - fullscreen app
  - two monitors with different scales
  - keyboard-only use
  - screen reader (Orca)
  - light and dark styles

## 5. Risks

| Risk | Mitigation |
|---|---|
| `remoteSearch.js` / `Shell.BlurEffect` internals change between GNOME releases | Isolate each in one module (`providers/remote.js`, `ui/blur.js`) with feature detection; support GNOME 50 only. |
| The hotkey collides with input-source switching or other extensions | Use a non-colliding default and show a conflict warning in prefs. |
| Slow D-Bus providers make results stutter | Per-provider timeouts, results streamed in as they arrive, stable section order. |
| Focus or modal edge cases (screen lock, notifications, the Overview opening) | Close on `Main.sessionMode` changes and `overview-showing`; always `popModal` in `disable()`. |

## 6. Verify before coding (against GNOME 50 sources)
- [ ] `remoteSearch.js` export names and how they are called (`loadRemoteSearchProviders` and the provider method signatures).
- [x] `Shell.BlurEffect` property names on 50: `radius` (int), `brightness`, `mode` (`ACTOR`/`BACKGROUND`), `enabled`.
- [ ] `Main.pushModal` options and the return value on 50.
- [ ] Whether `St.BoxLayout` uses `orientation` or `vertical` on 50 (the reference already uses `orientation`).

## 7. Decisions
| Decision | Choice |
|---|---|
| GNOME versions | 50 only |
| License | GPL-2.0-or-later |
| UUID | `highbeam@kthompson` (can change until the first upload to extensions.gnome.org) |
| First usable build | Phases 0–3. The calculator and window search follow in Phase 4. |
