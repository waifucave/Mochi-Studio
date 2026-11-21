// mochi-camera: the helper between Mochi Studio and its Camera Extension on
// macOS (docs/virtual-camera.md). It lives in the app bundle, next to the
// app's executable, so macOS finds the extension in the app's bundle.
//
//   mochi-camera status       prints {"installed": true|false} (the camera is listed)
//   mochi-camera activate     asks macOS to activate the extension (the person approves)
//   mochi-camera deactivate   asks macOS to deactivate it
//   mochi-camera feed         reads frames on standard input (MochiCameraCore's format)
//                             and writes them into the extension's sink stream
//
// Written from Apple's Core Media I/O and System Extensions documentation.
import CoreMediaIO
import CoreVideo
import Foundation
import MochiCameraCore
import SystemExtensions

let extensionID = "com.waifucave.mochistudio.camera"
let cameraName = "Mochi Studio Camera"

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func hostNanos() -> UInt64 {
  var info = mach_timebase_info_data_t()
  mach_timebase_info(&info)
  return mach_absolute_time() * UInt64(info.numer) / UInt64(info.denom)
}

// --- Core Media I/O: the camera and its sink stream ------------------------------------

func address(_ selector: Int) -> CMIOObjectPropertyAddress {
  CMIOObjectPropertyAddress(
    mSelector: CMIOObjectPropertySelector(selector),
    mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
    mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
}

func objects(_ owner: CMIOObjectID, _ selector: Int) -> [CMIOObjectID] {
  var addr = address(selector)
  var size: UInt32 = 0
  guard CMIOObjectGetPropertyDataSize(owner, &addr, 0, nil, &size) == 0, size > 0 else {
    return []
  }
  var ids = [CMIOObjectID](repeating: 0, count: Int(size) / MemoryLayout<CMIOObjectID>.size)
  var used: UInt32 = 0
  guard CMIOObjectGetPropertyData(owner, &addr, 0, nil, size, &used, &ids) == 0 else { return [] }
  return ids
}

func name(_ object: CMIOObjectID) -> String? {
  var addr = address(kCMIOObjectPropertyName)
  var value: Unmanaged<CFString>?
  var used: UInt32 = 0
  let size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard CMIOObjectGetPropertyData(object, &addr, 0, nil, size, &used, &value) == 0 else {
    return nil
  }
  return value?.takeRetainedValue() as String?
}

func cameraDevice() -> CMIOObjectID? {
  objects(CMIOObjectID(kCMIOObjectSystemObject), kCMIOHardwarePropertyDevices).first {
    name($0) == cameraName
  }
}

/// The extension's sink stream: the one named "… input" (the second, by its order).
func sinkStream(_ device: CMIOObjectID) -> CMIOStreamID? {
  let streams = objects(device, kCMIODevicePropertyStreams)
  return streams.first { name($0)?.hasSuffix(" input") == true } ?? (streams.count > 1 ? streams[1] : nil)
}

/// The sink as MochiCameraCore's sink: pixel buffers into the stream's queue.
final class StreamSink: FrameSink {
  let queue: CMSimpleQueue
  private var pool: CVPixelBufferPool?
  private var poolSize = (0, 0)
  private(set) var dropped = 0

  init(queue: CMSimpleQueue) { self.queue = queue }

  func makeBuffer(width: Int, height: Int) throws -> SinkBuffer {
    if pool == nil || poolSize != (width, height) {
      let attrs: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:],
      ]
      pool = nil
      CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &pool)
      poolSize = (width, height)
    }
    var out: CVPixelBuffer?
    guard let pool, CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &out) == 0,
      let out
    else { throw NSError(domain: "mochi-camera", code: 1) }
    return Planes(out)
  }

  func send(_ buffer: SinkBuffer, presentationNanos: UInt64) throws {
    let image = (buffer as! Planes).buffer
    var format: CMFormatDescription?
    CMVideoFormatDescriptionCreateForImageBuffer(
      allocator: kCFAllocatorDefault, imageBuffer: image, formatDescriptionOut: &format)
    var timing = CMSampleTimingInfo(
      duration: .invalid,
      presentationTimeStamp: CMTime(value: CMTimeValue(presentationNanos), timescale: 1_000_000_000),
      decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    guard let format,
      CMSampleBufferCreateReadyWithImageBuffer(
        allocator: kCFAllocatorDefault, imageBuffer: image, formatDescription: format,
        sampleTiming: &timing, sampleBufferOut: &sample) == noErr, let sample
    else { throw NSError(domain: "mochi-camera", code: 2) }
    // A full queue: the extension hasn't taken the last one yet; this frame is dropped.
    if CMSimpleQueueGetCount(queue) >= CMSimpleQueueGetCapacity(queue) {
      dropped += 1
      return
    }
    CMSimpleQueueEnqueue(queue, element: Unmanaged.passRetained(sample).toOpaque())
  }
}

