export const meta = {
  apiVersion: 1,
  key: "agnes",
  name: "Agnes",
  description: {
    en: "Agnes video generation (text-to-video, keyframe and reference modes)",
    zh: "Agnes 视频生成（文生视频、首尾帧、参考图模式）",
  },
  version: "1.0.0",
  author: { name: "short-drama" },
  channelTypes: [64],
  models: ["agnes-video-2.5-flash"],
  fetchMode: "per_task",
  upstreams: ["vendor"],
  usageSchema: {
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Video generation unit price", zh: "视频生成单价" },
    },
  },
  usageExamples: [
    { label: "5s", facts: { seconds: 5 } },
    { label: "10s", facts: { seconds: 10 } },
  ],
  protocols: ["openai_video"],
};

// Agnes 的查询接口不在 /v1 下：https://apihub.agnes-ai.com/agnesapi
function apiHost(ctx) {
  return String(ctx.baseUrl || "").replace(/\/v1\/?$/, "");
}

// Agnes 2.5-flash 仅支持 4-12 秒：计费乘子必须在校验阶段截断。
function clampSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.min(12, Math.max(4, Math.round(n)));
}

function pickVideoUrl(data) {
  const url =
    data.video_url || data.remixed_from_video_id || data.result_url || data.download_url;
  return url ? String(url) : "";
}

export const protocols = {
  openai_video: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req))
        throw new Error("JSON object required");
      if (!ctx.model) throw new Error("model is required");
      const raw = req.seconds !== undefined ? req.seconds : req.duration;
      const seconds = raw === undefined || raw === null || raw === "" ? 5 : Number(raw);
      if (!Number.isFinite(seconds) || seconds < 4 || seconds > 12)
        throw new Error("seconds must be between 4 and 12");
      const mode = typeof req.mode === "string" && req.mode ? req.mode : "text";
      return {
        kind: "submit",
        model: ctx.model,
        action: mode === "text" ? "text_to_video" : "image_to_video",
        requestBody: {
          model: ctx.model,
          prompt: typeof req.prompt === "string" ? req.prompt : "",
          mode: mode,
          seconds: seconds,
          size: typeof req.size === "string" && req.size ? req.size : "720P",
          aspect_ratio:
            typeof req.aspect_ratio === "string" && req.aspect_ratio
              ? req.aspect_ratio
              : "9:16",
          images: req.images,
          audios: req.audios,
          first_frame: req.first_frame,
          last_frame: req.last_frame,
          seed: req.seed,
        },
      };
    },
    render: function (ctx, task) {
      // host 会覆盖 id/object/model/status/progress/created_at/completed_at，
      // 这里只返回 Agnes 侧的扩展字段；task.data 是上游查询响应的原始快照。
      const data =
        task && task.data && typeof task.data === "object" && !Array.isArray(task.data)
          ? task.data
          : {};
      const out = {};
      const url = pickVideoUrl(data);
      if (url) out.video_url = url;
      const reason = data.message || data.fail_reason;
      if (reason) out.fail_reason = String(reason);
      return out;
    },
  },
};

export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody || {};
  const body = {
    model: ctx.upstreamModel || ctx.model,
    prompt: req.prompt || "",
    mode: req.mode || "text",
    seconds: String(req.seconds !== undefined ? req.seconds : 5),
    size: req.size || "720P",
    aspect_ratio: req.aspect_ratio || "9:16",
  };
  for (const k of ["images", "audios", "first_frame", "last_frame", "seed"]) {
    if (req[k] !== undefined && req[k] !== null) body[k] = req[k];
  }
  return {
    url: apiHost(ctx) + "/v1/videos",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer " + ctx.apiKey,
    },
    body: body,
    action: ctx.action,
  };
}

export function parseSubmitResponse(ctx, resp) {
  const result = (resp && resp.body) || {};
  const videoId = result.video_id;
  if (!videoId)
    throw new Error(
      "agnes submit failed: missing video_id in " + JSON.stringify(result).slice(0, 200)
    );
  return { taskId: String(videoId), taskData: result };
}

export function buildQueryRequest(ctx) {
  const model = ctx.upstreamModel || ctx.model || "";
  const params =
    "video_id=" +
    encodeURIComponent(ctx.taskId) +
    "&model_name=" +
    encodeURIComponent(model);
  return {
    url: apiHost(ctx) + "/agnesapi?" + params,
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + ctx.apiKey,
    },
  };
}

const DONE_STATUSES = { completed: 1, succeeded: 1, success: 1, done: 1 };
const FAILED_STATUSES = { failed: 1, error: 1, cancelled: 1, canceled: 1 };

export function parseTaskResult(ctx, body) {
  const data = body && typeof body === "object" ? body : {};
  const rawStatus = String(data.status || "").toLowerCase();
  if (DONE_STATUSES[rawStatus])
    return {
      status: "SUCCESS",
      url: pickVideoUrl(data),
      reason: String(data.message || data.fail_reason || ""),
    };
  if (FAILED_STATUSES[rawStatus])
    return {
      status: "FAILURE",
      reason: String(data.message || data.fail_reason || "task failed"),
    };
  if (rawStatus) return { status: "IN_PROGRESS" };
  return { status: "UNKNOWN", reason: "missing status in agnes query response" };
}

export function extractUsage(ctx) {
  const req = ctx.requestBody || {};
  const raw = req.seconds !== undefined ? req.seconds : req.duration;
  // decodeRequest 已做 4-12 校验（400），这里只做防御性截断，永不返回 null
  // 导致漏计费。
  return { seconds: clampSeconds(raw === undefined ? 5 : raw) };
}

export function listArtifacts(task) {
  const data =
    task && task.data && typeof task.data === "object" && !Array.isArray(task.data)
      ? task.data
      : {};
  return task.status === "SUCCESS" && pickVideoUrl(data)
    ? [{ key: "video", type: "video" }]
    : [];
}

export function buildContentRequest(ctx) {
  const data =
    ctx && ctx.data && typeof ctx.data === "object" && !Array.isArray(ctx.data)
      ? ctx.data
      : {};
  const url = pickVideoUrl(data);
  if (ctx.artifactKey !== "video" || !url) throw new Error("artifact_not_found");
  return { url: url, method: "GET", credentialless: true };
}
