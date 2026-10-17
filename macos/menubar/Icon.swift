// The Nidum grid mark (design/dashboard-light.html, the 28 px brand SVG) drawn in code
// as a monochrome template image, so it follows light and dark menu bars.
//
// The mark is a 6×6 grid of 14-unit squares on a 16-unit pitch in a 100-unit box, here
// snapped to whole device pixels. The filled squares form an "N"; the rest are thin
// outlines at reduced opacity. The amber square of the colour mark (row 3, column 3) is
// drawn solid: template images are single-colour.
//
// Centred (N7 validation 2 P1: the 18 pt version sat 1 px towards the top left). Six
// squares on a whole-pixel pitch are 5 × pitch + side wide; at 1x that is 5 × 3 + 2 = 17 px,
// which can't be centred in 18 px. So the image is 17 pt square and the mark fills it
// exactly at both scales, with the same geometry (2x is 1x doubled):
//   1x: 2 px squares on a 3 px pitch (17 px);   2x: 4 px squares on a 6 px pitch (34 px).
// The status item centres the image itself.

import AppKit

enum Icon {
    /// 1 = filled, 0 = outlined. Row 0 is the top row.
    static let grid: [[Int]] = [
        [1, 0, 0, 0, 0, 1],
        [1, 1, 0, 0, 0, 1],
        [1, 0, 1, 0, 0, 1],
        [1, 0, 0, 1, 0, 1],
        [1, 0, 0, 0, 1, 1],
        [1, 0, 0, 0, 0, 1],
    ]

    /// The image's size in points (square).
    static let size: CGFloat = 17

    /// Alpha of the outlined squares (the design uses 0.3; a 1 px outline needs a little
    /// more to stay visible at menu bar size).
    static let outlineAlpha: CGFloat = 0.45

    /// The mark as a template image `height` points square (17 by default), snapped to
    /// whole device pixels at the scale it is drawn at (NSImage redraws the handler per
    /// backing scale). In points: 2 pt squares on a 3 pt pitch, no margin (5 × 3 + 2 = 17).
    ///   - 2x and up (Retina): outlines are 0.5 pt (1 px at 2x), corners slightly rounded.
    ///   - 1x: outlined squares are filled at the outline alpha, since a 1 px outline on a
    ///     2 px square covers it anyway. No rounding (sub-pixel corners would blur).
    /// The same 6×6 cells are filled or outlined at every scale; only the snapping differs.
    static func templateImage(height: CGFloat = size) -> NSImage {
        let image = NSImage(size: NSSize(width: height, height: height), flipped: true) { rect in
            let scale = deviceScale()
            let u = rect.height / 17
            let pitch = 3 * u, side = 2 * u
            // Centred in whatever rect we get (no offset at the design size).
            let margin = (rect.height - (5 * pitch + side)) / 2
            func cell(_ r: Int, _ c: Int) -> NSRect {
                NSRect(x: rect.minX + margin + pitch * CGFloat(c), y: rect.minY + margin + pitch * CGFloat(r), width: side, height: side)
            }
            if scale < 1.5 {
                // 1x: whole pixels (1 pt = 1 px at u = 1).
                for (r, row) in grid.enumerated() {
                    for (c, filled) in row.enumerated() {
                        (filled == 1 ? NSColor.black : NSColor.black.withAlphaComponent(outlineAlpha)).setFill()
                        cell(r, c).fill()
                    }
                }
                return true
            }
            NSColor.black.setFill()
            NSColor.black.withAlphaComponent(outlineAlpha).setStroke()
            let line = 0.5 * u
            for (r, row) in grid.enumerated() {
                for (c, filled) in row.enumerated() {
                    let box = cell(r, c)
                    if filled == 1 {
                        NSBezierPath(roundedRect: box, xRadius: 0.35 * u, yRadius: 0.35 * u).fill()
                    } else {
                        let path = NSBezierPath(roundedRect: box.insetBy(dx: line / 2, dy: line / 2), xRadius: 0.25 * u, yRadius: 0.25 * u)
                        path.lineWidth = line
                        path.stroke()
                    }
                }
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = Titles.accessibilityLabel
        return image
    }

    /// Device pixels per point of the context being drawn into (1 when unknown).
    private static func deviceScale() -> CGFloat {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return 1 }
        let t = ctx.userSpaceToDeviceSpaceTransform
        return max(abs(t.a), abs(t.d), 1)
    }

    /// Writes the icon as a PNG (`scale` pixels per point) for visual checks.
    static func writePNG(to path: String, height: CGFloat = size, scale: CGFloat = 2) -> Bool {
        let image = templateImage(height: height)
        let px = Int((height * scale).rounded())
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { return false }
        rep.size = NSSize(width: height, height: height)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(x: 0, y: 0, width: height, height: height))
        NSGraphicsContext.restoreGraphicsState()
        guard let data = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? data.write(to: URL(fileURLWithPath: path))) != nil
    }
}
