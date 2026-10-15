import Foundation
import AVFoundation
import Speech

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

@available(macOS 26.0, *)
func run(_ command: [String: Any]) async {
    guard SpeechTranscriber.isAvailable else {
        emit(command["action"] as? String == "capabilities"
            ? ["available": false, "languages": []] : ["status": "error", "error": "unsupported-platform"]); return
    }
    if command["action"] as? String == "capabilities" {
        let installed = Set(await SpeechTranscriber.installedLocales.map { $0.identifier })
        let locales = await SpeechTranscriber.supportedLocales
        emit(["available": true, "languages": locales.map {
            ["id": $0.identifier, "name": Locale.current.localizedString(forIdentifier: $0.identifier) ?? $0.identifier,
             "installed": installed.contains($0.identifier)] as [String: Any]
        }.sorted { ($0["id"] as? String ?? "") < ($1["id"] as? String ?? "") }])
        return
    }
    guard command["action"] as? String == "transcribe",
          let path = command["path"] as? String,
          let language = command["locale"] as? String,
          let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) else {
        emit(["status": "error", "error": "unsupported-language"]); return
    }
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    var stage = "model-unavailable"
    do {
        emit(["status": "preparing"])
        // Reserve the user's chosen language so its assets remain available for subsequent use.
        try await AssetInventory.reserve(locale: locale)
        if await AssetInventory.status(forModules: [transcriber]) != .installed,
           let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            emit(["status": "downloading"])
            try await request.downloadAndInstall()
        }
        stage = "audio-unavailable"
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        guard file.length > 0 else { emit(["status": "error", "error": "audio-unavailable"]); return }
        stage = "transcription-failed"
        emit(["status": "transcribing"])
        try await analyzer.start(inputAudioFile: file, finishAfterFile: true)
        for try await result in transcriber.results {
            let start = max(0, result.range.start.seconds)
            let end = max(start, CMTimeRangeGetEnd(result.range).seconds)
            let text = String(result.text.characters)
            if start.isFinite && end.isFinite && !text.isEmpty {
                emit(["segment": ["start": start, "end": end, "text": text]])
            }
        }
        emit(["status": "complete"])
    } catch {
        await analyzer.cancelAndFinishNow()
        // Do not send native error descriptions, which can include recording paths or speech.
        emit(["status": "error", "error": stage])
    }
}

@main struct SpeechBridge {
    static func main() async {
        guard let line = readLine(), let data = line.data(using: .utf8),
              let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            emit(["status": "error", "error": "invalid-request"]); return
        }
        if command["action"] as? String == "waveform" {
            guard let source = command["path"] as? String else { emit(["error": "waveform-unavailable"]); return }
            do { emit(try voiceWaveform(source: URL(fileURLWithPath: source))) }
            catch { emit(["error": "waveform-unavailable"]) }
            return
        }
        if command["action"] as? String == "prepareAudio" {
            guard let source = command["path"] as? String, let output = command["output"] as? String else {
                emit(["prepared": false]); return
            }
            do {
                try await prepareVoiceAudio(source: URL(fileURLWithPath: source), destination: URL(fileURLWithPath: output))
                emit(["prepared": true])
            } catch { emit(["prepared": false]) }
            return
        }
        if #available(macOS 26.0, *) { await run(command) }
        else { emit(command["action"] as? String == "capabilities"
            ? ["available": false, "languages": []] : ["status": "error", "error": "unsupported-platform"]) }
    }
}
