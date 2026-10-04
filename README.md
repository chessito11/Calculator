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
