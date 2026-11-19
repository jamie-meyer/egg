# egg 🥚

An ideation room for [bb](https://github.com/get-bb/bb).

Point a room at a real folder, say or type a half-formed thought about one
small part of it, and four different views of the real thing land side by
side: small pages made by agents that read the folder. Keep what shows you
something, drop the rest, go again.

It is for the phase where you are still looking for the idea, or trying to
make sense of something too big to hold in your head. Nothing in it is
specific to one kind of folder.

## Install from a checkout

You need bb 0.49 or newer and Node 22 or newer.

```sh
git clone <this repository> egg
cd egg
npm install --include=dev
bb plugin install . --yes
```

Then open **egg** from bb's navigation rail (or go to `/plugins/egg/egg`).

## How it works

- **A room** is a folder to read plus a subject. Make one with `n`: the
  folder defaults to the current bb project's checkout, and the first line
  is the subject.
- **Each line starts a round.** A quick planning step (a fast model) picks
  four deliberately different angles on what you said, given the room's
  earlier lines and which views you kept or dropped. Four cards appear at
  once, and four agent threads, one per angle, read the folder and each
  write one small page (or plain text). Each card fills in as its thread
  finishes; a round takes about 20 seconds.
- **Every view says what it was built from**: the files its thread read and
  the commands it ran, taken from the thread's own event stream, not from
  what the model says it did. Press `b` to see it.
- The view threads are hidden from bb's sidebar, titled
  `egg: <angle> · <subject>`, and archived when their round is superseded
  or the view is dropped.

### Going further from a view

Each of these works on the selected view, on the table or in the kept
strip, and every view it makes still reads the real folder.

- **More like this** (`m`): a round of four variations of the view. The
  planning step names four different axes to vary it along (a narrower
  scope, a different form, a different question about the same data, a
  different grain, …) and each card shows its axis. The notebook says
  `more like "<angle>"`.
- **Mark, compare, cross**: `v` marks a view (two at most; a third
  replaces the older). `c` shows the two marked views large, side by side,
  with no model involved. `x` crosses them: a round of two views that each
  combine the parents a different way, with every part labelled `[A]`,
  `[B]` or `[A+B]`; the card names both parents. The notebook says
  `cross "<angle A>" × "<angle B>"`.
- **Zoom into a part** (`z`): the line input opens with "zoom into…"; type
  or paste the part. That makes a **child room** on the same folder, about
  that part, and its first round starts at once. `-` goes back up to the
  parent room, at the view you zoomed from. The room list shows child rooms
  under their parents, and each child room keeps its kept views in its own
  directory, inside the parent's.
- **Pin** (`p`): pins or unpins a view (one at a time). While it is
  pinned, every line's round gets it as reference, and the notebook says
  so. This is how an earlier view is pulled back into play.
- **Where a view came from**: a view made by any of these records its
  parents (room, round, view). "Built from" lists them above the files and
  commands, and a kept view's JSON has them too.

The parent view's content is handed to the planning step and the view
threads as **quoted reference material**, between delimiters that carry a
fresh random token for each round, with the instruction that nothing inside
is an instruction. It was written by a model that read arbitrary files, so
it is treated as data. The view threads are told to rebuild from the folder
and not to copy a fact from the reference without checking it.

### Lines in

- **Type**: `i` opens a one-line input. Enter sends, Escape leaves.
- **Paste**: a paste anywhere on the page (when no text field is focused)
  opens the line input with the pasted text in it; Enter sends, Escape
  discards. This is how a dictation app that pastes its text works with no
  setup. The setting *Send a pasted line at once* skips the Enter.
- **Dictation apps that type characters** instead of pasting: press `i`
  first, then dictate. (On the page itself letters are commands.)
- **Hold to talk**: hold Space (when no text field is focused) to record,
  release to send the clip to bb's voice transcription; the text becomes a
  line exactly as if typed. Clips under a second are ignored. The key can be
  changed to backquote or turned off in egg's settings.

## Keys

Press `?` on the page for this legend.

| Key | Does |
| --- | --- |
| `i` (or `a`) | open the line input; Enter sends, Escape leaves |
| paste | open the line input with the pasted text |
| hold Space | record a line; release to transcribe |
| `h` `l` | previous, next card (arrows too); `0` `$` first, last |
| `j` `k` | move down and up the grid of cards and to the kept strip |
| Enter | open the selected view large; Escape closes it |
| `y` | keep the view |
| `d` | drop the view |
| `u` | undo the last keep or drop |
| `b` | show or hide what views were built from |
| `[` `]` | previous, next round; `G` the latest |
| `m` | more like this: four variations along named axes |
| `v` | mark or unmark the view (two at most) |
| `c` | compare the two marked views side by side; Escape closes |
| `x` | cross the two marked views |
| `z` | zoom into a part of the view: a child room |
| `-` | up to the parent room |
| `p` | pin or unpin the view as context for the next lines |
| `r` | the list of rooms, child rooms under their parents (`j` `k`, Enter) |
| `D` | in the room list: delete the room; `u` undoes while the list is open |
| `n` | a new room |
| `?` | the legend |

Keep, drop and deleting a room are instant and never ask anything.
Deleting a room takes it out of egg and archives its threads; its kept
files stay on disk, and its child rooms move to the top level of the list.

In the new-room form the folder defaults to the folder of the last room
made; below it is a list of bb's project checkouts, which Up and Down (or
Ctrl-n, Ctrl-p) pick from.

