<p align="right">
  <a href="./README.md">English</a> | <strong>简体中文</strong>
</p>

# CloudEdge Ops

> 一个具备状态持久化能力的云边设备运维 MVP，覆盖遥测、设备影子、告警生命周期、OTA 工作流和实时可观测性。

CloudEdge Ops 是一个面向工业设备和机器人设备的作品集项目。模拟边缘设备向 Node.js 服务上报遥测；服务端维护设备影子、评估阈值与离线告警、下发可审计的 OTA 命令、持久化运行状态，并通过服务器发送事件（SSE）将变更实时推送到浏览器仪表盘。

当前仓库实现的是可在本地运行的 Node.js MVP。项目不宣称已经支持真实硬件、MQTT、Go 服务、生产级规模或 AI 诊断；这些能力仍属于明确的未来里程碑。

## 已验证的业务闭环

```text
设备遥测 -> reported 设备影子 -> 告警证据 -> 操作员确认
-> 告警解决 / OTA 请求 -> 设备轮询命令 -> 分阶段上报进度
-> 成功或失败 -> 固件状态一致 -> 持久化审计历史
```

## 当前已实现

- 自动注册设备与多设备仪表盘导航
- 持久化的 reported/desired 设备影子与近期遥测历史
- 高温、振动和设备离线告警规则
- 告警生命周期：`open -> acknowledged -> resolved`，包括解决后重新触发
- OTA 状态机：`queued -> acknowledged -> downloading -> installing -> success|failed`
- 命令确认和进度重试的幂等处理
- 完整命令历史与每条命令的进度时间线
- 使用原子临时文件替换的 JSON 持久化
- SSE 实时更新，以及连接中、已连接和重连中的可见状态
- 请求输入校验、有大小限制的 JSON 请求体、结构化错误码和 `409` 状态冲突
- 领域层、HTTP、持久化和真实模拟器集成测试

## 本地运行

环境要求：Node.js 18 或更高版本。项目没有第三方运行时依赖。

在项目目录中打开两个 PowerShell 终端。

终端 1：

```powershell
npm start
```

终端 2：

```powershell
npm run simulate
```

浏览器访问 [http://localhost:4173](http://localhost:4173)。

运行状态保存在 `data/platform-state.json`，该文件已被 Git 忽略。如果需要从全新演示状态开始，请先停止服务，删除该文件，然后重新启动服务。

可选环境变量记录在 [`.env.example`](.env.example) 中。PowerShell 示例：

```powershell
$env:OFFLINE_AFTER_MS = "10000"
$env:DEVICE_ID = "robot-arm-02"
npm run simulate
```

## 演示流程

1. 启动服务端和模拟器。
2. 选择一台设备，观察遥测数据实时更新。
3. 创建一个指定目标版本的 OTA 任务。
4. 观察排队、已确认、下载、安装和成功状态。
5. 注入高温告警，确认告警，然后解决告警。
6. 停止模拟器，等待离线告警创建；重新启动模拟器，观察自动恢复。
7. 重启服务端，确认设备、告警、命令、遥测和事件均能从持久化状态恢复。

## 验证

```powershell
npm test
npm run test:integration
```

集成测试会启动真实 HTTP 服务和设备模拟器进程，将 OTA 任务推进到 `success 100%`，验证 reported/desired 固件版本一致，并从临时 JSON 状态文件恢复最终结果。

## 项目结构

```text
CloudEdge-Ops/
  server/
    domain/                 设备、遥测、告警、命令和 OTA 领域规则
    persistence/            JSON 状态仓储
    http.js                 REST、输入校验、静态文件和 SSE 传输
    index.js                运行时组合与离线检测调度器
  simulator/                可直接运行的边缘设备模拟器
  web/                      无第三方依赖的多设备运维仪表盘
  tests/                    领域、HTTP、持久化和模拟器测试
  docs/                     架构、API 契约、路线图和交接指南
```

## API

完整接口契约和状态转换规则记录在 [docs/API_CONTRACT.md](docs/API_CONTRACT.md) 中。

主要接口包括：

| 方法 | 接口 | 用途 |
| --- | --- | --- |
| `GET` | `/api/devices` | 获取已注册设备和最新遥测 |
| `GET` | `/api/devices/:id` | 获取设备详情、遥测、活动命令和完整命令历史 |
| `POST` | `/api/telemetry` | 接收遥测和 reported 设备影子状态 |
| `GET` | `/api/commands?deviceId=...` | 供设备轮询活动命令 |
| `GET` | `/api/commands?deviceId=...&scope=all` | 获取完整命令历史 |
| `POST` | `/api/ota-jobs` | 创建 OTA 命令 |
| `POST` | `/api/commands/:id/ack` | 确认设备已收到命令 |
| `POST` | `/api/commands/:id/progress` | 上报阶段进度或终态结果 |
| `POST` | `/api/alerts/:id/acknowledge` | 确认一个待处理告警 |
| `POST` | `/api/alerts/:id/resolve` | 解决一个已确认告警 |
| `GET` | `/api/events` | 订阅 SSE 实时事件流 |

## 当前边界

- JSON 持久化采用同步方式，仅面向单个本地进程。
- 尚未实现设备身份认证、租户隔离、固件签名、真实固件传输、回滚或可恢复 OTA。
- 在线/离线判定使用服务端接收时间；设备时间戳只作为观测时间保留，目前还没有时钟偏差策略或设备身份校验保护。
- 尚未实现 AI 诊断服务。未来的 AI 能力必须从只读模式开始，并引用遥测、日志和文档证据。
- 在没有实际测量数据前，不应宣称项目具备特定规模、可用性、硬件可靠性或 OTA 可靠性。

正式架构演进方向记录在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 中。

## 公开仓库安全

本仓库只能保存模拟数据。请勿提交 `.env`、API 密钥、消息代理凭据、生产环境地址、私有固件、公司内部文档、用户数据或客户遥测。

## 许可证

本项目基于 [Apache License 2.0](LICENSE) 发布。
