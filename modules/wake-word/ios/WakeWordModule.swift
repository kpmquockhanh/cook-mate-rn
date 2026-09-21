import ExpoModulesCore

public class WakeWordModule: Module {
  private let capture = AudioCapture()
  private var threshold: Float = 0.5
  private var chunksSinceLevel = 0

  public func definition() -> ModuleDefinition {
    Name("WakeWord")

    Events("onWakeWord", "onLevel", "onInterrupted", "onResumed", "onError")

    AsyncFunction("start") { (threshold: Double) in
      self.threshold = Float(threshold)
      self.capture.onChunk = { [weak self] chunk in self?.handle(chunk) }
      try self.capture.start()
    }

    AsyncFunction("stop") {
      self.capture.stop()
    }

    Function("setThreshold") { (threshold: Double) in
      self.threshold = Float(threshold)
    }

    OnDestroy {
      self.capture.stop()
    }
  }

  private func handle(_ chunk: [Int16]) {
    chunksSinceLevel += 1
    if chunksSinceLevel >= 3 {
      chunksSinceLevel = 0
      sendEvent("onLevel", ["rms": Self.rms(chunk)])
    }
  }

  static func rms(_ chunk: [Int16]) -> Double {
    let sum = chunk.reduce(0.0) { $0 + Double($1) * Double($1) }
    return (sum / Double(max(chunk.count, 1))).squareRoot() / Double(Int16.max)
  }
}
