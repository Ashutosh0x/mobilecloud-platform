package com.mobilecloud.console

import org.json.JSONArray
import org.json.JSONObject

/* =========================================================================
 * Data model — a 1:1 Kotlin mirror of the web console (`lib/types.ts` +
 * `lib/store.tsx`). Field names match the JSON keys returned by
 * `apps/web-dashboard/lib/server/api.ts` so parsing is mechanical.
 * ========================================================================= */

data class User(val id: String, val email: String, val name: String, val role: String, val plan: String)
data class Project(val id: String, val name: String, val framework: String, val target: String, val createdAt: Long)
data class Deployment(val id: String, val projectId: String, val project: String, val status: String, val note: String, val createdAt: Long)
data class Domain(val id: String, val host: String, val project: String, val status: String, val detail: String)
data class DbFile(val id: String, val name: String, val engine: String, val bytes: Long?, val path: String)
data class FuncRow(val id: String, val name: String, val route: String, val hasSource: Boolean, val invocations: Int)
data class ObjectRow(val id: String, val bucket: String, val key: String, val bytes: Long)
data class LogRow(val id: String, val level: String, val source: String, val message: String, val at: Long)
data class Member(val id: String, val name: String, val email: String, val role: String, val emailSent: Boolean)

data class Metrics(
    val collectedAt: Long,
    val processUptimeSec: Long,
    val cpuBusySinceBootPct: Double?,
    val memoryUsedPct: Double?,
    val memoryUsedBytes: Long,
    val memoryTotalBytes: Long,
    val dataDirBytes: Long,
    val diskFreeBytes: Long?,
    val diskTotalBytes: Long?,
    val responseAvgMs: Long?,
    val responseSamples: Int,
    val recordedRequests: Int,
    val unavailable: List<String>,
)

data class Point(val label: String, val count: Int)
data class Analytics(val range: String, val total: Int, val points: List<Point>)
data class HostInfo(
    val hostname: String,
    val platform: String,
    val arch: String,
    val release: String,
    val cpuCount: Int,
    val processUptimeSec: Long,
    val memoryUsedBytes: Long,
    val memoryTotalBytes: Long,
    val unavailable: List<String>,
)

data class Billing(val plan: String, val provider: String?, val charged: Boolean, val detail: String)
data class Capability(val name: String, val state: String, val detail: String)

data class FirewallRule(
    val id: String, val name: String, val action: String, val matchKey: String,
    val matchOp: String, val matchValue: String, val headerName: String?,
    val limitCount: Int?, val windowSec: Int?, val enabled: Int,
)
data class FirewallEvent(val id: String, val ruleId: String?, val action: String, val path: String, val ip: String, val at: Long)
data class TrafficRank(val value: String, val count: Int)
data class TrafficBucket(val start: Long, val requests: Int)
data class Traffic(
    val window: String, val requests: Int, val denied: Int, val logged: Int, val rateLimited: Int,
    val buckets: List<TrafficBucket>, val topPaths: List<TrafficRank>, val topAgents: List<TrafficRank>,
    val topJa4: List<TrafficRank>, val crawlerTokens: List<TrafficRank>, val notes: List<String>,
)
data class Firewall(val rules: List<FirewallRule>, val events: List<FirewallEvent>, val traffic: Traffic?)

data class VitalMetric(val metric: String, val samples: Int, val p75: Double?)
data class Vitals(val collectedAt: Long, val metrics: List<VitalMetric>, val res: Double?, val note: String)

data class BuildRow(val id: String, val project: String, val target: String, val status: String, val note: String, val createdAt: Long)
data class RunInfo(val status: String, val note: String, val at: Long)
data class WorkflowRow(val id: String, val name: String, val createdAt: Long, val lastRun: RunInfo?)
data class DriveRow(val id: String, val name: String, val bytes: Long?, val createdAt: Long)

