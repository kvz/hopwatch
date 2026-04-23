---
'hopwatch': patch
---

fix: truncate long hostnames in the "Most suspicious hop (7d)" cell with ellipsis + hover tooltip, so a couple of rows with lengthy `name (ip)` values can no longer push the root-index table past the viewport and hide the mini-chart column off the right edge. Full hostname remains available via the browser's native `title` tooltip on hover.
