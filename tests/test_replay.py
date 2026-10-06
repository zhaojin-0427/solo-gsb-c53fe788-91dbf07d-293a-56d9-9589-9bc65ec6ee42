"""DMX 信号回放端到端测试：CSV 解析、帧重建、冲突策略、快照/旧记录基准、只读保证。"""
from __future__ import annotations

import os
import tempfile

import pytest

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DMX_DB_PATH"] = _tmp.name

from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.services import init_db  # noqa: E402


@pytest.fixture(scope="session")
def client():
    Base.metadata.drop_all(bind=engine)
    init_db()
    with TestClient(app) as c:
        yield c


CATALOG_CSV = (
    "manufacturer,name,mode,channels\n"
    "ACME,Solar,Basic,10\n"
    "ACME,Solar,Full,20\n"
    "BrightCo,Par,3CH,3\n"
    "LitePro,Beam,Std,5\n"
)


@pytest.fixture(scope="session")
def published(client):
    """导入型录、建 4 台灯具、加一条保留区（线路 1: 500-510），预览并发布。

    返回 (plan_id, 发布 payload)。保留区随快照固化，供回放归类测试使用。
    """
    r = client.post("/api/catalog/import", files={"file": ("c.csv", CATALOG_CSV, "text/csv")})
    assert r.status_code == 200, r.text
    modes = {(t["name"], m["name"]): m for t in client.get("/api/catalog").json() for m in t["modes"]}
    for name, mode_name in [
        ("Alpha", ("Solar", "Basic")),   # 10ch
        ("Beta", ("Solar", "Full")),     # 20ch
        ("Gamma", ("Par", "3CH")),       # 3ch
        ("Delta", ("Beam", "Std")),      # 5ch
    ]:
        r = client.post("/api/fixtures", json={"name": name, "mode_id": modes[mode_name]["id"]})
        assert r.status_code == 201, r.text
    r = client.post("/api/reservations", json={"line_id": 1, "start": 500, "end": 510, "reason": "主控"})
    assert r.status_code == 201, r.text
    p = client.post("/api/plans/preview").json()
    assert p["optimality_status"] == "optimal", p
    r = client.post(f"/api/plans/{p['plan_id']}/publish")
    assert r.status_code == 200, r.text
    payload = client.get(f"/api/plans/{p['plan_id']}").json()
    assert payload["from_snapshot"] is True
    return p["plan_id"], payload


def alloc_of(payload, name):
    return next(a for a in payload["allocations"] if a["name"] == name)


def sig_csv(rows) -> str:
    """rows: (时间ms, 线路, 通道, 值) 元组列表。"""
    lines = ["时间ms,线路,通道,值"]
    lines += [",".join(str(v) for v in row) for row in rows]
    return "\n".join(lines) + "\n"


def replay_csv(client, plan_id, csv_text, policy=None):
    url = f"/api/plans/{plan_id}/replay"
    if policy is not None:
        url += f"?on_conflict={policy}"
    return client.post(url, files={"file": ("sig.csv", csv_text, "text/csv")})


def test_01_frames_merge_and_carryover(client, published):
    """同一毫秒多行合为一帧；槽位初值 0；未更新的值延续上一帧。"""
    plan_id, payload = published
    alpha = alloc_of(payload, "Alpha")
    s = alpha["start"]
    rep = replay_csv(client, plan_id, sig_csv([
        (0, 1, s, 100),        # Alpha 相对通道 1
        (0, 1, s + 1, 50),     # Alpha 相对通道 2（同毫秒 -> 同一帧）
        (10, 1, s + 1, 75),    # 下一帧更新相对通道 2
    ]))
    assert rep.status_code == 200, rep.text
    r = rep.json()
    assert r["from_snapshot"] is True
    assert r["plan_id"] == plan_id
    assert r["conflict_policy"] == "reject"
    assert r["conflicts_resolved"] == []
    c = r["counts"]
    assert (c["rows"], c["frames"], c["slots_touched"], c["fixtures_touched"], c["conflicts"]) == (3, 2, 2, 1, 0)

    f0, f1 = r["frames"]
    assert f0["t"] == 0 and len(f0["changes"]) == 2  # 同毫秒合并
    ch0 = next(x for x in f0["changes"] if x["channel"] == s)
    assert (ch0["value"], ch0["previous"]) == (100, 0)  # 槽位初值 0
    assert f1["t"] == 10 and len(f1["changes"]) == 1
    ch1 = f1["changes"][0]
    assert (ch1["channel"], ch1["value"], ch1["previous"]) == (s + 1, 75, 50)  # 延续上一帧

    reg = r["slot_regions"][f"1:{s}"]
    assert reg["kind"] == "fixture"
    assert reg["fixture_id"] == alpha["fixture_id"]
    assert reg["rel_channel"] == 1
    assert r["slot_regions"][f"1:{s + 1}"]["rel_channel"] == 2
    assert r["fixtures_touched"] == [alpha["fixture_id"]]
    # 基准灯具闭区间来自发布快照
    fx = next(f for f in r["fixtures"] if f["fixture_id"] == alpha["fixture_id"])
    assert (fx["start"], fx["end"], fx["channels"]) == (s, alpha["end"], 10)
    # 快照中的保留区随基准返回
    assert any(rv["start"] == 500 and rv["end"] == 510 for rv in r["reservations"])


