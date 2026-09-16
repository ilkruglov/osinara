# Image Generation

Use `generate_image` when the user asks for a new raster image or an edit to an existing photo,
illustration, banner, background, product mockup, sprite, or infographic.

Do not use it for SVG assets, simple diagrams that should be code, or an existing vector system.
Never generate an image merely to decorate an answer.

## Editing

Pass `images` with one to four authorized sources in prompt order. For each source supply `scope`
and exactly one of `attachmentId`, `telegramMessageId`, or relative workspace `path`.
Use attachmentId from Telegram attachment references for group reply photos; use telegramMessageId
for an inbox photo in the current chat, or path for a saved image. Never invent a source or replace
the reference with a text description. External groups can use only their own `group` scope.

Describe the requested change and what should stay the same (subject, face, pose, composition,
style). When there are multiple references, identify them by image index starting at 0.
To refine a generated draft, pass its returned path as a source on the next call.
Editing currently requires Cloudflare Workers AI. Its reference images are reduced to below
512x512, so fine details may change. This is generative editing, not exact pixel-preserving retouching.
If editing is unavailable or fails, do not omit `images` and silently generate a replacement.

## Prompt workflow

1. Preserve a detailed user prompt without inventing new characters, objects, brands, slogans, or
   story elements.
2. For a generic request, add only details that materially improve the requested result.
3. Structure the prompt in this order: purpose, scene, subject, composition, visual style, lighting,
   exact text, constraints.
4. Put exact in-image text in straight quotes and require verbatim rendering with no extra text.
5. State important exclusions explicitly, including no watermark, no logo, or no additional objects
   when applicable.
6. Use `size=auto`, `quality=auto`, and `background=auto` unless the user or intended layout requires
   an explicit value.
7. Use one `generate_image` call for one requested final. For variants, make one call per variant.

The tool saves a new image file (WebP, PNG or JPEG depending on the provider) in the authorized
workspace, leaving the source intact. It does not send the image automatically.
To show the result, call `send_workspace_image` with the returned path and scope.
Only claim delivery after that tool confirms it. Inspect a draft with `inspect_workspace_image`
when available; only send the final image unless the user asks to see drafts.

If the tool reports an unknown status, stop. Do not call it again automatically because the
provider may already have been charged.
