import Foundation
import AVFoundation

enum VoiceAudioError: Error { case missingAudio, exportUnavailable }

// QTA memos can contain spatial audio and data tracks. Export only the normal
// audio track to a private working file; never alter Apple's recording library.
func prepareVoiceAudio(source: URL, destination: URL) async throws {
    let asset = AVURLAsset(url: source)
    let tracks = try await asset.loadTracks(withMediaType: .audio)
    guard let track = tracks.first else { throw VoiceAudioError.missingAudio }
    let duration = try await asset.load(.duration)
    guard duration.seconds.isFinite && duration.seconds > 0 else { throw VoiceAudioError.missingAudio }
    let composition = AVMutableComposition()
    guard let audio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
        throw VoiceAudioError.missingAudio
    }
    try audio.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: track, at: .zero)
    guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetAppleM4A) else {
        throw VoiceAudioError.exportUnavailable
    }
    if #available(macOS 15.0, *) {
        try await exporter.export(to: destination, as: .m4a)
    } else {
        exporter.outputURL = destination
        exporter.outputFileType = .m4a
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            exporter.exportAsynchronously {
                continuation.resume()
            }
        }
        guard exporter.status == .completed else { throw VoiceAudioError.exportUnavailable }
    }
}
