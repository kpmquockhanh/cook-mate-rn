import AVFoundation
import ExpoModulesCore

public class WakeWordModule: Module {
  private let capture = AudioCapture()
  private var pipeline: WakeWordPipeline?
  /// Inference is off the audio thread, and serial so chunks stay in order.
  private let queue = DispatchQueue(label: "cookmate.wakeword")
  private var threshold: Float = 0.5
  /// Only the first chunk above the threshold is reported; the score has to
  /// fall well below it before another detection counts.
  private var aboveThreshold = false
  private var chunksSinceLevel = 0
  private var running = false
  private var interruptionObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("WakeWord")

    Events("onWakeWord", "onLevel", "onInterrupted", "onResumed", "onError")

    AsyncFunction("start") { (threshold: Double) in
      self.threshold = Float(threshold)
      if self.pipeline == nil { self.pipeline = try WakeWordPipeline() }
      self.pipeline?.reset()
      self.aboveThreshold = false
      self.capture.onChunk = { [weak self] chunk in
        self?.queue.async { self?.handle(chunk) }
      }
      try self.capture.start()
      self.running = true
      self.observeInterruptions()
    }

    AsyncFunction("stop") {
      self.running = false
      self.capture.stop()
      self.stopObservingInterruptions()
    }

    Function("setThreshold") { (threshold: Double) in
      self.queue.async { self.threshold = Float(threshold) }
    }

    AsyncFunction("scoreWav") { (path: String) -> Double in
      try self.scoreWav(path)
    }

    OnDestroy {
      self.running = false
      self.capture.stop()
      self.stopObservingInterruptions()
    }
  }

  private func handle(_ chunk: [Int16]) {
    chunksSinceLevel += 1
    if chunksSinceLevel >= 3 {
      chunksSinceLevel = 0
      sendEvent("onLevel", ["rms": Self.rms(chunk)])
    }
    guard let pipeline else { return }
    do {
      guard let score = try pipeline.process(chunk) else { return }
      if score >= threshold, !aboveThreshold {
        aboveThreshold = true
        sendEvent("onWakeWord", ["score": Double(score)])
      } else if score < threshold * 0.5 {
        aboveThreshold = false
      }
    } catch {
      capture.stop()
      running = false
      sendEvent("onError", ["message": error.localizedDescription])
    }
  }

  private func observeInterruptions() {
    guard interruptionObserver == nil else { return }
    interruptionObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
    ) { [weak self] note in
      guard let self, self.running,
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
        let type = AVAudioSession.InterruptionType(rawValue: raw)
      else { return }
      switch type {
      case .began:
        self.capture.stop()
        self.sendEvent("onInterrupted")
      case .ended:
        do {
          self.queue.sync { self.pipeline?.reset(); self.aboveThreshold = false }
          try self.capture.start()
          self.sendEvent("onResumed")
        } catch {
          self.running = false
          self.sendEvent("onError", ["message": error.localizedDescription])
        }
      @unknown default:
        break
      }
    }
  }

  private func stopObservingInterruptions() {
    if let observer = interruptionObserver { NotificationCenter.default.removeObserver(observer) }
    interruptionObserver = nil
  }

  /// Dev-only parity check: the max score over a 16 kHz mono 16-bit WAV.
  private func scoreWav(_ path: String) throws -> Double {
    let url = path.hasPrefix("file://") ? URL(string: path)! : URL(fileURLWithPath: path)
    let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatInt16, interleaved: true)
    let frames = AVAudioFrameCount(file.length)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames),
      file.processingFormat.sampleRate == AudioCapture.sampleRate,
      file.processingFormat.channelCount == 1
    else { throw NSError(domain: "WakeWord", code: 1, userInfo: [NSLocalizedDescriptionKey: "WAV must be 16 kHz mono"]) }
    try file.read(into: buffer)
    let samples = Array(UnsafeBufferPointer(start: buffer.int16ChannelData![0], count: Int(buffer.frameLength)))

    let offline = try WakeWordPipeline()
    var best: Float = 0
    var start = 0
    while start + AudioCapture.chunkSize <= samples.count {
      if let score = try offline.process(Array(samples[start..<(start + AudioCapture.chunkSize)])) {
        best = max(best, score)
      }
      start += AudioCapture.chunkSize
    }
    return Double(best)
  }

  static func rms(_ chunk: [Int16]) -> Double {
    let sum = chunk.reduce(0.0) { $0 + Double($1) * Double($1) }
    return (sum / Double(max(chunk.count, 1))).squareRoot() / Double(Int16.max)
  }
}
