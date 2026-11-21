// The virtual camera's Camera Extension on macOS (docs/virtual-camera.md):
// "Mochi Studio Camera", which every AVFoundation app lists. It has two
// streams:
//
// - the source stream, which apps read;
// - the sink stream, into which the app's helper (mochi-camera) writes the
//   frames Mochi Studio sends.
//
// A timer sends the latest frame from the sink to the source at the stream's
// rate; while no frame came for two seconds, it sends a still card saying
// Mochi Studio isn't sending. Written from Apple's Core Media I/O extension
// documentation (CMIOExtension*).
import CoreGraphics
import CoreMediaIO
import CoreText
import CoreVideo
import Foundation
import IOKit.audio
import MochiCameraCore

let cameraName = "Mochi Studio Camera"
let sizes = [(1280, 720), (1920, 1080), (960, 540)]
let staleNanos: UInt64 = 2_000_000_000

func hostNanos() -> UInt64 {
  var info = mach_timebase_info_data_t()
  mach_timebase_info(&info)
  return mach_absolute_time() * UInt64(info.numer) / UInt64(info.denom)
}

func formatDescription(width: Int, height: Int) -> CMFormatDescription {
  var desc: CMFormatDescription?
  CMVideoFormatDescriptionCreate(
    allocator: kCFAllocatorDefault, codecType: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    width: Int32(width), height: Int32(height), extensions: nil, formatDescriptionOut: &desc)
  return desc!
}

func streamFormats() -> [CMIOExtensionStreamFormat] {
  sizes.map { w, h in
    CMIOExtensionStreamFormat(
      formatDescription: formatDescription(width: w, height: h),
      maxFrameDuration: CMTime(value: 1, timescale: 30),
      minFrameDuration: CMTime(value: 1, timescale: 60), validFrameDurations: nil)
  }
}

