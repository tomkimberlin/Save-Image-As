# Store Privacy and Permission Answers

## Single Purpose

Save Image As converts an image explicitly selected by the user into PNG, JPG, or WebP and saves the converted file locally.

## Permission Justifications

### `contextMenus`

Adds the **Save image as** command to the browser menu when the user right-clicks an image.

### `downloads`

Saves the user-requested converted image to the user's device and supports the browser's Save As dialog.

### `storage`

Stores the user's JPG quality, WebP quality, and Save As dialog preferences. These settings contain no personal information.

### `scripting`

Runs a narrowly scoped fallback in the current page only after the user selects an image conversion command and only when the image cannot be converted directly from the extension context.

### Host access (`<all_urls>`)

Images can appear on any website and are frequently served from a different host than the page displaying them. This access is used only after the user invokes a conversion command, allowing the extension to fetch the selected image or perform the page fallback required to convert it.

## Remote Code

**No.** The extension does not download or execute remote code. All executable code ships inside the extension package.

## Data Usage

- No user data is collected or transmitted to the developer.
- No browsing history is collected.
- No analytics, telemetry, advertising, or tracking is present.
- No image is uploaded to a developer-operated or third-party conversion service.
- The selected image is processed in browser memory and saved only to the user's chosen download location.
- Browser synchronization may sync the three non-personal preference values through the browser vendor's own service.

## Limited Use Certification

The extension's use of website and image data is limited to the user-facing image conversion feature. Data is not sold, transferred for advertising, used for credit or lending, or used for unrelated purposes.
