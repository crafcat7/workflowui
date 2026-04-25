// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
//
// Single translation unit that instantiates stb_image / stb_image_write.
// Both headers are public-domain / MIT (dual-licensed) by Sean Barrett;
// see third_party/stb/stb_image.h LICENSE block at EOF for details.
//
// Keep this file the ONLY place that defines STB_IMAGE_IMPLEMENTATION
// and STB_IMAGE_WRITE_IMPLEMENTATION across the workflow_backend +
// workflow_test targets — everywhere else in the codebase should just
// `#include "stb_image.h"` / `#include "stb_image_write.h"` for the
// declarations.

#define STB_IMAGE_IMPLEMENTATION
// Trim formats we do not need: keep PNG + JPG only. Cuts ~2.5k lines of
// dead code from the load side and avoids dragging in HDR/PIC/PSD
// decoders that the workflow runtime will never invoke.
#define STBI_NO_HDR
#define STBI_NO_LINEAR
#define STBI_NO_PIC
#define STBI_NO_PNM
#define STBI_NO_PSD
#define STBI_NO_TGA
#define STBI_NO_GIF
#define STBI_NO_BMP
#include "stb_image.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"
