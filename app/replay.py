"""DMX 信号回放：解析信号 CSV，按时间重建帧并按发布时落点归类槽位。

本模块为纯函数实现，不触碰数据库：基准（发布快照或旧记录留存明细还原出的
灯具闭区间与保留区）由调用方传入，回放过程不修改任何编排与发布数据。

帧重建规则：
- 每行更新一个槽位（线路, 通道）；同一毫秒的多行合并为一帧；
- 槽位初值为 0，未被某帧更新的槽位延续上一帧的值；
- 同一毫秒同一槽位出现不同值时由调用方选择策略：整表拒收（reject），
  或按文件顺序取末值并在结果中标注（last）——行顺序不得悄悄改变读数。

CSV 行级问题（时间/线路/通道/值非法）与结构问题一样整表拒收，
抛出 SignalCsvError；reject 策略下发现同毫秒同槽冲突抛 ConflictError。
"""
from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass

#: 信号 CSV 允许出现的线路与单线通道上限（与编排规则一致）
VALID_LINE_IDS = {1, 2, 3, 4}
LINE_SIZE = 512

#: DMX 通道取值范围
MIN_VALUE = 0
MAX_VALUE = 255

#: 上传文件大小上限，防止异常大文件拖垮服务
MAX_FILE_BYTES = 1_000_000

#: 错误信息中最多逐项列出的坏行/冲突数（超出部分汇总计数）
MAX_LISTED_ISSUES = 20

_INT_RE = re.compile(r"[+-]?\d+")

#: 冲突策略：整表拒收 / 按文件顺序取末值并标注
CONFLICT_REJECT = "reject"
CONFLICT_LAST = "last"
CONFLICT_POLICIES = (CONFLICT_REJECT, CONFLICT_LAST)


class SignalCsvError(ValueError):
    """信号 CSV 的结构或行级数据问题（空文件、非 UTF-8、缺表头、
    非法时间/线路/通道/值）——整表拒收（HTTP 422）。"""


class ConflictError(ValueError):
    """reject 策略下发现同毫秒同槽不同值——整表拒收。携带冲突清单。"""

    def __init__(self, conflicts: list[dict]):
        self.conflicts = conflicts
        shown = "；".join(
            f"t={c['t']}ms 线路{c['line']} 通道{c['channel']} "
            f"（行 {','.join(str(n) for n in c['rows'])}，值 {'→'.join(str(v) for v in c['values'])}）"
            for c in conflicts[:MAX_LISTED_ISSUES]
        )
        more = f"；……共 {len(conflicts)} 处" if len(conflicts) > MAX_LISTED_ISSUES else ""
        super().__init__(
            f"同一毫秒同一槽位出现不同值：{shown}{more}。"
            "已按“整表拒收”策略拒绝；如需继续，请选择“按文件顺序取末值并标注”后重新上传。"
        )


@dataclass
class SignalRow:
    """一行通过校验的信号记录：t 毫秒时将槽位 (line, channel) 更新为 value。"""

    row_no: int  # 文件中的行号（首个非空行为表头，数据行从表头之后计）
    t: int
    line: int
    channel: int
    value: int
    raw: str


#: 表头别名：规范化（去空白与下划线、小写）后映射到四个必需字段。
_HEADER_ALIASES = {
    "time": {"时间", "时间ms", "毫秒", "毫秒时间", "time", "timems", "ms", "timestamp", "时间戳"},
    "line": {"线路", "line", "lineid", "线路id", "universe"},
    "channel": {"通道", "channel", "ch", "dmx通道", "通道地址", "地址"},
    "value": {"值", "value", "val", "dmx值", "通道值", "亮度"},
}

REQUIRED_HEADER_HINT = "时间ms,线路,通道,值"


def _norm_header(cell: str) -> str:
    return "".join(cell.split()).replace("_", "").lower()


def _header_mapping(header: list[str]) -> dict[str, int]:
    mapping: dict[str, int] = {}
    for idx, cell in enumerate(header):
        norm = _norm_header(cell)
        if not norm:
            continue
        for field_name, aliases in _HEADER_ALIASES.items():
            if norm in aliases and field_name not in mapping:
                mapping[field_name] = idx
    return mapping