data class StatusCounts(val s2xx: Int, val s3xx: Int, val s4xx: Int, val s5xx: Int)
data class Observability(
    val collectedAt: Long, val samples: Int, val statuses: StatusCounts,
    val p50: Long?, val p95: Long?, val p99: Long?, val unavailable: List<String>,
)

data class Settings(val recordPageViews: Boolean)
data class Notice(val id: String, val type: String, val title: String, val message: String, val read: Boolean, val at: Long)
data class SessionRow(val id: String, val userAgent: String, val createdAt: Long?, val expiresAt: Long, val current: Boolean)
data class TokenRow(val id: String, val name: String, val prefix: String, val createdAt: Long, val expiresAt: Long?, val lastUsed: Long?)
data class WebhookRow(val id: String, val url: String, val events: String, val createdAt: Long)
data class Protection(val required: Boolean, val unlocked: Boolean)

/** Full snapshot returned by `GET /api/overview`. */
data class Snapshot(
    val user: User?,
    val projects: List<Project>,
    val deployments: List<Deployment>,
    val domains: List<Domain>,
    val databases: List<DbFile>,
    val functions: List<FuncRow>,
    val objects: List<ObjectRow>,
    val logs: List<LogRow>,
    val team: List<Member>,
    val settings: Settings,
    val metrics: Metrics?,
    val host: HostInfo?,
    val billing: Billing?,
    val firewall: Firewall,
    val observability: Observability?,
    val vitals: Vitals?,
    val builds: List<BuildRow>,
    val workflows: List<WorkflowRow>,
    val drives: List<DriveRow>,
    val capabilities: List<Capability>,
    val notifications: List<Notice>,
    val sessions: List<SessionRow>,
    val tokens: List<TokenRow>,
    val webhooks: List<WebhookRow>,
    val protection: Protection,
    val identity: List<Capability>,
)

/* ----------------------------- JSON helpers ----------------------------- */

private fun JSONObject.s(key: String, def: String = ""): String = if (!has(key) || isNull(key)) def else optString(key, def)
private fun JSONObject.sn(key: String): String? = if (!has(key) || isNull(key)) null else optString(key)
private fun JSONObject.l(key: String, def: Long = 0L): Long = if (!has(key) || isNull(key)) def else optLong(key, def)
private fun JSONObject.ln(key: String): Long? = if (!has(key) || isNull(key)) null else optLong(key)
private fun JSONObject.i(key: String, def: Int = 0): Int = if (!has(key) || isNull(key)) def else optInt(key, def)
private fun JSONObject.inn(key: String): Int? = if (!has(key) || isNull(key)) null else optInt(key)
private fun JSONObject.dn(key: String): Double? = if (!has(key) || isNull(key)) null else optDouble(key)
private fun JSONObject.b(key: String, def: Boolean = false): Boolean = if (!has(key) || isNull(key)) def else optBoolean(key, def)
private fun JSONObject.obj(key: String): JSONObject? = if (!has(key) || isNull(key)) null else optJSONObject(key)
private fun JSONObject.arr(key: String): JSONArray = if (!has(key) || isNull(key)) JSONArray() else optJSONArray(key) ?: JSONArray()
private fun JSONObject.strList(key: String): List<String> {
    val a = arr(key)
    return List(a.length()) { idx -> a.optString(idx) }.filter { it.isNotEmpty() }
}

private inline fun <T> JSONArray.map(transform: (JSONObject) -> T): List<T> =
    List(length()) { i -> transform(optJSONObject(i) ?: JSONObject()) }

