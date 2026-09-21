package expo.modules.wakeword

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.sqrt

class WakeWordModule : Module() {
  @Volatile private var threshold = 0.5f
  private var chunksSinceLevel = 0
  @Volatile private var capture: AudioCapture? = null

  override fun definition() = ModuleDefinition {
    Name("WakeWord")

    Events("onWakeWord", "onLevel", "onInterrupted", "onResumed", "onError")

    AsyncFunction("start") { threshold: Double ->
      this@WakeWordModule.threshold = threshold.toFloat()
      if (capture == null) {
        lateinit var created: AudioCapture
        created = AudioCapture(
          onChunk = { handle(it) },
          onFailure = { message ->
            // Only clear the field if it still points at this instance: a
            // late failure from a since-replaced capture must not null out
            // a newer one.
            if (capture === created) capture = null
            sendEvent("onError", mapOf("message" to message))
          }
        )
        try {
          // Assigned before start(): the capture thread can fail as soon as
          // start() spawns it, and onFailure's `capture === created` guard
          // must already see this instance or a fast failure would leave
          // `capture` pointing at a dead instance once this line ran after.
          capture = created
          created.start()
        } catch (e: Exception) {
          capture = null
          throw e
        }
      }
    }

    AsyncFunction("stop") {
      capture?.stop()
      capture = null
    }

    Function("setThreshold") { threshold: Double ->
      this@WakeWordModule.threshold = threshold.toFloat()
    }

    OnDestroy {
      capture?.stop()
      capture = null
    }
  }

  private fun handle(chunk: ShortArray) {
    chunksSinceLevel += 1
    if (chunksSinceLevel >= 3) {
      chunksSinceLevel = 0
      sendEvent("onLevel", mapOf("rms" to rms(chunk)))
    }
  }

  private fun rms(chunk: ShortArray): Double {
    var sum = 0.0
    for (s in chunk) sum += s.toDouble() * s
    return sqrt(sum / chunk.size) / Short.MAX_VALUE
  }
}
