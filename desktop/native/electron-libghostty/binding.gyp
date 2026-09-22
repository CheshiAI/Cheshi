{
  "targets": [
    {
      "target_name": "cheshi_ghostty",
      "sources": ["src/native_host.mm", "src/window_glass.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "include"
      ],
      "defines": ["NODE_ADDON_API_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-std=c++17"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "OTHER_LDFLAGS": [
          "-L<(module_root_dir)/native-deps/lib",
          "-lCheshiGhosttyBridge",
          "-framework AppKit",
          "-Wl,-rpath,@loader_path"
        ]
      }
    }
  ]
}
