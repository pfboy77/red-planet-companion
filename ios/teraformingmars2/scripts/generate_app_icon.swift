#!/usr/bin/swift

import AppKit

let canvasSize = 1024
let outputURL = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "AppIcon.png")

guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
      let bitmapContext = CGContext(
        data: nil,
        width: canvasSize,
        height: canvasSize,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
      ) else {
    fatalError("Could not create an opaque RGB bitmap")
}
let graphicsContext = NSGraphicsContext(cgContext: bitmapContext, flipped: false)

func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat, alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: red / 255, green: green / 255, blue: blue / 255, alpha: alpha)
}

func circle(center: NSPoint, radius: CGFloat) -> NSBezierPath {
    NSBezierPath(ovalIn: NSRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphicsContext
graphicsContext.shouldAntialias = true

let canvas = NSRect(x: 0, y: 0, width: canvasSize, height: canvasSize)
NSGradient(starting: color(8, 15, 31), ending: color(22, 30, 54))?.draw(in: canvas, angle: 90)

// A restrained star field gives the silhouette depth without introducing text or trademarks.
for star in [
    (118, 826, 5), (201, 704, 3), (851, 815, 4), (914, 643, 3),
    (92, 454, 3), (805, 350, 4), (179, 234, 4), (884, 202, 3),
] {
    color(232, 238, 248, alpha: 0.42).setFill()
    circle(center: NSPoint(x: star.0, y: star.1), radius: CGFloat(star.2)).fill()
}

let center = NSPoint(x: 512, y: 536)
let orbitRect = NSRect(x: 116, y: 238, width: 792, height: 596)
let orbit = NSBezierPath(ovalIn: orbitRect)
orbit.lineWidth = 10
color(238, 187, 104, alpha: 0.34).setStroke()
orbit.stroke()

let planet = circle(center: center, radius: 276)
graphicsContext.saveGraphicsState()
planet.addClip()
NSGradient(colors: [color(247, 124, 77), color(188, 55, 52), color(99, 30, 43)])?.draw(
    from: NSPoint(x: 360, y: 720),
    to: NSPoint(x: 700, y: 330),
    options: []
)

// Abstract terrain bands: original geometric shapes, kept bold enough for small icon sizes.
for band in [
    NSRect(x: 250, y: 408, width: 520, height: 120),
    NSRect(x: 325, y: 574, width: 455, height: 86),
    NSRect(x: 285, y: 690, width: 310, height: 62),
] {
    let path = NSBezierPath(ovalIn: band)
    color(86, 24, 41, alpha: 0.22).setFill()
    path.fill()
}

let highlight = circle(center: NSPoint(x: 420, y: 650), radius: 118)
color(255, 210, 151, alpha: 0.18).setFill()
highlight.fill()
graphicsContext.restoreGraphicsState()

planet.lineWidth = 14
color(255, 187, 118, alpha: 0.7).setStroke()
planet.stroke()

// Six colored nodes represent the six tracked resources.
let nodeColors = [
    color(244, 195, 77), color(139, 159, 177), color(210, 219, 230),
    color(87, 181, 116), color(92, 146, 225), color(245, 104, 58),
]
let angles: [CGFloat] = [24, 84, 144, 204, 264, 324]
for (index, degrees) in angles.enumerated() {
    let radians = degrees * .pi / 180
    let point = NSPoint(
        x: center.x + cos(radians) * 362,
        y: center.y + sin(radians) * 274
    )
    color(10, 17, 32, alpha: 0.96).setFill()
    circle(center: point, radius: 53).fill()
    nodeColors[index].setFill()
    circle(center: point, radius: 36).fill()
    color(255, 255, 255, alpha: 0.42).setStroke()
    let inner = circle(center: point, radius: 36)
    inner.lineWidth = 5
    inner.stroke()
}

NSGraphicsContext.restoreGraphicsState()

try FileManager.default.createDirectory(
    at: outputURL.deletingLastPathComponent(),
    withIntermediateDirectories: true
)
guard let image = bitmapContext.makeImage() else {
    fatalError("Could not create the app icon image")
}
let bitmap = NSBitmapImageRep(cgImage: image)
guard let pngData = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Could not encode the app icon as PNG")
}
try pngData.write(to: outputURL, options: .atomic)
print(outputURL.path)
