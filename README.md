# Bilibili Web Fast

Bilibili Web Fast 是一个自用 Chrome 扩展，用于改善 B 站网页端 VOD 和直播播放时的缓冲、预取、恢复和诊断体验。项目不面向商店发布，使用前请自行阅读代码并本地构建。

## 当前修复范围

本轮修复聚焦播放器请求语义、缓存续排、seek 恢复和高码率直播：

- VOD / 通用请求：只有普通、无 `Range` 的 `GET` 媒体或 playlist 请求可以命中整包缓存；`HEAD`、带 `Range` 的请求、以及 `fetch(Request)` 中携带 method/header 语义的请求都会走原始网络语义。
- 请求副作用边界：只有普通无 `Range` 的 `GET` 流媒体请求才会驱动缓存续排、吞吐采样、后台补仓和 Range Split；`HEAD` / `Range` / 其他 method 不会再偷偷触发这些流式副作用。
- 缓存命中：命中已预取片段后会继续从下一段主动续排，避免后台播放等到缓存耗尽才恢复下载。
- 媒体缓存写入：页面成功媒体响应只保留一条缓存写入路径，同 URL 并发写入会合并，避免重复读取整包 body。
- seek / waiting / stalled：用户 seek 到未缓冲位置时不会因为 `waiting` / `stalled` 立即触发 `reload` / `restart` / `replay`；只有目标时间真正进入 `buffered` 后才结束 seek 急救态。恢复链会显式回到 seek target。
- Live：live playlist 会区分 master/sub playlist、init map 和媒体 segment；live 预取窗口优先使用 playlist `#EXTINF` 的真实媒体时长估算，live cache target 使用独立于 VOD 的时间窗口和码率估算，避免高码率直播无限膨胀。
- Live 续拉锚点：多层 playlist 命中缓存后，后台刷新会继续锚定到真正承载媒体 segment 的叶子 playlist，而不是回退到 master playlist，避免后台续拉断链。
- 策略实现：页面运行时现在调用 `src/shared/policy/*` 中的请求、预取、live、下载控制和恢复策略，避免运行时与单测长期双轨漂移。

## 构建与使用

要求 Node.js `>= 20.19.0`。

```powershell
npm install
npm run build
```

构建结果位于 `dist-extension/`。在 Chrome 扩展程序页面开启开发者模式，选择“加载已解压的扩展程序”，加载该目录即可。

## VOD 行为

- VOD playurl 会按策略锁定清晰度和 codec。
- 普通媒体 `GET` 可以由预取缓存服务；`HEAD` 和 `Range` 请求不复用整包缓存，也不会被 Range Split 改写为整包 `200`。
- `HEAD`、显式 `Range` 和其他非普通 `GET` 请求不会再推动媒体预取队列、下载控制吞吐采样或缓存补仓。
- Range Split 只在 VOD、普通无 Range 的 `GET`、且实验开关开启时生效。
- seek 未命中缓存时，下载控制器进入 seek phase，并优先调度 seek 相关片段；seek 期间的 `waiting` / `stalled` 被视为正常等待，不触发激进恢复。

## Live 行为

- live play info 在稳定模式下优先 fMP4，在低延迟模式下优先 FLV。
- master playlist 和子 playlist 会作为 playlist 链路处理，init map 与媒体 segment 作为媒体资源处理。
- 背景刷新优先刷新最近一个叶子 playlist；即使上层 playlist 命中缓存，也不会把 live 续拉链路错误切回 master。
- live 预取窗口使用目标 buffer 秒数和 playlist segment duration 计算，不再使用固定的小 segment 上限。
- live cache target 使用 live 独立估算，并随高码率质量档位设置上限，防止缓存按 VOD 字节模型异常扩张。

## 验证门槛

修复交付前必须通过：

```powershell
cmd /c npm.cmd run typecheck
cmd /c npm.cmd test
cmd /c npm.cmd run build
cmd /c npm.cmd run test:real
```

本地 Playwright harness 还覆盖缓存命中续排、`HEAD` / `Range` 不触发错误副作用、seek 恢复和 live 多层 playlist 叶子续拉；真实测试以 `test:real` 为最终烟测门槛。
