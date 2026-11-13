---
packages: @parcha/agentrun-computer
kind: feature
---
Render sandboxes as a computer provider (`render`, subpath `@parcha/agentrun-computer/render`): a Linux sandbox in a Firecracker microVM, network `none`, over Render's public REST API with no SDK. Settings → Computers shows a Render row that takes `RENDER_API_KEY` and `RENDER_WORKSPACE_ID`.
The provider reaches `computerd stdio` over Render's exec-session WebSocket (`runs/session`), which Render's public API does not serve yet: until it does, starting the daemon answers `unsupported`, in words, and no Render computer can run. Render has no endpoint that lengthens a running sandbox, so `extend()` is unsupported, and the run and epoch ride in the sandbox's name because Render has no labels. No mount yet: a Render computer can't mount the server's run folders.
