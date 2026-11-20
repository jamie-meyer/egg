# Changelog

## 0.2.0

- **Open egg from anywhere.** Control+Option+E opens egg's page from any
  screen in bb, and "egg: open its page" is in bb's command palette. The
  shortcut can be rebound in bb's keyboard settings.
- **Its own icon:** a hatching egg.
- **A room thread.** A room can have one long-lived thread that does real
  work: builds, writes scripts and harnesses, runs them for minutes or
  hours. It starts the first time a line asks for work and stays for the
  life of the room.
- **Lines are routed.** The planning step that runs on every line also
  returns a route in the same call: `look` (four views), `work` (the room
  thread) or `both`. `w` sends a line straight to the room thread. A work
  line while it is busy is added to its running turn, and the notebook
  says so.
- **It works in a copy.** A copy-on-write clone (the `cow-clone`
  environment provider) or a git worktree; never the folder itself unless
  the new *Where the room thread works* setting is `in-place`. A way that is
  not available is said in the notebook, with why.
- **Material.** It keeps what it makes in `.egg/` (a ledger of runs,
  notes, pages, scripts, results), kept out of git with `info/exclude`.
  Notes become notebook lines, pages become cards in a round of their own,
  and `.egg/` is copied to the room's directory, so it outlives the clone;
  a fresh room thread gets it back.
- **Views use it.** Once there is a room thread, views run in its
  workspace, read its ledger first and cite it. "Built from" lists the
  ledger entries a view rests on, each checked against what the room
  thread's own events show it ran.
- **On the page.** A status line for the room thread (state, how long, its
  latest step, tokens), its chat in a pane beside the table (`t`, `i` to
  type, Escape), and `S` to stop its turn.
- Model, provider and permission mode are settings per role: views,
  planning, room thread. The room thread's model defaults to the provider's
  default.
- `scripts/copy-for-checks.mjs` makes a copy for checks under its own
  plugin id; the end-to-end scripts refuse the id `egg` unless told.

## 0.1.1

- Rounds are faster: about 16 to 18 seconds instead of 21 to 28 for a plain
  round on egg's own repository. A round lasts as long as its slowest view,
  and the slow views were the ones that read in many small steps or went
  back to check and edit their page after saving it. Views now read in at
  most three batched commands, make a smaller page, and write it once.
  egg itself was not waiting: each card already showed the moment its own
  thread finished.
- When a round completes, its notebook line says how many views landed and
  how long it took, for example `4 views · 16 s`.
- A view opened large and the comparison now cover everything below the top
  bar; a sliver of the notebook no longer shows above them.
- `scripts/e2e.mjs` runs a named subset of its sections (`--only`) and can
  reuse an existing room (`--room`), so a change can be checked with a few
  threads or none. `scripts/round-timing.mjs` shows where a round's time
  goes, view by view, from each thread's own events.
- CI runs the unit tests and the typecheck on pushes and pull requests to
  `main`.

## 0.1.0

The first version.

- Rooms: a folder to read plus a subject. Child rooms by zooming into a
  part (`z`), and back up (`-`).
- Lines in by typing (`i`), by pasting, or by holding a key to talk.
- Each line starts a round of four views on four different angles, made by
  agents that read the folder.
- Move, open, keep (`y`) and drop (`d`) from the keyboard; kept views are
  plain files with a JSON record beside them.
- More like this (`m`) along named axes; mark two views (`v`) to compare
  (`c`) or cross (`x`) them; pin a view as reference (`p`).
- Every view says what it was built from, taken from its thread's own
  events, and derived views record their parents.
- Generated pages are untrusted: an allowlist sanitiser and two nested
  sandboxed frames.