def parse_signal_csv(content: bytes) -> list[SignalRow]:
    """解析信号 CSV，返回按文件顺序排列的有效行。

    结构问题（空文件、非 UTF-8、缺表头）与行级问题（非法时间/线路/通道/值）
    一律抛 SignalCsvError，由调用方整表拒收——不做行级隔离，避免残缺时间轴
    被误当作完整信号回放。
    """
    if not content:
        raise SignalCsvError("文件为空，未收到任何内容")
    if len(content) > MAX_FILE_BYTES:
        raise SignalCsvError(f"文件过大（超过 {MAX_FILE_BYTES // 1000} KB），请拆分后重试")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise SignalCsvError("文件不是有效的 UTF-8 编码 CSV，请另存为 UTF-8 后重试") from exc

    rows = list(csv.reader(io.StringIO(text)))
    header_idx = next((i for i, r in enumerate(rows) if any(c.strip() for c in r)), None)
    if header_idx is None:
        raise SignalCsvError("文件为空，未找到表头行")
    mapping = _header_mapping(rows[header_idx])
    missing_fields = [f for f in ("time", "line", "channel", "value") if f not in mapping]
    if missing_fields:
        raise SignalCsvError(
            "表头缺少必需列，无法识别信号数据：需要包含 " + REQUIRED_HEADER_HINT +
            "（时间为非负毫秒，线路 1-4，通道 1-512，值 0-255；多余列会被忽略）"
        )

    valid: list[SignalRow] = []
    bad: list[str] = []
    max_idx = max(mapping.values())
    for i in range(header_idx + 1, len(rows)):
        cells = rows[i]
        row_no = i + 1
        if not any(c.strip() for c in cells):
            continue  # 跳过全空行
        raw = ",".join(cells)
        if len(cells) <= max_idx:
            bad.append(f"第 {row_no} 行：列数不足（{raw!r}）")
            continue

        parsed: dict[str, int] = {}
        reasons: list[str] = []
        for field_name, label in (
            ("time", "时间"),
            ("line", "线路"),
            ("channel", "通道"),
            ("value", "值"),
        ):
            cell = cells[mapping[field_name]].strip()
            if not _INT_RE.fullmatch(cell):
                reasons.append(f"{label}不是整数（{cell!r}）")
            else:
                parsed[field_name] = int(cell)

        t = parsed.get("time")
        if t is not None and t < 0:
            reasons.append(f"非法时间：{t}（必须为非负毫秒）")
        line = parsed.get("line")
        if line is not None and line not in VALID_LINE_IDS:
            reasons.append(f"非法线路：{line}（仅允许 1-4）")
        channel = parsed.get("channel")
        if channel is not None and not (1 <= channel <= LINE_SIZE):
            reasons.append(f"非法通道：{channel}（仅允许 1-512）")
        value = parsed.get("value")
        if value is not None and not (MIN_VALUE <= value <= MAX_VALUE):
            reasons.append(f"非法值：{value}（仅允许 0-255）")

        if reasons:
            bad.append(f"第 {row_no} 行：{'；'.join(reasons)}")
            continue
        valid.append(SignalRow(row_no, t, line, channel, value, raw))  # type: ignore[arg-type]

    if bad:
        shown = "；".join(bad[:MAX_LISTED_ISSUES])
        more = f"；……共 {len(bad)} 行非法" if len(bad) > MAX_LISTED_ISSUES else ""
        raise SignalCsvError(f"信号 CSV 存在非法行，整表拒收：{shown}{more}")
    return valid


def build_frames(rows: list[SignalRow], on_conflict: str) -> tuple[list[dict], list[dict]]:
    """按时间重建帧，返回 (frames, conflicts)。

    frames 按时间升序，每帧 {"t": 毫秒, "changes": [{line, channel, value, previous}]}：
    同一毫秒的多行合为一帧；槽位初值为 0，未更新的槽位延续上一帧的值
    （previous 即延续后的读数）。conflicts 为同毫秒同槽不同值的清单；
    策略为 reject 且存在冲突时抛 ConflictError，策略为 last 时按文件顺序
    取末值并返回冲突清单供结果标注。
    """
    if on_conflict not in CONFLICT_POLICIES:
        raise ValueError(f"未知冲突策略：{on_conflict!r}（仅支持 {CONFLICT_POLICIES}）")

    by_time: dict[int, list[SignalRow]] = {}
    for r in rows:
        by_time.setdefault(r.t, []).append(r)

    # 第一遍：收集全部冲突（同毫秒、同槽位、值不同；同值重复行不算冲突）
    conflicts: list[dict] = []
    for t in sorted(by_time):
        per_slot: dict[tuple[int, int], list[SignalRow]] = {}
        for r in by_time[t]:
            per_slot.setdefault((r.line, r.channel), []).append(r)
        for (line, channel), slot_rows in sorted(per_slot.items()):
            if len({r.value for r in slot_rows}) > 1:
                conflicts.append(
                    {
                        "t": t,
                        "line": line,
                        "channel": channel,
                        "rows": [r.row_no for r in slot_rows],
                        "values": [r.value for r in slot_rows],
                        "taken": slot_rows[-1].value,  # 文件顺序取末值
                    }
                )
    if conflicts and on_conflict == CONFLICT_REJECT:
        raise ConflictError(conflicts)

    # 第二遍：逐帧应用。同槽多行时后者覆盖前者（= 文件顺序取末值），
    # 与冲突策略无关——reject 时此时已保证无不同值冲突。
    state: dict[tuple[int, int], int] = {}
    frames: list[dict] = []
    for t in sorted(by_time):
        winners: dict[tuple[int, int], SignalRow] = {}
        for r in by_time[t]:
            winners[(r.line, r.channel)] = r
        changes = []
        for r in sorted(winners.values(), key=lambda r: r.row_no):
            key = (r.line, r.channel)
            prev = state.get(key, 0)
            state[key] = r.value
            changes.append(
                {"line": r.line, "channel": r.channel, "value": r.value, "previous": prev}
            )
        frames.append({"t": t, "changes": changes})
    return frames, conflicts


