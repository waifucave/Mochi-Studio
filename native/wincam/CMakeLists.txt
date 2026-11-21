# The virtual camera's DLLs on Windows (docs/virtual-camera.md):
# - mochi_camera_dshow.dll: the DirectShow source filter, for every
#   DirectShow app (registered with regsvr32, in 64-bit and 32-bit builds);
# - mochi_camera_mf.dll: the Media Foundation source of Windows 11's virtual
#   camera, which the Frame Server loads (64-bit).
# npm run build:wincam builds both architectures (scripts/build-wincam.mjs).
cmake_minimum_required(VERSION 3.20)
project(mochi_camera CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# The C runtime linked in: the DLLs load into other apps, which may lack it.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_compile_definitions(UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
if(MSVC)
  add_compile_options(/utf-8 /W4 /permissive-)
endif()

add_library(mochi_camera_dshow SHARED src/dshow/filter.cc src/dshow/filter.def)
target_link_libraries(mochi_camera_dshow PRIVATE strmiids ole32 oleaut32 uuid gdi32 advapi32)

if(CMAKE_SIZEOF_VOID_P EQUAL 8 AND EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/src/mf/source.cc)
  add_library(mochi_camera_mf SHARED src/mf/source.cc src/mf/source.def)
  target_link_libraries(mochi_camera_mf PRIVATE mfplat mfuuid ole32 oleaut32 uuid gdi32 advapi32)
endif()
