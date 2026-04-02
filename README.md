# Save Image As

Save Image As is a Chrome extension that adds a format-conversion option directly to the image context menu. Right-click an image, choose **Save image as**, and export a converted copy as PNG, JPG, or WebP.

## What It Does

Browsers already let people save images, but they usually do not offer format conversion as part of that flow. This extension adds that missing step without requiring a separate editor or design tool.

## Features

- Adds a `Save image as` submenu to Chrome's right-click image menu
- Converts images to `PNG`, `JPG`, or `WebP`
- Preserves transparency for PNG and WebP where supported
- Fills transparent areas with white when exporting to JPG
- Includes adjustable JPG and WebP quality settings
- Uses a fallback path for some page-scoped images such as `blob:` URLs
- Runs entirely in the browser with no backend service

## Supported Formats

- `PNG`: lossless output, ideal for graphics, screenshots, and transparent images
- `JPG`: practical for photos and smaller general-purpose files
- `WebP`: modern web-friendly format with strong compression in Chrome

Formats such as GIF, TIFF, BMP, and AVIF are intentionally not included by default because they are less reliable or less useful in a browser-first export workflow.

## How It Works

The extension uses a Manifest V3 service worker to handle image conversion and downloads. For standard image URLs, it fetches the source image, decodes it, renders it to an offscreen canvas, converts it to the selected format, and downloads the result. For page-scoped sources such as some `blob:` URLs, it falls back to page-context conversion when possible.

## Settings

The extension includes an options page for:

- JPG quality
- WebP quality
- Toggling Chrome's Save As dialog before download

## Project Structure

- `manifest.json`: extension manifest and permissions
- `service-worker.js`: context menu, conversion, fallback, and download logic
- `options.html`, `options.css`, `options.js`: settings UI and persistence
- `popup.html`, `popup.css`, `popup.js`: lightweight extension popup

## Development

The project is built as a plain Manifest V3 extension with no bundler or framework dependency. Core browser APIs used by the extension include:

- `chrome.contextMenus`
- `chrome.downloads`
- `chrome.storage.sync`
- `chrome.scripting`
- `createImageBitmap`
- `OffscreenCanvas`

## Testing

Recommended manual checks:

- Export the same image as PNG, JPG, and WebP
- Convert a transparent PNG to JPG and confirm transparent regions become white
- Lower JPG and WebP quality settings and confirm output size changes
- Try images from multiple sites to exercise cross-origin behavior
- Try a page that uses `blob:` image URLs to verify fallback behavior

## Privacy

Image conversion happens locally in the browser. The extension does not require a backend service or external processing pipeline.

## Limitations

- The extension is intended for images available through Chrome's image context menu
- Some sites may restrict image access in ways that prevent reliable conversion
- Rapidly changing or highly custom-rendered image surfaces may not be capturable
- Animated images are treated as static single-frame exports

## License

This project is licensed under the MIT License. See `LICENSE` for details.