final class Planes: SinkBuffer {
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
    try body(
      CVPixelBufferGetBaseAddressOfPlane(buffer, 0)!.assumingMemoryBound(to: UInt8.self),
      CVPixelBufferGetBaseAddressOfPlane(buffer, 1)!.assumingMemoryBound(to: UInt8.self))
  }
}

func feed() -> Never {
  guard let device = cameraDevice() else {
    fail("No camera named “\(cameraName)”: its extension isn’t active.")
  }
  guard let stream = sinkStream(device) else { fail("The camera has no sink stream.") }
  var queueRef: Unmanaged<CMSimpleQueue>?
  let altered: CMIODeviceStreamQueueAlteredProc = { _, _, _ in }
  guard CMIOStreamCopyBufferQueue(stream, altered, nil, &queueRef) == 0, let queueRef else {
    fail("The camera’s sink stream gave no queue.")
  }
  let queue = queueRef.takeRetainedValue()
  guard CMIODeviceStartStream(device, stream) == 0 else { fail("The sink stream didn’t start.") }
  let writer = SinkWriter(sink: StreamSink(queue: queue), now: hostNanos)
  let reader = FrameReader()
  let input = FileHandle.standardInput
  while true {
    let data = input.availableData
    if data.isEmpty { break }  // the app closed the pipe
    do {
      for frame in try reader.add([UInt8](data)) { try writer.write(frame) }
    } catch {
      CMIODeviceStopStream(device, stream)
      fail("A frame the helper can’t read: \(error)")
    }
  }
  CMIODeviceStopStream(device, stream)
  exit(0)
}

// --- System Extensions: activate and deactivate --------------------------------------------

final class Request: NSObject, OSSystemExtensionRequestDelegate {
  func request(
    _ request: OSSystemExtensionRequest,
    actionForReplacingExtension existing: OSSystemExtensionProperties,
    withExtension ext: OSSystemExtensionProperties
  ) -> OSSystemExtensionRequest.ReplacementAction { .replace }

  func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
    print("{\"needsApproval\": true}")
    fflush(stdout)
  }

  func request(
    _ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result
  ) {
    print("{\"done\": true, \"reboot\": \(result == .willCompleteAfterReboot)}")
    exit(0)
  }

  func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
    fail("macOS refused: \(error.localizedDescription)")
  }
}

func submit(_ request: OSSystemExtensionRequest) -> Never {
  let delegate = Request()
  request.delegate = delegate
  OSSystemExtensionManager.shared.submitRequest(request)
  RunLoop.main.run()
  exit(0)
}

switch CommandLine.arguments.dropFirst().first {
case "status":
  print("{\"installed\": \(cameraDevice() != nil)}")
case "activate":
  submit(OSSystemExtensionRequest.activationRequest(forExtensionWithIdentifier: extensionID, queue: .main))
case "deactivate":
  submit(
    OSSystemExtensionRequest.deactivationRequest(forExtensionWithIdentifier: extensionID, queue: .main))
case "feed":
  feed()
default:
  fail("Usage: mochi-camera status | activate | deactivate | feed")
}
