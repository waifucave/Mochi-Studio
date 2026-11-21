# The virtual camera's Windows module for the app (docs/virtual-camera.md): it
# writes NV12 frames to the frame ring the cameras read, and converts them.
# Windows only; Node-API (C), so one build loads in Electron and in Node. The
# cameras themselves are DLLs built with CMake (CMakeLists.txt).
{
  "targets": [
    {
      "target_name": "mochi_wincam",
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/addon.cc"],
          "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE", "NOMINMAX"],
          "libraries": ["advapi32.lib", "ole32.lib", "mfuuid.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": { "AdditionalOptions": ["/utf-8", "/O2"] }
          }
        }]
      ]
    }
  ]
}
