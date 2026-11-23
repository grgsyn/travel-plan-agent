# 系统架构

## 1. 总览

系统由 Web 前端、FastAPI 服务、LangGraph 工作流、Agent 团队会话和确定性工具层组成。

```text
React + Vite
      |
   HTTP / SSE
      |
   FastAPI
      |
   LangGraph
      |
   Agent 团队会话
      |
   工具与数据源
      |
   SQLite
```

## 2. 请求链路

```text
浏览器
  |-- POST /api/plan/questions   需求澄清
  |-- POST /api/plan             SSE 规划
  |-- POST /api/plan/{id}/resume 中断恢复
  |-- POST /api/plan/{id}/refine 单日返工
  |-- GET  /api/plan/{id}        方案 / 版本 / 统计
  `-- GET  /api/coverage         演示覆盖范围
```

FastAPI 负责鉴权、SSE、持久化和静态前端托管；LangGraph 负责流程状态与中断；团队会话负责任务拆解、专业选择与评审返工。

## 3. LangGraph 流程

```text
START
  |
  v
clarify（需求归一化）
  |
  v
peer_run（团队会话）
  |
  +--> peer_ask（需要用户取舍时中断）
  |
  v
peer_finalize（确定性硬校验）
  |-- 未通过且未到上限 → peer_run
  `-- 通过 → END
```

### 3.1 clarify

把表单需求归一化为 `TripBrief`，补充默认值与可行性提示；不调用模型。用户补充说明保存为独立的 `notes` 字段，随需求进入角色提示词。

### 3.2 peer_run

运行完整的多角色会话：

| 角色 | 职责 |
|---|---|
| Orchestrator | 拆任务、定义依赖、派工、处理返工 |
| Logistics | 选择航班与酒店 |
| Local Expert | 安排景点、天气与逐日行程 |
| Critic | 基于结构化评审包独立评审 |
| Writer | 整合已批准版本的计划书 |

角色使用独立提示词、工具白名单和对话历史；通过结构化消息传递提案、反对、接受与升级。

### 3.3 peer_ask

团队无法自行协调时，通过 LangGraph `interrupt()` 暂停，等待用户选择；恢复后继续会话。

### 3.4 peer_finalize

执行确定性硬校验，检查预算、时间轴、闭馆、返程预留、同行人适配与版本一致性。未通过则返工，达到上限后停止并保留问题。

## 4. 状态与持久化

SQLite 保存：

- `plans`：当前方案；
- `plan_versions`：只追加的版本快照；
- `run_events`：SSE 事件与轨迹；
- `runs`：运行结果、失败原因与用量。

长时间会话快照使用 artifact store 单独保存，避免 checkpoint 体积随对话线性增长。

## 5. 中断与恢复

- 需要用户取舍时写入中断信息；
- 前端刷新后通过 `GET /api/run/{id}` 恢复确认面板；
- 用户提交选择后，服务端从 checkpoint 继续，不重跑已完成的模型调用。

## 6. 设计原则

1. **模型负责判断，代码负责事实**：预算、时间、闭馆、距离等由确定性代码校验。
2. **角色边界清晰**：专业角色只处理自己的领域，跨域修改会被工具权限和沙箱阻止。
3. **版本只追加**：返工、降配、回滚都保留版本，批准绑定到具体版本。
4. **过程可追溯**：任务、消息、工具调用、评审与用量都有结构化记录。


## 7. 地图（可选）

需求页右侧默认是 SVG 示意图。配置 `frontend/.env.local` 中的高德 JS API Key 与安全密钥后，前端会：

- 加载真实底图与城市坐标；
- 绘制起终点标记和城际弧线；
- 加载失败时回退到 SVG。

地图 Key 是前端 Key，应配置域名白名单；仓库不保存真实 Key。地图展示尚未接入市内道路路线；规划侧道路距离见第 9 节。

## 8. 天气（可选）

默认使用 `backend/data/mock/weather.json`。配置 `QWEATHER_KEY` 与 `QWEATHER_HOST` 后，`get_weather` 改为读取和风天气：

- Local Expert 用它安排室内/户外与每日节奏；
- Critic 用雨天标记检查户外项目；
- Writer 把它写入出行提示；
- 未配置时回退 mock；已配置但请求失败会报天气不可用，不静默换假数据，也不阻塞其他规划。

## 9. 景点与路线（可选）

配置 `AMAP_WEB_KEY` 后：

- `list_pois` 改用高德 POI 搜索；
- `route_distances` 改用高德驾车道路距离与耗时；
- 未配置时继续使用 mock 景点与坐标直线估算。

高德 POI 的开放时间、票价字段不完整时会标记“待核实”；道路距离不代表步行可达。

规划前会检查本地 mock 覆盖：缺航线、酒店、景点或天气时明确拒绝；GET /api/coverage 返回当前覆盖。

## 10. 游览时长估算

景点时长不是 POI 的固定属性。Local Expert 在 `submit_day_plans` 的 `stops` 中为每个景点提交 `minutes_low` / `minutes_high`、置信度和理由；Planner 用上限做开门、餐食、返程窗口校验。高德 POI 不预设固定分钟；没有可靠估算时要求 Agent 补充，而不是按类型硬编码。

返程日不再统一清空：先按航班、机场提前量和市区转场算可用窗口；能放下才排一个点，放不下会在当日说明中写明最晚离店时间。

## 11. 相关文档

- [运行指标](observability.md)
- [项目主页](../README.md)
