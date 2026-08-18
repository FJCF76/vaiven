# App mode

Automatic mode restores **values**, not **structure**. If the person can add, remove or
reorder rows, a reload would put the values back into a form that no longer has anywhere to
put them. That is when you take over.

Calling `Vaiven.render()` switches automatic capture off and hands you the document.

```html
<ul id="list"></ul>
<button id="add">Add a row</button>

<script>
// One node per row, kept across repaints. Rebuilding a row would destroy the field
// somebody is typing into — see the warning below.
const nodes = new Map();

function makeRow(id) {
  const li = document.createElement("li");
  const text = document.createElement("input");
  text.onchange = () => Vaiven.mutate(s => {
    const row = s.items.find(i => i.id === id);
    if (row) row.text = text.value;
  });
  const del = document.createElement("button");
  del.textContent = "Remove";
  del.onclick = () => Vaiven.mutate(s => { s.items = s.items.filter(i => i.id !== id); });
  li.append(text, del);
  nodes.set(id, { li, text });
  return nodes.get(id);
}

Vaiven.render(s => {
  const items = s.items ?? [];          // always defensive: state outlives your markup
  for (const [id] of nodes) {           // rows that went away
    if (!items.some(i => i.id === id)) nodes.delete(id);
  }
  for (const item of items) {           // rows that are new, and values that moved
    const node = nodes.get(item.id) ?? makeRow(item.id);
    if (node.text !== document.activeElement) node.text.value = item.text ?? "";
  }
  // Touch the DOM only when the rows actually changed. Re-inserting a node cancels a
  // click that is already in flight over it, even if the node itself is reused.
  const want = items.map(i => nodes.get(i.id).li);
  const have = [...list.children];
  if (want.length !== have.length || want.some((li, k) => li !== have[k])) {
    list.replaceChildren(...want);
  }
  for (const el of document.querySelectorAll("input,button")) el.disabled = Vaiven.readonly;
});

add.onclick = () => Vaiven.mutate(s => {
  (s.items ??= []).push({ id: crypto.randomUUID(), text: "" });
});
</script>
```

## The rules

**`render(fn)`** registers your painter. It runs when state arrives and after every change,
including changes made by you on a later turn or by another person right now.

**`mutate(fn)`** is the only way to change state. Mutate the draft it hands you; the diff,
the save and the event log all happen for you.

**`render` runs again after every `mutate`, including your own.** The obvious painter —
`replaceChildren` on every render — breaks in two ways that read as browser bugs. Mutate on
each keystroke and the repaint destroys the input being typed into: one character, focus
lost, the rest goes nowhere. Mutate on `change` instead and the next click is swallowed,
because moving focus fires `change`, which repaints and re-inserts the button before the
click lands on it.

Reusing the node is not sufficient either: re-inserting a node — which `append` and
`replaceChildren` both do, even to a node already in place — cancels a click in flight over
it. Give each row a stable id of your own, update values in place, skip the field holding
focus, and rewrite the list only when rows are added, removed or reordered. That is what
the example above does.

**Never call `mutate` from inside `render`.** It loops forever. Both the helper and the
shell will stop you, loudly, but the fix is to move the mutation into an event handler.

**Never assume a field exists.** `s.items ?? []`, always. You will republish this app while
old state is live — that is the central loop, not an edge case — and a structural change is
fixed with one `PUT /state`, not with migration machinery.

**Array elements carry `_vid`.** Leave it alone and let it round-trip. It is how an edited
row is told apart from a new one, so the log can say `items[Extra budget].cost: 0 → 5000`
instead of a meaningless index.

**`Vaiven.log(kind, payload)`** appends a note. Your `kind` travels as the note *text* and
the event reads back with kind `note`, so filter on the text or the payload rather than on
the string you passed. It does not change state, but it does bump the version.
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
