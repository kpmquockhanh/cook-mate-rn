package expo.modules.wakeword

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder

/**
 * Reads the microphone on its own thread and hands out 16 kHz mono Int16 chunks
 * of CHUNK_SIZE samples - openWakeWord's 80 ms frame.
 *
 * VOICE_RECOGNITION rather than VOICE_COMMUNICATION: WebRTC holds the
 * communication source, and recognition is the one Android lets a second
 * recorder in the same app share. The spike (Task 5) is what confirms this.
 */
class AudioCapture(private val onChunk: (ShortArray) -> Unit, private val onFailure: (String) -> Unit) {
  companion object {
    const val SAMPLE_RATE = 16_000
    const val CHUNK_SIZE = 1_280
  }

  @Volatile private var running = false
  private var thread: Thread? = null

  @SuppressLint("MissingPermission") // RECORD_AUDIO is already granted for LiveKit.
  fun start() {
    if (running) return
    val minBuffer = AudioRecord.getMinBufferSize(
      SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
    )
    val record = AudioRecord(
      MediaRecorder.AudioSource.VOICE_RECOGNITION,
      SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      maxOf(minBuffer, CHUNK_SIZE * 2 * 4)
    )
    if (record.state != AudioRecord.STATE_INITIALIZED) {
      record.release()
      throw IllegalStateException("The microphone could not be opened")
    }
    try {
      record.startRecording()
    } catch (e: Exception) {
      record.release()
      throw IllegalStateException("The microphone could not be started", e)
    }
    if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
      record.release()
      throw IllegalStateException("The microphone could not be started")
    }
    running = true
    thread = Thread({
      val chunk = ShortArray(CHUNK_SIZE)
      try {
        while (running) {
          var filled = 0
          while (filled < CHUNK_SIZE && running) {
            val read = record.read(chunk, filled, CHUNK_SIZE - filled)
            if (read < 0) throw IllegalStateException("Microphone read failed ($read)")
            filled += read
          }
          if (filled == CHUNK_SIZE) onChunk(chunk.copyOf())
        }
      } catch (e: Exception) {
        if (running) onFailure(e.message ?: "Microphone capture failed")
      } finally {
        record.stop()
        record.release()
      }
    }, "WakeWordCapture").also { it.start() }
  }

  fun stop() {
    running = false
    thread?.join(500)
    thread = null
  }
}
