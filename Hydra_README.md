# Claude Code Hydra

A self-contained pixel-art hydra that animates on a `<canvas>`. Single HTML file,
no dependencies, no build step. Designed to be driven by external code — every
behavior is reachable through a JS API or a `postMessage` bridge.

Open `web/hydra.html` in a browser, or embed it in an `<iframe>`.

It is wired into the harness dashboard (`web/index.html`): the **Fleet hydra** panel
embeds `web/hydra.html?embed=1` (which hides the manual controls) and the dashboard's
2s status poll drives it via `setState` — **one head per worker**, and the **vibe tracks
fleet state**: `sleepy` (idle) · `busy` (workers running) · `disco` (integrating) ·
`panic` (a worker failed or integration escalated) · `chill` (all done). The server
serves it at `/hydra.html`.

---

## Vibes

Seven animation modes. Switch with `hydra.setVibe(name)` or the buttons.

| Vibe     | Behavior                                                              |
|----------|-----------------------------------------------------------------------|
| `chill`  | Default calm sway.                                                     |
| `busy`   | Faster, wider neck motion.                                            |
| `zen`    | Very slow, gentle.                                                     |
| `disco`  | Heads cycle through colors; single-color pixel fireworks up top.      |
| `panic`  | Frantic speed, max neck wobble, wide eyes + open mouths.              |
| `snek`   | Necks get a 3× wobble multiplier — serpentine.                       |
| `sleepy` | Heads droop and doze (zzz), with a moon, twinkling + shooting stars. |

Ambient layers (`moon`, twinkle stars, shooting stars, fireworks) cross-fade in
and out as you switch vibes, so transitions are smooth rather than abrupt.

Head count is independent of vibe: 1–18, set via slider or `setHeads(n)`.

---

## JavaScript API

All methods live on the global `window.hydra`.

### Setters
| Method                 | Description                                              |
|------------------------|----------------------------------------------------------|
| `addHead()`            | Add one head (max 18). Returns new count.                |
| `removeHead()`         | Remove one head (min 1). Returns new count.              |
| `setHeads(n)`          | Set exact count, clamped 1–18. Returns new count.        |
| `setVibe(name)`        | Set vibe by name. Returns `true` if valid, else `false`. |
| `setState({count,vibe})` | Restore both at once; fires a single `change`. Returns snapshot. |

Setters sync the on-screen controls automatically, so driving the widget
externally keeps the slider and vibe buttons in agreement.

### Getters
| Method            | Returns                                                        |
|-------------------|----------------------------------------------------------------|
| `count()`         | Current head count (number).                                   |
| `getVibe()`       | Current vibe name (string).                                    |
| `getVibeIndex()`  | Current vibe index (number).                                   |
| `listVibes()`     | Array of all vibe names.                                       |
| `getEndpoints()`  | `[{index, color, x, y}]` — live chin coords + color per head.  |
| `getState()`      | `{count, vibe, vibeIndex, endpoints}` — full snapshot.         |

> **Coordinate space:** endpoint `x`/`y` are in **canvas pixels** (0–680 × 0–440),
> not screen pixels. If you overlay DOM elements, multiply by the canvas's
> rendered scale (`canvas.clientWidth / 680`).

### Events
Subscribe instead of polling. `on()` returns an unsubscribe function.

```js
const stop = hydra.on('change', state => {
  console.log(state.vibe, state.count);
});
// later:
stop();              // or hydra.off('change', cb)
```

| Event    | Fires when…             | Payload                          |
|----------|-------------------------|----------------------------------|
| `change` | Any head or vibe change | full snapshot (same as getState) |
| `head`   | Head count changes      | `{count, prev}`                  |
| `vibe`   | Vibe changes            | `{vibe, prev}`                   |

Programmatic calls that don't change anything (e.g. `setHeads` to the current
count) do **not** fire events.

---

## postMessage bridge (iframe embeds)

When the widget runs inside an `<iframe>`, a parent page can drive it across the
frame boundary without direct access to `window.hydra`.

### Parent → widget (commands)
Post a message with `source: 'hydra-cmd'`, a `cmd` (any API method name), and an
optional `arg`:

```js
const frame = document.getElementById('hydra-frame');

frame.contentWindow.postMessage(
  { source: 'hydra-cmd', cmd: 'setVibe', arg: 'disco' }, '*'
);
frame.contentWindow.postMessage(
  { source: 'hydra-cmd', cmd: 'setHeads', arg: 12 }, '*'
);
frame.contentWindow.postMessage(
  { source: 'hydra-cmd', cmd: 'getState' }, '*'
);
```

Supported `cmd` values: `setVibe`, `setHeads`, `addHead`, `removeHead`,
`setState`, `getState` (plus any other method on `window.hydra`).

### Widget → parent (messages)
The widget posts back to its parent:

```js
window.addEventListener('message', e => {
  if (e.data?.source !== 'hydra') return;
  if (e.data.type === 'change') {
    // pushed automatically on every state change
    console.log('state changed:', e.data.detail);
  }
  if (e.data.type === 'reply') {
    // response to a command you sent
    console.log(e.data.cmd, '→', e.data.result);
  }
});
```

- `{ source:'hydra', type:'change', detail }` — pushed on every change. No polling needed.
- `{ source:'hydra', type:'reply', cmd, result }` — sent after each command you post.

> Replace the `'*'` target origin with your actual origin in production to avoid
> leaking messages to untrusted frames.

---

## Quick examples

```js
// Read current state
hydra.getState();           // {count: 5, vibe: 'chill', vibeIndex: 0, endpoints: [...]}
hydra.getVibe();            // 'chill'
hydra.count();              // 5

// Drive it
hydra.setVibe('sleepy');
hydra.setHeads(9);
hydra.setState({ count: 3, vibe: 'disco' });

// React to changes
hydra.on('vibe', ({vibe, prev}) => console.log(`${prev} → ${vibe}`));

// Wire external nodes to each head's chin (live)
function tick() {
  for (const ep of hydra.getEndpoints()) {
    // ep.index, ep.color, ep.x, ep.y  (canvas-space coords)
  }
  requestAnimationFrame(tick);
}
tick();
```

---

## Notes

- The slider/buttons are just one control surface. If your separate interface
  drives `setHeads`/`setVibe` externally, the on-screen controls stay in sync
  automatically — and you don't need to render them on your end at all.
- No external requests, no storage, no globals beyond `window.hydra`.
- The canvas is fixed at 680×440 internal resolution and scales responsively.