private fun parseUser(o: JSONObject) = User(o.s("id"), o.s("email"), o.s("name"), o.s("role"), o.s("plan"))
private fun parseProject(o: JSONObject) = Project(o.s("id"), o.s("name"), o.s("framework"), o.s("target"), o.l("createdAt"))
private fun parseDeployment(o: JSONObject) = Deployment(o.s("id"), o.s("projectId"), o.s("project"), o.s("status"), o.s("note"), o.l("createdAt"))
private fun parseDomain(o: JSONObject) = Domain(o.s("id"), o.s("host"), o.s("project"), o.s("status"), o.s("detail"))
private fun parseDb(o: JSONObject) = DbFile(o.s("id"), o.s("name"), o.s("engine", "sqlite"), o.ln("bytes"), o.s("path"))
private fun parseFunc(o: JSONObject) = FuncRow(o.s("id"), o.s("name"), o.s("route"), o.b("hasSource"), o.i("invocations"))
private fun parseObject(o: JSONObject) = ObjectRow(o.s("id"), o.s("bucket"), o.s("key"), o.l("bytes"))
private fun parseLog(o: JSONObject) = LogRow(o.s("id"), o.s("level"), o.s("source"), o.s("message"), o.l("at"))
private fun parseMember(o: JSONObject) = Member(o.s("id"), o.s("name"), o.s("email"), o.s("role"), o.b("emailSent"))

private fun parseMetrics(o: JSONObject) = Metrics(
    collectedAt = o.l("collectedAt"),
    processUptimeSec = o.l("processUptimeSec"),
    cpuBusySinceBootPct = o.dn("cpuBusySinceBootPct"),
    memoryUsedPct = o.dn("memoryUsedPct"),
    memoryUsedBytes = o.l("memoryUsedBytes"),
    memoryTotalBytes = o.l("memoryTotalBytes"),
    dataDirBytes = o.l("dataDirBytes"),
    diskFreeBytes = o.ln("diskFreeBytes"),
    diskTotalBytes = o.ln("diskTotalBytes"),
    responseAvgMs = o.ln("responseAvgMs"),
    responseSamples = o.i("responseSamples"),
    recordedRequests = o.i("recordedRequests"),
    unavailable = o.strList("unavailable"),
)

private fun parseHost(o: JSONObject) = HostInfo(
    o.s("hostname"), o.s("platform"), o.s("arch"), o.s("release"),
    o.i("cpuCount"), o.l("processUptimeSec"), o.l("memoryUsedBytes"), o.l("memoryTotalBytes"),
    o.strList("unavailable"),
)

private fun parseBilling(o: JSONObject) = Billing(o.s("plan"), o.sn("provider"), o.b("charged"), o.s("detail"))
private fun parseCapability(o: JSONObject) = Capability(o.s("name"), o.s("state"), o.s("detail"))

private fun parseRule(o: JSONObject) = FirewallRule(
    o.s("id"), o.s("name"), o.s("action"), o.s("matchKey"), o.s("matchOp"), o.s("matchValue"),
    o.sn("headerName"), o.inn("limitCount"), o.inn("windowSec"), o.i("enabled"),
)
private fun parseEvent(o: JSONObject) = FirewallEvent(o.s("id"), o.sn("ruleId"), o.s("action"), o.s("path"), o.s("ip"), o.l("at"))
private fun parseRank(o: JSONObject) = TrafficRank(o.s("value"), o.i("count"))
private fun parseBucket(o: JSONObject) = TrafficBucket(o.l("start"), o.i("requests"))
private fun parseTraffic(o: JSONObject) = Traffic(
    o.s("window", "24h"), o.i("requests"), o.i("denied"), o.i("logged"), o.i("rateLimited"),
    o.arr("buckets").map(::parseBucket), o.arr("topPaths").map(::parseRank),
    o.arr("topAgents").map(::parseRank), o.arr("topJa4").map(::parseRank),
    o.arr("crawlerTokens").map(::parseRank), o.strList("notes"),
)

private fun parseFirewall(o: JSONObject?) = Firewall(
    rules = o?.arr("rules")?.map(::parseRule) ?: emptyList(),
    events = o?.arr("events")?.map(::parseEvent) ?: emptyList(),
    traffic = o?.obj("traffic")?.let(::parseTraffic),
)

private fun parseVitals(o: JSONObject?) = o?.let {
    Vitals(
        it.l("collectedAt"),
        it.arr("metrics").map { m -> VitalMetric(m.s("metric"), m.i("samples"), m.dn("p75")) },
        it.dn("res"),
        it.s("note"),
    )
}

