# The virtual camera's Linux module (docs/virtual-camera.md): it
# writes frames to a v4l2loopback device, and converts them to YUYV. Linux only;
# plain C over Node-API, so one build loads in Electron and in Node.
{
  "targets": [
    {
      "target_name": "mochi_v4l2",
      "conditions": [
        ["OS=='linux'", {
          "sources": ["src/addon.c"],
          "defines": ["NAPI_VERSION=8"],
          "cflags": ["-O2", "-std=gnu11", "-Wall", "-Wextra"]
        }]
      ]
    }
  ]
}