def test_02_frames_sorted_and_initial_zero(client, published):
    """文件内乱序的时间仍按毫秒升序成帧；首帧 previous 为初值 0。"""
    plan_id, payload = published
    s = alloc_of(payload, "Alpha")["start"]
    r = replay_csv(client, plan_id, sig_csv([
        (20, 1, s, 7),
        (0, 1, s, 1),
        (10, 1, s + 1, 2),
    ])).json()
    assert [f["t"] for f in r["frames"]] == [0, 10, 20]
    last = r["frames"][2]["changes"][0]
    assert (last["channel"], last["value"], last["previous"]) == (s, 7, 1)  # 延续 t=0 的值


def test_03_conflict_reject_default(client, published):
    """默认策略：同毫秒同槽不同值 -> 整表拒收（422）。"""
    plan_id, payload = published
    s = alloc_of(payload, "Alpha")["start"]
    r = replay_csv(client, plan_id, sig_csv([(5, 1, s, 10), (5, 1, s, 20)]))
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "同一毫秒同一槽位" in detail and "整表拒收" in detail
    assert "t=5ms" in detail and "线路1" in detail


def test_04_conflict_last_wins_and_annotated(client, published):
    """last 策略：按文件顺序取末值，结果中逐处标注，行顺序不悄悄改读数。"""
    plan_id, payload = published
    s = alloc_of(payload, "Alpha")["start"]
    r = replay_csv(client, plan_id, sig_csv([(5, 1, s, 10), (5, 1, s, 20)]), policy="last")
    assert r.status_code == 200, r.text
    rep = r.json()
    assert rep["conflict_policy"] == "last"
    assert rep["counts"]["conflicts"] == 1
    k = rep["conflicts_resolved"][0]
    assert (k["t"], k["line"], k["channel"]) == (5, 1, s)
    assert k["rows"] == [2, 3] and k["values"] == [10, 20] and k["taken"] == 20
    frame = rep["frames"][0]
    assert len(frame["changes"]) == 1
    assert (frame["changes"][0]["value"], frame["changes"][0]["previous"]) == (20, 0)
    assert rep["notices"] and "末值" in rep["notices"][0]


def test_05_same_value_duplicate_is_not_conflict(client, published):
    """同毫秒同槽同值不算冲突，默认拒收策略下也正常回放。"""
    plan_id, payload = published
    s = alloc_of(payload, "Alpha")["start"]
    r = replay_csv(client, plan_id, sig_csv([(5, 1, s, 10), (5, 1, s, 10)]))
    assert r.status_code == 200, r.text
    rep = r.json()
    assert rep["counts"]["conflicts"] == 0
    assert rep["conflicts_resolved"] == []
    assert len(rep["frames"][0]["changes"]) == 1


def test_06_invalid_rows_rejected(client, published):
    """非法时间/线路/通道/值一律整表拒收（422）。"""
    plan_id, _ = published
    bad_rows = [
        "-1,1,1,0",      # 负时间
        "abc,1,1,0",     # 时间非整数
        "1.5,1,1,0",     # 时间非整数
        "0,0,1,0",       # 线路 0
        "0,5,1,0",       # 线路 5
        "0,1,0,0",       # 通道 0
        "0,1,513,0",     # 通道 513
        "0,1,1,-1",      # 值 -1
        "0,1,1,256",     # 值 256
        "0,1,1,x",       # 值非整数
        "0,1,1",         # 列数不足
    ]
    for row in bad_rows:
        r = replay_csv(client, plan_id, "时间ms,线路,通道,值\n" + row + "\n")
        assert r.status_code == 422, (row, r.status_code)
        assert "整表拒收" in r.json()["detail"] or "列数不足" in r.json()["detail"]