/// The still card: dark, with two lines of text, as NV12.
func drawCard(width: Int, height: Int) -> [UInt8] {
  var bgra = [UInt8](repeating: 0, count: width * height * 4)
  let space = CGColorSpaceCreateDeviceRGB()
  let info = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
  bgra.withUnsafeMutableBytes { p in
    guard
      let ctx = CGContext(
        data: p.baseAddress, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width * 4, space: space, bitmapInfo: info)
    else { return }
    ctx.setFillColor(CGColor(red: 0x22 / 255, green: 0x26 / 255, blue: 0x33 / 255, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    func line(_ text: String, size: CGFloat, gray: CGFloat, y: CGFloat) {
      let font = CTFontCreateWithName("Helvetica Neue" as CFString, size, nil)
      let attrs: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(
          gray: gray, alpha: 1),
      ]
      let ct = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
      let bounds = CTLineGetBoundsWithOptions(ct, [])
      ctx.textPosition = CGPoint(x: (CGFloat(width) - bounds.width) / 2, y: y)
      CTLineDraw(ct, ctx)
    }
    let h = CGFloat(height)
    line("Mochi Studio isn\u{2019}t sending", size: h / 14, gray: 0.95, y: h / 2 + h / 40)
    line(
      "Turn on the virtual camera in Mochi Studio\u{2019}s Camera tab.", size: h / 28, gray: 0.68,
      y: h / 2 - h / 10)
  }
  return (try? bgraToNv12(bgra, width: width, height: height, under: 0)) ?? nv12Black(
    width: width, height: height)
}

final class StreamSource: NSObject, CMIOExtensionStreamSource {
  private(set) var stream: CMIOExtensionStream!
  let formats = streamFormats()
  var activeFormatIndex = 0
  var frameDuration = CMTime(value: 1, timescale: 30)
  weak var device: DeviceSource?
  let isSink: Bool

  init(device: DeviceSource, sink: Bool) {
    self.device = device
    isSink = sink
    super.init()
    stream = CMIOExtensionStream(
      localizedName: sink ? "\(cameraName) input" : cameraName, streamID: UUID(),
      direction: sink ? .sink : .source, clockType: .hostTime, source: self)
  }

  var availableProperties: Set<CMIOExtensionProperty> {
    var p: Set<CMIOExtensionProperty> = [.streamActiveFormatIndex, .streamFrameDuration]
    if isSink {
      p.formUnion([
        .streamSinkBufferQueueSize, .streamSinkBuffersRequiredForStartup,
        .streamSinkBufferUnderrunCount, .streamSinkEndOfData,
      ])
    }
    return p
  }

  func streamProperties(forProperties properties: Set<CMIOExtensionProperty>) throws
    -> CMIOExtensionStreamProperties
  {
    let p = CMIOExtensionStreamProperties(dictionary: [:])
    if properties.contains(.streamActiveFormatIndex) { p.activeFormatIndex = activeFormatIndex }
    if properties.contains(.streamFrameDuration) { p.frameDuration = frameDuration }
    if isSink {
      if properties.contains(.streamSinkBufferQueueSize) { p.sinkBufferQueueSize = 1 }
      if properties.contains(.streamSinkBuffersRequiredForStartup) {
        p.sinkBuffersRequiredForStartup = 1
      }
    }
    return p
  }

  func setStreamProperties(_ properties: CMIOExtensionStreamProperties) throws {
    if let i = properties.activeFormatIndex, i >= 0, i < formats.count {
      activeFormatIndex = i
      device?.formatChanged()
    }
    if let d = properties.frameDuration { frameDuration = d }
  }

  func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool {
    // The sink takes frames from the client that starts it: the helper.
    if isSink { device?.sinkClient(client) }
    return true
  }

  func startStream() throws {
    if isSink { device?.startSink() } else { device?.startSource() }
  }

  func stopStream() throws {
    if isSink { device?.stopSink() } else { device?.stopSource() }
  }
}

final class DeviceSource: NSObject, CMIOExtensionDeviceSource {
  private(set) var device: CMIOExtensionDevice!
  private var source: StreamSource!
  private var sink: StreamSource!
  private let queue = DispatchQueue(label: "com.waifucave.mochistudio.camera")
  private var timer: DispatchSourceTimer?
  private var pool: CVPixelBufferPool?
  private var poolSize = (0, 0)
  private var latest: CVPixelBuffer?
  private var latestAt: UInt64 = 0
  private var card: (Int, Int, [UInt8])?
  private var sinkClient: CMIOExtensionClient?
  private var sinkRunning = false
  private var sequence: UInt64 = 0

  override init() {
    super.init()
    device = CMIOExtensionDevice(
      localizedName: cameraName, deviceID: UUID(uuidString: "6B0E4C1A-7D2F-4E5B-9C3A-1F8D2E6A4B70")!,
      legacyDeviceID: nil, source: self)
    source = StreamSource(device: self, sink: false)
    sink = StreamSource(device: self, sink: true)
    try? device.addStream(source.stream)
    try? device.addStream(sink.stream)
  }

  var availableProperties: Set<CMIOExtensionProperty> { [.deviceTransportType, .deviceModel] }

  func deviceProperties(forProperties properties: Set<CMIOExtensionProperty>) throws
    -> CMIOExtensionDeviceProperties
  {
    let p = CMIOExtensionDeviceProperties(dictionary: [:])
    if properties.contains(.deviceTransportType) {
      p.transportType = kIOAudioDeviceTransportTypeVirtual
    }
    if properties.contains(.deviceModel) { p.model = "Mochi Studio" }
    return p
  }

  func setDeviceProperties(_ properties: CMIOExtensionDeviceProperties) throws {}

  private var size: (Int, Int) { sizes[source.activeFormatIndex] }

  func formatChanged() { queue.async { self.latest = nil } }

  // The source: frames to apps at the stream's rate.
  func startSource() {
    queue.async {
      let t = DispatchSource.makeTimerSource(queue: self.queue)
      let ns = UInt64(CMTimeGetSeconds(self.source.frameDuration) * 1_000_000_000)
      t.schedule(deadline: .now(), repeating: .nanoseconds(Int(max(ns, 16_000_000))))
      t.setEventHandler { [weak self] in self?.sendFrame() }
      self.timer = t
      t.resume()
    }
  }

  func stopSource() {
    queue.async {
      self.timer?.cancel()
      self.timer = nil
    }
  }

  // The sink: the helper's frames.
  func startSink() {
    queue.async {
      self.sinkRunning = true
      self.consume()
    }
  }

  func stopSink() { queue.async { self.sinkRunning = false } }

  func sinkClient(_ client: CMIOExtensionClient) { queue.async { self.sinkClient = client } }

  private func consume() {
    guard sinkRunning, let client = sinkClient else { return }
    sink.stream.consumeSampleBuffer(from: client) { [weak self] buffer, seq, _, more, _ in
      guard let self else { return }
      self.queue.async {
        if let buffer, let image = CMSampleBufferGetImageBuffer(buffer) {
          self.latest = image
          self.latestAt = hostNanos()
          let output = CMIOExtensionScheduledOutput(
            sequenceNumber: seq, hostTimeInNanoseconds: self.latestAt)
          self.sink.stream.notifyScheduledOutputChanged(output)
        }
        // Again at once while more wait, else a moment later.
        if more { self.consume() } else {
          self.queue.asyncAfter(deadline: .now() + .milliseconds(5)) { self.consume() }
        }
      }
    }
  }

  private func makeBuffer(width: Int, height: Int) -> CVPixelBuffer? {
    if pool == nil || poolSize != (width, height) {
      let attrs: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:],
      ]
      CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &pool)
      poolSize = (width, height)
    }
    var out: CVPixelBuffer?
    guard let pool else { return nil }
    CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &out)
    return out
  }

  /// A buffer of the card, at the stream's size.
  private func cardBuffer() -> CVPixelBuffer? {
    let (w, h) = size
    if card == nil || card!.0 != w || card!.1 != h { card = (w, h, drawCard(width: w, height: h)) }
    guard let buffer = makeBuffer(width: w, height: h) else { return nil }
    let writer = PixelBufferSink(buffer: buffer)
    try? writer.fill(Frame(width: w, height: h, nv12: card!.2))
    return buffer
  }

  private func sendFrame() {
    let now = hostNanos()
    let fresh = latest != nil && now - latestAt < staleNanos
    let (w, h) = size
    // A frame of another size than the stream's: the card says so less well than a
    // black frame would mislead; the helper sends the camera's size, so this is rare.
    let image: CVPixelBuffer? =
      fresh && CVPixelBufferGetWidth(latest!) == w && CVPixelBufferGetHeight(latest!) == h
      ? latest : cardBuffer()
    guard let image else { return }
    var format: CMFormatDescription?
    CMVideoFormatDescriptionCreateForImageBuffer(
      allocator: kCFAllocatorDefault, imageBuffer: image, formatDescriptionOut: &format)
    var timing = CMSampleTimingInfo(
      duration: source.frameDuration,
      presentationTimeStamp: CMTime(value: CMTimeValue(now), timescale: 1_000_000_000),
      decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    guard let format,
      CMSampleBufferCreateReadyWithImageBuffer(
        allocator: kCFAllocatorDefault, imageBuffer: image, formatDescription: format,
        sampleTiming: &timing, sampleBufferOut: &sample) == noErr, let sample
    else { return }
    sequence += 1
    source.stream.send(sample, discontinuity: [], hostTimeInNanoseconds: now)
  }
}

