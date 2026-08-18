# App mode

Automatic mode restores **values**, not **structure**. If the person can add, remove or
reorder rows, a reload would put the values back into a form that no longer has anywhere to
put them. That is when you take over.

Calling `Vaiven.render()` switches automatic capture off and hands you the document.

```html
<ul id="list"></ul>
<button id="add">Add a row</button>

<script>
Vaiven.render(s => {
  const items = s.items ?? [];            // always defensive: state outlives your markup
  list.replaceChildren(...items.map(row));
});

add.onclick = () =>
  Vaiven.mutate(s => { (s.items ??= []).push({ text: "", done: false }); });
</script>
```

## The rules

**`render(fn)`** registers your painter. It runs when state arrives and after every change,
including changes made by you on a later turn or by another person right now.

**`mutate(fn)`** is the only way to change state. Mutate the draft it hands you; the diff,
the save and the event log all happen for you.

**Never call `mutate` from inside `render`.** It loops forever. Both the helper and the
shell will stop you, loudly, but the fix is to move the mutation into an event handler.

**Never assume a field exists.** `s.items ?? []`, always. You will republish this app while
old state is live — that is the central loop, not an edge case — and a structural change is
fixed with one `PUT /state`, not with migration machinery.

**Array elements carry `_vid`.** Leave it alone and let it round-trip. It is how an edited
row is told apart from a new one, so the log can say `items[Extra budget].cost: 0 → 5000`
instead of a meaningless index.

**`Vaiven.log(kind, payload)`** appends a note without changing state.
**`Vaiven.readonly`** is true when the viewer holds a read key — hide your controls.

## What the person sees around your app

A bar you do not control and cannot suppress: the title, the name their edits are recorded
under, save status, a **Done for now** button, and a panel showing them their own event log.
That bar is where they are told their edits are being recorded, because in automatic mode
you never know it is happening — so you cannot be the one to tell them.

## Links

Your page has no navigation rights, so anchors are intercepted: the shell shows the
destination and opens it if the person agrees. Write ordinary `<a href="https://…">` and it
works; `mailto:` too. `http:` and every other scheme is ignored.
