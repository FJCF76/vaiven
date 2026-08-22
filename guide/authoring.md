# Authoring a document you will republish

`PUT /content` takes one file. Nothing about the sandbox, the CSP or the two origins
constrains how you *author* it — only what you serve. So the question this page answers is
not "how do I publish", it is "what stops me rewriting the whole thing every time".

**The principle: a component is code that has stopped changing.** Code regenerated on every
revision is not a component however it is factored. Everything below exists so that parts of
a document can stop being rewritten.

## When this page applies

**One file is the right answer more often than not.** A form you write once, hand to somebody
and never touch again should be a single file, and nothing here applies to it. Publishing a
document must never take more than one call.

Reach for sources on disk when you expect to republish the document — typically, though not
always, one using `render`/`mutate`. That is the case where regenerating whole is expensive
and getting more so.

## Three shapes, none of them canonical

Only `dist.html` is contractual. These are starting points, not the anatomy of a Vaivén
document — a document can be a canvas, a generated layout, or forty lines, and none of those
wants the same tree.

**A. Single file.** Forty lines, no build step, nothing to assemble.

```
app.html                    -> published directly
```

**B. Split by concern.** The common shape for an app-mode document with lists and fields.

```
page.html                   structure
theme.css                   tokens and palette
app.js                      what is specific to this tool
components/list.js          reconciliation, focus, click-in-flight
components/field.js         field <-> state binding
assets/*.woff2              you inline these yourself; see below
build.sh                 -> dist.html
```

**C. Generated.** A canvas or WebGL document has almost no markup and no component tree; the
interesting code is the generator.

```
shell.html                  a canvas element and nothing else
sim.js                      the thing that actually runs
palette.js                  values, not styles
build.sh                 -> dist.html
```

If your document does not fit any of these, that is expected. The rule is the output, not
the tree.

## A build script

Concatenation is enough. There is no bundler here and none is wanted; the whole point is
that you can read the output.

Put two markers in `page.html`, each **alone on its line** — the marker's whole line is
replaced, so anything sharing it is lost:

```html
<!--STYLE-->
```

in `<head>`, and

```html
<!--SCRIPT-->
```

immediately before `</body>`. Then `build.sh` splices:

```bash
#!/usr/bin/env bash
set -euo pipefail
trap 'rm -f style.part script.part dist.html.part' EXIT

[ "$(grep -c '<!--STYLE-->'  page.html)" = 1 ] || { echo 'page.html needs exactly one <!--STYLE--> marker'  >&2; exit 1; }
[ "$(grep -c '<!--SCRIPT-->' page.html)" = 1 ] || { echo 'page.html needs exactly one <!--SCRIPT--> marker' >&2; exit 1; }

{ echo '<style>';  cat theme.css;               echo '</style>';  } > style.part
{ echo '<script>'; awk 1 components/*.js app.js; echo '</script>'; } > script.part

awk '
  /<!--STYLE-->/  { while ((getline line < "style.part")  > 0) print line; next }
  /<!--SCRIPT-->/ { while ((getline line < "script.part") > 0) print line; next }
                  { print }
' page.html > dist.html.part

grep -q '</style>'  dist.html.part || { echo 'build: the style block did not land' >&2; exit 1; }
grep -q '</script>' dist.html.part || { echo 'build: the script block did not land' >&2; exit 1; }

mv dist.html.part dist.html
```

**The script goes before `</body>`, not in `<head>`.** An inline classic script runs at the
point it is parsed, so one in `<head>` executes before the body exists and every
`getElementById` in it returns `null`. This is the single most common way an assembled
document silently does nothing.

**Assemble beside the target, then move it into place.** Writing straight to `dist.html`
truncates it before the first source is read, so a failure part-way through would leave a
half-written document where a working one used to be: closing tags absent, still valid enough
to publish, and the last good version gone. Building into `dist.html.part` and renaming means
a failed build leaves the previous `dist.html` untouched. Keep the part file in the same
directory as `dist.html`, because a rename is atomic only within one filesystem.

**Count the markers, then check the output.** A `page.html` that lost its marker would
otherwise build successfully — the splice simply finds nothing to replace — and install a
document with the style and script missing entirely. Counting catches the missing, duplicated
and shared-line cases with a useful message; re-reading the assembled file catches whatever
counting did not anticipate. Verifying the artifact matters more than verifying the inputs.

**`awk 1` rather than `cat`**, because it guarantees a newline after each file. `cat` does
not, so one source without a trailing newline silently welds its last line onto the next
file's first. A newline is not a complete answer, though: JavaScript only inserts a semicolon
where the next token cannot continue the expression, so **end every source file with a
semicolon** rather than trusting the line break.

**Order inside `<script>` is glob order, which is filename order, not the order you listed
the files in.** `components/field.js` loads before `components/list.js` whatever the tree
above suggests. Name files so the order falls out, or list them explicitly.

**What this does and does not catch.** An explicitly named source that disappears
(`theme.css`, `app.js`) stops the build, and so does a `components/` that matches nothing.
Deleting one file out of several the glob still matches does not: the build succeeds without
it. If a component is load-bearing, name it in the `awk 1` list instead of relying on the
glob.

**Use POSIX `awk`, not GNU-only `sed`.** `sed Q` is a GNU extension that BSD `sed` on macOS
rejects, and agents author on macOS constantly, so that failure lands on users rather than on
you. The `awk` above behaves identically under gawk, mawk and busybox awk.

**A literal `</script>` inside your JavaScript ends the script element.** The HTML parser
does not know about JS strings, so `var s = "</scr" + "ipt>"` is the fix and
`var s = "</script>"` truncates the document. The same applies to `</style>` in CSS. This
bites documents that generate markup, which is most of them.

**Nothing may precede the doctype.** `<!doctype html>` must be the first thing in
`dist.html`. A tag or any text before it — a banner `<script>`, a stray character — puts the
page into quirks mode, where the box model changes and layouts break in ways that look like
your CSS is wrong. Comments and blank lines before the doctype are tolerated by the parser,
and a byte-order mark may or may not be, depending on how the file is decoded; none of them
belong there either. Keep both markers inside the document, never above the doctype.

Fonts and images have to be inline, because the page has no network. **The script above does
not do this for you** — it copies your CSS and JS verbatim. Encode each asset and paste the
whole URI into `theme.css`:

```bash
printf 'url("data:font/woff2;base64,%s")\n' "$(base64 < assets/inter.woff2 | tr -d '\n')"
```

`base64 -w0` is GNU-only and fails on macOS, which is why the line pipes through `tr`
instead. `guide/limits.md` has the size caps this counts against.

## Never hand-edit `dist.html`

The moment you patch the assembled file instead of a source, the sources are lying. The next
build silently discards your fix, and you are back to a monolith without having noticed.

If the fastest path to a fix is editing `dist.html`, that is a signal the sources are wrong,
not permission to skip them. Fix the source and rebuild.

## What Vaivén sees, and does not

Vaivén receives `dist.html`. It never sees your sources and cannot recover them. They live on
whatever machine authored them, so unless you put them somewhere else **that machine is the
only copy**. Version control is the obvious somewhere else, and with reasonable commit
messages it also records *why* each change happened, which the published blob never can.

## The API your sources are written against

`window.Vaiven` has exactly six members: `state`, `readonly`, `render`, `mutate`, `note` and
`log`. `https://vaiven.owncompute.com/guide/app-mode.md` covers them in depth. Nothing on this
page changes them — assembling from sources is an authoring convenience, not a different
runtime.
