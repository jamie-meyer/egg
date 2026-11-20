# Changelog

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
