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
| `r` | the list of rooms, most recent first (`j` `k`, Enter) |
| `n` | a new room |
| `?` | the legend |

Keep and drop are instant and never ask anything.

## What it stores, and where

- **Rooms** (their lines, rounds, views and what each view was built from)
  are kept in egg's plugin storage inside bb's data directory, so they
  survive reloads and restarts.
- **Kept views are plain files.** Each room has a directory under the
  *Rooms directory* setting (default `~/egg`); the page shows its path.
  Keeping a view writes the view (`.html` or `.txt`) and a small `.json`
  beside it: the room, the line that produced it, its angle, the model, the
  time, and the "built from" list. Undoing a keep removes both files.
  Dropping a view takes it off the table, not out of the notebook.

## What it sends to model providers

egg runs agent threads through bb on the provider and models you choose
(defaults: `claude-code`, `claude-sonnet-5-5` for views and
`claude-haiku-5-5` for planning). **Those agents read the contents of the
folder a room points at**, and what they read goes to that provider. The
planning step sends the room's subject, its earlier lines and the names of
kept and dropped views. Hold-to-talk sends your recording to whatever voice
service bb is set to use.

The agents are told the folder is read only and to write only their view,
into their own thread storage. With the default permission mode (`auto`)
bb's workspace sandbox applies; "built from" flags any write outside the
thread's storage.

## Generated pages are untrusted

A view is written by a model that has just read arbitrary files. egg shows
each one in an iframe with `srcdoc` and an empty `sandbox` attribute (no
scripts, no same origin, no forms, no popups), and the document starts with
a Content-Security-Policy that blocks every network request. Meta refreshes,
`<link>` tags and link targets are taken out before it is shown. A view
cannot reach bb's page, its storage, its cookies, or the network.

`node scripts/sandbox-check.mjs` proves it in headless Chrome with a view
that tries parent access, cookies, storage, fetch, XHR, beacons, sockets,
images, stylesheets and a refresh.

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
node scripts/e2e.mjs --folder <absolute folder>   # needs Chrome and a running bb; runs one round
```

## Licence

MIT
