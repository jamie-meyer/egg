# Who can make egg act

bb serves every plugin's methods on your own machine (loopback) and does not
say who is calling. Any local process that can reach bb can call them: by
HTTP, or with `bb plugin rpc call`. That includes an agent thread inside bb's
command sandbox.

A line in a room is a message from you to a thread that builds and runs
things in a copy of your folder. So egg does not take a caller's word for
anything. Your browser proves each call is yours with a signature, and egg
refuses everything else.

This page says what is signed, what is not, and what signing cannot protect.

## What is signed

Everything egg does. Each of these is carried out only for a call signed by
a key that is enrolled with egg:

| Action | What it does | Key on the page |
| --- | --- | --- |
| `room_create` | makes a room on a folder and starts its first round of threads | `n` |
| `say` | a line from you: starts a round of views, work for the room thread, or both | `i`, paste, hold-to-talk |
| `work` | a line straight to the room thread | `w` |
| `worker_stop` | stops the room thread's turn and its open runs | `S`, `y` |
| `more` | four variations of a view (four threads) | `m` |
| `cross` | crosses two views (threads) | `x` |
| `zoom` | a child room about a part of a view, and its first round | `z` |
| `pin` | pins or unpins a view as context for the next lines | `p` |
| `decide` | keep (writes files in the room's directory), drop, or undo either (removes the kept files) | `y`, `d`, `u` |
| `room_delete` | takes a room out of egg and archives its threads | `D` |
| `room_restore` | puts a deleted room back | `u` |
| `note` | a trouble line the page writes in your notebook (a failed transcription) | (the page itself) |
| `key_approve`, `key_refuse`, `key_remove` | approve or refuse a browser that asks to be enrolled; remove a key | `A` then `y`, `X` |
| `defaults` | read: the default folder, the rooms directory, bb's project checkouts | |
| `rooms_list` | read: every room's subject, folder and counts | `r` |
| `room_get` | read: a whole room: every line, round and view record | |
| `view_content` | read: one view's page | |
| `ledger` | read: the room thread's runs | |
| `worker_status` | read: the room thread's status line | |

The list is `ACTIONS` in `src/signing/actions.ts`. None of these is a method
of egg's interface any more. There is one method, `signed`, and it looks at
nothing of a call before its signature is good.

**Reads are signed too.** They hold your lines and every page, and signing
them costs nothing you can see: measured, a signature takes the page about
0.05 ms, and a whole signed read about 0.2 ms longer than an unsigned call.
This closes egg's interface to other callers. It does not make
your rooms secret from a thread on your machine: see "What egg cannot
guarantee".

### What the signature covers

The page signs one text, and the backend rebuilds that text from the call it
received and checks the signature against it. The text holds:

- **which installed egg it is for** (the plugin's id), so a call signed for
  one installed copy is no use against another that trusts the same browser;
- **the action's name**;
- **every argument**, exactly: the room, the view, the folder, the words of
  the line, where the line came from (typed, voice, pasted);
- **the time it was signed**, by egg's clock. A call signed more than two
  minutes before or after egg's clock is refused. So is one signed before
  egg last started;
- **a nonce**, used once. The same signed call sent again is refused, and so
  is a new call that reuses a nonce.

Change any of these after signing and the signature no longer matches.

The key is ECDSA P-256, made by the browser's WebCrypto as non-extractable,
and kept in that browser's IndexedDB for bb's address under a name that
includes the plugin id. No script, egg's included, can read the private half
out. The public half is what egg stores. A key is shown as a short
fingerprint, such as `445f-d491-2add-8ca0`.

The answer to a call is not signed or encrypted. It travels over loopback
like everything else bb serves.

## Enrolment

**The first browser.** With no key enrolled, the first page to open egg is
enrolled. It says nothing about it. This is trust on first use: open egg's
page yourself after installing or updating to this version, before agents
run.

**Another browser** (bb's web page as well as its desktop app, a second
machine) is not enrolled by opening egg. It shows nothing, and one line:

> This browser is not enrolled with egg, so egg shows nothing and does
> nothing here. Its key is 1a2b-3c4d-5e6f-7a8b. Open egg in a browser where
> it already works: it shows this key there, and A, then y, approves it. …

Every enrolled page then shows a line with that key. Approve it only if you
have just opened egg in another browser and it shows the same key: the name
beside the key is the asking browser's own word. `A` asks first, and only
`y` approves; `X` refuses. Approving, refusing and removing are signed like
everything else, so only an enrolled browser can do them.

**If egg works in no browser of yours**, something else was first, or the
browser that was enrolled lost its storage. From your own terminal:

```sh
mkdir -p ~/.bb/plugins/egg && touch ~/.bb/plugins/egg/reset-enrollment
```

(The page prints the exact path: `plugins/<plugin id>/reset-enrollment`
under bb's data directory.) egg removes the file, forgets every key and
every request, and the next page to open is enrolled. The file is under bb's
data directory because bb's command sandbox does not let a thread write
there.

**When a call is refused** for a reason of signing, the page says so in the
notebook in plain words ("Not sent: this browser is not enrolled with egg.
The line at the top of this page says what to do."), and the line stays
until the browser is enrolled. If egg restarted or the computer's clock
moved, the page reads egg's clock again and signs once more by itself; you
see nothing.

## What is not signed, method by method

egg's whole interface is three methods. All three are open to any local
process.

| Method | What it does | What a caller can read or change with it |
| --- | --- | --- |
| `signed` | carries out one action, when the call is signed by an enrolled key | Nothing without a valid signature. An unsigned, forged, replayed, stale or altered call is refused and changes nothing. |
| `keys_state` | reads enrolment | **Reads:** the plugin id; each enrolled key's public half, fingerprint, the name its browser gave itself, how and when it was enrolled, which key approved it, and when it last signed (to the minute); the same for each request; egg's clock; the path of the reset file. **Changes:** nothing. It tells a caller that you use egg, from which browsers, and roughly when you last did. |
| `key_enrol` | presents a public key | **On an egg with no key enrolled: that key is enrolled**, and its holder can do everything above. Your own page then says it is not enrolled; that line is the evidence, and the reset file is the way back. **Otherwise:** it adds a request, under a name of the caller's choosing, that every enrolled page shows until you answer it. At most 8 are kept; a request you refused gives way to a new one, one still waiting never does. A request can do nothing until you approve it with `A`, `y`. It cannot read anything. |

Other ways in, which are not methods:

| Way in | What it can do |
| --- | --- |
| egg's settings (`bb plugin config egg set …`, or bb's settings screen) | **Not signed, and a sandboxed thread can change them** (tried: see below). bb owns settings and does not tell a plugin who changed one. A caller can change, for threads egg starts from then on: the model and provider of each role (what your lines cost and who receives them), the **permission mode** of views, the planning step and a new room thread (`full` lifts bb's sandbox), **where a new room thread works** (`in-place` is your folder itself), the rooms directory (where kept files are written), how often egg wakes the room thread, the largest file copied out, the thread title prefix, the hold-to-talk key and *send a pasted line at once*. It cannot make egg start anything: that still takes a signed line. |
| bb's realtime channels `room-changed` and `keys-changed` | egg publishes a room's id when it changes, and nothing when enrolment changes. Whoever can listen to bb's channels learns that, and when. |
| a thread carrying the mark of one of egg's view threads | egg reads a view only from the thread it started for it, so another thread cannot supply a view's page or end a view early. |
| the page opener and its shortcut | they open the page. They do nothing for you. |

There are no CLI commands and no HTTP routes of egg's own.

## What egg cannot guarantee

Signing stops a caller from acting as you **through egg**. It rests on
things egg does not control.

- **The key is in your browser profile's files.** It cannot be exported
  through the browser, but it is on disk in the profile, and bb's sandbox
  lets a thread read most of the disk (the profile's IndexedDB folder can be
  listed from inside it). An agent that parsed those files could take the
  key and sign as you; egg would not know. So could anything that runs
  script on bb's own address in your browser (another plugin's page, which
  bb already trusts fully), and anything that drives your browser with your
  profile.
- **A thread in `full` permission mode is not sandboxed.** It can create the
  reset file and be the next key enrolled, rewrite egg's storage in bb's
  database, and rewrite the rooms directory. Your page would then say it is
  not enrolled, or show rooms you did not make.
- **`bb thread tell` already speaks as you.** bb lets any thread send a
  message to another thread, and a caller that does not say which thread it
  is counts as you. So an agent can message the room thread directly, as
  you, without egg. That is bb's, and a plugin cannot fix it. Such a message
  is not a line in the notebook; it is in the room thread's chat (`t`).
- **Reading.** egg's storage is in bb's database, which a sandboxed thread
  can open for reading (not for writing). The rooms directory is plain
  files. bb also lets a thread read other threads, and egg's threads carry
  your lines as their prompts. Signed reads close egg's own interface; they
  do not hide your rooms from a thread on your machine.
- **The material in `.egg/` is the room thread's own.** Its notes, ledger
  lines and pages are written by the room thread, in a workspace it and
  anything else working there can write. egg vouches only for runs made
  through its runner (see the README). A note in the notebook marked ◆ is
  the room thread's word, not yours and not egg's.
- **Settings.** As the table above says, a thread can change egg's settings
  with `bb plugin config`. The page does not show that a setting changed.
  If it matters, look at `bb plugin config egg` before a long piece of work.
- **First use.** Whatever opens an egg with no key first is enrolled.
- **The plugin's own code.** bb runs a plugin from where it was installed.
  If that is a folder a thread can write (a checkout an agent works in), the
  thread can change what egg is. `bb plugin disable` and `bb plugin
  uninstall` are open to a thread too.
- **Requests can nag.** Any caller can make your page show up to 8 requests
  under any name. None can do anything until you press `A`, `y`. Do that
  only for a key you can see in a browser of yours.

## The probe

`scripts/probe.mjs` tries every action from the position of a process
without your key, and `npm run e2e` runs it as its `probe` section, against
a copy for checks only. For each of the 21 actions it tries:

- the old method name, the way egg 0.2.0 took it (refused: no such method);
- `signed` with the arguments alone, and with no signature (refused: "egg
  acts only on calls signed by a browser enrolled with it");
- a made-up signature naming the enrolled key (refused: "the signature does
  not match the call");
- a signature by a key of its own, under its own name ("the key that signed
  this call is not enrolled with egg") and under the enrolled key's name
  ("does not match");
- a valid signature whose nonce was already used ("already used once");
- a valid signature that is too old ("signed too long ago");
- a valid signature with the arguments changed, with the action changed,
  and with the time changed ("does not match").

It also sends a whole signed call a second time, sends a call signed for
another installed copy, repeats some of this through `bb plugin rpc call`,
and asks to enrol a key of its own (which becomes a request and nothing
more). The valid signatures it misuses come from the e2e's own enrolled
key; those for changed arguments are signed for a room that does not exist,
so they do nothing if sent as they are. Before and after, the e2e reads
every room, ledger, file in the rooms' directories and enrolled key, and
checks that nothing changed.

With `--sandboxed`, run from inside an agent's command sandbox, it also
reports what only the sandbox stops. On bb 0.50 with the `claude-code`
provider's sandbox (the rooms directory was tried by hand):

| Tried from inside the sandbox | Result |
| --- | --- |
| all of the above, 252 calls | each refused; nothing changed |
| create the reset file | blocked: operation not permitted |
| open bb's database for writing | blocked |
| write a file in the rooms directory | blocked |
| open bb's database for reading | **open** |
| `bb plugin config <copy> set wakeMinutes 11` | **changed** (and put back) |

How to run it is in the README under Development.
