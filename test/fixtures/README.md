# Test fixtures

Every file here was generated for these tests. None holds anyone else's
material.

- **`tone.ogg`:** a one-second 440 Hz sine tone, mono, 22,050 Hz, Ogg
  Vorbis (4.7 KB). It is a model's motion sound in
  `test/browser/textureCaps.test.ts`. Made with ffmpeg's built-in tone
  source:

  ```sh
  ffmpeg -f lavfi -i "sine=frequency=440:duration=1:sample_rate=22050" \
    -ac 1 -c:a libvorbis -q:a 2 -map_metadata -1 \
    -fflags +bitexact -flags:a +bitexact test/fixtures/tone.ogg
  ```

- **`synthetic-session.json`:** a tracking session in the app's recording
  format, made up in code rather than recorded from a camera.
  `scripts/make-synthetic-fixture.ts` writes it, and its `source` field
  says what it holds.
- **`nv12-vectors.json`:** pixel colors and their NV12 bytes, from the
  reference conversion in `src/core/nv12.test.ts`
  (`MOCHI_UPDATE_FIXTURES=1` writes them again). The macOS camera's Swift
  tests keep a copy in `native/maccam/Tests/MochiCameraCoreTests/`.

The other models and pictures the tests load are made in code at run time
(`test/support/syntheticModel.ts`, `test/support/craftedTexture.ts`), and
none is kept as a file. The one exception is the app's sample model
(`samples/mochi/`), which `test/browser/firstRun.test.ts` opens.
