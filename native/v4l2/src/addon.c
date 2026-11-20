/*
 * The virtual camera's Linux module (docs/virtual-camera.md).
 *
 * - open(path), close(fd): the device, opened for writing;
 * - queryCap(fd): its driver and card name (VIDIOC_QUERYCAP), to tell a
 *   v4l2loopback device and its label;
 * - setFormat(fd, width, height, fps): YUYV at that size on the device's
 *   output side (VIDIOC_S_FMT), BT.709 limited range, and the frame rate
 *   (VIDIOC_S_PARM);
 * - write(fd, frame): one frame;
 * - convert(src, width, height, under, dst, rgba): premultiplied BGRA (or
 *   RGBA) over the color `under` to YUYV, exactly as src/core/yuv.ts does.
 *
 * Written from the V4L2 API (linux/videodev2.h) and v4l2loopback's README.
 */
#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <linux/videodev2.h>

#define CHECK(call)                                   \
  do {                                                \
    if ((call) != napi_ok) {                          \
      napi_throw_error(env, NULL, "Node-API failed"); \
      return NULL;                                    \
    }                                                 \
  } while (0)

static napi_value throw_errno(napi_env env, const char *what) {
  char msg[800];
  snprintf(msg, sizeof msg, "%s: %s", what, strerror(errno));
  napi_throw_error(env, NULL, msg);
  return NULL;
}

static int get_args(napi_env env, napi_callback_info info, size_t want, napi_value *argv) {
  size_t argc = want;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < want) {
    napi_throw_type_error(env, NULL, "Missing arguments");
    return 0;
  }
  return 1;
}

static int get_i32(napi_env env, napi_value v, int32_t *out) {
  if (napi_get_value_int32(env, v, out) != napi_ok) {
    napi_throw_type_error(env, NULL, "Expected a number");
    return 0;
  }
  return 1;
}

static napi_value make_i32(napi_env env, int32_t v) {
  napi_value r;
  napi_create_int32(env, v, &r);
  return r;
}

static void set_str(napi_env env, napi_value obj, const char *key, const char *s) {
  napi_value v;
  napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, obj, key, v);
}

static void set_u32(napi_env env, napi_value obj, const char *key, uint32_t n) {
  napi_value v;
  napi_create_uint32(env, n, &v);
  napi_set_named_property(env, obj, key, v);
}

static napi_value Open(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!get_args(env, info, 1, argv)) return NULL;
  char path[512];
  size_t len;
  CHECK(napi_get_value_string_utf8(env, argv[0], path, sizeof path, &len));
  int fd = open(path, O_RDWR | O_CLOEXEC);
  if (fd < 0) return throw_errno(env, path);
  return make_i32(env, fd);
}

static napi_value Close(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int32_t fd;
  if (!get_args(env, info, 1, argv) || !get_i32(env, argv[0], &fd)) return NULL;
  close(fd);
  return NULL;
}

static napi_value QueryCap(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int32_t fd;
  if (!get_args(env, info, 1, argv) || !get_i32(env, argv[0], &fd)) return NULL;
  struct v4l2_capability cap;
  memset(&cap, 0, sizeof cap);
  if (ioctl(fd, VIDIOC_QUERYCAP, &cap) < 0) return throw_errno(env, "VIDIOC_QUERYCAP");
  napi_value r;
  CHECK(napi_create_object(env, &r));
  set_str(env, r, "driver", (const char *)cap.driver);
  set_str(env, r, "card", (const char *)cap.card);
  set_u32(env, r, "capabilities", cap.capabilities);
  set_u32(env, r, "deviceCaps", cap.device_caps);
  return r;
}

static napi_value SetFormat(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  int32_t fd, w, h, fps;
  if (!get_args(env, info, 4, argv) || !get_i32(env, argv[0], &fd) || !get_i32(env, argv[1], &w) ||
      !get_i32(env, argv[2], &h) || !get_i32(env, argv[3], &fps))
    return NULL;
  struct v4l2_format f;
  memset(&f, 0, sizeof f);
  f.type = V4L2_BUF_TYPE_VIDEO_OUTPUT;
  f.fmt.pix.width = (uint32_t)w;
  f.fmt.pix.height = (uint32_t)h;
  f.fmt.pix.pixelformat = V4L2_PIX_FMT_YUYV;
  f.fmt.pix.field = V4L2_FIELD_NONE;
  f.fmt.pix.bytesperline = (uint32_t)w * 2;
  f.fmt.pix.sizeimage = (uint32_t)w * (uint32_t)h * 2;
  f.fmt.pix.colorspace = V4L2_COLORSPACE_REC709;
  f.fmt.pix.ycbcr_enc = V4L2_YCBCR_ENC_709;
  f.fmt.pix.quantization = V4L2_QUANTIZATION_LIM_RANGE;
  f.fmt.pix.xfer_func = V4L2_XFER_FUNC_709;
  if (ioctl(fd, VIDIOC_S_FMT, &f) < 0) return throw_errno(env, "VIDIOC_S_FMT");
  struct v4l2_streamparm p;
  memset(&p, 0, sizeof p);
  p.type = V4L2_BUF_TYPE_VIDEO_OUTPUT;
  p.parm.output.timeperframe.numerator = 1;
  p.parm.output.timeperframe.denominator = (uint32_t)fps;
  // Not every device takes a rate; the format is what matters.
  int rate_ok = ioctl(fd, VIDIOC_S_PARM, &p) == 0;
  napi_value r;
  CHECK(napi_create_object(env, &r));
  set_u32(env, r, "width", f.fmt.pix.width);
  set_u32(env, r, "height", f.fmt.pix.height);
  set_u32(env, r, "bytesPerLine", f.fmt.pix.bytesperline);
  set_u32(env, r, "sizeImage", f.fmt.pix.sizeimage);
  set_u32(env, r, "pixelFormat", f.fmt.pix.pixelformat);
  napi_value b;
  napi_get_boolean(env, rate_ok, &b);
  napi_set_named_property(env, r, "rateSet", b);
  return r;
}