/// A pixel buffer as a sink buffer, for the card (the same row copy as the helper's).
final class PixelBufferSink: FrameSink {
  let buffer: CVPixelBuffer
  init(buffer: CVPixelBuffer) { self.buffer = buffer }
  func makeBuffer(width: Int, height: Int) throws -> SinkBuffer { PixelBufferPlanes(buffer) }
  func send(_ buffer: SinkBuffer, presentationNanos: UInt64) throws {}
  func fill(_ frame: Frame) throws {
    try SinkWriter(sink: self, now: hostNanos).write(frame)
  }
}

final class PixelBufferPlanes: SinkBuffer {
  let buffer: CVPixelBuffer
  init(_ buffer: CVPixelBuffer) { self.buffer = buffer }
  var width: Int { CVPixelBufferGetWidth(buffer) }
  var height: Int { CVPixelBufferGetHeight(buffer) }
  var lumaBytesPerRow: Int { CVPixelBufferGetBytesPerRowOfPlane(buffer, 0) }
  var chromaBytesPerRow: Int { CVPixelBufferGetBytesPerRowOfPlane(buffer, 1) }
  func withPlanes(_ body: (UnsafeMutablePointer<UInt8>, UnsafeMutablePointer<UInt8>) throws -> Void)
    rethrows
  {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    let y = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)!.assumingMemoryBound(to: UInt8.self)
    let uv = CVPixelBufferGetBaseAddressOfPlane(buffer, 1)!.assumingMemoryBound(to: UInt8.self)
    try body(y, uv)
  }
}

final class ProviderSource: NSObject, CMIOExtensionProviderSource {
  private(set) var provider: CMIOExtensionProvider!
  private let deviceSource = DeviceSource()

  override init() {
    super.init()
    provider = CMIOExtensionProvider(source: self, clientQueue: nil)
    try? provider.addDevice(deviceSource.device)
  }

  var availableProperties: Set<CMIOExtensionProperty> { [.providerManufacturer] }

  func providerProperties(forProperties properties: Set<CMIOExtensionProperty>) throws
    -> CMIOExtensionProviderProperties
  {
    let p = CMIOExtensionProviderProperties(dictionary: [:])
    if properties.contains(.providerManufacturer) { p.manufacturer = "Mochi Studio" }
    return p
  }

  func setProviderProperties(_ properties: CMIOExtensionProviderProperties) throws {}

  func connect(to client: CMIOExtensionClient) throws {}

  func disconnect(from client: CMIOExtensionClient) {}
}

let providerSource = ProviderSource()
CMIOExtensionProvider.startService(provider: providerSource.provider)
CFRunLoopRun()
