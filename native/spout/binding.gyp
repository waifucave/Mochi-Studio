# The Spout2 sender addon: Windows only. The SDK sources come from
# npm run fetch:spout (third_party/Spout2, pinned), compiled in as SpoutDX's
# own static build does (SpoutDX/CMakeLists.txt: SpoutDX_static).
{
  "targets": [
    {
      "target_name": "mochi_spout",
      "conditions": [
        ["OS=='win'", {
          "sources": [
            "src/addon.cc",
            "third_party/Spout2/SPOUTSDK/SpoutDirectX/SpoutDX/SpoutDX.cpp",
            "third_party/Spout2/SPOUTSDK/SpoutGL/SpoutCopy.cpp",
            "third_party/Spout2/SPOUTSDK/SpoutGL/SpoutDirectX.cpp",
            "third_party/Spout2/SPOUTSDK/SpoutGL/SpoutFrameCount.cpp",
            "third_party/Spout2/SPOUTSDK/SpoutGL/SpoutSenderNames.cpp",
            "third_party/Spout2/SPOUTSDK/SpoutGL/SpoutSharedMemory.cpp",
            "third_party/Spout2/SPOUTSDK/SpoutGL/SpoutUtils.cpp"
          ],
          "include_dirs": [
            "<!(node -p \"require('node-addon-api').include_dir\")",
            "third_party/Spout2/SPOUTSDK/SpoutDirectX/SpoutDX"
          ],
          "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8", "SPOUT_BUILD_STATIC", "NOMINMAX"],
          "libraries": ["d3d11.lib", "dxgi.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++17", "/utf-8"], "ExceptionHandling": 1 }
          }
        }]
      ]
    }
  ]
}