def test_07_structure_errors_rejected(client, published):
    plan_id, _ = published
    # 缺少必需表头
    r = replay_csv(client, plan_id, "foo,bar\n1,2\n")
    assert r.status_code == 422 and "表头" in r.json()["detail"]
    # 空文件
    assert replay_csv(client, plan_id, "").status_code == 422
    # 非 UTF-8
    r = client.post(
        f"/api/plans/{plan_id}/replay",
        files={"file": ("s.csv", "时间ms,线路,通道,值\n0,1,1,2\n".encode("gbk"), "text/csv")},
    )
    assert r.status_code == 422
    # 非法冲突策略
    r = replay_csv(client, plan_id, sig_csv([(0, 1, 1, 1)]), policy="bogus")
    assert r.status_code == 422 and "on_conflict" in r.json()["detail"]


def test_08_unpublished_or_missing_plan_rejected(client, published):
    p = client.post("/api/plans/preview").json()
    assert p["optimality_status"] == "optimal"
    r = replay_csv(client, p["plan_id"], sig_csv([(0, 1, 1, 1)]))
    assert r.status_code == 409 and "尚未发布" in r.json()["detail"]
    r = replay_csv(client, 999999, sig_csv([(0, 1, 1, 1)]))
    assert r.status_code == 404


def test_09_reserved_and_unallocated_classified(client, published):
    """有快照：保留区与未分配通道分别归类，供页面逐帧列出非零值。"""
    plan_id, payload = published
    s = alloc_of(payload, "Alpha")["start"]
    rep = replay_csv(client, plan_id, sig_csv([
        (0, 1, s, 100),     # 灯具
        (0, 1, 500, 60),    # 保留区（快照中的 500-510）
        (0, 1, 400, 30),    # 未分配
    ])).json()
    regions = rep["slot_regions"]
    assert regions[f"1:{s}"]["kind"] == "fixture"
    assert regions["1:500"]["kind"] == "reserved"
    assert regions["1:500"]["reason"] == "主控"
    assert regions["1:400"]["kind"] == "unallocated"


def test_10_legacy_plan_unknown_attribution(client, published):
    """无快照旧记录：灯具按留存落点解读；灯具外非零值归属未知，
    不得按当前保留区判为保留区命中或空位异常。"""
    from datetime import datetime, timezone

    from app.database import SessionLocal
    from app.models import Plan, PlanAllocation
    from app.services import get_config_version

    _, payload = published
    alpha = alloc_of(payload, "Alpha")
    with SessionLocal() as db:
        plan = Plan(
            config_version=get_config_version(db),
            status="published",
            optimality_status="optimal",
            migration_count=0,
            used_lines=1,
            published_at=datetime(2020, 6, 6, tzinfo=timezone.utc),
        )
        db.add(plan)
        db.flush()
        db.add(PlanAllocation(plan_id=plan.id, fixture_id=alpha["fixture_id"],
                              line_id=2, start=100, end=109, migrated=False))
        db.commit()
        legacy_id = plan.id

    # 当前保留区覆盖线路 2 的 200-210：回放旧记录时不得用它裁决
    r = client.post("/api/reservations", json={"line_id": 2, "start": 200, "end": 210, "reason": "现行"})
    assert r.status_code == 201, r.text

    rep = replay_csv(client, legacy_id, sig_csv([
        (0, 2, 100, 9),   # 留存落点内的灯具通道
        (0, 2, 205, 9),   # 落在“当前”保留区内 —— 仍须归属未知
        (0, 3, 1, 9),     # 灯具之外 —— 归属未知
    ])).json()
    assert rep["from_snapshot"] is False
    assert rep["reservations"] is None  # 旧记录保留区无法还原
    regions = rep["slot_regions"]
    assert regions["2:100"]["kind"] == "fixture"
    assert regions["2:100"]["fixture_id"] == alpha["fixture_id"]
    assert regions["2:100"]["rel_channel"] == 1
    assert regions["2:205"]["kind"] == "unknown"  # 不按当前保留区判为保留区
    assert regions["3:1"]["kind"] == "unknown"
    assert rep["notices"] and "归属未知" in rep["notices"][-1]
    # 旧记录名称来源透传（当前名称），仅供展示
    fx = next(f for f in rep["fixtures"] if f["fixture_id"] == alpha["fixture_id"])
    assert fx["name"] == "Alpha" and fx["name_source"] == "current"