static napi_value Write(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  int32_t fd;
  if (!get_args(env, info, 2, argv) || !get_i32(env, argv[0], &fd)) return NULL;
  void *data;
  size_t len;
  napi_typedarray_type type;
  napi_value ab;
  size_t offset;
  if (napi_get_typedarray_info(env, argv[1], &type, &len, &data, &ab, &offset) != napi_ok ||
      type != napi_uint8_array) {
    napi_throw_type_error(env, NULL, "Expected a Uint8Array");
    return NULL;
  }
  size_t done = 0;
  while (done < len) {
    ssize_t n = write(fd, (const uint8_t *)data + done, len - done);
    if (n < 0) {
      if (errno == EINTR) continue;
      return throw_errno(env, "write");
    }
    done += (size_t)n;
  }
  return make_i32(env, (int32_t)done);
}

/* The same fixed-point weights as src/core/yuv.ts (× 2^16, rounded). */
#define S (1 << 16)
#define W(v) ((int32_t)((v) * S + ((v) < 0 ? -0.5 : 0.5)))
#define CK (224.0 / 255.0)

static napi_value Convert(napi_env env, napi_callback_info info) {
  napi_value argv[6];
  int32_t w, h, under, rgba = 0;
  if (!get_args(env, info, 5, argv) || !get_i32(env, argv[1], &w) || !get_i32(env, argv[2], &h) ||
      !get_i32(env, argv[3], &under))
    return NULL;
  size_t argc = 6;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc >= 6) {
    bool b = false;
    napi_get_value_bool(env, argv[5], &b);
    rgba = b;
  }
  if (w <= 0 || h <= 0 || (w & 1)) {
    napi_throw_range_error(env, NULL, "The width must be even.");
    return NULL;
  }
  uint8_t *src, *dst;
  size_t slen, dlen, off;
  napi_typedarray_type t;
  napi_value ab;
  if (napi_get_typedarray_info(env, argv[0], &t, &slen, (void **)&src, &ab, &off) != napi_ok ||
      napi_get_typedarray_info(env, argv[4], &t, &dlen, (void **)&dst, &ab, &off) != napi_ok) {
    napi_throw_type_error(env, NULL, "Expected Uint8Arrays");
    return NULL;
  }
  size_t n = (size_t)w * (size_t)h;
  if (slen < n * 4 || dlen < n * 2) {
    napi_throw_range_error(env, NULL, "A buffer is smaller than the frame.");
    return NULL;
  }
  const int32_t YR = W(0.2126 * 219 / 255), YG = W(0.7152 * 219 / 255), YB = W(0.0722 * 219 / 255);
  const int32_t UR = W(-0.2126 / 1.8556 * CK), UG = W(-0.7152 / 1.8556 * CK), UB = W(0.5 * CK);
  const int32_t VR = W(0.5 * CK), VG = W(-0.7152 / 1.5748 * CK), VB = W(-0.0722 / 1.5748 * CK);
  const int32_t ur = (under >> 16) & 255, ug = (under >> 8) & 255, ub = under & 255;
  const int ri = rgba ? 0 : 2, bi = rgba ? 2 : 0;
  /* The color under each alpha, per channel, as in src/core/yuv.ts. */
  int32_t tr[256], tg[256], tb[256];
  for (int a = 0; a < 256; a++) {
    tr[a] = (ur * (255 - a) + 127) / 255;
    tg[a] = (ug * (255 - a) + 127) / 255;
    tb[a] = (ub * (255 - a) + 127) / 255;
  }
  for (size_t p = 0, o = 0; p < n; p += 2, o += 4) {
    const uint8_t *s = src + p * 4;
    int32_t r0 = s[ri] + tr[s[3]], g0 = s[1] + tg[s[3]], b0 = s[bi] + tb[s[3]];
    int32_t r1 = s[4 + ri] + tr[s[7]], g1 = s[5] + tg[s[7]], b1 = s[4 + bi] + tb[s[7]];
    dst[o] = (uint8_t)(16 + ((YR * r0 + YG * g0 + YB * b0 + (S >> 1)) >> 16));
    dst[o + 2] = (uint8_t)(16 + ((YR * r1 + YG * g1 + YB * b1 + (S >> 1)) >> 16));
    int32_t r = r0 + r1, g = g0 + g1, b = b0 + b1;
    dst[o + 1] = (uint8_t)(128 + ((UR * r + UG * g + UB * b + S) >> 17));
    dst[o + 3] = (uint8_t)(128 + ((VR * r + VG * g + VB * b + S) >> 17));
  }
  return NULL;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"open", NULL, Open, NULL, NULL, NULL, napi_enumerable, NULL},
      {"close", NULL, Close, NULL, NULL, NULL, napi_enumerable, NULL},
      {"queryCap", NULL, QueryCap, NULL, NULL, NULL, napi_enumerable, NULL},
      {"setFormat", NULL, SetFormat, NULL, NULL, NULL, napi_enumerable, NULL},
      {"write", NULL, Write, NULL, NULL, NULL, napi_enumerable, NULL},
      {"convert", NULL, Convert, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  napi_define_properties(env, exports, sizeof props / sizeof props[0], props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
