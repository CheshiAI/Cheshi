import CoreGraphics

struct DragSelectionCopy {
  private var start: CGPoint?
  private var moved = false

  mutating func begin(at point: CGPoint) {
    start = point
    moved = false
  }

  mutating func move(to point: CGPoint) {
    if let start, point != start { moved = true }
  }

  mutating func finish(at point: CGPoint) -> Bool {
    move(to: point)
    let copy = start != nil && moved
    cancel()
    return copy
  }

  mutating func cancel() {
    start = nil
    moved = false
  }
}
