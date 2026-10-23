---
"opencode-jev-router-plugin": minor
---

Add `/jev-off` and `/jev-on`: switch the router off and on for the current
session. While routing is off no classifier call is made and the model chosen
by hand is preserved; the toggle is also checked while a prompt is in flight,
so a pending model switch is dropped when `/jev-off` runs during
classification. `/jev` now reports the state (`routing: on` / `routing: off`),
and a failing toggle command is reported in the session instead of only in the log.