def classify_slots(
    slots: set[tuple[int, int]],
    fixtures: list[dict],
    reservations: list[dict] | None,
) -> dict[str, dict]:
    """把被触及的槽位按发布时落点归类，返回 {"线路:通道": region}。

    fixtures 为基准中的灯具闭区间（fixture_id/name/line_id/start/end）；
    reservations 为发布时的保留区列表，None 表示旧记录无法还原保留区——
    此时灯具之外一律标 unknown（归属未知），不得按当前保留区把灯具外
    非零值判为保留区命中或空位异常。
    """
    fx_by_line: dict[int, list[dict]] = {}
    for f in fixtures:
        fx_by_line.setdefault(f["line_id"], []).append(f)
    res_by_line: dict[int, list[dict]] = {}
    if reservations is not None:
        for r in reservations:
            res_by_line.setdefault(r["line_id"], []).append(r)

    regions: dict[str, dict] = {}
    for line, channel in sorted(slots):
        region = None
        for f in fx_by_line.get(line, []):
            if f["start"] <= channel <= f["end"]:
                region = {
                    "kind": "fixture",
                    "fixture_id": f["fixture_id"],
                    "name": f["name"],
                    "rel_channel": channel - f["start"] + 1,  # 相对通道（1 起）
                }
                if f.get("name_source"):
                    region["name_source"] = f["name_source"]
                break
        if region is None and reservations is not None:
            for r in res_by_line.get(line, []):
                if r["start"] <= channel <= r["end"]:
                    region = {"kind": "reserved"}
                    if r.get("id") is not None:
                        region["reservation_id"] = r["id"]
                    if r.get("reason"):
                        region["reason"] = r["reason"]
                    break
        if region is None:
            region = {"kind": "unallocated"} if reservations is not None else {"kind": "unknown"}
        regions[f"{line}:{channel}"] = region
    return regions


def build_report(plan_payload: dict, rows: list[SignalRow], on_conflict: str) -> dict:
    """以已发布方案的基准（快照还原或旧记录留存明细）重建帧并归类槽位。

    基准中的灯具闭区间与保留区一律取自 plan_payload（发布时事实），
    绝不使用当前灯具落点——发布会回写灯具既有地址，历史回放不得随之漂移。
    """
    fixtures = []
    for a in plan_payload["allocations"]:
        f = {
            "fixture_id": a["fixture_id"],
            "name": a.get("name", f"#{a['fixture_id']}"),
            "line_id": a["line_id"],
            "start": a["start"],
            "end": a["end"],
            "channels": a["channels"],
        }
        # 旧记录的名称为当前值/不可用，透传来源标注（仅供展示，不参与归类）
        if a.get("name_source"):
            f["name_source"] = a["name_source"]
        fixtures.append(f)

    from_snapshot = bool(plan_payload.get("from_snapshot"))
    reservations: list[dict] | None = None
    if from_snapshot:
        # 快照占用中的保留区是发布时事实；旧记录为 None（无法还原）
        reservations = [
            {
                "line_id": line["line_id"],
                "id": r.get("id"),
                "start": r["start"],
                "end": r["end"],
                "reason": r.get("reason", ""),
            }
            for line in plan_payload.get("occupancy", [])
            for r in (line.get("reservations") or [])
        ]

    frames, conflicts = build_frames(rows, on_conflict)
    slots = {(c["line"], c["channel"]) for frame in frames for c in frame["changes"]}
    slot_regions = classify_slots(slots, fixtures, reservations)
    fixtures_touched = sorted(
        {reg["fixture_id"] for reg in slot_regions.values() if reg["kind"] == "fixture"}
    )

    notices: list[str] = []
    if conflicts:  # 此时必为 last 策略（reject 已在 build_frames 抛错）
        notices.append(
            f"同一毫秒同一槽位出现不同值共 {len(conflicts)} 处：已按文件顺序取末值"
            "（逐处明细见 conflicts_resolved），行顺序不会悄悄改变读数。"
        )
    if not from_snapshot:
        notices.append(
            "该发布记录缺少快照：灯具按留存落点解读；灯具之外的非零值归属未知"
            "（可能属于当时的保留区或未分配通道），不按当前保留区裁决。"
        )

    return {
        "conflict_policy": on_conflict,
        "conflicts_resolved": conflicts,
        "notices": notices,
        "counts": {
            "rows": len(rows),
            "frames": len(frames),
            "slots_touched": len(slots),
            "fixtures_touched": len(fixtures_touched),
            "conflicts": len(conflicts),
        },
        "fixtures": fixtures,
        "fixtures_touched": fixtures_touched,
        # 快照记录为发布时保留区列表；旧记录为 None（未知，不按当前保留区裁决）
        "reservations": reservations,
        "slot_regions": slot_regions,
        "frames": frames,
    }