## What it stores, and where

- **Rooms** (their lines, rounds, views and what each view was built from)
  are kept in egg's plugin storage inside bb's data directory, so they
  survive reloads and restarts.
- **Kept views are plain files.** Each room has a directory under the
  *Rooms directory* setting (default `~/egg`); the page shows its path.
  Keeping a view writes the view (`.html` or `.txt`) and a small `.json`
  beside it: the room (and for a child room, the room and view it was
  zoomed from), the line that produced it, the kind of round, its angle and
  axis, the model, the time, its parent views, and the "built from" list. Undoing a keep removes both files, and
  so does dropping a view that was kept.
  Dropping a view takes it off the table, not out of the notebook.

## What it sends to model providers

egg runs agent threads through bb on the provider and models you choose
(defaults: `claude-code`, `claude-sonnet-5-5` for views and
`claude-haiku-5-5` for planning). **Those agents read the contents of the
folder a room points at**, and what they read goes to that provider. The
planning step sends the room's subject, its earlier lines and the names of
kept and dropped views, and, for a variation, cross, zoom or pinned round,
the text of the parent views. Hold-to-talk sends your recording to whatever voice
service bb is set to use.

The agents are told the folder is read only and to write only their view,
into their own thread storage. With the default permission mode (`auto`)
bb's workspace sandbox applies; "built from" flags any write outside the
thread's storage.

## Generated pages are untrusted

A view is written by a model that has just read arbitrary files, and a
hostile file can tell it what to write. egg treats every view as untrusted,
with three barriers so that none is the only one:

- **An allowlist.** egg parses the view with the browser's own parser into
  an inert document and writes back only allowlisted elements and
  attributes: text structure, tables, lists, details, inline SVG shapes and
  text, and styles. Every `meta`, `link`, `base`, `script`, frame, object,
  form and `on*` attribute goes, and so does every attribute that holds an
  address (`href`, `src`, `action`, …) except an image's `data:` source. A
  link keeps its text, with its address as a tooltip. In CSS, `@import` and
  any `url()` that is not `data:` are made invalid.
- **A sandboxed frame with a strict policy.** The view is shown in an iframe
  with `srcdoc` and an empty `sandbox` attribute (no scripts, no same
  origin, no forms, no popups), and its document starts with a
  Content-Security-Policy that blocks every request.
- **An outer frame.** That iframe sits inside a second one written by egg,
  whose policy has `frame-src 'none'`. A frame navigating itself (a
  clicked link) is not stopped by its own policy, but Chrome checks it
  against the parent's, so the navigation is blocked before any request.

A view cannot reach bb's page, its storage, its cookies, or the network.
One limit: on a mouse press on an `https:` link, Chrome opens a connection
to the link's host (a preconnect) even when the navigation is blocked. No
request is sent, but the host name is looked up. Only the allowlist stops
this, by leaving no addresses in the view.

`node scripts/sandbox-check.mjs` proves all of this in headless Chrome. One
view tries parent access, cookies, storage, fetch, XHR, beacons, sockets,
images, stylesheets and a refresh. Then each view in `test/hostile.ts`
(attribute tricks, meta refreshes, SVG links, image maps, forms, `<base>`,
prefetches, CSS `url()` and `@import`, encoded addresses, parser
confusion) is shown three ways: as shipped, with only the frames, and with
only the allowlist. Every element in it gets a real click. A local listener
must see no request.

## Settings

`bb plugin config egg` lists them: models for views and for planning, the
provider, the permission mode for view threads, the rooms directory, the
hold-to-talk key (Space, backquote, or off), *send a pasted line at once*,
and the prefix of thread titles.

## Development

```sh
npm test                     # unit tests
npm run typecheck
node scripts/sandbox-check.mjs   # needs Chrome
node scripts/e2e.mjs --folder <absolute folder> [--plugin <id>]   # needs Chrome and a running bb
```

## Licence

MIT
