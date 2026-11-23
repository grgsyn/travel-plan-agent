# 旅行规划助手

<p align="center">
  <img src="docs/screenshots/home.png" alt="旅行规划助手首页" width="900">
</p>

![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-SSE-009688?logo=fastapi&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![LangGraph](https://img.shields.io/badge/LangGraph-workflow-1C3C3C)
![License](https://img.shields.io/badge/License-MIT-8B9CFF)

一个由多个专业 Agent 协作完成旅行规划的系统。它把“需求澄清、交通住宿、本地体验、独立评审、文案整合”拆成明确角色，用 LangGraph 串起完整流程，并用确定性代码负责预算、时间、开放时间与硬约束。

> 使用前需要在设置页配置一个 OpenAI 兼容模型；系统不会在未配置模型时用规则结果伪装成 Agent 输出。

## 目录

- [项目简介](#1-项目简介)
- [功能](#2-功能)
- [工作流](#3-工作流)
- [架构](#4-架构)
- [快速开始](#5-快速开始)
- [使用](#6-使用)
- [API](#7-api)
- [项目结构](#8-项目结构)
- [数据与范围](#9-数据与范围)
- [开发](#10-开发)
- [许可](#11-许可)

## 1. 项目简介

旅行规划不是“一次生成一段文本”，而是同时满足预算、日期、同行人、交通、开放时间、体力与偏好的约束问题。

这个项目把问题拆成两层：

- **团队层**：多个角色分别做选择、提出反对、返工和整合；
- **确定性层**：排程、费用、时间冲突、闭馆、赶机等由代码校验，模型不能自行放行。

最终输出一份可阅读、可修改、可追溯的逐日行程，并保留版本与运行轨迹。

## 2. 功能

- **需求输入**：出发地、目的地、日期、人数、预算、同行人、偏好与节奏。
- **补充说明**：字段表达不了的细节以独立 `notes` 传给团队，不混入偏好标签。
- **运行前澄清**：模型阅读需求后，只提出 0–2 个会明显改变行程的问题；支持选项与自定义回答。
- **多角色规划**：交通住宿、本地体验分别交付，独立评审可否决并触发返工。
- **天气参与**：真实预报可驱动雨天户外检查、每日节奏与出行提示。
- **真实 POI 与道路距离**：配置高德 Web 服务后启用，未配置时回退演示数据。
- **确定性校验**：预算、时间轴、闭馆、返程预留、同行人适配等硬约束。
- **过程可见**：SSE 实时轨迹、任务状态、评审问题与版本记录。
- **交付与修改**：逐日行程、预算视图、单日返工、版本回滚、分享页。
- **中断与恢复**：需要用户取舍时暂停；刷新或重启后可继续。

## 3. 工作流

```text
需求输入
   |
   v
运行前澄清（0–2 个问题）
   |
   v
LangGraph
   clarify
      |
      v
   team session
      |-- orchestrator   拆任务 / 派工 / 返工
      |-- logistics      航班、酒店
      |-- local_expert   景点、天气、逐日安排
      |-- critic_agent   独立评审
      |-- writer         整合已批准版本
      |
      v
   peer_finalize（确定性硬校验）
      |-- 未通过 → 返工
      `-- 通过 → 交付
```

### 3.1 运行前澄清

`POST /api/plan/questions` 读取结构化需求，返回 0–2 个问题：

- `kind=infer`：可合理推断，请用户确认；
- `kind=ask`：无法推断，且答案会改变行程。

问题可以带选项、后果说明和自定义输入；回答会随需求一起进入规划。

### 3.2 团队角色

| 角色 | 职责 |
|---|---|
| Orchestrator | 拆解目标、定义任务依赖、派工、按评审意见返工 |
| Logistics | 查询并选择航班与酒店，交付实际选择 |
| Local Expert | 结合景点、天气、距离与体力安排逐日行程 |
| Critic | 基于结构化评审包检查预算、时刻、闭馆与体验风险，可否决 |
| Writer | 只整合已批准版本，生成计划书文案 |

每个角色有独立的系统提示、工具权限与对话历史；角色之间通过结构化消息协作，而不是共享一段自由文本。

### 3.3 确定性校验

以下内容不交给模型自由决定：

- 总预算与每日费用；
- 时间轴、餐期、入住与市内交通；
- 景点闭馆、雨天户外、返程机场预留；
- 同行人适配与每日强度；
- 版本一致性、证据引用与最终交付条件。

## 4. 架构

### 4.1 分层

```text
React + Vite
   |  HTTP / SSE
FastAPI
   |
LangGraph 工作流
   |
Agent 团队会话
   |
工具与数据源
   |
SQLite（方案 / 版本 / 事件 / 运行记录）
```

### 4.2 编排

外层 LangGraph 负责流程与中断：

```text
clarify → peer_run → peer_ask
              |
              v
        peer_finalize → END
```

- `peer_run`：运行完整团队会话；
- `peer_ask`：需要用户取舍时中断，恢复后继续；
- `peer_finalize`：确定性硬校验，未通过则返工。

更完整的说明见 [docs/architecture.md](docs/architecture.md)。

## 5. 快速开始

### 5.1 环境

- Python 3.12+
- Node.js 18+
- 一个 OpenAI 兼容模型接口（base_url、model、api_key）

### 5.2 后端

```powershell
cd backend
python -m venv .venv
.venv/Scripts/python.exe -m pip install langgraph pydantic fastapi "uvicorn[standard]"
```

Linux / macOS 将 `.venv/Scripts/python.exe` 换成 `.venv/bin/python`。

### 5.3 前端

```powershell
cd frontend
npm install
npm run build
```

前端构建产物由后端静态托管，不需要单独启动前端服务。

### 5.4 启动

```powershell
cd backend
.venv/Scripts/python.exe -m uvicorn app.api.main:app --host 127.0.0.1 --port 8848
```

打开 <http://127.0.0.1:8848>。

### 5.5 配置模型

进入右上角「设置」：

1. 勾选「启用模型」；
2. 填写 `base_url`、模型名、API Key；
3. 点击「测试连接」，确认可用后保存。

API Key 只保存在本机 SQLite 配置中，不会写入代码或仓库。

### 5.6 地图（可选）

右侧默认使用内置 SVG 示意图。配置高德后，会切换为真实底图与城市坐标：

```powershell
cd frontend
copy .env.example .env.local
```

在 `frontend/.env.local` 填写：

```dotenv
VITE_AMAP_KEY=你的 JS API Key
VITE_AMAP_SECURITY_CODE=你的安全密钥
```

然后重新构建：

```powershell
npm run build
```

配置后的效果：

<img src="docs/screenshots/demand-map.png" alt="配置高德后的需求页" width="760">

说明：

- 需要在高德开放平台创建 **Web 端（JS API）** Key，并配置安全密钥；
- 这是前端 Key，必须配置域名白名单；不要使用 Web 服务 Key；
- 未填写或加载失败时，自动回退到 SVG 示意图；
- 当前版本展示真实底图、城市定位和城际弧线；地图展示尚未接入市内道路路线，规划侧道路距离见 5.8；
- 地图版权信息与高德服务条款需按官方要求保留。

### 5.7 天气（可选）

默认使用 `backend/data/mock/weather.json`。配置和风天气后，规划会使用真实预报：

```powershell
cd backend
copy .env.example .env
```

在 `backend/.env` 填写：

```dotenv
QWEATHER_KEY=你的和风天气 Key
QWEATHER_HOST=你的 API Host
```

然后重启后端：

```powershell
.venv/Scripts/python.exe -m uvicorn app.api.main:app --host 127.0.0.1 --port 8848
```

说明：

- 未配置时继续使用 mock 天气；
- 配置后，天气会参与 Local Expert 的排程、Critic 的雨天户外检查和 Writer 的出行提示；
- 和风免费版通常只提供有限天数的预报，超出范围会只返回可用日期；
- 未核实天气会在方案中标注，不应写成实时保证。

### 5.8 景点与路线（可选）

默认使用 `backend/data/mock/pois.json`，路线为坐标直线估算。配置高德 Web 服务后：

```dotenv
AMAP_WEB_KEY=你的 Web 服务 Key
```

重启后端即可：

- 景点改为高德 POI 搜索；
- `route_distances` 改为高德驾车道路距离与耗时；
- 未配置时回退 mock 景点 / 直线距离；已配置但请求失败会报数据源不可用，不静默换假数据。

注意：

- 这是 **Web 服务 Key**，不是前面地图用的 JS API Key；
- POI 的开放时间与票价来自高德字段，缺省会标注“待核实”；
- 道路距离是驾车规划，不含实时路况，也不代表步行可达。

## 6. 使用

1. 首页点击「开始规划」；
2. 填写需求；字段之外的细节写在「补充说明」，确认后生成 0–2 个澄清问题；
3. 逐题确认，或选择「其他」自行补充；
4. 团队开始规划，右侧可查看实时轨迹；
5. 方案页查看逐日安排、预算与变更；
6. 可对单日提交返工，或回滚到历史版本；
7. 进入「交付」生成分享页。

<table>
  <tr>
    <td><img src="docs/screenshots/demand.png" alt="需求输入"></td>
    <td><img src="docs/screenshots/plan.png" alt="方案页"></td>
  </tr>
</table>

### 6.1 交付页：计划书

Writer 会在行程卡下方整合总览、逐日摘要与出行提示：

<img src="docs/screenshots/delivery.png" alt="交付页计划书" width="760">

## 7. API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/plan/questions` | 运行前澄清，返回 0–2 个问题 |
| POST | `/api/plan` | 创建规划，SSE 流式返回 |
| POST | `/api/plan/{id}/resume` | 中断后恢复 |
| GET | `/api/plan/{id}` | 方案、版本、团队交付与运行统计 |
| GET | `/api/coverage` | 当前演示覆盖的航线与城市 |
| GET | `/api/plan/{id}/versions` | 版本列表 |
| POST | `/api/plan/{id}/refine` | 单日返工 |
| POST | `/api/plan/{id}/rollback` | 回滚到指定版本 |
| GET | `/api/metrics/runs` | 最近运行的调用数、tokens、耗时与结果 |
| GET | `/api/run/{id}` | 失败/中断运行摘要 |
| GET / PUT | `/api/config` | 读取 / 保存模型与编排配置 |

本机访问免口令；外部访问需要访问口令，或在 URL 中带合法分享签名。

## 8. 项目结构

```text
backend/
  app/
    agents/        角色、运行时、消息总线、工具与校验
    graph/         LangGraph 状态与图组装
    tools/         数据源协议与 mock 实现
    api/           FastAPI 路由与 SQLite 持久化
  data/mock/       演示用航班 / 酒店 / 景点 / 天气快照
  scripts/         开发与验收脚本
frontend/
  src/             React 页面与组件
  src/AmapRoute.tsx 可选：高德地图与城际弧线
docs/
  screenshots/     当前界面截图
  architecture.md  架构说明
  observability.md 运行指标说明
```

## 9. 数据与范围

- 默认数据源为内置演示快照，价格、天气与余票不是实时数据；
- 演示快照覆盖 15 城：上海、北京、广州、深圳、成都、重庆、西安、杭州、南京、苏州、武汉、长沙、厦门、青岛、昆明；航班与酒店价格为演示生成，景点名称/坐标来自高德 POI；
- 系统输出规划建议，不执行实际机票、酒店或门票预订；
- 规划前会检查演示覆盖：缺航线/酒店/景点/天气时明确报错，不静默生成不可用方案；当前覆盖可用 `GET /api/coverage` 查看；
- 未配置高德时路线距离为坐标直线估算；配置后为高德驾车道路距离，不含实时路况；
- 住宿按房间容量计算房间数，交付包含 `rooms` 与 `hotel_total`；3 人默认 2 间，避免报价与时间轴不一致；
- 游览时长由 Local Expert 按本次行程估算区间，Planner 用上限排程；高德 POI 不预设固定游览分钟；
- 返程日按可用窗口决定是否安排景点，窗口不足会明确说明而不是静默留白；
- 当前为单机 SQLite 部署，适合本地运行、演示与二次开发；
- 接入真实库存、支付或多租户前，需要实现对应数据源与鉴权。

## 10. 开发

```powershell
# 后端语法检查
cd backend
.venv/Scripts/python.exe -m compileall -q app

# 前端类型检查与构建
cd ../frontend
npm run build
```

追问质量评测脚本（会调用真实模型，手动运行）：

```powershell
cd backend
.venv/Scripts/python.exe scripts/eval_followups.py --limit 5
```

## 11. 许可

本项目采用 [MIT License](LICENSE)。