def test_11_replay_is_readonly(client, published):
    """回放不修改编排与发布数据：配置版本与方案内容前后一致。"""
    plan_id, _ = published
    version_before = client.get("/api/plans/version").json()["config_version"]
    payload_before = client.get(f"/api/plans/{plan_id}").json()
    rep = replay_csv(client, plan_id, sig_csv([(0, 1, 1, 255), (3, 2, 7, 8)]))
    assert rep.status_code == 200, rep.text
    assert client.get("/api/plans/version").json()["config_version"] == version_before
    assert client.get(f"/api/plans/{plan_id}").json() == payload_before


def test_12_historical_replay_ignores_current_placement(client, published):
    """发布会回写灯具既有地址：再次发布后，历史回放仍用所选版本的落点。"""
    plan_id, payload = published
    alpha = alloc_of(payload, "Alpha")
    a_start = alpha["start"]

    # 用保留区覆盖 Alpha 的发布落点，迫使新版本把它挪走
    r = client.post("/api/reservations",
                    json={"line_id": 1, "start": a_start, "end": alpha["end"], "reason": "force-move"})
    assert r.status_code == 201, r.text
    p2 = client.post("/api/plans/preview").json()
    assert p2["optimality_status"] == "optimal"
    assert client.post(f"/api/plans/{p2['plan_id']}/publish").status_code == 200
    payload_b = client.get(f"/api/plans/{p2['plan_id']}").json()
    alpha_b = next(a for a in payload_b["allocations"] if a["fixture_id"] == alpha["fixture_id"])
    assert (alpha_b["line_id"], alpha_b["start"]) != (1, a_start)  # 确实挪位
    # 发布已回写灯具既有地址为新落点
    fx = {f["id"]: f for f in client.get("/api/fixtures").json()}
    assert (fx[alpha["fixture_id"]]["previous_line"], fx[alpha["fixture_id"]]["previous_start"]) == (
        alpha_b["line_id"], alpha_b["start"])

    # 历史回放 plan A：旧落点仍归 Alpha（快照事实），新落点在 A 中不属于 Alpha
    rep_a = replay_csv(client, plan_id, sig_csv([(0, 1, a_start, 9), (0, 1, alpha_b["start"], 9)])).json()
    reg_a = rep_a["slot_regions"]
    assert reg_a[f"1:{a_start}"]["kind"] == "fixture"
    assert reg_a[f"1:{a_start}"]["fixture_id"] == alpha["fixture_id"]
    assert reg_a[f"1:{alpha_b['start']}"].get("fixture_id") != alpha["fixture_id"]

    # 同一 CSV 回放 plan B：落点解释随之不同（各按各的发布快照）
    rep_b = replay_csv(client, p2["plan_id"], sig_csv([(0, 1, a_start, 9), (0, 1, alpha_b["start"], 9)])).json()
    reg_b = rep_b["slot_regions"]
    assert reg_b[f"1:{alpha_b['start']}"]["fixture_id"] == alpha["fixture_id"]
    assert reg_b[f"1:{a_start}"].get("fixture_id") != alpha["fixture_id"]


def test_13_english_header_aliases(client, published):
    plan_id, payload = published
    s = alloc_of(payload, "Alpha")["start"]
    r = replay_csv(client, plan_id, f"time,line,channel,value\n0,1,{s},42\n")
    assert r.status_code == 200, r.text
    assert r.json()["counts"]["frames"] == 1


def test_14_header_only_csv_yields_zero_frames(client, published):
    plan_id, _ = published
    rep = replay_csv(client, plan_id, "时间ms,线路,通道,值\n").json()
    assert rep["counts"]["frames"] == 0
    assert rep["frames"] == []


def test_15_frontend_ships_replay_panel(client):
    html = client.get("/").text
    assert 'id="replay-plan-select"' in html
    assert 'id="replay-file"' in html
    assert 'id="replay-conflict-policy"' in html
    assert 'id="btn-replay"' in html
    assert 'id="replay-result"' in html
    js = client.get("/static/app.js").text
    assert "renderReplayShell" in js
    assert "renderReplayFrame" in js
    assert "gotoReplayFrame" in js
    assert "/replay?on_conflict=" in js
