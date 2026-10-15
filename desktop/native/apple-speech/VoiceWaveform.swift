import Foundation
import AVFoundation

// Scan bounded PCM buffers, returning only peaks rather than decoded audio to the UI.
func voiceWaveform(source: URL) throws -> [String: Any] {
    let file = try AVAudioFile(forReading: source, commonFormat: .pcmFormatFloat32, interleaved: false)
    let format = file.processingFormat
    guard file.length > 0, format.sampleRate > 0,
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8192) else { throw VoiceAudioError.missingAudio }
    let count = 512
    var peaks = [Float](repeating: 0, count: count)
    var offset: AVAudioFramePosition = 0
    while offset < file.length {
        try file.read(into: buffer)
        guard buffer.frameLength > 0, let channels = buffer.floatChannelData else { break }
        for frame in 0..<Int(buffer.frameLength) {
            let bucket = min(count - 1, Int(Double(offset + Int64(frame)) / Double(file.length) * Double(count)))
            for channel in 0..<Int(format.channelCount) {
                let value = abs(channels[channel][frame])
                if value.isFinite { peaks[bucket] = max(peaks[bucket], min(1, value)) }
            }
        }
        offset += Int64(buffer.frameLength)
    }
    guard offset > 0 else { throw VoiceAudioError.missingAudio }
    return ["duration": Double(file.length) / format.sampleRate, "peaks": peaks.map { Double($0) }]
}
