// syscap — system-audio tap for twinklybox live sync mode.
//
// Captures the Mac's audio OUTPUT mix via ScreenCaptureKit (macOS 13+), runs an
// FFT, folds the spectrum into 12 log-spaced bands (40 Hz .. 16 kHz — matching
// the browser mic path), and writes one JSON line per analysis frame to stdout:
//     {"t":<unix_ms>,"bands":[b0..b11]}        // each ~0..1
// plus status/errors to stderr. The Node side (syscap-source.ts) spawns this,
// reads stdout, applies a sync delay + rolling normalization, and drives
// megadrome.
//
// Why ScreenCaptureKit: it taps the system output mix natively, needs no
// virtual audio device (BlackHole), and does NOT conflict with AirPlay — so we
// can analyze exactly what's being sent to the AirPlay speaker. Requires the
// Screen Recording permission for whatever process launches it.
//
// Build: ./build.sh  ->  ./syscap

import Foundation
import ScreenCaptureKit
import AVFoundation
import Accelerate

// ---- config (match client/useMicSource.ts) ----
let NUM_BANDS = 12
let F_LO: Float = 40
let F_HI: Float = 16000
let FFT_SIZE = 2048
let SAMPLE_RATE: Double = 48000
let EMIT_HZ: Double = 30          // analysis/emit rate

func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

// ---- FFT analyzer: accumulate mono samples, FFT a sliding 2048 window ----
final class Analyzer {
    private let log2n = vDSP_Length(11)            // 2^11 = 2048
    private let n = FFT_SIZE
    private let setup: FFTSetup
    private var window = [Float](repeating: 0, count: FFT_SIZE)
    private var ring = [Float](repeating: 0, count: FFT_SIZE)
    private var ringFill = 0
    private var real = [Float](repeating: 0, count: FFT_SIZE / 2)
    private var imag = [Float](repeating: 0, count: FFT_SIZE / 2)
    private var mags = [Float](repeating: 0, count: FFT_SIZE / 2)
    private var edges = [Int](repeating: 0, count: 13)   // bin index per band edge

    init() {
        setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
        vDSP_hann_window(&window, vDSP_Length(n), Int32(vDSP_HANN_NORM))
        let binHz = Float(SAMPLE_RATE) / Float(n)
        for i in 0...NUM_BANDS {
            let f = F_LO * pow(F_HI / F_LO, Float(i) / Float(NUM_BANDS))
            edges[i] = max(1, min(n / 2 - 1, Int((f / binHz).rounded())))
        }
    }

    // Feed interleaved/mono Float samples; emit a band frame each time the ring
    // advances by a full hop. Returns the latest 12-band vector when ready.
    func process(_ samples: [Float]) -> [Float]? {
        var out: [Float]? = nil
        for s in samples {
            ring[ringFill] = s
            ringFill += 1
            if ringFill == n {
                out = analyzeWindow()
                // 50% overlap: keep the second half for the next window
                for i in 0..<(n / 2) { ring[i] = ring[i + n / 2] }
                ringFill = n / 2
            }
        }
        return out
    }

    private func analyzeWindow() -> [Float] {
        var windowed = [Float](repeating: 0, count: n)
        vDSP_vmul(ring, 1, window, 1, &windowed, 1, vDSP_Length(n))

        var bands = [Float](repeating: 0, count: NUM_BANDS)
        real.withUnsafeMutableBufferPointer { rp in
            imag.withUnsafeMutableBufferPointer { ip in
                var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                windowed.withUnsafeBufferPointer { wp in
                    wp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) { cp in
                        vDSP_ctoz(cp, 2, &split, 1, vDSP_Length(n / 2))
                    }
                }
                vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                vDSP_zvabs(&split, 1, &mags, 1, vDSP_Length(n / 2))
            }
        }
        // Fold magnitudes into 12 bands, convert to a dB-ish 0..1 like
        // getByteFrequencyData (which the mic path also produces).
        for b in 0..<NUM_BANDS {
            let i0 = edges[b], i1 = max(edges[b], edges[b + 1])
            var sum: Float = 0; var cnt: Float = 0
            var i = i0
            while i <= i1 { sum += mags[i]; cnt += 1; i += 1 }
            let avg = cnt > 0 ? sum / cnt : 0
            // normalize FFT magnitude, then dB map [-80,0] -> [0,1]
            let norm = avg / Float(n)
            let db = 20 * log10(max(norm, 1e-7))
            bands[b] = max(0, min(1, (db + 80) / 80))
        }
        return bands
    }

    deinit { vDSP_destroy_fftsetup(setup) }
}

