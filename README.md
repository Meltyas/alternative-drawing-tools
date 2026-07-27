# Alternative Drawing Tools

Better drawing tools for Foundry VTT (v14). Foundry's native freehand tool samples the pointer every ~75ms, producing jagged polygons; this module captures every mouse event, bakes smoothing into the stroke, and saves everything as native scene Drawings — so persistence, syncing, and permissions are handled by the core.

## Tools

A floating toolbar appears at the top of the canvas when the layer is active:

| Tool | Shortcut | Notes |
|---|---|---|
| Tool lock | — | Keep the active tool after drawing (default on) |
| Hand | `H` | Pan the map |
| Select / move | `1` / `V` | Click or drag a marquee; `Shift`+click adds; `Ctrl+A` selects all; drag moves the group; `Del` deletes |
| Rectangle | `2` / `R` | `Shift`: square |
| Diamond | `3` / `D` | |
| Ellipse | `4` / `O` | `Shift`: circle |
| Arrow | `5` / `A` | `Shift`: 15° angle snap |
| Line | `6` / `L` | `Shift`: 15° angle snap |
| Pencil | `7` / `P` | High-precision freehand, WYSIWYG smoothing |
| Text | `8` / `T` | Click to place |
| Eraser | `0` / `E` | Cuts only the part of the stroke you touch |

Plus undo (`Ctrl+Z`), a GM-only delete-all (double-confirmed), and a styles panel: stroke colors (with saveable custom swatches — `+` to save, right-click to remove), fills, width presets plus a custom value, sloppiness, edges, opacity, and layer ordering. With an active selection, the styles panel edits the selected strokes instead.

## Wheel shortcuts (while the layer is active)

| Shortcut | Action |
|---|---|
| `Shift` + wheel | Stroke width (or eraser size when the eraser is selected) |
| `Ctrl` + wheel | Next/previous palette color |
| `Alt` + wheel | Opacity |

## Sketchy style

Pick a sloppiness level in the styles panel and shapes get a deterministic hand-drawn look: each stroke is drawn twice with subtle deviations, and closed shapes get slightly overlapping seams. The preview and the final stroke are always identical.

## Players

All players can draw, move, and erase any stroke: their operations are executed through the GM's client via [socketlib](https://github.com/manuelVo/foundryvtt-socketlib) (required dependency). A GM must be connected.

## Installation

Install via manifest URL:

```
https://github.com/Meltyas/alternative-drawing-tools/releases/latest/download/module.json
```

Or copy the folder into `Data/modules/` and enable **Alternative Drawing Tools** in your world. The first activation requires a world restart so the socket flag is registered.
