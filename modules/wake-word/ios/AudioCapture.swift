import AVFoundation

/// Taps the microphone and hands out 16 kHz mono Int16 chunks of `chunkSize`
/// samples - the frame size openWakeWord is built around (80 ms).
///
/// It never touches the AVAudioSession category: LiveKit owns the session
/// (playAndRecord, voice chat), and changing it here would break the call.
final class AudioCapture {
  static let sampleRate: Double = 16_000
  static let chunkSize = 1_280

  enum CaptureError: LocalizedError {
    case noInput
    var errorDescription: String? { "No microphone input is available" }
  }

  var onChunk: (([Int16]) -> Void)?

  private let engine = AVAudioEngine()
  private var converter: AVAudioConverter?
  private var pending: [Int16] = []
  private let target = AVAudioFormat(
    commonFormat: .pcmFormatInt16, sampleRate: AudioCapture.sampleRate, channels: 1, interleaved: true)!

  private(set) var isRunning = false

  func start() throws {
    if isRunning { return }
    pending.removeAll()
    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { throw CaptureError.noInput }
    converter = AVAudioConverter(from: inputFormat, to: target)
    input.installTap(onBus: 0, bufferSize: 4_096, format: inputFormat) { [weak self] buffer, _ in
      self?.convert(buffer)
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      // Remove the tap and drop the converter so a later start() can install a
      // fresh tap; a second installTap on top of this one crashes with an
      // Objective-C NSException that Swift cannot catch.
      input.removeTap(onBus: 0)
      converter = nil
      throw error
    }
    isRunning = true
  }

  func stop() {
    guard isRunning else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    isRunning = false
  }

  private func convert(_ buffer: AVAudioPCMBuffer) {
    guard let converter else { return }
    let ratio = target.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }

    var supplied = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return buffer
    }
    guard error == nil, let channel = out.int16ChannelData else { return }

    pending.append(contentsOf: UnsafeBufferPointer(start: channel[0], count: Int(out.frameLength)))
    while pending.count >= Self.chunkSize {
      let chunk = Array(pending.prefix(Self.chunkSize))
      pending.removeFirst(Self.chunkSize)
      onChunk?(chunk)
    }
  }
}
