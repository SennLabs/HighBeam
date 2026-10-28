# Changelog

## 0.1.0 (unreleased)

First release, for GNOME Shell 50.

- Spotlight-style search popup on Ctrl+Super+Space (configurable), outside the
  Activities Overview, on the monitor under the pointer or the primary one.
- Searches installed apps, GNOME's system actions and every GNOME search
  provider (Files, Settings, Characters, …), following Settings → Search.
- Built-in calculator (Enter copies the answer), open-window search, and a
  "Search the web for …" result with a configurable URL. Each can be
  switched off.
- Top Hit across all results; results stream in as each provider answers,
  so a slow provider never holds up the rest.
- Learns from what you pick: results chosen before rank higher for the same
  or a similar query. Can be switched off or forgotten.
- Keyboard-driven: arrows, Tab, Page Up/Down, Enter, Ctrl/Alt+Enter for the
  secondary action, Ctrl+1…9, Esc to clear then close.
- Preferences: shortcut, monitor, remembered query, result counts, theme
  (follow system, dark, light), opacity, blur, corner radius, size, text
  size, section order.
- Screen reader support: named and labelled list, rows and headings, and the
  selected result is announced while typing.
- Ready for translation (gettext domain `highbeam`).

Fixed before release, after a round of review and stress testing:

- Clicking a result or "Show More" now opens it.
- The calculator no longer turns IP addresses, version numbers or phone
  numbers into products; `sin(x)^2` and `sqrt(4)!` apply to the function's
  result; very long or deeply nested input is refused instead of overflowing;
  large integers are exact (or shown in exponent form).
- Results from an earlier query expire even while you type fast, and Enter
  waits briefly for GNOME's providers instead of opening a stale row or the
  web search.
- A result picked once no longer stops a strong match from being the Top Hit,
  and one-letter picks no longer boost every longer query.
- The popup always fits its monitor.
- Escape after reopening no longer swallows the next typed character.
- "Forget" works even right after a pick, and the history file keeps its
  order (saved as version 2; version 1 is still read).
- GNOME Calculator's duplicate answer is hidden when the built-in calculator
  answers.
- Preferences: Shift+letter can't be set as the shortcut; clashes with GNOME
  shortcuts are flagged; the web search URL is checked; Forget asks first;
  reset buttons are disabled when there's nothing to reset; reordering keeps
  keyboard focus.
