import Foundation
import onnxruntime_objc

/// openWakeWord's streaming inference, one 80 ms chunk at a time:
///   raw audio -> melspectrogram frames -> 96-d embedding per chunk -> classifier
/// on the last 16 embeddings (~1.3 s of speech).
///
/// Mirrors `openwakeword.utils.AudioFeatures`; any change here has to keep the
/// dev screen's parity check against tools/wakeword/evaluate.py passing.
final class WakeWordPipeline {
  enum PipelineError: LocalizedError {
    case missingModel(String)
    case noOutput
    var errorDescription: String? {
      switch self {
      case .missingModel(let name): return "Wake word model \(name).onnx is missing from the app bundle"
      case .noOutput: return "Wake word model produced no output"
      }
    }
  }

  private static let melContextSamples = 160 * 3
  private static let melBins = 32
  private static let melWindow = 76
  private static let embeddingWindow = 16

  private struct Model {
    let session: ORTSession
    let input: String
    let output: String
  }

  private let env: ORTEnv
  private let mel: Model
  private let embedding: Model
  private let classifier: Model

  private var raw: [Int16] = []
  private var melFrames: [[Float]] = []
  private var embeddings: [[Float]] = []

  init() throws {
    env = try ORTEnv(loggingLevel: .warning)
    mel = try Self.load("melspectrogram", env)
    embedding = try Self.load("embedding_model", env)
    classifier = try Self.load("hey_cookmate", env)
    reset()
  }

  func reset() {
    raw.removeAll()
    // openWakeWord starts its mel buffer as ones, so the first embeddings see
    // the same padding the model was trained with.
    melFrames = Array(repeating: Array(repeating: 1, count: Self.melBins), count: Self.melWindow)
    embeddings.removeAll()
  }

  /// Feed one chunk of `AudioCapture.chunkSize` samples. Returns a score once
  /// 16 embeddings have accumulated, nil before that.
  func process(_ chunk: [Int16]) throws -> Float? {
    raw.append(contentsOf: chunk)
    let needed = chunk.count + Self.melContextSamples
    if raw.count > needed { raw.removeFirst(raw.count - needed) }

    let melInput = raw.map { Float($0) }
    let melOut = try run(mel, melInput, shape: [1, melInput.count])
    let frameCount = melOut.count / Self.melBins
    for f in 0..<frameCount {
      let frame = melOut[(f * Self.melBins)..<((f + 1) * Self.melBins)].map { $0 / 10 + 2 }
      melFrames.append(Array(frame))
    }
    if melFrames.count > Self.melWindow { melFrames.removeFirst(melFrames.count - Self.melWindow) }

    let window = melFrames.flatMap { $0 }
    embeddings.append(try run(embedding, window, shape: [1, Self.melWindow, Self.melBins, 1]))
    if embeddings.count > Self.embeddingWindow { embeddings.removeFirst() }
    guard embeddings.count == Self.embeddingWindow else { return nil }

    let features = embeddings.flatMap { $0 }
    let score = try run(classifier, features, shape: [1, Self.embeddingWindow, 96])
    return score.first
  }

  private static func load(_ name: String, _ env: ORTEnv) throws -> Model {
    let bundles = [Bundle(for: WakeWordPipeline.self), Bundle.main]
    guard let path = bundles.lazy.compactMap({ $0.path(forResource: name, ofType: "onnx") }).first else {
      throw PipelineError.missingModel(name)
    }
    let session = try ORTSession(env: env, modelPath: path, sessionOptions: nil)
    return Model(session: session, input: try session.inputNames()[0], output: try session.outputNames()[0])
  }

  private func run(_ model: Model, _ values: [Float], shape: [Int]) throws -> [Float] {
    let data = values.withUnsafeBufferPointer { NSMutableData(bytes: $0.baseAddress, length: $0.count * 4) }
    let tensor = try ORTValue(
      tensorData: data, elementType: .float, shape: shape.map { NSNumber(value: $0) })
    let outputs = try model.session.run(
      withInputs: [model.input: tensor], outputNames: [model.output], runOptions: nil)
    guard let out = outputs[model.output] else { throw PipelineError.noOutput }
    let bytes = try out.tensorData() as Data
    return bytes.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
  }
}
