# Changelog

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
