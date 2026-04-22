# Save Image As

Save Image As is a Chrome and Firefox extension that adds a format-conversion option directly to the image context menu. Right-click an image, choose **Save image as**, and export a converted copy as PNG, JPG, or WebP.

## What It Does

Browsers already let people save images, but they usually do not offer format conversion as part of that flow. This extension adds that missing step without requiring a separate editor or design tool.

## Features

- Adds a `Save image as` submenu to the browser's right-click image menu
- Converts images to `PNG`, `JPG`, or `WebP`
- Preserves transparency for PNG and WebP where supported
- Fills transparent areas with white when exporting to JPG
- Includes adjustable JPG and WebP quality settings
- Uses a fallback path for some page-scoped images such as `blob:` URLs
- Runs entirely in the browser with no backend service

## Supported Formats

- `PNG`: lossless output, ideal for graphics, screenshots, and transparent images
- `JPG`: practical for photos and smaller general-purpose files
- `WebP`: modern web-friendly format with strong compression in modern browsers

Formats such as GIF, TIFF, BMP, and AVIF are intentionally not included by default because they are less reliable or less useful in a browser-first export workflow.

## How It Works

The extension uses a cross-browser Manifest V3 background setup: Chromium browsers load `service-worker.js` as a service worker, while Firefox loads the same file through `background.scripts`. For standard image URLs, the extension fetches the source image and converts it inside the extension context before downloading the result. Chromium uses the worker-friendly `createImageBitmap` and `OffscreenCanvas` path, while Firefox uses a document-backed `<canvas>` path in its background page. For page-scoped sources such as some `blob:` and `data:` URLs, it falls back to page-context conversion when possible.

## Settings

The extension includes an options page for:

- JPG quality
- WebP quality
- Toggling the browser's Save As dialog before download

## Project Structure

- `manifest.json`: extension manifest and permissions
- `service-worker.js`: context menu, conversion, fallback, and download logic
- `options.html`, `options.css`, `options.js`: settings UI and persistence
- `popup.html`, `popup.css`, `popup.js`: lightweight extension popup

## Development

The project is built as a plain Manifest V3 extension with no bundler or framework dependency. Core browser APIs used by the extension include:

- `browser.contextMenus` / `chrome.contextMenus`
- `browser.downloads` / `chrome.downloads`
- `browser.storage.sync` / `chrome.storage.sync`
- `browser.scripting` / `chrome.scripting`
- `createImageBitmap`
- `OffscreenCanvas`

## Local Install

### Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select the project's `manifest.json`

### Chrome / Chromium

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the project folder

## Packaging

- Keep `dist/` and generated archives out of git. The repository already ignores packaged `.zip` files.
- For Firefox distribution, keep a stable `browser_specific_settings.gecko.id` in `manifest.json`.
- Package only the extension files that ship to the browser: `manifest.json`, scripts, HTML, CSS, icons/assets, and license/readme files if desired.
- Before publishing, reload the unpacked extension in both browsers and re-run the manual checks below.

## Testing

Recommended manual checks:

- Confirm the extension version shown in the browser matches the current `manifest.json`
- Load the extension in both Chrome and Firefox and confirm the context menu appears on images
- Export the same image as PNG, JPG, and WebP
- Convert a transparent PNG to JPG and confirm transparent regions become white
- Lower JPG and WebP quality settings and confirm output size changes
- Try images from multiple sites to exercise cross-origin behavior
- Try a page that uses `blob:` image URLs to verify fallback behavior
- Try an SVG source in Firefox and confirm the exported PNG/JPG/WebP file is actually written to disk

## Privacy

Image conversion happens locally in the browser. The extension does not require a backend service or external processing pipeline.

## Limitations

- The extension is intended for images available through the browser's image context menu
- Some sites may restrict image access in ways that prevent reliable conversion
- Rapidly changing or highly custom-rendered image surfaces may not be capturable
- Animated images are treated as static single-frame exports
- Some page-context fallbacks can still be blocked by browser canvas security rules when the page itself cannot legally export the selected image

## License

This project is licensed under the MIT License. See `LICENSE` for details.