private fun parseObservability(o: JSONObject?) = o?.let {
    val st = it.obj("statuses")
    Observability(
        it.l("collectedAt"), it.i("samples"),
        StatusCounts(st?.i("s2xx") ?: 0, st?.i("s3xx") ?: 0, st?.i("s4xx") ?: 0, st?.i("s5xx") ?: 0),
        it.ln("p50"), it.ln("p95"), it.ln("p99"), it.strList("unavailable"),
    )
}

private fun parseBuild(o: JSONObject) = BuildRow(o.s("id"), o.s("project"), o.s("target"), o.s("status"), o.s("note"), o.l("createdAt"))
private fun parseWorkflow(o: JSONObject) = WorkflowRow(
    o.s("id"), o.s("name"), o.l("createdAt"),
    o.obj("lastRun")?.let { r -> RunInfo(r.s("status"), r.s("note"), r.l("at")) },
)
private fun parseDrive(o: JSONObject) = DriveRow(o.s("id"), o.s("name"), o.ln("bytes"), o.l("createdAt"))

private fun parseSettings(o: JSONObject?) = Settings(o?.b("recordPageViews", true) ?: true)
private fun parseNotice(o: JSONObject) = Notice(o.s("id"), o.s("type"), o.s("title"), o.s("message"), o.b("read"), o.l("at"))
private fun parseSession(o: JSONObject) = SessionRow(o.s("id"), o.s("userAgent"), o.ln("createdAt"), o.l("expiresAt"), o.b("current"))
private fun parseToken(o: JSONObject) = TokenRow(o.s("id"), o.s("name"), o.s("prefix"), o.l("createdAt"), o.ln("expiresAt"), o.ln("lastUsed"))
private fun parseWebhook(o: JSONObject) = WebhookRow(o.s("id"), o.s("url"), o.s("events"), o.l("createdAt"))
private fun parseProtection(o: JSONObject?) = Protection(o?.b("required") ?: false, o?.b("unlocked", true) ?: true)

fun parseSnapshot(o: JSONObject) = Snapshot(
    user = o.obj("user")?.let(::parseUser),
    projects = o.arr("projects").map(::parseProject),
    deployments = o.arr("deployments").map(::parseDeployment),
    domains = o.arr("domains").map(::parseDomain),
    databases = o.arr("databases").map(::parseDb),
    functions = o.arr("functions").map(::parseFunc),
    objects = o.arr("objects").map(::parseObject),
    logs = o.arr("logs").map(::parseLog),
    team = o.arr("team").map(::parseMember),
    settings = parseSettings(o.obj("settings")),
    metrics = o.obj("metrics")?.let(::parseMetrics),
    host = o.obj("host")?.let(::parseHost),
    billing = o.obj("billing")?.let(::parseBilling),
    firewall = parseFirewall(o.obj("firewall")),
    observability = parseObservability(o.obj("observability")),
    vitals = parseVitals(o.obj("vitals")),
    builds = o.arr("builds").map(::parseBuild),
    workflows = o.arr("workflows").map(::parseWorkflow),
    drives = o.arr("drives").map(::parseDrive),
    capabilities = o.arr("capabilities").map(::parseCapability),
    notifications = o.arr("notifications").map(::parseNotice),
    sessions = o.arr("sessions").map(::parseSession),
    tokens = o.arr("tokens").map(::parseToken),
    webhooks = o.arr("webhooks").map(::parseWebhook),
    protection = parseProtection(o.obj("protection")),
    identity = o.arr("identity").map(::parseCapability),
)

fun parseAnalytics(o: JSONObject) = Analytics(
    range = o.s("range", "24h"),
    total = o.i("total"),
    points = o.arr("points").map { Point(it.s("label"), it.i("count")) },
)

fun parseUserEnvelope(o: JSONObject): User? = o.obj("user")?.let(::parseUser)
