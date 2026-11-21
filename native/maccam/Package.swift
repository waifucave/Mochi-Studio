// swift-tools-version:5.9
// The virtual camera on macOS (docs/virtual-camera.md): a Camera Extension
// (Core Media I/O, macOS 12.3 or later) and the helper the app feeds it
// through. Built unsigned with `npm run build:maccam` (build.sh); signing
// waits for the project's Apple setup (docs/virtual-camera.md, macOS).
//
// - MochiCameraCore: the frame work with no Apple framework, under unit
//   tests against a fake sink: the NV12 conversion (exactly as
//   src/core/yuv.ts), the frames the app sends, and the sink writer.
// - MochiCameraExtension: the extension, "Mochi Studio Camera": a source
//   stream apps read and a sink stream the helper writes into.
// - mochi-camera: the helper. It reads NV12 frames from the app on its
//   standard input and writes them into the extension's sink stream; it
//   also asks macOS to activate or deactivate the extension.
import PackageDescription

let package = Package(
  name: "MochiCamera",
  platforms: [.macOS("12.3")],
  products: [
    .executable(name: "mochi-camera", targets: ["MochiCameraHelper"]),
    .executable(name: "MochiCameraExtension", targets: ["MochiCameraExtension"]),
  ],
  targets: [
    .target(name: "MochiCameraCore"),
    .executableTarget(name: "MochiCameraHelper", dependencies: ["MochiCameraCore"]),
    .executableTarget(name: "MochiCameraExtension", dependencies: ["MochiCameraCore"]),
    .testTarget(
      name: "MochiCameraCoreTests",
      dependencies: ["MochiCameraCore"],
      resources: [.copy("nv12-vectors.json")]
    ),
  ]
)
