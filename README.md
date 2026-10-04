# ATLAS Takeoff — Version 1

Standalone browser-based DXF wall framing takeoff prototype.

## What V1 does

- Opens ASCII DXF files directly in the browser.
- Reads LINE, LWPOLYLINE, and basic POLYLINE geometry.
- Lets you tap/select a line as a wall.
- Assigns a wall number, height, stud size, gauge, spacing, top track, and bottom track.
- Calculates stud quantity without drawing individual studs.
- Supports double end studs and a waste percentage.
- Keeps takeoff quantities separated by wall number.
- Builds a combined material summary grouped by stud size, gauge, and height.
- Exports the wall takeoff as CSV.
- Supports pan and zoom, including touch/pinch use.

## Run it

No server or installation is required for the basic prototype.

1. Put `index.html`, `style.css`, and `app.js` in the same folder.
2. Open `index.html` in a modern browser.
3. Choose **Open DXF**.
4. Select the correct DXF units if Auto cannot detect them.
5. Tap a line, enter wall properties, and press **Save Wall**.

It is also suitable for GitHub Pages because it is a static site.

## Current stud formula

For a straight wall without openings:

`base studs = ceil(wall length in inches / spacing) + 1`

If **Double end studs** is checked, two extra studs are added (one additional stud at each end).

Waste is then applied and the result is rounded up.

This is intentionally a simple first-pass framing rule. Doors, windows, intersections, corners, jambs, headers, cripples, kickers, and special framing conditions should be handled in later versions rather than hidden inside the basic formula.

## DXF notes

Version 1 is deliberately lightweight and dependency-free. It currently focuses on straight segments from:

- LINE
- LWPOLYLINE
- POLYLINE / VERTEX

Arcs, splines, blocks/inserts, dimensions, and text are not required for wall takeoff yet and are not used as selectable wall geometry in V1.

## Suggested next steps

1. Add a calibration tool: select two points and enter a known dimension.
2. Add openings (doors/windows) to a wall record.
3. Add corner/intersection rules.
4. Add drywall and insulation quantities.
5. Add project save/open.
6. Add Excel export and printable takeoff report.
7. Add wall color/status filters and search by wall number.


## iPhone / iPad file picker

Version 1.1 uses a real **Open DXF** button and intentionally does not use an HTML `accept` filter. Some iOS/Safari versions hide `.dxf` files when that filter is present.

Tap **Open DXF**, choose **Browse**, then select the DXF from Files / iCloud Drive / Downloads.


## Version 1.2 — scale calibration

For DXF files converted from PDF or other sources where drawing units may not be trustworthy:

1. Open the DXF.
2. Press **Calibrate Scale**.
3. Tap the first point of a known dimension.
4. Tap the second point.
5. Enter the actual feet and inches.
6. Press **Apply Calibration**.

ATLAS Takeoff stores a calibrated feet-per-DXF-unit factor and uses it for all wall lengths, stud counts, track quantities, and CSV output. Changing the DXF unit setting resets calibration so an old scale cannot silently remain attached to a different unit interpretation.


## Version 1.3 calibration controls

Calibration now matches the ATLAS Layout style:

1. Tap **Scale 1**, then tap the first known point.
2. Tap **Scale 2**, then tap the second known point.
3. Enter the known feet/inches.
4. Tap **Apply Calibration**.

Scale 1 and Scale 2 can be changed independently. The active Scale button is highlighted, and each selected point is marked `1` or `2` on the drawing.


## Version 1.4 — WALL tool restored and made explicit

No takeoff functionality was removed.

The top toolbar now has three independent working controls:

- **WALL** — select a DXF line and show all wall takeoff options.
- **Scale 1** — set the first scale point.
- **Scale 2** — set the second scale point.

After calibration is applied, the app automatically returns to **WALL** mode. On iPad/mobile, selecting a wall also brings the full Selected Wall panel into view.

The existing wall fields remain:
wall number, length, height, stud size, gauge, spacing, top track, bottom track, double end studs, waste, calculated studs, calculated track, wall takeoff table, material summary, and CSV export.


## Version 1.5 — Manual corner tracing + Wall Type Library

This version keeps all previous functionality and adds two new workflows.

### TRACE WALLS — manual corner-to-corner selection

This works like the point sequence used in ATLAS Layout, but there are no X1/X2 labels.

1. Choose the **Active type** (optional).
2. Tap **TRACE WALLS**.
3. Tap the first DXF corner/end point.
4. Tap the next corner. A wall is created between those two points.
5. Keep tapping the next corners to create wall after wall.

The trace mode snaps only to DXF endpoints/corners. It does not automatically choose a point along a line. The original **WALL** tool still selects existing DXF line segments normally.

Each traced segment is automatically saved as a wall with the current Active Type and receives the next W-### wall number.

### Wall Type Library

Wall types are reusable framing assemblies stored in the browser.

A wall type stores:

- Height
- Stud size
- Gauge
- Stud spacing
- Top track type
- Bottom track type
- Double end stud setting
- Waste percentage

Enter a type name such as `W1`, `W2`, or `Shaft Wall` and press **Save / Update Type**. The type then appears in the Active Type selector and can be applied to future walls.

### Wall Type Totals

Walls are grouped by type and the program totals:

- Number of walls
- Total wall length
- Total stud quantity
- Total top track LF
- Total bottom track LF

The detailed Wall Takeoff table also shows the type assigned to each individual wall, and CSV export now includes the Wall Type column.