// ---- extract mono Float samples from an audio CMSampleBuffer ----
extension CMSampleBuffer {
    func monoFloats() -> [Float]? {
        guard let fmt = CMSampleBufferGetFormatDescription(self),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee else { return nil }
        let channels = max(1, Int(asbd.mChannelsPerFrame))
        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        guard isFloat else { return nil }   // SCStream delivers Float32

        // Allocate an AudioBufferList sized for the actual channel count —
        // SCStream audio is stereo NON-interleaved (one buffer per channel), so
        // a single-buffer ABL makes the extraction call fail with ArrayTooSmall.
        var blockBuffer: CMBlockBuffer?
        let ablPtr = AudioBufferList.allocate(maximumBuffers: channels)
        defer { free(ablPtr.unsafeMutablePointer) }
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            self, bufferListSizeNeededOut: nil, bufferListOut: ablPtr.unsafeMutablePointer,
            bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: channels),
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer)
        guard status == noErr else { return nil }
        let buffers = ablPtr

        // Non-interleaved (one buffer per channel) is the common SCK layout.
        if buffers.count >= 1 && Int(buffers[0].mNumberChannels) == 1 {
            let frames = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size
            var mono = [Float](repeating: 0, count: frames)
            for ch in 0..<min(channels, buffers.count) {
                let p = buffers[ch].mData!.bindMemory(to: Float.self, capacity: frames)
                for i in 0..<frames { mono[i] += p[i] }
            }
            let inv = channels > 0 ? 1.0 / Float(channels) : 1
            for i in 0..<frames { mono[i] *= inv }
            return mono
        }
        // Interleaved fallback.
        let frames = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size / max(1, channels)
        let p = buffers[0].mData!.bindMemory(to: Float.self, capacity: frames * channels)
        var mono = [Float](repeating: 0, count: frames)
        for i in 0..<frames {
            var acc: Float = 0
            for ch in 0..<channels { acc += p[i * channels + ch] }
            mono[i] = acc / Float(channels)
        }
        return mono
    }
}

// ---- capture ----
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    let analyzer = Analyzer()
    var stream: SCStream?
    var lastEmit: Double = 0
    let minEmitGap = 1.0 / EMIT_HZ

    func start() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else { err("no display available"); exit(2) }
            // Audio-only intent: filter on a display (required), but we only add
            // the audio output and ignore screen frames.
            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            let cfg = SCStreamConfiguration()
            cfg.capturesAudio = true
            cfg.excludesCurrentProcessAudio = true
            cfg.sampleRate = Int(SAMPLE_RATE)
            cfg.channelCount = 2
            // Keep video cheap (we ignore it); SCStream still wants valid dims.
            cfg.width = 2; cfg.height = 2; cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)

            let s = SCStream(filter: filter, configuration: cfg, delegate: self)
            try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "syscap.audio"))
            try await s.startCapture()
            stream = s
            err("syscap: capturing system audio @\(Int(SAMPLE_RATE))Hz")
        } catch {
            err("syscap start failed: \(error)")
            exit(3)
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        guard let mono = sampleBuffer.monoFloats() else { return }
        guard let bands = analyzer.process(mono) else { return }
        let now = Date().timeIntervalSince1970
        if now - lastEmit < minEmitGap { return }
        lastEmit = now
        let ms = Int(now * 1000)
        let arr = bands.map { String(format: "%.4f", $0) }.joined(separator: ",")
        let line = "{\"t\":\(ms),\"bands\":[\(arr)]}\n"
        FileHandle.standardOutput.write(line.data(using: .utf8)!)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        err("syscap stopped: \(error)")
        exit(4)
    }
}

let cap = Capture()
Task { await cap.start() }
RunLoop.main.run()
