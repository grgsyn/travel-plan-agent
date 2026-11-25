# 运行指标与可观测性

## 1. 数据来源

`runs` 表保存每次运行（成功、失败、中断、取消）的摘要；`run_events` 保存事件流，用于估算耗时。

## 2. 接口

`GET /api/metrics/runs?limit=20`（需访问口令；本机免口令）

返回最近运行：

```json
{
  "runs": [
    {
      "run_id": "...",
      "status": "completed",
      "created_at": "2026-11-19T15:44:00+00:00",
      "duration_ms": 101153,
      "calls": 20,
      "total_tokens": 177445,
      "latency_ms": 98000,
      "passed": true,
      "total_cost": 6060,
      "version": 1,
      "revision": 0,
      "failure_type": "completed",
      "message": ""
    }
  ]
}
```

字段：

| 字段 | 含义 |
|---|---|
| `calls` | 供应商模型请求数 |
| `total_tokens` | prompt + completion（供应商返回 usage 时） |
| `duration_ms` | 事件流首尾时间差，近似墙钟耗时 |
| `passed` | 最终确定性校验是否通过 |
| `failure_type` | 失败/中断类型；成功为 `completed` |
| `message` | 失败原因，最多 160 字，不含密钥 |

## 2.1 局部返工

`/api/plan/{id}/refine` 不新建 `runs` 记录，但会把返工开始、完成、失败写入同一个 `run_events`。因此：

- 轨迹抽屉和 `/api/plan/{id}/events` 能看到返工；
- 方案版本记录 `source=team_rework`；
- 返工日期不一致会被 409 拒绝，不会生成新版本。

## 3. 页面

设置面板 → 运行指标：最近 10 次运行，显示时间、状态、调用数、tokens、耗时、结果。

## 4. 排障路径

1. 先看 `status`：`completed` / `failed` / `interrupted` / `cancelled`；
2. 看 `calls` 是否接近 `max_model_calls`；
3. 看 `total_tokens` 与上次相比是否异常；
4. 看 `duration_ms` 是否接近 `max_runtime_s`；
5. 失败时展开 `message`，再结合 `run_events` 查具体节点。

## 5. 边界

- 耗时按事件首尾估算，不含排队和客户端渲染；
- 供应商不返回 usage 时 `total_tokens` 为 0；
- 指标页面主要面向开发与运维，不进入用户主流程；
- 未记录完整提示词，避免密钥/隐私入库。
